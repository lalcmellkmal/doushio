(function () {

var root = THREAD ? '../../' : '../';

var $button = $('<a></a>', {
	href: '#',
	id: 'login-button',
	'class': 'persona-button dark',
	css: {'margin-top': '0.5em'},
});
var $caption = $('<span>...</span>').appendTo($button);
$button.appendTo('fieldset');

function inform(msg, color) {
	$caption.text(msg);
	$button.toggleClass('orange', color == 'orange');
	$button.toggleClass('dark', color == 'dark');
}

function setup_button() {
	if (!window.loggedInUser) {
		inform('Login', 'orange');
		$button.prop('href', root + 'login');
		$button.click(on_login);
	}
	else {
		inform('Logout', 'blue');
		$button.prop('href', root + 'logout');
		$button.click(on_logout);
	}
	$button.focus();
}

function on_login(event) {
	var opts = 'location=0,menubar=0,status=0,toolbar=0,height=700,width=500';
	var popup = window.open(root + 'login?popup', 'login', opts);
	if (popup)
		event.preventDefault();
}

function on_logout(event) {
	inform('Logging out...', 'dark');
	$.ajax({
		type: 'POST',
		url: root + 'logout',
		data: {csrf: window.x_csrf},
		dataType: 'json',
		success: function (res) {
			if (res && res.status == 'okay') {
				inform('Logged out.', 'orange');
				setTimeout(function () {
					window.location.reload();
				}, 1000);
			}
			else
				inform(res.message||'Unknown error.', 'dark');
		},
		error: function (res) {
			inform('Network error.', 'dark');
			console.error(res);
		},
	});
	event.preventDefault();
}

$('<link></link>', {
	rel: 'stylesheet',
	href: mediaURL + 'css/persona-buttons.css',
}).appendTo('head');

setup_button();

})();
