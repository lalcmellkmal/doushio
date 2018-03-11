(function () {

var siteKey = reportConfig.RECAPTCHA_SITE_KEY;
var REPORTS = {};
var PANEL;
var CAPTCHA_CTR = 0;

if (siteKey)
	menuOptions.push('Report');

var Report = Backbone.Model.extend({
	defaults: {
		status: 'setup',
		hideAfter: true,
	},

	request_new: function () {
		this.set({
			status: 'setup',
			error: ''
		});
		if (this.get('captchaId')) {
			this.reset();
			return;
		}
		// inject a new div into captchaHolder
		let id = 'captcha_' + CAPTCHA_CTR++;
		this.trigger('createDiv', id);
		// render a new captcha on it
		let params = {
			sitekey: siteKey,
			theme: 'dark',
			callback: response => {
				this.set({
					status: 'ready',
					error: '',
					response: response
				});
			},
			'expired-callback': () => {
				this.set({
					status: 'error',
					error: 'reCAPTCHA expired.'
				});
			},
			'error-callback': () => {
				this.set({
					status: 'error',
					error: 'reCAPTCHA error.'
				});
			}
		};
		setTimeout(() => {
			debugger;
			window.grecaptcha.render(id, params);
		}, 10);
	},

	did_report: function () {
		delete REPORTS[this.id];

		setTimeout(() => this.trigger('destroy'), 1500);

		if (this.get('hideAfter'))
			this.get('post').set('hide', true);
	},

	reset: function () {
		let captchaId = this.get('captchaId');
		if (captchaId) {
			grecaptcha.reset(captchaId);
			this.set('captchaId', null);
		}
	},
});

var ReportPanel = Backbone.View.extend({
	id: 'report-panel',
	tagName: 'form',
	className: 'modal',

	events: {
		submit: 'submit',
		'click .close': 'remove',
		'click .hideAfter': 'hide_after_changed',
	},

	initialize: function () {
		this.$captchaHolder = $('<div>', {
			id: 'captcha',
			css: {'min-width': 304, 'min-height': 78}
		});
		this.$message = $('<div class="message"/>');
		this.$submit = $('<input>', {type: 'submit', val: 'Report'});
		var $hideAfter = $('<input>', {
			'class': 'hideAfter',
			type: 'checkbox',
			checked: this.model.get('hideAfter'),
		});
		var $hideLabel = $('<label>and hide</label>')
			.append($hideAfter);

		var num = this.model.id;

		this.$el
		.append('Reporting post ')
		.append($('<a/>', {href: '#'+num, text: '>>'+num}))
		.append('<a class="close" href="#">x</a>')
		.append(this.$message)
		.append(this.$captchaHolder)
		.append(this.$submit)
		.append(' ', $hideLabel);

		/* HACK */
		if (window.x_csrf) {
			this.model.set('hideAfter', false);
			$hideLabel.remove();
		}

		this.listenTo(this.model, {
			'change:error': this.error_changed,
			'change:status': this.status_changed,
			createDiv: this.create_div,
			destroy: this.remove,
		});
	},

	render: function () {
		this.error_changed();
		this.status_changed();
		return this;
	},

	create_div: function (id) {
		this.$captchaHolder.empty().append($('<div/>', {id: id}));
	},

	submit: function (event) {
		event.preventDefault();
		let status = this.model.get('status');
		if (status == 'ready' && this.model.get('response')) {
			send([REPORT_POST, this.model.id, this.model.get('response')]);
			this.model.set({
				status: 'reporting',
				response: null
			});
		}
		else if (status == 'error') {
			this.model.request_new();
		}
	},

	error_changed: function () {
		this.$message.text(this.model.get('error'));
	},

	status_changed: function () {
		var status = this.model.get('status');
		let submit = 'Report';
		if (status == 'reporting')
			submit = 'Reporting...';
		if (status == 'error')
			submit = 'Another.';
		this.$submit
			.prop('disabled', status != 'ready' && status != 'error')
			.toggle(status != 'done')
			.val(submit);
		if (status == 'done')
			this.$('label').remove();

		var msg;
		if (status == 'done')
			msg = 'Report submitted!';
		else if (status == 'setup')
			msg = 'Obtaining reCAPTCHA...';
		else if (status == 'error')
			msg = 'E';
		else if (status == 'ready' && this.model.get('error'))
			msg = 'E';
		this.$message.text(msg=='E' ? this.model.get('error') : msg);
		this.$message.toggleClass('error', msg == 'E');

		// not strictly view logic, but only relevant when visible
		if (status == 'done')
			this.model.did_report();
	},

	hide_after_changed: function (e) {
		this.model.set('hideAfter', e.target.checked);
	},

	remove: function () {
		this.model.reset();

		Backbone.View.prototype.remove.call(this);
		if (PANEL == this) {
			PANEL = null;
		}
		return false;
	},
});

var ajaxJs = 'https://www.google.com/recaptcha/api.js?onload=on_init_captcha&render=explicit';

var CAPTCHA_LOADED = false;
window.on_init_captcha = () => { CAPTCHA_LOADED = true; };

menuHandlers.Report = function (post) {
	var num = post.id;
	var model = REPORTS[num];
	if (!model)
		REPORTS[num] = model = new Report({id: num, post: post});

	if (PANEL) {
		if (PANEL.model === model) {
			PANEL.focus();
			return;
		}
		PANEL.remove();
	}
	PANEL = new ReportPanel({model: model});
	PANEL.render().$el.appendTo('body');
	if (CAPTCHA_LOADED) {
		model.request_new();
		return;
	}
	$.getScript(ajaxJs, () => {
		// why is `grecaptcha` not immediately available?
		setTimeout(() => {
			if (CAPTCHA_LOADED)
				model.request_new();
			else
				model.set({
					status: 'error',
					error: "Couldn't load reCATPCHA.",
				});
		}, 10);
	});
};

dispatcher[REPORT_POST] = function (msg, op) {
	var num = msg[0], etc = msg[1];
	var report = REPORTS[num];
	if (report)
		report.set(msg[1] || {status: 'done'});
};

})();
