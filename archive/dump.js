/* Dumps the given thread as JSON and HTML to `www/archive/`
 * Writes the IP addresses as JSON to `./authdump/<thread>.json`
 */

const caps = require('../server/caps'),
    db = require('../db'),
    etc = require('../etc'),
    { createWriteStream } = require('fs'),
    { join } = require('path'),
    { write_thread_head, write_thread_html, write_page_end } = require('../server/render');

const DUMP_DIR = 'www/archive';
const AUTH_DUMP_DIR = 'authdump';

const DUMP_IDENT = {ip: '127.0.0.1', auth: 'dump'};

class JsonDumper {
	constructor(reader, out) {
		this.out = out;
		this.reader = reader;
		reader.on('thread', this.on_thread);
		reader.on('post', this.on_post);
		reader.on('endthread', this.on_endthread);
	}

	on_thread = (op_post) => {
		if (this.needComma) {
			this.out.write(',\n');
			this.needComma = false;
		}
		this.op = op_post.num;
		this.out.write('[\n' + JSON.stringify(tweak_post(op_post)));
	}

	on_post = (post) => {
		this.out.write(',\n' + JSON.stringify(tweak_post(post, this.op)));
	}

	on_endthread = () => {
		this.out.write('\n]');
		this.needComma = true;
		this.op = null;
	}

	destroy() {
		this.reader.removeListener('thread', this.on_thread);
		this.reader.removeListener('post', this.on_post);
		this.reader.removeListener('endthread', this.on_endthread);
		this.reader = null;
		this.out = null;
	}
}

class AuthDumper {
	constructor(reader, out) {
		this.out = out;
		this.reader = reader;
		reader.on('thread', this.on_thread);
		reader.on('post', this.on_post);
		reader.on('endthread', this.on_endthread);
	}

	on_thread = post => {
		this.out.write('{"ips":{');

		if (post.num && post.ip) {
			this.out.write(`"${post.num}":${JSON.stringify(post.ip)}`);
			this.needComma = true;
		}
	}

	on_post = post => {
		if (post.num && post.ip) {
			if (this.needComma)
				this.out.write(',');
			else
				this.needComma = true;
			this.out.write(`"${post.num}":${JSON.stringify(post.ip)}`);
		}
	}

	on_endthread = () => {
		this.out.write('}}');
		this.needComma = false;
	}

	destroy() {
		this.reader.removeListener('thread', this.on_thread);
		this.reader.removeListener('post', this.on_post);
		this.reader.removeListener('endthread', this.on_endthread);
		this.reader = null;
		this.out = null;
	}
}

function tweak_post(post, known_op) {
	post = { ...post };

	/* thread-only */
	if (typeof post.tags == 'string')
		post.tags = db.parse_tags(post.tags);
	if (typeof post.origTags == 'string')
		post.origTags = db.parse_tags(post.origTags);
	if (typeof post.hctr == 'string')
		post.hctr = parseInt(post.hctr, 10);
	if (typeof post.imgctr == 'string')
		post.imgctr = parseInt(post.imgctr, 10);

	/* post-only */
	if (known_op == post.op)
		delete post.op;

	if (post.hideimg) {
		delete post.image;
		delete post.hideimg;
	}
	if (post.body == '')
		delete post.body;

	/* blacklisting is bad... */
	delete post.ip;

	return post;
}

function dump_thread(op, board, ident, outputs) {
	if (!caps.can_access_board(ident, board))
		return Promise.reject(404);
	if (!caps.can_access_thread(ident, op))
		return Promise.reject(404);

	const yaku = new db.Yakusoku(board, ident);
	return new Promise((resolve, reject) => {
		yaku.once('error', reject);
		const reader = new db.Reader(yaku);
		reader.get_thread(board, op, {});
		reader.once('nomatch', () => reject(404));
		reader.once('redirect', op => reject('redirect'));
		reader.once('error', reject);
		reader.once('begin', ({ subject }) => {
			const { json, auth, html } = outputs;
			const jsonDumper = new JsonDumper(reader, json);
			const authDumper = new AuthDumper(reader, auth);

			write_thread_head(html, '', board, op, { subject });

			const fakeReq = {ident, headers: {}};
			const opts = {fullPosts: true, board};
			write_thread_html(reader, fakeReq, html, opts);

			reader.once('end', () => {
				json.write('\n');
				auth.write('\n');
				write_page_end(html, ident, true);
				resolve();
			});
		});
	}).finally(() => yaku.disconnect());
}

function close_stream(stream) {
	return new Promise((resolve, reject) => {
		if (!stream.writable)
			return resolve();
		if (stream.write(''))
			close();
		else
			stream.once('drain', close);

		function close() {
			// deal with process.stdout not being closable
			try {
				stream.destroySoon(err => {
					if (resolve) {
						err ? reject(err) : resolve();
					}
					resolve = reject = null;
				});
			}
			catch (e) {
				if (resolve)
					resolve();
				resolve = reject = null;
			}
		}
	});
}

async function load_state() {
	await Promise.all([
		etc.checked_mkdir(DUMP_DIR),
		etc.checked_mkdir(AUTH_DUMP_DIR),
	]);
	await require('../server/state').reload_hot_resources();
	await db.track_OPs();
}

async function dump() {
	let op = parseInt(process.argv[2], 10), board = process.argv[3];
	if (!op) {
		console.error('Usage: node upkeep/dump.js <thread>');
		process.exit(-1);
	}

	console.log('Loading state...');
	await load_state();

	if (!board)
		board = db.first_tag_of(op);
	if (!board) {
		console.error(`#${op} has no tags.`);
		process.exit(-1);
	}

	console.log(`Dumping thread #${op} on /${board}/...`);

	const base = join(DUMP_DIR, op.toString());
	const authBase = join(AUTH_DUMP_DIR, op.toString());
	const outputs = {
		auth: createWriteStream(authBase + '.json'),
		json: createWriteStream(base + '.json'),
		html: createWriteStream(base + '.html'),
	};

	await dump_thread(op, board, DUMP_IDENT, outputs);

	for (let k in outputs)
		await close_stream(outputs[k]);

	console.log(`Wrote HTML to: ${base}.html`);
	// crappy flush for stdout (can't close it)
	if (process.stdout.write(''))
		process.exit(0);
	else
		process.stdout.on('drain', () => process.exit(0));
}

if (require.main === module)
	dump().catch(err => { console.error(err); process.exit(1); });
