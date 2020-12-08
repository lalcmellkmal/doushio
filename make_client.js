const config = require('./config'),
    etc = require('./etc'),
    fs = require('fs'),
    imagerConfig = require('./imager/config'),
    reportConfig = require('./report/config'),
    streamBuffers = require('stream-buffers'),
    util = require('util');

async function make_client(inputs, out) {

	// flatten all the config entries.
	// YIKES: no namespacing
	const defines = new Map();
	for (let k in config)
		defines.set(k, JSON.stringify(config[k]));
	for (let k in imagerConfig)
		defines.set(k, JSON.stringify(imagerConfig[k]));
	for (let k in reportConfig)
		defines.set(k, JSON.stringify(reportConfig[k]));

	// UGH
	const configDictLookup = {
		config,
		imagerConfig,
		reportConfig,
	};

	function lookup_config(dictName, key) {
		const dict = configDictLookup[dictName];
		if (/(SECRET|SECURE|PRIVATE)/.test(key)) {
			throw new Error(`Refusing ${key} in client code!`);
		}
		return dict[key];
	}

	const config_re = /\b((?:c|imagerC|reportC)onfig)\.(\w+)\b/;

// INNER CONVERT LOOP
for (const file of inputs) {

	if (/^lib\//.test(file))
		throw new Error("lib/* should be in VENDOR_DEPS");
	if (/^config\.js/.test(file))
		throw new Error("config.js shouldn't be in client");

	const fullFile = await etc.readFile(file, 'UTF-8');

	const lines = fullFile.split('\n');
	let waitForDrain = false;
	for (let line of lines) {
		// skip the defines-setup in common.js (and admin/common.js)
		if (/^const\s+DEFINES\s*=\s*exports\s*;\s*$/.test(line))
			continue;
		// config/common/underscore imports are implicit
		if (/^(var|let|const)\s+(\w+onfig|common|_)\s*=\s*require.*$/.test(line))
			continue;
		// collect definitions
		let m = line.match(/^DEFINES\.(\w+)\s*=\s*(.+);$/);
		if (m) {
			defines.set(m[1], m[2]);
			continue;
		}
		// turn common.js exports into global definitions
		m = line.match(/^exports\.(\w+)\s*=\s*(\w+)\s*;\s*$/);
		if (m && m[1] == m[2])
			continue; // skip lines like `exports.foo = foo;`
		m = line.match(/^exports\.(\w+)\s*=\s*(.*)$/);
		if (m)
			line = `const ${m[1]} = ${m[2]}`;

		// inline all the config values for this line
		while (true) {
			let m = line.match(config_re);
			if (!m)
				break;
			let cfg = lookup_config(m[1], m[2]);
			if (cfg === undefined) {
				return cb(`No such ${m[1]} var '${m[2]}'`);
			}
			// Bleh
			if (cfg instanceof RegExp)
				cfg = cfg.toString();
			else
				cfg = JSON.stringify(cfg);
			line = line.replace(config_re, cfg);
		}
		// try applying each define to this line
		for (let [src, dest] of defines.entries()) {
			if (line.indexOf(src) < 0)
				continue;
			let regexp = new RegExp('(?:DEFINES\.)?\\b' + src + '\\b', 'g');
			line = line.replace(regexp, dest);
		}
		// finally, write it out
		waitForDrain = !out.write(line+'\n', 'UTF-8');
	}
	if (waitForDrain) {
		await new Promise(resolve => {
			// error handling??
			out.once('drain', resolve);
		});
	}
}
// END CONVERT LOOP
}

async function make_minified(files, out) {
	const buf = new streamBuffers.WritableStreamBuffer();
	buf.once('error', err => { throw err; });
	await make_client(files, buf);
	const src = buf.getContentsAsString('utf-8');
	if (!src || !src.length)
		throw new Error('make_minified: no client JS was generated');
	const UglifyJS = require('uglify-es');
	const ugly = UglifyJS.minify(src, {mangle: false});
	await new Promise((resolve, reject) => {
		if (ugly.error)
			throw ugly.error;
		out.write(ugly.code, err => (err ? reject(err) : resolve()));
	});
}

function make_maybe_minified(files, out) { // returns a promise
	return config.DEBUG ? make_client(files, out) : make_minified(files, out);
}

exports.make_maybe_minified = make_maybe_minified;

if (require.main === module) {
	const files = [];
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];
		if (arg[0] != '-') {
			files.push(arg);
			continue;
		}
		else {
			util.error('Unrecognized option ' + arg);
			process.exit(1);
		}
	}

	make_maybe_minified(files, process.stdout).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
