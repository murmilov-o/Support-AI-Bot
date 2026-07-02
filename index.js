const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
const express = require('express');
const cheerio = require('cheerio'); 

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

// --- 3. ФУНКЦИИ OPENAI И WIKI (Бронебойный поиск) ---
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

async function fetchWikiGraphQL(searchQuery) {
    if (!WIKI_URL || WIKI_URL.includes("undefined")) return []; 
    const WIKI_COOKIE = process.env.WIKI_COOKIE || ""; 
    const headers = { 'Content-Type': 'application/json' };
    if (WIKI_COOKIE) headers['Cookie'] = WIKI_COOKIE;

    let allResults = [];

    try {
        const tagToSearch = searchQuery.toLowerCase().trim();
        
        // 1. Секретный поиск по ТЕГАМ (обходим языковые барьеры)
        const tagRes = await fetch(`${WIKI_URL}/graphql`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify([{
                operationName: null,
                variables: { locale: null, tags: [tagToSearch] },
                extensions: {},
                query: "query ($limit: Int, $orderBy: PageOrderBy, $orderByDirection: PageOrderByDirection, $tags: [String!], $locale: String) {\n  pages {\n    list(limit: $limit, orderBy: $orderBy, orderByDirection: $orderByDirection, tags: $tags, locale: $locale) {\n      id\n      locale\n      path\n      title\n      description\n      tags\n    }\n  }\n}\n"
            }])
        });
        const tagData = await tagRes.json();
        const tagResults = tagData[0]?.data?.pages?.list || [];
        if (tagResults.length > 0) allResults = allResults.concat(tagResults);

        // 2. Текстовый поиск с принудительным RU
        const textResRu = await fetch(`${WIKI_URL}/graphql`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify([{
                operationName: null,
                variables: { query: searchQuery },
                extensions: {},
                query: "query ($query: String!) {\n  pages {\n    search(query: $query, locale: \"ru\") {\n      results {\n        id\n        title\n        path\n      }\n    }\n  }\n}\n"
            }])
        });
        const textDataRu = await textResRu.json();
        const textResultsRu = textDataRu[0]?.data?.pages?.search?.results || [];
        if (textResultsRu.length > 0) allResults = allResults.concat(textResultsRu);

        return allResults;
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
        GatewayIntentBits.DirectMessages 
    ],
    partials: [Partials.Message, Partials.Channel] 
});

client.once('clientReady', (c) => {
    console.log(`🤖 Бот успешно авторизован как ${c.user.tag}`);
    client.user.setActivity({ name: 'на твои скрины 👀', type: ActivityType.Watching });
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const NEWS_CHANNEL_ID = '1515056485128867963';
    if (message.channel.id === NEWS_CHANNEL_ID) {
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
            } catch (err) {}
        }
        return; 
    }

    const isDirectMessage = !message.guild; 
    const isReplyToBot = message.reference && message.mentions.has(client.user);
    const hasPrefix = message.content.startsWith('!');

    if (!isDirectMessage && !hasPrefix && !isReplyToBot) return;

    let userQuery = message.content.replace('!ask', '').replace('!learn', '').replace(`<@${client.user.id}>`, '').trim();
    let command = hasPrefix ? message.content.slice(1).split(' ')[0].toLowerCase() : 'ask';

    if (command === 'learn' && hasPrefix) {
        if (!userQuery) return message.reply('❌ Напиши текст, который мне нужно запомнить.');
        await saveKnowledge(userQuery);
        await message.react('💾'); 
        return message.reply('✅ Успешно сохранил в личную базу!');
    }

    if (command === 'ask' || isDirectMessage || isReplyToBot) {
        const processingMsg = await message.reply('⏳ *Анализирую запрос...*');

        try {
            let previousContext = "";
            let searchContext = userQuery;

            if (message.reference && message.reference.messageId) {
                try {
                    const repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
                    if (repliedMsg.author.id === client.user.id) {
                        previousContext = `\nПредыдущий ответ бота: "${repliedMsg.content}"\nУчитывай его.`;
                        searchContext = `${userQuery} ${repliedMsg.content.substring(0, 50)}`; 
                    }
                } catch(e) {}
            }

            let topArticles = [];
            let queryVariations = [];
            
            // ЖЕСТКИЙ ПЕРЕХВАТ ПРЯМОЙ ССЫЛКИ (Исправлено чтение ссылок с мусором вокруг)
            const urlMatch = userQuery.match(/(https?:\/\/wiki\.nadoje\.com[^\s>]+)/i);

            if (urlMatch) {
                const directUrl = urlMatch[1];
                await processingMsg.edit(`⏳ *Вижу прямую ссылку! Иду читать статью напрямую...*`);
                topArticles.push({ url: directUrl, title: "Статья по прямой ссылке" });
            } else {
                const translatePrompt = `Запрос пользователя: "${searchContext}".
ВНИМАНИЕ: Исправляй опечатки и русский сленг. 
Сгенерируй 4 тега для поиска в Wiki:
1. Вероятная полная фраза
2. Только главное слово 1
3. Только главное слово 2
4. Связанный термин.
Верни ТОЛЬКО 4 варианта через запятую, без нумерации и кавычек.`;

                let smartQueryText = await askOpenAI([
                    { role: "system", content: "Генератор тегов. Исправляй опечатки." },
                    { role: "user", content: translatePrompt }
                ], 0.1);

                queryVariations = smartQueryText.split(',').map(s => s.trim()).filter(s => s.length > 0);
                if (userQuery.length > 3) queryVariations.push(userQuery);

                await processingMsg.edit(`⏳ *Ищу в Wiki по тегам: \`${queryVariations.join(' | ')}\`...*`);

                const fetchPromises = queryVariations.map(q => fetchWikiGraphQL(q));
                const resultsArray = await Promise.all(fetchPromises);
                
                const combinedResults = resultsArray.flat();
                const uniqueResults = [];
                const seenPaths = new Set();
                for (const item of combinedResults) {
                    if (item && item.path && !seenPaths.has(item.path)) {
                        seenPaths.add(item.path);
                        item.url = `${WIKI_URL}/${item.path}`;
                        uniqueResults.push(item);
                    }
                }

                topArticles = uniqueResults.slice(0, 6); 
                
                if (topArticles.length === 0) {
                    await processingMsg.edit(`❌ *Wiki.js вернула 0 результатов. Если знаешь ссылку на статью, просто скинь её мне!*`);
                    return;
                }
            }

            let wikiContext = "";
            let cookieWarning = ""; 
            const WIKI_COOKIE = process.env.WIKI_COOKIE || ""; 

            for (const page of topArticles) {
                try {
                    const fetchHeaders = {};
                    if (WIKI_COOKIE) fetchHeaders['Cookie'] = WIKI_COOKIE;

                    const pageRes = await fetch(page.url, { headers: fetchHeaders });
                    let pageHtml = await pageRes.text();
                    
                    if (pageHtml.toLowerCase().includes('name="password"') || pageHtml.toLowerCase().includes('login')) {
                        cookieWarning = "\n\n⚠️ **Внимание:** Мой Cookie для Wiki.js истек! Обновите `WIKI_COOKIE` на Railway.";
                        break; 
                    }

                    const $ = cheerio.load(pageHtml);
                    $('script, style, nav, footer, header, .sidebar, .menu').remove();
                    let cleanText = $('body').text().replace(/\s+/g, ' ').trim();
                    
                    wikiContext += `\n--- СТАТЬЯ WIKI: ${page.title} (Оригинальная ссылка: ${page.url}) ---\n${cleanText.substring(0, 15000)}\n`;
                } catch (e) {
                    console.error("[DEBUG] Ошибка при чтении статьи:", e);
                }
            }

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
                personalContext = `\n--- ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА ---\n${recentKnowledge}\n`;
            }

            const systemPrompt = `
 Ты AI-помощник для АГЕНТОВ ТЕХПОДДЕРЖКИ. 
 У тебя есть ДВА источника знаний:
 1. ЛИЧНЫЕ ЗАМЕТКИ АГЕНТА.
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
                { role: "user", content: `Вопрос пользователя: ${userQuery}` } 
            ];
            
            let finalAnswer = await askOpenAI(apiMessages, 0.2);

            if (finalAnswer.length > 1800) {
                finalAnswer = finalAnswer.substring(0, 1800) + "...\n*(Ответ обрезан из-за лимитов Discord)*";
            }

            await processingMsg.edit(finalAnswer + cookieWarning);

        } catch (error) {
            await processingMsg.edit(`❌ Ошибка: ${error.message}`);
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
