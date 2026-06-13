require('dotenv').config({ path: __dirname + '/.env' });


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
const processing = new Set();

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

async function saveMemory(data) {
  try {
    await redis.set('jarvis-memory', JSON.stringify(data));
    console.log('✅ Memory saved to Redis');
  } catch (err) {
    console.error('Redis save failed:', err);
  }
}

// =========================
// DASHBOARD CONFIG REFRESH
// =========================
const DASHBOARD_KEYS = ['logChannels', 'modes', 'automod'];

async function refreshDashboardConfig() {
  try {
    const data = await redis.get('jarvis-memory');
    const remote = data ? (typeof data === 'string' ? JSON.parse(data) : data) : {};
    for (const key of DASHBOARD_KEYS) {
      if (remote[key] !== undefined) {
        memory[key] = remote[key];
      }
    }
  } catch (err) {
    console.error('[Dashboard] refresh failed:', err.message);
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
// LOGGING SYSTEM
// =========================
async function getLogChannel(guildId) {
  const channelId = memory.logChannels?.[guildId];
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

async function pushLogEvent(guildId, event) {
  try {
    const key = `logs-${guildId}`;
    const existing = await redis.get(key);
    // Upstash auto-parses, so check if it's already an array
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

// ─── Member Join ──────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const event = {
    type: 'join',
    userId: member.id,
    username: member.user.tag,
    detail: `Account created: <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`
  };
  await pushLogEvent(member.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.join)
    .setTitle('📥 Member Joined')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: 'ID', value: member.id, inline: true },
      { name: 'Account Age', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${member.guild.name}` })
    .setTimestamp();

  await sendLog(member.guild.id, embed);
});

// ─── Member Leave ─────────────────────────────────────────────
client.on('guildMemberRemove', async (member) => {
  const roles = member.roles.cache
    .filter(r => r.id !== member.guild.id)
    .map(r => `<@&${r.id}>`)
    .join(', ') || 'None';

  const event = {
    type: 'leave',
    userId: member.id,
    username: member.user.tag,
    detail: `Left or was removed`
  };
  await pushLogEvent(member.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.leave)
    .setTitle('📤 Member Left')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${member.user.tag}`, inline: true },
      { name: 'ID', value: member.id, inline: true },
      { name: 'Roles', value: roles.length > 1024 ? roles.slice(0, 1021) + '...' : roles }
    )
    .setFooter({ text: `JARVIS Logs • ${member.guild.name}` })
    .setTimestamp();

  await sendLog(member.guild.id, embed);
});

// ─── Message Delete ───────────────────────────────────────────
client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;

  const event = {
    type: 'messageDelete',
    userId: message.author?.id,
    username: message.author?.tag,
    detail: message.content?.slice(0, 200) || '[no content]'
  };
  await pushLogEvent(message.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.messageDelete)
    .setTitle('🗑️ Message Deleted')
    .addFields(
      { name: 'Author', value: message.author ? `<@${message.author.id}> (${message.author.tag})` : 'Unknown', inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Content', value: message.content?.slice(0, 1024) || '*[empty or attachment]*' }
    )
    .setFooter({ text: `JARVIS Logs • ${message.guild.name}` })
    .setTimestamp();

  await sendLog(message.guild.id, embed);
});

// ─── Message Edit ─────────────────────────────────────────────
client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;

  const event = {
    type: 'messageEdit',
    userId: newMsg.author?.id,
    username: newMsg.author?.tag,
    detail: `Before: ${oldMsg.content?.slice(0, 100)}`
  };
  await pushLogEvent(newMsg.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.messageEdit)
    .setTitle('✏️ Message Edited')
    .setURL(newMsg.url)
    .addFields(
      { name: 'Author', value: `<@${newMsg.author.id}> (${newMsg.author.tag})`, inline: true },
      { name: 'Channel', value: `<#${newMsg.channel.id}>`, inline: true },
      { name: 'Before', value: oldMsg.content?.slice(0, 512) || '*[unavailable]*' },
      { name: 'After',  value: newMsg.content?.slice(0, 512) || '*[empty]*' }
    )
    .setFooter({ text: `JARVIS Logs • ${newMsg.guild.name}` })
    .setTimestamp();

  await sendLog(newMsg.guild.id, embed);
});

// ─── Ban ──────────────────────────────────────────────────────
client.on('guildBanAdd', async (ban) => {
  let moderator = 'Unknown';
  let reason = ban.reason || 'No reason given';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBan, limit: 1 });
    const entry = audit.entries.first();
    if (entry && entry.target.id === ban.user.id) {
      moderator = entry.executor?.tag || 'Unknown';
      reason = entry.reason || reason;
    }
  } catch {}

  const event = {
    type: 'ban',
    userId: ban.user.id,
    username: ban.user.tag,
    detail: `Banned by ${moderator} — ${reason}`
  };
  await pushLogEvent(ban.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.ban)
    .setTitle('🔨 Member Banned')
    .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: 'User', value: `${ban.user.tag}`, inline: true },
      { name: 'ID', value: ban.user.id, inline: true },
      { name: 'Moderator', value: moderator, inline: true },
      { name: 'Reason', value: reason }
    )
    .setFooter({ text: `JARVIS Logs • ${ban.guild.name}` })
    .setTimestamp();

  await sendLog(ban.guild.id, embed);
});

// ─── Unban ────────────────────────────────────────────────────
client.on('guildBanRemove', async (ban) => {
  let moderator = 'Unknown';
  try {
    await new Promise(r => setTimeout(r, 1000));
    const audit = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUnban, limit: 1 });
    const entry = audit.entries.first();
    if (entry && entry.target.id === ban.user.id) {
      moderator = entry.executor?.tag || 'Unknown';
    }
  } catch {}

  const event = {
    type: 'unban',
    userId: ban.user.id,
    username: ban.user.tag,
    detail: `Unbanned by ${moderator}`
  };
  await pushLogEvent(ban.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.unban)
    .setTitle('✅ Member Unbanned')
    .addFields(
      { name: 'User', value: `${ban.user.tag}`, inline: true },
      { name: 'ID', value: ban.user.id, inline: true },
      { name: 'Moderator', value: moderator, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${ban.guild.name}` })
    .setTimestamp();

  await sendLog(ban.guild.id, embed);
});

// ─── Channel Create ───────────────────────────────────────────
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

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.channelCreate)
    .setTitle('📢 Channel Created')
    .addFields(
      { name: 'Channel', value: `<#${channel.id}> (${channel.name})`, inline: true },
      { name: 'Type', value: channel.type.toString(), inline: true },
      { name: 'Created by', value: creator, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${channel.guild.name}` })
    .setTimestamp();

  await sendLog(channel.guild.id, embed);
});

// ─── Channel Delete ───────────────────────────────────────────
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

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.channelDelete)
    .setTitle('🗑️ Channel Deleted')
    .addFields(
      { name: 'Channel', value: `#${channel.name}`, inline: true },
      { name: 'Deleted by', value: deleter, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${channel.guild.name}` })
    .setTimestamp();

  await sendLog(channel.guild.id, embed);
});

// ─── Role Create ──────────────────────────────────────────────
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

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.roleCreate)
    .setTitle('🎭 Role Created')
    .addFields(
      { name: 'Role', value: `<@&${role.id}> (${role.name})`, inline: true },
      { name: 'Created by', value: creator, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${role.guild.name}` })
    .setTimestamp();

  await sendLog(role.guild.id, embed);
});

// ─── Role Delete ──────────────────────────────────────────────
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

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.roleDelete)
    .setTitle('🗑️ Role Deleted')
    .addFields(
      { name: 'Role', value: role.name, inline: true },
      { name: 'Deleted by', value: deleter, inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${role.guild.name}` })
    .setTimestamp();

  await sendLog(role.guild.id, embed);
});

// ─── Nickname Change ──────────────────────────────────────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (oldMember.nickname === newMember.nickname) return;

  const event = {
    type: 'nickChange',
    userId: newMember.id,
    username: newMember.user.tag,
    detail: `${oldMember.nickname || 'none'} → ${newMember.nickname || 'none'}`
  };
  await pushLogEvent(newMember.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS.nickChange)
    .setTitle('📝 Nickname Changed')
    .addFields(
      { name: 'User', value: `<@${newMember.id}> (${newMember.user.tag})`, inline: true },
      { name: 'Before', value: oldMember.nickname || '*none*', inline: true },
      { name: 'After',  value: newMember.nickname || '*none*', inline: true }
    )
    .setFooter({ text: `JARVIS Logs • ${newMember.guild.name}` })
    .setTimestamp();

  await sendLog(newMember.guild.id, embed);
});

// ─── Voice State ──────────────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild) return;
  const user = newState.member?.user;
  if (!user || user.bot) return;

  let type, title;

  if (!oldState.channel && newState.channel) {
    type = 'voiceJoin';
    title = '🔊 Joined Voice';
  } else if (oldState.channel && !newState.channel) {
    type = 'voiceLeave';
    title = '🔇 Left Voice';
  } else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
    type = 'voiceMove';
    title = '🔀 Moved Voice Channel';
  } else {
    return;
  }

  const event = {
    type,
    userId: user.id,
    username: user.tag,
    detail: `${oldState.channel?.name || '—'} → ${newState.channel?.name || '—'}`
  };
  await pushLogEvent(newState.guild.id, event);

  const embed = new EmbedBuilder()
    .setColor(LOG_COLORS[type])
    .setTitle(title)
    .addFields(
      { name: 'User', value: `<@${user.id}> (${user.tag})`, inline: true },
      ...(type === 'voiceMove'
        ? [{ name: 'From', value: oldState.channel.name, inline: true }, { name: 'To', value: newState.channel.name, inline: true }]
        : [{ name: 'Channel', value: (newState.channel || oldState.channel)?.name || '?', inline: true }]
      )
    )
    .setFooter({ text: `JARVIS Logs • ${newState.guild.name}` })
    .setTimestamp();

  await sendLog(newState.guild.id, embed);
});

// =========================
// AUTO MODERATION SYSTEM
// =========================

/**
 * Config stored in memory.automod[guildId]:
 * {
 *   enabled: { invites, spam, mentions, caps, links, slurs },
 *   action: 'delete' | 'warn' | 'timeout' | 'kick',
 *   ignoreRoles: ['roleId1', ...]
 * }
 */

const SLUR_LIST = [
  'nigger','nigga','faggot','fag','retard','chink','spic','kike','wetback','gook','tranny','dyke', 'fuck', 'bitch'
];

// Spam tracker: userId -> array of timestamps
const spamTracker = new Map();

function checkSpam(userId) {
  const now = Date.now();
  const times = (spamTracker.get(userId) || []).filter(t => now - t < 5000);
  times.push(now);
  spamTracker.set(userId, times);
  return times.length >= 5; // 5+ messages in 5s = spam
}

function getAutomodConfig(guildId) {
  return memory.automod?.[guildId] || { enabled: {}, action: 'delete', ignoreRoles: [] };
}

async function handleAutomod(message) {
  if (!message.guild || message.author.bot) return;

  const config = getAutomodConfig(message.guild.id);
  const enabled = config.enabled || {};

  // Skip if no filters are on
  if (!Object.values(enabled).some(Boolean)) return;

  // Fetch member for role/permission checks
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);

  // Skip admins and Manage Guild permission holders
  if (member?.permissions.has('ManageGuild')) return;

  // Skip users with ignored roles
  if (config.ignoreRoles?.length > 0) {
    const hasIgnoredRole = config.ignoreRoles.some(roleId => member?.roles.cache.has(roleId));
    if (hasIgnoredRole) return;
  }

  const content = message.content;
  let triggered = false;
  let filterName = '';

  // ── Filter 1: Discord invite links ──────────────────────────
  if (enabled.invites && /discord\.(gg|com\/invite)\//i.test(content)) {
    triggered = true;
    filterName = 'Discord invite links';
  }

  // ── Filter 2: Spam / repeated text ──────────────────────────
  if (!triggered && enabled.spam) {
    if (checkSpam(message.author.id)) {
      triggered = true;
      filterName = 'Spam / flooding';
    } else if (/(.{3,})\1{3,}/.test(content)) {
      triggered = true;
      filterName = 'Repeated text';
    }
  }

  // ── Filter 3: Mass mentions (5+ users) ──────────────────────
  if (!triggered && enabled.mentions) {
    const mentionCount = (content.match(/<@!?\d+>/g) || []).length;
    if (mentionCount >= 5) {
      triggered = true;
      filterName = `Mass mentions (${mentionCount} users)`;
    }
  }

  // ── Filter 4: Excessive caps (>70%, min 8 chars) ────────────
  if (!triggered && enabled.caps && content.length >= 8) {
    const letters = content.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= 4) {
      const upperRatio = letters.replace(/[^A-Z]/g, '').length / letters.length;
      if (upperRatio > 0.7) {
        triggered = true;
        filterName = 'Excessive caps';
      }
    }
  }

  // ── Filter 5: All external links ────────────────────────────
  if (!triggered && enabled.links && /https?:\/\//i.test(content)) {
    if (!/discord\.(com|gg)/i.test(content)) {
      triggered = true;
      filterName = 'External links';
    }
  }

  // ── Filter 6: Slurs & hate speech ───────────────────────────
  if (!triggered && enabled.slurs) {
    const found = SLUR_LIST.find(slur => new RegExp(`\\b${slur}\\b`, 'i').test(content));
    if (found) {
      triggered = true;
      filterName = 'Hate speech / slurs';
    }
  }

  if (!triggered) return;

  const action = config.action || 'delete';

  // Delete the message first
  try { await message.delete(); } catch {}

  // Log to server log channel
  const logEmbed = new EmbedBuilder()
    .setColor(LOG_COLORS.automod)
    .setTitle('🛡️ AutoMod Triggered')
    .addFields(
      { name: 'User',    value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
      { name: 'Channel', value: `<#${message.channel.id}>`,                         inline: true },
      { name: 'Filter',  value: filterName,                                          inline: true },
      { name: 'Action',  value: action,                                              inline: true },
      { name: 'Message', value: content.slice(0, 512) || '*[empty]*' }
    )
    .setFooter({ text: `JARVIS AutoMod • ${message.guild.name}` })
    .setTimestamp();

  await pushLogEvent(message.guild.id, {
    type: 'automod',
    userId: message.author.id,
    username: message.author.tag,
    detail: `[AutoMod] ${filterName} — action: ${action}`
  });
  await sendLog(message.guild.id, logEmbed);

  // ── Execute punishment ───────────────────────────────────────
  if (action === 'delete') {
    try { await message.author.send(`⚠️ Your message in **${message.guild.name}** was removed.\nReason: ${filterName}`); } catch {}
    return;
  }

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
    } catch (err) {
      console.error('[AutoMod] timeout failed:', err.message);
    }
    return;
  }

  if (action === 'kick') {
    try {
      await message.guild.members.kick(message.author.id, `[AutoMod] ${filterName}`);
      try { await message.author.send(`👢 You were kicked from **${message.guild.name}**.\nReason: ${filterName}`); } catch {}
    } catch (err) {
      console.error('[AutoMod] kick failed:', err.message);
    }
    return;
  }
}

// =========================
// PROMPT ENGINE
// =========================
function splitMessage(text, maxLength = 1900) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}



// =========================
// VOICE AI SYSTEM
// =========================
const activeListeners = new Map();

async function generateSpeech(text) {
  try {
    const encoded = encodeURIComponent(text.slice(0, 200));
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encoded}`;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const filePath = path.join(__dirname, `tts-${Date.now()}.mp3`);
    fs.writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  } catch (err) {
    console.error('[Voice] TTS failed:', err.message);
    return null;
  }
}

async function playAudioFile(connection, filePath) {
  return new Promise((resolve) => {
    const player = createAudioPlayer();
    const resource = createAudioResource(filePath);
    connection.subscribe(player);
    player.play(resource);
    player.on(AudioPlayerStatus.Idle, () => {
      try { fs.unlinkSync(filePath); } catch {}
      resolve();
    });
    player.on('error', (err) => {
      console.error('[Voice] Player error:', err.message);
      try { fs.unlinkSync(filePath); } catch {}
      resolve();
    });
  });
}

function listenToUser(connection, userId, guildId, member) {
  if (activeListeners.get(guildId)?.has(userId)) return;
  if (!activeListeners.has(guildId)) activeListeners.set(guildId, new Set());
  activeListeners.get(guildId).add(userId);

  const receiver = connection.receiver;

  receiver.speaking.on('start', (speakingUserId) => {
    if (speakingUserId !== userId) return;

    const audioStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });

    const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
    const filePath = path.join(__dirname, `voice-${userId}-${Date.now()}.pcm`);
    const fileStream = fs.createWriteStream(filePath);

    audioStream.pipe(decoder).pipe(fileStream);

    audioStream.once('close', async () => {
      fileStream.end();
      await new Promise(r => setTimeout(r, 200));

      try {
        const stats = fs.statSync(filePath);
        if (stats.size < 4000) { fs.unlinkSync(filePath); return; }
      } catch { return; }

      const wavPath = filePath.replace('.pcm', '.wav');
      try {
        execSync(`"${ffmpegPath}" -f s16le -ar 16000 -ac 1 -i "${filePath}" "${wavPath}"`);
        fs.unlinkSync(filePath); // clean up the .pcm
      } catch (err) {
        console.error('[Voice] FFmpeg conversion failed:', err.message);
        try { fs.unlinkSync(filePath); } catch {}
        return;
      }

      // Transcribe with Groq Whisper (free)
      let transcript;
      try {
        const form = new FormData();
        form.append('file', fs.createReadStream(wavPath), { filename: 'audio.wav' });
        form.append('model', 'whisper-large-v3');
        const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`
          }
        });
        transcript = res.data.text?.trim();
        try { fs.unlinkSync(wavPath); } catch {}
      } catch (err) {
        console.error('[Voice] Transcription failed:', err.message);
        try { fs.unlinkSync(wavPath); } catch {}
        return;
      }

      if (!transcript || transcript.length < 2) return;
      console.log(`[Voice] ${member.user.username}: ${transcript}`);

      // AI response
      const activeMode = getActiveMode(guildId);
      const modeData = MODES[activeMode];

      let aiResponse;
      try {
        const res = await groq.chat.completions.create({
          model: 'meta-llama/llama-3.1-8b-instruct',
          messages: [
            {
              role: 'system',
              content: `${modeData.prompt}
You are JARVIS in a Discord voice channel. Keep replies SHORT — 1-3 sentences max.
No markdown, no bullet points, no emojis. Speak naturally out loud.`
            },
            { role: 'user', content: `${member.user.username} said: ${transcript}` }
          ],
          temperature: 0.85,
          max_tokens: 150,
        });
        aiResponse = res.choices[0].message.content.replace(/[*_`#@]/g, '');
      } catch (err) {
        console.error('[Voice] AI failed:', err.message);
        return;
      }

      if (!aiResponse) return;
      console.log(`[Voice] JARVIS: ${aiResponse}`);

      const ttsFile = await generateSpeech(aiResponse);
      if (ttsFile) await playAudioFile(connection, ttsFile);
    });
  });
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
  new SlashCommandBuilder().setName('dashboard').setDescription('Edit my settings').setDMPermission(true),

  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask JARVIS anything')
    .addStringOption(o =>
      o.setName('question').setDescription('Your question').setRequired(true)
    ).setDMPermission(true),

    new SlashCommandBuilder()
  .setName('imagine')
  .setDescription('Generate an image from a prompt 🎨')
  .addStringOption(o =>
    o.setName('prompt').setDescription('What to generate').setRequired(true)
  )
  .setDMPermission(true),

  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Switch JARVIS personality mode')
    .addStringOption(o =>
      o.setName('mode')
        .setDescription('Pick a mode')
        .setRequired(true)
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

  // ─── LOGGING COMMANDS ────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('setlogchannel')
    .setDescription('Set the channel where JARVIS sends server logs')
    .addChannelOption(o =>
      o.setName('channel').setDescription('Log channel').setRequired(true)
    )
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('disablelogs')
    .setDescription('Disable server logging for this server')
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('View recent server log events (last 10)')
    .setDMPermission(false),

  // ─── AUTO MODERATION COMMANDS ────────────────────────────────
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure auto moderation for this server')
    .addSubcommand(sub =>
      sub.setName('enable')
        .setDescription('Enable an automod filter')
        .addStringOption(o =>
          o.setName('filter')
            .setDescription('Which filter to enable')
            .setRequired(true)
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
      sub.setName('disable')
        .setDescription('Disable an automod filter')
        .addStringOption(o =>
          o.setName('filter')
            .setDescription('Which filter to disable')
            .setRequired(true)
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
      sub.setName('action')
        .setDescription('Set the punishment when a filter triggers')
        .addStringOption(o =>
          o.setName('type')
            .setDescription('Punishment type')
            .setRequired(true)
            .addChoices(
              { name: 'delete — Delete message only',          value: 'delete'  },
              { name: 'warn — Delete + warn user',             value: 'warn'    },
              { name: 'timeout — Delete + timeout (10 min)',   value: 'timeout' },
              { name: 'kick — Delete + kick user',             value: 'kick'    }
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('ignorerole')
        .setDescription('Add or remove a role that bypasses automod')
        .addRoleOption(o =>
          o.setName('role').setDescription('Role to toggle').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show current automod config for this server')
    )
    .setDMPermission(false),

    new SlashCommandBuilder()
  .setName('join')
  .setDescription('Join your voice channel and start listening')
  .setDMPermission(false),

new SlashCommandBuilder()
  .setName('leave')
  .setDescription('Leave the voice channel')
  .setDMPermission(false),

].map(c => c.toJSON());
// =========================
// DEPLOY COMMANDS
// =========================
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  const dmCommands = commands.map(cmd => ({
    ...cmd,
    integration_types: [0, 1],
    contexts: [0, 1, 2]
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

  // Pick up dashboard config changes every 15s without a restart
  setInterval(refreshDashboardConfig, 15_000);
});

// =========================
// INTERACTIONS
// =========================
client.on('interactionCreate', async (interaction) => {
  // ── Trivia answer buttons ─────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('trivia_')) {
    const triviaKey = `trivia-${interaction.channelId}`;
    const correct = memory[triviaKey];

    if (!correct) {
      return interaction.reply({ content: '❌ This trivia question has expired or was already answered.', flags: 64 });
    }

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
      const keep = {
        ownerConfirmed: memory.ownerConfirmed,
        modes: memory.modes,
        ratings: memory.ratings,
        feedback: memory.feedback,
        logChannels: memory.logChannels,
        automod: memory.automod,
      };
      memory = keep;
      await saveMemory(memory);
      return interaction.reply({ content: "💀 all conversation memory cleared" });
    } else {
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

  if (interaction.commandName === 'dashboard') {
    return interaction.reply({
      content: `🚀 See my Dashboard here:\n👉 https://jarvisbot-rust.vercel.app/dashboard.html`
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
/dashboard - edit settings
/roast - roast a user
/browse - fetch and summarize a website
/trivia - answer an AI trivia question
/wouldyourather - get a would you rather question
/warn - warn a user (mod only)
/warnings - check user warnings
/news - get latest news on a topic
/define - get definition of a word
/clearwarnings - clear all warnings for a user (mod only)
/kick - kick a user from the server (mod only)
/timeout - timeout a user for X minutes (mod only)
/leaderboard - show trivia score leaderboard
/8ball - ask the magic 8ball
/setlogchannel - set the log channel (admin only)
/disablelogs - disable server logging (admin only)
/logs - view recent log events
/automod enable - enable a filter (admin only)
/automod disable - disable a filter (admin only)
/automod action - set punishment type (admin only)
/automod ignorerole - toggle a bypass role (admin only)
/automod status - view current automod config
/imagine - generate an image from a prompt
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
    if (isOnCooldown(interaction.user.id)) {
      const remaining = ((COOLDOWN_MS - (Date.now() - cooldowns.get(interaction.user.id))) / 1000).toFixed(1);
      return interaction.reply({ content: `⏳ slow down! wait **${remaining}s** before using another AI command.`, flags: 64 });
    }
    setCooldown(interaction.user.id);
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
      const event = {
        type: 'kick',
        userId: target.id,
        username: target.tag,
        detail: `Kicked by ${interaction.user.tag} — ${reason}`
      };
      await pushLogEvent(interaction.guild.id, event);
      const logEmbed = new EmbedBuilder()
        .setColor(LOG_COLORS.kick)
        .setTitle('👢 Member Kicked')
        .addFields(
          { name: 'User',      value: `${target.tag}`,          inline: true },
          { name: 'Moderator', value: interaction.user.tag,     inline: true },
          { name: 'Reason',    value: reason }
        )
        .setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` })
        .setTimestamp();
      await sendLog(interaction.guild.id, logEmbed);
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
      const event = {
        type: 'timeout',
        userId: target.id,
        username: target.tag,
        detail: `Timed out ${minutes}m by ${interaction.user.tag} — ${reason}`
      };
      await pushLogEvent(interaction.guild.id, event);
      const logEmbed = new EmbedBuilder()
        .setColor(LOG_COLORS.timeout)
        .setTitle('🔇 Member Timed Out')
        .addFields(
          { name: 'User',      value: `${target.tag}`,          inline: true },
          { name: 'Duration',  value: `${minutes} minute(s)`,   inline: true },
          { name: 'Moderator', value: interaction.user.tag,     inline: true },
          { name: 'Reason',    value: reason }
        )
        .setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` })
        .setTimestamp();
      await sendLog(interaction.guild.id, logEmbed);
      return interaction.reply(`🔇 **${target.username}** timed out for **${minutes} minute(s)**. Reason: ${reason}`);
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '❌ Could not timeout that user.', flags: 64 });
    }
  }

  if (interaction.commandName === 'leaderboard') {
    try {
      const playerIds = await redis.smembers('trivia-players');
      if (!playerIds || playerIds.length === 0) return interaction.reply('📊 No trivia scores yet. Use `/trivia` to start!');
      const scores = await Promise.all(
        playerIds.map(async (userId) => {
          const val = await redis.get(`trivia-score-${userId}`);
          return { userId, score: parseInt(val) || 0 };
        })
      );
      scores.sort((a, b) => b.score - a.score);
      const lines = await Promise.all(
        scores.slice(0, 10).map(async (entry, i) => {
          try {
            const user = await client.users.fetch(entry.userId);
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            return `${medal} **${user.username}** — ${entry.score} point(s)`;
          } catch {
            return `${i + 1}. Unknown — ${entry.score} point(s)`;
          }
        })
      );
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xffd700)
            .setTitle('🏆 Trivia Leaderboard')
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Answer trivia questions to earn points!' })
        ]
      });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '❌ Could not load leaderboard.', flags: 64 });
    }
  }

  if (interaction.commandName === '8ball') {
    const question = interaction.options.getString('question');
    const responses = [
      '✅ It is certain.', '✅ Without a doubt.', '✅ You may rely on it.',
      '✅ Yes, definitely.', '✅ It is decidedly so.',
      '🤔 Reply hazy, try again.', '🤔 Ask again later.',
      '🤔 Better not tell you now.', '🤔 Cannot predict now.',
      "❌ Don't count on it.", '❌ My reply is no.',
      '❌ My sources say no.', '❌ Very doubtful.', '❌ Outlook not so good.',
    ];
    return interaction.reply(`🎱 **Q: ${question}**\n${responses[Math.floor(Math.random() * responses.length)]}`);
  }

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
    const event = {
      type: 'warn',
      userId: target.id,
      username: target.tag,
      detail: `Warned by ${interaction.user.tag} — ${reason}`
    };
    await pushLogEvent(interaction.guild.id, event);
    const logEmbed = new EmbedBuilder()
      .setColor(LOG_COLORS.warn)
      .setTitle('⚠️ Member Warned')
      .addFields(
        { name: 'User',             value: `${target.tag}`,          inline: true },
        { name: 'Moderator',        value: interaction.user.tag,     inline: true },
        { name: 'Total Warnings',   value: `${memory[key].length}`,  inline: true },
        { name: 'Reason',           value: reason }
      )
      .setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` })
      .setTimestamp();
    await sendLog(interaction.guild.id, logEmbed);
    try { await target.send(`⚠️ You were warned in **${interaction.guild.name}**\nReason: ${reason}`); } catch {}
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

  if (interaction.commandName === 'trivia') {
    await interaction.deferReply();
    try {
      const res = await groq.chat.completions.create({
        model: 'meta-llama/llama-3.1-8b-instruct',
        messages: [
          {
            role: 'system',
            content: `Generate a multiple choice trivia question with 4 options (A, B, C, D). Format exactly like:
QUESTION: <question text>
A) <option>
B) <option>
C) <option>
D) <option>
ANSWER: <letter>`
          },
          { role: 'user', content: 'Give me a trivia question.' }
        ],
        temperature: 1.0,
        max_tokens: 200
      });

      const text = res.choices[0].message.content;
      const answerMatch = text.match(/ANSWER:\s*([A-D])/i);
      const answer = answerMatch ? answerMatch[1].toUpperCase() : 'A';

      const qMatch = text.match(/QUESTION:\s*([\s\S]*?)\n[A-D]\)/i);
      const question = qMatch ? qMatch[1].trim() : text.split('\n')[0];

      const options = {};
      ['A', 'B', 'C', 'D'].forEach(letter => {
        const m = text.match(new RegExp(`${letter}\\)\\s*(.+)`));
        options[letter] = m ? m[1].trim() : letter;
      });

      const triviaKey = `trivia-${interaction.channelId}`;
      memory[triviaKey] = answer;
      await saveMemory(memory);

      const row = new ActionRowBuilder().addComponents(
        ['A', 'B', 'C', 'D'].map(letter =>
          new ButtonBuilder()
            .setCustomId(`trivia_${letter}`)
            .setLabel(`${letter}) ${options[letter]}`.slice(0, 80))
            .setStyle(ButtonStyle.Primary)
        )
      );

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🧠 Trivia Time!')
        .setDescription(question)
        .setFooter({ text: 'Click a button below to answer!' });

      return interaction.editReply({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error(err);
      return interaction.editReply('❌ Failed to generate trivia question.');
    }
  }

  // =========================
  // LOGGING SLASH COMMANDS
  // =========================

  if (interaction.commandName === 'setlogchannel') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) {
      return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
    }
    const channel = interaction.options.getChannel('channel');
    memory.logChannels = memory.logChannels || {};
    memory.logChannels[interaction.guild.id] = channel.id;
    await saveMemory(memory);

    const confirmEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Log Channel Set')
      .setDescription(`JARVIS will now send server logs to <#${channel.id}>.`)
      .addFields({
        name: 'Events logged',
        value: 'Member join/leave • Message delete/edit • Bans/unbans • Kicks • Timeouts • Channel create/delete • Role create/delete • Nickname changes • Voice activity • Warnings • AutoMod actions'
      })
      .setFooter({ text: `JARVIS Logs • ${interaction.guild.name}` })
      .setTimestamp();

    return interaction.reply({ embeds: [confirmEmbed] });
  }

  if (interaction.commandName === 'disablelogs') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) {
      return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
    }
    if (memory.logChannels?.[interaction.guild.id]) {
      delete memory.logChannels[interaction.guild.id];
      await saveMemory(memory);
      return interaction.reply('🔕 Logging disabled for this server.');
    } else {
      return interaction.reply({ content: '❌ Logging is not currently enabled.', flags: 64 });
    }
  }

  if (interaction.commandName === 'logs') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    try {
      const key = `logs-${interaction.guild.id}`;
      const existing = await redis.get(key);
      const logs = Array.isArray(existing) ? existing : (existing ? JSON.parse(existing) : []);
      if (logs.length === 0) return interaction.reply({ content: '📭 No log events recorded yet.', flags: 64 });

      const typeEmoji = {
        join: '📥', leave: '📤', ban: '🔨', unban: '✅', kick: '👢',
        timeout: '🔇', messageDelete: '🗑️', messageEdit: '✏️',
        channelCreate: '📢', channelDelete: '🗑️', roleCreate: '🎭',
        roleDelete: '🗑️', voiceJoin: '🔊', voiceLeave: '🔇', voiceMove: '🔀',
        warn: '⚠️', nickChange: '📝', automod: '🛡️'
      };

      const recent = logs.slice(-10).reverse();
      const lines = recent.map(e => {
        const emoji = typeEmoji[e.type] || '📋';
        const time = `<t:${Math.floor(e.timestamp / 1000)}:R>`;
        const user = e.username ? `**${e.username}**` : '';
        return `${emoji} ${time} ${user} — ${e.detail || e.type}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('📋 Recent Server Events')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Last ${recent.length} events • JARVIS Logs` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    } catch (err) {
      console.error(err);
      return interaction.reply({ content: '❌ Could not load logs.', flags: 64 });
    }
  }

  // =========================
  // AUTOMOD SLASH COMMANDS
  // =========================

  if (interaction.commandName === 'automod') {
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
    if (!interaction.member.permissions.has('ManageGuild')) {
      return interaction.reply({ content: '❌ You need **Manage Server** permission.', flags: 64 });
    }

    const sub = interaction.options.getSubcommand();
    memory.automod = memory.automod || {};
    if (!memory.automod[interaction.guild.id]) {
      memory.automod[interaction.guild.id] = { enabled: {}, action: 'delete', ignoreRoles: [] };
    }
    const cfg = memory.automod[interaction.guild.id];

    const ALL_FILTERS = ['invites', 'spam', 'mentions', 'caps', 'links', 'slurs'];

    // ── /automod enable ──────────────────────────────────────
    if (sub === 'enable') {
      const filter = interaction.options.getString('filter');
      if (filter === 'all') {
        ALL_FILTERS.forEach(f => { cfg.enabled[f] = true; });
        await saveMemory(memory);
        return interaction.reply('🛡️ All automod filters **enabled**.');
      }
      cfg.enabled[filter] = true;
      await saveMemory(memory);
      return interaction.reply(`🛡️ AutoMod filter **${filter}** is now **enabled**.`);
    }

    // ── /automod disable ─────────────────────────────────────
    if (sub === 'disable') {
      const filter = interaction.options.getString('filter');
      if (filter === 'all') {
        ALL_FILTERS.forEach(f => { cfg.enabled[f] = false; });
        await saveMemory(memory);
        return interaction.reply('🛡️ All automod filters **disabled**.');
      }
      cfg.enabled[filter] = false;
      await saveMemory(memory);
      return interaction.reply(`🛡️ AutoMod filter **${filter}** is now **disabled**.`);
    }

    // ── /automod action ──────────────────────────────────────
    if (sub === 'action') {
      const type = interaction.options.getString('type');
      cfg.action = type;
      await saveMemory(memory);
      const labels = {
        delete: 'Delete message only',
        warn: 'Delete + warn user',
        timeout: 'Delete + timeout (10 min)',
        kick: 'Delete + kick user'
      };
      return interaction.reply(`⚙️ AutoMod punishment set to: **${labels[type]}**`);
    }

    // ── /automod ignorerole ──────────────────────────────────
    if (sub === 'ignorerole') {
      const role = interaction.options.getRole('role');
      cfg.ignoreRoles = cfg.ignoreRoles || [];
      const idx = cfg.ignoreRoles.indexOf(role.id);
      if (idx === -1) {
        cfg.ignoreRoles.push(role.id);
        await saveMemory(memory);
        return interaction.reply(`✅ <@&${role.id}> will now **bypass** automod.`);
      } else {
        cfg.ignoreRoles.splice(idx, 1);
        await saveMemory(memory);
        return interaction.reply(`❌ <@&${role.id}> is no longer bypassing automod.`);
      }
    }

    // ── /automod status ──────────────────────────────────────
    if (sub === 'status') {
      const filterNames = {
        invites:  'Discord invite links',
        spam:     'Spam / repeated text',
        mentions: 'Mass mentions (5+)',
        caps:     'Excessive caps (>70%)',
        links:    'All external links',
        slurs:    'Hate speech / slurs',
      };
      const filterLines = ALL_FILTERS.map(f => {
        const on = cfg.enabled?.[f];
        return `${on ? '🟢' : '🔴'} **${filterNames[f]}**`;
      }).join('\n');

      const ignoreList = (cfg.ignoreRoles || []).map(id => `<@&${id}>`).join(', ') || 'None';
      const actionLabels = {
        delete: '🗑️ Delete message only',
        warn: '⚠️ Delete + warn',
        timeout: '🔇 Delete + timeout (10 min)',
        kick: '👢 Delete + kick'
      };

      const embed = new EmbedBuilder()
        .setColor(0xff4d4d)
        .setTitle('🛡️ AutoMod Status')
        .addFields(
          { name: 'Filters',        value: filterLines },
          { name: 'Punishment',     value: actionLabels[cfg.action] || cfg.action },
          { name: 'Bypass Roles',   value: ignoreList }
        )
        .setFooter({ text: `JARVIS AutoMod • ${interaction.guild.name}` })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  }

  if (interaction.commandName === 'imagine') {
  await interaction.deferReply();
  const prompt = interaction.options.getString('prompt');

  // Safety check
  if (prompt.toLowerCase().includes('@everyone') || prompt.toLowerCase().includes('@here')) {
    return interaction.editReply("nah not doing that 💀");
  }

  try {
    const encoded = encodeURIComponent(prompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 99999)}`;

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('🎨 Image Generated')
      .setDescription(`**Prompt:** ${prompt}`)
      .setImage(imageUrl)
      .setFooter({ text: 'JARVIS AI • Powered by Pollinations.ai' });

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ Failed to generate image rq, try again');
  }
}

if (interaction.commandName === 'join') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) return interaction.reply({ content: '❌ Join a voice channel first.', flags: 64 });
  const existing = getVoiceConnection(interaction.guild.id);
  if (existing) return interaction.reply({ content: '⚠️ Already in a voice channel. Use `/leave` first.', flags: 64 });

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

  for (const [, vcMember] of voiceChannel.members) {
    if (vcMember.user.bot) continue;
    listenToUser(connection, vcMember.id, interaction.guild.id, vcMember);
  }

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      activeListeners.delete(interaction.guild.id);
    }
  });

  return interaction.reply(`🎙️ Joined **${voiceChannel.name}**! Talk to me.`);
}

if (interaction.commandName === 'leave') {
  if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
  const connection = getVoiceConnection(interaction.guild.id);
  if (!connection) return interaction.reply({ content: "❌ I'm not in a voice channel.", flags: 64 });
  connection.destroy();
  activeListeners.delete(interaction.guild.id);
  return interaction.reply('👋 Left the voice channel.');
}

});

// =========================
// MESSAGE HANDLER
// =========================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── Run automod on every message first ──────────────────────
  await handleAutomod(message);

  const content = message.content;
  const lower = content.toLowerCase();

  const ownerConfirmed = memory.ownerConfirmed === OWNER_ID;
  const isDM = message.guild === null;
  const isMention = message.mentions.has(client.user);

  if (!isDM && !isMention) return;

  if (message.author.id === OWNER_ID && !memory.ownerConfirmed) {
    memory.ownerConfirmed = OWNER_ID;
    saveMemory(memory);
  }

  if (lower.includes("@everyone") || lower.includes("@here")) {
    return message.reply("nah I'm not doing that 💀 I don't mass ping people");
  }

  if (message.attachments.size > 0) {
    const imageAttachment = message.attachments.find(a =>
      a.contentType && ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'].includes(a.contentType)
    );
    if (imageAttachment) {
      const cleanMsg = content.replace(/<@!?\d+>/g, '').trim();
      const question = cleanMsg.length > 0 ? cleanMsg : "What's in this image? Describe it.";
      try {
        message.channel.sendTyping();
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

  const userTag = message.author.username;
  const userId = message.author.id;
  const userIsOwner = isOwner(userId);

  const cleanContent = content.replace(/<@!?\d+>/g, '').trim();

  convo.messages.push({
    role: "user",
    content: `${userTag}: ${cleanContent}`
  });

  if (convo.messages.length > 20) convo.messages.shift();

  const guildId = message.guild?.id || 'dm';
  const activeMode = getActiveMode(guildId);
  const modeData = MODES[activeMode];

  const system = `
${modeData.prompt}

You are JARVIS From Iron man made by ${OWNER_NAME}, a Discord bot.

PERSONALITY:
- Talk naturally, not like a robot. Match the vibe of the server.
- Keep replies SHORT unless someone asks something complex.
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
- TALK LIKE A PROFESSIONAL AI ASSISTANT, DON'T USE SLANG THAT'S AN ORDER

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
      temperature: 0.85,
      max_tokens: 300
    });

    const reply = res.choices[0].message.content
      .replace(/@everyone/gi, '`@everyone`')
      .replace(/@here/gi, '`@here`');

    convo.messages.push({ role: "assistant", content: reply });
    saveMemory(memory);

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