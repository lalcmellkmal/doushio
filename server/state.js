const _ = require('../lib/underscore'),
    config = require('../config'),
    crypto = require('crypto'),
    path = require('path'),
    pipeline = require('../pipeline'),
    { readFile } = require('../etc'),
    vm = require('vm');

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

	const caps = require('./caps');
	await caps.reload_suspensions(HOT);
	await reload_conn_token();
}

// load the encryption key for connToken
async function reload_conn_token() {
	const r = global.redis;
	const key = 'ctoken-secret-key';
	const secretHex = await r.promise.get(key);
	if (secretHex) {
		const secretBytes = Buffer.from(secretHex, 'hex');
		if (secretBytes.length != 32)
			throw new Error('ctoken secret key is invalid');
		HOT.connTokenSecretKey = secretBytes;
	} else {
		// generate a new one
		const secretKey = crypto.randomBytes(32);
		const wasSet = await r.promise.setnx(key, secretKey.toString('hex'));
		if (wasSet)
			HOT.connTokenSecretKey = secretKey;
		else
			throw new Error("reload_conn_token race?!");
	}
}

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

async function reload_resources() {
	const tmpls = await read_templates();
	_.extend(RES, expand_templates(tmpls));
	// idk why the web module doesn't simply use our exported resources?
	require('./web').set_error_templates(RES);
}

async function read_templates() {
	const read = (dir, file) => readFile(path.join(dir, file), 'UTF-8');

	const [index, filter, curfew, suspension, notFound, serverError] = await Promise.all([
		read('tmpl', 'index.html'),
		read('tmpl', 'filter.html'),
		read('tmpl', 'curfew.html'),
		read('tmpl', 'suspension.html'),
		read('www', '404.html'),
		read('www', '50x.html'),
	]);
	return { index, filter, curfew, suspension, notFound, serverError };
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
