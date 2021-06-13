const { TELEGRAM_TOKEN, TELEGRAM_PASSWORD } = require('./config'),
    winston = require('winston');

let BOT;
const MOD_HASH = 'telegram:mods';

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
            const added = await r.promise.hset(MOD_HASH, id, '0');
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
            const removed = await r.promise.hdel(MOD_HASH, id);
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
    const mods = await r.promise.hgetall(MOD_HASH);
    let wasSent = false;
    for (let id in mods) {
        let errorCount = mods[id];
        try {
            await BOT.sendMessage(id, message);
            wasSent = true;
            if (errorCount != 0) {
                // reset the error count
                await r.promise.hset(MOD_HASH, id, '0');
            }
        } catch (err) {
            winston.warn(`Telegram to mod #${id} failed: ${err}`);
            errorCount++;
            if (errorCount < 3) {
                await r.promise.hset(MOD_HASH, id, errorCount);
            } else {
                await r.promise.hdel(MOD_HASH, id);
                winston.warn(`Telegram mod #${id} removed due to sendMessage errors.`);
            }
        }
    }
    if (!wasSent) {
        winston.warn(`Telegram was not sent to anyone:\n${message}`);
    }
};
