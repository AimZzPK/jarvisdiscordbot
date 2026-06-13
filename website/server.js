require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());
app.use(express.static('public')); // serve dashboard.html from /public

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // e.g. https://yourdomain.com/api/auth/callback

// ── Login redirect ──────────────────────────────────────────
app.get('/api/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// ── OAuth callback ───────────────────────────────────────────
app.get('/api/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token } = tokenRes.data;

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    req.session.user = userRes.data;
    req.session.accessToken = access_token;

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  res.json(req.session.user);
});

// ── Middleware ───────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  next();
}

// ── List mutual guilds (user has Manage Server + bot is in it) ──
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const MANAGE_GUILD = 0x20; // permission bit

app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    // User's guilds
    const userGuilds = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${req.session.accessToken}` }
    });

    // Bot's guilds
    const botGuilds = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });

    const botGuildIds = new Set(botGuilds.data.map(g => g.id));

    const manageable = userGuilds.data.filter(g => {
      const perms = BigInt(g.permissions);
      const hasManage = (perms & BigInt(MANAGE_GUILD)) === BigInt(MANAGE_GUILD) || g.owner;
      return hasManage && botGuildIds.has(g.id);
    });

    res.json(manageable.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null
    })));
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'failed to fetch guilds' });
  }
});

// ── Get / Save settings for a specific guild ─────────────────
async function getMemory() {
  const data = await redis.get('jarvis-memory');
  return data ? (typeof data === 'string' ? JSON.parse(data) : data) : {};
}
async function setMemory(memory) {
  await redis.set('jarvis-memory', JSON.stringify(memory));
}

// Verify the logged-in user actually manages this guild
async function verifyGuildAccess(req, guildId) {
  const userGuilds = await axios.get('https://discord.com/api/users/@me/guilds', {
    headers: { Authorization: `Bearer ${req.session.accessToken}` }
  });
  const guild = userGuilds.data.find(g => g.id === guildId);
  if (!guild) return false;
  const perms = BigInt(guild.permissions);
  return (perms & BigInt(MANAGE_GUILD)) === BigInt(MANAGE_GUILD) || guild.owner;
}

app.get('/api/guilds/:id/settings', requireAuth, async (req, res) => {
  const guildId = req.params.id;
  if (!(await verifyGuildAccess(req, guildId))) return res.status(403).json({ error: 'forbidden' });

  const memory = await getMemory();

  res.json({
    activeMode: memory.modes?.[guildId] || 'normal',
    logChannelId: memory.logChannels?.[guildId] || null,
    automod: memory.automod?.[guildId] || { enabled: {}, action: 'delete', ignoreRoles: [] }
  });
});

app.post('/api/guilds/:id/settings', requireAuth, async (req, res) => {
  const guildId = req.params.id;
  if (!(await verifyGuildAccess(req, guildId))) return res.status(403).json({ error: 'forbidden' });

  const { activeMode, logChannelId, automod } = req.body;
  const memory = await getMemory();

  if (activeMode) {
    memory.modes = memory.modes || {};
    memory.modes[guildId] = activeMode;
  }

  memory.logChannels = memory.logChannels || {};
  if (logChannelId) {
    memory.logChannels[guildId] = logChannelId;
  } else {
    delete memory.logChannels[guildId];
  }

  if (automod) {
    memory.automod = memory.automod || {};
    memory.automod[guildId] = automod;
  }

  await setMemory(memory);
  res.json({ success: true });
});

// ── Get channel list for a guild (for log channel dropdown) ──
app.get('/api/guilds/:id/channels', requireAuth, async (req, res) => {
  const guildId = req.params.id;
  if (!(await verifyGuildAccess(req, guildId))) return res.status(403).json({ error: 'forbidden' });

  try {
    const channels = await axios.get(`https://discord.com/api/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` }
    });
    const textChannels = channels.data
      .filter(c => c.type === 0) // GUILD_TEXT
      .map(c => ({ id: c.id, name: c.name }));
    res.json(textChannels);
  } catch (err) {
    res.status(500).json({ error: 'failed to fetch channels' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard server running on port ${PORT}`));