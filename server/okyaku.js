const caps = require('./caps'),
    common = require('../common'),
    events = require('events'),
    Muggle = require('../etc').Muggle,
    STATE = require('./state'),
    util = require('util'),
    winston = require('winston');

const dispatcher = exports.dispatcher = {};

function Okyaku(socket, ip, country) {
	events.EventEmitter.call(this);

	this.socket = socket;
	this.ident = caps.lookup_ident(ip, country);
	this.watching = {};
	this.ip = ip;
	this.country = country;

	let clients = STATE.clientsByIP[ip];
	if (clients)
		clients.push(this);
	else
		clients = STATE.clientsByIP[ip] = [this];
	STATE.emitter.emit('change:clientsByIP', ip, clients);
}
util.inherits(Okyaku, events.EventEmitter);
exports.Okyaku = Okyaku;

const OK = Okyaku.prototype;

OK.send = function (msg) {
	this.socket.send(JSON.stringify([msg]));
};

OK.on_update = function (op, kind, msg) {
	// Special cases for operations that overwrite a client's state
	if (this.post && kind == common.DELETE_POSTS) {
		const nums = JSON.parse(msg)[0].slice(2);
		if (nums.includes(this.post.num))
			this.post = null;
	}
	else if (this.post && kind == common.DELETE_THREAD) {
		if (this.post.num == op || this.post.op == op)
			this.post = null;
	}

	if (this.blackhole && HOLED_UPDATES.includes(kind))
		return;
	this.socket.send(msg);
};

const HOLED_UPDATES = [common.DELETE_POSTS, common.DELETE_THREAD];

OK.on_thread_sink = function (thread, err) {
	/* TODO */
	winston.error(`>>${thread} sank: ${err}`);
};

const WORMHOLES = [common.SYNCHRONIZE, common.FINISH_POST];

// websocket data arrives here
OK.on_message = async function (data) {
	let msg;
	try { msg = JSON.parse(data); }
	catch (e) {}
	let type = common.INVALID;
	if (msg) {
		if (this.post && typeof msg == 'string')
			type = common.UPDATE_POST;
		else if (msg.constructor == Array)
			type = msg.shift();
	}
	if (!this.synced && type != common.SYNCHRONIZE)
		type = common.INVALID;
	if (this.blackhole && !WORMHOLES.includes(type))
		return;
	const func = dispatcher[type];
	try {
		const result = func && func(msg, this);
		if (!result || (await Promise.resolve(result)) === false) {
			const error = new Error(`Message rejected: ${JSON.stringify(data)}`);
			throw Muggle("Bad protocol.", error);
		}
	}
	catch (err) {
		this.kotowaru(err);
	}
};

const ip_expiries = new Map;

OK.on_close = async function () {
	const { ip } = this;
	const clientList = STATE.clientsByIP[ip];
	if (clientList) {
		const i = clientList.indexOf(this);
		if (i >= 0) {
			clientList.splice(i, 1);
			STATE.emitter.emit('change:clientsByIP', ip, clientList);
		}
		if (!clientList.length) {
			// Expire this list after a short delay
			if (ip_expiries.has(ip))
				clearTimeout(ip_expiries.get(ip));
			ip_expiries.set(ip, setTimeout(() => {
				const list = STATE.clientsByIP[ip];
				if (list && list.length === 0)
					delete STATE.clientsByIP[ip];
				ip_expiries.delete(ip);
			}, 5000));
		}
	}

	if (this.id) {
		delete STATE.clients[this.id];
		this.id = null;
	}
	this.synced = false;
	const { db } = this;
	if (db) {
		db.kikanai();
		if (this.post) {
			try {
				await this.finish_post();
			}
			catch (err) {
				winston.warn(`finishing post: ${err}`);
				// fall through
			}
		}
		db.disconnect();
	}

	this.emit('close');
};

OK.kotowaru = function (error) {
	if (this.blackhole)
		return;
	let msg = 'Server error.';
	if (error instanceof Muggle) {
		msg = error.most_precise_error_message();
		error = error.deepest_reason();
	}
	winston.error(`Error by ${JSON.stringify(this.ident)}:`);
	winston.error(error || msg);
	this.send([0, common.INVALID, msg]);
	this.synced = false;
};

OK.finish_post = async function (callback) {
	/* TODO: Should we check this.uploading? */
	await this.db.finish_post(this.post);
	this.post = null;
};

exports.scan_client_caps = function () {
	for (let ip in STATE.clientsByIP) {
		STATE.clientsByIP[ip].forEach(function (okyaku) {
			if (!okyaku.id || !okyaku.board)
				return;
			let ident = caps.lookup_ident(ip, okyaku.country);
			if (ident.timeout) {
				okyaku.blackhole = true;
				return;
			}
			if (!caps.can_access_board(ident, okyaku.board)) {
				try {
					okyaku.socket.close();
				}
				catch (e) { /* bleh */ }
			}
		});
	}
};
