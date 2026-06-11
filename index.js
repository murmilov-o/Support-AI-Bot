const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');

// --- 1. ЗАГЛУШКА ДЛЯ RENDER (чтобы сервер не падал) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Бот работает и готов к труду!'));
app.listen(PORT, () => console.log(`Веб-сервер запущен на порту ${PORT}`));

// --- 2. ИНИЦИАЛИЗАЦИЯ DISCORD БОТА ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

client.once('ready', () => {
    console.log(`🤖 Бот успешно авторизован как ${client.user.tag}`);
});

// Слушаем все сообщения в чате (пока просто для проверки)
client.on('messageCreate', async message => {
    // Игнорируем сообщения от других ботов
    if (message.author.bot) return;

    if (message.content === '!ping') {
        message.reply('Pong! Я на связи.');
    }
});

// Запускаем бота (Токен будем брать из секретных переменных Render)
client.login(process.env.DISCORD_TOKEN);
