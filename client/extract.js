// remember which posts are mine for two days
var Mine = new Kioku('mine', 2);
// no cookie though
Mine.bake_cookie = () => false;
$.cookie('mine', null); // TEMP

(function () {

var mine = Mine.read_all();

function extract_post_model(el) {
	/* incomplete */
	var info = {num: parseInt(el.id, 10)};
	var $article = $(el);
	/* TODO: do these all in one pass */
	var $header = $article.children('header');
	var $b = $header.find('b');
	if ($b.length)
		info.name = $b.text();
	var $code = $header.find('code');
	if ($code.length)
		info.trip = $code.text();
	var $time = $header.find('time');
	if ($time.length)
		info.time = new Date($time.attr('datetime')).getTime();

	var $fig = $article.children('figure');
	if ($fig.length) {
		var $cap = $fig.children('figcaption');
		var image = {
			MD5: $fig.data('md5'),
			size: $fig.data('size'),
			src: $cap.children('a').text(),
		};

		var $i = $cap.children('i');
		var t = $i.length && $i[0].childNodes[0];
		t = t && t.data;
		var m = /(\d+)x(\d+)/.exec(t);
		if (m)
			image.dims = [parseInt(m[1], 10), parseInt(m[2], 10)];
		if (t && t.indexOf(audioIndicator) == 1)
			image.audio = true;
		var $nm = $i.find('a');
		image.imgnm = $nm.attr('title') || $nm.text() || '';

		var $img = $fig.find('img');
		image.thumb = $img.attr('src');
		if (image.dims && $img.length) {
			image.dims.push($img.width(), $img.height());
		}

		info.image = image;
	}
	info.body = ''; // TODO
	if (mine[info.num])
		info.mine = true;
	return new Post(info);
}

function extract_thread_model(section) {
	var replies = [];
	for (var i = 0; i < section.childElementCount; i++) {
		var el = section.children[i];
		if (el.tagName != 'ARTICLE')
			continue;
		var post = extract_post_model(el);
		new Article({model: post, el: el});
		replies.push(post);
	}
	var thread = new Thread({
		num: parseInt(section.id, 10),
		replies: new Replies(replies),
	});
	if (mine[thread.num])
		thread.set('mine', true);
	return thread;
}

function scan_threads_for_extraction() {
	var bod = document.body;
	var threads = [];
	for (var i = 0; i < bod.childElementCount; i++) {
		var el = bod.children[i];
		if (el.tagName != 'SECTION')
			continue;
		var thread = extract_thread_model(el);
		new Section({model: thread, el: el});
		threads.push(thread);
	}
	Threads.add(threads);

	if (THREAD)
		CurThread = Threads.get(THREAD);
}

scan_threads_for_extraction();
Mine.purge_expired_soon();

})();
