/* Copies old threads to the archive board.
 * Run this in parallel with the main server.
 */

var config = require('../config'),
    db = require('../db'),
    winston = require('winston');

let yaku;
function connect() {
	let r;
	if (!yaku) {
		yaku = new db.Yakusoku('archive', db.UPKEEP_IDENT);
		r = yaku.connect();
		r.on('error', (err) => {
			winston.error(err);
			process.exit(1);
		});
	}
	else
		r = yaku.connect();
	return r;
}

function at_next_minute(func) {
	const now = Date.now();
	const inFive = new Date(now + 5000);

	let nextMinute = inFive.getTime();
	let ms = inFive.getMilliseconds(), s = inFive.getSeconds();
	if (ms > 0) {
		nextMinute += 1000 - ms;
		s++;
	}
	if (s > 0 && s < 60)
		nextMinute += (60 - s) * 1000;
	const delay = nextMinute - now;

	return setTimeout(func, delay);
}

const CLEANING_LIMIT = 10; // per minute

async function clean_up() {
	try {
		const r = connect();
		const expiryKey = db.expiry_queue_key();
		const now = Math.floor(Date.now() / 1000);
		const expired = await r.promise.zrangebyscore(expiryKey, 1, now, 'limit', 0, CLEANING_LIMIT);
		for (let entry of expired) {
			const m = entry.match(/^(\d+):/);
			if (!m)
				continue;
			const op = parseInt(m[1], 10);
			if (!op)
				continue;
			await yaku.archive_thread(op);
			const n = await r.promise.zrem(expiryKey, entry);
			if (n == 1)
				winston.info(`Archived thread >>${op}`);
			else
				winston.error(`>>${op} not archived?!`);
		}
	}
	catch (err) {
		winston.error(err);
	}
	finally {
		at_next_minute(clean_up);
	}
}

if (require.main === module) process.nextTick(async () => {
	connect();
	const { argv } = process;
	// you may pass one thread op to archive that thread specifically
	if (argv.length == 3) {
		const op = parseInt(argv[2], 10);
		if (op) {
			try {
				await yaku.archive_thread(op);
				process.exit(0);
			}
			catch (err) {
				winston.error(err);
				process.exit(1);
			}
		}
		else {
			winston.error("Usage: node archive/daemon.js <thread number>");
			process.exit(1);
		}
	}
	else {
		at_next_minute(clean_up);
	}
});
