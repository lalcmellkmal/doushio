const config = require('./config'),
    crypto = require('crypto'),
    etc = require('./etc'),
    fs = require('fs'),
    make_client = require('./make_client').make_maybe_minified,
    pathJoin = require('path').join,
    stream = require('stream'),
    tmp_promise = require('tmp-promise'),
    util = require('util');

const TMP_BUILD_DIR = '.build';
const PUBLIC_JS = pathJoin('www', 'js');

function HashingStream(out) {
	stream.Writable.call(this);

	this._hash = crypto.createHash('MD5');
	this._outStream = out;
}
util.inherits(HashingStream, stream.Writable);

HashingStream.prototype._write = function (chunk, encoding, cb) {
	this._hash.update(chunk);
	this._outStream.write(chunk, encoding, cb);
};

HashingStream.prototype.end = function (cb) {
	if (arguments.length > 1)
		throw new Error("TODO multi-arg HashingStream.end");
	stream.Writable.prototype.end.call(this, () => {
		this._outStream.end(() => {
			if (cb)
				cb();
		});
	});
};

function end_and_move_js(stream, dir, prefix) {
	async function move_js() {
		let fnm;
		if (config.DEBUG) {
			fnm = `${prefix}-debug.js`;
		}
		else {
			const hash = stream._hash.digest('hex').slice(0, 10);
			fnm = `${prefix}-${hash}.min.js`;
		}
		const tmp = stream._tmpFilename;
		await etc.move(tmp, pathJoin(dir, fnm));
		return fnm;
	}
	return new Promise((resolve, reject) => {
		stream.end(() => move_js().then(resolve, reject));
	});
}


async function make_hashing_stream(prefix) {
	const opts = {tmpdir: TMP_BUILD_DIR, prefix, postfix: '.gen.js', mode: 0o644};
	const {fd, path, cleanup} = await tmp_promise.file(opts);
	const out = fs.createWriteStream(null, {fd});
	out.once('error', err => {
		try {
			cleanup();
		}
		finally {
			throw new Error('unrecoverable hashing stream error', err);
		}
	});

	if (config.DEBUG) {
		out._tmpFilename = path;
		return out;
	}
	else {
		const stream = new HashingStream(out);
		stream._tmpFilename = path;
		return stream;
	}
}

async function build_vendor_js(deps) {
	const stream = await make_hashing_stream('vendor-');
	const write = util.promisify(stream.write).bind(stream);
	for (const filename of deps.VENDOR_DEPS) {
		const buf = await etc.readFile(filename);
		await write(buf);
	}
	return await end_and_move_js(stream, PUBLIC_JS, 'vendor');
}

async function build_client_js(deps) {
	const stream = await make_hashing_stream('client-');
	await make_client(deps.CLIENT_DEPS, stream);
	return await end_and_move_js(stream, PUBLIC_JS, 'client');
}

async function build_mod_client_js(deps) {
	const stream = await make_hashing_stream('mod-');
	await make_client(deps.MOD_CLIENT_DEPS, stream);
	return await end_and_move_js(stream, 'state', 'mod');
}

async function commit_assets(metadata) {
	const path = await tmp_promise.tmpName({ tmpdir: TMP_BUILD_DIR, template: 'assets-XXXXXX.json' });
	await fs.promises.writeFile(path, JSON.stringify(metadata) + '\n', 'utf8');
	await etc.move(path, pathJoin('state', 'scripts.json'));
}

async function rebuild() {
	await Promise.all([
		etc.checked_mkdir('state'),
		etc.checked_mkdir(TMP_BUILD_DIR),
	]);
	const deps = require('./deps');
	const [vendor, client, mod] = await Promise.all([
		build_vendor_js(deps),
		build_client_js(deps),
		build_mod_client_js(deps),
	]);
	await commit_assets({vendor, client, mod});
}
exports.rebuild = rebuild;

exports.refresh_deps = () => {
	delete require.cache[pathJoin(__dirname, 'deps.js')];
};

if (require.main === module) {
	rebuild().catch(err => { console.error(err); process.exit(1); });
}
