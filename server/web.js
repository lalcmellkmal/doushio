const _ = require('../lib/underscore'),
    auth = require('./auth'),
    caps = require('./caps'),
    config = require('../config'),
    formidable = require('formidable'),
    Stream = require('stream'),
    url_parse = require('url').parse,
    util = require('util'),
    winston = require('winston');

let send;
if (config.SERVE_STATIC_FILES)
	send = require('send');

const escape = require('../common').escape_html;
const routes = [];
const resources = [];

const server = require('http').createServer((req, resp) => {
	let ip = req.connection.remoteAddress;
	let country;
	if (config.TRUST_X_FORWARDED_FOR)
		ip = parse_forwarded_for(req.headers['x-forwarded-for']) || ip;
	if (config.CLOUDFLARE) {
		ip = req.headers['cf-connecting-ip'] || ip;
		country = req.headers['cf-ipcountry'];
	}
	if (!ip) {
		resp.writeHead(500, {'Content-Type': 'text/plain'});
		resp.end("Your IP could not be determined. "
				+ "This server is misconfigured.");
		return;
	}
	req.ident = caps.lookup_ident(ip, country);
	if (req.ident.timeout)
		return timeout(resp);
	if (req.ident.ban)
		return render_500(resp);
	if (req.ident.slow)
		return slow_request(req, resp);
	handle_request(req, resp);
});
exports.server = server;

/// main request router
function handle_request(req, resp) {
	const method = req.method.toLowerCase();
	// chop the query string off of `req.url`
	const { pathname, query } = url_parse(req.url, true);
	req.url = pathname;
	req.query = query;
	req.cookies = parse_cookie(req.headers.cookie);

	// try the dynamic routes
	for (let route of routes) {
		if (method != route.method)
			continue;
		const m = req.url.match(route.pattern);
		if (m) {
			// dispatch this route!
			route.handler(req, resp, m);
			if (config.DEBUG)
				winston.verbose(`${route.method.toUpperCase()} ${req.url}`);
			return;
		}
	}

	// otherwise, try the resource-based handlers
	if (method == 'get' || method == 'head') {
		for (let resource of resources) {
			const m = req.url.match(resource.pattern);
			if (m) {
				handle_resource(req, resp, resource, m);
				return;
			}
		}
	}

	if (config.SERVE_IMAGES) {
		if (require('../imager').serve_image(req, resp))
			return;
	}

	if (config.SERVE_STATIC_FILES) {
		send(req, req.url, {root: 'www/'}).pipe(resp);
		return;
	}

	// nothing worked
	render_404(resp);
	if (config.DEBUG)
		winston.verbose(`404 ${req.url} fallthrough`);
}

/// when you register an HTTP resource with `web.resource` this code dispatches it.
/// by the way: web.resource accepts two or three function parameters
/// they are `head`, `get` (AKA the body), and optionally `tear_down`
///
/// when a request comes in that matches `resource.pattern`,
/// the `head` callback is called with the request header
/// `head` is allowed to finish the response early with redirects, errors, etc.
/// otherwise, if request.method != "HEAD", the main `get` handler is called
/// `get` is where the meat of the response lives.
/// optionally, after the response ends, if it was a 200, `tear_down` happens.
function handle_resource(req, resp, resource, params) {
	const args = [req];
	if (resource.headParams)
		args.push(params);
	// here's where we pass the HEAD handler's callback
	args.push(resource_second_handler.bind(null, req, resp, resource));

	const cookie = auth.extract_login_cookie(req.cookies);
	if (cookie) {
		auth.check_cookie(cookie, (err, ident) => {
			if (err && !resource.authPassthrough) {
				if (config.DEBUG)
					winston.verbose(`DENY ${req.url} (${err})`);
				return forbidden(resp, 'No cookie.');
			}
			else if (!err)
				_.extend(req.ident, ident);
			resource.head.apply(null, args);
		});
	}
	else if (!resource.authPassthrough) {
		if (config.DEBUG)
			winston.verbose(`DENY ${req.url}`);
		render_404(resp);
	}
	else
		resource.head.apply(null, args);
	return true;
}

// this is the callback passed to the first half of a web `resource`
// it passes control to the second half of the resource
function resource_second_handler(req, resp, resource, err, act, arg) {
	const method = req.method.toUpperCase();
	const log = config.DEBUG;
	if (err) {
		if (err == 404) {
			if (log)
				winston.verbose(`404 ${req.url}`);
			return render_404(resp);
		}
		else if (err != 500)
			winston.error(err);
		else if (log)
			winston.verbose(`500 ${req.url}`);
		return render_500(resp);
	}
	else if (act == 'ok' || act == 200) {
		if (log)
			winston.verbose(`${method} ${req.url} 200`);
		if (method == 'HEAD') {
			const headers = (arg && arg.headers) || noCacheHeaders;
			resp.writeHead(200, headers);
			resp.end();
			if (resource.tear_down)
				resource.tear_down.call(arg);
		}
		else {
			if (resource.tear_down) {
				if (!arg)
					arg = {};
				arg.finished = () => resource.tear_down.call(arg);
			}
			resource.get.call(arg, req, resp);
		}
	}
	else if (act == 304) {
		resp.writeHead(304);
		resp.end();
		if (log)
			winston.verbose(`304 ${req.url}`);
	}
	else if (act == 'redirect' || (act >= 300 && act < 400)) {
		const headers = {Location: arg};
		if (act == 'redirect')
			act = 303;
		if (log)
			winston.verbose(`${act} ${req.url} to ${arg}`);
		if (act == 303.1) {
			act = 303;
			headers['X-Robots-Tag'] = 'nofollow';
		}
		resp.writeHead(act, headers);
		resp.end();
	}
	else if (act == 'redirect_js') {
		if (log)
			winston.verbose(`303.js ${req.url} to ${arg}`);
		if (method == 'HEAD') {
			resp.writeHead(303, {Location: arg});
			resp.end();
		}
		else
			redirect_js(resp, arg);
	}
	else
		throw new Error(`Unknown resource handler: ${act}`);
}

exports.route_get = function (pattern, handler) {
	handler = auth_passthrough.bind(null, handler);
	routes.push({method: 'get', pattern, handler});
};

/// `web.resource` registration function
exports.resource = function (pattern, head, get, tear_down) {
	if (head === true)
		head = (req, cb) => { cb(null, 'ok'); };
	const res = {pattern, head, authPassthrough: true};
	res.headParams = (head.length == 3);
	if (get)
		res.get = get;
	if (tear_down)
		res.tear_down = tear_down;
	resources.push(res);
};

exports.resource_auth = function (pattern, head, get, finished) {
	if (head === true)
		head = (req, cb) => { cb(null, 'ok'); };
	const res = {pattern, head, authPassthrough: false};
	res.headParams = (head.length == 3);
	if (get)
		res.get = get;
	if (finished)
		res.finished = finished;
	resources.push(res);
};

function parse_forwarded_for(ff) {
	if (!ff)
		return null;
	const ips = ff.split(',');
	if (!ips.length)
		return null;
	const last = ips[ips.length - 1].trim();
	/* check that it looks like some kind of IPv4/v6 address */
	if (!/^[\da-fA-F.:]{3,45}$/.test(last))
		return null;
	return last;
}
exports.parse_forwarded_for = parse_forwarded_for;

function auth_passthrough(handler, req, resp, params) {
	const cookie = auth.extract_login_cookie(req.cookies);
	if (!cookie) {
		handler(req, resp, params);
		return;
	}

	auth.check_cookie(cookie, (err, ident) => {
		if (!err)
			_.extend(req.ident, ident);
		handler(req, resp, params);
	});
}

exports.route_get_auth = function (pattern, handler) {
	routes.push({method: 'get', pattern: pattern,
			handler: auth_checker.bind(null, handler, false)});
};

function auth_checker(handler, is_post, req, resp, params) {
	if (is_post) {
		const form = new formidable.IncomingForm();
		form.maxFieldsSize = 50 * 1024;
		form.type = 'urlencoded';
		try {
			form.parse(req, (err, fields) => {
				if (err) {
					resp.writeHead(500, noCacheHeaders);
					resp.end(preamble + escape(err));
					return;
				}
				req.body = fields;
				check_it();
			});
		}
		catch (e) {
			winston.error('formidable threw: ' + e);
			return forbidden(resp, 'Bad request.');
		}
	}
	else
		check_it();

	function check_it() {
		const cookie = auth.extract_login_cookie(req.cookies);
		if (!cookie)
			return forbidden(resp, 'No cookie.');
		auth.check_cookie(cookie, (err, session) => {
			if (err)
				return forbidden(resp, err);
			if (is_post && session.csrf != req.body.csrf)
				return forbidden(resp, "Possible CSRF.");
			_.extend(req.ident, session);
			handler(req, resp, params);
		});
	}
}

function forbidden(resp, err) {
	resp.writeHead(401, noCacheHeaders);
	resp.end(preamble + escape(err));
}

exports.route_post = function (pattern, handler) {
	// auth_passthrough conflicts with formidable
	// (by the time the cookie check comes back, formidable can't
	// catch the form data)
	// We don't need the auth here anyway currently thanks to client_id
	routes.push({method: 'post', pattern, handler});
};

exports.route_post_auth = function (pattern, handler) {
	handler = auth_checker.bind(null, handler, true);
	routes.push({method: 'post', pattern, handler});
};

const noCacheHeaders = {'Content-Type': 'text/html; charset=UTF-8',
		'Expires': 'Thu, 01 Jan 1970 00:00:00 GMT',
		'Cache-Control': 'no-cache, no-store',
		'X-Frame-Options': 'sameorigin',
		'X-XSS-Protection': '1',
};
const preamble = '<!doctype html><meta charset=utf-8>';

exports.noCacheHeaders = noCacheHeaders;

exports.notFoundHtml = preamble + '<title>404</title>404';
exports.serverErrorHtml = preamble + '<title>500</title>Server error';

exports.set_error_templates = (res) => {
	exports.notFoundHtml = res.notFoundHtml;
	exports.serverErrorHtml = res.serverErrorHtml;
};

function render_404(resp) {
	resp.writeHead(404, noCacheHeaders);
	resp.end(exports.notFoundHtml);
};
exports.render_404 = render_404;

function render_500(resp) {
	resp.writeHead(500, noCacheHeaders);
	resp.end(exports.serverErrorHtml);
}
exports.render_500 = render_500;

function slow_request(req, resp) {
	let n = Math.floor(1000 + Math.random() * 500);
	if (Math.random() < 0.1)
		n *= 10;
	setTimeout(() => {
		if (resp.finished)
			return;
		if (resp.socket && resp.socket.destroyed)
			return resp.end();
		handle_request(req, new Debuff(resp));
	}, n);
}

function timeout(resp) {
	let n = Math.random();
	n = Math.round(9000 + n*n*50000);
	setTimeout(() => {
		if (resp.socket && !resp.socket.destroyed)
			resp.socket.destroy();
		resp.end();
	}, n);
}

function redirect(resp, uri, code) {
	const headers = {Location: uri};
	for (let k in noCacheHeaders)
		headers[k] = noCacheHeaders[k];
	resp.writeHead(code || 303, headers);
	resp.end(`${preamble}
<title>Redirect</title>
<a href="${encodeURI(uri)}" rel="noreferrer noopener">Proceed</a>.`);
}
exports.redirect = redirect;

const redirectJsTmpl = require('fs').readFileSync('tmpl/redirect.html');

function redirect_js(resp, uri) {
	resp.writeHead(200, noCacheHeaders);
	resp.end(`${preamble}
<title>Redirecting...</title>
<script>let dest = "${encodeURI(uri)}";</script>
${redirectJsTmpl}`);
}
exports.redirect_js = redirect_js;

exports.dump_server_error = function (resp, err) {
	resp.writeHead(500, noCacheHeaders);
	resp.write(`${preamble}
<title>Server error</title>
<pre>
${escape(util.inspect(err))}
</pre>
`);
};

function parse_cookie(header) {
	const chunks = {};
	(header || '').split(';').forEach((part) => {
		const bits = part.match(/^([^=]*)=(.*)$/);
		if (bits) {
			try {
				const [_0, k, v] = bits;
				chunks[k.trim()] = decodeURIComponent(v.trim());
			}
			catch (e) {}
		}
	});
	return chunks;
}
exports.parse_cookie = parse_cookie;

exports.prefers_json = function (accept) {
	/* Not technically correct but whatever */
	const mimes = (accept || '').split(',');
	for (let mime of mimes) {
		if (/json/i.test(mime))
			return true;
		else if (/(html|xml|plain|image)/i.test(mime))
			return false;
	}
	return false;
};

function Debuff(stream) {
	Stream.call(this);
	this.out = stream;
	this.buf = [];
	this.timer = 0;
	this.writable = true;
	this.destroyed = false;
	this.closing = false;
	this._flush = this._flush.bind(this);
	this.on_close = this.destroy.bind(this);
	this.on_error = this.on_error.bind(this);
	stream.once('close', this.on_close);
	stream.on('error', this.on_error);
	this.timeout = setTimeout(this.destroy.bind(this), 120*1000);
}
util.inherits(Debuff, Stream);

const D = Debuff.prototype;

D.writeHead = function () {
	if (!this._check())
		return false;
	this.buf.push({_head: [].slice.call(arguments)});
	this._queue();
	return true;
};

D.write = function (data, encoding) {
	if (!this._check())
		return false;
	if (encoding)
		this.buf.push({_enc: encoding, _data: data});
	else
		this.buf.push(data);
	this._queue();
	return true;
};

D.end = function (data, encoding) {
	if (!this._check())
		return;
	if (encoding)
		this.buf.push({_enc: encoding, _data: data});
	else if (data)
		this.buf.push(data);
	this._queue();
	this.closing = true;
	this.cleanEnd = true;
};

D._check = function () {
	if (!this.writable)
		return false;
	if (!this.out.writable) {
		this.destroy();
		return false;
	}
	if (this.out.sock && this.out.sock.destroyed) {
		this.destroy();
		return false;
	}
	return true;
};

D._queue = function () {
	if (this.timer)
		return;
	if (Math.random() < 0.05)
		return;
	let wait = 500 + Math.floor(Math.random() * 5000);
	if (Math.random() < 0.5)
		wait *= 2;
	this.timer = setTimeout(this._flush, wait);
};

D._flush = function () {
	let limit = 500 + Math.floor(Math.random() * 1000);
	if (Math.random() < 0.05)
		limit *= 3;

	let count = 0;
	while (this.out.writable && this.buf.length && count < limit) {
		let o = this.buf.shift();
		if (o._head) {
			this.out.writeHead.apply(this.out, o._head);
			this.statusCode = this.out.statusCode;
			continue;
		}
		let enc;
		if (o._enc && o._data) {
			enc = o.enc;
			o = o._data;
		}
		if (!o.length)
			continue;
		const n = limit - count;
		if (typeof o == 'string' && o.length > n) {
			this.buf.unshift(o.slice(n));
			o = o.slice(0, n);
		}
		count += o.length;
		if (!this.out.write(o, enc))
			break;
	}
	this.timer = 0;
	if (this.out.writable && this.buf.length)
		this._queue();
	else if (this.closing) {
		if (this.cleanEnd) {
			this.out.end();
			this._clean_up();
			this.emit('close');
		}
		else {
			this.destroy();
		}
	}
	else
		this.emit('drain');
};

D.destroy = function () {
	if (this.destroyed)
		return;
	this._clean_up();
	this.cleanEnd = false;
	this.emit('close');
};

D.destroySoon = function () {
	if (!this.timer)
		return this.destroy();
	this.writable = false;
	this.closing = true;
};

D.on_error = function (err) {
	if (!this.destroyed)
		this._clean_up();
	this.cleanEnd = false;
	this.emit('error', err);
};

D._clean_up = function () {
	this.writable = false;
	this.destroyed = true;
	this.closing = false;
	this.out.removeListener('close', this.on_close);
	this.out.removeListener('error', this.on_error);
	if (this.timer) {
		clearTimeout(this.timer);
		this.timer = 0;
	}
	if (this.timeout) {
		clearTimeout(this.timeout);
		this.timeout = 0;
	}
	if (!this.out.finished) {
		this.out.destroy();
	}
};

D.getHeader = function (name) { return this.out.getHeader(name); };
D.setHeader = function (k, v) { this.out.setHeader(k, v); };
D.removeHeader = function (name) { return this.out.removeHeader(name); };
D.addTrailers = function (headers) { this.out.addTrailers(headers); };
