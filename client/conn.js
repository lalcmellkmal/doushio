(function () {

const PING_INTERVAL = 25 * 1000;

let socket, attempts, attemptTimer, pingTimer;

window.send = function (msg) {
	// need deferral or reporting on these lost messages...
	if (connSM.state != 'synced' && connSM.state != 'syncing')
		return;
	if (socket.readyState != WebSocket.OPEN) {
		if (console)
			console.warn("Attempting to send while socket closed");
		return;
	}

	msg = JSON.stringify(msg);
	if (config.DEBUG)
		console.log('<', msg);
	socket.send(msg);
};

const pong = `[[0,${PING}]]`;

function on_message(e) {
	if (e == pong)
		return;
	if (config.DEBUG)
		console.log('>', e.data);
	const msgs = JSON.parse(e.data);

	with_dom(() => {
		for (let msg of msgs) {
			const op = msg.shift();
			const type = msg.shift();
			if (is_pubsub(type) && op in syncs)
				syncs[op]++;
			dispatcher[type](msg, op);
		}
	});
}

function sync_status(msg, hover) {
	$('#sync').text(msg).attr('class', hover ? 'error' : '');
}

connSM.act('load + start -> conn', () => {
	sync_status('Connecting...', false);
	attempts = 0;
	connect();
});

function connect() {
	if (socket) {
		socket.onclose = null;
		socket.onmessage = null;
	}
	if (window.location.protocol == 'file:') {
		console.log("Page downloaded locally; refusing to sync.");
		return;
	}
	socket = window.new_socket(attempts);
	socket.onopen = connSM.feeder('open');
	socket.onclose = connSM.feeder('close');
	socket.onmessage = on_message;
	if (config.DEBUG)
		window.socket = socket;
}

window.new_socket = () => {
	let url = config.SOCKET_PATH;
	if (typeof ctoken != 'undefined') {
		url += '?' + $.param({ctoken});
	}
	if (url.startsWith('/')) {
		url = new URL(url, window.location);
		if (url.protocol == 'https:')
			url.protocol = 'wss:';
		if (url.protocol == 'http:')
			url.protocol = 'ws:';
	}
	return new WebSocket(url);
};

connSM.act('conn, reconn + open -> syncing', () => {
	sync_status('Syncing...', false);
	CONN_ID = random_id();
	send([SYNCHRONIZE, CONN_ID, BOARD, syncs, BUMP, document.cookie]);
	if (pingTimer)
		clearInterval(pingTimer);
	pingTimer = setInterval(ping, PING_INTERVAL);
});

connSM.act('syncing + sync -> synced', () => {
	sync_status('Synced.', false);
	attemptTimer = setTimeout(() => {
		attemptTimer = 0;
		reset_attempts();
	}, 10000);
});

function reset_attempts() {
	if (attemptTimer) {
		clearTimeout(attemptTimer);
		attemptTimer = 0;
	}
	attempts = 0;
}

connSM.act('* + close -> dropped', (e) => {
	if (socket) {
		socket.onclose = null;
		socket.onmessage = null;
	}
	if (config.DEBUG)
		console.error('E:', e);
	if (attemptTimer) {
		clearTimeout(attemptTimer);
		attemptTimer = 0;
	}
	if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = 0;
	}
	sync_status('Dropped.', true);

	attempts++;
	const n = Math.min(Math.floor(attempts/2), 12);
	const wait = 500 * Math.pow(1.5, n);
	// wait maxes out at ~1min
	setTimeout(connSM.feeder('retry'), wait);
});

connSM.act('dropped + retry -> reconn', () => {
	connect();
	/* Don't show this immediately so we don't thrash on network loss */
	setTimeout(() => {
		if (connSM.state == 'reconn')
			sync_status('Reconnecting...', true);
	}, 100);
});

connSM.act('* + invalid, desynced + close -> desynced', (msg) => {
	msg = (msg && msg[0]) ? `Out of sync: ${msg[0]}` : 'Out of sync.';
	sync_status(msg, true);
	if (attemptTimer) {
		clearTimeout(attemptTimer);
		attemptTimer = 0;
	}
	socket.onclose = null;
	socket.onmessage = null;
	socket.close();
	socket = null;
	if (config.DEBUG)
		window.socket = null;
});

function window_focused() {
	const s = connSM.state;
	if (s == 'desynced')
		return;
	// might have just been suspended;
	// try to get our SM up to date if possible
	if (s == 'synced' || s == 'syncing' || s == 'conn') {
		const rs = socket.readyState;
		if (rs != WebSocket.OPEN && rs != WebSocket.CONNECTING) {
			connSM.feed('close');
			return;
		}
		else if (!config.DEBUG && navigator.onLine === false) {
			connSM.feed('close');
			return;
		}
		ping();
	}
	connSM.feed('retry');
}

function ping() {
	if (socket.readyState == WebSocket.OPEN)
		socket.send(`[${PING}]`);
	else if (pingTimer) {
		clearInterval(pingTimer);
		pingTimer = 0;
	}
}

(function () {
	_.defer(connSM.feeder('start'));
	$(window).focus(() => {
		setTimeout(window_focused, 20);
	});
	window.addEventListener('online', () => {
		reset_attempts();
		connSM.feed('retry');
	});
	window.addEventListener('offline', connSM.feeder('close'));
})();

})();
