var common = require('../common'),
    hooks = require('../hooks');

var rollLimit = 5;

exports.roll_dice = function (frag, post, extra) {
	var ms = frag.split(common.dice_re);
	var dice = [];
	for (var i = 1; i < ms.length && dice.length < rollLimit; i += 2) {
		var info = common.parse_dice(ms[i]);
		if (!info)
			continue;
		var f = info.faces;
		var rolls = [f];
		for (var j = 0; j < info.n; j++)
			rolls.push(Math.floor(Math.random() * f) + 1);
		if (info.bias)
			rolls.push({bias: info.bias})
		dice.push(rolls);
	}
	if (dice.length) {
		// Would prefer an appending scheme for adding new rolls but
		// there's no hash value append redis command...
		// I don't want to spill into a separate redis list.
		// Overwriting the whole log every time is quadratic though.
		// Enforcing a roll limit to deter that and for sanity
		var exist = post.dice ? post.dice.length : 0;
		if (dice.length + exist > rollLimit)
			dice = dice.slice(0, Math.max(0, rollLimit - exist));
		if (dice.length) {
			extra.new_dice = dice;
			dice = post.dice ? post.dice.concat(dice) : dice;
			post.dice = dice;
		}
	}
};

function inline_dice(post, dice) {
	if (dice && dice.length) {
		dice = JSON.stringify(dice);
		post.dice = dice.substring(1, dice.length - 1);
	}
}

exports.attach_dice_to_post = attached => {
	const { new_dice } = attached.extra;
	if (new_dice) {
		attached.attach.dice = new_dice;
		inline_dice(attached.writeKeys, attached.post.dice);
	}
};

exports.notify_client_fun_banner = function (client, op) {
	client.db.get_fun(op, (err, js) => {
		if (err)
			return winston.error(err);
		if (js)
			client.send([op, common.EXECUTE_JS, js]);
	});

	client.db.get_banner((err, banner) => {
		if (err)
			return winston.error(err);
		if (banner && banner.op == op && banner.message) {
			client.send([op, common.UPDATE_BANNER, banner.message]);
		}
	});
};
