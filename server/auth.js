var _ = require('../lib/underscore'),
    common = require('../common'),
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
	var ip = req.ident.ip;
	// if login cookie present, redirect to board (preferably, go back. but will that be easy?)
	var r = connect();
	function fail(error) {
		respond_error(resp, error)
	}
	if (req.query.state) {
		var state = req.query.state;
		r.get('github:'+state, function (err, savedIP) {
			if (err) {
				winston.error("Couldn't read login: " + err);
				fail("Couldn't read login attempt.");
				return;
			}
			if (!savedIP) {
				winston.info("Expired login attempt from " + ip);
				fail("Login attempt expired. Please try again.");
				return;
			}
			if (savedIP != ip) {
				winston.warn("IP changed from " + savedIP + " to " + ip);
				fail("Your IP changed during login. Please try again.");
				return;
			}
			if (req.query.error == 'access_denied') {
				fail("User did not approve GitHub app access.");
				return;
			}
			if (req.query.error) {
				// escaping out of paranoia (though respond_error emits JSON)
				var err = common.escape_html(req.query.error);
				winston.error("OAuth error: " + err);
				if (req.query.error_description) {
					err = common.escape_html(req.query.error_description);
					winston.error("Desc: " + err);
				}
				fail("OAuth login failure: " + err);
				return;
			}
			var code = req.query.code;
			if (!code) {
				fail("OAuth code missing!");
				return;
			}
			request_access_token(req.query.code, state, function (err, token) {
				if (err) {
					winston.error("Github access token: " + err);
					fail("Couldn't obtain token from GitHub. Try again.");
					return;
				}
				request_username(token, function (err, username) {
					if (err) {
						winston.error("Username: " + err);
						fail("Couldn't read username. Try again.");
						return;
					}
					r.del('github:'+state, function (err) {});
					if (/^popup:/.test(state))
						req.popup_HACK = true;
					verify_auth(req, resp, username);
				});
			});
		});
		return;
	}
	// new login attempt; TODO rate limit
	var nonce = random_str();
	if (req.query.popup !== undefined)
		nonce = 'popup:' + nonce;
	r.setex('github:'+nonce, 60, ip, function (err) {
		if (err) {
			winston.error("Couldn't save login: " + err);
			fail("Couldn't persist login attempt.");
			return;
		}
		var params = {
			client_id: config.GITHUB_CLIENT_ID,
			state: nonce,
			allow_signup: 'false',
		};
		var url = 'https://github.com/login/oauth/authorize?' +
				querystring.stringify(params);
		resp.writeHead(303, {Location: url});
		resp.end('Redirect to GitHub Login');
	});
}

function request_access_token(code, state, cb) {
	var payload = {
		client_id: config.GITHUB_CLIENT_ID,
		client_secret: config.GITHUB_CLIENT_SECRET,
		code: code,
		state: state,
	};
	var opts = {
		url: 'https://github.com/login/oauth/access_token',
		body: payload,
		json: true,
	};
	request.post(opts, function (err, tokenResp, packet) {
		if (err || !packet || typeof packet.access_token != 'string') {
			cb(err || "No access token in response");
		}
		else {
			cb(null, packet.access_token);
		}
	});
}

function request_username(token, cb) {
	var opts = {
		url: 'https://api.github.com/user',
		headers: {Authorization: 'token ' + token, 'User-Agent': 'Doushio-Auth'},
		json: true,
	};
	request.get(opts, function (err, usernameResp, packet) {
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
	var ip = req.ident.ip;
	var packet = {ip: ip, user: user, date: Date.now()};
	if (config.ADMIN_GITHUBS.indexOf(user) >= 0) {
		winston.info("@" + user + " logging in as admin from " + ip);
		packet.auth = 'Admin';
		exports.set_cookie(req, resp, packet);
	}
	else if (config.MODERATOR_GITHUBS.indexOf(user) >= 0) {
		winston.info("@" + user + " logging in as moderator from " + ip);
		packet.auth = 'Moderator';
		exports.set_cookie(req, resp, packet);
	}
	else {
		winston.error("Login attempt by @" + user + " from " + ip);
		return respond_error(resp, 'Check your privilege.');
	}
};

exports.set_cookie = function (req, resp, info) {
	var pass = random_str();
	info.csrf = random_str();

	var m = connect().multi();
	m.hmset('session:'+pass, info);
	m.expire('session:'+pass, config.LOGIN_SESSION_TIME);
	m.exec(function (err) {
		if (err)
			return oauth_error(resp, err);
		respond_ok(req, resp, make_cookie('a', pass, info.expires));
	});
};

function extract_login_cookie(chunks) {
	if (!chunks || !chunks.a)
		return false;
	return /^[a-zA-Z0-9+\/]{20}$/.test(chunks.a) ? chunks.a : false;
}
exports.extract_login_cookie = extract_login_cookie;

exports.check_cookie = function (cookie, callback) {
	var r = connect();
	r.hgetall('session:' + cookie, function (err, session) {
		if (err)
			return callback(err);
		else if (_.isEmpty(session))
			return callback('Not logged in.');
		callback(null, session);
	});
};

exports.logout = function (req, resp) {
	if (req.method != 'POST') {
		resp.writeHead(200, {'Content-Type': 'text/html'});
		resp.end('<!doctype html><title>Logout</title><form method=post>' +
			'<input type=submit value=Logout></form>');
		return;
	}
	var r = connect();
	var cookie = extract_login_cookie(req.cookies);
	if (!cookie) {
		console.log('no cookie');
		return respond_error(resp, "No login cookie for logout.");
	}
	r.hgetall('session:' + cookie, function (err, session) {
		if (err)
			return respond_error(resp, "Logout error.");
		r.del('session:' + cookie);
		respond_ok(req, resp, 'a=; expires=Thu, 01 Jan 1970 00:00:00 GMT');
	});
};

function respond_error(resp, message) {
	resp.writeHead(200, {'Content-Type': 'application/json'});
	resp.end(JSON.stringify({status: 'error', message: message}));
}

function respond_ok(req, resp, cookie) {
	var headers = {'Set-Cookie': cookie};
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
	var expiry = new Date(Date.now()
		+ config.LOGIN_SESSION_TIME*1000).toUTCString();
	/* Change it to the expected dash-separated format */
	var m = expiry.match(/^(\w+,\s+\d+)\s+(\w+)\s+(\d+\s+[\d:]+\s+\w+)$/);
	return m ? m[1] + '-' + m[2] + '-' + m[3] : expiry;
}

function make_cookie(key, val) {
	var header = key + '=' + val + '; Expires=' + make_expiry();
	var domain = config.LOGIN_COOKIE_DOMAIN;
	if (domain)
		header += '; Domain=' + domain;
	return header;
}

function random_str() {
	return crypto.randomBytes(15).toString('base64');
}
