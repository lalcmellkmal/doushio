var _ = require('../lib/underscore'),
    async = require('async'),
    config = require('../config'),
    crypto = require('crypto'),
    fs = require('fs'),
    hooks = require('../hooks'),
    path = require('path'),
    pipeline = require('../pipeline'),
    { promisify } = require('util'),
    vm = require('vm');

const readFile = promisify(fs.readFile);

_.templateSettings = {
	interpolate: /\{\{(.+?)\}\}/g
};

exports.emitter = new (require('events').EventEmitter);

exports.dbCache = {
	OPs: {},
	opTags: {},
	threadSubs: {},
	YAKUMAN: 0,
	funThread: 0,
	addresses: {},
	ranges: {},
	connTokenSecretKey: null,
};

var HOT = exports.hot = {};
var RES = exports.resources = {};
exports.clients = {};
exports.clientsByIP = {};

async function reload_hot_config() {
	const js = await readFile('hot.js', 'UTF-8');
	let hot = {};
	vm.runInNewContext(js, hot);
	if (!hot || !hot.hot)
		return reject('Bad hot config.');

	// Overwrite the original object just in case
	for (let k of Object.keys(HOT)) {
		delete HOT[k];
	}
	_.extend(HOT, hot.hot);
	await new Promise((resolve, reject) => {
		hooks.trigger('reloadHot', HOT, err => {
			err ? reject(err) : resolve()
		});
	});
}

// load the encryption key for connToken
hooks.hook('reloadHot', function (hot, cb) {
	var r = global.redis;
	var key = 'ctoken-secret-key';
	r.get(key, function (err, secretHex) {
		if (err) return cb(err);
		if (secretHex) {
			var secretBytes = Buffer.from(secretHex, 'hex');
			if (secretBytes.length != 32)
				return cb('ctoken secret key is invalid');
			HOT.connTokenSecretKey = secretBytes;
			return cb(null);
		}
		// generate a new one
		var secretKey = crypto.randomBytes(32);
		r.setnx(key, secretKey.toString('hex'), function (err, wasSet) {
			if (err) return cb(err);
			if (wasSet)
				HOT.connTokenSecretKey = secretKey;
			else
				assert(!!HOT.connTokenSecretKey);
			cb(null);
		});
	});
});

async function reload_scripts() {
	const filename = path.join('state', 'scripts.json');
	const json = await readFile(filename, 'UTF-8');
	const js = JSON.parse(json);
	if (!js || !js.vendor || !js.client)
		throw new Error('Bad state/scripts.json.');

	HOT.VENDOR_JS = js.vendor;
	HOT.CLIENT_JS = js.client;

	const modFilename = path.join('state', js.mod);
	const modSrc = await readFile(modFilename, 'UTF-8');
	RES.modJs = modSrc;
}

function reload_resources() {
	return new Promise((resolve, reject) => {

		const deps = require('../deps');

		read_templates((err, tmpls) => {
			if (err)
				return reject(err);
			_.extend(RES, expand_templates(tmpls));
			hooks.trigger('reloadResources', RES, err => {
				err ? reject(err) : resolve()
			});
		});
	});
}

function read_templates(cb) {
	function read(dir, file) {
		return fs.readFile.bind(fs, path.join(dir, file), 'UTF-8');
	}

	async.parallel({
		index: read('tmpl', 'index.html'),
		filter: read('tmpl', 'filter.html'),
		curfew: read('tmpl', 'curfew.html'),
		suspension: read('tmpl', 'suspension.html'),
		notFound: read('www', '404.html'),
		serverError: read('www', '50x.html'),
	}, cb);
}

function expand_templates(res) {
	var templateVars = _.clone(HOT);
	_.extend(templateVars, require('../imager/config'));
	_.extend(templateVars, config);

	function tmpl(data) {
		var expanded = _.template(data, templateVars);
		return {tmpl: expanded.split(/\$[A-Z]+/),
			src: expanded};
	}

	var ex = {
		navigationHtml: make_navigation_html(),
		filterTmpl: tmpl(res.filter).tmpl,
		curfewTmpl: tmpl(res.curfew).tmpl,
		suspensionTmpl: tmpl(res.suspension).tmpl,
		notFoundHtml: res.notFound,
		serverErrorHtml: res.serverError,
	};

	var index = tmpl(res.index);
	ex.indexTmpl = index.tmpl;
	var hash = crypto.createHash('md5').update(index.src);
	ex.indexHash = hash.digest('hex').slice(0, 8);

	return ex;
}

exports.reload_hot_resources = async function () {
	pipeline.refresh_deps();
	await reload_hot_config();
	await pipeline.rebuild();
	await reload_scripts();
	await reload_resources();
}

function make_navigation_html() {
	if (!HOT.INTER_BOARD_NAVIGATION)
		return '';
	var bits = ['<nav>['];
	config.BOARDS.forEach(function (board, i) {
		if (board == config.STAFF_BOARD)
			return;
		if (i > 0)
			bits.push(' / ');
		bits.push('<a href="../'+board+'/">'+board+'</a>');
	});
	bits.push(']</nav>');
	return bits.join('');
}
