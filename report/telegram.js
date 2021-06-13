const { TELEGRAM_TOKEN, TELEGRAM_PASSWORD } = require('./config'),
    winston = require('winston');

let BOT;

exports.install = () => {
    const TelegramBot = require('node-telegram-bot-api');
    BOT = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
    winston.info('Polling Telegram bot.');

    BOT.onText(/\/register\s*(.*)/, async ({ from }, match) => {
        const { id } = from;
        const password = match[1];
        if (password !== TELEGRAM_PASSWORD) {
            BOT.sendMessage(id, 'Wrong password, sorry!');
            return;
        }
        const r = global.redis;
        try {
            const added = await r.promise.hset('telegram:mods', id, '0');
            BOT.sendMessage(id, added > 0 ? "You're on the list!" : "Re-registered...?");
        } catch (err) {
            winston.error('/register', id, err);
            BOT.sendMessage(id, "Something's gone horribly wrong.");
        }
    });
    BOT.onText(/\/deregister/, async ({ from }) => {
        const { id } = from;
        // This seems abuseable?
        const r = global.redis;
        try {
            const removed = await r.promise.hdel('telegram:mods', id);
            BOT.sendMessage(id, removed > 0 ? "So long~" : "You're not registered to start with!");
        } catch (err) {
            winston.error('/deregister', id, err);
            BOT.sendMessage(id, "Whoopsie!");
        }
    });
    BOT.onText(/\/nipah/, ({ from }) => BOT.sendMessage(from.id, 'mii'));
    BOT.on('photo', ({ from }) => BOT.sendMessage(from.id, 'HNNNNGGGGGG'));

    return exports;
};

exports.broadcastToMods = async (message) => {
    if (!BOT) throw new Error('Telegram Bot not enabled');
    const r = global.redis;
    const mods = await r.promise.hgetall('telegram:mods');
    for (let id in mods) {
        // TODO if this errors, increment the error count, and possibly eject the user
        await BOT.sendMessage(id, message);
    }
};
