/* YOUTUBE */

var youtube_url_re = /(?:>>>*?)?(?:https?:\/\/)?(?:www\.|m.)?(?:youtube\.com\/watch\/?\?((?:[^\s#&=]+=[^\s#&]*&)*)?v=([\w-]{11})((?:&[^\s#&=]+=[^\s#&]*)*)&?(#t=[\dhms]{1,9})?|(?:|youtu\.be\/)([\w-]{11})(?:\?)?(t=[\dhms]{1,9})?)/;
var youtube_time_re = /^#t=(?:(\d\d?)h)?(?:(\d{1,3})m)?(?:(\d{1,3})s)?$/;

function make_video(id, params, start) {
	if (!params)
		params = {allowFullScreen: 'true'};
	params.allowScriptAccess = 'always';
	//settings of the video
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
	//makes the video
	return $('<iframe></iframe>', {
		type: 'text/html', src: uri,
		frameborder: '0',
		attr: video_dims(),
		"class": 'youtube-player',
	});
}
//dimensions of the video
function video_dims() {
	if (window.screen && screen.width <= 320)
		return {width: 250, height: 150};
	else
		return {width: 560, height: 340};
}
//when link is clicked, open video embed
$(document).on('click', '.watch', function (e) {
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
	//maximum lazy codingww
	else if (m[6]) {
		var t = m[6].match(youtube_time_re);
		if (t) {
			if (t[1])
				start += parseInt(t[1], 10) * 3600;
			if (t[2])
				start += parseInt(t[2], 10) * 60;
			if (t[3])
				start += parseInt(t[3], 10);
		}
	}
	if (m[2])
		var $obj = make_video(m[2], null, start);
	else 
		var $obj = make_video(m[5], null, start);
	with_dom(function () {
		$target.css('width', video_dims().width).append('<br>', $obj);
	});
	return false;
});
//when hovering over the youtube embed, get title data (I think?)
$(document).on('mouseenter', '.watch', function (event) {
	var $target = $(event.target);
	if ($target.data('requestedTitle'))
		return;
	$target.data('requestedTitle', true);
	/* Edit textNode in place so that we don't mess with the embed */
	var node = $target.contents().filter(function () {
		return this.nodeType === 3;
	})[0];
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

function make_embed(uri, params, dims) {
	var $obj = $('<object/>', {attr: dims});
	for (var name in params)
		$('<param/>', {
			attr: {name: name, value: params[name]},
		}).appendTo($obj);
	$('<embed/>', {
		src: uri, type: 'application/x-shockwave-flash',
	}).attr(dims).attr(params).appendTo($obj);
	return $obj;
}

/* SOUNDCLOUD */

var soundcloud_url_re = /(?:>>>*?)?(?:https?:\/\/)?(?:www\.)?soundcloud\.com\/([\w-]{1,40}\/[\w-]{1,80})\/?/;

function make_soundcloud(path, dims) {
	var query = {url: 'http://soundcloud.com/' + path};
	var uri = 'https://player.soundcloud.com/player.swf?' + $.param(query);
	var params = {movie: uri};
	return make_embed(uri, params, dims);
}

$(document).on('click', '.soundcloud', function (e) {
	if (e.which > 1 || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)
		return;
	var $target = $(e.target);

	var $obj = $target.find('object');
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
	var $obj = make_soundcloud(m[1], {width: width, height: 81});
	with_dom(function () {
		$target.css('width', width).append('<br>', $obj);
	});
	return false;
});

/* lol copy pasta */
$(document).on('mouseenter', '.soundcloud', function (event) {
	var $target = $(event.target);
	if ($target.data('requestedTitle'))
		return;
	$target.data('requestedTitle', true);
	/* Edit textNode in place so that we don't mess with the embed */
	var node = $target.contents().filter(function () {
		return this.nodeType === 3;
	})[0];
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
