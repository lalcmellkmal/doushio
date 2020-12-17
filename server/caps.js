const authcommon = require('../admin/common'),
    check = require('./msgcheck').check,
    config = require('../config'),
    curfew = require('../curfew/server'),
    db = require('../db');

const RANGES = require('./state').dbCache.ranges;

function can_access_board(ident, board) {
	if (board == 'graveyard' && can_administrate(ident))
		return true;
	if (board == config.STAFF_BOARD && !can_moderate(ident))
		return false;
	if (ident.ban || ident.suspension)
		return false;
	if (!temporal_access_check(ident, board))
		return false;
	return db.is_board(board);
}
exports.can_access_board = can_access_board;

exports.can_access_thread = function (ident, op) {
	const tags = db.tags_of(op);
	if (!tags)
		return false;
	for (let tag of tags)
		if (can_access_board(ident, tag))
			return tag;
	return false;
};

/// Returns false if the visitor cannot currently access `board` due to curfew.
function temporal_access_check(ident, board) {
	if (can_administrate(ident))
		return true;
	return !curfew.under_curfew(ident, board);
}
exports.temporal_access_check = temporal_access_check;

exports.can_ever_access_board = function (ident, board) {
	if (can_access_board(ident, board))
		return true;
	if (!temporal_access_check(ident, board))
		return true;
	return false;
};

function can_moderate(ident) {
	return (ident.auth === 'Admin' || ident.auth === 'Moderator');
}
exports.can_moderate = can_moderate;

function can_administrate(ident) {
	return ident.auth === 'Admin';
}
exports.can_administrate = can_administrate;

function denote_priv(info) {
	if (info.data.priv)
		info.header.push(' (priv)');
}

function dead_media_paths(paths) {
	paths.src = '../dead/src/';
	paths.thumb = '../dead/thumb/';
	paths.mid = '../dead/mid/';
}

exports.augment_oneesama = function (oneeSama, opts) {
	const { board, ident } = opts;
	oneeSama.ident = ident;
	if (can_moderate(ident))
		oneeSama.hook('headerName', authcommon.append_mnemonic);
	if (can_administrate(ident)) {
		oneeSama.hook('headerName', denote_priv);
		oneeSama.hook('headerName', authcommon.denote_hidden);
	}
	if (can_administrate(ident) && board == 'graveyard')
		oneeSama.hook('mediaPaths', dead_media_paths);
};

exports.mod_handler = function (func) {
	return function (nums, client) {
		if (!can_moderate(client.ident))
			return false;
		const opts = nums.shift();
		if (!check({when: 'string'}, opts) || !check('id...', nums))
			return false;
		const { when } = opts;
		if (!(when in authcommon.delayDurations))
			return false;
		const delay = authcommon.delayDurations[when];
		if (!delay)
			func(nums, client);
		else
			setTimeout(func.bind(null, nums, client), delay*1000);
		// TODO this ought to return a promise...
		return true;
	};
};

function parse_ip(ip) {
	const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/);
	if (!m)
		return false;
	// damn you signed int32s!
	let num = 0;
	for (let i = 4, shift = 1; i > 0; i--) {
		num += parseInt(m[i], 10) * shift;
		shift *= 256;
	}

	const info = {full: ip, num};
	if (m[5]) {
		const bits = parseInt(m[5], 10);
		if (bits > 0 && bits <= 32) {
			info.mask = 0x100000000 - Math.pow(2, 32 - bits);
			info.num &= info.mask;
		}
	}
	return info;
}

function parse_ranges(ranges) {
	if (!ranges)
		return [];
	ranges = ranges.map(o => {
		if (typeof o == 'object') {
			o.ip = parse_ip(o.ip);
			return o;
		}
		else
			return {ip: parse_ip(o)};
	});
	ranges.sort((a, b) => a.ip.num - b.ip.num);
	return ranges;
}

function range_lookup(ranges, num) {
	if (!ranges)
		return null;
	/* Ideally would have a tree lookup here or something */
	let result = null;
	for (let range of ranges) {
		const box = range.ip;
		/* sint32 issue here doesn't matter for realistic ranges */
		if ((box.mask ? (num & box.mask) : num) === box.num)
			result = range;
		/* don't break out of loop */
	}
	return result;
}

exports.reload_suspensions = async (hot) => {
	const r = global.redis;
	await Promise.all(authcommon.suspensionKeys.map(async (key) => {
		let ranges = await r.promise.smembers('hot:' + key);
		if (key == 'suspensions')
			ranges = parse_suspensions(ranges);
		const up = key.toUpperCase();
		hot[up] = (hot[up] || []).concat(ranges || []);
		RANGES[key] = parse_ranges(hot[up]);
	}));
};

function parse_suspensions(suspensions) {
	if (!suspensions)
		return [];
	const parsed = [];
	for (let s of suspensions) {
		try {
			parsed.push(JSON.parse(s));
		}
		catch (e) {
			winston.error("Bad suspension JSON: " + s);
		}
	}
	return parsed;
}

exports.lookup_ident = function (ip, country) {
	const ident = {ip, country, readOnly: config.READ_ONLY};
	if (country
		&& config.RESTRICTED_COUNTRIES
		&& config.RESTRICTED_COUNTRIES.includes(country)) {
		ident.readOnly = true;
	}
	const num = parse_ip(ip).num;
	let ban = range_lookup(RANGES.bans, num);
	if (ban) {
		ident.ban = ban.ip.full;
		return ident;
	}
	ban = range_lookup(RANGES.timeouts, num);
	if (ban) {
		ident.ban = ban.ip.full;
		ident.timeout = true;
		return ident;
	}
	const suspension = range_lookup(RANGES.suspensions, num);
	if (suspension) {
		ident.suspension = suspension;
		return ident;
	}

	const priv = range_lookup(RANGES.boxes, num);
	if (priv)
		ident.priv = priv.ip.full;

	const slow = range_lookup(RANGES.slows, num);
	if (slow)
		ident.slow = slow;

	return ident;
};


