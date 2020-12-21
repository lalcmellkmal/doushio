const opts = require('./opts');
if (require.main == module) opts.parse_args();
opts.load_defaults();

const _ = require('../lib/underscore'),
    amusement = require('./amusement'),
    async = require('async'),
    auth = require('./auth'),
    caps = require('./caps'),
    check = require('./msgcheck').check,
    common = require('../common'),
    { OneeSama, safe, escape_html } = common,
    config = require('../config'),
    curfew = require('../curfew/server'),
    crypto = require('crypto'),
    db = require('../db'),
    fs = require('fs'),
    imager = require('../imager'),
    { Muggle, json_paranoid } = require('../etc'),
    { Okyaku, dispatcher, scan_client_caps } = require('./okyaku'),
    render = require('./render'),
    fetch = require('node-fetch'),
    STATE = require('./state'),
    tripcode = require('./../tripcode/tripcode'),
    urlParse = require('url').parse,
    web = require('./web'),
    winston = require('winston');

require('../admin');
if (!imager.is_standalone())
	require('../imager/daemon'); // preload and confirm it works
try {
	const reportConfig = require('../report/config');
	if (reportConfig.RECAPTCHA_SITE_KEY)
		require('../report/server');
} catch (e) {}

const RES = STATE.resources;

dispatcher[common.PING] = function (msg, client) {
	if (msg.length)
		return false;
	client.send([0, common.PING]);
	return true;
};

dispatcher[common.SYNCHRONIZE] = function (msg, client) {
	function checked(err, ident) {
		if (!err)
			_.extend(client.ident, ident);
		if (!synchronize(msg, client))
			client.kotowaru(Muggle("Bad protocol."));
	}
	const chunks = web.parse_cookie(msg.pop());
	const cookie = auth.extract_login_cookie(chunks);
	if (cookie) {
		auth.check_cookie(cookie, checked);
		return true;
	}
	else
		return synchronize(msg, client);
};

function synchronize(msg, client) {
	if (!check(['id', 'string', 'id=>nat', 'boolean'], msg))
		return false;
	let [id, board, syncs, live] = msg;
	if (id in STATE.clients) {
		winston.error(`Duplicate client id ${id}`);
		return false;
	}
	client.id = id;
	STATE.clients[id] = client;

	if (!caps.can_access_board(client.ident, board))
		return false;
	let dead_threads = [], count = 0, op;
	for (let k in syncs) {
		k = parseInt(k, 10);
		if (db.OPs[k] != k || !db.OP_has_tag(board, k)) {
			delete syncs[k];
			dead_threads.push(k);
		}
		op = k;
		if (++count > config.THREADS_PER_PAGE) {
			/* Sync logic isn't great yet; allow this for now */
			// return false;
		}
	}
	client.watching = syncs;
	if (live) {
		/* XXX: This will break if a thread disappears during sync
		 *      (won't be reported)
		 * Or if any of the threads they see on the first page
		 * don't show up in the 'live' pub for whatever reason.
		 * Really we should get them synced first and *then* switch
		 * to the live pub.
		 */
		client.watching = {live: true};
		count = 1;
	}
	client.board = board;

	if (client.db)
		client.db.disconnect();
	client.db = new db.Yakusoku(board, client.ident);
	/* Race between subscribe and backlog fetch; client must de-dup */
	client.db.kiku(client.watching, client.on_update.bind(client),
			client.on_thread_sink.bind(client), listening);
	function listening(errs) {
		if (errs && errs.length >= count)
			return client.kotowaru(Muggle("Couldn't sync to board."));
		else if (errs) {
			dead_threads.push.apply(dead_threads, errs);
			errs.forEach(thread => {
				delete client.watching[thread];
			});
		}
		client.db.fetch_backlogs(client.watching, got_backlogs);
	}
	function got_backlogs(errs, logs) {
		if (errs) {
			dead_threads.push.apply(dead_threads, errs);
			errs.forEach(thread => {
				delete client.watching[thread];
			});
		}

		if (client.ident.readOnly) {
			logs.push(`0,${common.MODEL_SET},["hot"],{"readOnly":true}`);
		}

		let sync = '0,' + common.SYNCHRONIZE;
		if (dead_threads.length)
			sync += ',' + JSON.stringify(dead_threads);
		logs.push(sync);
		client.socket.write(`[[${logs.join('],[')}]]`);
		client.synced = true;

		const isSingleThread = !live && count == 1;
		if (isSingleThread) {
			amusement.notify_client_fun_banner(client, op);
		}
	}
	return true;
}

function setup_imager_relay() {
	return new Promise((resolve, reject) => {
		const onegai = new imager.Onegai;
		onegai.relay_client_messages();
		onegai.once('relaying', () => {
			onegai.on('message', image_status);
			resolve();
		});
	});
}

function image_status(client_id, status) {
	if (!check('id', client_id))
		return;
	const client = STATE.clients[client_id];
	if (client) {
		try {
			client.send([0, common.IMAGE_STATUS, status]);
		}
		catch (e) {
			// Swallow EINTR
			// anta baka?
		}
	}
}

function page_nav(thread_count, cur_page, ascending) {
	let page_count = Math.ceil(thread_count / config.THREADS_PER_PAGE);
	page_count = Math.max(page_count, 1);
	const info = {pages: page_count, threads: thread_count, cur_page, ascending};

	const step = ascending ? -1 : 1;
	const next = Math.max(cur_page, 0) + step;
	if (next >= 0 && next < page_count)
		info.next_page = 'page' + next;
	const prev = cur_page - step;
	if (prev >= 0 && prev < page_count)
		info.prev_page = 'page' + prev;
	return info;
}

function write_gzip_head(req, resp, headers) {
	const encoding = config.GZIP && req.headers['accept-encoding'];
	if (req.ident.slow || !encoding || !encoding.includes('gzip')) {
		resp.writeHead(200, headers);
		return resp;
	}
	resp.writeHead(200, _.extend({}, headers, {
		'Content-Encoding': 'gzip',
		Vary: 'Accept-Encoding',
	}));

	const gz = require('zlib').createGzip();
	gz.pipe(resp);
	return gz;
}

function redirect_thread(cb, num, op, tag) {
	if (!tag)
		cb(null, 'redirect', `${op}#${num}`);
	else
		/* Use a JS redirect to preserve the hash */
		cb(null, 'redirect_js', `../${tag}/${op}#${num}`);
}

// unless imager.config.DAEMON, we deal with image uploads in-process.
if (!imager.is_standalone()) {
	web.route_post(/^\/upload\/$/, require('../imager/daemon').new_upload);
}

/// site root
web.resource(/^\/$/, function (req, cb) {
	cb(null, 'redirect', config.DEFAULT_BOARD + '/');
});

if (config.DEBUG) {
	/* Shortcuts for convenience */
	winston.warn("Running in (insecure) debug mode.");
	winston.warn("Do not use on the public internet.");
	web.route_get(/^\/login$/, function (req, resp) {
		auth.set_cookie(req, resp, {auth: 'Admin'});
	});
	web.route_get(/^\/mod$/, function (req, resp) {
		auth.set_cookie(req, resp, {auth: 'Moderator'});
	});
}
else {
	/* Production login endpoint */
	web.route_get(/^\/login$/, auth.login);

	if (config.SERVE_STATIC_FILES)
		winston.warn("Recommended: nginx-like webserver instead of SERVE_STATIC_FILES.");
	if (config.SERVE_IMAGES)
		winston.warn("Recommended: nginx-like webserver instead of SERVE_IMAGES.");
}
web.route_get(/^\/logout$/, auth.logout);
web.route_post(/^\/logout$/, auth.logout);

function write_mod_js(resp, ident) {
	if (!RES.modJs) {
		resp.writeHead(500);
		resp.end('Mod js not built?!');
		return;
	}

	const noCacheJs = _.clone(web.noCacheHeaders);
	noCacheJs['Content-Type'] = 'text/javascript; charset=UTF-8';
	resp.writeHead(200, noCacheJs);
	resp.end(`(function (IDENT) {
${RES.modJs};
})(${JSON.stringify(ident)});`);
}

/// provide admin client js
web.resource_auth(/^\/admin\.js$/, (req, cb) => {
	if (!caps.can_administrate(req.ident))
		cb(404);
	else
		cb(null, 'ok');
},
function (req, resp) {
	const { auth, csrf, user } = req.ident;
	write_mod_js(resp, { auth, csrf, user });
});

web.resource_auth(/^\/mod\.js$/, (req, cb) => {
	if (!caps.can_moderate(req.ident))
		cb(404);
	else
		cb(null, 'ok');
},
(req, resp) => {
	const { auth, csrf, user } = req.ident;
	write_mod_js(resp, { auth, csrf, user });
});

/// view board index
web.resource(/^\/(\w+)$/, function (req, params, cb) {
	const board = params[1];
	/* If arbitrary boards were allowed, need to escape this: */
	const dest = board + '/';
	if (req.ident.suspension)
		return cb(null, 'redirect', dest); /* TEMP */
	if (!caps.can_ever_access_board(req.ident, board))
		return cb(404);
	cb(null, 'redirect', dest);
});

web.resource(/^\/(\w+)\/live$/, function (req, params, cb) {
	if (req.ident.suspension)
		return cb(null, 'redirect', '.'); /* TEMP */
	if (!caps.can_ever_access_board(req.ident, params[1]))
		return cb(404);
	cb(null, 'redirect', '.');
});

web.resource(/^\/(\w+)\/$/, (req, params, cb) => {
	const board = params[1];
	const { ident } = req;
	if (ident.suspension)
		return cb(null, 'ok'); /* TEMP */
	if (!caps.can_ever_access_board(ident, board))
		return cb(404);

	cb(null, 'ok', { board });
},
function (req, resp) {
	/* TEMP */
	if (req.ident.suspension)
		return render_suspension(req, resp);

	const { board } = this;
	const { ident } = req;
	if (!caps.temporal_access_check(ident, board)) {
		curfew.divert_response(board, resp);
		return;
	}

	const yaku = new db.Yakusoku(board, ident);
	yaku.get_tag(-1);
	let paginationHtml;
	yaku.once('begin', (thread_count) => {
		const nav = page_nav(thread_count, -1, board == 'archive');
		const initScript = make_init_script(ident);
		render.write_board_head(resp, initScript, board, nav);
		paginationHtml = render.make_pagination_html(nav);
		resp.write(paginationHtml);
		resp.write('<hr>\n');
	});
	resp = write_gzip_head(req, resp, web.noCacheHeaders);
	const opts = {fullLinks: true, board};
	render.write_thread_html(yaku, req, resp, opts);
	yaku.once('end', () => {
		resp.write(paginationHtml);
		render.write_page_end(resp, ident, false);
		resp.end();
		yaku.disconnect();
	});
	yaku.once('error', (err) => {
		winston.error(`rendering /${board}/ index: ${err}`);
		resp.end();
		yaku.disconnect();
	});
});

/// view page of board
web.resource(/^\/(\w+)\/page(\d+)$/, function (req, params, cb) {
	const board = params[1];
	if (!caps.temporal_access_check(req.ident, board))
		return cb(null, 302, '..');
	if (req.ident.suspension)
		return cb(null, 'ok'); /* TEMP */
	if (!caps.can_access_board(req.ident, board))
		return cb(404);
	const page = parseInt(params[2], 10);
	if (page > 0 && params[2][0] == '0') /* leading zeroes? */
		return cb(null, 'redirect', 'page' + page); // if so, normalize url

	const yaku = new db.Yakusoku(board, req.ident);
	yaku.get_tag(page);
	yaku.once('nomatch', () => {
		cb(null, 302, '.');
		yaku.disconnect();
	});
	yaku.once('begin', (threadCount) => {
		cb(null, 'ok', { board, page, yaku, threadCount });
	});
},
function (req, resp) {
	/* TEMP */
	if (req.ident.suspension)
		return render_suspension(req, resp);

	const { board, page, yaku, threadCount } = this;
	const nav = page_nav(this.threadCount, page, board == 'archive');
	resp = write_gzip_head(req, resp, web.noCacheHeaders);
	const initScript = make_init_script(req.ident);
	render.write_board_head(resp, initScript, board, nav);
	const paginationHtml = render.make_pagination_html(nav);
	resp.write(paginationHtml);
	resp.write('<hr>\n');

	const opts = {fullLinks: true, board};
	render.write_thread_html(yaku, req, resp, opts);
	yaku.once('end', () => {
		resp.write(paginationHtml);
		render.write_page_end(resp, req.ident, false);
		resp.end();
		this.finished();
	});
	yaku.once('error', (err) => {
		winston.error(`rendering /${board}/ page #${page}: ${err}`);
		resp.end();
		this.finished();
	});
},
function () {
	this.yaku.disconnect();
});

web.resource(/^\/(\w+)\/page(\d+)\/$/, (req, params, cb) => {
	if (!caps.temporal_access_check(req.ident, params[1]))
		cb(null, 302, '..');
	else
		cb(null, 'redirect', '../page' + params[2]);
});

/// view thread
web.resource(/^\/(\w+)\/(\d+)$/, function (req, params, cb) {
	const board = params[1];
	if (!caps.temporal_access_check(req.ident, board))
		return cb(null, 302, '.');
	if (req.ident.suspension)
		return cb(null, 'ok'); /* TEMP */
	if (!caps.can_access_board(req.ident, board))
		return cb(404);
	const num = parseInt(params[2], 10);
	if (!num)
		return cb(404);
	else if (params[2][0] == '0')
		return cb(null, 'redirect', '' + num);

	const json = web.prefers_json(req.headers.accept);
	let op;
	if (board == 'graveyard') {
		op = num;
	}
	else {
		op = db.OPs[num];
		if (!op)
			return cb(404);
		if (!json && !db.OP_has_tag(board, op)) {
			const tag = db.first_tag_of(op);
			if (tag) {
				if (!caps.can_access_board(req.ident, tag))
					return cb(404);
				return redirect_thread(cb, num, op, tag);
			}
			else {
				winston.warn(`Orphaned post >>${num} with tagless OP >>${op}`);
				return cb(404);
			}
		}
		if (!json && op != num)
			return redirect_thread(cb, num, op);
	}
	if (!caps.can_access_thread(req.ident, op))
		return cb(404);
	if (json)
		return cb(null, 'ok', {json: true, num});

	const yaku = new db.Yakusoku(board, req.ident);
	const reader = new db.Reader(yaku);
	const opts = {redirect: true};

	const lastN = detect_last_n(req.query);
	if (lastN)
		opts.abbrev = lastN + config.ABBREVIATED_REPLIES;

	if (caps.can_administrate(req.ident) && 'reported' in req.query)
		opts.showDead = true;

	reader.get_thread(board, num, opts);
	reader.once('nomatch', () => {
		cb(404);
		yaku.disconnect();
	});
	reader.once('redirect', (op, tag) => {
		redirect_thread(cb, num, op, tag);
		yaku.disconnect();
	});
	reader.once('begin', (preThread) => {
		const headers = web.noCacheHeaders;
		const { subject } = preThread;
		const { abbrev } = opts;
		cb(null, 'ok', { board, op, headers, subject, abbrev, yaku, reader });
	});
},
function (req, resp) {
	/* TODO: json suspensions */
	if (req.ident.suspension)
		return render_suspension(req, resp);
	if (this.json)
		return write_json_post(req, resp, this.num);

	const { board, op, headers, subject, abbrev, yaku, reader } = this;

	resp = write_gzip_head(req, resp, headers);
	const initScript = make_init_script(req.ident);
	render.write_thread_head(resp, initScript, board, op, { subject, abbrev });

	const opts = {fullPosts: true, board, loadAllPostsLink: true};
	render.write_thread_html(reader, req, resp, opts);
	reader.once('end', () => {
		render.write_page_end(resp, req.ident, true);
		resp.end();
		this.finished();
	});
	const on_err = (err) => {
		winston.error(`rendering thread >>${num}: ${err}`);
		resp.end();
		this.finished();
	};
	this.reader.once('error', on_err);
	this.yaku.once('error', on_err);
},
function () {
	this.yaku.disconnect();
});

function write_json_post(req, resp, num) {
	const json = {TODO: true};

	const cache = json.editing ? 'no-cache' : 'private, max-age=86400';
	resp = write_gzip_head(req, resp, {
		'Content-Type': 'application/json',
		'Cache-Control': cache,
	});
	resp.end(JSON.stringify(json));
}

function detect_last_n(query) {
	for (let k in query) {
		const m = /^last(\d+)$/.exec(k);
		if (m) {
			const n = parseInt(m[1], 10);
			if (common.reasonable_last_n(n))
				return n;
		}
	}
	return 0;
}

web.resource(/^\/(\w+)\/(\d+)\/$/, function (req, params, cb) {
	if (!caps.temporal_access_check(req.ident, params[1]))
		cb(null, 302, '..');
	else
		cb(null, 'redirect', '../' + params[2]);
});

web.resource(/^\/outbound\/iqdb\/([\w+\/]{22}\.\w{3,4})$/, (req, params, cb) => {
	let thumb = `${imager.config.MEDIA_URL}vint/${params[1]}`;

	// attempt to make protocol more absolute
	const u = urlParse(thumb, false, true);
	if (!u.protocol) {
		u.protocol = 'http:';
		thumb = u.format();
	}
	cb(null, 303.1, `https://iqdb.org?url=${encodeURIComponent(thumb)}`);
});

web.resource(/^\/outbound\/a\/(\d{0,10})$/, function (req, params, cb) {
	const thread = parseInt(params[1], 10);
	let url = 'https://boards.4chan.org/a/';
	if (thread)
		url += 'thread/' + thread;
	cb(null, 303.1, url);
});

function make_init_script(ident) {
	const secretKey = STATE.hot.connTokenSecretKey;
	if (!ident || !secretKey)
		return '';
	const country = ident.country || 'x';
	const payload = JSON.stringify({
		ip: ident.ip,
		cc: country,
		ts: Date.now(),
	});
	// encrypt payload as 'ctoken'
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
	let crypted = cipher.update(payload, 'utf8', 'hex');
	crypted += cipher.final('hex');
	const authTag = cipher.getAuthTag()
	if (authTag.length != 16)
		throw 'auth tag of unexpected length';
	const combined = iv.toString('hex') + authTag.toString('hex') + crypted;
	return `\t<script>const ctoken = ${json_paranoid(combined)};</script>\n`;
}

function decrypt_ctoken(ctoken) {
	const secretKey = STATE.hot.connTokenSecretKey;
	if (!secretKey)
		return null;
	if (ctoken.length < 56) {
		winston.warn('ctoken too short');
		return null;
	}
	const iv = Buffer.from(ctoken.slice(0, 24), 'hex');
	if (iv.length != 12) {
		winston.warn('iv not hex');
		return null;
	}
	const authTag = Buffer.from(ctoken.slice(24, 56), 'hex');
	if (authTag.length != 16) {
		winston.warn('authTag not hex');
		return null;
	}
	try {
		const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
		decipher.setAuthTag(authTag);
		let plain = decipher.update(ctoken.slice(56), 'hex', 'utf8');
		plain += decipher.final('utf8');
		return JSON.parse(plain);
	}
	catch (e) {
		winston.warn(`decrypt ctoken: ${e}`);
	}
	return null;
}

const TWEET_CACHE = new Map();
const TWEET_CACHE_MAX = 100;
const TWEET_CACHE_EXPIRY = 120*1000;
const TWEET_IN_FLIGHT = new Map();

web.resource(/^\/outbound\/tweet\/(\w{1,15}\/status\/\d{4,20})$/, async (req, params, cb) => {
	const url = new URL('https://publish.twitter.com/oembed');
	{
		const { s, theme } = req.query;
		let tweet_url = 'https://twitter.com/' + params[1];
		if (/^\d+$/.test(s))
			tweet_url += `?s=${s}`;
		url.searchParams.append('url', tweet_url);
		url.searchParams.append('omit_script', 'true');
		url.searchParams.append('theme', theme == 'dark' ? 'dark' : 'light');
	}
	const key = 'tw:'+url;

	// do we have a locally cached copy?
	if (TWEET_CACHE.has(key)) {
		const json = TWEET_CACHE.get(key);
		return cb(null, 'ok', {json});
	}

	// maybe a fetch is already pending?
	if (TWEET_IN_FLIGHT.has(key)) {
		const promise = TWEET_IN_FLIGHT.get(key);
		try {
			const json = await promise;
			if (json) {
				return cb(null, 'ok', {json});
			}
		}
		catch (e) {
			return cb(Muggle("Tweet was lost; try again.", e));
		}
		// shouldn't get here
		return cb('tweet got lost on the way');
	}

	// kick off the twitter API request
	const promise = (async () => {
		const resp = await fetch(url);
		if (!resp.ok) {
			if (resp.status == 404)
				throw 404;
			else
				throw Muggle('twitter returned ' + resp.statusText);
		}
		const json = await resp.json();
		if (!json.html)
			throw Muggle('unexpected tweet form');
		return json;
	})();

	// mark this tweet as in-flight while we fetch it
	TWEET_IN_FLIGHT.set(key, promise);

	// and wait for the tweet to come back
	let json;
	try {
		json = await promise;
	}
	catch (e) {
		cb(e);
		return;
	}
	finally {
		TWEET_IN_FLIGHT.delete(key);
	}

	if (json) {
		// cache the tweet if there's space
		if (TWEET_CACHE.size < TWEET_CACHE_MAX) {
			TWEET_CACHE.set(key, json);
			setTimeout(() => TWEET_CACHE.delete(key), TWEET_CACHE_EXPIRY);
		}

		// pass the tweet json to the second handler
		cb(null, 'ok', {json});
	}

}, function (req, resp) {
	const { json } = this;
	resp = write_gzip_head(req, resp, {
		'Content-Type': 'application/json',
		'Cache-Control': config.DEBUG ? 'no-cache' : 'public, max-age=600',
	});
	resp.end(JSON.stringify(json));
});

web.route_get_auth(/^\/dead\/(src|thumb|mid)\/(\w+\.\w{3})$/,
			function (req, resp, params) {
	if (!caps.can_administrate(req.ident))
		return web.render_404(resp);
	imager.send_dead_image(params[1], params[2], resp);
});


function valid_links(frag, state, ident) {
	const links = {};
	// use a short-lived OneeSama to populate `ident` with all the >>links in `frag`
	const onee = new OneeSama(num => {
		const op = db.OPs[num];
		if (op && caps.can_access_thread(ident, op))
			links[num] = db.OPs[num];
	});
	onee.callback = (frag) => {};
	onee.state = state;
	onee.fragment(frag);
	return _.isEmpty(links) ? null : links;
}

const insertSpec = [{
	frag: 'opt string',
	image: 'opt string',
	nonce: 'id',
	op: 'opt id',
	name: 'opt string',
	email: 'opt string',
	auth: 'opt string',
	subject: 'opt string',
	flavor: 'opt string',
}];

dispatcher[common.INSERT_POST] = function (msg, client) {
	if (!check(insertSpec, msg))
		return false;
	msg = msg[0];
	if (client.post)
		return update_post(msg.frag, client);
	if (!caps.can_access_board(client.ident, client.board))
		return false;
	const { frag, image } = msg;
	if (frag && /^\s*$/g.test(frag))
		return false;
	if (!frag && !image)
		return false;
	if (config.DEBUG)
		debug_command(client, frag);

	return allocate_post(msg, client).catch(err => {
		client.kotowaru(err);
	});
}

async function allocate_post(msg, client) {
	if (client.post)
		throw Muggle("Already have a post.");
	const post = {time: Date.now(), nonce: msg.nonce};
	const { board, ident } = client;
	const { ip } = ident;
	let image_alloc;
	if (msg.image) {
		if (!/^\d+$/.test(msg.image))
			throw Muggle('Expired image token.');
		image_alloc = msg.image;
	}
	let body = '';
	if (msg.frag) {
		if (/^\s*$/g.test(msg.frag))
			throw Muggle('Bad post body.');
		if (msg.frag.length > common.MAX_POST_CHARS)
			throw Muggle('Post is too long.');
		body = msg.frag.replace(config.EXCLUDE_REGEXP, '');
	}

	const { op } = msg;
	if (op) {
		if (db.OPs[op] != op)
			throw Muggle('Thread does not exist.');
		if (!db.OP_has_tag(board, op))
			throw Muggle('Wrong board for thread.');
		post.op = op;
	}
	else {
		// new threads must have an image
		if (!image_alloc)
			throw Muggle('Image missing.');
		let subject = (msg.subject || '').trim();
		subject = subject.replace(config.EXCLUDE_REGEXP, '');
		subject = subject.replace(/[「」]/g, '');
		subject = subject.slice(0, config.SUBJECT_MAX_LENGTH);
		if (subject)
			post.subject = subject;
	}

	/* TODO: Check against client.watching? */
	if (msg.name) {
		const [name, trip, secureTrip] = common.parse_name(msg.name);
		post.name = name;
		const spec = STATE.hot.SPECIAL_TRIPCODES;
		if (spec && trip && trip in spec) {
			post.trip = spec[trip];
		}
		else if (trip || secureTrip) {
			const hashed = tripcode.hash(trip, secureTrip);
			if (hashed)
				post.trip = hashed;
		}
	}
	if (msg.email) {
		post.email = msg.email.trim().substr(0, 320);
		if (common.is_noko(post.email))
			delete post.email;
	}
	if (msg.flavor && /^\w+$/.test(msg.flavor)) {
		if (msg.flavor == 'floop')
			post.flavor = 'floop';
	}
	post.state = common.initial_state();

	if ('auth' in msg) {
		if (!msg.auth || !ident || msg.auth !== ident.auth)
			throw Muggle('Bad auth.');
		post.auth = msg.auth;
	}

	if (op)
		await client.db.check_thread_locked(op);
	else
		await client.db.check_new_thread_throttle(ip);

	// note: `reserve_post` checks the words-per-timeslot rate limiter
	const num = await client.db.reserve_post(op, ip);
	post.num = num;

	if (!client.synced)
		throw Muggle('Dropped; post aborted.');
	// sort-of guard against a race condition here
	if (client.post)
		throw Muggle('Already have a post.');

	const links = valid_links(body, post.state, ident);
	if (links)
		post.links = links;

	const extra = {ip, board};
	if (body.length && is_game_board(board))
		amusement.roll_dice(body, post, extra);

	client.post = post;
	try {
		if (image_alloc) {
			const image = await imager.obtain_image_alloc(image_alloc);
			if (image)
				extra.image_alloc = image;
		}
		if (!client.synced)
			throw Muggle('Dropped; post aborted.');

		await client.db.insert_post(post, body, extra);
		post.body = body;
	}
	catch (err) {
		if (client.post === post)
			client.post = null;
		throw err;
	}
}

function update_post(frag, client) {
	if (typeof frag != 'string')
		return false;
	if (config.DEBUG)
		debug_command(client, frag);
	frag = frag.replace(config.EXCLUDE_REGEXP, '');
	const { post } = client;
	if (!post)
		return false;
	const limit = common.MAX_POST_CHARS;
	if (frag.length > limit || post.length >= limit)
		return false;
	const combined = post.length + frag.length;
	if (combined > limit)
		frag = frag.substr(0, combined - limit);
	const extra = {ip: client.ident.ip};
	if (is_game_board(client.board))
		amusement.roll_dice(frag, post, extra);
	post.body += frag;
	/* imporant: broadcast prior state */
	const old_state = post.state.slice();

	const links = valid_links(frag, post.state, client.ident);
	if (links) {
		if (!post.links)
			post.links = {};
		// TODO wtf use Maps instead
		const new_links = {};
		for (let k in links) {
			const link = links[k];
			if (post.links[k] != link) {
				post.links[k] = link;
				new_links[k] = link;
			}
		}
		extra.links = links;
		extra.new_links = new_links;
	}

	client.db.append_post(post, frag, old_state, extra, err => {
		if (err)
			client.kotowaru(Muggle("Couldn't add text.", err));
	});
	return true;
}
dispatcher[common.UPDATE_POST] = update_post;

function debug_command(client, frag) {
	if (!frag)
		return;
	if (/\bfail\b/.test(frag))
		client.kotowaru(Muggle("Failure requested."));
	else if (/\bclose\b/.test(frag))
		client.socket.close();
}

dispatcher[common.FINISH_POST] = function (msg, client) {
	if (!check([], msg))
		return false;
	if (!client.post)
		return true; /* whatever */
	client.finish_post(function (err) {
		if (err)
			client.kotowaru(Muggle("Couldn't finish post.", err));
	});
	return true;
}

dispatcher[common.DELETE_POSTS] = caps.mod_handler(async (nums, client) => {
	/* Omit to-be-deleted posts that are inside to-be-deleted threads */
	const ops = {};
	const { OPs } = db;
	for (let num of nums) {
		if (num == OPs[num])
			ops[num] = 1;
	}
	nums = nums.filter(num => (OPs[num] == num || !(OPs[num] in ops)));
	await client.db.remove_posts(nums);
});

dispatcher[common.LOCK_THREAD] = caps.mod_handler(async (nums, client) => {
	nums = nums.filter(op => db.OPs[op] == op);
	for (let num of nums) {
		await client.db.toggle_thread_lock(num);
	}
});

dispatcher[common.DELETE_IMAGES] = caps.mod_handler(async (nums, client) => {
	await client.db.remove_images(nums);
});

dispatcher[common.INSERT_IMAGE] = function (msg, client) {
	if (!check(['string'], msg))
		return false;
	const [alloc] = msg;
	const { post } = client;
	if (!post || post.image)
		return false;
	imager.obtain_image_alloc(alloc).catch(err => {
		client.kotowaru(Muggle("Image lost.", err));
	}).then(alloc => {
		if (!post || post.image)
			return;
		client.db.add_image(post, alloc, client.ident.ip, err => {
			if (err)
				client.kotowaru(Muggle("Image insertion problem.", err));
		});
	});
	return true;
};

dispatcher[common.SPOILER_IMAGES] = caps.mod_handler(async (nums, client) => {
	await client.db.force_image_spoilers(nums);
});

dispatcher[common.EXECUTE_JS] = function (msg, client) {
	if (!caps.can_administrate(client.ident))
		return false;
	if (!check(['id'], msg))
		return false;
	const op = msg[0];
	client.db.set_fun_thread(op, function (err) {
		if (err)
			client.kotowaru(err);
	});
	return true;
};

function is_game_board(board) {
	return config.GAME_BOARDS.includes(board);
}

function render_suspension(req, resp) {
setTimeout(function () {
	const ban = req.ident.suspension, tmpl = RES.suspensionTmpl;
	resp.writeHead(200, web.noCacheHeaders);
	resp.write(tmpl[0]);
	resp.write(escape_html(ban.why || ''));
	resp.write(tmpl[1]);
	resp.write(escape_html(ban.until || ''));
	resp.write(tmpl[2]);
	resp.write(escape_html(STATE.hot.EMAIL || '<missing>'));
	resp.end(tmpl[3]);
}, 2000);
}

function get_sockjs_script_sync() {
	const src = fs.readFileSync('tmpl/index.html', 'UTF-8');
	return src.match(/sockjs-[\d.]+(?:\.min)?\.js/)[0];
}

function sockjs_log(sev, message) {
	if (message.length > 80)
		message = message.slice(0, 60) + '[\u2026]' + message.slice(message.length - 14);
	if (sev == 'info')
		winston.verbose(message);
	else if (sev == 'error')
		winston.error(message);
}
if (config.DEBUG) {
	winston.remove(winston.transports.Console);
	winston.add(winston.transports.Console, {level: 'verbose'});
}
else {
	winston.add(winston.transports.File, {level: 'warn', filename: 'error.log'});
}

function start_server() {
	const is_unix_socket = (typeof config.LISTEN_PORT == 'string');
	if (is_unix_socket) {
		try { fs.unlinkSync(config.LISTEN_PORT); } catch (e) {}
	}
	web.server.listen(config.LISTEN_PORT, config.LISTEN_HOST);
	if (is_unix_socket) {
		fs.chmodSync(config.LISTEN_PORT, '777'); // TEMP
	}


	const sockjsPath = 'js/' + get_sockjs_script_sync();
	const sockOpts = {
		sockjs_url: imager.config.MEDIA_URL + sockjsPath,
		prefix: config.SOCKET_PATH,
		jsessionid: false,
		log: sockjs_log,
		websocket: true,
	};
	const sockJs = require('sockjs').createServer(sockOpts);
	web.server.on('upgrade', (req, resp) => resp.end());
	sockJs.installHandlers(web.server);

	sockJs.on('connection', (socket) => {
		let ip = socket.remoteAddress;
		let country;
		if (config.TRUST_X_FORWARDED_FOR) {
			const ff = web.parse_forwarded_for(socket.headers['x-forwarded-for']);
			if (ff)
				ip = ff;
		}
		if (!ip) {
			winston.warn(`no ip from ${socket}`);
			socket.close();
			return;
		}

		// parse ctoken
		const url = urlParse(socket.url, true);
		if (url.query && url.query.ctoken) {
			const token = decrypt_ctoken(url.query.ctoken);
			if (token) {
				if (token.ts + 24*60*60*1000 < Date.now()) {
					// token expired, ask for a new one?
					winston.warn('ctoken: expired');
				}
				if (ip != token.ip)
					winston.info(`ctoken: ${ip} != ${token.ip}`);
				country = token.cc;
			}
			else {
				winston.log(`ctoken: invalid from ${ip}`);
			}
		}
		else if (STATE.hot.connTokenSecretKey) {
			winston.warn(`ctoken: MISSING from ${ip}`);
		}

		const client = new Okyaku(socket, ip, country);
		socket.on('data', client.on_message.bind(client));
		socket.on('close', client.on_close.bind(client));
	});

	process.on('SIGHUP', hot_reloader);
	db.on_pub('reloadHot', hot_reloader);

	if (config.DAEMON) {
		const daemon = require('daemon');
		daemon.start(process.stdout.fd, process.stderr.fd);
		daemon.lock(config.PID_FILE);
		winston.remove(winston.transports.Console);
		return;
	}

	process.nextTick(non_daemon_pid_setup);

	winston.info(`Listening on ${config.LISTEN_HOST || ''}${is_unix_socket ? '' : ':'}${config.LISTEN_PORT}.`);
}

async function hot_reloader() {
	try {
		await STATE.reload_hot_resources();
	}
	catch (err) {
		winston.error("Error trying to reload:");
		winston.error(err);
		return;
	}
	scan_client_caps();
	winston.info('Reloaded initial state.');
}

function non_daemon_pid_setup() {
	const pidFile = config.PID_FILE;
	fs.writeFile(pidFile, process.pid+'\n', (err) => {
		if (err)
			return winston.warn(`Couldn't write pid: ${err}`);
		process.once('SIGINT', delete_pid);
		process.once('SIGTERM', delete_pid);
		winston.info(`PID ${process.pid} written to ${pidFile}`);
	});

	function delete_pid() {
		try {
			fs.unlinkSync(pidFile);
		}
		catch (e) { }
		process.exit(1);
	}
}

async function main() {
	if (!process.getuid())
		throw new Error("Refusing to run as root.");
	tripcode.setSalt(config.SECURE_SALT);

	await imager.make_media_dirs();
	await setup_imager_relay();
	await STATE.reload_hot_resources();
	await db.track_OPs();

	const yaku = new db.Yakusoku(null, db.UPKEEP_IDENT);
	let onegai;
	const writes = [];
	if (!config.READ_ONLY) {
		writes.push(yaku.finish_all.bind(yaku));
		if (!imager.is_standalone()) {
			onegai = new imager.Onegai;
			writes.push(onegai.delete_temporaries.bind(
					onegai));
		}
	}
	async.series(writes, function (err) {
		if (err)
			throw err;
		yaku.disconnect();
		if (onegai)
			onegai.disconnect();
		process.nextTick(start_server);
	});
}

if (require.main === module)
	main().catch(err => { winston.error(err); process.exit(1); });
