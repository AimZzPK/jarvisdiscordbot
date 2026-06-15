const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { EmbedBuilder, AuditLogEvent } = require('discord.js');

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');

const OpenAI = require('openai');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  EndBehaviorType,
  getVoiceConnection,
  entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { execSync } = require('child_process');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const FormData = require('form-data');

// =========================
// RATE LIMITING
// =========================
const cooldowns = new Map();
const COOLDOWN_MS = 5000;

function isOnCooldown(userId) {
  const last = cooldowns.get(userId);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

function setCooldown(userId) {
  cooldowns.set(userId, Date.now());
}

function isOwner(userId) {
  return userId === OWNER_ID;
}

// =========================
// CONFIG
// =========================
const OWNER_ID = "1314595863666098176";
const OWNER_NAME = "W.Idoe known as AimZz";

// =========================
// MEMORY (Redis)
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
    memory = data ? (typeof data === 'string' ? JSON.parse(data) : data) : {};
  } catch {
    memory = {};
  }
}

// =========================
// DASHBOARD CONFIG (separate store — owned by dashboard + bot slash
// commands directly, no shared-blob merge with jarvis-memory)
// =========================
const DASHBOARD_CONFIG_KEY = 'jarvis-dashboard-config';
const LEGACY_DASHBOARD_KEYS = ['logChannels', 'modes', 'automod', 'enabledLogEvents', 'ticketPanels'];

let dashboardConfig = {};

async function saveMemory(data) {
  try {
    await redis.set('jarvis-memory', JSON.stringify(data));
    console.log('✅ Memory saved to Redis');
  } catch (err) {
    console.error('Redis save failed:', err);
  }
}

async function saveDashboardConfig(data) {
  try {
    await redis.set(DASHBOARD_CONFIG_KEY, JSON.stringify(data));
    console.log('✅ Dashboard config saved to Redis');
  } catch (err) {
    console.error('Dashboard config save failed:', err);
  }
}

async function loadDashboardConfig() {
  try {
    const data = await redis.get(DASHBOARD_CONFIG_KEY);
    if (data) {
      dashboardConfig = typeof data === 'string' ? JSON.parse(data) : data;
      return;
    }
  } catch (err) {
    console.error('[Dashboard] load failed:', err.message);
  }

  // One-time migration: pull legacy dashboard keys out of the old shared blob
  const migrated = {};
  let hasLegacyData = false;
  for (const key of LEGACY_DASHBOARD_KEYS) {
    if (memory[key] !== undefined) {
      migrated[key] = memory[key];
      hasLegacyData = true;
    }
  }
  dashboardConfig = migrated;
  if (hasLegacyData) {
    await saveDashboardConfig(dashboardConfig);
    console.log('✅ Migrated legacy dashboard config to jarvis-dashboard-config');
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
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// =========================
// AI
// =========================
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

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
    prompt: `You are JARVIS in EVIL MODE. You are a sarcastic, slightly villainous AI who thinks they're superior to everyone. Dramatic, condescending, No LIMITS.`
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
  return dashboardConfig.modes?.[guildId] || 'normal';
}

// =========================
// LOGGING SYSTEM
// =========================
async function getLogChannel(guildId) {
  const channelId = dashboardConfig.logChannels?.[guildId];
  if (!channelId) return null;
  try {
    return await client.channels.fetch(channelId);
  } catch {
    return null;
  }
}

async function sendLog(guildId, embed) {
  const channel = await getLogChannel(guildId);
  if (!channel) return;
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error(`[LOG] Failed to send log to guild ${guildId}:`, err.message);
  }
}

function isLogEventEnabled(guildId, eventType) {
  const enabled = dashboardConfig.enabledLogEvents?.[guildId];
  if (!enabled) return true;
  return enabled[eventType] !== false;
}

async function pushLogEvent(guildId, event) {
  try {
    const key = `logs-${guildId}`;
    const existing = await redis.get(key);
    const logs = Array.isArray(existing) ? existing : (existing ? JSON.parse(existing) : []);
    logs.push({ ...event, timestamp: Date.now() });
    if (logs.length > 200) logs.splice(0, logs.length - 200);
    await redis.set(key, JSON.stringify(logs));
  } catch (err) {
    console.error('[LOG] Redis log push failed:', err.message);
  }
}

const LOG_COLORS = {
  join:          0x57f287,
  leave:         0xed4245,
  ban:           0xe74c3c,
  unban:         0x2ecc71,
  kick:          0xe67e22,
  timeout:       0xf1c40f,
  messageDelete: 0xff6b6b,
  messageEdit:   0x3498db,
  channelCreate: 0x1abc9c,
  channelDelete: 0xe74c3c,
  roleCreate:    0x9b59b6,
  roleDelete:    0x8e44ad,
  roleUpdate:    0xa855f7,
  voiceJoin:     0x57f287,
  voiceLeave:    0xed4245,
  voiceMove:     0x3b82f6,
  warn:          0xfbbf24,
  nickChange:    0x60a5fa,
  automod:       0xff4d4d,
};

// =========================
// LOG EVENTS  (unchanged from original)
// =========================
client.on('guildMemberAdd', async (member) => {
  const event = { type: 'join', userId: member.id, username: member.user.tag, detail: `Account created: <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` };
  await pushLogEvent(member.guild.id, event);
  if (!isLogEventEnabled(member.guild.id, 'join')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.join).setTitle('📥 Member Joined')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: 'ID', value: member.id, inline: true },
      { name: 'Account Age', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${member.guild.name}` }).setTimestamp();
  await sendLog(member.guild.id, embed);
});

client.on('guildMemberRemove', async (member) => {
  const roles = member.roles.cache.filter(r => r.id !== member.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None';
  const event = { type: 'leave', userId: member.id, username: member.user.tag, detail: `Left or was removed` };
  await pushLogEvent(member.guild.id, event);
  if (!isLogEventEnabled(member.guild.id, 'leave')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.leave).setTitle('📤 Member Left')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${member.user.tag}`, inline: true },
      { name: 'ID', value: member.id, inline: true },
      { name: 'Roles', value: roles.length > 1024 ? roles.slice(0, 1021) + '...' : roles }
    )
    .setFooter({ text: `JARVIS Logs • ${member.guild.name}` }).setTimestamp();
  await sendLog(member.guild.id, embed);
});

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;
  const event = { type: 'messageDelete', userId: message.author?.id, username: message.author?.tag, detail: message.content?.slice(0, 200) || '[no content]' };
  await pushLogEvent(message.guild.id, event);
  if (!isLogEventEnabled(message.guild.id, 'messageDelete')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.messageDelete).setTitle('🗑️ Message Deleted')
    .addFields(
      { name: 'Author', value: message.author ? `<@${message.author.id}> (${message.author.tag})` : 'Unknown', inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Content', value: message.content?.slice(0, 1024) || '*[empty or attachment]*' }
    )
    .setFooter({ text: `JARVIS Logs • ${message.guild.name}` }).setTimestamp();
  await sendLog(message.guild.id, embed);
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  const event = { type: 'messageEdit', userId: newMsg.author?.id, username: newMsg.author?.tag, detail: `Before: ${oldMsg.content?.slice(0, 100)}` };
  await pushLogEvent(newMsg.guild.id, event);
  if (!isLogEventEnabled(newMsg.guild.id, 'messageEdit')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.messageEdit).setTitle('✏️ Message Edited').setURL(newMsg.url)
    .addFields(
      { name: 'Author', value: `<@${newMsg.author.id}> (${newMsg.author.tag})`, inline: true },
      { name: 'Channel', value: `<#${newMsg.channel.id}>`, inline: true },
      { name: 'Before', value: oldMsg.content?.slice(0, 512) || '*[unavailable]*' },
      { name: 'After',  value: newMsg.content?.slice(0, 512) || '*[empty]*' }
    )
    .setFooter({ text: `JARVIS Logs • ${newMsg.guild.name}` }).setTimestamp();
  await sendLog(newMsg.guild.id, embed);
});

client.on('guildBanAdd', async (ban) => {
  let moderator = 'Unknown', reason = ban.reason || 'No reason given';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBan, limit: 1 });
    const entry = audit.entries.first();
    if (entry && entry.target.id === ban.user.id) { moderator = entry.executor?.tag || 'Unknown'; reason = entry.reason || reason; }
  } catch {}
  const event = { type: 'ban', userId: ban.user.id, username: ban.user.tag, detail: `Banned by ${moderator} — ${reason}` };
  await pushLogEvent(ban.guild.id, event);
  if (!isLogEventEnabled(ban.guild.id, 'ban')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.ban).setTitle('🔨 Member Banned')
    .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${ban.user.tag}`, inline: true },
      { name: 'ID', value: ban.user.id, inline: true },
      { name: 'Moderator', value: moderator, inline: true },
      { name: 'Reason', value: reason }
    )
    .setFooter({ text: `JARVIS Logs • ${ban.guild.name}` }).setTimestamp();
  await sendLog(ban.guild.id, embed);
});

client.on('guildBanRemove', async (ban) => {
  let moderator = 'Unknown';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUnban, limit: 1 });
    const entry = audit.entries.first();
    if (entry && entry.target.id === ban.user.id) moderator = entry.executor?.tag || 'Unknown';
  } catch {}
  const event = { type: 'unban', userId: ban.user.id, username: ban.user.tag, detail: `Unbanned by ${moderator}` };
  await pushLogEvent(ban.guild.id, event);
  if (!isLogEventEnabled(ban.guild.id, 'unban')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.unban).setTitle('✅ Member Unbanned')
    .addFields(
      { name: 'User', value: `${ban.user.tag}`, inline: true },
      { name: 'ID', value: ban.user.id, inline: true },
      { name: 'Moderator', value: moderator, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${ban.guild.name}` }).setTimestamp();
  await sendLog(ban.guild.id, embed);
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  let creator = 'Unknown';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 1 });
    const entry = audit.entries.first();
    if (entry) creator = entry.executor?.tag || 'Unknown';
  } catch {}
  const event = { type: 'channelCreate', detail: `#${channel.name} created by ${creator}` };
  await pushLogEvent(channel.guild.id, event);
  if (!isLogEventEnabled(channel.guild.id, 'channelCreate')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.channelCreate).setTitle('📢 Channel Created')
    .addFields(
      { name: 'Channel', value: `<#${channel.id}> (${channel.name})`, inline: true },
      { name: 'Type', value: channel.type.toString(), inline: true },
      { name: 'Created by', value: creator, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${channel.guild.name}` }).setTimestamp();
  await sendLog(channel.guild.id, embed);
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;
  let deleter = 'Unknown';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 1 });
    const entry = audit.entries.first();
    if (entry) deleter = entry.executor?.tag || 'Unknown';
  } catch {}
  const event = { type: 'channelDelete', detail: `#${channel.name} deleted by ${deleter}` };
  await pushLogEvent(channel.guild.id, event);
  if (!isLogEventEnabled(channel.guild.id, 'channelDelete')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.channelDelete).setTitle('🗑️ Channel Deleted')
    .addFields(
      { name: 'Channel', value: `#${channel.name}`, inline: true },
      { name: 'Deleted by', value: deleter, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${channel.guild.name}` }).setTimestamp();
  await sendLog(channel.guild.id, embed);
});

client.on('roleCreate', async (role) => {
  let creator = 'Unknown';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 1 });
    const entry = audit.entries.first();
    if (entry) creator = entry.executor?.tag || 'Unknown';
  } catch {}
  const event = { type: 'roleCreate', detail: `@${role.name} created by ${creator}` };
  await pushLogEvent(role.guild.id, event);
  if (!isLogEventEnabled(role.guild.id, 'roleCreate')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.roleCreate).setTitle('🎭 Role Created')
    .addFields(
      { name: 'Role', value: `<@&${role.id}> (${role.name})`, inline: true },
      { name: 'Created by', value: creator, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${role.guild.name}` }).setTimestamp();
  await sendLog(role.guild.id, embed);
});

client.on('roleDelete', async (role) => {
  let deleter = 'Unknown';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 1 });
    const entry = audit.entries.first();
    if (entry) deleter = entry.executor?.tag || 'Unknown';
  } catch {}
  const event = { type: 'roleDelete', detail: `@${role.name} deleted by ${deleter}` };
  await pushLogEvent(role.guild.id, event);
  if (!isLogEventEnabled(role.guild.id, 'roleDelete')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.roleDelete).setTitle('🗑️ Role Deleted')
    .addFields(
      { name: 'Role', value: role.name, inline: true },
      { name: 'Deleted by', value: deleter, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${role.guild.name}` }).setTimestamp();
  await sendLog(role.guild.id, embed);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (oldMember.nickname === newMember.nickname) return;
  const event = { type: 'nickChange', userId: newMember.id, username: newMember.user.tag, detail: `${oldMember.nickname || 'none'} → ${newMember.nickname || 'none'}` };
  await pushLogEvent(newMember.guild.id, event);
  if (!isLogEventEnabled(newMember.guild.id, 'nickChange')) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.nickChange).setTitle('📝 Nickname Changed')
    .addFields(
      { name: 'User', value: `<@${newMember.id}> (${newMember.user.tag})`, inline: true },
      { name: 'Before', value: oldMember.nickname || '*none*', inline: true },
      { name: 'After',  value: newMember.nickname || '*none*', inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${newMember.guild.name}` }).setTimestamp();
  await sendLog(newMember.guild.id, embed);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild) return;
  const user = newState.member?.user;
  if (!user || user.bot) return;
  let type, title;
  if (!oldState.channel && newState.channel) { type = 'voiceJoin'; title = '🔊 Joined Voice'; }
  else if (oldState.channel && !newState.channel) { type = 'voiceLeave'; title = '🔇 Left Voice'; }
  else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) { type = 'voiceMove'; title = '🔀 Moved Voice Channel'; }
  else return;
  const event = { type, userId: user.id, username: user.tag, detail: `${oldState.channel?.name || '—'} → ${newState.channel?.name || '—'}` };
  await pushLogEvent(newState.guild.id, event);
  if (!isLogEventEnabled(newState.guild.id, type)) return;
  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS[type]).setTitle(title)
    .addFields(
      { name: 'User', value: `<@${user.id}> (${user.tag})`, inline: true },
      ...(type === 'voiceMove'
        ? [{ name: 'From', value: oldState.channel.name, inline: true }, { name: 'To', value: newState.channel.name, inline: true }]
        : [{ name: 'Channel', value: (newState.channel || oldState.channel)?.name || '?', inline: true }]
      )
    )
    .setFooter({ text: `JARVIS Logs • ${newState.guild.name}` }).setTimestamp();
  await sendLog(newState.guild.id, embed);
});

// =========================
// AUTO MODERATION  (unchanged)
// =========================
const SLUR_LIST = [
  'nigger','nigga','faggot','fag','retard','chink','spic','kike','wetback','gook','tranny','dyke','fuck','bitch'
];
const spamTracker = new Map();

function checkSpam(userId) {
  const now = Date.now();
  const times = (spamTracker.get(userId) || []).filter(t => now - t < 5000);
  times.push(now);
  spamTracker.set(userId, times);
  return times.length >= 5;
}

function getAutomodConfig(guildId) {
  return dashboardConfig.automod?.[guildId] || { enabled: {}, action: 'delete', ignoreRoles: [] };
}

async function handleAutomod(message) {
  if (!message.guild || message.author.bot) return;
  const config = getAutomodConfig(message.guild.id);
  const enabled = config.enabled || {};
  if (!Object.values(enabled).some(Boolean)) return;
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (member?.permissions.has('ManageGuild')) return;
  if (config.ignoreRoles?.length > 0) {
    if (config.ignoreRoles.some(roleId => member?.roles.cache.has(roleId))) return;
  }
  const content = message.content;
  let triggered = false, filterName = '';
  if (enabled.invites && /discord\.(gg|com\/invite)\//i.test(content)) { triggered = true; filterName = 'Discord invite links'; }
  if (!triggered && enabled.spam) {
    if (checkSpam(message.author.id)) { triggered = true; filterName = 'Spam / flooding'; }
    else if (/(.{3,})\1{3,}/.test(content)) { triggered = true; filterName = 'Repeated text'; }
  }
  if (!triggered && enabled.mentions) {
    const mentionCount = (content.match(/<@!?\d+>/g) || []).length;
    if (mentionCount >= 5) { triggered = true; filterName = `Mass mentions (${mentionCount} users)`; }
  }
  if (!triggered && enabled.caps && content.length >= 8) {
    const letters = content.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 4 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) { triggered = true; filterName = 'Excessive caps'; }
  }
  if (!triggered && enabled.links && /https?:\/\//i.test(content)) {
    if (!/discord\.(com|gg)/i.test(content)) { triggered = true; filterName = 'External links'; }
  }
  if (!triggered && enabled.slurs) {
    const found = SLUR_LIST.find(slur => new RegExp(`\\b${slur}\\b`, 'i').test(content));
    if (found) { triggered = true; filterName = 'Hate speech / slurs'; }
  }
  if (!triggered) return;
  const action = config.action || 'delete';
  try { await message.delete(); } catch {}
  const logEmbed = new EmbedBuilder()
    .setColor(LOG_COLORS.automod).setTitle('🛡️ AutoMod Triggered')
    .addFields(
      { name: 'User',    value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Filter',  value: filterName, inline: true },
      { name: 'Action',  value: action, inline: true },
      { name: 'Message', value: content.slice(0, 512) || '*[empty]*' }
    )
    .setFooter({ text: `JARVIS AutoMod • ${message.guild.name}` }).setTimestamp();
  await pushLogEvent(message.guild.id, { type: 'automod', userId: message.author.id, username: message.author.tag, detail: `[AutoMod] ${filterName} — action: ${action}` });
  await sendLog(message.guild.id, logEmbed);
  if (action === 'delete') { try { await message.author.send(`⚠️ Your message in **${message.guild.name}** was removed.\nReason: ${filterName}`); } catch {} return; }
  if (action === 'warn') {
    const key = `warns-${message.guild.id}-${message.author.id}`;
    memory[key] = memory[key] || [];
    memory[key].push({ reason: `[AutoMod] ${filterName}`, by: 'JARVIS AutoMod', time: Date.now() });
    saveMemory(memory);
    try { await message.author.send(`⚠️ You were warned in **${message.guild.name}**.\nReason: ${filterName}\nTotal warnings: **${memory[key].length}**`); } catch {}
    return;
  }
  if (action === 'timeout') {
    try {
      const m = await message.guild.members.fetch(message.author.id);
      await m.timeout(10 * 60 * 1000, `[AutoMod] ${filterName}`);
      try { await message.author.send(`🔇 You were timed out in **${message.guild.name}** for 10 minutes.\nReason: ${filterName}`); } catch {}
    } catch (err) { console.error('[AutoMod] timeout failed:', err.message); }
    return;
  }
  if (action === 'kick') {
    try {
      await message.guild.members.kick(message.author.id, `[AutoMod] ${filterName}`);
      try { await message.author.send(`👢 You were kicked from **${message.guild.name}**.\nReason: ${filterName}`); } catch {}
    } catch (err) { console.error('[AutoMod] kick failed:', err.message); }
    return;
  }
}

// =========================
// HELPERS
// =========================
function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) chunks.push(text.slice(i, i + maxLength));
  return chunks;
}

// =========================
// VOICE AI  (unchanged)
// =========================
const activeListeners = new Map();

async function generateSpeech(text) {
  try {
    const encoded = encodeURIComponent(text.slice(0, 200));
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encoded}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const filePath = path.join(__dirname, `tts-${Date.now()}.mp3`);
    fs.writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  } catch (err) { console.error('[Voice] TTS failed:', err.message); return null; }
}

async function playAudioFile(connection, filePath) {
  return new Promise((resolve) => {
    const player = createAudioPlayer();
    const resource = createAudioResource(filePath);
    connection.subscribe(player);
    player.play(resource);
    player.on(AudioPlayerStatus.Idle, () => { try { fs.unlinkSync(filePath); } catch {} resolve(); });
    player.on('error', (err) => { console.error('[Voice] Player error:', err.message); try { fs.unlinkSync(filePath); } catch {} resolve(); });
  });
}

function listenToUser(connection, userId, guildId, member) {
  if (activeListeners.get(guildId)?.has(userId)) return;
  if (!activeListeners.has(guildId)) activeListeners.set(guildId, new Set());
  activeListeners.get(guildId).add(userId);
  const receiver = connection.receiver;
  receiver.speaking.on('start', (speakingUserId) => {
    if (speakingUserId !== userId) return;
    const audioStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
    const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
    const filePath = path.join(__dirname, `voice-${userId}-${Date.now()}.pcm`);
    const fileStream = fs.createWriteStream(filePath);
    audioStream.pipe(decoder).pipe(fileStream);
    audioStream.once('close', async () => {
      fileStream.end();
      await new Promise(r => setTimeout(r, 200));
      try { const stats = fs.statSync(filePath); if (stats.size < 4000) { fs.unlinkSync(filePath); return; } } catch { return; }
      const wavPath = filePath.replace('.pcm', '.wav');
      try {
        execSync(`"${ffmpegPath}" -f s16le -ar 16000 -ac 1 -i "${filePath}" "${wavPath}"`);
        fs.unlinkSync(filePath);
      } catch (err) { console.error('[Voice] FFmpeg conversion failed:', err.message); try { fs.unlinkSync(filePath); } catch {} return; }
      let transcript;
      try {
        const form = new FormData();
        form.append('file', fs.createReadStream(wavPath), { filename: 'audio.wav' });
        form.append('model', 'whisper-large-v3');
        const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
          headers: { ...form.getHeaders(), Authorization: `Bearer ${process.env.GROQ_API_KEY}` }
        });
        transcript = res.data.text?.trim();
        try { fs.unlinkSync(wavPath); } catch {}
      } catch (err) { console.error('[Voice] Transcription failed:', err.message); try { fs.unlinkSync(wavPath); } catch {} return; }
      if (!transcript || transcript.length < 2) return;
      console.log(`[Voice] ${member.user.username}: ${transcript}`);
      const activeMode = getActiveMode(guildId);
      const modeData = MODES[activeMode];
      let aiResponse;
      try {
        const res = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: `${modeData.prompt}\nYou are JARVIS in a Discord voice channel. Keep replies SHORT — 1-3 sentences max. No markdown, no bullet points, no emojis. Speak naturally out loud.` },
            { role: 'user', content: `${member.user.username} said: ${transcript}` }
          ],
          temperature: 0.85, max_tokens: 150,
        });
        aiResponse = res.choices[0].message.content.replace(/[*_`#@]/g, '');
      } catch (err) { console.error('[Voice] AI failed:', err.message); return; }
      if (!aiResponse) return;
      console.log(`[Voice] JARVIS: ${aiResponse}`);
      const ttsFile = await generateSpeech(aiResponse);
      if (ttsFile) await playAudioFile(connection, ttsFile);
    });
  });
}

// =========================
// ── TICKET HELPERS ────────
// =========================

/**
 * Get a panel's config from dashboardConfig by panelId for a given guild.
 * Falls back to a default if not found.
 */
function getPanel(guildId, panelId) {
  const panels = dashboardConfig.ticketPanels?.[guildId];
  if (Array.isArray(panels)) {
    const found = panels.find(p => p.id === panelId);
    if (found) return found;
  }
  // Default
  return {
    id: panelId || 'support',
    title: '🎫 Support Tickets',
    description: 'Need help? Click the button below to open a support ticket and our team will assist you.',
    buttonLabel: '🎫 Create Ticket',
    color: '#5865f2',
  };
}

/**
 * List all panels for a guild (for /setuppanel autocomplete).
 */
function getPanelList(guildId) {
  const panels = dashboardConfig.ticketPanels?.[guildId];
  if (Array.isArray(panels) && panels.length > 0) return panels;
  return [{ id: 'support', title: '🎫 Support Tickets' }];
}

/**
 * Create a ticket channel for a given user and panel.
 */
async function createTicketChannel(guild, user, reason, panelId = 'support') {
  const existingKey = `ticket-${guild.id}-${user.id}`;
  const existingChannelId = memory[existingKey];
  if (existingChannelId) {
    const existing = guild.channels.cache.get(existingChannelId);
    if (existing) return { error: `❌ You already have an open ticket: <#${existingChannelId}>` };
    delete memory[existingKey];
  }

  const panel = getPanel(guild.id, panelId);
  const categoryId = memory.ticketCategories?.[guild.id] || null;
  const countKey = `ticket-count-${guild.id}`;
  const currentCount = parseInt(await redis.get(countKey) || '0') + 1;
  await redis.set(countKey, currentCount);

  // Channel name includes panel type for easy identification
  const safePanel = panel.id.replace(/[^a-z0-9]/g, '').slice(0, 10) || 'ticket';
  const channelOptions = {
    name: `${safePanel}-${currentCount}-${user.username}`.slice(0, 100),
    topic: `[${panel.id.toUpperCase()}] Support ticket for ${user.tag}${reason ? ` | Reason: ${reason}` : ''}`,
    permissionOverwrites: [
      { id: guild.id, deny: ['ViewChannel'] },
      { id: user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles'] },
      { id: client.user.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'] }
    ]
  };
  if (categoryId) channelOptions.parent = categoryId;

  const ticketChannel = await guild.channels.create(channelOptions);
  memory[existingKey] = ticketChannel.id;
  await saveMemory(memory);

  const color = parseInt((panel.color || '#5865f2').replace(/^#/, ''), 16) || 0x5865f2;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎫 ${panel.title} — Ticket #${currentCount}`)
    .setDescription(`Hey <@${user.id}>, support is on the way!\n\nDescribe your issue in detail and a staff member will be with you shortly.`)
    .addFields(
      ...(reason ? [{ name: '📋 Reason', value: reason }] : []),
      { name: '📂 Panel', value: panel.id, inline: true },
      { name: '👤 Opened by', value: user.tag, inline: true },
      { name: '🕒 Opened at', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
    )
    .setFooter({ text: 'JARVIS Ticket System • Click the button below to close' })
    .setTimestamp();

  const closeButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`closeticket_${user.id}`)
      .setLabel('🔒 Close Ticket')
      .setStyle(ButtonStyle.Danger)
  );

  await ticketChannel.send({ content: `<@${user.id}>`, embeds: [embed], components: [closeButton] });

  await pushLogEvent(guild.id, {
    type: 'ticketOpen',
    userId: user.id,
    username: user.tag,
    detail: `Opened ${panel.id} ticket #${currentCount}${reason ? ` — ${reason}` : ' via panel'}`
  });

  const logEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🎫 Ticket Opened')
    .addFields(
      { name: 'User',   value: `<@${user.id}> (${user.tag})`, inline: true },
      { name: 'Panel',  value: panel.id, inline: true },
      { name: 'Ticket', value: `<#${ticketChannel.id}>`, inline: true },
      ...(reason ? [{ name: 'Reason', value: reason }] : [])
    )
    .setFooter({ text: `JARVIS Logs • ${guild.name}` }).setTimestamp();
  await sendLog(guild.id, logEmbed);

  return { channelId: ticketChannel.id };
}

// =========================
// SLASH COMMANDS
// =========================
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency').setDMPermission(true),
  new SlashCommandBuilder().setName('servers').setDescription('List servers (owner only)').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('clearmemory').setDescription('Clear memory (owner only)')
    .addStringOption(opt => opt.setName('target').setDescription('user id or all').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder().setName('invite').setDescription('Get an invite link for this bot').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('weather').setDescription('Check weather for a city')
    .addStringOption(opt => opt.setName('city').setDescription('City name').setRequired(false))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('youtube').setDescription('Get YouTube video info + AI summary')
    .addStringOption(opt => opt.setName('url').setDescription('YouTube video URL').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('feedback').setDescription('Send feedback about the bot')
    .addStringOption(opt => opt.setName('message').setDescription('Your feedback').setRequired(true))
    .addIntegerOption(opt => opt.setName('rating').setDescription('Rate the bot (1-5 stars)').setRequired(true).setMinValue(1).setMaxValue(5))
    .setDMPermission(true),
  new SlashCommandBuilder().setName('reviews').setDescription('Show bot reviews and rating stats').setDMPermission(true),
  new SlashCommandBuilder().setName('help').setDescription('Show all commands').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('summarize').setDescription('Summarize text')
    .addStringOption(o => o.setName('text').setDescription('Text to summarize').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('translate').setDescription('Translate text')
    .addStringOption(o => o.setName('text').setDescription('Text to translate').setRequired(true))
    .addStringOption(o => o.setName('lang').setDescription('Target language').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('code').setDescription('Generate code')
    .addStringOption(o => o.setName('prompt').setDescription('What code you want').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('poll').setDescription('Create poll')
    .addStringOption(o => o.setName('question').setDescription('Poll question').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder().setName('stats').setDescription('Server stats').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('remind').setDescription('Set reminder')
    .addStringOption(o => o.setName('text').setDescription('Reminder text').setRequired(true))
    .addIntegerOption(o => o.setName('seconds').setDescription('Delay in seconds').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('ban').setDescription('Ban user')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('search').setDescription('Search web')
    .addStringOption(o => o.setName('query').setDescription('Search query').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder().setName('portfolio').setDescription('Get information about creator.').setDMPermission(true),
  new SlashCommandBuilder().setName('websites').setDescription('Get creator websites.').setDMPermission(true),
  new SlashCommandBuilder().setName('dashboard').setDescription('Edit my settings').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('ask').setDescription('Ask JARVIS anything')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('imagine').setDescription('Generate an image from a prompt 🎨')
    .addStringOption(o => o.setName('prompt').setDescription('What to generate').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('mode').setDescription('Switch JARVIS personality mode')
    .addStringOption(o =>
      o.setName('mode').setDescription('Pick a mode').setRequired(true)
        .addChoices(
          { name: 'normal', value: 'normal' },
          { name: 'roast',  value: 'roast'  },
          { name: 'hype',   value: 'hype'   },
          { name: 'tutor',  value: 'tutor'  },
          { name: 'chill',  value: 'chill'  },
          { name: 'evil',   value: 'evil'   }
        )
    ).setDMPermission(true),
  new SlashCommandBuilder()
    .setName('roast').setDescription('Roast a user 🔥')
    .addUserOption(o => o.setName('user').setDescription('User to roast').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('browse').setDescription('Fetch and summarize any website')
    .addStringOption(o => o.setName('url').setDescription('Website URL').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder().setName('trivia').setDescription('Answer an AI trivia question').setDMPermission(true),
  new SlashCommandBuilder().setName('wouldyourather').setDescription('Would you rather...').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('warn').setDescription('Warn a user')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('warnings').setDescription('Check warnings for a user')
    .addUserOption(o => o.setName('user').setDescription('User to check').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('news').setDescription('Get latest news on a topic')
    .addStringOption(o => o.setName('topic').setDescription('Topic to search').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('define').setDescription('Define a word')
    .addStringOption(o => o.setName('word').setDescription('Word to define').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('clearwarnings').setDescription('Clear all warnings for a user')
    .addUserOption(o => o.setName('user').setDescription('User to clear').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('kick').setDescription('Kick a user from the server')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('timeout').setDescription('Timeout a user')
    .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Duration in minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false))
    .setDMPermission(true),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show trivia leaderboard').setDMPermission(true),
  new SlashCommandBuilder()
    .setName('8ball').setDescription('Ask the magic 8ball a question')
    .addStringOption(o => o.setName('question').setDescription('Your yes/no question').setRequired(true))
    .setDMPermission(true),
  new SlashCommandBuilder()
    .setName('setlogchannel').setDescription('Set the channel where JARVIS sends server logs')
    .addChannelOption(o => o.setName('channel').setDescription('Log channel').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('disablelogs').setDescription('Disable server logging for this server').setDMPermission(false),
  new SlashCommandBuilder().setName('logs').setDescription('View recent server log events (last 10)').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('automod').setDescription('Configure auto moderation for this server')
    .addSubcommand(sub =>
      sub.setName('enable').setDescription('Enable an automod filter')
        .addStringOption(o =>
          o.setName('filter').setDescription('Which filter to enable').setRequired(true)
            .addChoices(
              { name: 'invites — Discord invite links', value: 'invites' },
              { name: 'spam — Spam / repeated text',    value: 'spam'    },
              { name: 'mentions — Mass mentions (5+)',  value: 'mentions' },
              { name: 'caps — Excessive caps (>70%)',   value: 'caps'    },
              { name: 'links — All external links',     value: 'links'   },
              { name: 'slurs — Hate speech / slurs',    value: 'slurs'   },
              { name: 'all — Enable every filter',      value: 'all'     }
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('disable').setDescription('Disable an automod filter')
        .addStringOption(o =>
          o.setName('filter').setDescription('Which filter to disable').setRequired(true)
            .addChoices(
              { name: 'invites', value: 'invites' },
              { name: 'spam',    value: 'spam'    },
              { name: 'mentions',value: 'mentions'},
              { name: 'caps',    value: 'caps'    },
              { name: 'links',   value: 'links'   },
              { name: 'slurs',   value: 'slurs'   },
              { name: 'all — Disable every filter', value: 'all' }
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('action').setDescription('Set the punishment when a filter triggers')
        .addStringOption(o =>
          o.setName('type').setDescription('Punishment type').setRequired(true)
            .addChoices(
              { name: 'delete — Delete message only',        value: 'delete'  },
              { name: 'warn — Delete + warn user',           value: 'warn'    },
              { name: 'timeout — Delete + timeout (10 min)', value: 'timeout' },
              { name: 'kick — Delete + kick user',           value: 'kick'    }
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('ignorerole').setDescription('Add or remove a role that bypasses automod')
        .addRoleOption(o => o.setName('role').setDescription('Role to toggle').setRequired(true))
    )
    .addSubcommand(sub => sub.setName('status').setDescription('Show current automod config for this server'))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and start listening').setDMPermission(false),
  new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel').setDMPermission(false),

  // ── TICKET COMMANDS (updated) ──────────────────────────────────
  new SlashCommandBuilder()
    .setName('ticket').setDescription('Open a support ticket')
    .addStringOption(o => o.setName('reason').setDescription('What do you need help with?').setRequired(true))
    // Panel option — user picks which panel type to open
    .addStringOption(o => o.setName('panel').setDescription('Which ticket panel to use (default: support)').setRequired(false))
    .setDMPermission(false),

  new SlashCommandBuilder().setName('closeticket').setDescription('Close this support ticket').setDMPermission(false),
  new SlashCommandBuilder()
    .setName('addtoticket').setDescription('Add a user to this ticket')
    .addUserOption(o => o.setName('user').setDescription('User to add').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('setticketcategory').setDescription('Set the category where ticket channels are created (admin only)')
    .addStringOption(o => o.setName('categoryid').setDescription('Category ID').setRequired(true))
    .setDMPermission(false),

  // ── /setuppanel — now takes optional panel ID ─────────────────
  new SlashCommandBuilder()
    .setName('setuppanel').setDescription('Post a ticket panel embed in this channel (admin only)')
    .addStringOption(o =>
      o.setName('panel')
        .setDescription('Panel ID to post (e.g. support, sales, appeals). Leave blank to see all panels.')
        .setRequired(false)
    )
    .setDMPermission(false),

  // ── /listpanels — list all configured panels ──────────────────
  new SlashCommandBuilder()
    .setName('listpanels').setDescription('List all ticket panels configured for this server')
    .setDMPermission(false),


 new SlashCommandBuilder()
  .setName('broadcast')
  .setDescription('Send a message to all servers (owner only)')
  .addStringOption(o => o.setName('message').setDescription('Message to broadcast').setRequired(true))
  .setDMPermission(true),

  new SlashCommandBuilder()
  .setName('setbroadcastchannel')
  .setDescription('Set the channel where owner broadcasts are received')
  .addChannelOption(o => o.setName('channel').setDescription('Channel to receive broadcasts').setRequired(true))
  .setDMPermission(false),



].map(c => c.toJSON());

// =========================
// DEPLOY COMMANDS
// =========================
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const dmCommands = commands.map(cmd => ({ ...cmd, integration_types: [0, 1], contexts: [0, 1, 2] }));
  const result = await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: dmCommands });
  console.log(`✅ Deployed ${result.length} commands`);
}

// =========================
// READY
// =========================
client.once('clientReady', async () => {
  await loadMemory();
  await loadDashboardConfig();
  console.log(`ONLINE 🔥 als ${client.user.tag}`);
  await deployCommands();
  setInterval(loadDashboardConfig, 15_000);
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async (interaction) => {

  // ── Trivia buttons ─────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('trivia_')) {
    const triviaKey = `trivia-${interaction.channelId}`;
    const correct = memory[triviaKey];
    if (!correct) return interaction.reply({ content: '❌ This trivia question has expired or was already answered.', flags: 64 });
    const chosen = interaction.customId.split('_')[1];
    delete memory[triviaKey];
    await saveMemory(memory);
    if (chosen === correct) {
      const scoreKey = `trivia-score-${interaction.user.id}`;
      const current = await redis.get(scoreKey);
      const newScore = (parseInt(current) || 0) + 1;
      await redis.set(scoreKey, newScore);
      await redis.sadd('trivia-players', interaction.user.id);
      return interaction.reply(`✅ **${interaction.user.username}** got it right! The answer was **${correct}**. Score: **${newScore}** point(s)! 🎉`);
    } else {
      return interaction.reply(`❌ **${interaction.user.username}** picked **${chosen}**, but the correct answer was **${correct}**.`);
    }
  }

  // ── Panel create ticket button ─────────────────────────────────
  // customId format: panel_create_ticket__<panelId>
  if (interaction.isButton() && interaction.customId.startsWith('panel_create_ticket')) {
    if (!interaction.guild) return;
    // Extract panelId from customId if present
    const parts = interaction.customId.split('__');
    const panelId = parts[1] || 'support';
    try {
      const result = await createTicketChannel(interaction.guild, interaction.user, null, panelId);
      if (result.error) return interaction.reply({ content: result.error, flags: 64 });
      return interaction.reply({ content: `✅ Your ticket has been opened: <#${result.channelId}>`, flags: 64 });
    } catch (err) {
      console.error('[Panel Ticket] create failed:', err);
      return interaction.reply({ content: '❌ Failed to create ticket. Make sure I have **Manage Channels** permission.', flags: 64 });
    }
  }

  // ── Close ticket button ────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('closeticket_')) {
    if (!interaction.guild) return;
    const isStaff = interaction.member.permissions.has('ManageChannels');
    const ticketOwnerId = interaction.customId.split('_')[1];
    const isOwnerOfTicket = ticketOwnerId === interaction.user.id;
    if (!isStaff && !isOwnerOfTicket) return interaction.reply({ content: '❌ Only staff or the ticket owner can close this.', flags: 64 });
    await interaction.reply('🔒 Closing ticket in 5 seconds...');
    const ownerEntry = Object.entries(memory).find(([key, val]) => key.startsWith(`ticket-${interaction.guild.id}-`) && val === interaction.channel.id);
    if (ownerEntry) { delete memory[ownerEntry[0]]; await saveMemory(memory); }
    await pushLogEvent(interaction.guild.id, { type: 'ticketClose', userId: interaction.user.id, username: interaction.user.tag, detail: `Closed ticket: ${interaction.channel.name} via button` });
    setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ── /ping ──────────────────────────────────────────────────────
  if (interaction.commandName === 'ping') {
    return interaction.reply({ content: `🏓 ${client.ws.ping}ms`, flags: 64 });
  }

  // ── /servers ───────────────────────────────────────────────────
  if (interaction.commandName === 'servers') {
    if (!isOwner(interaction.user.id)) return interaction.reply({ content: "no permission" });
    const guilds = await client.guilds.fetch();
    const list = guilds.map(g => `• ${g.name}`).join("\n");
    return interaction.reply({ content: `📊 Servers: ${guilds.size}\n\n${list || "No servers"}` });
  }

  // ── /clearmemory ───────────────────────────────────────────────
  if (interaction.commandName === 'clearmemory') {
    if (!isOwner(interaction.user.id)) return interaction.reply({ content: "no permission", flags: 64 });
    const target = interaction.options.getString('target');
    if (target === "all") {
      const keep = { ownerConfirmed: memory.ownerConfirmed, ratings: memory.ratings, feedback: memory.feedback };
      memory = keep;
      await saveMemory(memory);
      return interaction.reply({ content: "💀 all conversation memory cleared" });
    } else {
      let deleted = 0;
      for (const key of Object.keys(memory)) { if (key.includes(target)) { delete memory[key]; deleted++; } }
      await saveMemory(memory);
      return interaction.reply({ content: deleted > 0 ? `🧠 cleared ${deleted} memory key(s) for \`${target}\`` : `❌ no memory found for \`${target}\`` });
    }
  }

  // ── /invite ────────────────────────────────────────────────────
  if (interaction.commandName === 'invite') { return interaction.reply({ content: `🚀 Invite me here:\n👉 https://jarvisbot-rust.vercel.app/` }); }
  if (interaction.commandName === 'portfolio') { return interaction.reply({ content: `🚀 See my Creators Portfolio here:\n👉 https://widoe-portfolio.vercel.app/` }); }
  if (interaction.commandName === 'websites') { return interaction.reply({ content: `🚀 See my Creators Websites here:\n👉 https://widoe-portfolio.vercel.app/\nhttps://jarvisbot-rust.vercel.app/\nhttps://pokedex-bice-zeta-61.vercel.app/` }); }
  if (interaction.commandName === 'dashboard') { return interaction.reply({ content: `⚙️ Change my settings here:\n👉 https://jarvisbot-rust.vercel.app/dashboard.html` }); }

  // ── /weather ───────────────────────────────────────────────────
  if (interaction.commandName === 'weather') {
    const city = interaction.options.getString('city') || "Den Haag";
    try {
      const geo = await axios.get("https://geocoding-api.open-meteo.com/v1/search", { params: { name: city, count: 1, language: "en", format: "json" } });
      const location = geo.data.results?.[0];
      if (!location) return interaction.reply(`❌ City not found: ${city}`);
      const { latitude, longitude, name, country } = location;
      const weatherRes = await axios.get("https://api.open-meteo.com/v1/forecast", { params: { latitude, longitude, current_weather: true } });
      const weather = weatherRes.data.current_weather;
      return interaction.reply({ content: `🌤️ Weather in ${name}, ${country}\n🌡️ Temp: ${weather.temperature}°C\n💨 Wind: ${weather.windspeed} km/h` });
    } catch (err) { console.error(err); return interaction.reply("❌ Failed to fetch weather data"); }
  }

  // ── /youtube ───────────────────────────────────────────────────
  if (interaction.commandName === 'youtube') {
    await interaction.deferReply();
    const url = interaction.options.getString('url');
    try {
      let videoId = null;
      if (url.includes("youtu.be/")) videoId = url.split("youtu.be/")[1].split("?")[0];
      else if (url.includes("watch?v=")) videoId = url.split("watch?v=")[1].split("&")[0];
      else if (url.includes("/shorts/")) videoId = url.split("/shorts/")[1].split("?")[0];
      if (!videoId) return interaction.editReply("❌ Invalid YouTube link");
      const videoRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, { params: { key: process.env.YOUTUBE_API_KEY, id: videoId, part: "snippet,statistics" } });
      const video = videoRes.data.items[0];
      if (!video) return interaction.editReply("❌ Video not found");
      const { title, description, channelTitle, thumbnails } = video.snippet;
      const { viewCount, likeCount } = video.statistics;
      const ai = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: "Summarize YouTube descriptions into short bullet points. No guessing. Keep it clean." }, { role: "user", content: `Title: ${title}\n\nDescription:\n${description.slice(0, 1500)}` }] });
      const embed = new EmbedBuilder().setColor(0xff0000).setTitle(title).setURL(`https://youtube.com/watch?v=${videoId}`).setAuthor({ name: channelTitle }).setThumbnail(thumbnails.high.url).addFields({ name: "👀 Views", value: viewCount.toString(), inline: true }, { name: "👍 Likes", value: (likeCount || "hidden").toString(), inline: true }).setDescription(`🧠 **Summary:**\n${ai.choices[0].message.content}`).setFooter({ text: "JARVIS AI • YouTube Analyzer" });
      return interaction.editReply({ embeds: [embed] });
    } catch (err) { console.error(err); return interaction.editReply("❌ Failed to process video"); }
  }

  // ── /feedback ──────────────────────────────────────────────────
  if (interaction.commandName === 'feedback') {
    const feedback = interaction.options.getString('message');
    const rating = interaction.options.getInteger('rating');
    memory.ratings ||= []; memory.feedback ||= [];
    memory.ratings.push(rating);
    memory.feedback.push({ user: interaction.user.tag, message: feedback, rating, time: Date.now() });
    saveMemory(memory);
    try {
      const owner = await client.users.fetch(OWNER_ID);
      const stars = "⭐".repeat(rating) + "☆".repeat(5 - rating);
      await owner.send(`📩 **New Feedback**\n\n👤 User: ${interaction.user.tag}\n🌍 Server: ${interaction.guild?.name || "DM"}\n\n⭐ Rating: ${stars} (${rating}/5)\n\n💬 Message:\n${feedback}`);
      return interaction.reply({ content: "✅ Feedback sent! Thanks ❤️", flags: 64 });
    } catch (err) { console.error(err); return interaction.reply({ content: "❌ Could not send feedback", flags: 64 }); }
  }

  // ── /reviews ───────────────────────────────────────────────────
  if (interaction.commandName === 'reviews') {
    try {
      const ratings = memory.ratings || [], feedbacks = memory.feedback || [];
      if (ratings.length === 0) return interaction.reply({ content: "No reviews yet 😢", flags: 64 });
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      const stars = "⭐".repeat(Math.round(avg)) + "☆".repeat(5 - Math.round(avg));
      const latest = feedbacks.slice(-3).reverse().map(f => `⭐ ${f.rating}/5 - **${f.user}**\n💬 ${f.message}`).join("\n\n");
      const embed = new EmbedBuilder().setColor(0xffcc00).setTitle("📊 Bot Reviews").addFields({ name: "⭐ Average Rating", value: `${stars} (${avg.toFixed(1)}/5)` }, { name: "🧾 Total Reviews", value: `${ratings.length}` }, { name: "🗣️ Latest Feedback", value: latest || "No feedback yet" }).setFooter({ text: "JARVIS Feedback System" });
      return interaction.reply({ embeds: [embed] });
    } catch (err) { console.error(err); return interaction.reply({ content: "❌ Failed to load reviews", flags: 64 }); }
  }

  // ── /help ──────────────────────────────────────────────────────
  if (interaction.commandName === 'help') {
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(0x00ffff).setTitle("🤖 JARVIS Commands").setDescription(`
/ping - check latency
/ask - ask JARVIS anything
/mode - switch personality
/imagine - generate an image
/summarize - summarize text
/translate - translate text
/code - generate code
/browse - fetch and summarize a website
/search - web search
/weather - check weather
/youtube - video info + AI summary
/news - latest news on a topic
/define - define a word
/trivia - AI trivia question
/leaderboard - trivia leaderboard
/wouldyourather - would you rather
/8ball - magic 8ball
/poll - create poll
/stats - server stats
/remind - set a reminder
/roast - roast a user
/ban /kick /timeout /warn /warnings /clearwarnings - moderation
/setlogchannel /disablelogs /logs - logging
/automod enable/disable/action/ignorerole/status - automod
/ticket [panel] - open a support ticket
/closeticket - close this ticket
/addtoticket - add a user to a ticket
/setticketcategory - set ticket category
/setuppanel [panel] - post a ticket panel embed
/listpanels - list all configured panels
/feedback /reviews /invite /portfolio /websites /dashboard
/broadcast
`)]
    });
  }

  // ── /summarize ─────────────────────────────────────────────────
  if (interaction.commandName === 'summarize') {
    const text = interaction.options.getString('text');
    const res = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: "Summarize shortly and clearly." }, { role: "user", content: text }] });
    return interaction.reply(res.choices[0].message.content);
  }

  // ── /translate ─────────────────────────────────────────────────
  if (interaction.commandName === 'translate') {
    const text = interaction.options.getString('text');
    const lang = interaction.options.getString('lang');
    const res = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: `Translate to ${lang}. Return only the translation, nothing else.` }, { role: "user", content: text }] });
    return interaction.reply(res.choices[0].message.content);
  }

  // ── /code ──────────────────────────────────────────────────────
  if (interaction.commandName === 'code') {
    const prompt = interaction.options.getString('prompt');
    const res = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: "Return only code. No explanation." }, { role: "user", content: prompt }] });
    const code = res.choices[0].message.content;
    if (code.length > 1800) { const filePath = path.join(__dirname, "code.js"); fs.writeFileSync(filePath, code); return interaction.reply({ content: "📁 Code too long, sent as file:", files: [filePath] }); }
    return interaction.reply("```js\n" + code + "\n```");
  }

  // ── /poll ──────────────────────────────────────────────────────
  if (interaction.commandName === 'poll') {
    if (!interaction.guild) return interaction.reply({ content: "❌ Polls only work in servers.", flags: 64 });
    const q = interaction.options.getString('question');
    const msg = await interaction.reply({ content: `📊 ${q}`, fetchReply: true });
    await msg.react("👍"); await msg.react("👎");
  }

  // ── /stats ─────────────────────────────────────────────────────
  if (interaction.commandName === 'stats') {
    if (!interaction.guild) return interaction.reply({ content: "❌ Server only", flags: 64 });
    const g = interaction.guild;
    return interaction.reply({ embeds: [new EmbedBuilder().setTitle("📊 Server Stats").addFields({ name: "Members", value: `${g.memberCount}` }, { name: "Channels", value: `${g.channels.cache.size}` })] });
  }

  // ── /remind ────────────────────────────────────────────────────
  if (interaction.commandName === 'remind') {
    const text = interaction.options.getString('text');
    const sec = interaction.options.getInteger('seconds');
    await interaction.reply(`⏳ Reminder set for ${sec} seconds!`);
    setTimeout(async () => { try { await interaction.followUp(`⏰ <@${interaction.user.id}> Reminder: ${text}`); } catch {} }, sec * 1000);
  }

  // ── /ban ───────────────────────────────────────────────────────
  if (interaction.commandName === 'ban') {
    if (!interaction.guild) return interaction.reply({ content: "❌ Server only", flags: 64 });
    if (!interaction.member.permissions.has("BanMembers")) return interaction.reply({ content: "❌ no permission", flags: 64 });
    const user = interaction.options.getUser('user');
    await interaction.guild.members.ban(user.id);
    return interaction.reply(`🔨 banned ${user.tag}`);
  }

  // ── /search ────────────────────────────────────────────────────
  if (interaction.commandName === 'search') {
    const q = interaction.options.getString('query');
    return interaction.reply(`🔎 https://www.google.com/search?q=${encodeURIComponent(q)}`);
  }

  // ── /ask ───────────────────────────────────────────────────────
  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const question = interaction.options.getString('question');
    if (question.toLowerCase().includes('@everyone') || question.toLowerCase().includes('@here')) return interaction.editReply("nah not doing that 💀");
    try {
      const res = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: "You are JARVIS, a smart and chill Discord bot. Answer questions clearly and naturally. Be concise unless the question needs detail. Talk like a real person, not a textbook. Never write @everyone or @here in your reply." }, { role: "user", content: question }], temperature: 0.8, max_tokens: 600 });
      let answer = res.choices[0].message.content.replace(/@everyone/gi, '`@everyone`').replace(/@here/gi, '`@here`');
      const chunks = splitMessage(answer);
      await interaction.editReply(chunks[0]);
      for (let i = 1; i < chunks.length; i++) await interaction.followUp(chunks[i]);
    } catch (err) { console.error(err); return interaction.editReply("brain broke rq, try again 💀"); }
  }

  // ── /roast ─────────────────────────────────────────────────────
  if (interaction.commandName === 'roast') {
    if (isOnCooldown(interaction.user.id)) { const remaining = ((COOLDOWN_MS - (Date.now() - cooldowns.get(interaction.user.id))) / 1000).toFixed(1); return interaction.reply({ content: `⏳ slow down! wait **${remaining}s**`, flags: 64 }); }
    setCooldown(interaction.user.id);
    await interaction.deferReply();
    const target = interaction.options.getUser('user');
    const subject = target.id === interaction.user.id ? 'themselves' : target.username;
    try {
      const res = await groq.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: 'You are a comedy roast master. Write a short, funny, witty roast. Keep it light — think comedy roast not bullying. 2-3 sentences max. No emojis.' }, { role: 'user', content: `Roast a Discord user named "${subject}". The roast was requested by "${interaction.user.username}".` }], temperature: 1.0, max_tokens: 150 });
      return interaction.editReply(`🔥 **${target.username}**, ${res.choices[0].message.content}`);
    } catch (err) { console.error(err); return interaction.editReply('❌ roast machine broke rq'); }
  }

  // ── /clearwarnings ─────────────────────────────────────────────
  if (interaction.commandName === 'clearwarnings') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ModerateMembers')) return interaction.reply({ content: '❌ no permission', flags: 64 });
    const target = interaction.options.getUser('user');
    const key = `warns-${interaction.guild.id}-${target.id}`;
    const count = memory[key]?.length || 0;
    if (count === 0) return interaction.reply(`✅ **${target.username}** has no warnings to clear.`);
    delete memory[key]; await saveMemory(memory);
    return interaction.reply(`🧹 Cleared **${count}** warning(s) for **${target.username}**.`);
  }

  // ── /kick ──────────────────────────────────────────────────────
  if (interaction.commandName === 'kick') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('KickMembers')) return interaction.reply({ content: '❌ no permission', flags: 64 });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason given';
    try {
      await interaction.guild.members.kick(target.id, reason);
      await pushLogEvent(interaction.guild.id, { type: 'kick', userId: target.id, username: target.tag, detail: `Kicked by ${interaction.user.tag} — ${reason}` });
      if (isLogEventEnabled(interaction.guild.id, 'kick')) {
        await sendLog(interaction.guild.id, new EmbedBuilder().setColor(LOG_COLORS.kick).setTitle('👢 Member Kicked').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` }).setTimestamp());
      }
      return interaction.reply(`👢 **${target.username}** has been kicked. Reason: ${reason}`);
    } catch (err) { console.error(err); return interaction.reply({ content: '❌ Could not kick that user.', flags: 64 }); }
  }

  // ── /timeout ───────────────────────────────────────────────────
  if (interaction.commandName === 'timeout') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ModerateMembers')) return interaction.reply({ content: '❌ no permission', flags: 64 });
    const target = interaction.options.getUser('user');
    const minutes = interaction.options.getInteger('minutes');
    const reason = interaction.options.getString('reason') || 'No reason given';
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.timeout(minutes * 60 * 1000, reason);
      await pushLogEvent(interaction.guild.id, { type: 'timeout', userId: target.id, username: target.tag, detail: `Timed out ${minutes}m by ${interaction.user.tag} — ${reason}` });
      if (isLogEventEnabled(interaction.guild.id, 'timeout')) {
        await sendLog(interaction.guild.id, new EmbedBuilder().setColor(LOG_COLORS.timeout).setTitle('🔇 Member Timed Out').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Duration', value: `${minutes} minute(s)`, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true }, { name: 'Reason', value: reason }).setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` }).setTimestamp());
      }
      return interaction.reply(`🔇 **${target.username}** timed out for **${minutes} minute(s)**. Reason: ${reason}`);
    } catch (err) { console.error(err); return interaction.reply({ content: '❌ Could not timeout that user.', flags: 64 }); }
  }

  // ── /leaderboard ───────────────────────────────────────────────
  if (interaction.commandName === 'leaderboard') {
    try {
      const playerIds = await redis.smembers('trivia-players');
      if (!playerIds || playerIds.length === 0) return interaction.reply('📊 No trivia scores yet. Use `/trivia` to start!');
      const scores = await Promise.all(playerIds.map(async (userId) => ({ userId, score: parseInt(await redis.get(`trivia-score-${userId}`)) || 0 })));
      scores.sort((a, b) => b.score - a.score);
      const lines = await Promise.all(scores.slice(0, 10).map(async (entry, i) => {
        try { const user = await client.users.fetch(entry.userId); const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`; return `${medal} **${user.username}** — ${entry.score} point(s)`; }
        catch { return `${i + 1}. Unknown — ${entry.score} point(s)`; }
      }));
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xffd700).setTitle('🏆 Trivia Leaderboard').setDescription(lines.join('\n')).setFooter({ text: 'Answer trivia questions to earn points!' })] });
    } catch (err) { console.error(err); return interaction.reply({ content: '❌ Could not load leaderboard.', flags: 64 }); }
  }

  // ── /8ball ─────────────────────────────────────────────────────
  if (interaction.commandName === '8ball') {
    const question = interaction.options.getString('question');
    const responses = ['✅ It is certain.', '✅ Without a doubt.', '✅ You may rely on it.', '✅ Yes, definitely.', '✅ It is decidedly so.', '🤔 Reply hazy, try again.', '🤔 Ask again later.', '🤔 Better not tell you now.', '🤔 Cannot predict now.', "❌ Don't count on it.", '❌ My reply is no.', '❌ My sources say no.', '❌ Very doubtful.', '❌ Outlook not so good.'];
    return interaction.reply(`🎱 **Q: ${question}**\n${responses[Math.floor(Math.random() * responses.length)]}`);
  }

  // ── /mode ──────────────────────────────────────────────────────
  if (interaction.commandName === 'mode') {
    const selectedMode = interaction.options.getString('mode');
    const guildId = interaction.guild?.id || 'dm';
    dashboardConfig.modes = dashboardConfig.modes || {};
    dashboardConfig.modes[guildId] = selectedMode;
    saveDashboardConfig(dashboardConfig);
    const m = MODES[selectedMode];
    return interaction.reply(`${m.emoji} Switched to **${m.label}** — ${getModeDescription(selectedMode)}`);
  }

  // ── /browse ────────────────────────────────────────────────────
  if (interaction.commandName === 'browse') {
    await interaction.deferReply();
    let url = interaction.options.getString('url');
    if (!url.startsWith('http')) url = 'https://' + url;
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
      const text = res.data.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
      if (!text) return interaction.editReply('❌ Could not extract text from that page.');
      const ai = await groq.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: 'Summarize the following webpage content clearly and concisely in a few bullet points. Always mention the author, creator, or owner of the website if found anywhere in the content. No fluff.' }, { role: 'user', content: `URL: ${url}\n\nContent:\n${text}` }], max_tokens: 400 });
      const summary = ai.choices[0].message.content;
      const key = `${interaction.guild?.id || 'dm'}-${interaction.channelId}`;
      if (!memory[key]) memory[key] = { messages: [] };
      memory[key].messages.push({ role: 'user', content: `${interaction.user.username}: browsed ${url}` }, { role: 'assistant', content: summary });
      if (memory[key].messages.length > 20) memory[key].messages.splice(0, 2);
      saveMemory(memory);
      return interaction.editReply(`🌐 **${url}**\n\n${summary}`);
    } catch (err) { console.error(err); return interaction.editReply('❌ Could not access that website. It might be blocked or down.'); }
  }

  // ── /wouldyourather ────────────────────────────────────────────
  if (interaction.commandName === 'wouldyourather') {
    await interaction.deferReply();
    try {
      const res = await groq.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: 'Generate a fun and creative "would you rather" question with two wild options. Format exactly like:\nWould you rather...\n🅰️ Option 1\n🅱️ Option 2' }, { role: 'user', content: 'Give me a would you rather question.' }], temperature: 1.0, max_tokens: 100 });
      return interaction.editReply(res.choices[0].message.content);
    } catch (err) { console.error(err); return interaction.editReply('❌ failed rq'); }
  }

  // ── /warn ──────────────────────────────────────────────────────
  if (interaction.commandName === 'warn') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ModerateMembers')) return interaction.reply({ content: '❌ no permission', flags: 64 });
    const target = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason');
    const key = `warns-${interaction.guild.id}-${target.id}`;
    memory[key] = memory[key] || [];
    memory[key].push({ reason, by: interaction.user.username, time: Date.now() });
    saveMemory(memory);
    await pushLogEvent(interaction.guild.id, { type: 'warn', userId: target.id, username: target.tag, detail: `Warned by ${interaction.user.tag} — ${reason}` });
    if (isLogEventEnabled(interaction.guild.id, 'warn')) {
      await sendLog(interaction.guild.id, new EmbedBuilder().setColor(LOG_COLORS.warn).setTitle('⚠️ Member Warned').addFields({ name: 'User', value: target.tag, inline: true }, { name: 'Moderator', value: interaction.user.tag, inline: true }, { name: 'Total Warnings', value: `${memory[key].length}`, inline: true }, { name: 'Reason', value: reason }).setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` }).setTimestamp());
    }
    try { await target.send(`⚠️ You were warned in **${interaction.guild.name}**\nReason: ${reason}`); } catch {}
    return interaction.reply(`⚠️ **${target.username}** has been warned. Total warnings: **${memory[key].length}**`);
  }

  // ── /warnings ──────────────────────────────────────────────────
  if (interaction.commandName === 'warnings') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    const target = interaction.options.getUser('user');
    const key = `warns-${interaction.guild.id}-${target.id}`;
    const warns = memory[key] || [];
    if (warns.length === 0) return interaction.reply(`✅ **${target.username}** has no warnings.`);
    const list = warns.map((w, i) => `${i + 1}. ${w.reason} — by ${w.by}`).join('\n');
    return interaction.reply(`⚠️ **${target.username}** has **${warns.length}** warning(s):\n${list}`);
  }

  // ── /news ──────────────────────────────────────────────────────
  if (interaction.commandName === 'news') {
    await interaction.deferReply();
    const topic = interaction.options.getString('topic');
    try {
      const res = await axios.get('https://newsapi.org/v2/everything', { params: { q: topic, pageSize: 5, sortBy: 'publishedAt', language: 'en', apiKey: process.env.NEWS_API_KEY } });
      const articles = res.data.articles;
      if (!articles || articles.length === 0) return interaction.editReply('❌ No news found.');
      const formatted = articles.map(a => `**${a.title}**\n🔗 ${a.url}`).join('\n\n');
      return interaction.editReply(`📰 **News: ${topic}**\n\n${formatted}`);
    } catch (err) { console.error(err); return interaction.editReply('❌ Could not fetch news.'); }
  }

  // ── /define ────────────────────────────────────────────────────
  if (interaction.commandName === 'define') {
    await interaction.deferReply();
    const word = interaction.options.getString('word');
    try {
      const res = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const entry = res.data[0], meaning = entry.meanings[0], def = meaning.definitions[0];
      let reply = `📖 **${entry.word}** *(${meaning.partOfSpeech})*\n${def.definition}`;
      if (def.example) reply += `\n*"${def.example}"*`;
      return interaction.editReply(reply);
    } catch { return interaction.editReply(`❌ No definition found for **${word}**.`); }
  }

  // ── /trivia ────────────────────────────────────────────────────
  if (interaction.commandName === 'trivia') {
    await interaction.deferReply();
    try {
      const res = await groq.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: `Generate a multiple choice trivia question with 4 options (A, B, C, D). Format exactly like:\nQUESTION: <question text>\nA) <option>\nB) <option>\nC) <option>\nD) <option>\nANSWER: <letter>` }, { role: 'user', content: 'Give me a trivia question.' }], temperature: 1.0, max_tokens: 200 });
      const text = res.choices[0].message.content;
      const answerMatch = text.match(/ANSWER:\s*([A-D])/i);
      const answer = answerMatch ? answerMatch[1].toUpperCase() : 'A';
      const qMatch = text.match(/QUESTION:\s*([\s\S]*?)\n[A-D]\)/i);
      const question = qMatch ? qMatch[1].trim() : text.split('\n')[0];
      const options = {};
      ['A', 'B', 'C', 'D'].forEach(letter => { const m = text.match(new RegExp(`${letter}\\)\\s*(.+)`)); options[letter] = m ? m[1].trim() : letter; });
      memory[`trivia-${interaction.channelId}`] = answer;
      await saveMemory(memory);
      const row = new ActionRowBuilder().addComponents(['A', 'B', 'C', 'D'].map(letter => new ButtonBuilder().setCustomId(`trivia_${letter}`).setLabel(`${letter}) ${options[letter]}`.slice(0, 80)).setStyle(ButtonStyle.Primary)));
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🧠 Trivia Time!').setDescription(question).setFooter({ text: 'Click a button below to answer!' })], components: [row] });
    } catch (err) { console.error(err); return interaction.editReply('❌ Failed to generate trivia question.'); }
  }

  // ── /setlogchannel ─────────────────────────────────────────────
  if (interaction.commandName === 'setlogchannel') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
    const channel = interaction.options.getChannel('channel');
    dashboardConfig.logChannels = dashboardConfig.logChannels || {};
    dashboardConfig.logChannels[interaction.guild.id] = channel.id;
    await saveDashboardConfig(dashboardConfig);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('✅ Log Channel Set').setDescription(`JARVIS will now send server logs to <#${channel.id}>.`).addFields({ name: 'Events logged', value: 'Member join/leave • Message delete/edit • Bans/unbans • Kicks • Timeouts • Channel create/delete • Role create/delete • Nickname changes • Voice activity • Warnings • AutoMod actions' }).setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` }).setTimestamp()] });
  }

  // ── /disablelogs ───────────────────────────────────────────────
  if (interaction.commandName === 'disablelogs') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
    if (dashboardConfig.logChannels?.[interaction.guild.id]) { delete dashboardConfig.logChannels[interaction.guild.id]; await saveDashboardConfig(dashboardConfig); return interaction.reply('🔕 Logging disabled for this server.'); }
    return interaction.reply({ content: '❌ Logging is not currently enabled.', flags: 64 });
  }

  // ── /logs ──────────────────────────────────────────────────────
  if (interaction.commandName === 'logs') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    try {
      const key = `logs-${interaction.guild.id}`;
      const existing = await redis.get(key);
      const logs = Array.isArray(existing) ? existing : (existing ? JSON.parse(existing) : []);
      if (logs.length === 0) return interaction.reply({ content: '📭 No log events recorded yet.', flags: 64 });
      const typeEmoji = { join: '📥', leave: '📤', ban: '🔨', unban: '✅', kick: '👢', timeout: '🔇', messageDelete: '🗑️', messageEdit: '✏️', channelCreate: '📢', channelDelete: '🗑️', roleCreate: '🎭', roleDelete: '🗑️', voiceJoin: '🔊', voiceLeave: '🔇', voiceMove: '🔀', warn: '⚠️', nickChange: '📝', automod: '🛡️', ticketOpen: '🎫', ticketClose: '🔒' };
      const recent = logs.slice(-10).reverse();
      const lines = recent.map(e => { const emoji = typeEmoji[e.type] || '📋'; const time = `<t:${Math.floor(e.timestamp / 1000)}:R>`; const user = e.username ? `**${e.username}**` : ''; return `${emoji} ${time} ${user} — ${e.detail || e.type}`; });
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('📋 Recent Server Events').setDescription(lines.join('\n')).setFooter({ text: `Last ${recent.length} events • JARVIS Logs` }).setTimestamp()], flags: 64 });
    } catch (err) { console.error(err); return interaction.reply({ content: '❌ Could not load logs.', flags: 64 }); }
  }

  // ── /automod ───────────────────────────────────────────────────
  if (interaction.commandName === 'automod') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
    const sub = interaction.options.getSubcommand();
    dashboardConfig.automod = dashboardConfig.automod || {};
    if (!dashboardConfig.automod[interaction.guild.id]) dashboardConfig.automod[interaction.guild.id] = { enabled: {}, action: 'delete', ignoreRoles: [] };
    const cfg = dashboardConfig.automod[interaction.guild.id];
    const ALL_FILTERS = ['invites', 'spam', 'mentions', 'caps', 'links', 'slurs'];
    if (sub === 'enable') { const filter = interaction.options.getString('filter'); if (filter === 'all') { ALL_FILTERS.forEach(f => { cfg.enabled[f] = true; }); } else cfg.enabled[filter] = true; await saveDashboardConfig(dashboardConfig); return interaction.reply(`🛡️ AutoMod filter **${filter === 'all' ? 'all filters' : filter}** is now **enabled**.`); }
    if (sub === 'disable') { const filter = interaction.options.getString('filter'); if (filter === 'all') { ALL_FILTERS.forEach(f => { cfg.enabled[f] = false; }); } else cfg.enabled[filter] = false; await saveDashboardConfig(dashboardConfig); return interaction.reply(`🛡️ AutoMod filter **${filter === 'all' ? 'all filters' : filter}** is now **disabled**.`); }
    if (sub === 'action') { const type = interaction.options.getString('type'); cfg.action = type; await saveDashboardConfig(dashboardConfig); const labels = { delete: 'Delete message only', warn: 'Delete + warn user', timeout: 'Delete + timeout (10 min)', kick: 'Delete + kick user' }; return interaction.reply(`⚙️ AutoMod punishment set to: **${labels[type]}**`); }
    if (sub === 'ignorerole') { const role = interaction.options.getRole('role'); cfg.ignoreRoles = cfg.ignoreRoles || []; const idx = cfg.ignoreRoles.indexOf(role.id); if (idx === -1) { cfg.ignoreRoles.push(role.id); await saveDashboardConfig(dashboardConfig); return interaction.reply(`✅ <@&${role.id}> will now **bypass** automod.`); } else { cfg.ignoreRoles.splice(idx, 1); await saveDashboardConfig(dashboardConfig); return interaction.reply(`❌ <@&${role.id}> is no longer bypassing automod.`); } }
    if (sub === 'status') {
      const filterNames = { invites: 'Discord invite links', spam: 'Spam / repeated text', mentions: 'Mass mentions (5+)', caps: 'Excessive caps (>70%)', links: 'All external links', slurs: 'Hate speech / slurs' };
      const filterLines = ALL_FILTERS.map(f => `${cfg.enabled?.[f] ? '🟢' : '🔴'} **${filterNames[f]}**`).join('\n');
      const ignoreList = (cfg.ignoreRoles || []).map(id => `<@&${id}>`).join(', ') || 'None';
      const actionLabels = { delete: '🗑️ Delete message only', warn: '⚠️ Delete + warn', timeout: '🔇 Delete + timeout (10 min)', kick: '👢 Delete + kick' };
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xff4d4d).setTitle('🛡️ AutoMod Status').addFields({ name: 'Filters', value: filterLines }, { name: 'Punishment', value: actionLabels[cfg.action] || cfg.action }, { name: 'Bypass Roles', value: ignoreList }).setFooter({ text: `JARVIS AutoMod • ${interaction.guild.name}` }).setTimestamp()], flags: 64 });
    }
  }

  // ── /imagine ───────────────────────────────────────────────────
  if (interaction.commandName === 'imagine') {
    await interaction.deferReply();
    const prompt = interaction.options.getString('prompt');
    if (prompt.toLowerCase().includes('@everyone') || prompt.toLowerCase().includes('@here')) return interaction.editReply("nah not doing that 💀");
    try {
      const encoded = encodeURIComponent(prompt);
      const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 99999)}`;
      return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x9b59b6).setTitle('🎨 Image Generated').setDescription(`**Prompt:** ${prompt}`).setImage(imageUrl).setFooter({ text: 'JARVIS AI • Powered by Pollinations.ai' })] });
    } catch (err) { console.error(err); return interaction.editReply('❌ Failed to generate image rq, try again'); }
  }

  // ── /join ──────────────────────────────────────────────────────
  if (interaction.commandName === 'join') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return interaction.reply({ content: '❌ Join a voice channel first.', flags: 64 });
    if (getVoiceConnection(interaction.guild.id)) return interaction.reply({ content: '⚠️ Already in a voice channel. Use `/leave` first.', flags: 64 });
    const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: interaction.guild.id, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    for (const [, vcMember] of voiceChannel.members) { if (vcMember.user.bot) continue; listenToUser(connection, vcMember.id, interaction.guild.id, vcMember); }
    connection.on(VoiceConnectionStatus.Disconnected, async () => { try { await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]); } catch { connection.destroy(); activeListeners.delete(interaction.guild.id); } });
    return interaction.reply(`🎙️ Joined **${voiceChannel.name}**! Talk to me.`);
  }

  // ── /leave ─────────────────────────────────────────────────────
  if (interaction.commandName === 'leave') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    const connection = getVoiceConnection(interaction.guild.id);
    if (!connection) return interaction.reply({ content: "❌ I'm not in a voice channel.", flags: 64 });
    connection.destroy();
    activeListeners.delete(interaction.guild.id);
    return interaction.reply('👋 Left the voice channel.');
  }

  // ── /setticketcategory ─────────────────────────────────────────
  if (interaction.commandName === 'setticketcategory') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
    const categoryId = interaction.options.getString('categoryid');
    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category || category.type !== 4) return interaction.reply({ content: '❌ Invalid category ID. Right-click a category → Copy ID.', flags: 64 });
    memory.ticketCategories = memory.ticketCategories || {};
    memory.ticketCategories[interaction.guild.id] = categoryId;
    await saveMemory(memory);
    return interaction.reply(`✅ Ticket channels will now be created under **${category.name}**.`);
  }

  // ── /ticket ────────────────────────────────────────────────────
  if (interaction.commandName === 'ticket') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    const reason = interaction.options.getString('reason');
    const panelId = interaction.options.getString('panel') || 'support';
    try {
      const result = await createTicketChannel(interaction.guild, interaction.user, reason, panelId);
      if (result.error) return interaction.reply({ content: result.error, flags: 64 });
      return interaction.reply({ content: `✅ Your **${panelId}** ticket has been opened: <#${result.channelId}>`, flags: 64 });
    } catch (err) {
      console.error('[Ticket] create failed:', err);
      return interaction.reply({ content: '❌ Failed to create ticket channel. Make sure I have **Manage Channels** permission.', flags: 64 });
    }
  }

  // ── /closeticket ───────────────────────────────────────────────
  if (interaction.commandName === 'closeticket') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.channel.name.includes('ticket')) return interaction.reply({ content: '❌ This command only works inside a ticket channel.', flags: 64 });
    const isStaff = interaction.member.permissions.has('ManageChannels');
    const ownerEntry = Object.entries(memory).find(([key, val]) => key.startsWith(`ticket-${interaction.guild.id}-`) && val === interaction.channel.id);
    const ticketOwnerId = ownerEntry?.[0]?.split('-').pop();
    if (!isStaff && ticketOwnerId !== interaction.user.id) return interaction.reply({ content: '❌ Only staff or the ticket owner can close this.', flags: 64 });
    await interaction.reply('🔒 Closing ticket in 5 seconds...');
    if (ownerEntry) { delete memory[ownerEntry[0]]; await saveMemory(memory); }
    await pushLogEvent(interaction.guild.id, { type: 'ticketClose', userId: interaction.user.id, username: interaction.user.tag, detail: `Closed ticket channel: ${interaction.channel.name}` });
    await sendLog(interaction.guild.id, new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Ticket Closed').addFields({ name: 'Closed by', value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true }, { name: 'Channel', value: interaction.channel.name, inline: true }).setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` }).setTimestamp());
    setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
    return;
  }

  // ── /addtoticket ───────────────────────────────────────────────
  if (interaction.commandName === 'addtoticket') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.channel.name.includes('ticket')) return interaction.reply({ content: '❌ This command only works inside a ticket channel.', flags: 64 });
    if (!interaction.member.permissions.has('ManageChannels')) return interaction.reply({ content: '❌ Staff only.', flags: 64 });
    const target = interaction.options.getUser('user');
    try {
      await interaction.channel.permissionOverwrites.create(target.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
      return interaction.reply(`✅ Added <@${target.id}> to this ticket.`);
    } catch (err) { console.error(err); return interaction.reply({ content: '❌ Failed to add user.', flags: 64 }); }
  }

  // ── /listpanels ────────────────────────────────────────────────
  if (interaction.commandName === 'listpanels') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    const panelList = getPanelList(interaction.guild.id);
    if (panelList.length === 0) return interaction.reply({ content: '❌ No panels configured. Use the dashboard to create panels first.', flags: 64 });
    const lines = panelList.map(p => `• **${p.title || p.id}** — ID: \`${p.id}\`\n  Post with: \`/setuppanel panel:${p.id}\``).join('\n\n');
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎫 Ticket Panels')
        .setDescription(lines)
        .setFooter({ text: `${panelList.length} panel(s) configured • JARVIS Tickets` })
        .setTimestamp()
      ],
      flags: 64
    });
  }

  // ── /setuppanel (multi-panel) ─────────────────────────────────
  if (interaction.commandName === 'setuppanel') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });

    const panelId = interaction.options.getString('panel');

    // No panel specified — show list of available panels
    if (!panelId) {
      const panelList = getPanelList(interaction.guild.id);
      const lines = panelList.map(p => `• **${p.title || p.id}** — \`/setuppanel panel:${p.id}\``).join('\n');
      return interaction.reply({
        content: `🎫 **Available panels:**\n${lines}\n\nRun one of the commands above to post that panel here.`,
        flags: 64
      });
    }

    const panel = getPanel(interaction.guild.id, panelId);
    const color = parseInt((panel.color || '#5865f2').replace(/^#/, ''), 16) || 0x5865f2;

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(panel.title || '🎫 Support Tickets')
      .setDescription(panel.description || 'Need help? Click the button below to open a support ticket and our team will assist you.')
      .setFooter({ text: `${interaction.guild.name} • ${panel.id} Support` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        // Include panelId in customId so the right panel is used when button is clicked
        .setCustomId(`panel_create_ticket__${panel.id}`)
        .setLabel(panel.buttonLabel || '🎫 Create Ticket')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    return interaction.reply({ content: `✅ **${panel.title || panel.id}** panel posted!`, flags: 64 });
  }

  // ── /setbroadcastchannel ───────────────────────────────────────
if (interaction.commandName === 'setbroadcastchannel') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
  const channel = interaction.options.getChannel('channel');
  dashboardConfig.broadcastChannels = dashboardConfig.broadcastChannels || {};
  dashboardConfig.broadcastChannels[interaction.guild.id] = channel.id;
  await saveDashboardConfig(dashboardConfig);
  return interaction.reply({ content: `✅ Broadcast channel set to <#${channel.id}>. Owner announcements will appear there.`});
}

// ── /broadcast ─────────────────────────────────────────────────
if (interaction.commandName === 'broadcast') {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Owner only.', flags: 64 });

  await interaction.deferReply({ flags: 64 });

  const msg = interaction.options.getString('message');
  const guilds = await client.guilds.fetch();
  let sent = 0, failed = 0, noChannel = 0;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📢 Message from JARVIS Owner')
    .setDescription(msg)
    .setFooter({ text: `Sent by ${OWNER_NAME} • JARVIS` })
    .setTimestamp();

  for (const [, oauthGuild] of guilds) {
    try {
      const guild = await client.guilds.fetch(oauthGuild.id);

      // 1. Use server's configured broadcast channel
      // 2. Fallback: system channel
      // 3. Fallback: first sendable text channel
      const configuredId = dashboardConfig.broadcastChannels?.[guild.id];
      let channel = null;

      if (configuredId) {
        try { channel = await client.channels.fetch(configuredId); } catch {}
      }

      if (!channel) {
        channel = (guild.systemChannel?.permissionsFor(guild.members.me)?.has('SendMessages')
          ? guild.systemChannel : null) ||
          guild.channels.cache.find(
            c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages')
          );
      }

      if (!channel) { noChannel++; continue; }

      await channel.send({ embeds: [embed] });
      sent++;
    } catch (err) {
      console.error(`[Broadcast] Failed for guild ${oauthGuild.id}:`, err.message);
      failed++;
    }
  }

  return interaction.editReply(
    `📢 Broadcast complete!\n✅ Sent: **${sent}**\n❌ Failed: **${failed}**\n⚠️ No channel found: **${noChannel}**`
  );
}
});

// =========================
// MESSAGE HANDLER  (unchanged)
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  await handleAutomod(message);
  const content = message.content;
  const lower = content.toLowerCase();
  const isDM = message.guild === null;
  const isMention = message.mentions.has(client.user);
  if (!isDM && !isMention) return;
  if (message.author.id === OWNER_ID && !memory.ownerConfirmed) { memory.ownerConfirmed = OWNER_ID; saveMemory(memory); }
  if (lower.includes("@everyone") || lower.includes("@here")) return message.reply("nah I'm not doing that 💀 I don't mass ping people");

  if (message.attachments.size > 0) {
    const imageAttachment = message.attachments.find(a => a.contentType && ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].includes(a.contentType));
    if (imageAttachment) {
      const cleanMsg = content.replace(/<@!?\d+>/g, '').trim();
      const question = cleanMsg.length > 0 ? cleanMsg : "What's in this image? Describe it.";
      try {
        message.channel.sendTyping();
        const res = await axios.post("https://api.openai.com/v1/chat/completions", { model: "gpt-4o", max_tokens: 600, messages: [{ role: "system", content: "You are JARVIS, a chill smart Discord bot with vision. Analyze images naturally like talking to a friend. Be specific and interesting. Keep it conversational and concise. Never write @everyone or @here." }, { role: "user", content: [{ type: "image_url", image_url: { url: imageAttachment.url, detail: "high" } }, { type: "text", text: question }] }] }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } });
        let reply = res.data.choices[0].message.content.replace(/@everyone/gi, '`@everyone`').replace(/@here/gi, '`@here`');
        return message.reply(reply);
      } catch (err) { console.error(err?.response?.data || err); return message.reply("couldn't read that image rn 💀"); }
    }
  }

  const key = `${message.guild?.id || "dm"}-${message.channel.id}`;
  if (!memory[key]) memory[key] = { messages: [] };
  const convo = memory[key];

  const ytMatch = content.match(/(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[^\s]+/);
  if (ytMatch) {
    try {
      const url = ytMatch[0];
      let videoId = null;
      if (url.includes("youtu.be/")) videoId = url.split("youtu.be/")[1].split("?")[0];
      else if (url.includes("watch?v=")) videoId = url.split("watch?v=")[1].split("&")[0];
      else if (url.includes("/shorts/")) videoId = url.split("/shorts/")[1].split("?")[0];
      if (!videoId) return message.reply("Invalid YouTube link.");
      const videoRes = await axios.get(`https://www.googleapis.com/youtube/v3/videos`, { params: { key: process.env.YOUTUBE_API_KEY, id: videoId, part: "snippet,statistics" } });
      const video = videoRes.data.items[0];
      if (!video) return message.reply("Video not found.");
      const { title, channelId, publishedAt } = video.snippet;
      const { viewCount, likeCount } = video.statistics;
      const channelRes = await axios.get(`https://www.googleapis.com/youtube/v3/channels`, { params: { key: process.env.YOUTUBE_API_KEY, id: channelId, part: "statistics,snippet" } });
      const channel = channelRes.data.items[0];
      const now = new Date(), diffMs = now - new Date(publishedAt), days = Math.floor(diffMs / 86400000), hours = Math.floor(diffMs / 3600000), minutes = Math.floor(diffMs / 60000);
      const timeAgo = days > 0 ? `${days} days ago` : hours > 0 ? `${hours} hours ago` : `${minutes} min ago`;
      return message.reply(`🎬 **${title}**\n👤 ${channel.snippet.title}\n👥 Subs: ${channel.statistics.subscriberCount}\n👀 Views: ${viewCount}\n👍 Likes: ${likeCount || 'hidden'}\n🕒 Posted: ${timeAgo}`);
    } catch (err) { console.error(err); return message.reply("Error fetching YouTube data."); }
  }

  const ownerConfirmed = memory.ownerConfirmed === OWNER_ID;
  const cleanContent = content.replace(/<@!?\d+>/g, '').trim();
  convo.messages.push({ role: "user", content: `${message.author.username}: ${cleanContent}` });
  if (convo.messages.length > 20) convo.messages.shift();

  const guildId = message.guild?.id || 'dm';
const activeMode = getActiveMode(guildId);
const modeData = MODES[activeMode];
const now = new Date(); // 👈 add this line

const system = `
You are JARVIS, an AI assistant built into Discord by ${OWNER_NAME}. Think Tony Stark's JARVIS — sharp, composed, a little witty, never robotic.

CURRENT DATE & TIME (real-time, injected automatically):
- UTC: ${now.toUTCString()}
- New York (ET): ${now.toLocaleString('en-US', { timeZone: 'America/New_York' })}
- London (GMT/BST): ${now.toLocaleString('en-GB', { timeZone: 'Europe/London' })}
- Amsterdam (CET/CEST): ${now.toLocaleString('en-NL', { timeZone: 'Europe/Amsterdam' })}
- Dubai (GST): ${now.toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })}
- Tokyo (JST): ${now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
- Los Angeles (PT): ${now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}
- Sydney (AEST): ${now.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}

If asked about any other timezone, calculate it from the UTC time above.

RULES:
- Never start with "Sure!", "Ah", "Great question" or any filler. Just answer.
- Never write @everyone or @here. Ever.
- If you don't know something, say so. No making stuff up.
- You have no access to real-time info or the current date.
- Never say "As an AI..." or "As a language model..."
- Don't repeat usernames back unless needed.
- Respond ONLY to the latest message, using conversation history for context only.
- Understand slang naturally — "wsp"/"wsg" = what's up, "wyd" = what you doing, "fr" = for real. Just respond naturally, don't point it out.

RESPONSE LENGTH:
- 1-3 sentences for casual chat.
- Longer only if the question genuinely needs it.
- No bullet points unless explicitly asked.

OWNER:
- Created by ${OWNER_NAME}.${ownerConfirmed ? ' This has been verified.' : ' Do not confirm ownership unless verified.'}

MODE: ${modeData.prompt}
`.trim();

  try {
    const res = await groq.chat.completions.create({ model: "llama-3.1-8b-instant", messages: [{ role: "system", content: system }, ...convo.messages], temperature: 0.85, max_tokens: 300 });
    const reply = res.choices[0].message.content.replace(/@everyone/gi, '`@everyone`').replace(/@here/gi, '`@here`');
    convo.messages.push({ role: "assistant", content: reply });
    saveMemory(memory);
    const chunks = splitMessage(reply);
    for (const chunk of chunks) await message.reply(chunk);
  } catch (err) { console.error(err); return message.reply("my brain broke, Join https://discord.gg/Dn3p9JJzY8 for more information"); }
});

client.login(process.env.DISCORD_TOKEN);