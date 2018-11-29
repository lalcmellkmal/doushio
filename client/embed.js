/* YOUTUBE */

// fairly liberal regexp that will accept things like
// https://m.youtube.com/watch/?v=abcdefghijk&t=2m
// youtube.com/watch/?foo=bar&v=abcdefghijk#t=5h2s
// >>>youtu.be/abcdefghijk
var youtube_url_re = /(?:>>>*?)?(?:https?:\/\/)?(?:www\.|m.)?(?:youtu\.be\/|youtube\.com\/watch\/?\?((?:[^\s#&=]+=[^\s#&]*&)*)?v=)([\w-]{11})((?:&[^\s#&=]+=[^\s#&]*)*)&?([#\?]t=[\dhms]{1,9})?/;
var youtube_time_re = /^[#\?]t=(?:(\d\d?)h)?(?:(\d{1,3})m)?(?:(\d{1,3})s)?$/;

(function () {

function make_video(id, params, start) {
	if (!params)
		params = {allowFullScreen: 'true'};
	params.allowScriptAccess = 'always';
	var query = {
		autohide: 1,
		fs: 1,
		modestbranding: 1,
		origin: document.location.origin,
		rel: 0,
		showinfo: 0,
	};
	if (start)
		query.start = start;
	if (params.autoplay)
		query.autoplay = params.autoplay;
	if (params.loop) {
		query.loop = '1';
		query.playlist = id;
	}

	var uri = encodeURI('https://www.youtube.com/embed/' + id) + '?' +
			$.param(query);
	return $('<iframe></iframe>', {
		type: 'text/html', src: uri,
		frameborder: '0',
		attr: video_dims(),
		"class": 'youtube-player',
	});
}
window.make_video = make_video;

function video_dims() {
	if (window.screen && screen.width <= 320)
		return {width: 250, height: 150};
	else
		return {width: 560, height: 340};
}

$DOC.on('click', '.watch', function (e) {
	if (e.which > 1 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
		return;
	var $target = $(e.target);

	/* maybe squash that double-play bug? ugh, really */
	if (!$target.is('a'))
		return;

	var $video = $target.find('iframe');
	if ($video.length) {
		$video.siblings('br').andSelf().remove();
		$target.css('width', 'auto');
		return false;
	}
	if ($target.data('noembed'))
		return;
	var m = $target.attr('href').match(youtube_url_re);
	if (!m) {
		/* Shouldn't happen, but degrade to normal click action */
		return;
	}
	var start = 0;
	if (m[4]) {
		var t = m[4].match(youtube_time_re);
		if (t) {
			if (t[1])
				start += parseInt(t[1], 10) * 3600;
			if (t[2])
				start += parseInt(t[2], 10) * 60;
			if (t[3])
				start += parseInt(t[3], 10);
		}
	}

	var $obj = make_video(m[2], null, start);
	with_dom(function () {
		$target.css('width', video_dims().width).append('<br>', $obj);
	});
	return false;
});

$DOC.on('mouseenter', '.watch', function (event) {
	var $target = $(event.target);
	if ($target.data('requestedTitle'))
		return;
	$target.data('requestedTitle', true);
	/* Edit textNode in place so that we don't mess with the embed */
	var node = text_child($target);
	if (!node)
		return;
	var orig = node.textContent;
	with_dom(function () {
		node.textContent = orig + '...';
	});
	var m = $target.attr('href').match(youtube_url_re);
	if (!m)
		return;

	$.ajax({
		url: 'https://www.googleapis.com/youtube/v3/videos',
		data: {id: m[2],
		       key: config.GOOGLE_API_KEY,
		       part: 'snippet,status',
		       fields: 'items(snippet(title),status(embeddable))'},
		dataType: 'json',
		success: function (data) {
			with_dom(gotInfo.bind(null, data));
		},
		error: function () {
			with_dom(function () {
				node.textContent = orig + '???';
			});
		},
	});

	function gotInfo(data) {
		var title = data && data.items && data.items[0].snippet &&
				data.items[0].snippet.title;
		if (title) {
			node.textContent = orig + ': ' + title;
			$target.css({color: 'black'});
		}
		else
			node.textContent = orig + ' (gone?)';

		if (data && data.items && data.items[0].status &&
			data.items[0].status.embeddable == false) {
			node.textContent += ' (EMBEDDING DISABLED)';
			$target.data('noembed', true);
		}
	}
});

function text_child($target) {
	return $target.contents().filter(function () {
		return this.nodeType === 3;
	})[0];
}

/* SOUNDCLOUD */

window.soundcloud_url_re = /(?:>>>*?)?(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/([\w-]{1,40}\/[\w-]{1,80})\/?/;

function make_soundcloud(path, dims) {
	var query = {
		url: 'http://soundcloud.com/' + path,
		color: 'ffaa66',
		auto_play: false,
		show_user: false,
		show_comments: false,
	};
	var uri = 'https://w.soundcloud.com/player/?' + $.param(query);
	return $('<iframe></iframe>', {
		src: uri, width: dims.width, height: dims.height,
		scrolling: 'no', frameborder: 'no',
	});
}

$DOC.on('click', '.soundcloud', function (e) {
	if (e.which > 1 || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)
		return;
	var $target = $(e.target);

	var $obj = $target.find('iframe');
	if ($obj.length) {
		$obj.siblings('br').andSelf().remove();
		$target.css('width', 'auto');
		return false;
	}
	var m = $target.attr('href').match(soundcloud_url_re);
	if (!m) {
		/* Shouldn't happen, but degrade to normal click action */
		return;
	}
	var width = Math.round($(window).innerWidth() * 0.75);
	var $obj = make_soundcloud(m[1], {width: width, height: 166});
	with_dom(function () {
		$target.css('width', width).append('<br>', $obj);
	});
	return false;
});

/* lol copy pasta */
$DOC.on('mouseenter', '.soundcloud', function (event) {
	var $target = $(event.target);
	if ($target.data('requestedTitle'))
		return;
	$target.data('requestedTitle', true);
	/* Edit textNode in place so that we don't mess with the embed */
	var node = text_child($target);
	if (!node)
		return;
	var orig = node.textContent;
	with_dom(function () {
		node.textContent = orig + '...';
	});
	var m = $target.attr('href').match(soundcloud_url_re);
	if (!m)
		return;

	$.ajax({
		url: '//soundcloud.com/oembed',
		data: {format: 'json', url: 'http://soundcloud.com/' + m[1]},
		dataType: 'json',
		success: function (data) {
			with_dom(gotInfo.bind(null, data));
		},
		error: function () {
			with_dom(function () {
				node.textContent = orig + '???';
			});
		},
	});

	function gotInfo(data) {
		var title = data && data.title;
		if (title) {
			node.textContent = orig + ': ' + title;
			$target.css({color: 'black'});
		}
		else
			node.textContent = orig + ' (gone?)';
	}
});

/* TWITTER */

window.twitter_url_re = /(?:>>>*?)?(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?twitter\.com\/(\w{1,15})\/status\/(\d{4,20})\/?(?:\?s=\d+)?/;

$DOC.on('click', '.tweet', function (e) {
	if (e.which > 1 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
		return;
	var $target = $(e.target);
	if (!$target.is('a.tweet') || $target.data('tweet') == 'error')
		return;
	setup_tweet($target);

	var $tweet = $target.find('.twitter-tweet');
	if ($tweet.length) {
		$tweet.siblings('br').andSelf().remove();
		$target.css('width', 'auto');
		text_child($target).textContent = $target.data('tweet-expanded');
		return false;
	}
	fetch_tweet($target, function (err, info) {
		var orig = $target.data('tweet-ref');
		if (err) {
			$target.data('tweet', 'error');
			if (info && info.node) {
				with_dom(function () {
					info.node.textContent = orig + ' (error: ' + err + ')';
				});
			}
			return;
		}
		$target.data('tweet', info.tweet);
		var w = 500;
		if (window.screen && screen.width && screen.width < w)
			w = screen.width - 20;

		var $tweet = $($.parseHTML(info.tweet.html)[0]);
		with_tweet_widget(function () {
			$target.append('<br>', $tweet);
			$target.css('width', w);
			info.node.textContent = orig;
		});
	});
	return false;
});

$DOC.on('mouseenter', '.tweet', function (event) {
	var $target = $(event.target);
	if (!$target.is('a.tweet') || $target.data('tweet'))
		return;
	setup_tweet($target);

	fetch_tweet($target, function (err, info) {
		if (err) {
			if (info && info.node) {
				$target.data('tweet', 'error');
				with_dom(function () {
					info.node.textContent += ' (error: ' + err + ')';
				});
			}
			else
				console.warn(err);
			return;
		}

		var node = info.node;
		var orig = $target.data('tweet-ref') || node.textContent;
		var html = info.tweet && info.tweet.html;
		if (!html) {
			$target.data('tweet', 'error');
			node.textContent = orig + ' (broken?)';
			return;
		}
		$target.data('tweet', info.tweet);
		// twitter sends us HTML of the tweet; scrape it a little
		var $tweet = $($.parseHTML(html)[0]);
		var $p = $tweet.find('p');
		if ($p.length) {
			// chop the long ID number off our ref
			var prefix = orig;
			var m = /^(.+)\/\d{4,20}(?:s=\d+)?$/.exec(prefix);
			if (m)
				prefix = m[1];

			var text = scrape_tweet_p($p);
			with_dom(function () {
				var expanded = prefix + ' \u00b7 ' + text;
				$target.data('tweet-expanded', expanded);
				node.textContent = expanded;
				$target.css({color: 'black'});
			});
		}
		else {
			with_dom(function () {
				node.textContent = orig + ' (could not scrape)';
			});
		}
	});
});

/// call this before fetch_tweet or any DOM modification of the ref
function setup_tweet($target) {
	setup_tweet_widgets_script();
	if ($target.data('tweet-ref'))
		return;
	var node = text_child($target);
	if (!node)
		return;
	$target.data('tweet-ref', node.textContent);
}

/// fetch & cache the json about the tweet referred to by >>>/@ref $target
function fetch_tweet($target, cb) {
	var node = text_child($target);
	if (!node)
		return cb("ref's text node not found");

	var cached = $target.data('tweet');
	if (cached == 'error')
		return cb('could not contact twitter', {node: node});
	if (cached && cached.inflight) {
		var queue = TW_CB[cached.inflight];
		if (queue)
			queue.callbacks.push(cb);
		else
			cb('gone', {node: node});
		return;
	}
	if (cached)
		return cb(null, {tweet: cached, node: node});

	var tweet_url = $target.attr('href');
	var m = tweet_url.match(twitter_url_re);
	if (!m)
		return cb('invalid tweet ref', {node: node});
	var handle = m[1];
	var id = m[2];

	// if this request is already in-flight, just wait on the result
	var flight = TW_CB[id];
	if (flight) {
		flight.node = node;
		flight.callbacks.push(cb);
		return;
	}

	// chop the prefix off the url and add our own
	var chop = tweet_url.indexOf(handle);
	if (chop < 0)
		return;
	var our_url = '../outbound/tweet/' + tweet_url.substr(chop);

	// we're ready, make the call
	TW_CB[id] = {node: node, callbacks: [cb]};
	$target.data('tweet', {inflight: id});

	var theme = 'light'; // TODO tie into current theme
	$.ajax({
		url: our_url,
		data: {theme: theme},
		dataType: 'json',
		success: function (json) {
			got_tweet(json, id);
		},
		error: function (xhr, stat, error) {
			failed_tweet(error, id);
		},
	});

	var orig = $target.data('tweet-ref') || node.textContent;
	with_dom(function () {
		node.textContent = orig + '...';
	});
}

function scrape_tweet_p($p) {
	var bits = $p.contents();
	var text = "";
	var i;
	for (i = 0; i < bits.length; i++) {
		var node = bits[i];
		if (node.nodeType == 3)
			text += node.textContent;
		else if (node.nodeType == 1) {
			if (node.tagName == 'A')
				text += node.textContent;
			else
				break;
		}
		else
			break;
	}
	if (i < bits.length)
		text += ' \u2026';
	if (!text)
		text = $p.text();
	return text;
}

var TW_CB = {};

function failed_tweet(err, id) {
	var req = TW_CB[id];
	if (!req)
		return;
	delete TW_CB[id];
	var node = req.node;
	if (node) {
		req.node = null;
		var payload = {node: node};
		while (req.callbacks.length)
			req.callbacks.shift()(err || 'offline?', payload);
	}
	req.callbacks = [];
}

function got_tweet(tweet, id) {
	var saved = TW_CB[id];
	if (!saved) {
		console.warn('tweet callback for non-pending tweet', tweet);
		return;
	}
	delete TW_CB[id];

	var payload = {node: saved.node, tweet: tweet};
	saved.node = null;
	while (saved.callbacks.length)
		saved.callbacks.shift()(null, payload);
}

var TW_WG_SCRIPT;

function setup_tweet_widgets_script() {
	TW_WG_SCRIPT = $.getScript('https://platform.twitter.com/widgets.js').done(function () {
		TW_WG_SCRIPT = {done: twttr.ready};
		twttr.ready(function () {
			TW_WG_SCRIPT = true;
		});
	});
	setup_tweet_widgets_script = function () {};
}

/// when creating a tweet widget, wrap the DOM insertion with this
function with_tweet_widget(func) {
	function go() {
		func();
		if (window.twttr)
			twttr.widgets.load();
	}
	if (TW_WG_SCRIPT && TW_WG_SCRIPT.done) {
		TW_WG_SCRIPT.done(function () {
			with_dom(go);
		});
	}
	else
		with_dom(go);
}

})();
