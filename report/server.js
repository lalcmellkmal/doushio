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
			send_report(reporter, board, op, num, message, [message], cb);
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

		let img;
		if (post.image && !post.hideimg)
			img = image_preview(post.image);
		if (img) {
			body += '\nThumbnail: ' + img.src;
			html.push(safe('<br><br><img src="'), img.src,
				safe('" width="'), img.width,
				safe('" height="'), img.height,
				safe('" title="'), img.title, safe('">'));
		}

		send_report(reporter, board, op, num, body, html, cb);
	});
}

function send_report(reporter, board, op, num, body, html, cb) {
	let noun;
	let url = `${config.MAIL_THREAD_URL_BASE}${board}/${op}?reported`;
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

	if (SMTP) {
		const opts = {
			from: config.MAIL_FROM,
			to: config.MAIL_TO.join(', '),
			subject,
			text: body,
			html: common.flatten(html).join(''),
		};
		setTimeout(() => {
			SMTP.sendMail(opts, (err, resp) => err ? cb(err) : cb(null));
		}, 0);
	}

	if (!SMTP) {
		winston.warn(`Reporting not configured!\n${subject}\n${body}`);
	}
}

function image_preview(info) {
	if (!info.dims)
		return;
	// DRY
	let tw = info.dims[2], th = info.dims[3];
	if (info.mid) {
		tw *= 2;
		th *= 2;
	}
	if (!tw || !th) {
		tw = info.dims[0];
		th = info.dims[1];
	}
	if (!tw || !th)
		return;

	const mediaURL = config.MAIL_MEDIA_URL || require('../imager/config').MEDIA_URL;
	let src;
	if (info.mid)
		src = mediaURL + '/mid/' + info.mid;
	else if (info.realthumb || info.thumb)
		src = mediaURL + '/thumb/' + (info.realthumb || info.thumb);
	else
		return;

	const title = common.readable_filesize(info.size);
	return {src, width: tw, height: th, title};
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

