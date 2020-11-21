const child_process = require('child_process'),
    fs = require('fs'),
    util = require('util'),
    winston = require('winston');

exports.readFile = util.promisify(fs.readFile);
exports.unlink = util.promisify(fs.unlink);

exports.exec = util.promisify(child_process.exec);
exports.execFile = util.promisify(child_process.execFile);

/* Non-wizard-friendly error message */
function Muggle(message, reason) {
	if (!(this instanceof Muggle))
		return new Muggle(message, reason);
	Error.call(this, message);
	Error.captureStackTrace(this, this.constructor);
	this.message = message;
	this.reason = reason;
}
util.inherits(Muggle, Error);
exports.Muggle = Muggle;

Muggle.prototype.most_precise_error_message = function () {
	var deepest = this.message;
	var muggle = this;
	var sanity = 10;
	while (muggle.reason && muggle.reason instanceof Muggle) {
		muggle = muggle.reason;
		if (muggle.message && typeof muggle.message == 'string')
			deepest = muggle.message;
		if (--sanity <= 0)
			break;
	}
	return deepest;
};

Muggle.prototype.deepest_reason = function () {
	if (this.reason && this.reason instanceof Muggle)
		return this.reason.deepest_reason();
	return this.reason || this;
};

exports.move = async (src, dest) => {
	try {
		await exports.execFile('/bin/mv', ['--', src, dest]);
	}
	catch (err) {
		throw Muggle("Couldn't move file into place.", err);
	}
};

exports.move_no_clobber = async (src, dest) => {
	try {
		await exports.execFile('/bin/mv', ['-n', '--', src, dest]);
	}
	catch (err) {
		throw Muggle("Couldn't move file into place.", err);
	}
};

exports.copy = async (src, dest) => {
	try {
		// try to do a graceful (non-overwriting) copy
		await exports.execFile('/bin/cp', ['-n', '--', src, dest]);
	}
	catch (err) {
		// overwrite, but whine about it
		winston.warn(`overwriting (${src}) to (${dest}).`);
		try {
			await exports.execFile('/bin/cp', ['--', src, dest]);
		}
		catch (err) {
			throw Muggle("Couldn't copy file into place.", err);
		}
	}
};

exports.checked_mkdir = dir => {
	return new Promise((resolve, reject) => {
		fs.mkdir(dir, err => {
			if (err && err.code != 'EEXIST')
				reject(err);
			else
				resolve();
		});
	});
};

// TEMP duplicated from common.js for imager daemon sanity
exports.random_id = function () {
	return Math.floor(Math.random() * 1e16) + 1;
};

exports.json_paranoid = function (obj) {
	return JSON.stringify(obj).replace(/\//g, '\\x2f');
};
