const config = require('../config'),
    minimist = require('minimist'),
    path = require('path');

function usage() {
	process.stderr.write(
`Usage: node server/server.js
       --host <host> --port <port>
       --pid <pid file location>

<port> can also be a unix domain socket path.
`);
	process.exit(1);
}

exports.parse_args = function () {
	const argv = minimist(process.argv.slice(2));

	if ('h' in argv || 'help' in argv)
		return usage();

	// WTF MUTATING `config` ARE YOU SERIOUS, PAST ME?
	if (argv.port)
		config.LISTEN_PORT = argv.port;
	if (argv.host)
		config.LISTEN_HOST = argv.host;
	if (argv.pid)
		config.PID_FILE = argv.pid;
};

exports.load_defaults = function () {
	if (!config.PID_FILE)
		config.PID_FILE = path.join(__dirname, '.server.pid');
};
