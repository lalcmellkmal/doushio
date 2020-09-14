const config = require('./config'),
    events = require('events'),
    fs = require('fs'),
    { Muggle, unlink } = require('../etc'),
    util = require('util'),
    winston = require('winston');

const IMG_EXPIRY = 60;
const STANDALONE = !!config.DAEMON;

function redis_client() {
	const db = require('../db');
	if (STANDALONE) {
		const conn = require('redis').createClient(config.DAEMON.REDIS_PORT);
		db.promisify_redis_client(conn);
		return conn;
	}
	else {
		return db.redis_client();
	}
}
exports.connect = redis_client;

function Onegai() {
	events.EventEmitter.call(this);
}

util.inherits(Onegai, events.EventEmitter);
exports.Onegai = Onegai;
const O = Onegai.prototype;

O.connect = function () {
	if (STANDALONE) {
		if (!global.imagerRedis)
			global.imagerRedis = redis_client();
		return global.imagerRedis;
	}
	return global.redis;
};

O.disconnect = function () {};

O.track_temporary = function (path, cb) {
	const m = this.connect();
	m.sadd('temps', path, (err, tracked) => {
		if (err)
			return cb(err);
		if (tracked > 0) {
			setTimeout(() => this.del_temp(path), (IMG_EXPIRY+1) * 1000);
		}
		cb(null);
	});
};

O.lose_temporaries = function (files, cb) {
	this.connect().srem('temps', files, cb);
};

O.del_temp = function (path) {
	this.cleanup_image_alloc(path, err => {
		if (err) {
			winston.warn(`unlink ${path}: ${err}`);
		}
	});
};

// if an image doesn't get used in a post in a timely fashion, delete it
O.cleanup_image_alloc = function (path, cb) {
	const r = this.connect();
	r.srem('temps', path, (err, n) => {
		if (err)
			return winston.warn(err);
		if (n) {
			fs.unlink(path, err => {
				if (err)
					return cb(err);
				cb(null, true);
			});
		}
		else {
			cb(null, false); // wasn't found
		}
	});
};

// catch any dangling images on server startup
O.delete_temporaries = async function () {
	const r = this.connect();
	const temps = await r.promise.smembers('temps');
	for (let temp of temps) {
		try {
			await unlink(temp);
			winston.info(`del temp ${temp}`);
		}
		catch (err) {
			winston.warn(`temp ${temp}: ${err}`);
		}
	}
	await r.del('temps');
};

O.check_duplicate = function (hash, callback) {
	this.connect().get('hash:'+hash, function (err, num) {
		if (err)
			callback(err);
		else if (num)
			callback(Muggle(`Duplicate of >>${num}.`));
		else
			callback(false);
	});
};

O.record_image_alloc = function (id, alloc, callback) {
	const r = this.connect();
	r.setex('image:' + id, IMG_EXPIRY, JSON.stringify(alloc), callback);
};

O.obtain_image_alloc = function (id, callback) {
	const m = this.connect().multi();
	const key = 'image:' + id;
	m.get(key);
	m.setnx('lock:' + key, '1');
	m.expire('lock:' + key, IMG_EXPIRY);
	m.exec((err, rs) => {
		if (err)
			return callback(err);
		if (rs[1] != 1)
			return callback(Muggle("Image in use."));
		if (!rs[0])
			return callback(Muggle("Image lost."));
		const alloc = JSON.parse(rs[0]);
		alloc.id = id;
		callback(null, alloc);
	});
};

exports.is_standalone = () => STANDALONE;

O.commit_image_alloc = function (alloc, cb) {
	// We should already hold the lock at this point.
	const key = 'image:' + alloc.id;
	const m = this.connect().multi();
	m.del(key);
	m.del('lock:' + key);
	m.exec(cb);
};

O.client_message = function (client_id, msg) {
	this.connect().publish('client:' + client_id, JSON.stringify(msg));
};

O.relay_client_messages = function () {
	const r = redis_client();
	r.psubscribe('client:*');
	r.once('psubscribe', () => {
		this.emit('relaying');
		r.on('pmessage', (pat, chan, message) => {
			const id = parseInt(chan.match(/^client:(\d+)$/)[1], 10);
			this.emit('message', id, JSON.parse(message));
		});
	});
};
