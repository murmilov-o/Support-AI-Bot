const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const express = require('express');
const fs = require('fs');

// --- 1. ЗАГЛУШКА ДЛЯ RENDER (чтобы сервер не засыпал) ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Бот на связи! И готов смотреть скрины! 👀'));
app.listen(PORT, () => console.log(`Веб-сервер Express запущен на порту ${PORT}`));

// --- 2. НАСТРОЙКИ API И БАЗЫ ДАННЫХ ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WIKI_URL = process.env.WIKI_URL;
const DB_FILE = './knowledge.json';

// Загружаем личную базу знаний (Вариант Б)
let localKnowledge = [];
if (fs.existsSync(DB_FILE)) {
    try {
        localKnowledge = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Ошибка загрузки базы знаний, создана новая:", e.message);
        localKnowledge = [];
    }
}

function saveKnowledge(text) {
    localKnowledge.push({ date: new Date().toISOString(), text: text });
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(localKnowledge, null, 2));
    } catch (e) {
        console.error("Ошибка сохранения базы данных:", e.message);
    }
}

// --- 3. ФУНКЦИИ OPENAI И WIKI ---

// УБРАЛИ fetchGraphQL, так как OpenAI через Vision сам извлекает текст из картинок и статей Wiki.js
async function askOpenAI(messages, temperature = 0.2) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini", // Эта модель поддерживает Vision по умолчанию!
      messages: messages,
      temperature: temperature,
      max_tokens: 1500 // Регулируем длину ответа
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

client.once('clientReady', (c) => {
    console.log(`🤖 Бот успешно авторизован как ${c.user.tag}`);
    // Ставим статус бота "Смотрю на скрины"
    client.user.setActivity({
        name: 'на твои скрины 👀',
        type: ActivityType.Watching
    });
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
        await message.react('💾'); // Эмодзи сохранения
        return message.reply('✅ Успешно сохранил в личную базу! Можешь спрашивать через `!ask`.');
    }

    // КОМАНДА 2: ПОИСК И АНАЛИЗ ВОПРОСОВ (!ask)
    if (command === 'ask') {
        // Мы НЕ требуем текста запроса (userQuery), так как контекст может быть только в картинке!

        // Отправляем сообщение-заглушку, чтобы Discord не думал, что бот завис
        const processingMsg = await message.reply('⏳ *Начинаю анализ... Проверяю память, Wiki.js и смотрю на картинки (если они есть)...*');

        try {
            // --- ЭТАП 1: ПОДГОТОВКА ГЛОБАЛЬНОЙ ТЕМЫ (ПОИСК WIKI) ---
            const textToSearch = userQuery || "general logistics"; // Если текста нет, ищем просто "logistics" для базовых правил
            
            const translatePrompt = `
Контекст: база знаний техподдержки логистической компании.
Запрос: "${textToSearch}"
Сгенерируй 4 варианта поиска на английском и 1 на русском (вытащи суть). Переводи бренды (альфа->Alfa, хос->HOS). Обязательно укажи глобальную тему.
Верни ТОЛЬКО 5 вариантов через запятую.`;

            let smartQueryText = await askOpenAI([
                { role: "system", content: "Генератор запросов." },
                { role: "user", content: translatePrompt }
            ], 0.1);

            let queryVariations = smartQueryText.split(',').map(s => s.trim()).filter(s => s.length > 0);
            
            // Если агент написал текст, добавляем его в поиск
            if (userQuery) queryVariations.push(userQuery);

            // --- ЭТАП 2: ПОИСК И СБОР ДАННЫХ ИЗ WIKI.JS (Вариант А) ---
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

            // Простая сортировка
            uniqueResults.sort((a, b) => {
                let score = 0;
                queryVariations.forEach(q => {
                    if (a.title.toLowerCase().includes(q.toLowerCase())) score -= 1;
                });
                return score;
            });

            // Берем топ-2 статьи, чтобы не превысить лимиты OpenAI по контексту
            const topArticles = uniqueResults.slice(0, 2); 

            let wikiContext = "";
            for (const page of topArticles) {
                try {
                    const pageRes = await fetch(page.url);
                    let pageHtml = await pageRes.text();
                    pageHtml = pageHtml.substring(0, 20000); // Режем HTML, чтобы влезло в память
                    
                    let cleanText = pageHtml.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
                    cleanText = cleanText.replace(/href=["'](\/[^"']+)["']/gi, `href="${WIKI_URL}$1"`);
                    cleanText = cleanText.replace(/<\/?(?!(a)\b)[^>]+>/gi, ' ');
                    cleanText = cleanText.replace(/\s+/g, ' ').trim();
                    
                    wikiContext += `\n--- СТАТЬЯ WIKI: ${page.title} ---\n${cleanText.substring(0, 6000)}\n`;
                } catch (e) {
                    console.log(`Не удалось прочитать статью ${page.url}`);
                }
            }

            // --- ЭТАП 3: СБОР ЛИЧНОЙ БАЗЫ ЗНАНИЙ (Вариант Б) ---
            let personalContext = "";
            if (localKnowledge.length > 0) {
                // Берем последние 10 записей, чтобы не перегружать контекст
                const recentKnowledge = localKnowledge.slice(-10).map(k => k.text).join('\n- ');
                personalContext = `\n--- ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА (САМЫЙ ВЫСОКИЙ ПРИОРИТЕТ!) ---\n- ${recentKnowledge}\n`;
            }

            // --- ЭТАП 4: СУПЕРСПОСОБНОСТЬ LOOK (VISION API) ---
            let visionMessages = [];
            // Проверяем, есть ли прикрепленные картинки
            if (message.attachments.size > 0) {
                const attachment = message.attachments.first(); // Берем первую картинку
                
                // Простая проверка, что это картинка
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    const imageUrl = attachment.url; // Вытаскиваем URL картинки!

                    // Обновляем статус сообщения, чтобы агент видел прогресс
                    await processingMsg.edit('⏳ *Смотрю на картинку своими AI-глазами... 👀 Параллельно читаю Wiki.js...*');
                    
                    // Формируем контент пользователя (Микс текста и картинки!)
                    visionMessages = [
                        {
                            type: "text",
                            text: `Вопрос агента: ${userQuery || "Пожалуйста, проанализируй эту картинку и скажи, что здесь происходит?"}`
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: imageUrl, // Отправляем ссылку на картинку в OpenAI!
                                detail: "high" // high деталь для чтения мелкого текста (ошибок)
                            }
                        }
                    ];
                } else {
                    // Если файл не картинка, отвечаем текстом
                    visionMessages = [{ type: "text", text: `Вопрос агента: ${userQuery}. (Файл, который ты прикрепил, не является картинкой, поэтому я его не вижу).` }];
                }
            } else {
                // Картинки нет, обычный текстовый контент
                visionMessages = [{ type: "text", text: `Вопрос агента: ${userQuery}` }];
            }

            // --- ЭТАП 5: ФИНАЛЬНЫЙ АНАЛИЗ И ФОРМИРОВАНИЕ ОТВЕТА ---
            const systemPrompt = `
 Ты корпоративный AI-помощник для АГЕНТОВ ТЕХПОДДЕРЖКИ. Твоя задача - помочь агенту ответить на тикет клиента.
 Ты получил вопрос агента. У тебя может быть прикреплен СКРИНШОТ экрана (ошибки, логбука, админки).
 
 У тебя есть ДВА источника знаний (в текстовом виде):
 1. ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА (самый высокий приоритет! Это внутренние скрипты).
 2. СТАТЬИ ИЗ WIKI.JS.
 
 ПРАВИЛА:
 - Отвечай строго на вопрос, используя факты из этих двух источников текста.
 - Если прикреплен скриншот, внимательно "прочитай" его (коды ошибок, имена водителей, статусы) и используй эту информацию для поиска решения в предоставленных текстах!
 - Запрещено придумывать инструкции. Если ответа нет ни там, ни там, скажи "Информация не найдена в Wiki.js или твоих заметках".
 - Ссылки из Wiki.js сохраняй в формате Markdown.
 - Твой ответ должен быть структурированным, в стиле DISCORD MARKDOWN (используй **жирный текст**, списки через -, ссылки [Текст](URL)). Не используй HTML-теги!
 
 ИСТОЧНИКИ ДАННЫХ (ТЕКСТ):
 ${personalContext}
 ${wikiContext}`;

            // Формируем массив сообщений для API OpenAI
            let apiMessages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: visionMessages } // Здесь может быть микс текста и картинки!
            ];
            
            // Финальный запрос к OpenAI
            let finalAnswer = await askOpenAI(apiMessages, 0.2);

            // Discord лимит - 2000 символов на сообщение
            if (finalAnswer.length > 1950) {
                finalAnswer = finalAnswer.substring(0, 1950) + "...\n*(Ответ обрезан из-за лимитов Discord)*";
            }

            // Заменяем сообщение-заглушку на реальный ответ
            await processingMsg.edit(finalAnswer);

        } catch (error) {
            await processingMsg.edit(`❌ Ошибка при поиске/анализе: ${error.message}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
