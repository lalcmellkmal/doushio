const _ = require('../lib/underscore'),
    { escape_html } = require('../common'),
    { Muggle } = require('../etc'),
    config = require('../config'),
    crypto = require('crypto'),
    formidable = require('formidable'),
    querystring = require('querystring'),
    RES = require('./state').resources,
    request = require('request'),
    winston = require('winston');

function connect() {
	return global.redis;
}

exports.login = function (req, resp) {
	const { ip } = req.ident;
	// if login cookie present, redirect to board (preferably, go back. but will that be easy?)
	const r = connect();
	const fail = error => respond_error(resp, error);
	if (req.query.state) {
		const { state } = req.query;
		r.get('github:'+state, (err, savedIP) => {
			if (err) {
				winston.error(`Couldn't read login: ${err}`);
				fail("Couldn't read login attempt.");
				return;
			}
			if (!savedIP) {
				winston.info(`Expired login attempt from ${ip}`);
				fail("Login attempt expired. Please try again.");
				return;
			}
			if (savedIP != ip) {
				winston.warn(`IP changed from ${savedIP} to ${ip}`);
				fail("Your IP changed during login. Please try again.");
				return;
			}
			if (req.query.error == 'access_denied') {
				fail("User did not approve GitHub app access.");
				return;
			}
			if (req.query.error) {
				// escaping out of paranoia (though respond_error emits JSON)
				let err = escape_html(req.query.error);
				winston.error(`OAuth error: ${err}`);
				if (req.query.error_description) {
					err = escape_html(req.query.error_description);
					winston.error(`Desc: ${err}`);
				}
				fail(`OAuth login failure: ${err}`);
				return;
			}
			const { code } = req.query;
			if (!code) {
				fail("OAuth code missing!");
				return;
			}
			request_access_token(code, state, (err, token) => {
				if (err) {
					winston.error(`Requesting GH access token: ${err}`);
					fail("Couldn't obtain token from GitHub. Try again.");
					return;
				}
				request_username(token, (err, username) => {
					if (err) {
						winston.error(`Requesting GH username: ${err}`);
						fail("Couldn't read username. Try again.");
						return;
					}
					r.del('github:'+state, (err) => {});
					if (/^popup:/.test(state))
						req.popup_HACK = true;
					verify_auth(req, resp, username.toLowerCase());
				});
			});
		});
		return;
	}
	// new login attempt; TODO rate limit
	let nonce = random_str();
	if (req.query.popup !== undefined)
		nonce = 'popup:' + nonce;
	r.setex('github:'+nonce, 60, ip, (err) => {
		if (err) {
			winston.error(`Couldn't save login: ${err}`);
			fail("Couldn't persist login attempt.");
			return;
		}
		const params = {
			client_id: config.GITHUB_CLIENT_ID,
			state: nonce,
			allow_signup: 'false',
		};
		const url = 'https://github.com/login/oauth/authorize?' +
				querystring.stringify(params);
		resp.writeHead(303, {Location: url});
		resp.end('Redirect to GitHub Login');
	});
}

function request_access_token(code, state, cb) {
	const payload = {
		client_id: config.GITHUB_CLIENT_ID,
		client_secret: config.GITHUB_CLIENT_SECRET,
		code: code,
		state: state,
	};
	const opts = {
		url: 'https://github.com/login/oauth/access_token',
		body: payload,
		json: true,
	};
	request.post(opts, (err, tokenResp, packet) => {
		if (err || !packet || typeof packet.access_token != 'string') {
			cb(err || "No access token in response");
		}
		else {
			cb(null, packet.access_token);
		}
	});
}

function request_username(token, cb) {
	const opts = {
		url: 'https://api.github.com/user',
		headers: {Authorization: 'token ' + token, 'User-Agent': 'Doushio-Auth'},
		json: true,
	};
	request.get(opts, (err, usernameResp, packet) => {
		if (err || !packet || typeof packet.login != 'string') {
			cb(err || "Invalid username response");
		}
		else {
			cb(null, packet.login);
		}
	});
}

function verify_auth(req, resp, user) {
	if (!user)
		return respond_error(resp, 'Invalid username.');
	const { ip } = req.ident;
	const packet = {ip, user, date: Date.now()};
	if (config.ADMIN_GITHUBS.includes(user)) {
		winston.info(`@${user} logging in as admin from ${ip}`);
		packet.auth = 'Admin';
		exports.set_cookie(req, resp, packet);
	}
	else if (config.MODERATOR_GITHUBS.includes(user)) {
		winston.info(`@${user} logging in as moderator from ${ip}`);
		packet.auth = 'Moderator';
		exports.set_cookie(req, resp, packet);
	}
	else {
		winston.error(`Login attempt by @${user} from ${ip}`);
		return respond_error(resp, 'Check your privilege.');
	}
};

exports.set_cookie = function (req, resp, info) {
	const pass = random_str();
	info.csrf = random_str();

	const m = connect().multi();
	m.hmset('session:'+pass, info);
	m.expire('session:'+pass, config.LOGIN_SESSION_TIME);
	m.exec(err => {
		if (err)
			return oauth_error(resp, err);
		respond_ok(req, resp, make_cookie('a', pass));
	});
};

function extract_login_cookie(chunks) {
	if (!chunks || !chunks.a)
		return false;
	return /^[a-zA-Z0-9+\/]{20}$/.test(chunks.a) ? chunks.a : false;
}
exports.extract_login_cookie = extract_login_cookie;

exports.check_cookie = function (cookie, callback) {
	const r = connect();
	r.hgetall('session:' + cookie, (err, session) => {
		if (err)
			return callback(err);
		else if (_.isEmpty(session))
			return callback(Muggle('Not logged in.'));
		callback(null, session);
	});
};

exports.check_cookie_async = (cookie) => new Promise((resolve, reject) => {
	exports.check_cookie(cookie, (err, session) => err ? reject(err) : resolve(session));
});

exports.logout = function (req, resp) {
	if (req.method != 'POST') {
		resp.writeHead(200, {'Content-Type': 'text/html'});
		resp.end('<!doctype html><title>Logout</title><form method=post>' +
			'<input type=submit value=Logout></form>');
		return;
	}
	const r = connect();
	const cookie = extract_login_cookie(req.cookies);
	if (!cookie) {
		console.log('no cookie');
		return respond_error(resp, "No login cookie for logout.");
	}
	r.hgetall('session:' + cookie, (err, session) => {
		if (err)
			return respond_error(resp, "Logout error.");
		r.del('session:' + cookie);
		respond_ok(req, resp, 'a=; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict');
	});
};

function respond_error(resp, message) {
	resp.writeHead(200, {'Content-Type': 'application/json'});
	resp.end(JSON.stringify({status: 'error', message}));
}

function respond_ok(req, resp, cookie) {
	const headers = {'Set-Cookie': cookie};
	if (/json/.test(req.headers.accept)) {
		headers['Content-Type'] = 'application/json';
		resp.writeHead(200, headers);
		resp.end(JSON.stringify({status: 'okay'}));
	}
	else if (req.popup_HACK) {
		headers['Content-Type'] = 'text/html';
		resp.writeHead(200, headers);
		resp.end('<!doctype html><title>OK</title>Logged in!' +
			'<script>window.opener.location.reload(); window.close();</script>');
	}
	else {
		headers.Location = config.DEFAULT_BOARD + '/';
		resp.writeHead(303, headers);
		resp.end("OK! Redirecting.");
	}
}

function make_expiry() {
	const expiry = new Date(Date.now() + config.LOGIN_SESSION_TIME*1000).toUTCString();
	/* Change it to the expected dash-separated format */
	const m = expiry.match(/^(\w+,\s+\d+)\s+(\w+)\s+(\d+\s+[\d:]+\s+\w+)$/);
	return m ? `${m[1]}-${m[2]}-${m[3]}` : expiry;
}

function make_cookie(key, val) {
	let header = `${key}=${val}; Expires=${make_expiry()}; SameSite=Strict`;
	const domain = config.LOGIN_COOKIE_DOMAIN;
	if (domain)
		header += '; Domain=' + domain;
	return header;
}

function random_str() {
	return crypto.randomBytes(15).toString('base64');
}
