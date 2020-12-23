const _ = require('./lib/underscore'),
    async = require('async'),
    cache = require('./server/state').dbCache,
    caps = require('./server/caps'),
    common = require('./common'),
    config = require('./config'),
    events = require('events'),
    fs = require('fs'),
    { isLoopback } = require('ip'),
    Muggle = require('./etc').Muggle,
    util = require('util'),
    winston = require('winston');

const imager = require('./imager');
const amusement = require('./server/amusement');

const OPs = exports.OPs = cache.OPs;
const TAGS = exports.TAGS = cache.opTags;
const SUBS = exports.SUBS = cache.threadSubs;

const LUA = {};
function register_lua(name) {
	const src = fs.readFileSync(`lua/${name}.lua`, 'UTF-8');
	LUA[name] = {src};
}

function redis_client() {
	const redis = require('redis');
	const conn = redis.createClient(config.REDIS_PORT || undefined);
	promisify_redis_client(conn);

	// ASYNC SETUP RACE!
	const load = entry => {
		conn.script('load', entry.src, (err, sha) => {
			if (err)
				throw err;
			entry.sha = sha;
		});
	};

	for (let k in LUA)
		load(LUA[k]);

	return conn;
}
exports.redis_client = redis_client;

function promisify_redis_client(conn) {
	const { RedisClient } = require('redis');

	// provide `r.promise.*` async methods
	conn.promise = Object.entries(RedisClient.prototype)
		.filter(([_, f]) => typeof f === 'function' && f.name.toLowerCase() === f.name)
		.reduce((acc, [name, method]) => ({
			...acc,
			[name]: util.promisify(method).bind(conn)
		}), {});

	// multi() should return something with `.promise.exec()` available
	conn.multi = function () {
		const r = RedisClient.prototype.multi.call(this);
		r.promise = {
			exec: util.promisify(r.exec).bind(r)
		};
		return r;
	};
}
exports.promisify_redis_client = promisify_redis_client;

// wait for the `register_lua` calls before connecting
process.nextTick(() => {
	global.redis = redis_client();
});

/* REAL-TIME UPDATES */

function Subscription(targetInfo) {
	events.EventEmitter.call(this);
	this.setMaxListeners(0);

	this.fullKey = targetInfo.key;
	this.target = targetInfo.target;
	this.channel = targetInfo.channel;
	SUBS[this.fullKey] = this;

	// once all `pending_subscriptions` are subscribed, `ready` will resolve
	this.pending_subscriptions = new Set();
	this.ready = new Promise((resolve, reject) => {
		this._ready_callbacks = {resolve, reject};
	});

	this.k = redis_client();
	this.k.on('error', this._on_sub_error.bind(this));
	this.k.on('subscribe', this._on_one_sub.bind(this));
	this.k.subscribe(this.target);
	this.subscriptions = [this.target];
	this.pending_subscriptions.add(this.target);
	if (this.target != this.fullKey) {
		this.k.subscribe(this.fullKey);
		this.pending_subscriptions.add(this.fullKey);
	}
};

util.inherits(Subscription, events.EventEmitter);
const S = Subscription.prototype;

Subscription.full_key = function (target, ident) {
	let channel;
	if (ident && ident.priv)
		channel = 'priv:' + ident.priv;
	else if (caps.can_moderate(ident))
		channel = 'auth';
	let key = channel ? `${channel}:${target}` : target;
	return {key, channel, target};
};

Subscription.get = function (target, ident) {
	const full = Subscription.full_key(target, ident);
	let sub = SUBS[full.key];
	if (!sub)
		sub = new Subscription(full);
	return sub;
};

S._on_one_sub = function (name) {
	if (!this.pending_subscriptions.delete(name))
		throw new Error(`Obtained unasked-for subscription ${name}?!`);
	if (this.pending_subscriptions.size > 0)
		return;
	// hooray, we're now subscribed to everything we asked for
	delete this.pending_subscriptions;
	let { k } = this;
	k.removeAllListeners('subscribe');
	k.on('message', this.on_message.bind(this));
	k.removeAllListeners('error');
	k.on('error', this.sink_sub.bind(this));

	if (this._ready_callbacks) {
		const { resolve } = this._ready_callbacks;
		delete this._ready_callbacks;
		resolve();
	}
};

function length_prefixed(str) {
	return `${str.length}|${str}`;
}

function parse_pub_message(msg) {
	const m = msg.match(/^(\d+)\|/);
	const prefixLen = m[0].length;
	const bodyLen = parse_number(m[1]);
	const info = {body: msg.substr(prefixLen, bodyLen)};
	const suffixPos = prefixLen + bodyLen;
	if (msg.length > suffixPos)
		info.suffixPos = suffixPos;
	return info;
}

S.on_message = function (chan, msg) {
	/* Do we need to clarify whether this came from target or fullKey? */
	let parsed = parse_pub_message(msg);
	let extra;
	if (this.channel && parsed.suffixPos) {
		const suffix = JSON.parse(msg.slice(parsed.suffixPos));
		extra = suffix[this.channel];
	}
	msg = parsed.body;
	let m = msg.match(/^(\d+),(\d+)/);
	const op = parse_number(m[1]);
	const kind = parse_number(m[2]);

	if (extra && kind == common.INSERT_POST) {
		// horrifying hack: splice `ip` into INSERT_POST log
		let m = msg.match(/^(\d+,2,\d+,{)(.+)$/);
		if (m && extra.ip) {
			if (/"ip":/.test(msg))
				throw "`ip` in public pub " + chan;
			msg = `${m[1]}"ip":${JSON.stringify(extra.ip)},${m[2]}`;
		}
	}

	this.emit('update', op, kind, `[[${msg}]]`);
};

S._on_sub_error = function (err) {
	winston.error(`Subscription error: ${err.stack || err}`);
	this.commit_sudoku();
	if (this._ready_callbacks) {
		const { reject } = this._ready_callbacks;
		delete this._ready_callbacks;
		reject(err);
	}
};

S.sink_sub = function (err) {
	if (config.DEBUG)
		throw err;
	this.emit('error', this.target, err);
	this.commit_sudoku();
};

S.commit_sudoku = function () {
	const { k } = this;
	k.removeAllListeners('error');
	k.removeAllListeners('message');
	k.removeAllListeners('subscribe');
	k.quit();
	if (SUBS[this.fullKey] === this)
		delete SUBS[this.fullKey];
	this.removeAllListeners('update');
	this.removeAllListeners('error');
};

S.has_no_listeners = function () {
	/* Possibly idle out after a while */
	if (this.idleOutTimer)
		clearTimeout(this.idleOutTimer);
	this.idleOutTimer = setTimeout(() => {
		this.idleOutTimer = null;
		if (this.listeners('update').length == 0)
			this.commit_sudoku();
	}, 30 * 1000);
};

/* OP CACHE */

function add_OP_tag(tagIndex, op) {
	const tags = TAGS[op];
	if (tags === undefined)
		TAGS[op] = tagIndex;
	else if (typeof tags == 'number') {
		if (tagIndex != tags)
			TAGS[op] = [tags, tagIndex];
	}
	else if (tags.indexOf(tagIndex) < 0)
		tags.push(tagIndex);
}

function set_OP_tag(tagIndex, op) {
	TAGS[op] = tagIndex;
}

function OP_has_tag(tag, op) {
	const index = config.BOARDS.indexOf(tag);
	if (index < 0)
		return false;
	const tags = TAGS[op];
	if (tags === undefined)
		return false;
	if (typeof tags == 'number')
		return index == tags;
	else
		return tags.indexOf(index) >= 0;
};
exports.OP_has_tag = OP_has_tag;

exports.first_tag_of = function (op) {
	const tags = TAGS[op];
	if (tags === undefined)
		return false;
	else if (typeof tags == 'number')
		return config.BOARDS[tags];
	else
		return config.BOARDS[tags[0]];
};

function tags_of(op) {
	const tags = TAGS[op];
	if (tags === undefined)
		return false;
	else if (typeof tags == 'number')
		return [config.BOARDS[tags]];
	else
		return tags.map(i => config.BOARDS[i]);
}
exports.tags_of = tags_of;

function update_cache(chan, msg) {
	msg = JSON.parse(msg);
	let op = msg.op, kind = msg.kind, tag = msg.tag;

	if (kind == common.INSERT_POST) {
		if (msg.num)
			OPs[msg.num] = op;
		else {
			add_OP_tag(config.BOARDS.indexOf(tag), op);
			OPs[op] = op;
		}
	}
	else if (kind == common.MOVE_THREAD) {
		set_OP_tag(config.BOARDS.indexOf(tag), op);
	}
	else if (kind == common.DELETE_POSTS) {
		msg.nums.forEach(num => {
			delete OPs[num];
		});
	}
	else if (kind == common.DELETE_THREAD) {
		msg.nums.forEach(num => {
			delete OPs[num];
		});
		delete TAGS[op];
	}
}

exports.track_OPs = () => {
	return new Promise((resolve, reject) => {
		const k = redis_client();
		k.once('error', reject);
		k.subscribe('cache');
		k.once('subscribe', () => {
			load_OPs().then(resolve, reject);
		});
		k.on('message', update_cache);
		/* k persists for the purpose of cache updates */
	});
};

exports.on_pub = function (name, handler) {
	// TODO: share redis connection
	const k = redis_client();
	k.subscribe(name);
	k.on('message', handler);
	/* k persists */
};

async function load_OPs() {
	const r = global.redis;
	const boards = config.BOARDS;

	let threadsKey;
	let expiryKey = expiry_queue_key();

	// Want consistent ordering in the TAGS entries for multi-tag threads
	// (so do them in series)
	for (let tagIndex = 0; tagIndex < boards.length; tagIndex++) {
		const tag = boards[tagIndex];
		threadsKey = `tag:${tag_key(tag)}:threads`;
		const threads = await r.promise.zrange(threadsKey, 0, -1);
		for (let op of threads) {
			op = parse_number(op);
			let ps = [scan_thread(tagIndex, op)];
			if (!config.READ_ONLY && config.THREAD_EXPIRY && tag != 'archive') {
				ps.push(refresh_expiry(tag, op));
			}
			await Promise.all(ps);
		}
	}

	async function scan_thread(tagIndex, op) {
		op = parse_number(op);
		add_OP_tag(tagIndex, op);
		OPs[op] = op;
		const [posts, _privs] = await get_all_replies_and_privs(r, op);
		for (let num of posts) {
			OPs[parse_number(num)] = op;
		}
	}

	async function refresh_expiry(tag, op) {
		if (tag == config.STAFF_BOARD)
			return;
		const entry = op + ':' + tag_key(tag);
		const queries = ['time', 'immortal'];
		const thread = await hmget_obj(r, 'thread:'+op, queries);
		if (!thread.time) {
			winston.warn(`Thread #${op} doesn't exist.`);
			const m = r.multi();
			m.zrem(threadsKey, op);
			m.zrem(expiryKey, entry);
			await m.promise.exec();
		}
		else if (thread.immortal) {
			await r.promise.zrem(expiryKey, entry);
		}
		else {
			const score = expiry_queue_score(thread.time);
			await r.promise.zadd(expiryKey, score, entry);
		}
	}
}

function expiry_queue_score(time) {
	return Math.floor(parse_number(time)/1000 + config.THREAD_EXPIRY);
}

function expiry_queue_key() {
	return 'expiry:' + config.THREAD_EXPIRY;
}
exports.expiry_queue_key = expiry_queue_key;

/* SOCIETY */

exports.is_board = (board) => config.BOARDS.includes(board);

exports.UPKEEP_IDENT = {auth: 'Upkeep', ip: '127.0.0.1'};

function Yakusoku(board, ident) {
	events.EventEmitter.call(this);
	this.id = ++(cache.YAKUMAN);
	this.tag = board;
	this.ident = ident;
	this.subs = [];
}

util.inherits(Yakusoku, events.EventEmitter);
exports.Yakusoku = Yakusoku;
const Y = Yakusoku.prototype;

Y.connect = function () {
	// multiple redis connections are pointless (without slaves)
	return global.redis;
};

Y.disconnect = function () {
	this.removeAllListeners('end');
};

// TODO use Map, Promises
function forEachInObject(obj, f, callback) {
	let total = 0, complete = 0, done = false, errors = [];
	const cb = (err) => {
		complete++;
		if (err)
			errors.push(err);
		if (done && complete == total)
			callback(errors.length ? errors : null);
	};
	for (let k in obj) {
		if (obj.hasOwnProperty(k)) {
			total++;
			f(k, cb);
		}
	}
	done = true;
	if (complete == total)
		callback(errors.length ? errors : null);
}

Y.target_key = function (id) {
	return (id == 'live') ? 'tag:' + this.tag : 'thread:' + id;
};

Y.kiku = async function (targets, on_update, on_sink) {
	this.on_update = on_update;
	this.on_sink = on_sink;
	const { ident } = this;
	const promises = [];
	for (let [id, _sync] of targets) {
		const target = this.target_key(id);
		const sub = Subscription.get(target, ident);
		sub.on('update', on_update);
		sub.on('error', on_sink);
		this.subs.push(sub.fullKey);
		promises.push(sub.ready);
	}
	await Promise.all(promises);
};

Y.kikanai = function () {
	if (!this.on_update)
		return;
	for (let key of this.subs) {
		const sub = SUBS[key];
		if (sub) {
			sub.removeListener('update', this.on_update);
			sub.removeListener('error', this.on_sink);
			if (sub.listeners('update').length == 0)
				sub.has_no_listeners();
		}
	}
	this.subs = [];
	this.on_update = null;
	this.on_sink = null;
};

function post_volume(view, body) {
	return (body ? body.length : 0) +
		(view ? (config.NEW_POST_WORTH || 0) : 0) +
		((view && view.image) ? (config.IMAGE_WORTH || 0) : 0);
}

function update_throughput(m, ip, when, quant) {
	const key = 'ip:' + ip + ':throttle:';
	const shortKey = key + short_term_timeslot(when);
	const longKey = key + long_term_timeslot(when);
	m.incrby(shortKey, quant);
	m.incrby(longKey, quant);
	/* Don't want to use expireat in case of timezone trickery
	   or something dumb. (Really, UTC should be OK though...) */
	// Conservative expirations
	m.expire(shortKey, 10 * 60);
	m.expire(longKey, 2 * 24 * 3600);
}

function short_term_timeslot(when) {
	return Math.floor(when / (1000 * 60 * 5));
}

function long_term_timeslot(when) {
	return Math.floor(when / (1000 * 60 * 60 * 24));
}

Y.reserve_post = async function (op, ip) {
	if (this.ident.readOnly)
		throw Muggle("Can't post right now.");
	const r = this.connect();

	if (!isLoopback(ip)) {
		const key = `ip:${ip}:throttle:`;
		const now = Date.now();
		const shortTermKey = key + short_term_timeslot(now);
		const longTermKey = key + long_term_timeslot(now);
		const [short, long] = await r.promise.mget([shortTermKey, longTermKey]);
		if (short > config.SHORT_TERM_LIMIT || long > config.LONG_TERM_LIMIT)
			throw Muggle('Reduce your speed.');
	}

	const num = await r.promise.incr('postctr');
	OPs[num] = op || num;
	return num;
};

const optPostFields = 'name trip email auth subject flavor'.split(' ');

Y.insert_post = async function (msg, body, extra) {
	if (this.ident.readOnly)
		throw Muggle("Can't post right now.");
	// DRY what is the difference between extra.board and this.tag?
	const { tag } = this;
	if (!tag)
		throw Muggle("Can't retrieve board for posting.");
	const { ip, board } = extra;
	let { num, op, time } = msg;
	if (!num)
		throw Muggle("No post num.");
	else if (!ip)
		throw Muggle("No IP.");
	else if (op) {
		if (OPs[op] != op || !OP_has_tag(board, op)) {
			delete OPs[num];
			throw Muggle('Thread does not exist.');
		}
	}

	// make a fresh post object `view` to put post info into
	const view = {time, ip, state: msg.state.join()};
	for (let field of optPostFields) {
		if (msg[field])
			view[field] = msg[field];
	}
	const tagKey = `tag:${tag_key(tag)}`;
	if (op)
		view.op = op;
	else {
		view.tags = tag_key(board);
		if (board == config.STAFF_BOARD)
			view.immortal = 1;
	}

	if (extra.image_alloc) {
		msg.image = extra.image_alloc.image;
		if (!op == msg.image.pinky)
			throw Muggle("Image is the wrong size.");
		delete msg.image.pinky;
	}

	const key = (op ? 'post:' : 'thread:') + num;
	const bump = !op || !common.is_sage(view.email);
	const r = this.connect();
	const m = r.multi();
	m.incr(tagKey + ':postctr'); // must be first
	if (op)
		m.hget('thread:' + op, 'subject'); // must be second
	if (bump)
		m.incr(tagKey + ':bumpctr');
	m.sadd('liveposts', key);

	// why do we flatten here and then, 50 lines later, re-hydrate?
	flatten_post({src: msg, dest: view});

	if (msg.image) {
		if (op)
			m.hincrby('thread:' + op, 'imgctr', 1);
		else
			view.imgctr = 1;
		view.dims = view.dims.toString();
		// tell the imager to remember this hash for duplicate checking
		imager.note_hash(msg.image.hash, num);
	}
	m.hmset(key, view);
	m.set(key + ':body', body);
	if (msg.links)
		m.hmset(key + ':links', msg.links);

	let etc = {cacheUpdate: {}};
	let { priv } = this.ident;
	if (op) {
		etc.ipNum = num;
		etc.cacheUpdate.num = num;
		if (priv) {
			m.sadd(`thread:${op}:privs`, priv);
			m.rpush(`thread:${op}:privs:${priv}`, num);
		}
		else
			m.rpush(`thread:${op}:posts`, num);
	}
	else {
		// TODO: Add to alternate thread list?
		// set conditional hide?
		op = num;
		if (!view.immortal) {
			const score = expiry_queue_score(msg.time);
			const entry = `${num}:${tag_key(this.tag)}`;
			m.zadd(expiry_queue_key(), score, entry);
		}
		/* Rate-limit new threads */
		if (!isLoopback(ip))
			m.setex(`ip:${ip}:throttle:thread`, config.THREAD_THROTTLE, op);
	}

	/* Denormalize for backlog */
	view.nonce = msg.nonce;
	view.body = body;
	if (msg.links)
		view.links = msg.links;
	hydrate_post(view);
	delete view.ip;

	if (msg.image) {
		await imager.commit_image_alloc(extra.image_alloc);
	}
	if (ip) {
		const n = post_volume(view, body);
		if (n > 0)
			update_throughput(m, ip, view.time, n);
		etc.ip = ip;
	}
	this._log(m, op, common.INSERT_POST, [num, view], etc);

	try {
		const [postctr, subject_get] = await m.promise.exec();
		if (bump) {
			const subject = subject_val(op, op==num ? view.subject : subject_get);
			const m = r.multi();
			m.zadd(tagKey + ':threads', postctr, op);
			if (subject)
				m.zadd(tagKey + ':subjects', postctr, subject);
			await m.promise.exec();
		}
	}
	catch (err) {
		delete OPs[num];
		throw err;
	}
};

/// Weird interface.
/// Under normal circumstances returns [deleted_op, deleted_num].
/// If a race condition occurs, returns (-deleted_num)
Y.remove_post = async function (from_thread, num) {
	num = parse_number(num);
	let op = OPs[num];
	if (!op)
		throw Muggle('No such post.');
	if (op == num) {
		if (!from_thread)
			throw Muggle('Deletion loop?!');
		return await this.remove_thread(num);
	}

	let r = this.connect();

	if (from_thread) {
		const key = 'thread:' + op;
		const delCount = await r.promise.lrem(key + ':posts', -1, num);
		/* did someone else already delete this? */
		if (delCount != 1)
			return -num;
		/* record deletion */
		await r.promise.rpush(key + ':dels', num);
	}

	// okay, it's gone from the thread
	{
		const key = 'post:' + num;
		await r.promise.hset(key, 'hide', '1');
		/* TODO push cache update? */
		delete OPs[num];

		/* In the background, try to finish the post */
		this.finish_quietly(key, warn);
		this.hide_image(key).catch(warn);
	}

	return [op, num];
};

Y.remove_posts = async function (nums) {
	const dels = await Promise.all(nums.map(num => this.remove_post(true, num)));

	let threads = {}, already_gone = [];
	for (let del of dels) {
		// parse the weird return val of `remove_post` (todo refactor)
		if (Array.isArray(del)) {
			const op = del[0];
			if (!(op in threads))
				threads[op] = [];
			threads[op].push(del[1]);
		}
		else if (del < 0)
			already_gone.push(-del);
		else if (del)
			winston.warn('Unknown del: ' + del);
	}
	if (already_gone.length)
		winston.warn("Tried to delete missing posts: " + already_gone);

	if (!_.isEmpty(threads)) {
		let m = this.connect().multi();
		for (let op in threads) {
			let nums = threads[op];
			nums.sort();
			let opts = {cacheUpdate: {nums}};
			this._log(m, op, common.DELETE_POSTS, nums, opts);
		}
		await m.promise.exec();
	}
};

Y.remove_thread = async function (op) {
	if (OPs[op] != op)
		throw new Muggle('Thread does not exist.');
	const r = this.connect();
	const key = 'thread:' + op;
	const dead_key = 'dead:' + op;
	const graveyardKey = 'tag:' + tag_key('graveyard');
	const [nums, privs] = await get_all_replies_and_privs(r, op);
	const opts = {
		cacheUpdate: {nums}
	};

	await Promise.all(nums.map(num => this.remove_post(false, num)));

	let deadCtr, post;
	{
		const m = r.multi();
		m.incr(graveyardKey + ':bumpctr');
		m.hgetall(key);
		[deadCtr, post] = await m.promise.exec();
	}
	// Delete the thread from the index, and rename its keys
	let results;
	{
		let tags = parse_tags(post.tags);
		let subject = subject_val(op, post.subject);
		/* Rename thread keys, move to graveyard */
		const m = r.multi();
		const expiryKey = expiry_queue_key();
		for (let tag of tags) {
			const tagKey = tag_key(tag);
			m.zrem(expiryKey, `${op}:${tagKey}`);
			m.zrem(`tag:${tagKey}:threads`, op);
			if (subject)
				m.zrem(`tag:${tagKey}:subjects`, subject);
		}
		m.zadd(graveyardKey + ':threads', deadCtr, op);
		opts.tags = tags;
		this._log(m, op, common.DELETE_THREAD, [], opts);
		m.hset(key, 'hide', 1);
		/* Next two vals are checked */
		m.renamenx(key, dead_key);
		m.renamenx(key + ':history', dead_key + ':history');
		m.renamenx(key + ':ips', dead_key + ':ips');
		results = await m.promise.exec();
	}
	// See if our big transaction succeeded
	{
		let dels = results.slice(-2);
		if (dels.some(x => x === 0))
			throw new Error("Already deleted?!");
		delete OPs[op];
		delete TAGS[op];

		/* Extra renames now that we have renamenx exclusivity */
		const m = r.multi();
		m.rename(key + ':posts', dead_key + ':posts');
		m.rename(key + ':links', dead_key + ':links');
		if (privs.length) {
			m.rename(key + ':privs', dead_key + ':privs');
			for (let priv of privs) {
				const suff = ':privs:' + priv;
				m.rename(key + suff, dead_key + suff);
			}
		}
		await m.promise.exec();
	}
	// Clean everything up in the background if anything is still there
	{
		this.finish_quietly(dead_key, warn);
		this.hide_image(dead_key).catch(warn);
	}
};

Y.archive_thread = function (op, callback) {
	const r = this.connect();
	const key = 'thread:' + op, archiveKey = 'tag:' + tag_key('archive');
	async.waterfall([
	next => {
		const m = r.multi();
		m.exists(key);
		m.hget(key, 'immortal');
		m.zscore('tag:' + tag_key('graveyard') + ':threads', op);
		m.exec(next);
	},
	(rs, next) => {
		if (!rs[0])
			return callback(Muggle(key + ' does not exist.'));
		if (parse_number(rs[1]))
			return callback(Muggle(key + ' is immortal.'));
		if (rs[2])
			return callback(Muggle(key + ' is already deleted.'));
		const m = r.multi();
		// order counts
		m.hgetall(key);
		m.hgetall(key + ':links');
		m.llen(key + ':posts');
		m.smembers(key + ':privs');
		m.lrange(key + ':dels', 0, -1);
		m.exec(next);
	},
	(rs, next) => {
		let view = rs[0], links = rs[1], replyCount = rs[2],
				privs = rs[3], dels = rs[4];
		let subject = subject_val(op, view.subject);
		let tags = view.tags;
		const m = r.multi();
		// move to archive tag only
		m.hset(key, 'origTags', tags);
		m.hset(key, 'tags', tag_key('archive'));
		tags = parse_tags(tags);
		tags.forEach(tag => {
			const tagKey = 'tag:' + tag_key(tag);
			m.zrem(tagKey + ':threads', op);
			if (subject)
				m.zrem(tagKey + ':subjects', subject);
		});
		m.zadd(archiveKey + ':threads', op, op);
		this._log(m, op, common.DELETE_THREAD, [], {tags: tags});

		// shallow thread insertion message in archive
		if (!_.isEmpty(links))
			view.links = links;
		hydrate_post(view);
		delete view.ip;
		view.replyctr = replyCount;
		view.hctr = 0;
		let etc = {tags: ['archive'], cacheUpdate: {}};
		this._log(m, op, common.MOVE_THREAD, [view], etc);

		// clear history; note new history could be added
		// for deletion in the archive
		// (a bit silly right after adding a new entry)
		m.hdel(key, 'hctr');
		m.del(key + ':history');
		m.del(key + ':ips');

		// delete hidden posts
		dels.forEach(num => {
			m.del('post:' + num);
			m.del('post:' + num + ':links');
		});
		m.del(key + ':dels');

		if (privs.length) {
			m.del(key + ':privs');
			privs.forEach(priv => m.del(key + ':privs:' + priv));
		}

		m.exec(next);
	},
	(results, done) => {
		set_OP_tag(config.BOARDS.indexOf('archive'), op);
		done();
	}], callback);
};

/* BOILERPLATE CITY */

Y.gate_read_only = function () {
	if (this.ident.readOnly)
		throw Muggle("Read-only right now.");
};

Y.remove_images = async function (nums) {
	this.gate_read_only();

	const r = this.connect();
	const threads = new Map();
	await Promise.all(nums.map(async (num) => {
		const op = OPs[num];
		if (!op)
			return;
		const key = (op == num ? 'thread:' : 'post:') + num;
		const exists = await r.promise.hexists(key, 'src');
		if (!exists)
			return;

		// remove it from the filesystem
		await this.hide_image(key);

		// remove it from the thread
		const affected = await r.promise.hset(key, 'hideimg', 1);
		if (!affected)
			return;
		// update the accounting
		await r.promise.hincrby('thread:' + op, 'imgctr', -1);
		// track which images were deleted for the log later
		if (threads.has(op))
			threads.get(op).push(num);
		else
			threads.set(op, [num]);
	}));

	const m = r.multi();
	for (let [op, nums] of threads.entries())
		this._log(m, op, common.DELETE_IMAGES, nums, {tags: tags_of(op)});
	await m.promise.exec();
};

/// Move this image's files to the graveyard.
Y.hide_image = async function (key) {
	this.gate_read_only();

	const r = this.connect();
	// load up the relevant image state
	const imgKeys = ['hideimg', 'hash', 'src', 'thumb', 'realthumb', 'mid'];
	const rs = await r.promise.hmget(key, imgKeys);
	if (!rs)
		return;
	const image = {};
	for (let i = 0; i < rs.length; i++)
		image[imgKeys[i]] = rs[i];
	if (image.hideimg) /* already gone */
		return;

	// finally, ask the imager to move it to the graveyard
	await imager.bury_image(image);
};

Y.force_image_spoilers = async function (nums) {
	if (this.ident.readOnly)
		throw Muggle("Read-only right now.");
	const r = this.connect();
	const threads = new Map();
	for (let num of nums) {
		const op = OPs[num];
		if (!op)
			continue;
		const key = (op == num ? 'thread:' : 'post:') + num;
		const spoilerKeys = ['src', 'spoiler', 'realthumb'];
		const info = await r.promise.hmget(key, spoilerKeys);
		if (!info[0] || info[1] || info[2])
			continue; // no image or already spoilt

		const index = common.pick_spoiler(-1).index;
		await r.promise.hmset(key, 'spoiler', index);
		if (threads.has(op))
			threads.get(op).push([num, index]);
		else
			threads.set(op, [[num, index]]);
	}
	const m = r.multi();
	for (let [op, result] of threads) {
		const tags = tags_of(op);
		this._log(m, op, common.SPOILER_IMAGES, result, {tags});
	}
	await m.promise.exec();
};

Y.toggle_thread_lock = async function (op) {
	if (this.ident.readOnly)
		throw Muggle("Read-only right now.");
	if (OPs[op] != op)
		throw Muggle('Thread does not exist.');
	const r = this.connect();
	const key = 'thread:' + op;
	const locked = await r.promise.hexists(key, 'locked');
	const m = r.multi();
	if (locked)
		m.hdel(key, 'locked');
	else
		m.hset(key, 'locked', '1');
	const act = locked ? common.UNLOCK_THREAD : common.LOCK_THREAD;
	this._log(m, op, act, []);
	await m.promise.exec();
};

/* END BOILERPLATE CITY */

function warn(err) {
	if (err)
		winston.warn('Warning: ' + err);
}

Y.check_thread_locked = async function (op) {
	const lock = await this.connect().promise.hexists(`thread:${op}`, 'locked');
	if (lock)
		throw Muggle(`Thread >>${op} is locked.`);
};

Y.check_new_thread_throttle = async function (ip) {
	const key = `ip:${ip}:throttle:thread`;
	const exists = await this.connect().promise.exists(key);
	if (exists)
		throw Muggle('Too soon. Try again later.');
};

Y.add_image = async function (post, alloc, ip) {
	const r = this.connect();
	let { num, op } = post;
	if (!op)
		throw Muggle("Can't add another image to an OP.");
	let { image } = alloc;
	if (!image.pinky)
		throw Muggle("Image is wrong size.");
	delete image.pinky;

	const key = 'post:' + num;
	const exists = await r.promise.exists(key);
	if (!exists)
		throw Muggle("Post does not exist.");

	await imager.commit_image_alloc(alloc);

	{
		const m = r.multi();
		imager.note_hash(image.hash, num);
		// HACK: hmset doesn't like our array, but we need it
		let orig_dims = image.dims;
		image.dims = orig_dims.toString();
		m.hmset(key, image);
		image.dims = orig_dims;

		m.hincrby('thread:' + op, 'imgctr', 1);

		delete image.hash;
		this._log(m, op, common.INSERT_IMAGE, [num, image]);

		const now = Date.now();
		update_throughput(m, ip, now, post_volume({image: true}));
		await m.promise.exec();
	}
};

Y.append_post = async function (post, tail, old_state, extra) {
	const m = this.connect().multi();
	const key = (post.op ? 'post:' : 'thread:') + post.num;
	/* Don't need to check .exists() thanks to client state */
	m.append(key + ':body', tail);
	/* XXX: fragile */
	if (old_state[0] != post.state[0] || old_state[1] != post.state[1])
		m.hset(key, 'state', post.state.join());
	if (extra.ip) {
		const now = Date.now();
		update_throughput(m, extra.ip, now, post_volume(null, tail));
	}
	if (!_.isEmpty(extra.new_links))
		m.hmset(key + ':links', extra.new_links);

	// possibly attach data for dice rolls etc. to the update
	const attached = {post, extra, writeKeys: {}, attach: {}};
	amusement.attach_dice_to_post(attached);

	{
		for (let h in attached.writeKeys)
			m.hset(key, h, attached.writeKeys[h]);
		const msg = [post.num, tail];
		const links = extra.links || {};

		const a = old_state[0], b = old_state[1];
		// message tail is [... a, b, links, attachment]
		// default values [... 0, 0, {}, {}] don't need to be sent
		// to minimize log output
		if (!_.isEmpty(attached.attach))
			msg.push(a, b, links, attached.attach);
		else if (!_.isEmpty(links))
			msg.push(a, b, links);
		else if (b)
			msg.push(a, b);
		else if (a)
			msg.push(a);

		this._log(m, post.op || post.num, common.UPDATE_POST, msg);
		await m.promise.exec();
	}
};

register_lua('finish');

function finish_off(m, key) {
	const body_key = key.replace('dead', 'thread') + ':body';
	m.evalsha(LUA.finish.sha, 3, key, body_key, 'liveposts');
}

Y.finish_post = async function (post) {
	const m = this.connect().multi();
	const key = (post.op ? 'post:' : 'thread:') + post.num;
	/* Don't need to check .exists() thanks to client state */
	finish_off(m, key);
	this._log(m, post.op || post.num, common.FINISH_POST, [post.num]);
	await m.promise.exec();
};

Y.finish_quietly = function (key, callback) {
	const m = this.connect().multi();
	finish_off(m, key);
	m.exec(callback);
};

Y.finish_all = function (callback) {
	const r = this.connect();
	r.smembers('liveposts', (err, keys) => {
		if (err)
			return callback(err);
		async.forEach(keys, (key, cb) => {
			const isPost = /^post:(\d+)$/.test(key);
			const fini = (err, op) => {
				if (err)
					return cb(err);
				const m = r.multi();
				finish_off(m, key);
				let n = parse_number(key.match(/:(\d+)$/)[1]);
				op = isPost ? parse_number(op) : n;
				this._log(m, op, common.FINISH_POST, [n]);
				m.srem('liveposts', key);
				m.exec(cb);
			};
			if (isPost)
				r.hget(key, 'op', fini);
			else
				fini();
		}, callback);

	});
};

Y._log = function (m, op, kind, msg, opts) {
	opts = opts || {};
	msg = JSON.stringify(msg).slice(1, -1);
	msg = msg.length ? `${kind},${msg}` : ('' + kind);
	winston.info(`Log: ${msg}`);
	if (!op)
		throw new Error('No OP.');
	const { priv } = this.ident;
	const prefix = priv ? `priv:${priv}:` : '';
	const key = `${prefix}thread:${op}`;

	if (common.is_pubsub(kind)) {
		m.rpush(key + ':history', msg);
		m.hincrby(key, 'hctr', 1);
	}
	const { ip, ipNum } = opts;
	if (ipNum)
		m.hset(key + ':ips', ipNum, ip);

	// format `msg` for inclusion in the log
	msg = length_prefixed(`${op},${msg}`);

	// we can add an extra trailing message for secret info
	if (ip)
		msg += JSON.stringify({auth: {ip}});

	m.publish(key, msg);
	const tags = opts.tags || (this.tag ? [this.tag] : []);
	for (let tag of tags) {
		m.publish(`${prefix}tag:${tag}`, msg);
	}

	if (opts.cacheUpdate) {
		const info = {kind, tag: tags[0], op};
		_.extend(info, opts.cacheUpdate);
		m.publish('cache', JSON.stringify(info));
	}
};

Y.fetch_backlogs = async function (watching) {
	if (watching.size == 1 && watching.get('live')) {
		// TODO provide backlogs for `live` too, or just get rid of it?
		return [];
	}
	const r = this.connect();
	const combined = [];
	const inject_ips = caps.can_moderate(this.ident);
	// TODO parallelize
	for (let [thread, sync] of watching) {
		const key = `thread:${thread}`;
		const m = r.multi();
		m.lrange(key + ':history', sync, -1);
		if (inject_ips) {
			// if they're a mod, get the num->ip mapping to augment the logs
			m.hgetall(key + ':ips');
		}
		const [history, ips] = await m.promise.exec();
		const prefix = thread + ',';

		// construct full messages from history entries
		for (let entry of history) {
			if (inject_ips) {
				// HACK: attempt to inject ip into INSERT_POST log
				const m = entry.match(/^2,(\d+),{(.+)$/);
				const ip = m && ips[m[1]];
				if (ip) {
					entry = `2,${m[1]},{"ip":${JSON.stringify(ip)},${m[2]}`;
				}
			}
			combined.push(prefix + entry);
		}
	}
	return combined;
};

Y.get_post_op = function (num, callback) {
	const r = this.connect();
	r.hget('post:' + num, 'op', (err, op) => {
		if (err)
			return callback(err);
		else if (op)
			return callback(null, num, op);
		r.exists('thread:' + num, (err, exists) => {
			if (err)
				callback(err);
			else if (!exists)
				callback(null, null, null);
			else
				callback(null, num, num);
		});
	});
}

Y.get_tag = function (page) {
	const r = this.connect();
	const key = 'tag:' + tag_key(this.tag) + ':threads';
	const reverseOrder = this.tag == 'archive';
	if (page < 0 && !reverseOrder)
		page = 0;
	let start = page * config.THREADS_PER_PAGE;
	let end = start + config.THREADS_PER_PAGE - 1;
	const m = r.multi();
	if (reverseOrder)
		m.zrange(key, start, end);
	else
		m.zrevrange(key, start, end);
	m.zcard(key);
	m.exec((err, res) => {
		if (err)
			return this.emit('error', err);
		let nums = res[0];
		if (page > 0 && !nums.length)
			return this.emit('nomatch');
		if (reverseOrder)
			nums.reverse();
		this.emit('begin', res[1]);
		const reader = new Reader(this);
		reader.on('error', this.emit.bind(this, 'error'));
		reader.on('thread', this.emit.bind(this, 'thread'));
		reader.on('post', this.emit.bind(this, 'post'));
		reader.on('endthread', this.emit.bind(this, 'endthread'));
		this._get_each_thread(reader, 0, nums);
	});
};

Y._get_each_thread = function (reader, ix, nums) {
	if (!nums || ix >= nums.length) {
		this.emit('end');
		reader.removeAllListeners('endthread');
		reader.removeAllListeners('end');
		return;
	}
	const next_please = () => {
		reader.removeListener('end', next_please);
		reader.removeListener('nomatch', next_please);
		this._get_each_thread(reader, ix+1, nums);
	};
	reader.on('end', next_please);
	reader.on('nomatch', next_please);
	reader.get_thread(this.tag, nums[ix], {
			abbrev: config.ABBREVIATED_REPLIES || 5
	});
};

/* LURKERS */

register_lua('get_thread');

function lua_get_thread(r, key, abbrev, cb) {
	const body_key = key.replace('dead', 'thread') + ':body';
	const posts_key = key + ':posts';
	r.evalsha(LUA.get_thread.sha, 4, key, body_key, posts_key, 'liveposts', abbrev,
	(err, rs) => {
		if (err)
			return cb(err);
		if (!rs)
			return cb(null);
		if (rs.length != 4)
			throw new Error('get_thread.lua unexpected output');

		// activePosts is a hash of hashes; needs to be unbulked on two levels
		const activeBulk = rs[2];
		for (let i = 1; i < activeBulk.length; i += 2)
			activeBulk[i] = unbulk(activeBulk[i]);
		const active = unbulk(activeBulk);

		cb(null, {
			pre: unbulk(rs[0]),
			replies: rs[1].map(parse_number),
			active: active,
			total: rs[3],
		});
	});
}

function Reader(yakusoku) {
	events.EventEmitter.call(this);
	this.y = yakusoku;
	this.postCache = {};
	if (caps.can_administrate(yakusoku.ident))
		this.showPrivs = true;
}

util.inherits(Reader, events.EventEmitter);
exports.Reader = Reader;

Reader.prototype.get_thread = function (tag, num, opts) {
	const r = this.y.connect();
	const graveyard = (tag == 'graveyard');
	if (graveyard)
		opts.showDead = true;
	const key = (graveyard ? 'dead:' : 'thread:') + num;
	const abbrev = opts.abbrev || 0;

	lua_get_thread(r, key, abbrev, (err, result) => {
		if (err)
			return this.emit('error', err);
		if (!result || !result.pre || !result.pre.time) {
			if (!opts.redirect)
				return this.emit('nomatch');
			r.hget('post:' + num, 'op', (err, op) => {
				if (err)
					this.emit('error', err);
				else if (!op)
					this.emit('nomatch');
				else
					this.emit('redirect', op);
			});
			return;
		}
		const opPost = result.pre;
		let total = result.total;
		let nums = result.replies;
		this.postCache = result.active;

		const exists = this.is_visible(opPost, opts);
		const tags = parse_tags(opPost.tags);
		if (!graveyard && tags.indexOf(tag) < 0) {
			if (opts.redirect) {
				const op = OPs[num];
				return this.emit('redirect', op || num, tags[0]);
			}
			else
				exists = false;
		}
		if (!exists) {
			this.emit('nomatch');
			return;
		}
		this.emit('begin', opPost);
		opPost.num = num;
		refine_post(opPost);

		let priv = this.y.ident.priv;

		const prepared = (err, rs) => {
			if (err)
				return this.emit('error', err);
			// get results in the same order as before
			let deadNums, privNums;
			if (opts.showDead) {
				deadNums = rs.shift();
				if (abbrev)
					total += parse_number(rs.shift());
			}
			if (priv) {
				privNums = rs.shift();
				if (abbrev)
					total += parse_number(rs.shift());
			}

			if (deadNums)
				nums = merge_posts(nums, deadNums, abbrev);
			if (priv) {
				nums = merge_posts(nums, privNums, abbrev);
				if (this.showPrivs)
					this.privNums = privNums;
			}
			const omit = Math.max(total - abbrev, 0);
			this.emit('thread', opPost, omit);
			this._get_each_reply(0, nums, opts);
		};

		if (opts.showDead || priv) {
			const m = r.multi();
			// order is important!
			if (opts.showDead) {
				const deadKey = key + ':dels';
				m.lrange(deadKey, -abbrev, -1);
				if (abbrev)
					m.llen(deadKey);
			}
			if (priv) {
				const privsKey = key + ':privs:' + priv;
				m.lrange(privsKey, -abbrev, -1);
				if (abbrev)
					m.llen(privsKey);
			}

			m.exec(prepared);
		}
		else
			prepared();
	});
};

function merge_posts(nums, privNums, abbrev) {
	let i = nums.length - 1, pi = privNums.length - 1;
	if (pi < 0)
		return nums;
	let merged = [];
	while (!abbrev || merged.length < abbrev) {
		if (i >= 0 && pi >= 0) {
			let num = nums[i], pNum = privNums[pi];
			if (parse_number(num) > parse_number(pNum)) {
				merged.unshift(num);
				i--;
			}
			else {
				merged.unshift(pNum);
				pi--;
			}
		}
		else if (i >= 0)
			merged.unshift(nums[i--]);
		else if (pi >= 0)
			merged.unshift(privNums[pi--]);
		else
			break;
	}
	return merged;
}

function can_see_priv(priv, ident) {
	if (!priv)
		return true; // not private
	if (!ident)
		return false;
	if (ident.showPriv)
		return true;
	return priv == ident.priv;
}

Reader.prototype._get_each_reply = function (ix, nums, opts) {
	let cache = this.postCache;
	let limit = 20;

	let privs = this.privNums;
	const apply_privs = (post) => {
		if (privs && post.num && _.contains(privs, post.num.toString()))
			post.priv = true;
	};

	// find a run of posts that need to be fetched
	let end;
	for (end = ix; end < nums.length && (end - ix) < limit; end++) {
		if (cache[nums[end]])
			break;
	}
	if (ix < end) {
		// fetch posts in the ix..end range
		let range = [];
		for (let i = ix; i < end; i++)
			range.push(nums[i]);
		this.get_posts('post', range, opts, (err, posts) => {
			if (err)
				return this.emit('error', err);
			for (let i = 0; i < posts.length; i++) {
				let post = posts[i];
				apply_privs(post);
				this.emit('post', post);
			}
			process.nextTick(this._get_each_reply.bind(this, end, nums, opts));
		});
		return;
	}

	// otherwise read posts from cache
	for (; ix < nums.length; ix++) {
		const num = nums[ix];
		const post = cache[num];
		if (!post)
			break;

		if (this.is_visible(post, opts)) {
			post.num = num;
			refine_post(post);
			apply_privs(post);
			this.emit('post', post);
		}
	}

	if (ix < nums.length) {
		process.nextTick(this._get_each_reply.bind(this, ix, nums, opts));
	} else {
		this.emit('endthread');
		this.emit('end');
	}
};

/// fetch posts in bulk. it is assumed that none of them are currently being edited
Reader.prototype.get_posts = function (kind, nums, opts, cb) {
	if (!nums.length)
		return cb(null, []);
	const r = this.y.connect();

	const m = r.multi();
	for (let i = 0; i < nums.length; i++) {
		const key = kind + ':' + nums[i];
		m.hgetall(key);
	}
	m.exec((err, results) => {
		if (err)
			return cb(err);

		let posts = [];
		for (let i = 0; i < results.length; i++) {
			const post = results[i];
			const num = nums[i];
			post.num = num;
			if (!this.is_visible(post, opts))
				continue;

			refine_post(post);
			if (post.editing && !post.body) {
				post.body = '[a bug ate this post]';

				const key = kind + ':' + num + ':body';
				r.exists(key, (err, existed) => {
					if (err)
						winston.warn(err);
					else if (existed)
						winston.warn(key + " was overlooked");
				});
			}
			posts.push(post);
		}

		cb(null, posts);
	});
};

Reader.prototype.is_visible = function (post, opts) {
	if (_.isEmpty(post))
		return false;
	if (post.hide && !opts.showDead)
		return false;
	if (!can_see_priv(post.priv, this.ident))
		return false;
	return true;
};

/// turn a fresh-from-redis post hash into our expected format
function refine_post(post) {
	post.time = parse_number(post.time);
	if (typeof post.op == 'string')
		post.op = parse_number(post.op);
	if (typeof post.tags == 'string')
		post.tags = parse_tags(post.tags);
	if (typeof post.body != 'string')
		post.body = '';
	if (post.state)
		post.editing = true;
	// extract the image-specific keys (if any) to a sub-hash
	hydrate_post(post);
}

function parse_number(n) {
	return parseInt(n, 10);
}

/// Including hidden or private. Not in-order.
async function get_all_replies_and_privs(r, op) {
	const key = 'thread:' + op;
	const m = r.multi();
	m.lrange(key + ':posts', 0, -1);
	m.smembers(key + ':privs');
	let [nums, privs] = await m.promise.exec();
	if (privs.length) {
		const m = r.multi();
		privs.forEach(priv => m.lrange(`${key}:privs:${priv}`, 0, -1));
		const rs = await m.promise.exec();
		rs.forEach(ns => nums.push.apply(nums, ns));
	}
	return [nums, privs];
}


/* AUTHORITY */

function Filter(tag) {
	events.EventEmitter.call(this);
	this.tag = tag;
};

util.inherits(Filter, events.EventEmitter);
exports.Filter = Filter;
const F = Filter.prototype;

F.connect = function () {
	if (!this.r) {
		this.r = global.redis;
	}
	return this.r;
};

F.get_all = function (limit) {
	const r = this.connect();
	const go = (err, threads) => {
		if (err)
			return this.failure(err);
		async.forEach(threads, do_thread, err => this.check_done(err));
	}
	const do_thread = (op, cb) => {
		const key = 'thread:' + op;
		r.llen(key + ':posts', (err, len) => {
			if (err)
				cb(err);
			len = parse_number(len);
			if (len > limit)
				return cb(null);
			const thumbKeys = ['thumb', 'realthumb', 'src'];
			r.hmget(key, thumbKeys, (err, rs) => {
				if (err)
					cb(err);
				const thumb = rs[0] || rs[1] || rs[2];
				this.emit('thread', {num: op, thumb: thumb});
				cb(null);
			});
		});
	}
	r.zrange('tag:' + tag_key(this.tag) + ':threads', 0, -1, go);
};

F.check_done = function (err) {
	if (err)
		this.failure(err);
	else
		this.success();
};

F.success = function () {
	this.emit('end');
	this.cleanup();
};

F.failure = function (err) {
	this.emit('error', err);
	this.cleanup();
};

F.cleanup = function () {
	this.removeAllListeners('error');
	this.removeAllListeners('thread');
	this.removeAllListeners('end');
};

/* AMUSEMENT */

Y.get_fun = function (op, callback) {
	if (cache.funThread && op == cache.funThread) {
		/* Don't cache, for extra fun */
		fs.readFile('client/fun.js', 'UTF-8', callback);
	}
	else
		callback(null);
};

Y.set_fun_thread = function (op, callback) {
	if (OPs[op] != op)
		return callback(Muggle("Thread not found."));
	fs.readFile('client/fun.js', 'UTF-8', (err, funJs) => {
		if (err)
			return callback(err);
		cache.funThread = op;
		const m = this.connect().multi();
		this._log(m, op, common.EXECUTE_JS, [funJs]);
		m.exec(callback);
	});
};

Y.get_banner = function (cb) {
	const key = 'tag:' + tag_key(this.tag) + ':banner';
	this.connect().hgetall(key, cb);
};

// DEAD CODE
Y.set_banner = function (op, message, cb) {
	const r = this.connect();

	const key = 'tag:' + tag_key(this.tag) + ':banner';
	r.hgetall(key, (err, old) => {
		if (err)
			return cb(err);
		const m = r.multi();
		if (old && old.op != op) {
			// clear previous thread's banner
			this._log(m, old.op, common.UPDATE_BANNER, [null]);
		}

		// write new banner
		m.hmset(key, {op: op, msg: message});
		this._log(m, op, common.UPDATE_BANNER, [message]);
		m.exec(cb);
	});
};

Y.teardown = function (board, cb) {
	const m = this.connect().multi();
	const filter = new Filter(board);
	filter.get_all(NaN); // no length limit
	filter.on('thread', thread => this._log(m, thread.num, common.TEARDOWN, []));
	filter.on('error', cb);
	filter.on('end', () => m.exec(cb));
};

Y.get_current_body = function (num, cb) {
	const key = (OPs[num] == num ? 'thread:' : 'post:') + num;
	const m = this.connect().multi();
	m.hmget(key, 'hide', 'body');
	m.get(key + ':body');
	m.exec((err, rs) => {
		if (err)
			return cb(err);
		const hide = rs[0][0], finalBody = rs[0][1];
		const liveBody = rs[1];
		if (hide)
			return cb(null);
		if (finalBody)
			return cb(null, finalBody, true);
		cb(null, liveBody || '', false);
	});
};

/* HELPERS */

/// Hydrate a flat post from redis into the same object but with a nested `image`, etc.
function hydrate_post(post) {
	if (has_image(post)) {
		let image = {};
		// transplant all image-related keys
		for (const key of imager.image_attrs) {
			if (key in post) {
				image[key] = post[key];
				delete post[key];
			}
		}
		if (image.dims.split)
			image.dims = image.dims.split(',').map(parse_number);
		image.size = parse_number(image.size);
		// image hash is used for dedup; don't reveal it
		delete image.hash;
		post.image = image;
	}

	if (post.dice) {
		// comma-delimited dice rolls
		try {
			post.dice = JSON.parse('[' + post.dice + ']');
		}
		catch (e) {
			delete post.dice;
		}
	}
}

const has_image = post => !!post && !!(post.src || post.vint);

/// Dehydrate a post, flattening data from `info.src` into `info.dest`.
function flatten_post(info) {
	let post = info.dest;

	let image = info.src.image;
	if (image) {
		for (const key of imager.image_attrs) {
			if (key in image)
				post[key] = image[key];
		}
	}

	// copy pasted `inline_dice`
	let dice = info.src.dice;
	if (dice && dice.length) {
		dice = JSON.stringify(dice);
		post.dice = dice.substring(1, dice.length - 1);
	}
}

function with_body(r, key, post, callback) {
	if (post.body !== undefined)
		callback(null, post);
	else
		r.get(key + ':body', (err, body) => {
			if (err)
				return callback(err);
			if (body !== null) {
				post.body = body;
				post.editing = true;
				return callback(null, post);
			}
			// Race condition between finishing posts
			r.hget(key, 'body', (err, body) => {
				if (err)
					return callback(err);
				post.body = body || '';
				callback(null, post);
			});
		});
};

function subject_val(op, subject) {
	return subject && (op + ':' + subject);
}

function tag_key(tag) {
	return tag.length + ':' + tag;
}

function parse_tags(input) {
	if (!input) {
		winston.warn('Blank tag!');
		return [];
	}
	const tags = [];
	while (input.length) {
		const m = input.match(/^(\d+):/);
		if (!m)
			break;
		const len = parse_number(m[1]);
		const pre = m[1].length + 1;
		if (input.length < pre + len)
			break;
		tags.push(input.substr(pre, len));
		input = input.slice(pre + len);
	}
	return tags;
}
exports.parse_tags = parse_tags;

async function hmget_obj(r, key, keys) {
	const rs = await r.promise.hmget(key, keys);
	const result = {};
	for (let i = 0; i < keys.length; i++)
		result[keys[i]] = rs[i];
	return result;
}

/// converts a lua bulk response to a hash
function unbulk(list) {
	if (!list)
		return null;
	if (list.length % 2) {
		console.warn('bad bulk:', list);
		throw new Error('bulk of odd len ' + list.length);
	}
	const hash = {};
	for (let i = 0; i < list.length; i += 2) {
		const key = list[i];
		if (key in hash)
			throw new Error('bulk repeated key ' + key);
		hash[key] = list[i+1];
	}
	return hash;
}
