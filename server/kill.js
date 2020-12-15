#!/usr/bin/env node
const config = require('../config'),
    opts = require('./opts'),
    path = require('path');

opts.parse_args();
opts.load_defaults();
const lock = config.PID_FILE;

const cfg = config.DAEMON;
if (cfg) {
	require('daemon').kill(lock, (err) => {
		if (err)
			throw err;
	});
}
else {
	/* non-daemon version for hot reloads */
	require('fs').readFile(lock, (err, pid) => {
		pid = parseInt(pid, 10);
		if (err || !pid)
			return console.error(`Invalid pid in: ${lock}`);
		require('child_process').exec(`kill -HUP ${pid}`, (err) => {
			if (err) throw err;
			if (process.argv.indexOf('--silent') < 2)
				console.log('Sent HUP.');
		});
	});
}
