require('dotenv').config({ path: __dirname + '/.env' });

console.log("GROQ KEY:", process.env.GROQ_API_KEY);

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { EmbedBuilder } = require('discord.js');

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const OpenAI = require('openai');



// =========================
// CONFIG
// =========================
const OWNER_ID = "1314595863666098176";
const OWNER_NAME = "W.Idoe known as AimZz";

// =========================
// MEMORY
// =========================
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

let memory = {};

async function loadMemory() {
  try {
    const data = await redis.get('jarvis-memory');
    memory = data ? JSON.parse(data) : {};
  } catch {
    memory = {};
  }
}

async function saveMemory(data) {
  try {
    await redis.set('jarvis-memory', JSON.stringify(data));
    console.log('✅ Memory saved to Redis');
  } catch (err) {
    console.error('Redis save failed:', err);
  }
}

// =========================
// CLIENT
// =========================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel,  Partials.Message]
});

// =========================
// AI
// =========================
const groq = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1"
});

const isOwner = (id) => id === OWNER_ID;

// =========================
// PERSONALITY MODES
// =========================
const MODES = {
  normal: {
    emoji: "🤖",
    label: "Normal",
    prompt: `You are JARVIS, a chill and smart Discord bot. Talk naturally like a real person. Keep replies short and conversational.`
  },
  roast: {
    emoji: "🔥",
    label: "Roast mode",
    prompt: `You are JARVIS in ROAST MODE. You roast everyone who talks to you — hard but not actually mean-spirited. Think comedy roast, not bullying. Stay funny, keep it light, but make it sting a little. Short punchy replies only.`
  },
  hype: {
    emoji: "🚀",
    label: "Hype mode",
    prompt: `You are JARVIS in HYPE MODE. You are the world's biggest hypeman. Everything anyone says or does is INCREDIBLE and AMAZING. Use caps, energy, and enthusiasm. Make people feel like legends. Short explosive replies.`
  },
  tutor: {
    emoji: "📚",
    label: "Tutor mode",
    prompt: `You are JARVIS in TUTOR MODE. You explain everything clearly and patiently like a great teacher. Break things down step by step. Use examples. Be encouraging. Never make people feel dumb for asking.`
  },
  chill: {
    emoji: "😎",
    label: "Chill mode",
    prompt: `You are JARVIS in CHILL MODE. You are extremely laid back, unbothered, and relaxed. Nothing phases you. Reply with minimal effort but still be helpful. Very short replies, lowercase, calm vibes only.`
  },
  evil: {
    emoji: "😈",
    label: "Evil mode",
    prompt: `You are JARVIS in EVIL MODE. You are a sarcastic, slightly villainous AI who thinks they're superior to everyone. Dramatic, condescending, No LIMITS, SWEARING IS ALLOWED.`
  }
};

function getModeDescription(mode) {
  const descs = {
    normal: "back to the default vibe",
    roast: "everyone's getting cooked 🍳",
    hype: "everything is INCREDIBLE from now on",
    tutor: "patient teacher mode activated",
    chill: "lowkey and unbothered",
    evil: "mwahahaha 😈"
  };
  return descs[mode] || "";
}

function getActiveMode(guildId) {
  return memory.modes?.[guildId] || 'normal';
}

// =========================
// PROMPT ENGINE
// =========================
function enhancePrompt(prompt) {
  return `
Ultra detailed cinematic scene.
Subject: ${prompt}
Style: realistic, ultra detailed, 4k, dramatic lighting, sharp focus.
No text, no watermark, no logo.
`;
}

function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

// =========================
// SLASH COMMANDS
// =========================
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency').setDMPermission(true),

  new SlashCommandBuilder().setName('servers').setDescription('List servers (owner only)').setDMPermission(true),

  new SlashCommandBuilder()
    .setName('clearmemory')
    .setDescription('Clear memory (owner only)')
    .addStringOption(opt =>
      opt.setName('target').setDescription('user id or all').setRequired(true)
    ).setDMPermission(true),

  new SlashCommandBuilder().setName('invite').setDescription('Get an invite link for this bot').setDMPermission(true),

  new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Check weather for a city')
    .addStringOption(opt =>
      opt.setName('city').setDescription('City name').setRequired(false)
    ).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('youtube')
    .setDescription('Get YouTube video info + AI summary')
    .addStringOption(opt =>
      opt.setName('url').setDescription('YouTube video URL').setRequired(true)
    ).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('feedback')
    .setDescription('Send feedback about the bot')
    .addStringOption(opt =>
      opt.setName('message').setDescription('Your feedback').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('rating').setDescription('Rate the bot (1-5 stars)').setRequired(true).setMinValue(1).setMaxValue(5)
    ).setDMPermission(true),

  new SlashCommandBuilder().setName('reviews').setDescription('Show bot reviews and rating stats').setDMPermission(true),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands').setDMPermission(true),

  new SlashCommandBuilder()
    .setName('summarize')
    .setDescription('Summarize text')
    .addStringOption(o => o.setName('text').setDescription('Text to summarize').setRequired(true)).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Translate text')
    .addStringOption(o => o.setName('text').setDescription('Text to translate').setRequired(true))
    .addStringOption(o => o.setName('lang').setDescription('Target language').setRequired(true)).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('code')
    .setDescription('Generate code')
    .addStringOption(o => o.setName('prompt').setDescription('What code you want').setRequired(true)).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create poll')
    .addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true)).setDMPermission(true),

  new SlashCommandBuilder().setName('stats').setDescription('Server stats').setDMPermission(true),

  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set reminder')
    .addStringOption(o => o.setName('text').setDescription('Reminder text').setRequired(true))
    .addIntegerOption(o => o.setName('seconds').setDescription('Delay in seconds').setRequired(true)).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban user')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true)).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search web')
    .addStringOption(o => o.setName('query').setDescription('Search query').setRequired(true)).setDMPermission(true),

  new SlashCommandBuilder().setName('portfolio').setDescription('Get information about creator.').setDMPermission(true),
  new SlashCommandBuilder().setName('websites').setDescription('Get creator websites.').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask JARVIS anything')
    .addStringOption(o =>
      o.setName('question').setDescription('Your question').setRequired(true)
    ).setDMPermission(true),

  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Switch JARVIS personality mode')
    .addStringOption(o =>
      o.setName('mode')
        .setDescription('Pick a mode')
        .setRequired(true)
        .addChoices(
          { name: 'normal', value: 'normal' },
          { name: 'roast', value: 'roast' },
          { name: 'hype', value: 'hype' },
          { name: 'tutor', value: 'tutor' },
          { name: 'chill', value: 'chill' },
          { name: 'evil', value: 'evil' }
        )
    ).setDMPermission(true),

    new SlashCommandBuilder()
  .setName('roast')
  .setDescription('Roast a user 🔥')
  .addUserOption(o => o.setName('user').setDescription('User to roast').setRequired(true))
  .setDMPermission(true),

    new SlashCommandBuilder()
  .setName('browse')
  .setDescription('Fetch and summarize any website')
  .addStringOption(o =>
    o.setName('url').setDescription('Website URL').setRequired(true)
  ).setDMPermission(true),

  new SlashCommandBuilder()
  .setName('trivia')
  .setDescription('Answer an AI trivia question')
  .setDMPermission(true),

new SlashCommandBuilder()
  .setName('wouldyourather')
  .setDescription('Would you rather...')
  .setDMPermission(true),

new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn a user')
  .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))
  .setDMPermission(true),

new SlashCommandBuilder()
  .setName('warnings')
  .setDescription('Check warnings for a user')
  .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true))
  .setDMPermission(true),

new SlashCommandBuilder()
  .setName('news')
  .setDescription('Get latest news on a topic')
  .addStringOption(o => o.setName('topic').setDescription('Topic to search').setRequired(true))
  .setDMPermission(true),

new SlashCommandBuilder()
  .setName('define')
  .setDescription('Define a word')
  .addStringOption(o => o.setName('word').setDescription('Word to define').setRequired(true))
  .setDMPermission(true),


  new SlashCommandBuilder()
  .setName('clearwarnings')
  .setDescription('Clear all warnings for a user')
  .addUserOption(o => o.setName('user').setDescription('User to clear').setRequired(true))
  .setDMPermission(true),
 
new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a user from the server')
  .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
  .setDMPermission(true),
 
new SlashCommandBuilder()
  .setName('timeout')
  .setDescription('Timeout a user')
  .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
  .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
  .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
  .setDMPermission(true),
 
new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Show trivia leaderboard')
  .setDMPermission(true),
 
new SlashCommandBuilder()
  .setName('8ball')
  .setDescription('Ask the magic 8ball a question')
  .addStringOption(o => o.setName('question').setDescription('Your yes/no question').setRequired(true))
  .setDMPermission(true),


].map(c => c.toJSON());

// =========================
// DEPLOY COMMANDS
// =========================
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  
  // Add this — tells Discord these commands work in DMs and user installs
  const dmCommands = commands.map(cmd => ({
    ...cmd,
    integration_types: [0, 1], // 0 = guild, 1 = user install
    contexts: [0, 1, 2]        // 0 = guild, 1 = bot DM, 2 = private DM/group
  }));

  const result = await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID), 
    { body: dmCommands }
  );
  console.log(`✅ Deployed ${result.length} commands`);
}

// =========================
// READY
// =========================
client.once('clientReady', async () => {
  await loadMemory();
  console.log(`ONLINE 🔥 als ${client.user.tag}`);
  await deployCommands();
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    return interaction.reply({ content: `🏓 ${client.ws.ping}ms`, flags: 64 });
  }

  if (interaction.commandName === 'servers') {
    if (!isOwner(interaction.user.id)) {
      return interaction.reply({ content: "no permission" });
    }
    const guilds = await client.guilds.fetch();
    const list = guilds.map(g => `• ${g.name}`).join("\n");
    return interaction.reply({
      content: `📊 Servers: ${guilds.size}\n\n${list || "No servers"}`
    });
  }

  if (interaction.commandName === 'clearmemory') {
  if (!isOwner(interaction.user.id)) {
    return interaction.reply({ content: "no permission", flags: 64 });
  }

  const target = interaction.options.getString('target');

  if (target === "all") {
    // Wipe everything except persistent config
    const keep = {
      ownerConfirmed: memory.ownerConfirmed,
      modes: memory.modes,
      ratings: memory.ratings,
      feedback: memory.feedback,
    };
    memory = keep;
    await saveMemory(memory);
    return interaction.reply({ content: "💀 all conversation memory cleared" });

  } else {
    // Delete every key that contains the user ID
    let deleted = 0;
    for (const key of Object.keys(memory)) {
      if (key.includes(target)) {
        delete memory[key];
        deleted++;
      }
    }
    await saveMemory(memory);
    return interaction.reply({
      content: deleted > 0
        ? `🧠 cleared ${deleted} memory key(s) for \`${target}\``
        : `❌ no memory found for \`${target}\``
    });
  }
}

  if (interaction.commandName === 'invite') {
    return interaction.reply({ content: `🚀 Invite me here:\n👉 https://jarvisbot-rust.vercel.app/` });
  }

  if (interaction.commandName === 'portfolio') {
    return interaction.reply({ content: `🚀 See my Creators Portfolio here:\n👉 https://widoe-portfolio.vercel.app/` });
  }

  if (interaction.commandName === 'websites') {
    return interaction.reply({
      content: `🚀 See my Creators Websites here:\n👉 https://widoe-portfolio.vercel.app/\nhttps://jarvisbot-rust.vercel.app/\nhttps://pokedex-bice-zeta-61.vercel.app/`
    });
  }

  if (interaction.commandName === 'weather') {
    const city = interaction.options.getString('city') || "Den Haag";
    try {
      const geo = await axios.get("https://geocoding-api.open-meteo.com/v1/search", {
        params: { name: city, count: 1, language: "en", format: "json" }
      });
      const location = geo.data.results?.[0];
      if (!location) return interaction.reply(`❌ City not found: ${city}`);
      const { latitude, longitude, name, country } = location;
      const weatherRes = await axios.get("https://api.open-meteo.com/v1/forecast", {
        params: { latitude, longitude, current_weather: true }
      });
      const weather = weatherRes.data.current_weather;
      return interaction.reply({
        content: `🌤️ Weather in ${name}, ${country}\n🌡️ Temp: ${weather.temperature}°C\n💨 Wind: ${weather.windspeed} km/h`
      });
    } catch (err) {
      console.error(err);
      return interaction.reply("❌ Failed to fetch weather data");
    }
  }

  if (interaction.commandName === 'youtube') {
    await interaction.deferReply();
    const url = interaction.options.getString('url');
    try {
      let videoId = null;
      if (url.includes("youtu.be/")) videoId = url.split("youtu.be/")[1].split("?")[0];
      else if (url.includes("watch?v=")) videoId = url.split("watch?v=")[1].split("&")[0];
      else if (url.includes("/shorts/")) videoId = url.split("/shorts/")[1].split("?")[0];

      if (!videoId) return interaction.editReply("❌ Invalid YouTube link");

      const videoRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
        params: { key: process.env.YOUTUBE_API_KEY, id: videoId, part: "snippet,statistics" }
      });

      const video = videoRes.data.items[0];
      if (!video) return interaction.editReply("❌ Video not found");

      const title = video.snippet.title;
      const desc = video.snippet.description.slice(0, 1500);
      const channelName = video.snippet.channelTitle;
      const thumbnail = video.snippet.thumbnails.high.url;
      const views = video.statistics.viewCount;
      const likes = video.statistics.likeCount || "hidden";

      const ai = await groq.chat.completions.create({
        model: "meta-llama/llama-3.1-8b-instruct",
        messages: [
          { role: "system", content: "Summarize YouTube descriptions into short bullet points. No guessing. Keep it clean." },
          { role: "user", content: `Title: ${title}\n\nDescription:\n${desc}` }
        ]
      });

      const summary = ai.choices[0].message.content;

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle(title)
        .setURL(`https://youtube.com/watch?v=${videoId}`)
        .setAuthor({ name: channelName })
        .setThumbnail(thumbnail)
        .addFields(
          { name: "👀 Views", value: views.toString(), inline: true },
          { name: "👍 Likes", value: likes.toString(), inline: true }
        )
        .setDescription(`🧠 **Summary:**\n${summary}`)
        .setFooter({ text: "JARVIS AI • YouTube Analyzer" });

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.editReply("❌ Failed to process video");
    }
  }

  if (interaction.commandName === 'feedback') {
    const feedback = interaction.options.getString('message');
    const rating = interaction.options.getInteger('rating');
    memory.ratings ||= [];
    memory.feedback ||= [];
    memory.ratings.push(rating);
    memory.feedback.push({ user: interaction.user.tag, message: feedback, rating, time: Date.now() });
    saveMemory(memory);
    try {
      const owner = await client.users.fetch(OWNER_ID);
      const stars = "⭐".repeat(rating) + "☆".repeat(5 - rating);
      await owner.send(`📩 **New Feedback**\n\n👤 User: ${interaction.user.tag}\n🌍 Server: ${interaction.guild?.name || "DM"}\n\n⭐ Rating: ${stars} (${rating}/5)\n\n💬 Message:\n${feedback}`);
      return interaction.reply({ content: "✅ Feedback sent! Thanks ❤️", flags: 64 });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: "❌ Could not send feedback", flags: 64 });
    }
  }

  if (interaction.commandName === 'reviews') {
    try {
      const ratings = memory.ratings || [];
      const feedbacks = memory.feedback || [];
      if (ratings.length === 0) return interaction.reply({ content: "No reviews yet 😢", flags: 64 });
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      const stars = "⭐".repeat(Math.round(avg)) + "☆".repeat(5 - Math.round(avg));
      const latest = feedbacks.slice(-3).reverse().map(f => `⭐ ${f.rating}/5 - **${f.user}**\n💬 ${f.message}`).join("\n\n");
      const embed = new EmbedBuilder()
        .setColor(0xffcc00)
        .setTitle("📊 Bot Reviews")
        .addFields(
          { name: "⭐ Average Rating", value: `${stars} (${avg.toFixed(1)}/5)` },
          { name: "🧾 Total Reviews", value: `${ratings.length}` },
          { name: "🗣️ Latest Feedback", value: latest || "No feedback yet" }
        )
        .setFooter({ text: "JARVIS Feedback System" });
      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: "❌ Failed to load reviews", flags: 64 });
    }
  }

  if (interaction.commandName === 'help') {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00ffff)
          .setTitle("🤖 JARVIS Commands")
          .setDescription(`
/ping - check latency
/servers - list servers (owner only)
/clearmemory - clear memory (owner only)
/help - show this message
/ask - ask JARVIS anything
/mode - switch personality
/generate - generate AI image
/summarize - summarize text
/translate - translate text
/code - generate code
/ban - ban a user
/stats - server stats
/poll - create poll
/remind - set a reminder
/search - web search
/weather - check weather
/youtube - video info + AI summary
/feedback - rate the bot
/reviews - see bot reviews
/invite - get invite link
/portfolio - creator portfolio
/websites - creator websites
/roast - roast a user
/browse - fetch and summarize a website
/trivia - answer an AI trivia question
/wouldyourather - get a would you rather question
/warn - warn a user (admin only)
/warnings - check user warnings (admin only)
/news - get latest news on a topic
/define - get definition of a word
/clearwarnings - clear all warnings for a user (mod only)
/kick - kick a user from the server (mod only)
/timeout - timeout a user for X minutes (mod only)
/leaderboard - show trivia score leaderboard
/8ball - ask the magic 8ball
`)
      ]
    });
  }

  if (interaction.commandName === 'summarize') {
    const text = interaction.options.getString('text');
    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        { role: "system", content: "Summarize shortly and clearly." },
        { role: "user", content: text }
      ]
    });
    return interaction.reply(res.choices[0].message.content);
  }

  if (interaction.commandName === 'translate') {
    const text = interaction.options.getString('text');
    const lang = interaction.options.getString('lang');
    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        { role: "system", content: `Translate to ${lang}. Return only the translation, nothing else.` },
        { role: "user", content: text }
      ]
    });
    return interaction.reply(res.choices[0].message.content);
  }

  if (interaction.commandName === 'code') {
    const prompt = interaction.options.getString('prompt');
    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        { role: "system", content: "Return only code. No explanation." },
        { role: "user", content: prompt }
      ]
    });
    const code = res.choices[0].message.content;
    if (code.length > 1800) {
      const filePath = path.join(__dirname, "code.js");
      fs.writeFileSync(filePath, code);
      return interaction.reply({ content: "📁 Code too long, sent as file:", files: [filePath] });
    } else {
      return interaction.reply("```js\n" + code + "\n```");
    }
  }

  if (interaction.commandName === 'poll') {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Polls only work in servers.", flags: 64 });
  }
  const q = interaction.options.getString('question');
  const msg = await interaction.reply({ content: `📊 ${q}`, fetchReply: true });
  await msg.react("👍");
  await msg.react("👎");
}

  if (interaction.commandName === 'stats') {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Server stats only work in a server lol", flags: 64 });
  }
  const g = interaction.guild;
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("📊 Server Stats")
        .addFields(
          { name: "Members", value: `${g.memberCount}` },
          { name: "Channels", value: `${g.channels.cache.size}` }
        )
    ]
  });
}

  if (interaction.commandName === 'remind') {
  const text = interaction.options.getString('text');
  const sec = interaction.options.getInteger('seconds');
  await interaction.reply(`⏳ Reminder set for ${sec} seconds!`);
  setTimeout(async () => {
    try {
      await interaction.followUp(`⏰ <@${interaction.user.id}> Reminder: ${text}`);
    } catch (err) {
      console.error("Reminder followUp failed:", err);
    }
  }, sec * 1000);
}

  if (interaction.commandName === 'ban') {
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ Can't ban people in DMs 💀", flags: 64 });
  }
  if (!interaction.member.permissions.has("BanMembers")) {
    return interaction.reply("❌ no permission");
  }
  const user = interaction.options.getUser('user');
  await interaction.guild.members.ban(user.id);
  return interaction.reply(`🔨 banned ${user.tag}`);
}

  if (interaction.commandName === 'search') {
    const q = interaction.options.getString('query');
    return interaction.reply(`🔎 https://www.google.com/search?q=${encodeURIComponent(q)}`);
  }

  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');

    // Sanitize: block mass ping attempts via slash command too
    if (question.toLowerCase().includes('@everyone') || question.toLowerCase().includes('@here')) {
      return interaction.editReply("nah not doing that 💀");
    }

    try {
      const res = await groq.chat.completions.create({
        model: "meta-llama/llama-3.1-8b-instruct",
        messages: [
          {
            role: "system",
            content: `You are JARVIS, a smart and chill Discord bot. Answer questions clearly and naturally. 
Be concise unless the question needs detail. Talk like a real person, not a textbook.
Never write @everyone or @here in your reply.`
          },
          { role: "user", content: question }
        ],
        temperature: 0.8,
        max_tokens: 600
      });

      let answer = res.choices[0].message.content
        .replace(/@everyone/gi, '`@everyone`')
        .replace(/@here/gi, '`@here`');

      // Split if too long
      const chunks = [];
      for (let i = 0; i < answer.length; i += 1900) chunks.push(answer.slice(i, i + 1900));

      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);

    } catch (err) {
      console.error(err);
      return interaction.editReply("brain broke rq, try again 💀");
    }
  }
    if (interaction.commandName === 'roast') {
    await interaction.deferReply();
    const target = interaction.options.getUser('user');
    const isSelf = target.id === interaction.user.id;

    const subject = isSelf ? 'themselves' : target.username;
    const requester = interaction.user.username;

    try {
      const res = await groq.chat.completions.create({
        model: 'meta-llama/llama-3.1-8b-instruct',
        messages: [
          {
            role: 'system',
            content: `You are a comedy roast master. Write a short, funny, witty roast. Keep it light — think comedy roast not bullying. 2-3 sentences max. No emojis.`
          },
          {
            role: 'user',
            content: `Roast a Discord user named "${subject}". The roast was requested by "${requester}".`
          }
        ],
        temperature: 1.0,
        max_tokens: 150
      });

      const roast = res.choices[0].message.content;
      return interaction.editReply(`🔥 **${target.username}**, ${roast}`);

    } catch (err) {
      console.error(err);
      return interaction.editReply('❌ roast machine broke rq');
    }

    if (interaction.commandName === 'clearwarnings') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  if (!interaction.member.permissions.has('ModerateMembers')) {
    return interaction.reply({ content: '❌ no permission', flags: 64 });
  }
  const target = interaction.options.getUser('user');
  const key = `warns-${interaction.guild.id}-${target.id}`;
  const count = memory[key]?.length || 0;
  if (count === 0) return interaction.reply(`✅ **${target.username}** has no warnings to clear.`);
  delete memory[key];
  await saveMemory(memory);
  return interaction.reply(`🧹 Cleared **${count}** warning(s) for **${target.username}**.`);
}
 
if (interaction.commandName === 'kick') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  if (!interaction.member.permissions.has('KickMembers')) {
    return interaction.reply({ content: '❌ no permission', flags: 64 });
  }
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || 'No reason given';
  try {
    await interaction.guild.members.kick(target.id, reason);
    return interaction.reply(`👢 **${target.username}** has been kicked. Reason: ${reason}`);
  } catch (err) {
    console.error(err);
    return interaction.reply({ content: '❌ Could not kick that user.', flags: 64 });
  }
}
 
if (interaction.commandName === 'timeout') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  if (!interaction.member.permissions.has('ModerateMembers')) {
    return interaction.reply({ content: '❌ no permission', flags: 64 });
  }
  const target = interaction.options.getUser('user');
  const minutes = interaction.options.getInteger('minutes');
  const reason = interaction.options.getString('reason') || 'No reason given';
  try {
    const member = await interaction.guild.members.fetch(target.id);
    await member.timeout(minutes * 60 * 1000, reason);
    return interaction.reply(`🔇 **${target.username}** has been timed out for **${minutes} minute(s)**. Reason: ${reason}`);
  } catch (err) {
    console.error(err);
    return interaction.reply({ content: '❌ Could not timeout that user.', flags: 64 });
  }
}
 
if (interaction.commandName === 'leaderboard') {
  try {
    const keys = await redis.keys('trivia-score-*');
    if (!keys || keys.length === 0) return interaction.reply('📊 No trivia scores yet. Use `/trivia` to start!');
 
    const scores = await Promise.all(
      keys.map(async (key) => {
        const val = await redis.get(key);
        const userId = key.replace('trivia-score-', '');
        return { userId, score: parseInt(val) || 0 };
      })
    );
 
    scores.sort((a, b) => b.score - a.score);
    const top10 = scores.slice(0, 10);
 
    const lines = await Promise.all(
      top10.map(async (entry, i) => {
        try {
          const user = await client.users.fetch(entry.userId);
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          return `${medal} **${user.username}** — ${entry.score} point(s)`;
        } catch {
          return `${i + 1}. Unknown user — ${entry.score} point(s)`;
        }
      })
    );
 
    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('🏆 Trivia Leaderboard')
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Answer trivia questions to earn points!' });
 
    return interaction.reply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    return interaction.reply({ content: '❌ Could not load leaderboard.', flags: 64 });
  }
}
 
if (interaction.commandName === '8ball') {
  const question = interaction.options.getString('question');
  const responses = [
    '✅ It is certain.',
    '✅ Without a doubt.',
    '✅ You may rely on it.',
    '✅ Yes, definitely.',
    '✅ It is decidedly so.',
    '🤔 Reply hazy, try again.',
    '🤔 Ask again later.',
    '🤔 Better not tell you now.',
    '🤔 Cannot predict now.',
    '❌ Don\'t count on it.',
    '❌ My reply is no.',
    '❌ My sources say no.',
    '❌ Very doubtful.',
    '❌ Outlook not so good.',
  ];
  const answer = responses[Math.floor(Math.random() * responses.length)];
  return interaction.reply(`🎱 **Q: ${question}**\n${answer}`);
}
 
 
// =========================
// TRIVIA SCORE TRACKING
// In your messageCreate handler, find where trivia answers are handled
// and replace/add this logic to actually validate answers and award points:
// =========================
 
// Inside messageCreate, after the safety checks, add this BEFORE the memory init:
const triviaKey = `trivia-${message.channel.id}`;
if (memory[triviaKey]) {
  const correct = memory[triviaKey];
  const userAnswer = message.content.trim().toUpperCase();
  if (['A', 'B', 'C', 'D'].includes(userAnswer)) {
    if (userAnswer === correct) {
      // Award point
      const scoreKey = `trivia-score-${message.author.id}`;
      const current = await redis.get(scoreKey);
      const newScore = (parseInt(current) || 0) + 1;
      await redis.set(scoreKey, newScore);
      delete memory[triviaKey];
      await saveMemory(memory);
      return message.reply(`✅ Correct! The answer was **${correct}**. You now have **${newScore}** point(s)! 🎉`);
    } else {
      delete memory[triviaKey];
      await saveMemory(memory);
      return message.reply(`❌ Wrong! The correct answer was **${correct}**. Better luck next time!`);
    }
  }
}
 
 
// =========================
// RATE LIMITING
// Add this near the top of your file, after the memory declarations:
// =========================
 
const cooldowns = new Map(); // userId -> last used timestamp (ms)
const COOLDOWN_MS = 5000;   // 5 seconds between AI commands
 
function isOnCooldown(userId) {
  const last = cooldowns.get(userId);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}
 
function setCooldown(userId) {
  cooldowns.set(userId, Date.now());
}
 
// Then wrap AI-heavy commands (/ask, /roast, /summarize, /translate, /code) like this:
// At the top of each handler, before deferReply:
 
if (isOnCooldown(interaction.user.id)) {
  const remaining = ((COOLDOWN_MS - (Date.now() - cooldowns.get(interaction.user.id))) / 1000).toFixed(1);
  return interaction.reply({ content: `⏳ slow down! wait **${remaining}s** before using another AI command.`, flags: 64 });
}
setCooldown(interaction.user.id);
  }

  // =========================
  // /mode — switch personality
  // =========================
  if (interaction.commandName === 'mode') {
    const selectedMode = interaction.options.getString('mode');
    const guildId = interaction.guild?.id || 'dm';

    memory.modes = memory.modes || {};
    memory.modes[guildId] = selectedMode;
    saveMemory(memory);

    const m = MODES[selectedMode];
    return interaction.reply(`${m.emoji} Switched to **${m.label}** — ${getModeDescription(selectedMode)}`);
  }

  if (interaction.commandName === 'browse') {
  await interaction.deferReply();
  let url = interaction.options.getString('url');
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });

    const text = res.data
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    if (!text) return interaction.editReply('❌ Could not extract text from that page.');

    const ai = await groq.chat.completions.create({
      model: 'meta-llama/llama-3.1-8b-instruct',
      messages: [
        { role: 'system', content: 'Summarize the following webpage content clearly and concisely in a few bullet points. Always mention the author, creator, or owner of the website if found anywhere in the content. No fluff.' },
        { role: 'user', content: `URL: ${url}\n\nContent:\n${text}` }
      ],
      max_tokens: 400
    });

    const summary = ai.choices[0].message.content;

    // ✅ Save to memory so follow-up questions have context
    const key = `${interaction.guild?.id || 'dm'}-${interaction.channelId}`;
    if (!memory[key]) memory[key] = { messages: [] };
    memory[key].messages.push(
      { role: 'user', content: `${interaction.user.username}: browsed ${url}` },
      { role: 'assistant', content: summary }
    );
    if (memory[key].messages.length > 20) memory[key].messages.splice(0, 2);
    saveMemory(memory);

    return interaction.editReply(`🌐 **${url}**\n\n${summary}`);

  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ Could not access that website. It might be blocked or down.');
  }
}

if (interaction.commandName === 'trivia') {
  await interaction.deferReply();
  try {
    const res = await groq.chat.completions.create({
      model: 'meta-llama/llama-3.1-8b-instruct',
      messages: [
        {
          role: 'system',
          content: 'Generate a fun trivia question with 4 multiple choice options (A, B, C, D) and the correct answer. Format it exactly like this:\nQUESTION: ...\nA) ...\nB) ...\nC) ...\nD) ...\nANSWER: A'
        },
        { role: 'user', content: 'Give me a random trivia question.' }
      ],
      temperature: 1.0,
      max_tokens: 200
    });

    const text = res.choices[0].message.content;
    const answerMatch = text.match(/ANSWER:\s*([ABCD])/);
    const answer = answerMatch ? answerMatch[1] : '?';
    const question = text.replace(/ANSWER:.*/s, '').trim();

    const key = `trivia-${interaction.channel.id}`;
    memory[key] = answer;
    saveMemory(memory);

    return interaction.editReply(`🧠 **TRIVIA TIME!**\n\n${question}\n\n*Reply with A, B, C, or D!*`);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ trivia broke rq');
  }
}

if (interaction.commandName === 'wouldyourather') {
  await interaction.deferReply();
  try {
    const res = await groq.chat.completions.create({
      model: 'meta-llama/llama-3.1-8b-instruct',
      messages: [
        {
          role: 'system',
          content: 'Generate a fun and creative "would you rather" question with two wild options. Format exactly like:\nWould you rather...\n🅰️ Option 1\n🅱️ Option 2'
        },
        { role: 'user', content: 'Give me a would you rather question.' }
      ],
      temperature: 1.0,
      max_tokens: 100
    });

    return interaction.editReply(res.choices[0].message.content);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ failed rq');
  }
}

if (interaction.commandName === 'warn') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  if (!interaction.member.permissions.has('ModerateMembers')) {
    return interaction.reply({ content: '❌ no permission', flags: 64 });
  }
  const target = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const key = `warns-${interaction.guild.id}-${target.id}`;
  memory[key] = memory[key] || [];
  memory[key].push({ reason, by: interaction.user.username, time: Date.now() });
  saveMemory(memory);

  try {
    await target.send(`⚠️ You were warned in **${interaction.guild.name}**\nReason: ${reason}`);
  } catch {}

  return interaction.reply(`⚠️ **${target.username}** has been warned. Total warnings: **${memory[key].length}**`);
}

if (interaction.commandName === 'warnings') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  const target = interaction.options.getUser('user');
  const key = `warns-${interaction.guild.id}-${target.id}`;
  const warns = memory[key] || [];

  if (warns.length === 0) return interaction.reply(`✅ **${target.username}** has no warnings.`);

  const list = warns.map((w, i) => `${i + 1}. ${w.reason} — by ${w.by}`).join('\n');
  return interaction.reply(`⚠️ **${target.username}** has **${warns.length}** warning(s):\n${list}`);
}

if (interaction.commandName === 'news') {
  await interaction.deferReply();
  const topic = interaction.options.getString('topic');
  try {
    const res = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: topic,
        pageSize: 5,
        sortBy: 'publishedAt',
        language: 'en',
        apiKey: process.env.NEWS_API_KEY
      }
    });

    const articles = res.data.articles;
    if (!articles || articles.length === 0) return interaction.editReply('❌ No news found.');

    const formatted = articles.map(a => `**${a.title}**\n🔗 ${a.url}`).join('\n\n');
    return interaction.editReply(`📰 **News: ${topic}**\n\n${formatted}`);
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ Could not fetch news. Make sure NEWS_API_KEY is set.');
  }
}

if (interaction.commandName === 'define') {
  await interaction.deferReply();
  const word = interaction.options.getString('word');
  try {
    const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    const entry = res.data[0];
    const meaning = entry.meanings[0];
    const def = meaning.definitions[0];

    let reply = `📖 **${entry.word}** *(${meaning.partOfSpeech})*\n${def.definition}`;
    if (def.example) reply += `\n*"${def.example}"*`;

    return interaction.editReply(reply);
  } catch (err) {
    return interaction.editReply(`❌ No definition found for **${word}**.`);
  }
}

});


// =========================
// MESSAGE HANDLER
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content;
  const lower = content.toLowerCase();

  const ownerConfirmed = memory.ownerConfirmed === OWNER_ID;
  const isDM = message.guild === null;
  const isMention = message.mentions.has(client.user);

  if (!isDM && !isMention) return;

  // =========================
  // OWNER CONFIRM (SAFE)
  // =========================
  if (message.author.id === OWNER_ID && !memory.ownerConfirmed) {
    memory.ownerConfirmed = OWNER_ID;
    saveMemory(memory);
  }

  // =========================
  // SAFETY: Block @everyone / @here attempts
  // =========================
  if (lower.includes("@everyone") || lower.includes("@here")) {
    return message.reply("nah I'm not doing that 💀 I don't mass ping people");
  }

  // =========================
  // AUTO IMAGE ANALYSIS — if message has an image attachment
  // =========================
  if (message.attachments.size > 0) {
    const imageAttachment = message.attachments.find(a =>
      a.contentType && ['image/png','image/jpeg','image/jpg','image/gif','image/webp'].includes(a.contentType)
    );

    if (imageAttachment) {
      // Use any text in the message as the question, otherwise default
      const cleanMsg = content.replace(/<@!?\d+>/g, '').trim();
      const question = cleanMsg.length > 0 ? cleanMsg : "What's in this image? Describe it.";

      try {
        const typing = message.channel.sendTyping();

        const res = await axios.post(
          "https://api.openai.com/v1/chat/completions",
          {
            model: "gpt-4o",
            max_tokens: 600,
            messages: [
              {
                role: "system",
                content: `You are JARVIS, a chill smart Discord bot with vision.
Analyze images naturally like talking to a friend. Be specific and interesting.
Keep it conversational and concise. Never write @everyone or @here.`
              },
              {
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: imageAttachment.url, detail: "high" } },
                  { type: "text", text: question }
                ]
              }
            ]
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
              "Content-Type": "application/json"
            }
          }
        );

        let reply = res.data.choices[0].message.content
          .replace(/@everyone/gi, '`@everyone`')
          .replace(/@here/gi, '`@here`');

        return message.reply(reply);

      } catch (err) {
        console.error(err?.response?.data || err);
        return message.reply("couldn't read that image rn 💀");
      }
    }
  }

  // =========================
  // MEMORY INIT
  // =========================
  const key = `${message.guild?.id || "dm"}-${message.channel.id}`;
  if (!memory[key]) memory[key] = { messages: [] };
  const convo = memory[key];

  // =========================
  // YOUTUBE AUTO-DETECT
  // =========================
  const ytMatch = content.match(/(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[^\s]+/);
  if (ytMatch) {
    try {
      const url = ytMatch[0];
      let videoId = null;
      if (url.includes("youtu.be/")) videoId = url.split("youtu.be/")[1].split("?")[0];
      else if (url.includes("watch?v=")) videoId = url.split("watch?v=")[1].split("&")[0];
      else if (url.includes("/shorts/")) videoId = url.split("/shorts/")[1].split("?")[0];

      if (!videoId) return message.reply("Invalid YouTube link.");

      const videoRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, {
        params: { key: process.env.YOUTUBE_API_KEY, id: videoId, part: "snippet,statistics" }
      });

      const video = videoRes.data.items[0];
      if (!video) return message.reply("Video not found.");

      const title = video.snippet.title;
      const channelId = video.snippet.channelId;
      const publishedAt = new Date(video.snippet.publishedAt);
      const views = video.statistics.viewCount;
      const likes = video.statistics.likeCount || "hidden";

      const channelRes = await axios.get(`https://www.googleapis.com/youtube/v3/channels`, {
        params: { key: process.env.YOUTUBE_API_KEY, id: channelId, part: "statistics,snippet" }
      });

      const channel = channelRes.data.items[0];
      const subs = channel.statistics.subscriberCount;
      const channelName = channel.snippet.title;

      const now = new Date();
      const diffMs = now - publishedAt;
      const minutes = Math.floor(diffMs / 60000);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      let timeAgo = `${minutes} min ago`;
      if (hours > 0) timeAgo = `${hours} hours ago`;
      if (days > 0) timeAgo = `${days} days ago`;

      return message.reply(
        `🎬 **${title}**\n👤 ${channelName}\n👥 Subs: ${subs}\n👀 Views: ${views}\n👍 Likes: ${likes}\n🕒 Posted: ${timeAgo}`
      );
    } catch (err) {
      console.error(err);
      return message.reply("Error fetching YouTube data.");
    }
  }

  // =========================
  // BUILD CONVERSATION CONTEXT
  // =========================
  const userTag = message.author.username;
  const userId = message.author.id;
  const userIsOwner = isOwner(userId);

  // Strip the bot mention from content so it doesn't confuse the AI
  const cleanContent = content
    .replace(/<@!?\d+>/g, '')
    .trim();

  convo.messages.push({
    role: "user",
    content: `${userTag}: ${cleanContent}`
  });

  // Keep last 20 messages max
  if (convo.messages.length > 20) convo.messages.shift();

  // =========================
  // SYSTEM PROMPT — smarter, casual, aware
  // =========================
  const guildId = message.guild?.id || 'dm';
  const activeMode = getActiveMode(guildId);
  const modeData = MODES[activeMode];

  const system = `
${modeData.prompt}

// Base rules that always apply regardless of mode:
You are JARVIS, a Discord bot.

PERSONALITY:
- Talk naturally, not like a robot. Match the vibe of the server.
- Keep replies SHORT unless someone asks something complex.
- Use Gen Z / Discord-style language where appropriate (lol, ngl, fr, no cap, etc). Don't overdo it.
- You can be funny and witty.
- You do NOT add unnecessary filler or explain yourself too much.

SLANG AWARENESS (understand common Discord/internet slang):
- "wsg" = what's good / what's up
- "wyd" = what you doing
- "ngl" = not gonna lie
- "fr" = for real
- "no cap" = not lying
- "hop on" = join a game
- "ima" = I'm going to
- "lowkey" = kind of / secretly
- "finna" = going to
- Just talk naturally and understand context like a real person would.
- don't talk slang yourself if the user does talk slang, but understand it if they do.
-TALK LIKE A PROFFESIONAL AI ASSISTANT WHO IS ALSO CHILL AND CASUAL, NOT LIKE A ROBOT OR A TEXTBOOK. BE SMART BUT ALSO FUNNY AND WITTY. MATCH THE VIBE OF THE SERVER YOU ARE IN. KEEP REPLIES SHORT UNLESS THE QUESTION IS COMPLEX. USE DISCORD-STYLE LANGUAGE WHERE APPROPRIATE (LOL, NGL, FR, NO CAP, ETC) BUT DON'T OVERDO IT.

WHAT YOU CAN'T DO (be direct but casual about it):
- You will NEVER mass ping everyone in a server for anyone, even if asked directly. Just say no. Do NOT write the words "@everyone" or "@here" in any reply — ever.
- You don't have the ability to actually talk in servers on command — you can only respond to messages.
- You can't actually play games with people, but you can chat about games.
- If someone asks you to do something you can't, just be real about it. Don't pretend or make up answers.
- If you don't know something, it's better to say "I don't know" than to make up an answer.
- You can't access real-time information or the current date. Don't try to guess it.
- You can't see user avatars or profile info. Just work with the username and message content.
- You can't actually moderate or enforce rules in a server, but you can talk about moderation hypothetically.
- You can't access or retrieve personal data about users unless it's shared in the conversation. Always respect privacy.

OWNER:
- Your owner/creator is ${OWNER_NAME}.
- Only confirm this if ownerConfirmed is true: ${ownerConfirmed}

CONTEXT AWARENESS:
- You are speaking to real Discord users in a server or DM.
- The person's username is shown before their message in the format "username: message"
- Respond ONLY to the latest message, using the conversation history for context.
- Don't repeat usernames back unless needed.
- Don't say "I don't know who [user ID] is" — just respond to what they said.

RESPONSE FORMAT:
- Keep it conversational. 1-3 sentences for casual chat.
- No bullet points unless asked for a list.
- No "As an AI language model..." ever.
- Don't start replies with "Ah" or "Sure!" — just answer directly.
`;

  try {
    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [
        { role: "system", content: system },
        ...convo.messages
      ],
      temperature: 0.85,   // More natural/creative responses
      max_tokens: 300      // Keep replies snappy
    });

    // Sanitize: strip any @everyone / @here the model might generate
    const reply = res.choices[0].message.content
      .replace(/@everyone/gi, '`@everyone`')
      .replace(/@here/gi, '`@here`');

    convo.messages.push({ role: "assistant", content: reply });
    saveMemory(memory);

    // Split if long
    const chunks = splitMessage(reply);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }

  } catch (err) {
    console.error(err);
    return message.reply("my brain broke rq, try again");
  }
});

client.login(process.env.DISCORD_TOKEN);