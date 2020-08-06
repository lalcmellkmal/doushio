var _ = require('../lib/underscore'),
    config = require('../config'),
    db = require('../db'),
    web = require('../server/web'),
    winston = require('winston');

var RES = require('../server/state').resources;

exports.divert_response = function (board, resp) {
	resp.writeHead(200, web.noCacheHeaders);
	resp.write(RES.curfewTmpl[0]);
	resp.write('/' + board + '/');
	resp.write(RES.curfewTmpl[1]);
	const ending = curfew_ending_time(board);
	resp.write(ending ? ''+ending.getTime() : 'null');
	resp.end(RES.curfewTmpl[2]);
};

// note that admins should always be able to see a curfew board (not checked in here tho)
function under_curfew(ident, board) {
	const curfew = config.CURFEW_HOURS;
	const boards = config.CURFEW_BOARDS || [];
	if (!curfew || !boards.includes(board))
		return false;
	const hour = new Date().getUTCHours();
	return curfew.indexOf(hour) < 0;
}
exports.under_curfew = under_curfew;

function curfew_ending_time(board) {
	const curfew = config.CURFEW_HOURS;
	if (!curfew || !(config.CURFEW_BOARDS || []).includes(board))
		return null;
	const now = new Date();
	const tomorrow = day_after(now);
	const makeToday = hour_date_maker(now);
	const makeTomorrow = hour_date_maker(tomorrow);
	/* Dumb brute-force algorithm */
	const candidates = [];
	for (let hour of config.CURFEW_HOURS) {
		candidates.push(makeToday(hour), makeTomorrow(hour));
	}
	candidates.sort(compare_dates);
	for (let candidate of candidates) {
		if (candidate > now)
			return candidate;
	}
	return null;
}

function curfew_starting_time(board) {
	const curfew = config.CURFEW_HOURS;
	if (!curfew || !(config.CURFEW_BOARDS || []).includes(board))
		return null;
	const now = new Date();
	const tomorrow = day_after(now);
	const makeToday = hour_date_maker(now);
	const makeTomorrow = hour_date_maker(tomorrow);
	/* Even dumber brute-force algorithm */
	const candidates = [];
	for (let hour of config.CURFEW_HOURS) {
		hour = (hour + 1) % 24;
		if (!config.CURFEW_HOURS.includes(hour))
			candidates.push(makeToday(hour), makeTomorrow(hour));
	}
	candidates.sort(compare_dates);
	for (let candidate of candidates) {
		if (candidate > now)
			return candidate;
	}
	return null;
};

function compare_dates(a, b) {
	return a.getTime() - b.getTime();
}

function day_after(today) {
	/* Leap shenanigans? This is probably broken somehow. Yay dates. */
	let tomorrow = new Date(today.getTime() + 24*3600*1000);
	if (tomorrow.getUTCDate() == today.getUTCDate())
		tomorrow = new Date(tomorrow.getTime() + 12*3600*1000);
	return tomorrow;
}

function hour_date_maker(date) {
	const prefix = date.getUTCFullYear() + '/' + (date.getUTCMonth()+1)
			+ '/' + date.getUTCDate() + ' ';
	return hour => new Date(prefix + hour + ':00:00 GMT');
}

/* DAEMON */

function shutdown(board, cb) {
	var yaku = new db.Yakusoku(board, db.UPKEEP_IDENT);
	yaku.teardown(board, function (err) {
		yaku.disconnect();
		cb(err);
	});
}

function at_next_curfew_start(board, func) {
	var when = curfew_starting_time(board);
	winston.info('Next curfew for ' + board + ' at ' + when.toUTCString());
	setTimeout(func, when.getTime() - Date.now());
}

function enforce(board) {
	at_next_curfew_start(board, function () {
		winston.info('Curfew ' + board + ' at ' +
				new Date().toUTCString());
		shutdown(board, function (err) {
			if (err)
				winston.error(err);
		});
		setTimeout(enforce.bind(null, board), 30 * 1000);
	});
}

if (config.CURFEW_BOARDS && config.CURFEW_HOURS)
	config.CURFEW_BOARDS.forEach(enforce);
