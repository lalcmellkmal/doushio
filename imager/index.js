const config = require('./config'),
    db = require('./db'),
    etc = require('../etc'),
    fs = require('fs'),
    path = require('path'),
    winston = require('winston');

exports.Onegai = db.Onegai;
exports.config = config;

const image_attrs = ('src thumb dims size MD5 hash imgnm spoiler realthumb vint apng mid audio video duration').split(' ');
exports.image_attrs = image_attrs;

exports.send_dead_image = function (kind, filename, resp) {
	filename = dead_path(kind, filename);
	const stream = fs.createReadStream(filename);
	stream.once('error', function (err) {
		if (err.code == 'ENOENT') {
			resp.writeHead(404);
			resp.end('Image not found');
		}
		else {
			winston.error(err);
			resp.end();
		}
	});
	stream.once('open', function () {
		const h = {
			'Cache-Control': 'no-cache, no-store',
			'Expires': 'Thu, 01 Jan 1970 00:00:00 GMT',
		};
		try {
			h['Content-Type'] = require('mime').lookup(filename);
		} catch (e) {}
		resp.writeHead(200, h);
		stream.pipe(resp);
	});
};

async function publish(alloc) {
	const copies = [];
	const haveComp = alloc.tmps.comp && alloc.image.realthumb;
	for (let kind in alloc.tmps) {
		const src = media_path('tmp', alloc.tmps[kind]);

		// both comp and thumb go in thumb/
		const destDir = (kind == 'comp') ? 'thumb' : kind;
		// hack for stupid thumb/realthumb business
		let destKey = kind;
		if (haveComp) {
			if (kind == 'thumb')
				destKey = 'realthumb';
			else if (kind == 'comp')
				destKey = 'thumb';
		}

		const dest = media_path(destDir, alloc.image[destKey]);
		copies.push(etc.copy(src, dest));
	}
	await Promise.all(copies).catch(err => etc.Muggle('Publish error', err));
}

function validate_alloc(alloc) {
	if (!alloc || !alloc.image || !alloc.tmps)
		return;
	for (let dir in alloc.tmps) {
		const fnm = alloc.tmps[dir];
		if (!/^[\w_]+$/.test(fnm)) {
			winston.warn(`Suspicious filename: ${JSON.stringify(fnm)}`);
			return;
		}
	}
	return true;
}

/// Move the image (and its thumbnails) to the graveyard folder.
exports.bury_image = async (info) => {
	const { src } = info;
	if (!src)
		return;
	// sanity check the filename
	const m = /^\d+\w*\.\w+$/;
	if (!src.match(m))
		throw etc.Muggle('Invalid image filename to delete.');
	const moves = [bury('src', src)];
	// see if the other thumbnails exist
	function try_thumb(path, t) {
		if (!t)
			return;
		if (!t.match(m))
			throw etc.Muggle('Invalid thumbnail filename to delete.');
		moves.push(bury(path, t));
	}
	try_thumb('thumb', info.thumb);
	try_thumb('thumb', info.realthumb);
	try_thumb('mid', info.mid);
	await Promise.all(moves);
	function bury(p, nm) {
		return etc.move_no_clobber(media_path(p, nm), dead_path(p, nm));
	}
};

function media_path(dir, filename) {
	return path.join(config.MEDIA_DIRS[dir], filename);
}
exports.media_path = media_path;

function dead_path(dir, filename) {
	return path.join(config.MEDIA_DIRS.dead, dir, filename);
}

async function make_dir(base, key, cb) {
	const dir = base ? path.join(base, key) : config.MEDIA_DIRS[key];
	await etc.checked_mkdir(dir);
}
exports._make_media_dir = make_dir;

exports.make_media_dirs = async () => {
	const keys = ['src', 'thumb', 'vint', 'dead'];
	if (!is_standalone())
		keys.push('tmp');
	if (config.EXTRA_MID_THUMBNAILS)
		keys.push('mid');

	await Promise.all(keys.map(key => make_dir(null, key)));

	{
		const { dead } = config.MEDIA_DIRS;
		const keys = ['src', 'thumb'];
		if (config.EXTRA_MID_THUMBNAILS)
			keys.push('mid');

		await Promise.all(keys.map(key => make_dir(dead, key)));
	}
}

exports.serve_image = function (req, resp) {
	const m = /^\/(src|thumb|mid|vint)(\/\d+\.\w+)$/.exec(req.url);
	if (!m)
		return false;
	const root = config.MEDIA_DIRS[m[1]];
	if (!root)
		return false;
	require('send')(req, m[2], {root: root}).pipe(resp);
	return true;
};

exports.squish_MD5 = function (hash) {
	if (typeof hash == 'string')
		hash = Buffer.from(hash, 'hex');
	return hash.toString('base64').replace(/\//g, '_').replace(/=*$/, '');
};

exports.obtain_image_alloc = async function (id) {
	const onegai = new db.Onegai;
	try {
		const alloc = await onegai.obtain_image_alloc(id);
		if (validate_alloc(alloc))
			return alloc;
		else
			throw new etc.Muggle("Invalid image alloc");
	}
	finally {
		onegai.disconnect();
	}
};

exports.commit_image_alloc = async function (alloc) {
	await publish(alloc);
	const o = new db.Onegai;
	await o.commit_image_alloc(alloc);
	o.disconnect();
};

exports.note_hash = function (hash, num) {
	if (!config.DUPLICATE_COOLDOWN)
		return;
	const key = 'hash:' + hash;
	db.connect().setex(key, config.DUPLICATE_COOLDOWN, num, function (err) {
		if (err)
			winston.warn("note hash: " + err);
	});
};

const is_standalone = exports.is_standalone = db.is_standalone;
