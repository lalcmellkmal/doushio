const caps = require('../server/caps'),
    config = require('./config'),
    common = require('../common'),
    { safe } = common,
    db = require('../db'),
    mainConfig = require('../config'),
    msgcheck = require('../server/msgcheck'),
    okyaku = require('../server/okyaku'),
    Recaptcha2 = require('recaptcha2'),
    winston = require('winston');

const SMTP = config.SMTP && require('nodemailer').createTransport(config.SMTP);
const TELEGRAM = config.TELEGRAM_TOKEN && (() => {
	const TelegramBot = require('node-telegram-bot-api');
	return new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });
})();
if (TELEGRAM) {
	TELEGRAM.onText(/\/register\s*(.*)/, async ({ from }, match) => {
		const { id } = from;
		const password = match[1];
		if (password !== config.TELEGRAM_PASSWORD) {
			TELEGRAM.sendMessage(id, 'Wrong password, sorry!');
			return;
		}
		const r = global.redis;
		try {
			const added = await r.promise.hset('telegram:mods', id, '0');
			TELEGRAM.sendMessage(id, added > 0 ? "You're on the list!" : "Re-registered...?");
		} catch (err) {
			winston.error('/register', id, err);
			TELEGRAM.sendMessage(id, "Something's gone horribly wrong.");
		}
	});
	TELEGRAM.onText(/\/deregister/, async ({ from }) => {
		const { id } = from;
		// This seems abuseable?
		const r = global.redis;
		try {
			const removed = await r.promise.hdel('telegram:mods', id);
			TELEGRAM.sendMessage(id, removed > 0 ? "So long~" : "You're not registered to start with!");
		} catch (err) {
			winston.error('/deregister', id, err);
			TELEGRAM.sendMessage(id, "Whoopsie!");
		}
	});
	TELEGRAM.onText(/\/nipah/, ({ from }) => TELEGRAM.sendMessage(from.id, 'mii'));
	TELEGRAM.on('photo', ({ from }) => TELEGRAM.sendMessage(from.id, 'HNNNNGGGGGG'));
	winston.info('Polling Telegram bot.');
}

var VALIDATOR;
if (!!config.RECAPTCHA_SITE_KEY) {
	VALIDATOR = new Recaptcha2({
		siteKey: config.RECAPTCHA_SITE_KEY,
		secretKey: config.RECAPTCHA_SECRET_KEY,
	});
	exports.enabled = true;
}

function report(reporter_ident, op, num, cb) {
	const board = caps.can_access_thread(reporter_ident, op);
	if (!board)
		return cb("Post does not exist.");

	const reporter = maybe_mnemonic(reporter_ident.ip) || '???';

	const yaku = new db.Yakusoku(board, {auth: 'Moderator'});
	const reader = new db.Reader(yaku);
	const kind = op == num ? 'thread' : 'post';
	reader.get_posts(kind, [num], {}, (err, posts) => {
		if (err || !posts[0]) {
			if (err)
				console.error(err);
			const message = `(${kind} missing)`;
			send_report(reporter, board, op, num, message, [message]).then(() => cb(null), cb);
			return;
		}

		const post = posts[0];
		let name = post.name || common.ANON;
		if (name.length > 23)
			name = name.slice(0, 20) + '...';
		if (post.trip)
			name += ' # ' + post.trip;
		if (post.ip)
			name += ' # ' + maybe_mnemonic(post.ip);
		let body = 'Offender: ' + name;
		let html = ['Offender: ', safe('<b>'), name, safe('</b>')];

		send_report(reporter, board, op, num, body, html).then(() => cb(null), cb);
	});
}

async function send_report(reporter, board, op, num, body, html) {
	let noun;
	let url = `${config.REPORT_URL_BASE}${board}/${op}?reported`;
	if (op == num) {
		noun = 'Thread';
	}
	else {
		noun = 'Post';
		url += '#' + num;
	}
	const subject = `${noun} #${num} reported by ${reporter}`;

	body = body ? `${body}\n\n${url}` : url;
	if (html.length)
		html.push(safe('<br><br>'));
	html.push(safe('<a href="'), url, safe('">'), '>>'+num, safe('</a>'));

	const promises = [];
	if (SMTP) {
		const opts = {
			from: config.MAIL_FROM,
			to: config.MAIL_TO.join(', '),
			subject,
			text: body,
			html: common.flatten(html).join(''),
		};
		promises.push(new Promise((resolve, reject) => {
			SMTP.sendMail(opts, (err, _resp) => err ? reject(err) : resolve());
		}));
	}
	if (TELEGRAM) {
		promises.push((async () => {
			const r = global.redis;
			const mods = await r.promise.hgetall('telegram:mods');
			const message = `${subject}\n${body}`;
			for (let id in mods) {
				// TODO if this errors, increment the error count, and possibly eject the user
				await TELEGRAM.sendMessage(id, message);
			}
		})());
	}

	if (promises.length) {
		await Promise.all(promises);
	} else {
		winston.warn(`Reporting not configured!\n${subject}\n${body}`);
		throw new Error('Reporting not configured, sorry!');
	}
}

function maybe_mnemonic(ip) {
	if (ip && mainConfig.IP_MNEMONIC) {
		const { ip_mnemonic } = require('../admin/common');
		ip = ip_mnemonic(ip);
	}
	return ip;
}

okyaku.dispatcher[common.REPORT_POST] = function (msg, client) {
	if (!msgcheck.check(['id', 'string'], msg))
		return false;

	var num = msg[0];
	var op = db.OPs[num];
	if (!op || !caps.can_access_thread(client.ident, op))
		return reply_error("Post does not exist.");

	const response = msg[1];
	if (!response)
		return reply_error("Pretty please?");
	if (response.length > 10000)
		return reply_error("tl;dr");

	VALIDATOR.validate(response, client.ident.ip).then(function () {
		var op = db.OPs[num];
		if (!op)
			return reply_error("Post does not exist.");
		report(client.ident, op, num, function (err) {
			if (err) {
				winston.error(err);
				return reply_error("Couldn't send report.");
			}
			// success!
			client.send([op, common.REPORT_POST, num]);
		});
	}, function (err) {
		let readable = VALIDATOR.translateErrors(err);
		if (Array.isArray(readable))
			readable = readable.join('; ');
		reply_error(readable);
	});
	return true;

	function reply_error(err) {
		if (!err)
			err = 'Unknown reCAPTCHA error.';
		var op = db.OPs[num] || 0;
		var msg = {status: 'error', error: err};
		client.send([op, common.REPORT_POST, num, msg]);
		return true;
	}
};

