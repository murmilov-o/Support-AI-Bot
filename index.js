const { Client, GatewayIntentBits, Partials } = require('discord.js');
const express = require('express');
const fs = require('fs');

// --- 1. ЗАГЛУШКА ДЛЯ RENDER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('AI Бот работает!'));
app.listen(PORT, () => console.log(`Веб-сервер запущен на порту ${PORT}`));

// --- 2. НАСТРОЙКИ API И БАЗЫ ДАННЫХ ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WIKI_URL = process.env.WIKI_URL; // Например: https://wiki.nadoje.com
const DB_FILE = './knowledge.json';

// Загружаем личную базу знаний (Вариант Б)
let localKnowledge = [];
if (fs.existsSync(DB_FILE)) {
    localKnowledge = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveKnowledge(text) {
    localKnowledge.push({ date: new Date().toISOString(), text: text });
    fs.writeFileSync(DB_FILE, JSON.stringify(localKnowledge, null, 2));
}

// --- 3. ФУНКЦИИ OPENAI И WIKI ---
async function askOpenAI(messages, temperature = 0.2) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: messages,
            temperature: temperature
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content.trim();
}

async function fetchWikiGraphQL(query) {
    const res = await fetch(`${WIKI_URL}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{
            operationName: null,
            variables: { query: query },
            extensions: {},
            query: "query ($query: String!) {\n  pages {\n    search(query: $query) {\n      results {\n        id\n        title\n        path\n      }\n    }\n  }\n}\n"
        }])
    });
    const data = await res.json();
    return data[0]?.data?.pages?.search?.results || [];
}

// --- 4. ИНИЦИАЛИЗАЦИЯ DISCORD БОТА ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Channel]
});

client.once('clientReady', () => {
    console.log(`🤖 Бот успешно авторизован как ${client.user.tag}`);
});

client.on('messageCreate', async message => {
    // Игнорируем других ботов и сообщения без префикса "!"
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const userQuery = args.join(' ');

    // КОМАНДА 1: ОБУЧЕНИЕ (!learn)
    if (command === 'learn') {
        if (!userQuery) return message.reply('❌ Напиши текст, который мне нужно запомнить. Пример: `!learn Для флита Альфа мы делаем то-то...`');
        
        saveKnowledge(userQuery);
        await message.react('💾');
        return message.reply('✅ Успешно сохранил в личную базу!');
    }

    // КОМАНДА 2: ПОИСК (!ask)
    if (command === 'ask') {
        if (!userQuery) return message.reply('❌ Напиши вопрос. Пример: `!ask как выгрузить ифту`');

        // Отправляем сообщение-заглушку, чтобы Discord не думал, что бот завис
        const processingMsg = await message.reply('⏳ *Лезу в личную базу и Wiki.js...*');

        try {
            // Этап 1: Генерация запросов для Wiki
            const translatePrompt = `
Контекст: база знаний техподдержки логистической компании.
Запрос: "${userQuery}"
Сгенерируй 4 варианта поиска на английском и 1 на русском (вытащи суть). Переводи бренды (альфа->Alfa, хос->HOS). Обязательно укажи глобальную тему.
Верни ТОЛЬКО 5 вариантов через запятую.`;

            let smartQueryText = await askOpenAI([
                { role: "system", content: "Генератор запросов." },
                { role: "user", content: translatePrompt }
            ], 0.1);

            let queryVariations = smartQueryText.split(',').map(s => s.trim()).filter(s => s.length > 0);
            queryVariations.push(userQuery);

            // Этап 2: Поиск в Wiki.js
            const fetchPromises = queryVariations.map(q => fetchWikiGraphQL(q));
            const resultsArray = await Promise.all(fetchPromises);
            
            const combinedResults = resultsArray.flat();
            const uniqueResults = [];
            const seenPaths = new Set();
            for (const item of combinedResults) {
                if (!seenPaths.has(item.path)) {
                    seenPaths.add(item.path);
                    item.url = `${WIKI_URL}/${item.path}`;
                    uniqueResults.push(item);
                }
            }

            // Добавляем простую сортировку по совпадениям (как в браузере)
            uniqueResults.sort((a, b) => {
                let score = 0;
                queryVariations.forEach(q => {
                    if (a.title.toLowerCase().includes(q.toLowerCase())) score -= 1;
                });
                return score;
            });

            const topArticles = uniqueResults.slice(0, 3); // Берем топ-3, чтобы не превысить лимит символов Discord

            // Этап 3: Сбор текста из статей
            let wikiContext = "";
            for (const page of topArticles) {
                try {
                    const pageRes = await fetch(page.url);
                    let pageHtml = await pageRes.text();
                    pageHtml = pageHtml.substring(0, 30000); // Режем, чтобы влезло в память
                    
                    let cleanText = pageHtml.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
                    cleanText = cleanText.replace(/href=["'](\/[^"']+)["']/gi, `href="${WIKI_URL}$1"`);
                    cleanText = cleanText.replace(/<\/?(?!(a)\b)[^>]+>/gi, ' ');
                    cleanText = cleanText.replace(/\s+/g, ' ').trim();
                    
                    wikiContext += `\n--- СТАТЬЯ WIKI: ${page.title} ---\n${cleanText.substring(0, 8000)}\n`;
                } catch (e) {
                    console.log(`Не удалось прочитать статью ${page.url}`);
                }
            }

            // Этап 4: Сбор личной базы (Вариант Б)
            let personalContext = "";
            if (localKnowledge.length > 0) {
                // Берем последние 15 записей, чтобы не перегружать контекст
                const recentKnowledge = localKnowledge.slice(-15).map(k => k.text).join('\n- ');
                personalContext = `\n--- ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА ---\n- ${recentKnowledge}\n`;
            }

            // Этап 5: Финальный ответ
            const systemPrompt = `
Ты корпоративный AI-помощник для АГЕНТОВ ТЕХПОДДЕРЖКИ.
У тебя есть ДВА источника информации:
1. ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА (самый высокий приоритет).
2. СТАТЬИ ИЗ WIKI.JS.

ПРАВИЛА:
- Отвечай строго на вопрос, используя факты из этих двух источников.
- Запрещено придумывать инструкции. Если ответа нет ни там, ни там, скажи "Информации не найдено".
- Форматируй ответ в стиле DISCORD MARKDOWN (используй **жирный текст**, списки через -, ссылки в формате [Текст](URL)). Не используй HTML-теги!

ИСТОЧНИКИ ДАННЫХ:
${personalContext}
${wikiContext}`;

            let finalAnswer = await askOpenAI([
                { role: "system", content: systemPrompt },
                { role: "user", content: userQuery }
            ], 0.2);

            // Discord лимит - 2000 символов на сообщение
            if (finalAnswer.length > 1950) {
                finalAnswer = finalAnswer.substring(0, 1950) + "...\n*(Ответ обрезан из-за лимитов Discord)*";
            }

            // Заменяем сообщение-заглушку на реальный ответ
            await processingMsg.edit(finalAnswer);

        } catch (error) {
            await processingMsg.edit(`❌ Ошибка при поиске: ${error.message}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
