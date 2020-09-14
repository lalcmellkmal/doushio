/* Deletes the original images and thumbnails of archived posts,
 * leaving just the 'vint' thumbnail.
 */

const crypto = require('crypto'),
    db = require('../db'),
    etc = require('../etc'),
    fs = require('fs'),
    path = require('path'),
	{ media_path, squish_MD5 } = require('../imager'),
	winston = require('winston');

function Recycler() {
	this.tag = 'archive';
	this.y = new db.Yakusoku(this.tag, db.UPKEEP_IDENT);
}

const R = Recycler.prototype;

R.recycle_post = async function (post) {
	const { image } = post;
	if (!image || !image.src || post.hideimg)
		return;
	const r = this.y.connect();
	const src = media_path('src', image.src);
	const toDelete = [];
	if (image.thumb) {
		toDelete.push(src);
		src = media_path('thumb', image.thumb);
	}
	if (image.realthumb) {
		toDelete.push(media_path('thumb', image.realthumb));
	}
	if (image.mid) {
		toDelete.push(media_path('mid', image.mid));
	}

	let MD5;
	try {
		MD5 = await MD5_file(src);
	}
	catch (err) {
		if (err.code == 'ENOENT')
			winston.warn(`${src} doesn't exist.`);
		else
			winston.error(err);
		return;
	}
	const dest = MD5 + path.extname(src);
	const dest_path = media_path('vint', dest);
	await etc.move_no_clobber(src, dest_path);
	const m = r.multi();
	const key = post.op ? 'post:' + post.num : 'thread:' + post.num;
	m.hdel(key, 'src');
	m.hdel(key, 'thumb');
	m.hdel(key, 'mid');
	m.hset(key, 'vint', dest);
	try {
		await m.promise.exec();
	}
	catch (err) {
		// move it back
		try {
			await etc.move_no_clobber(dest_path, src);
		}
		catch (e) {
			winston.error(e);
		}
		throw err;
	}

	let deleted = 0;
	await Promise.all(toDelete.map(async (victim) => {
		try {
			await etc.unlink(victim);
			deleted += 1;
		}
		catch (e) {
			winston.error(`deleting ${victim}: ${e}`);
		}
	}));

	if (deleted) {
		winston.info(`${post.num}: del ${deleted}`);
	}
};

R.recycle_thread = (op) => new Promise((resolve, reject) => {
	op = parseInt(op, 10);
	const reader = new db.Reader(this.y);
	reader.get_thread(this.tag, op, {});
	reader.on('thread', (thread) => {
		if (thread.immortal)
			return resolve();
		// grrr, ought to stream
		const posts = [thread];
		reader.on('post', post => posts.push(post));
		reader.on('endthread', async () => {
			try {
				for (let post of posts) {
					await this.recycle_post(post);
				}
			}
			catch (e) {
				reject(e);
				return;
			}
			resolve();
		});
		reader.on('error', reject);
	});
});

R.recycle_archive = async function (cb) {
	const { tag } = this;
	const key = `tag:${tag.length}:${tag}`;
	const r = this.y.connect();
	const threads = await r.promise.zrange(`${key}:threads`, 0, -1);
	for (let op of threads) {
		await this.recycle_thread(op);
	}
};

const MD5_file = (path) => new Promise((resolve, reject) => {
	const stream = fs.createReadStream(path);
	const hash = crypto.createHash('md5');
	stream.once('error', err => {
		stream.destroy();
		reject(err);
	});
	stream.on('data', buf => hash.update(buf));
	stream.once('end', () => {
		stream.destroy();
		/* grr stupid digest() won't give us a Buffer */
		hash = Buffer.from(hash.digest('binary'), 'binary');
		resolve(imager.squish_MD5(hash));
	});
});

if (require.main === module) process.nextTick(async () => {
	const recycler = new Recycler;
	await recycler.recycle_archive();
	recycler.y.disconnect();
	process.exit(0);
});
