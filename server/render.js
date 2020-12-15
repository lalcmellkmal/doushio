const caps = require('./caps'),
    common = require('../common'),
    config = require('../config'),
    db = require('../db'),
    imager = require('../imager'),
    STATE = require('./state'),
    web = require('./web');

const RES = STATE.resources;
const escape = common.escape_html;

function tamashii(num) {
	const op = db.OPs[num];
	if (op && caps.can_access_thread(this.ident, op))
		this.callback(this.post_ref(num, op));
	else
		this.callback('>>' + num);
}

exports.write_thread_html = function (reader, req, out, opts) {
	let oneeSama = new common.OneeSama(tamashii);
	if (req.cookies) {
		oneeSama.tz_offset = parse_timezone(req.cookies.timezone);
	}

	opts.ident = req.ident;
	caps.augment_oneesama(oneeSama, opts);

	const cookies = web.parse_cookie(req.headers.cookie);
	if (common.thumbStyles.includes(cookies.thumb))
		oneeSama.thumbStyle = cookies.thumb;

	let lastN = cookies.lastn && parseInt(cookies.lastn, 10);
	if (!lastN || !common.reasonable_last_n(lastN))
		lastN = config.THREAD_LAST_N;
	oneeSama.lastN = lastN;

	const hidden = {};
	if (cookies.hide && !caps.can_moderate(req.ident)) {
		for (let num of cookies.hide.slice(0, 200).split(',')) {
			num = parseInt(num, 10);
			if (num)
				hidden[num] = null;
		}
	}

	let write_see_all_link;

	reader.on('thread', (op_post, omit, image_omit) => {
		if (op_post.num in hidden)
			return;
		op_post.omit = omit;
		const full = oneeSama.full = !!opts.fullPosts;
		oneeSama.op = opts.fullLinks ? false : op_post.num;
		const first = oneeSama.monomono(op_post, full && 'full');
		first.pop();
		out.write(first.join(''));

		write_see_all_link = omit && (first_reply_num => {
			let o = common.abbrev_msg(omit, image_omit);
			if (opts.loadAllPostsLink) {
				let url = '' + op_post.num;
				if (first_reply_num)
					url += '#' + first_reply_num;
				o += ' '+common.action_link_html(url, 'See all');
			}
			out.write(`\t<span class="omit">${o}</span>\n`);
		});

		reader.once('endthread', close_section);
	});

	reader.on('post', (post) => {
		if (post.num in hidden || post.op in hidden)
			return;
		if (write_see_all_link) {
			write_see_all_link(post.num);
			write_see_all_link = null;
		}
		out.write(oneeSama.mono(post));
	});

	function close_section() {
		out.write('</section><hr>\n');
	}
};

function make_link_rels(board, bits) {
	const path = imager.config.MEDIA_URL + 'css/';

	const { hot } = STATE;
	const base = `base.css?v=${hot.BASE_CSS_VERSION}`;
	bits.push(['stylesheet', path + base]);

	const theme = hot.BOARD_CSS[board];
	const theme_css = `${theme}.css?v=${hot.THEME_CSS_VERSION}`;
	bits.push(['stylesheet', path + theme_css, 'theme']);

	bits.push(['stylesheet', path + 'gravitas.css?v=1']);
	return bits.map(p => {
		let html = `\t<link rel="${p[0]}" href="${p[1]}"`;
		if (p[2])
			html += ` id="${p[2]}"`;
		return html + '>\n';
	}).join('');
}

exports.write_board_head = function (out, initScript, board, nav) {
	const { indexTmpl, navigationHtml } = RES;
	const title = STATE.hot.TITLES[board] || escape(board);
	const metaDesc = "Real-time imageboard";

	let i = 0;
	out.write(indexTmpl[i++]);
	out.write(title);
	out.write(indexTmpl[i++]);
	out.write(escape(metaDesc));
	out.write(indexTmpl[i++]);
	out.write(make_board_meta(board, nav));
	out.write(initScript);
	out.write(indexTmpl[i++]);
	if (navigationHtml)
		out.write(navigationHtml);
	out.write(indexTmpl[i++]);
	out.write(title);
	out.write(indexTmpl[i++]);
};

exports.write_thread_head = function (out, initScript, board, op, opts) {
	const { indexTmpl, navigationHtml } = RES;
	let title = `/${escape(board)}/ - `;
	if (opts.subject)
		title += `${escape(opts.subject)} (#${op})`;
	else
		title += '#' + op;
	const metaDesc = "Real-time imageboard thread";

	let i = 0;
	out.write(indexTmpl[i++]);
	out.write(title);
	out.write(indexTmpl[i++]);
	out.write(escape(metaDesc));
	out.write(indexTmpl[i++]);
	out.write(make_thread_meta(board, op, opts.abbrev));
	out.write(initScript);
	out.write(indexTmpl[i++]);
	if (navigationHtml)
		out.write(navigationHtml);
	out.write(indexTmpl[i++]);
	out.write('Thread #' + op);
	out.write(indexTmpl[i++]);
	const buttons = bottomHTML + ' ' + personaHTML;
	out.write(buttons + '\n<hr>\n');
};

function make_board_meta(board, info) {
	const bits = [];
	if (info.cur_page >= 0)
		bits.push(['index', '.']);
	if (info.prev_page)
		bits.push(['prev', info.prev_page]);
	if (info.next_page)
		bits.push(['next', info.next_page]);
	return make_link_rels(board, bits);
}

function make_thread_meta(board, num, abbrev) {
	const bits = [['index', '.']];
	if (abbrev)
		bits.push(['canonical', num]);
	return make_link_rels(board, bits);
}

exports.make_pagination_html = function (info) {
	const { ascending, cur_page, next_page, pages } = info;
	const bits = ['<nav class="pagination">'];
	if (cur_page >= 0)
		bits.push('<a href=".">live</a>');
	else
		bits.push('<strong>live</strong>');
	let start = 0, end = pages, step = 1;
	if (ascending) {
		start = end - 1;
		end = step = -1;
	}
	for (let i = start; i != end; i += step) {
		if (i != cur_page)
			bits.push(`<a href="page${i}">${i}</a>`);
		else
			bits.push(`<strong>${i}</strong>`);
	}
	if (next_page)
		bits.push(' <input type="button" value="Next"> ');
	bits.push('<a id="persona" href="#persona">ID</a></nav>');
	return bits.join('');
};

const returnHTML = common.action_link_html('.', 'Return').replace('span', 'span id="bottom"');
const bottomHTML = common.action_link_html('#bottom', 'Bottom');
const personaHTML = common.action_link_html('#persona', 'Identity', 'persona');

exports.write_page_end = function (out, ident, returnLink) {
	const { indexTmpl, navigationHtml } = RES;
	if (returnLink)
		out.write(returnHTML);
	else if (navigationHtml)
		out.write('<br><br>' + navigationHtml);
	const last = indexTmpl.length - 1;
	out.write(indexTmpl[last]);
	if (ident) {
		if (caps.can_administrate(ident))
			out.write('<script src="../admin.js"></script>\n');
		else if (caps.can_moderate(ident))
			out.write('<script src="../mod.js"></script>\n');
	}
};

function parse_timezone(tz) {
	if (!tz && tz != 0)
		return null;
	tz = parseInt(tz, 10);
	if (isNaN(tz) || tz < -24 || tz > 24)
		return null;
	return tz;
}
