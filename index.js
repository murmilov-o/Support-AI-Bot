const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const express = require('express');
const fs = require('fs');
const cors = require('cors'); 

// --- 1. ЗАГЛУШКА И ПРОКСИ ДЛЯ RENDER ---
const app = express();
const PORT = process.env.PORT || 10000;
app.use(express.json());
app.use(cors({ origin: 'https://discord.com', methods: ['POST'], allowedHeaders: ['Content-Type'] }));

// Прокси для браузерного расширения
app.post('/proxy-webhook', async (req, res) => {
    try {
        const { content, targetWebhook } = req.body;
        await fetch(targetWebhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        res.send('OK');
    } catch (e) {
        res.status(500).send(e.toString());
    }
});

app.get('/', (req, res) => res.send('Бот на связи! 👀'));
app.listen(PORT, () => console.log(`Веб-сервер Express запущен на порту ${PORT}`));

// --- 2. НАСТРОЙКИ API И БАЗЫ ДАННЫХ ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Защита от undefined: если переменной нет, ставим запасной вариант
const WIKI_URL = process.env.WIKI_URL || 'https://wiki.nadoje.com'; 
const DB_FILE = './knowledge.json';

// Загружаем личную базу знаний
let localKnowledge = [];
if (fs.existsSync(DB_FILE)) {
    try {
        localKnowledge = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Ошибка загрузки базы знаний:", e.message);
        localKnowledge = [];
    }
}

function saveKnowledge(text) {
    localKnowledge.push({ date: new Date().toISOString(), text: text });
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(localKnowledge, null, 2));
    } catch (e) {
        console.error("Ошибка сохранения БД:", e.message);
    }
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
      temperature: temperature,
      max_tokens: 1500 
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices[0].message.content.trim();
}

async function fetchWikiGraphQL(query) {
    if (!WIKI_URL || WIKI_URL.includes("undefined")) return []; // Защита от краша!
    try {
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
    } catch (e) {
        console.error("Wiki GraphQL Error:", e);
        return []; // Если Wiki легла, возвращаем пустоту, чтобы не крашить бота
    }
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

client.once('clientReady', (c) => {
    console.log(`🤖 Бот успешно авторизован как ${c.user.tag}`);
    client.user.setActivity({ name: 'на твои скрины 👀', type: ActivityType.Watching });
});

client.on('messageCreate', async message => {
    if (message.author.bot || !message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const userQuery = args.join(' ');

    if (command === 'learn') {
        if (!userQuery) return message.reply('❌ Напиши текст, который мне нужно запомнить.');
        saveKnowledge(userQuery);
        await message.react('💾'); 
        return message.reply('✅ Успешно сохранил в личную базу!');
    }

    if (command === 'ask') {
        const processingMsg = await message.reply('⏳ *Начинаю анализ... Проверяю память, Wiki.js и смотрю на картинки (если они есть)...*');

        try {
            const textToSearch = userQuery || "general rules"; 
            
            const translatePrompt = `
Контекст: база знаний техподдержки логистической компании. Запрос: "${textToSearch}".
Сгенерируй 4 варианта поиска на английском и 1 на русском (вытащи суть). 
Верни ТОЛЬКО 5 вариантов через запятую.`;

            let smartQueryText = await askOpenAI([
                { role: "system", content: "Генератор запросов." },
                { role: "user", content: translatePrompt }
            ], 0.1);

            let queryVariations = smartQueryText.split(',').map(s => s.trim()).filter(s => s.length > 0);
            if (userQuery) queryVariations.push(userQuery);

            // ИЩЕМ В WIKI
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

            const topArticles = uniqueResults.slice(0, 2); 
            let wikiContext = "";
            for (const page of topArticles) {
                try {
                    const pageRes = await fetch(page.url);
                    let pageHtml = await pageRes.text();
                    pageHtml = pageHtml.substring(0, 20000); 
                    
                    let cleanText = pageHtml.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
                    cleanText = cleanText.replace(/href=["'](\/[^"']+)["']/gi, `href="${WIKI_URL}$1"`);
                    cleanText = cleanText.replace(/<\/?(?!(a)\b)[^>]+>/gi, ' ');
                    cleanText = cleanText.replace(/\s+/g, ' ').trim();
                    
                    wikiContext += `\n--- СТАТЬЯ WIKI: ${page.title} ---\n${cleanText.substring(0, 6000)}\n`;
                } catch (e) {}
            }

            // ЛИЧНАЯ БАЗА (Ваша новость про очереди)
            let personalContext = "";
            if (localKnowledge.length > 0) {
                // Увеличил лимит последних записей до 20, чтобы ничего не потерялось!
                const recentKnowledge = localKnowledge.slice(-20).map(k => k.text).join('\n---\n');
                personalContext = `\n--- ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА (САМЫЙ ВЫСОКИЙ ПРИОРИТЕТ!) ---\n${recentKnowledge}\n`;
            }

            let visionMessages = [];
            if (message.attachments.size > 0) {
                const attachment = message.attachments.first(); 
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    await processingMsg.edit('⏳ *Смотрю на картинку своими AI-глазами... 👀*');
                    visionMessages = [
                        { type: "text", text: `Вопрос агента: ${userQuery || "Проанализируй картинку"}` },
                        { type: "image_url", image_url: { url: attachment.url, detail: "high" } }
                    ];
                } else {
                    visionMessages = [{ type: "text", text: `Вопрос: ${userQuery}. (Файл не картинка)` }];
                }
            } else {
                visionMessages = [{ type: "text", text: `Вопрос агента: ${userQuery}` }];
            }

            const systemPrompt = `
 Ты AI-помощник для АГЕНТОВ ТЕХПОДДЕРЖКИ. 
 У тебя есть ДВА источника знаний (в текстовом виде):
 1. ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА (самый высокий приоритет! Это внутренние правила из Discord).
 2. СТАТЬИ ИЗ WIKI.JS.
 
 ПРАВИЛА:
 - Отвечай строго на вопрос, опираясь НА ЭТИ ТЕКСТЫ.
 - Если ответа нет - скажи "Информация не найдена". Не выдумывай отсебятину!
 - Форматируй ответ в стиле DISCORD MARKDOWN (используй **жирный текст**, списки через -).
 
 ИСТОЧНИКИ ДАННЫХ:
 ${personalContext}
 ${wikiContext}`;

            let apiMessages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: visionMessages } 
            ];
            
            let finalAnswer = await askOpenAI(apiMessages, 0.2);

            if (finalAnswer.length > 1950) {
                finalAnswer = finalAnswer.substring(0, 1950) + "...\n*(Ответ обрезан из-за лимитов)*";
            }

            await processingMsg.edit(finalAnswer);

        } catch (error) {
            await processingMsg.edit(`❌ Ошибка: ${error.message}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
