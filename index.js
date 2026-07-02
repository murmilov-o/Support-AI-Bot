const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const express = require('express');
const cheerio = require('cheerio'); // НОВАЯ БИБЛИОТЕКА ДЛЯ WIKI

// --- 1. ЗАГЛУШКА ДЛЯ RENDER / RAILWAY ---
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Бот на связи! 👀'));
app.listen(PORT, () => console.log(`Веб-сервер Express запущен на порту ${PORT}`));

// --- 2. НАСТРОЙКИ API И БАЗЫ ДАННЫХ ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WIKI_URL = process.env.WIKI_URL || 'https://wiki.nadoje.com'; 
const FIREBASE_URL = process.env.FIREBASE_URL; 

async function saveKnowledge(text) {
    if (!FIREBASE_URL) return console.error("Не указан FIREBASE_URL");
    try {
        await fetch(FIREBASE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date: new Date().toISOString(), text: text })
        });
    } catch (e) {
        console.error("Ошибка сохранения в Firebase:", e);
    }
}

async function getKnowledge() {
    if (!FIREBASE_URL) return [];
    try {
        const res = await fetch(FIREBASE_URL);
        const data = await res.json();
        if (!data) return [];
        return Object.values(data);
    } catch (e) {
        console.error("Ошибка загрузки из Firebase:", e);
        return [];
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
    if (!WIKI_URL || WIKI_URL.includes("undefined")) return []; 
    
    const WIKI_COOKIE = process.env.WIKI_COOKIE || ""; 
    const headers = { 'Content-Type': 'application/json' };
    if (WIKI_COOKIE) headers['Cookie'] = WIKI_COOKIE;

    try {
        const res = await fetch(`${WIKI_URL}/graphql`, {
            method: 'POST',
            headers: headers,
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
        return []; 
    }
}

// --- 4. ИНИЦИАЛИЗАЦИЯ DISCORD БОТА ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages // ДОБАВЛЕНО: Чтение личных сообщений
    ],
    partials: [Partials.Message, Partials.Channel] // Channel нужен для работы с ЛС
});

client.once('clientReady', (c) => {
    console.log(`🤖 Бот успешно авторизован как ${c.user.tag}`);
    client.user.setActivity({ name: 'на твои скрины 👀', type: ActivityType.Watching });
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // --- ЛОГИКА НОВОСТНОГО КАНАЛА ---
    const NEWS_CHANNEL_ID = '1515056485128867963';
    if (message.channel.id === NEWS_CHANNEL_ID) {
        // ... (твой предыдущий код сохранения новостей остается без изменений)
        let textToSave = message.content || "";
        if (message.embeds && message.embeds.length > 0) {
            message.embeds.forEach(embed => {
                textToSave += "\n" + (embed.title || "") + "\n" + (embed.description || "");
            });
        }
        if (textToSave && textToSave.trim().length > 0) {
            textToSave = textToSave.trim() + `\n\n🔗 Источник: ${message.url}`;
            try {
                await saveKnowledge(textToSave);
                await message.react('🧠'); 
            } catch (err) {
                console.error("Ошибка автосохранения:", err);
            }
        }
        return; 
    }

    // --- ЛОГИКА КОМАНД И ОБЩЕНИЯ ---
    
    // Определяем, обращаемся ли мы к боту (префикс, ответ на его сообщение, или ЛС)
    const isDirectMessage = !message.guild; // Если нет сервера, значит это ЛС
    const isReplyToBot = message.reference && message.mentions.has(client.user);
    const hasPrefix = message.content.startsWith('!');

    // Если это обычное сообщение на сервере без префикса и не ответ боту — игнорируем
    if (!isDirectMessage && !hasPrefix && !isReplyToBot) return;

    // Очищаем запрос от префиксов и пингов
    let userQuery = message.content.replace('!ask', '').replace('!learn', '').replace(`<@${client.user.id}>`, '').trim();
    let command = hasPrefix ? message.content.slice(1).split(' ')[0].toLowerCase() : 'ask';

    if (command === 'learn' && hasPrefix) {
        if (!userQuery) return message.reply('❌ Напиши текст, который мне нужно запомнить.');
        await saveKnowledge(userQuery);
        await message.react('💾'); 
        return message.reply('✅ Успешно сохранил в личную базу!');
    }

    if (command === 'ask' || isDirectMessage || isReplyToBot) {
        const processingMsg = await message.reply('⏳ *Начинаю анализ... Проверяю память, Wiki.js и контекст...*');

        try {
            // 1. ИСТОРИЯ ДИАЛОГА (КОНТЕКСТ)
            let previousContext = "";
            if (message.reference && message.reference.messageId) {
                try {
                    const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
                    if (repliedMsg.author.id === client.user.id) {
                        previousContext = `\nПредыдущий ответ бота: "${repliedMsg.content}"\nУчитывай его, если пользователь задает уточняющий вопрос.`;
                    }
                } catch(e) {
                    console.log("Не удалось загрузить историю сообщения");
                }
            }

            const textToSearch = userQuery || "general rules"; 
            
            const translatePrompt = `Контекст: база знаний. Запрос пользователя: "${textToSearch}".
            Вытащи 2-3 самых главных ключевых слова из запроса на английском. 
            Верни ТОЛЬКО 5 вариантов через запятую, без лишних слов.`;

            let smartQueryText = await askOpenAI([
                { role: "system", content: "Генератор поисковых тегов." },
                { role: "user", content: translatePrompt }
            ], 0.1);

            let queryVariations = smartQueryText.split(',').map(s => s.trim()).filter(s => s.length > 0);
            if (userQuery) queryVariations.push(userQuery);

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

            const topArticles = uniqueResults.slice(0, 5); 
            let wikiContext = "";
            let cookieWarning = ""; // Предупреждение о протухшем куки
            const WIKI_COOKIE = process.env.WIKI_COOKIE || ""; 

            for (const page of topArticles) {
                try {
                    const fetchHeaders = {};
                    if (WIKI_COOKIE) fetchHeaders['Cookie'] = WIKI_COOKIE;

                    const pageRes = await fetch(page.url, { headers: fetchHeaders });
                    let pageHtml = await pageRes.text();
                    
                    // ПРОВЕРКА НА ИСТЕЧЕНИЕ COOKIE
                    if (pageHtml.toLowerCase().includes('name="password"') || pageHtml.toLowerCase().includes('login')) {
                        cookieWarning = "\n\n⚠️ **Внимание:** Мой Cookie для Wiki.js истек! Я не смог прочитать закрытые статьи. Пожалуйста, обновите `WIKI_COOKIE` в Railway.";
                        break; // Прерываем чтение, так как дальше только страницы логина
                    }

                    // НОВЫЙ ИДЕАЛЬНЫЙ ПАРСИНГ ЧЕРЕЗ CHEERIO
                    const $ = cheerio.load(pageHtml);
                    // Удаляем весь мусор (скрипты, стили, меню, футеры)
                    $('script, style, nav, footer, header, .sidebar, .menu').remove();
                    // Вытаскиваем только чистый текст страницы
                    let cleanText = $('body').text().replace(/\s+/g, ' ').trim();
                    
                    wikiContext += `\n--- СТАТЬЯ WIKI: ${page.title} (Оригинальная ссылка: ${page.url}) ---\n${cleanText.substring(0, 30000)}\n`;
                } catch (e) {
                    console.error("[DEBUG] Ошибка при чтении статьи:", e);
                }
            }

            // ЛИЧНАЯ БАЗА ИЗ ОБЛАКА
            let personalContext = "";
            const cloudKnowledge = await getKnowledge(); 
            if (cloudKnowledge.length > 0) {
                const searchWords = userQuery.toLowerCase().split(' ').filter(w => w.length > 3);
                let relevantRecords = cloudKnowledge.filter(k => {
                    const textLower = k.text.toLowerCase();
                    return searchWords.some(word => textLower.includes(word));
                });
                if (relevantRecords.length === 0) relevantRecords = cloudKnowledge.slice(-10);
                else relevantRecords = relevantRecords.slice(-15);

                const recentKnowledge = relevantRecords.map(k => k.text).join('\n---\n');
                personalContext = `\n--- ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА (САМЫЙ ВЫСОКИЙ ПРИОРИТЕТ!) ---\n${recentKnowledge}\n`;
            }

            let visionMessages = [];
            if (message.attachments.size > 0) {
                const attachment = message.attachments.first(); 
                if (attachment.contentType && attachment.contentType.startsWith('image/')) {
                    await processingMsg.edit('⏳ *Смотрю на картинку своими AI-глазами... 👀*');
                    visionMessages = [
                        { type: "text", text: `Вопрос: ${userQuery}` },
                        { type: "image_url", image_url: { url: attachment.url, detail: "high" } }
                    ];
                } else {
                    visionMessages = [{ type: "text", text: `Вопрос: ${userQuery}. (Файл не картинка)` }];
                }
            } else {
                visionMessages = [{ type: "text", text: `Вопрос: ${userQuery}` }];
            }

            const systemPrompt = `
 Ты AI-помощник для АГЕНТОВ ТЕХПОДДЕРЖКИ. 
 У тебя есть ДВА источника знаний:
 1. ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА (самый высокий приоритет).
 2. СТАТЬИ ИЗ WIKI.JS.
 
 ПРАВИЛА:
 - Отвечай строго на вопрос, опираясь НА ЭТИ ТЕКСТЫ.${previousContext}
 - Если ответа нет - скажи "Информация не найдена". Не выдумывай.
 - Форматируй ответ в стиле DISCORD MARKDOWN.
 - ЕСЛИ используешь Wiki, добавь в конец ответа "Оригинальную ссылку". НИКОГДА не генерируй ссылки сам!
 
 ИСТОЧНИКИ ДАННЫХ:
 ${personalContext}
 ${wikiContext}`;

            let apiMessages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: visionMessages } 
            ];
            
            let finalAnswer = await askOpenAI(apiMessages, 0.2);

            if (finalAnswer.length > 1800) {
                finalAnswer = finalAnswer.substring(0, 1800) + "...\n*(Ответ обрезан из-за лимитов Discord)*";
            }

            // Добавляем предупреждение о куки, если оно сработало
            await processingMsg.edit(finalAnswer + cookieWarning);

        } catch (error) {
            await processingMsg.edit(`❌ Ошибка: ${error.message}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
