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

O.track_temporary = async function (path) {
	const m = this.connect();
	const tracked = await m.promise.sadd('temps', path);
	if (tracked > 0) {
		setTimeout(() => this.del_temp(path), (IMG_EXPIRY+1) * 1000);
	}
};

O.lose_temporaries = async function (files) {
	await this.connect().promise.srem('temps', files);
};

O.del_temp = async function (path) {
	try {
		await this.cleanup_image_alloc(path);
	}
	catch (err) {
		winston.warn(`unlink ${path}: ${err}`);
	}
};

// if an image doesn't get used in a post in a timely fashion, delete it
O.cleanup_image_alloc = async function (path) {
	const r = this.connect();
	const n = await r.promise.srem('temps', path);
	if (n) {
		await unlink(path);
	}
	return !!n;
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

O.check_duplicate = async function (hash) {
	const num = await this.connect().promise.get('hash:'+hash);
	if (num)
		throw Muggle(`Duplicate of >>${num}.`);
	return false;
};

O.record_image_alloc = async function (id, alloc) {
	const r = this.connect();
	await r.promise.setex('image:' + id, IMG_EXPIRY, JSON.stringify(alloc));
};

O.obtain_image_alloc = async function (id) {
	const m = this.connect().multi();
	const key = 'image:' + id;
	m.get(key);
	m.setnx('lock:' + key, '1');
	m.expire('lock:' + key, IMG_EXPIRY);
	const [img, locked] = await m.promise.exec();
	if (locked != 1)
		throw Muggle("Image in use.");
	if (!img)
		throw Muggle("Image lost.");
	const alloc = JSON.parse(img);
	alloc.id = id;
	return alloc;
};

exports.is_standalone = () => STANDALONE;

O.commit_image_alloc = async function (alloc) {
	// We should already hold the lock at this point.
	const key = 'image:' + alloc.id;
	const m = this.connect().multi();
	m.del(key);
	m.del('lock:' + key);
	await m.promise.exec();
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
