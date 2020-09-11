const config = require('./config'),
    crypto = require('crypto'),
    etc = require('./etc'),
    fs = require('fs'),
    make_client = require('./make_client').make_maybe_minified,
    pathJoin = require('path').join,
    stream = require('stream'),
    tmp_file = require('tmp').file,
    util = require('util');

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
	var self = this;
	stream.Writable.prototype.end.call(this, function () {
		self._outStream.end(function () {
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


function make_hashing_stream() {
	return new Promise((resolve, reject) => {
		const opts = {dir: '.build', postfix: '.gen.js', mode: 0644};
		tmp_file(opts, (err, tmp, fd) => {
			if (err)
				return reject(err);
			const out = fs.createWriteStream(null, {fd: fd});
			out.once('error', reject);

			if (config.DEBUG) {
				out._tmpFilename = tmp;
				resolve(out);
			}
			else {
				const stream = new HashingStream(out);
				stream._tmpFilename = tmp;
				resolve(stream);
			}
		});
	});
}

async function build_vendor_js(deps) {
	const stream = await make_hashing_stream();
	const write = util.promisify(stream.write).bind(stream);
	for (const filename of deps.VENDOR_DEPS) {
		const buf = await etc.readFile(filename);
		await write(buf);
	}
	return await end_and_move_js(stream, PUBLIC_JS, 'vendor');
}

async function build_client_js(deps) {
	const stream = await make_hashing_stream();
	await make_client(deps.CLIENT_DEPS, stream);
	return await end_and_move_js(stream, PUBLIC_JS, 'client');
}

async function build_mod_client_js(deps) {
	const stream = await make_hashing_stream();
	await make_client(deps.MOD_CLIENT_DEPS, stream);
	return await end_and_move_js(stream, 'state', 'mod');
}

function commit_assets(metadata) {
	return new Promise((resolve, reject) => {
		tmp_file({dir: '.build', postfix: '.json'}, (err, tmp, fd) => {
			if (err)
				return reject(err);
			const stream = fs.createWriteStream(null, {fd});
			stream.once('error', reject);
			stream.end(JSON.stringify(metadata) + '\n', () => {
				etc.move(tmp, pathJoin('state', 'scripts.json'))
					.then(resolve, reject);
			});
		});
	});
}

async function rebuild() {
	await Promise.all([
		etc.checked_mkdir('state'),
		etc.checked_mkdir('.build'),
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
