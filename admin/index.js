var authcommon = require('./common'),
    caps = require('../server/caps'),
    common= require('../common'),
    okyaku = require('../server/okyaku'),
    STATE = require('../server/state');

require('./panel');

function connect() {
	return global.redis;
}

function ban(m, mod, ip, type) {
	if (type == 'timeout'){
		m.sadd('hot:' + type + 's', ip);
		m.hset('ip:' + ip, 'ban', type);
	} else if (type == 'unban'){
		m.srem('hot:timeouts', ip);
		m.del('ip:' + ip);
	}
	var now = Date.now();
	var info = {ip: ip, type: type, time: now};
	if (mod.ident.email)
		info.email = mod.ident.email;
	m.rpush('auditLog', JSON.stringify(info));

	// trigger reload
	m.publish('reloadHot', 'caps');
}

okyaku.dispatcher[authcommon.BAN] = function (msg, client) {
	if (!caps.can_administrate(client.ident))
		return false;
	var ip = msg[0];
	var type = msg[1];
	if (!authcommon.is_valid_ip(ip))
		return false;

	var m = connect().multi();
	ban(m, client, ip, type);
	m.exec(function (err) {
		if (err)
			return client.kotowaru(err);

		/* XXX not DRY */
		var ADDRS = authcommon.modCache.addresses;
		if (ADDRS[ip])
			ADDRS[ip].ban = (type == 'timeout');

		var a = {ban: (type == 'timeout')};
		client.send([0, common.MODEL_SET, ['addrs', ip], a]);
	});
	return true;
};
