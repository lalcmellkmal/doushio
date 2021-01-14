let lockTarget, lockKeyHeight;
let $lockTarget, $lockIndicator;
let lockedManually;
let dropAndLockTimer;

let nestLevel = 0;

function with_dom(func) {
	let lockHeight, locked = lockTarget, $post;
	if (locked == PAGE_BOTTOM)
		lockHeight = $DOC.height();
	else if (locked) {
		$post = $('#' + locked);
		const r = $post.length && $post[0].getBoundingClientRect();
		if (r && r.bottom > 0 && r.top < window.innerHeight)
			lockHeight = r.top;
		else
			locked = false;
	}

	let ret;
	try {
		nestLevel++;
		ret = func.call(this);
	}
	finally {
		if (!--nestLevel)
			Backbone.trigger('flushDomUpdates');
	}

	if (locked == PAGE_BOTTOM) {
		const height = $DOC.height();
		if (height > lockHeight - 10)
			window.scrollBy(0, height - lockHeight + 10);
	}
	else if (locked && lockTarget == locked) {
		const newY = $post[0].getBoundingClientRect().top;
		window.scrollBy(0, newY - lockHeight);
	}

	return ret;
}

function set_lock_target(num, manually) {
	lockedManually = manually;

	if (!num && at_bottom())
		num = PAGE_BOTTOM;
	if (num == lockTarget)
		return;
	lockTarget = num;
	const bottom = lockTarget == PAGE_BOTTOM;
	if ($lockTarget)
		$lockTarget.removeClass('scroll-lock');
	if (num && !bottom && manually)
		$lockTarget = $('#' + num).addClass('scroll-lock');
	else
		$lockTarget = null;

	const $ind = $lockIndicator;
	if ($ind) {
		const visibility = (bottom || manually) ? 'visible' : 'hidden';
		$ind.css({ visibility });
		if (bottom)
			$ind.text('Locked to bottom');
		else if (num) {
			$ind.empty().append($('<a/>', {
				text: '>>' + num,
				href: '#' + num,
			}));
		}
	}
}

oneeSama.hook('menuOptions', (info) => {
	const opts = info.options;
	if (lockTarget && info.model && lockTarget == info.model.id)
		opts.splice(opts.indexOf('Focus'), 1, 'Unfocus');
});

Backbone.on('hide', (model) => {
	if (model && model.id == lockTarget)
		set_lock_target(null);
});

connSM.on('dropped', () => {
	if (!dropAndLockTimer)
		dropAndLockTimer = setTimeout(drop_and_lock, 10 * 1000);
});

function drop_and_lock() {
	if (connSM.state == 'synced')
		return;
	// On connection drop, focus the last post.
	// This to prevent jumping to thread bottom on reconnect.
	if (CurThread && !lockedManually) {
		const last = CurThread.get('replies').last();
		if (last)
			set_lock_target(last.id, false);
	}
}

connSM.on('synced', () => {
	// If we dropped earlier, stop focusing now.
	if (!lockedManually)
		set_lock_target(null);
	if (dropAndLockTimer) {
		clearTimeout(dropAndLockTimer);
		dropAndLockTimer = null;
	}
});

let at_bottom = function () {
	return window.scrollY + window.innerHeight >= $DOC.height() - 5;
}
if (window.scrollMaxY !== undefined) {
	at_bottom = function () {
		return window.scrollMaxY <= window.scrollY;
	};
}

(function () {
	menuHandlers.Focus = (model) => {
		const num = model && model.id;
		set_lock_target(num, true);
	};
	menuHandlers.Unfocus = () => {
		set_lock_target(null);
	};

	function scroll_shita() {
		if (!lockTarget || (lockTarget == PAGE_BOTTOM))
			set_lock_target(null);
	}

	if (THREAD) {
		$lockIndicator = $('<span id=lock>Locked to bottom</span>', {
			css: {visibility: 'hidden'},
		}).appendTo('body');
		$DOC.scroll(scroll_shita);
		scroll_shita();
	}
})();
