var saku, postForm;
var nonces = {};

connSM.on('synced', postSM.feeder('sync'));
connSM.on('dropped', postSM.feeder('desync'));
connSM.on('desynced', postSM.feeder('desync'));

postSM.act('* + desync -> none', function () {
	if (postForm) {
		postForm.$el.removeClass('editing');
		postForm.input.val('');
		postForm.finish();
	}
	$('aside').remove();
});

postSM.act('none + sync, draft, alloc + done -> ready', function () {
	if (postForm) {
		postForm.remove();
		postForm = null;
		saku = null;
	}
	insert_pbs();

	var m = window.location.hash.match(/^#q(\d+)$/);
	if (m) {
		var id = parseInt(m[1], 10);
		if ($('#' + id).hasClass('highlight')) {
			window.location.hash = '#' + id;
			open_post_box(id);
			postForm.add_ref(id);
		}
	}
});

postSM.act('ready + new -> draft', function (aside) {
	var op = null;
	var $sec = aside.closest('section');
	if ($sec.length) {
		op = extract_num($sec);
	}
	else {
		$sec = $('<section/>');
	}
	saku = new Saku({op: op});
	postForm = new ComposerView({model: saku, dest: aside, thread: $sec});
});

postSM.preflight('draft', function (aside) {
	return aside.is('aside');
});

postSM.act('draft + alloc -> alloc', function (msg) {
	postForm.on_allocation(msg);
});

$DOC.on('click', 'aside a', _.wrap(function () {
	postSM.feed('new', $(this).parent());
}, with_dom));

function open_post_box(num) {
	var a = $('#' + num);
	postSM.feed('new', a.is('section')
			? a.children('aside') : a.siblings('aside'));
}

function make_reply_box() {
	return $('<aside class="act"><a>Reply</a></aside>');
}

function insert_pbs() {
	if (readOnly.indexOf(BOARD) >= 0)
		return;
	if (THREAD ? $('aside').length : $ceiling.next().is('aside'))
		return;
  make_reply_box().appendTo('section');
	if (!nashi.upload && (BUMP || PAGE == 0))
		$ceiling.after('<aside class="act"><a>New thread</a></aside>');
}

var Saku = Backbone.Model.extend({

idAttribute: 'num',

initialize: function () {
},

});

var ComposerView = Backbone.View.extend({

events: {
	'input #subject': model_link('subject'),
	'keydown #trans': 'on_key_down',
	'click #done': 'finish_wrapped',
},

initialize: function (dest) {

	this.model.on('change', this.render_buttons, this);

	var attrs = this.model.attributes;
	var op = attrs.op;
	var post = op ? $('<article/>') : this.options.thread;
	this.setElement(post[0]);

	this.buffer = $('<p/>');
	this.line_buffer = $('<p/>');
	this.meta = $('<header><a class="nope"><b/></a> <time/></header>');
	this.input = $('<textarea name="body" id="trans" rows="1" '
			+ 'class="themed" />');
	this.submit = $('<input type="button" id="done" value="Done"/>');
	this.$subject = $('<input/>', {
		id: 'subject',
		'class': 'themed',
		maxlength: config.SUBJECT_MAX_LENGTH,
		width: '80%',
	});
	this.blockquote = $('<blockquote/>');
	this.$sizer = $('<pre/>').appendTo('body');
	this.pending = '';
	this.line_count = 1;
	this.char_count = 0;
	this.imouto = new OneeSama(function (num) {
		var $s = $('#' + num);
		if (!$s.is('section'))
			$s = $s.closest('section');
		if ($s.is('section'))
			this.callback(this.post_ref(num, extract_num($s)));
		else
			this.callback(safe('<a class="nope">&gt;&gt;' + num
					+ '</a>'));
	});
	this.imouto.callback = inject;
	this.imouto.op = THREAD;
	this.imouto.state = [S_BOL, 0];
	this.imouto.buffer = this.buffer;
	this.imouto.hook('spoilerTag', touchable_spoiler_tag);
	oneeSama.trigger('imouto', this.imouto);

	shift_replies(this.options.thread);
	this.blockquote.append(this.buffer, this.line_buffer, this.input);
	post.append(this.meta, this.blockquote);
	if (!op) {
		post.append('<label for="subject">Subject: </label>',
				this.$subject);
		this.blockquote.hide();
	}
	this.uploadForm = this.make_upload_form();
	post.append(this.uploadForm);
	oneeSama.trigger('draft', post);

	this.propagate_ident();
	this.options.dest.replaceWith(post);

	//this.input.keydown($.proxy(this, 'on_key_down'));
	this.input.input(_.bind(this.on_input, this, undefined));

	if (op) {
		this.resize_input();
		this.input.focus();
	}
	else {
		post.after('<hr/>');
		this.$subject.focus();
	}
	$('aside').remove();
},

propagate_ident: function () {
	if (this.model.get('num'))
		return;
	var parsed = parse_name($name.val().trim());
	var meta = this.meta;
	var $b = meta.find('b');
	$b.text(parsed[0] || ANON);
	if (parsed[1] || parsed[2])
		$b.append(' <code>!?</code>');
	var email = $email.val().trim();
	if (is_noko(email))
		email = '';
	var tag = meta.children('a:first');
	if (email)
		tag.attr('href', 'mailto:' + email).attr('class', 'email');
	else
		tag.removeAttr('href').attr('class', 'nope');
},

on_allocation: function (msg) {
	var num = msg.num;
	ownPosts[num] = true;
	this.model.set({num: num});
	this.flush_pending();
	var header = $(flatten(oneeSama.atama(msg)).join(''));
	this.meta.replaceWith(header);
	this.meta = header;
	var op = this.model.get('op');
	if (op)
		this.$el.addClass('editing');
	else
		spill_page();
	oneeSama.trigger('afterInsert', this.$el);
	this.$el.attr('id', num);

	if (msg.image)
		this.insert_uploaded(msg.image);

	if (this.uploadForm)
		this.uploadForm.append(this.submit);
	else
		this.blockquote.after(this.submit);
	if (!op) {
		this.$subject.siblings('label').andSelf().remove();
		this.blockquote.show();
		this.resize_input();
		this.input.focus();
	}
},

on_image_alloc: function (msg) {
	var attrs = this.model.attributes;
	if (attrs.cancelled)
		return;
	if (!attrs.num && !attrs.sentAllocRequest) {
		send([INSERT_POST, this.make_alloc_request(null, msg)]);
		this.model.set({sentAllocRequest: true});
	}
	else {
		send([INSERT_IMAGE, msg]);
	}
},

entry_scroll_lock: function () {
	/* NOPE */
	if (lockTarget == PAGE_BOTTOM) {
		/* Special keyup<->down case */
		var height = $DOC.height();
		if (height > lockKeyHeight)
			window.scrollBy(0, height - lockKeyHeight + 1);
	}
},

on_key_down: function (event) {
	if (lockTarget == PAGE_BOTTOM) {
		lockKeyHeight = $DOC.height();
		_.defer($.proxy(this, 'entry_scroll_lock'));
	}
	switch (event.which) {
	case 83:
		if (event.altKey) {
			if (!this.submit.attr('disabled'))
				this.finish_wrapped();
			event.preventDefault();
		}
		break;
	case 13:
		event.preventDefault();
	case 32:
		var c = event.which == 13 ? '\n' : ' ';
		// predict result
		var input = this.input;
		var val = input.val();
		val = val.slice(0, input[0].selectionStart) + c +
				val.slice(input[0].selectionEnd);
		this.on_input(val);
		break;
	}
},

on_input: function (val) {
	var input = this.input;
	var start = input[0].selectionStart, end = input[0].selectionEnd;
	if (val === undefined)
		val = input.val();

	/* Turn YouTube links into proper refs */
	var changed = false;
	while (true) {
		var m = val.match(youtube_url_re);
		if (!m)
			break;
		/* Substitute */
		var t = m[4] || '';
		t = this.find_time_arg(m[3]) || this.find_time_arg(m[1]) || t;
		var v = '>>>/watch?v=' + m[2] + t;
		var old = m[0].length;
		val = val.substr(0, m.index) + v + val.substr(m.index + old);
		changed = true;
		/* Compensate caret position */
		if (m.index < start) {
			var diff = old - v.length;
			start -= diff;
			end -= diff;
		}
	}
	if (changed)
		input.val(val);

	var nl = val.lastIndexOf('\n');
	if (nl >= 0) {
		var ok = val.substr(0, nl);
		val = val.substr(nl+1);
		input.val(val);
		if (this.model.get('sentAllocRequest') || ok.match(/[^ ]/))
			this.commit(ok + '\n');
	}
	else {
		var len = val.length;
		var rev = val.split('').reverse().join('');
		var m = rev.match(/^(\s*\S+\s+\S+)\s+(?=\S)/);
		if (m) {
			var lim = len - m[1].length;
			var destiny = val.substr(0, lim);
			this.commit(destiny);
			val = val.substr(lim);
			start -= lim;
			end -= lim;
			input.val(val);
			input[0].setSelectionRange(start, end);
		}
	}

	input.attr('maxlength', MAX_POST_CHARS - this.char_count);
	this.resize_input(val);
},

add_ref: function (num) {
	/* If a >>link exists, put this one on the next line */
	var input = this.input;
	var val = input.val();
	if (val.match(/^>>\d+$/)) {
		input.val(val + '\n');
		this.on_input();
		val = input.val();
	}
	input.val(val + '>>' + num);
	input[0].selectionStart = input.val().length;
	this.on_input();
	input.focus();
},

find_time_arg: function (params) {
	if (!params || params.indexOf('t=') < 0)
		return false;
	params = params.split('&');
	for (var i = 0; i < params.length; i++) {
		var pair = '#' + params[i];
		if (pair.match(youtube_time_re))
			return pair;
	}
	return false;
},

resize_input: function (val) {
	var input = this.input;
	if (typeof val != 'string')
		val = input.val();

	this.$sizer.text(val);
	var left = input.offset().left - this.$el.offset().left;
	var size = this.$sizer.width() + INPUT_ROOM;
	size = Math.max(size, inputMinSize - left);
	input.css('width', size + 'px');
},

upload_status: function (msg) {
	if (this.model.get('cancelled'))
		return;
	this.uploadStatus.text(msg);
},

upload_error: function (msg) {
	if (this.model.get('cancelled'))
		return;
	this.uploadStatus.text(msg);
	this.model.set({uploading: false});
	if (this.uploadForm)
		this.uploadForm.find('input[name=alloc]').remove();
},

insert_uploaded: function (info) {
	var form = this.uploadForm, op = this.model.get('op');
	insert_image(info, form.siblings('header'), !op);
	this.$imageInput.siblings('strong').andSelf().add(this.$cancel
			).remove();
	form.find('#toggle').remove();
	this.flush_pending();
	this.model.set({uploading: false, uploaded: true,
			sentAllocRequest: true});

	/* Stop obnoxious wrap-around-image behaviour */
	var $img = this.$el.find('img');
	this.blockquote.css({
		'margin-left': $img.css('margin-right'),
		'padding-left': $img.width(),
	});

	this.resize_input();
},

make_alloc_request: function (text, image) {
	var nonce = random_id();
	nonces[nonce] = true;
	this.nonce = nonce;
	setTimeout(function () {
		delete nonces[nonce];
	}, 20 * 60 * 1000);

	var msg = {nonce: nonce};
	function opt(key, val) {
		if (val)
			msg[key] = val;
	}
	opt('name', $name.val().trim());
	opt('email', $email.val().trim());
	opt('subject', this.$subject.val().trim());
	opt('frag', text);
	opt('image', image);
	opt('op', this.model.get('op'));
	return msg;
},

commit: function (text) {
	var lines;
	if (text.indexOf('\n') >= 0) {
		lines = text.split('\n');
		this.line_count += lines.length - 1;
		var breach = this.line_count - MAX_POST_LINES + 1;
		if (breach > 0) {
			for (var i = 0; i < breach; i++)
				lines.pop();
			text = lines.join('\n');
			this.line_count = MAX_POST_LINES;
		}
	}
	var left = MAX_POST_CHARS - this.char_count;
	if (left < text.length)
		text = text.substr(0, left);
	if (!text)
		return;
	this.char_count += text.length;

	/* Either get an allocation or send the committed text */
	var attrs = this.model.attributes;
	if (!attrs.num && !attrs.sentAllocRequest) {
		send([INSERT_POST, this.make_alloc_request(text, null)]);
		this.model.set({sentAllocRequest: true});
	}
	else if (attrs.num)
		send(text);
	else
		this.pending += text;

	/* Add it to the user's display */
	var line_buffer = this.line_buffer;
	if (lines) {
		lines[0] = line_buffer.text() + lines[0];
		line_buffer.text(lines.pop());
		for (var i = 0; i < lines.length; i++)
			this.imouto.fragment(lines[i] + '\n');
	}
	else {
		line_buffer.append(document.createTextNode(text));
		line_buffer[0].normalize();
	}
},

flush_pending: function () {
	if (this.pending) {
		send(this.pending);
		this.pending = '';
	}
},

cancel: function () {
	if (this.model.get('uploading')) {
		this.$iframe.remove();
		this.$iframe = $('<iframe src="" name="upload"/></form>');
		this.$iframe.appendTo('body');
		this.upload_error('');
		this.model.set({cancelled: true});
	}
	else
		this.finish_wrapped();
},

finish: function () {
	if (this.model.get('num')) {
		this.flush_pending();
		this.commit(this.input.val());
		this.input.remove();
		this.submit.remove();
		if (this.uploadForm)
			this.uploadForm.remove();
		if (this.$iframe) {
			this.$iframe.remove();
			this.$iframe = null;
		}
		this.imouto.fragment(this.line_buffer.text());
		this.buffer.replaceWith(this.buffer.contents());
		this.line_buffer.remove();
		this.blockquote.css({'margin-left': '', 'padding-left': ''});
		send([FINISH_POST]);
		this.preserve = true;
	}
	postSM.feed('done');
},

remove: function () {
	if (!this.preserve) {
		if (!this.model.get('op'))
			this.$el.next('hr').remove();
		this.$el.remove();
	}
	this.$sizer.remove();
	if (this.$iframe) {
		this.$iframe.remove();
		this.$iframe = null;
	}
},

render_buttons: function () {
	var attrs = this.model.attributes;
	var allocWait = attrs.sentAllocRequest && !attrs.num;
	var d = attrs.uploading || allocWait;
	/* Beware of undefined! */
	this.submit.prop('disabled', !!d);
	if (attrs.uploaded)
		this.submit.css({'margin-left': '0'});
	this.$cancel.prop('disabled', !!allocWait);
	this.$cancel.toggle(!!(!attrs.num || attrs.uploading));
	this.$imageInput.prop('disabled', !!attrs.uploading);
},

prep_upload: function () {
	this.uploadStatus.text('Uploading...');
	this.input.focus();
	var attrs = this.model.attributes;
	return {spoiler: attrs.spoiler, op: attrs.op || 0};
},

notify_uploading: function () {
	this.model.set({uploading: true, cancelled: false});
},

make_upload_form: function () {
	var form = $('<form method="post" enctype="multipart/form-data" '
		+ 'target="upload"></form>');
	this.$cancel = $('<input>', {
		type: 'button', value: 'Cancel',
		click: $.proxy(this, 'cancel'),
	});
	this.$imageInput = $('<input>', {
		type: 'file', id: 'image', name: 'image', accept: 'image/*',
		change: $.proxy(this, 'on_image_chosen'),
	});
	this.$toggle = $('<input>', {
		type: 'button', id: 'toggle',
		click: $.proxy(this, 'on_toggle'),
	});
	this.uploadStatus = $('<strong/>');
	form.append(this.$cancel, this.$imageInput, this.$toggle, ' ',
			this.uploadStatus);
	this.$iframe = $('<iframe src="" name="upload"/>').appendTo('body');
	if (nashi.upload) {
		this.$imageInput.hide();
		this.$toggle.hide();
	}
	this.model.set({spoiler: 0, nextSpoiler: -1});
	return form;
},

on_image_chosen: function () {
	if (!this.$imageInput.val()) {
		this.uploadStatus.text('');
		return;
	}
	var extra = this.prep_upload();
	for (var k in extra)
		$('<input type=hidden>').attr('name', k).val(extra[k]
				).appendTo(this.uploadForm);
	this.uploadForm.prop('action', '../upload/?id=' + sessionId);
	this.uploadForm.submit();
	this.$iframe.load(function (event) {
		if (!postForm)
			return;
		var doc = this.contentWindow || this.contentDocument;
		if (!doc)
			return;
		var error = $(doc.document || doc).text();
		if (error.match(/^\s*OK\s*$/))
			return;
		/* sanity check for weird browser responses */
		if (error.length < 5 || error.length > 100)
			error = 'Unknown upload error.';
		postForm.upload_error(error);
	});
	this.notify_uploading();
},

on_toggle: function (event) {
	var self = this;
	var attrs = this.model.attributes;
	if (!attrs.uploading && !attrs.uploaded) {
		event.preventDefault();
		if (attrs.spoiler) {
			this.model.set({spoiler: 0});
			/* XXX: Removing the style attr is buggy... */
			set_image('pane.png');
			return;
		}
		var pick = pick_spoiler(attrs.nextSpoiler);
		this.model.set({spoiler: pick.index, nextSpoiler: pick.next});
		set_image('spoil' + pick.index + '.png');
	}
	function set_image(path) {
		self.$toggle.css('background-image', 'url("'
				+ mediaURL + 'kana/' + path + '")');
	}
},

});

(function () {
	var CV = ComposerView.prototype;
	CV.finish_wrapped = _.wrap(CV.finish, with_dom);
})();
