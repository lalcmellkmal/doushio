const config = require('./config');
const imagerConfig = require('./imager/config');
const DEFINES = exports;
DEFINES.INVALID = 0;

DEFINES.INSERT_POST = 2;
DEFINES.UPDATE_POST = 3;
DEFINES.FINISH_POST = 4;
DEFINES.CATCH_UP = 5;
DEFINES.INSERT_IMAGE = 6;
DEFINES.SPOILER_IMAGES = 7;
DEFINES.DELETE_IMAGES = 8;
DEFINES.DELETE_POSTS = 9;
DEFINES.DELETE_THREAD = 10;
DEFINES.LOCK_THREAD = 11;
DEFINES.UNLOCK_THREAD = 12;
DEFINES.REPORT_POST = 13;

DEFINES.PING = 30;
DEFINES.IMAGE_STATUS = 31;
DEFINES.SYNCHRONIZE = 32;
DEFINES.EXECUTE_JS = 33;
DEFINES.MOVE_THREAD = 34;
DEFINES.UPDATE_BANNER = 35;
DEFINES.TEARDOWN = 36;

DEFINES.MODEL_SET = 50;
DEFINES.COLLECTION_RESET = 55;
DEFINES.COLLECTION_ADD = 56;
DEFINES.SUBSCRIBE = 60;
DEFINES.UNSUBSCRIBE = 61;

DEFINES.ANON = 'Anonymous';
DEFINES.INPUT_ROOM = 20;
DEFINES.MAX_POST_LINES = 30;
DEFINES.MAX_POST_CHARS = 2000;
DEFINES.WORD_LENGTH_LIMIT = 120;
DEFINES.PAGE_BOTTOM = -1;

/// OneeSama.state[0] flags
DEFINES.S_BOL = 1;
DEFINES.S_QUOTE = 2;
DEFINES.S_BIG = 4;

function initial_state() {
	// state[0] = output mode
	// state[1] = number of spoiler tags we're inside
	return [DEFINES.S_BOL, 0];
}
exports.initial_state = initial_state;

if (typeof mediaURL == 'undefined' || !mediaURL)
	mediaURL = imagerConfig.MEDIA_URL;

function is_pubsub(t) {
	return t > 0 && t < 30;
}
exports.is_pubsub = is_pubsub;

function FSM(start) {
	this.state = start;
	this.spec = {acts: {}, ons: {}, wilds: {}, preflights: {}};
}
exports.FSM = FSM;

FSM.prototype.clone = function () {
	const second = new FSM(this.state);
	second.spec = this.spec;
	return second;
};

// Handlers on arriving to a new state
FSM.prototype.on = function (key, f) {
	const ons = this.spec.ons[key];
	if (ons)
		ons.push(f);
	else
		this.spec.ons[key] = [f];
	return this;
};

// Sanity checks before attempting a transition
FSM.prototype.preflight = function (key, f) {
	const pres = this.spec.preflights[key];
	if (pres)
		pres.push(f);
	else
		this.spec.preflights[key] = [f];
};

// Specify transitions and an optional handler function
FSM.prototype.act = function (trans_spec, on_func) {
	const halves = trans_spec.split('->');
	if (halves.length != 2)
		throw new Error("Bad FSM spec: " + trans_spec);
	const parts = halves[0].split(',');
	const dest = halves[1].match(/^\s*(\w+)\s*$/)[1];
	let tok;
	for (let i = parts.length-1; i >= 0; i--) {
		const part = parts[i];
		const m = part.match(/^\s*(\*|\w+)\s*(?:\+\s*(\w+)\s*)?$/);
		if (!m)
			throw new Error(`Bad FSM spec portion: ${part}`);
		if (m[2])
			tok = m[2];
		if (!tok)
			throw new Error(`Tokenless FSM action: ${part}`);
		const src = m[1];
		if (src == '*')
			this.spec.wilds[tok] = dest;
		else {
			let acts = this.spec.acts[src];
			if (!acts)
				this.spec.acts[src] = acts = {};
			acts[tok] = dest;
		}
	}
	if (on_func)
		this.on(dest, on_func);
	return this;
};

FSM.prototype.feed = function (ev, param) {
	const { spec, state } = this;
	const acts = spec.acts[state];
	const to = (acts && acts[ev]) || spec.wilds[ev];
	if (to && state != to) {
		// preflight checks first
		const preflights = spec.preflights[to];
		if (preflights)
			for (let pre of preflights)
				if (!pre.call(this, param))
					return false;
		// ok, transition to the new state
		this.state = to;
		for (let handler of spec.ons[to])
			handler.call(this, param);
	}
	return true;
};

FSM.prototype.feeder = function (ev) {
	return (param) => this.feed(ev, param);
};

const entities = {'&' : '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'};
function escape_html(html) {
	return html.replace(/[&<>"]/g, c => entities[c]);
}
exports.escape_html = escape_html;

function escape_fragment(frag) {
	const t = typeof frag;
	if (t == 'object' && frag && typeof frag.safe == 'string')
		return frag.safe;
	else if (t == 'string')
		return escape_html(frag);
	else if (t == 'number')
		return frag.toString();
	else
		return '???';
}
exports.escape_fragment = escape_fragment;

function flatten(frags) {
	let out = [];
	for (let frag of frags) {
		if (Array.isArray(frag))
			out = out.concat(flatten(frag));
		else
			out.push(escape_fragment(frag));
	}
	return out;
}
exports.flatten = flatten;

function safe(frag) {
	return {safe: frag};
}
exports.safe = safe;

function is_noko(email) {
	return email && !email.includes('@') && /noko/i.test(email);
}
exports.is_noko = is_noko;
function is_sage(email) {
	return config.SAGE_ENABLED && email && !email.includes('@') && /sage/i.test(email);
}
exports.is_sage = is_sage;

const OneeSama = function (t) {
	this.tamashii = t;
	this.hooks = {};
};
exports.OneeSama = OneeSama;
const OS = OneeSama.prototype;

const break_re = new RegExp("(\\S{" + DEFINES.WORD_LENGTH_LIMIT + "})");
/* internal refs, embeds */
const ref_re = />>(\d+|>\/watch\?v=[\w-]{11}(?:#t=[\dhms]{1,9})?|>\/soundcloud\/[\w-]{1,40}\/[\w-]{1,80}|>\/@\w{1,15}\/\d{4,20}(?:\?s=\d+)?|>\/a\/\d{0,10})/;

OS.hook = function (name, func) {
	const hs = this.hooks[name];
	if (!hs)
		this.hooks[name] = [func];
	else if (!hs.includes(func))
		hs.push(func);
};

OS.trigger = function (name, param) {
	const hs = this.hooks[name];
	if (hs)
		for (let i = 0; i < hs.length; i++)
			hs[i].call(this, param);
};

function override(obj, orig, upgrade) {
	const origFunc = obj[orig];
	obj[orig] = function () {
		const args = [].slice.apply(arguments);
		args.unshift(origFunc);
		return upgrade.apply(this, args);
	};
}

/// converts one >>ref to html
OS.red_string = function (ref) {
	const prefix = ref.slice(0, 3);
	let dest, linkClass;
	if (prefix == '>/w') {
		dest = 'https://www.youtube.com/' + ref.slice(2);
		linkClass = 'embed watch';
	}
	else if (prefix == '>/s') {
		dest = 'https://soundcloud.com/' + ref.slice(13);
		linkClass = 'embed soundcloud';
	}
	else if (prefix == '>/@') {
		const [handle, tweet] = ref.slice(3).split('/');
		dest = `https://twitter.com/${handle}/status/${tweet}`;
		linkClass = 'embed tweet';
	}
	else if (prefix == '>/a') {
		const num = parseInt(ref.slice(4), 10);
		dest = `../outbound/a/${num ? ''+num : ''}`;
	}
	else {
		this.tamashii(parseInt(ref, 10));
		return;
	}
	this.callback(new_tab_link(encodeURI(dest), '>>' + ref, linkClass));
};

/// 3rd tokenization stage; breaks text into chunks and >>refs
OS.break_heart = function (frag) {
	if (frag.safe)
		return this.callback(frag);
	// break long words
	const bits = frag.split(break_re);
	for (let i = 0; i < bits.length; i++) {
		// anchor >>refs
		const morsels = bits[i].split(ref_re);
		for (let j = 0; j < morsels.length; j++) {
			const m = morsels[j];
			if (j % 2)
				this.red_string(m);
			else if (i % 2) {
				this.geimu(m);
				this.callback(safe('<wbr>'));
			}
			else
				this.geimu(m);
		}
	}
};

/// 2nd tokenization stage; as we transition our state[0] flag, emits html tags as necessary
OS.iku = function (token, to) {
	const { state } = this;
	if (state[0] & DEFINES.S_QUOTE && !(to & DEFINES.S_QUOTE))
		this.callback(safe('</em>'));
	if (state[0] & DEFINES.S_BIG && !(to & DEFINES.S_BIG)) {
		if (token && token.safe == '<br>')
			token = '';
		this.callback(safe('</h4>'));
	}

	if (to & DEFINES.S_BIG && !(state[0] & DEFINES.S_BIG)) {
		this.callback(safe('<h4>'));
		state[0] |= DEFINES.S_BIG;
	}
	if (to & DEFINES.S_QUOTE && !(state[0] & DEFINES.S_QUOTE)) {
		this.callback(safe('<em>'));
		state[0] |= DEFINES.S_QUOTE;
	}

	if (to == 'SPOIL') {
		if (token[1] == '/') {
			state[1]--;
			this.callback(safe('</del>'));
		}
		else {
			const del = {html: '<del>'};
			this.trigger('spoilerTag', del);
			this.callback(safe(del.html));
			state[1]++;
		}
	}
	else {
		this.break_heart(token);
	}

	state[0] = to;
}

/// 1st tokenization stage, breaking up [spoiler]s, >quotes, and line breaks
OS.fragment = function (frag) {
	const chunks = frag.split(/(\[\/?spoiler\])/i);
	const { state } = this;
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (i % 2) {
			let to = 'SPOIL';
			if (chunk[1] == '/' && state[1] < 1)
				to = state[0] & DEFINES.S_QUOTE;
			this.iku(chunk, to);
			continue;
		}
		const lines = chunk.split(/(\n)/);
		for (let l = 0; l < lines.length; l++) {
			const line = lines[l];
			const is_bol = state[0] === DEFINES.S_BOL;
			if (l % 2)
				this.iku(safe('<br>'), DEFINES.S_BOL);
			else if (is_bol && !state[1] && /^[#＃]{2}[^#＃]/.test(line)) {
				let to = DEFINES.S_BIG;
				if (/[>＞]/.test(line[2]))
					to |= DEFINES.S_QUOTE;
				this.iku(line.slice(2), to);
			}
			else if (is_bol && /^[>＞]/.test(line))
				this.iku(line, DEFINES.S_QUOTE);
			else if (line)
				this.iku(line, state[0] & (DEFINES.S_QUOTE | DEFINES.S_BIG));
		}
	}
};

OS.close_out = function () {
	if (this.state[0] & DEFINES.S_QUOTE) {
		this.callback(safe('</em>'));
		this.state[0] -= DEFINES.S_QUOTE;
	}

	if (this.state[0] & DEFINES.S_BIG) {
		this.callback(safe('</h4>'));
		this.state[0] -= DEFINES.S_BIG;
	}

	while (this.state[1] > 0) {
		this.callback(safe('</del>'));
		this.state[1]--;
	}
};

/// converts one post body to HTML
OS.karada = function (body) {
	const output = [];
	this.state = initial_state();
	this.callback = (frag) => output.push(frag);
	this.fragment(body);
	this.close_out();
	this.callback = null;
	return output;
}

const dice_re = /(#flip|#8ball|#imfey|#\d{0,2}d\d{1,4}(?:[+-]\d{1,4})?)/i;
exports.dice_re = dice_re;

const EIGHT_BALL = [
	'Yes',
	'No',
	'Maybe',
	'Ara ara',
	'Why this',
	'Help',
	'git gud',
	'Okay',
	'My condolences',
	'Praise be',
	'EEEEEEH?!',
	'Try again never',
	'100%',
	'Can you repeat the question',
	'lol',
	'0.1%',
	'agreedo',
	'nope.avi',
	'Would you kindly?',
];

const IMFEY = [
	'wowme2',
	'u do u',
	"go get 'em champ",
	'my child...',
	'✨',
	'Kooloo Limpah!',
	'Invigorating.',
	'sproink',
	'elwind!',
];

function parse_dice(frag) {
	if (frag == '#flip')
		return {n: 1, faces: 2};
	if (frag == '#imfey')
		return {n: 1, faces: IMFEY.length};
	if (frag == '#8ball')
		return {n: 1, faces: EIGHT_BALL.length};
	const m = frag.match(/^#(\d*)d(\d+)([+-]\d+)?$/i);
	if (!m)
		return false;
	const n = parseInt(m[1], 10) || 1, faces = parseInt(m[2], 10);
	if (n < 1 || n > 10 || faces < 2 || faces > 100)
		return false;
	const info = {n, faces};
	if (m[3])
		info.bias = parseInt(m[3], 10);
	return info;
}
exports.parse_dice = parse_dice;

function readable_dice(bit, d) {
	if (bit == '#flip')
		return `#flip (${d[1] == 2})`;
	if (bit == '#imfey')
		return `#imfey (${IMFEY[d[1] - 1]})`;
	if (bit == '#8ball')
		return `#8ball (${EIGHT_BALL[d[1] - 1]})`;
	let f = d[0], n = d.length, b = 0;
	if (d[n-1] && typeof d[n-1] == 'object') {
		b = d[n-1].bias;
		n--;
	}
	const r = d.slice(1, n);
	n = r.length;
	bit += ' (';
	const eq = n > 1 || b;
	if (eq)
		bit += r.join(', ');
	if (b)
		bit += (b < 0) ? ` - ${-b}` : ` + ${b}`;
	let sum = b;
	for (let j = 0; j < n; j++)
		sum += r[j];
	return `${bit}${eq ? ' = ' : ''}${sum})`;
}

/// 4th tokenization stage; populates dice rolls
OS.geimu = function (text) {
	if (!this.dice) {
		this.kinpira(text);
		return;
	}

	const bits = text.split(dice_re);
	for (let i = 0; i < bits.length; i++) {
		const bit = bits[i];
		if (!(i % 2) || !parse_dice(bit)) {
			this.kinpira(bit);
		}
		else if (this.queueRoll) {
			this.queueRoll(bit);
		}
		else if (!this.dice[0]) {
			this.kinpira(bit);
		}
		else {
			const d = this.dice.shift();
			this.callback(safe('<strong>'));
			this.strong = true; // for client DOM insertion
			this.callback(readable_dice(bit, d));
			this.strong = false;
			this.callback(safe('</strong>'));
		}
	}
};

/// 5th tokenization stage; parses ^s
OS.kinpira = function (text) {
	if (!/[＾^]/.test(text) || /^([＾^]_|:[＾^])/.test(text)) {
		this.itameshi(text);
		return;
	}
	const bits = text.split(/[＾^]/);
	// remove trailing ^s
	while (bits.length && bits[bits.length-1] == '')
		bits.pop();

	let soup = safe('<sup>');
	this.sup_level = 0;
	for (let i = 0; i < bits.length; i++) {
		if (bits[i])
			this.itameshi(bits[i]);
		if (i + 1 < bits.length && i < 5) {
			// if there's more text, open a <sup>
			this.callback(soup);
			this.sup_level++;
		}
	}
	// close all the sups we opened
	const n = this.sup_level;
	this.sup_level = 0;
	soup = safe('</sup>');
	for (let i = 0; i < n; i++)
		this.callback(soup);
};

/// 6th tokenization stage; parses individual *italic* *words*
OS.itameshi = function (text) {
	while (true) {
		const m = /(^|[ .,;:?!(-])\*([^ *]+)\*($|[ .,;:?!)-])/.exec(text);
		if (!m)
			break;
		if (m.index > 0) {
			const before = text.slice(0, m.index);
			LINKIFY ? this.linkify(before) : this.callback(before);
		}
		if (m[1])
			this.callback(m[1]);
		this.callback(safe(`<i>${escape_html(m[2])}</i>`));
		text = text.slice(m.index + m[0].length - m[3].length);
	}
	if (text)
		LINKIFY ? this.linkify(text) : this.callback(text);
};

// Convert text URLs to clickable links
// *Not* recommended. Use at your own risk.
const LINKIFY = false;

/// optional 7th tokenization stage
if (LINKIFY) { OS.linkify = function (text) {

	const bits = text.split(/(https?:\/\/[^\s"<>^]*[^\s"<>'.,!?:;^])/);
	for (let i = 0; i < bits.length; i++) {
		if (i % 2) {
			const e = escape_html(bits[i]);
			// open in new tab, and disavow target
			this.callback(safe(`<a href="${e}" rel="nofollow noopener noreferrer" target="_blank">${e}</a>`));
		}
		else
			this.callback(bits[i]);
	}
}; }

function chibi(imgnm, src) {
	let name = '', ext = '';
	const m = imgnm.match(/^(.*)(\.\w{3,4})$/);
	if (m) {
		name = m[1];
		ext = m[2];
	}
	const bits = [safe('<a href="'), src, safe('" download="'), imgnm];
	if (name.length >= 38) {
		bits.push(safe('" title="'), imgnm);
		imgnm = [name.slice(0, 30), safe('(&hellip;)'), ext];
	}
	bits.push(safe('" rel="nofollow">'), imgnm, safe('</a>'));
	return bits;
}

OS.spoiler_info = function (index, toppu) {
	const large = toppu || this.thumbStyle == 'large';
	const dims = large ? imagerConfig.THUMB_DIMENSIONS : imagerConfig.PINKY_DIMENSIONS;
	const hd = toppu || this.thumbStyle != 'small';
	const thumb = encodeURI(`${mediaURL}kana/spoiler${hd ? '' : 's'}${index}.png`);
	return { dims, thumb };
};

const spoilerImages = imagerConfig.SPOILER_IMAGES;

function pick_spoiler(metaIndex) {
	const { normal, trans } = spoilerImages;
	const n = normal.length;
	const count = n + trans.length;
	let i;
	if (metaIndex < 0)
		i = Math.floor(Math.random() * count);
	else
		i = metaIndex % count;
	const index = i < n ? normal[i] : trans[i - n];
	const next = (i+1) % count;
	return { index, next };
}
exports.pick_spoiler = pick_spoiler;

function new_tab_link(srcEncoded, inside, cls) {
	cls = cls ? ` class="${cls}"` : '';
	return [
		safe(`<a href="${srcEncoded}" target="_blank"${cls} rel="noreferrer nofollow noopener">`),
		inside,
		safe('</a>')
	];
}


OS.image_paths = function () {
	if (!this._imgPaths) {
		this._imgPaths = {
			src: mediaURL + 'src/',
			thumb: mediaURL + 'thumb/',
			mid: mediaURL + 'mid/',
			vint: mediaURL + 'vint/',
		};
		this.trigger('mediaPaths', this._imgPaths);
	}
	return this._imgPaths;
};

const audioIndicator = "\u266B"; // musical note

OS.gazou = function (info, toppu) {
	let src, caption, video;
	if (info.vint) {
		src = encodeURI('../outbound/iqdb/' + info.vint);
		caption = ['Search ', new_tab_link(src, '[iqdb]')];
	}
	else {
		src = encodeURI(this.image_paths().src + info.src);
		video = info.video;
		caption = [video ? 'Video ' : 'Image ', new_tab_link(src, info.src)];
	}

	const img = this.gazou_img(info, toppu);
	const dims = `${info.dims[0]}x${info.dims[1]}`;

	return [safe('<figure data-MD5="'), info.MD5,
		safe('" data-size="'), info.size,
		video ? [safe('" data-video="'), video] : '',
		safe('"><figcaption>'),
		caption, safe(' <i>('),
		info.audio ? (audioIndicator + ', ') : '',
		info.duration ? (info.duration + ', ') : '',
		readable_filesize(info.size), ', ',
		dims, (info.apng ? ', APNG' : ''),
		this.full ? [', ', chibi(info.imgnm, img.src)] : '',
		safe(')</i></figcaption>'),
		this.thumbStyle == 'hide' ? '' : img.html,
		safe('</figure>\n\t')];
};

exports.thumbStyles = ['small', 'sharp', 'large', 'hide'];

OS.gazou_img = function (info, toppu) {
	let src, thumb;
	const imgPaths = this.image_paths();
	if (!info.vint)
		src = thumb = encodeURI(imgPaths.src + info.src);

	let [w, h, tw, th] = info.dims;
	if (info.spoiler) {
		const sp = this.spoiler_info(info.spoiler, toppu);
		thumb = sp.thumb;
		[tw, th] = sp.dims;
	}
	else if (info.vint) {
		tw = tw || w;
		th = th || h;
		src = encodeURI(`../outbound/iqdb/${info.vint}`);
		thumb = imgPaths.vint + info.vint;
	}
	else if (this.thumbStyle != 'small' && info.mid) {
		thumb = encodeURI(imgPaths.mid + info.mid);
		if (!toppu && this.thumbStyle == 'large') {
			tw *= 2;
			th *= 2;
		}
	}
	else if (info.thumb)
		thumb = encodeURI(imgPaths.thumb + info.thumb);
	else {
		tw = w;
		th = h;
	}

	let img = `<img src="${thumb}"`;
	if (tw && th)
		img += ` width="${tw}" height="${th}">`;
	else
		img += '>';
	if (imagerConfig.IMAGE_HATS)
		img = '<span class="hat"></span>' + img;
	const html = new_tab_link(src, safe(img));
	return { html, src };
};

function readable_filesize(size) {
	/* Deal with it. */
	if (size < 1024)
		return size + ' B';
	if (size < 1048576)
		return Math.round(size / 1024) + ' KB';
	size = Math.round(size / 104857.6).toString();
	return size.slice(0, -1) + '.' + size.slice(-1) + ' MB';
}
exports.readable_filesize = readable_filesize;

function pad(n) {
	return (n < 10 ? '0' : '') + n;
}

OS.readable_time = function (time) {
	const h = this.tz_offset;
	let offset;
	if (h || h == 0)
		offset = h * 60 * 60 * 1000;
	else /* would be nice not to construct new Dates all the time */
		offset = new Date().getTimezoneOffset() * -60 * 1000;
	const d = new Date(time + offset);
	const k = "日月火水木金土"[d.getUTCDay()];
	return `${d.getUTCFullYear()}/${pad(d.getUTCMonth()+1)}/${pad(d.getUTCDate())}&nbsp;(${k}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

function datetime(time) {
	const d = new Date(time);
	// surely there is a native way to do this?
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

OS.post_url = function (num, op, quote) {
	op = op || num;
	return `${this.op == op ? '' : op}#${quote ? 'q' : ''}${num}`;
};

OS.post_ref = function (num, op, desc_html) {
	let ref = '&gt;&gt;' + num;
	if (desc_html)
		ref += ' ' + desc_html;
	else if (this.op && this.op != op)
		ref += ' \u2192';
	else if (num == op && this.op == op)
		ref += ' (OP)';
	return safe(`<a href="${this.post_url(num, op, false)}">${ref}</a>`);
};

OS.post_nav = function (post) {
	const { num, op } = post;
	return safe(`<nav><a href="${this.post_url(num, op, false)}">No.</a><a href="${this.post_url(num, op, true)}">${num}</a></nav>`);
};

function action_link_html(href, name, id) {
	return `<span ${id ? `id="${id}" ` : ''}class="act"><a href="${href}">${name}</a></span>`;
}
exports.action_link_html = action_link_html;

exports.reasonable_last_n = function (n) {
	return n >= 5 && n <= 500;
};

OS.last_n_html = function (num) {
	const { lastN } = this;
	return action_link_html(`${num}?last${lastN}`, `Last&nbsp;${lastN}`);
};

OS.expansion_links_html = function (num, omit) {
	let html = ` &nbsp; ${action_link_html(num, 'Expand')}`;
	if (omit > this.lastN)
		html += ' ' + this.last_n_html(num);
	return html;
};

OS.atama = function (data) {
	const { auth, subject, name, trip } = data;
	const header = auth ? [safe('<b class="'), auth.toLowerCase(), safe('">')] : [safe('<b>')];
	if (subject)
		header.unshift(safe('<h3>「'), subject, safe('」</h3> '));
	if (name || !trip) {
		header.push(name || DEFINES.ANON);
		if (trip)
			header.push(' ');
	}
	if (trip)
		header.push(safe(`<code>${trip}</code>`));
	if (auth)
		header.push(` ## ${auth}`);
	this.trigger('headerName', { header, data });
	header.push(safe('</b>'));
	const { email, time, op, num, omit } = data;
	if (email) {
		header.unshift(safe(`<a class="email" href="mailto:${encodeURI(email)}" ref="noopener noreferrer" target="_blank">`));
		header.push(safe('</a>'));
	}
	header.push(safe(` <time datetime="${datetime(time)}">${this.readable_time(time)}</time> `), this.post_nav(data));
	if (!this.full && !op) {
		const ex = this.expansion_links_html(num, omit);
		header.push(safe(ex));
	}
	this.trigger('headerFinish', { header, data });
	header.unshift(safe('<header>'));
	header.push(safe('</header>\n\t'));
	return header;
};

OS.monogatari = function (data, toppu) {
	const tale = {header: this.atama(data)};
	this.dice = data.dice;
	const body = this.karada(data.body);
	tale.body = [safe('<blockquote>'), body, safe('</blockquote>')];
	if (data.num == MILLION) {
		tale.body.splice(1, 0, safe('<script>window.gravitas=true;</script>'));
	}
	if (data.image && !data.hideimg)
		tale.image = this.gazou(data.image, toppu);
	return tale;
};

const MILLION = 1000000;

function gravitas_body() {
	$('body').css({margin: 0});
}

OS.gravitas_style = function (idata, cssy) {
	let src = this.image_paths().src + idata.src;
	src = `url('${encodeURI(src)}')`;
	return cssy ? `background-image: ${src};` : src;
};

OS.mono = function (data) {
	const info = {
		data,
		classes: data.editing ? ['editing'] : [],
		style: ''
	};
	if (data.flavor)
		info.classes.push(data.flavor);
	if (data.num == MILLION) {
		info.classes.push('gravitas');
		if (data.image)
			info.style = this.gravitas_style(data.image, true);
	}
	this.trigger('openArticle', info);
	const { classes, style } = info;
	let cls = classes.length && classes.join(' '),
	    o = [safe(`\t<article id="${data.num}"`),
		(cls ? [safe(' class="'), cls, safe('"')] : ''),
		safe(style ? ` style="${style}"` : ''),
		safe('>')],
	    c = safe('</article>\n'),
	    gen = this.monogatari(data, false);
	return flatten([o, gen.header, gen.image || '', gen.body, c]).join('');
};

OS.monomono = function (data, cls) {
	const { flavor, locked, num, image, hctr, imgctr, full } = data;
	if (flavor)
		cls = cls ? `${cls} ${flavor}` : flavor;
	if (locked)
		cls = cls ? `${cls} locked` : 'locked';
	let style;
	if (num == MILLION) {
		cls = cls ? `${cls} gravitas` : 'gravitas';
		if (image)
			style = this.gravitas_style(image, true);
	}
	let o = [safe('<section id="' + num),
		(cls ? [safe('" class="'), cls] : ''),
		safe(style ? `" style="${style}` : ''),
		safe(`" data-sync="${hctr || 0}`),
		safe(full ? '' : `" data-imgs="${imgctr}`),
		safe('">')],
	    c = safe('</section>\n'),
	    gen = this.monogatari(data, true);
	return flatten([o, gen.image || '', gen.header, gen.body, '\n', c]);
};

function pluralize(n, noun) {
	return `${n} ${noun}${n == 1 ? '' : 's'}`;
}
exports.pluralize = pluralize;

exports.abbrev_msg = function (omit, img_omit) {
	return `${omit} repl${omit==1 ? 'y' : 'ies'} ${img_omit ? `and ${pluralize(img_omit, 'image')} ` : ''}omitted.`;
};

exports.parse_name = function (name) {
	let tripcode = '', secure = '';
	let hash = name.indexOf('#');
	if (hash >= 0) {
		tripcode = name.substr(hash+1);
		name = name.substr(0, hash);
		hash = tripcode.indexOf('#');
		if (hash >= 0) {
			secure = escape_html(tripcode.substr(hash+1));
			tripcode = tripcode.substr(0, hash);
		}
		tripcode = escape_html(tripcode);
	}
	name = name.trim().replace(config.EXCLUDE_REGEXP, '');
	return [name.substr(0, 100), tripcode.substr(0, 128), secure.substr(0, 128)];
};

function random_id() {
	return Math.floor(Math.random() * 1e16) + 1;
}
