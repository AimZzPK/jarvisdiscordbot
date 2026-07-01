// jarvis-engagement.js
//
// Drop-in engagement pack: Leveling/XP, Economy, Birthdays, Rep, Starboard.
// Everything in one file — commands, Redis helpers, and event hooks.
//
// ============================================================================
// SETUP (read this before wiring it in)
// ============================================================================
// 1. Point REDIS below at your existing Redis client (same one used for
//    your `premium:${guildId}` keys).
// 2. Register all commands: `client.commands.set(cmd.data.name, cmd)` for
//    each entry in `module.exports.commands`, and include them in your
//    slash command deploy script.
// 3. In your existing `messageCreate` handler, call:
//      await require('./jarvis-engagement').handleLevelingMessage(message);
// 4. In your existing `messageReactionAdd` / `messageReactionRemove`
//    handlers, call:
//      await require('./jarvis-engagement').handleStarboardReaction(reaction, user);
// 5. Once at boot, start the birthday scheduler:
//      require('./jarvis-engagement').startBirthdayScheduler(client);
// ============================================================================

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const { randomUUID } = require('crypto');

const REDIS = require('./redis'); // <-- point this at your actual redis client module

// ============================================================================
// STORAGE HELPERS
// ============================================================================

async function getJSON(key, fallback = null) {
  const raw = await REDIS.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function setJSON(key, value) {
  return REDIS.set(key, JSON.stringify(value));
}

// ============================================================================
// LEVELING / XP
// ============================================================================




const CONFIG = {
  currency: '🪙',
  xpCooldownMs: 60 * 1000,
  xpMin: 15,
  xpMax: 25,
  dailyCooldownMs: 24 * 60 * 60 * 1000,
  dailyStreakGraceMs: 48 * 60 * 60 * 1000,
  dailyBase: 100,
  dailyStreakBonus: 10,
  workCooldownMs: 60 * 60 * 1000,
  workMin: 30,
  workMax: 120,
  repCooldownMs: 24 * 60 * 60 * 1000,
};

const xpKey = (g, u) => `xp:${g}:${u}`;

function xpForLevel(level) {
  return 5 * level ** 2 + 50 * level + 100;
}

function levelFromXp(totalXp) {
  let level = 0;
  while (totalXp >= xpForLevel(level + 1)) level++;
  return level;
}

async function getUserXp(guildId, userId) {
  return getJSON(xpKey(guildId, userId), { xp: 0, level: 0, lastMessageTs: 0 });
}

async function addXp(guildId, userId, amount) {
  const data = await getUserXp(guildId, userId);
  const prevLevel = data.level;
  data.xp += amount;
  data.level = levelFromXp(data.xp);
  data.lastMessageTs = Date.now();
  await setJSON(xpKey(guildId, userId), data);
  return { ...data, leveledUp: data.level > prevLevel, prevLevel };
}

async function getLeaderboard(guildId, limit = 10) {
  const keys = await REDIS.keys(`xp:${guildId}:*`);
  const entries = await Promise.all(
    keys.map(async (k) => {
      const userId = k.split(':')[2];
      const data = await getJSON(k, { xp: 0, level: 0 });
      return { userId, ...data };
    })
  );
  return entries.sort((a, b) => b.xp - a.xp).slice(0, limit);
}

// ============================================================================
// LEVEL ROLES (dashboardConfig source of truth)
// ============================================================================

let getDashboardConfig = () => ({});
let saveDashboardConfigFn = async () => {};

function initLevelRoles(getConfigFn, saveConfigFn) {
  getDashboardConfig = getConfigFn;
  saveDashboardConfigFn = saveConfigFn;
}

function getLevelRoles(guildId) {
  const config = getDashboardConfig();
  return config.levelRoles?.[guildId] || {};
}

async function setLevelRole(guildId, level, roleId) {
  const config = {
    ...getDashboardConfig(),
    levelRoles: {
      ...(getDashboardConfig().levelRoles || {})
    }
  };

  config.levelRoles[guildId] = {
    ...(config.levelRoles[guildId] || {})
  };

  const key = String(level);

  if (roleId === null) {
    delete config.levelRoles[guildId][key];
  } else {
    config.levelRoles[guildId][key] = roleId;
  }

  await saveDashboardConfigFn(config);

  return config.levelRoles[guildId];
}

const xpCooldowns = new Map();

async function handleLevelingMessage(message) {
  if (message.author.bot || !message.guild) return;

  const cdKey = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = xpCooldowns.get(cdKey) || 0;
  if (now - last < CONFIG.xpCooldownMs) return;
  xpCooldowns.set(cdKey, now);

  const gain = Math.floor(Math.random() * (CONFIG.xpMax - CONFIG.xpMin + 1)) + CONFIG.xpMin;
  const result = await addXp(message.guild.id, message.author.id, gain);

  if (result.leveledUp) {
    message.channel
      .send(`🎉 ${message.author}, you leveled up to **Level ${result.level}**!`)
      .catch(() => {});

    const roleMap = await getLevelRoles(message.guild.id);
    const roleId = roleMap[String(result.level)];
    if (roleId) {
      const role = message.guild.roles.cache.get(roleId);
      const member = message.member;
      if (role && member && !member.roles.cache.has(roleId)) {
        member.roles.add(role).catch(() => {});
      }
    }
  }
}

// ============================================================================
// ECONOMY
// ============================================================================

const walletKey = (g, u) => `economy:${g}:${u}`;
const shopKey = (g) => `shop:${g}`;
const inventoryKey = (g, u) => `inventory:${g}:${u}`;

async function getWallet(guildId, userId) {
  return getJSON(walletKey(guildId, userId), { balance: 0, lastDaily: 0, dailyStreak: 0, lastWork: 0 });
}

async function setWallet(guildId, userId, wallet) {
  return setJSON(walletKey(guildId, userId), wallet);
}

async function addBalance(guildId, userId, amount) {
  const wallet = await getWallet(guildId, userId);
  wallet.balance = Math.max(0, wallet.balance + amount);
  await setWallet(guildId, userId, wallet);
  return wallet;
}

async function claimDaily(guildId, userId) {
  const wallet = await getWallet(guildId, userId);
  const now = Date.now();
  const sinceLastClaim = now - wallet.lastDaily;

  if (sinceLastClaim < CONFIG.dailyCooldownMs) {
    return { success: false, msRemaining: CONFIG.dailyCooldownMs - sinceLastClaim };
  }

  const streakBroken = sinceLastClaim > CONFIG.dailyStreakGraceMs;
  wallet.dailyStreak = streakBroken ? 1 : wallet.dailyStreak + 1;
  const reward = CONFIG.dailyBase + Math.min(wallet.dailyStreak * CONFIG.dailyStreakBonus, 500);
  wallet.balance += reward;
  wallet.lastDaily = now;
  await setWallet(guildId, userId, wallet);

  return { success: true, reward, streak: wallet.dailyStreak, wallet };
}

async function workShift(guildId, userId) {
  const wallet = await getWallet(guildId, userId);
  const now = Date.now();
  const sinceLastWork = now - wallet.lastWork;

  if (sinceLastWork < CONFIG.workCooldownMs) {
    return { success: false, msRemaining: CONFIG.workCooldownMs - sinceLastWork };
  }

  const earnings = Math.floor(Math.random() * (CONFIG.workMax - CONFIG.workMin + 1)) + CONFIG.workMin;
  wallet.balance += earnings;
  wallet.lastWork = now;
  await setWallet(guildId, userId, wallet);

  return { success: true, earnings, wallet };
}

async function payUser(guildId, fromUserId, toUserId, amount) {
  if (amount <= 0) return { success: false, reason: 'invalid_amount' };
  const sender = await getWallet(guildId, fromUserId);
  if (sender.balance < amount) return { success: false, reason: 'insufficient_funds' };

  sender.balance -= amount;
  await setWallet(guildId, fromUserId, sender);
  await addBalance(guildId, toUserId, amount);
  return { success: true };
}

async function getShop(guildId) {
  return getJSON(shopKey(guildId), []);
}

async function addShopItem(guildId, item) {
  const items = await getShop(guildId);
  items.push(item);
  await setJSON(shopKey(guildId), items);
  return items;
}

async function getInventory(guildId, userId) {
  return getJSON(inventoryKey(guildId, userId), []);
}

async function buyItem(guildId, userId, itemId) {
  const items = await getShop(guildId);
  const item = items.find((i) => i.id === itemId);
  if (!item) return { success: false, reason: 'not_found' };

  const wallet = await getWallet(guildId, userId);
  if (wallet.balance < item.price) return { success: false, reason: 'insufficient_funds', item };

  wallet.balance -= item.price;
  await setWallet(guildId, userId, wallet);

  const inv = await getInventory(guildId, userId);
  inv.push(item.id);
  await setJSON(inventoryKey(guildId, userId), inv);

  return { success: true, item };
}

async function coinflip(guildId, userId, amount, choice) {
  const wallet = await getWallet(guildId, userId);
  if (amount <= 0 || wallet.balance < amount) return { success: false, reason: 'insufficient_funds' };

  const result = Math.random() < 0.5 ? 'heads' : 'tails';
  const won = result === choice;
  wallet.balance += won ? amount : -amount;
  await setWallet(guildId, userId, wallet);

  return { success: true, won, result, wallet };
}

const SLOT_SYMBOLS = ['🍒', '🍋', '🍇', '💎', '⭐', '7️⃣'];
const SLOT_PAYOUTS = { '🍒': 2, '🍋': 3, '🍇': 4, '⭐': 6, '💎': 8, '7️⃣': 15 };

async function slots(guildId, userId, amount) {
  const wallet = await getWallet(guildId, userId);
  if (amount <= 0 || wallet.balance < amount) return { success: false, reason: 'insufficient_funds' };

  const roll = () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const reels = [roll(), roll(), roll()];

  let winnings = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    winnings = amount * SLOT_PAYOUTS[reels[0]];
  } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    winnings = Math.floor(amount * 1.5);
  }

  wallet.balance += winnings - amount;
  await setWallet(guildId, userId, wallet);
  return { success: true, reels, winnings, net: winnings - amount, wallet };
}

// ============================================================================
// SOCIAL: birthdays + rep
// ============================================================================

const birthdaysKey = (g) => `birthdays:${g}`;
const birthdayConfigKey = (g) => `birthdayConfig:${g}`;
const repKey = (g, u) => `rep:${g}:${u}`;
const repCooldownKey = (g, u) => `repcooldown:${g}:${u}`;

async function setBirthday(guildId, userId, mmdd) {
  const all = await getJSON(birthdaysKey(guildId), {});
  all[userId] = mmdd;
  await setJSON(birthdaysKey(guildId), all);
}

async function removeBirthday(guildId, userId) {
  const all = await getJSON(birthdaysKey(guildId), {});
  delete all[userId];
  await setJSON(birthdaysKey(guildId), all);
}

async function getAllBirthdays(guildId) {
  return getJSON(birthdaysKey(guildId), {});
}

async function getBirthdayConfig(guildId) {
  return getJSON(birthdayConfigKey(guildId), { channelId: null, lastAnnouncedDate: null });
}

async function setBirthdayChannel(guildId, channelId) {
  const cfg = await getBirthdayConfig(guildId);
  cfg.channelId = channelId;
  await setJSON(birthdayConfigKey(guildId), cfg);
  return cfg;
}

async function checkAndAnnounceBirthdays(guildId, client) {
  const cfg = await getBirthdayConfig(guildId);
  if (!cfg.channelId) return [];

  const today = new Date();
  const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const dateKey = today.toISOString().slice(0, 10);
  if (cfg.lastAnnouncedDate === dateKey) return [];

  const all = await getAllBirthdays(guildId);
  const celebrants = Object.entries(all)
    .filter(([, mmdd]) => mmdd === todayStr)
    .map(([userId]) => userId);

  if (celebrants.length) {
    const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
    if (channel) {
      const mentions = celebrants.map((id) => `<@${id}>`).join(', ');
      await channel.send(`🎉 Happy Birthday ${mentions}! 🎂`);
    }
  }

  cfg.lastAnnouncedDate = dateKey;
  await setJSON(birthdayConfigKey(guildId), cfg);
  return celebrants;
}

function startBirthdayScheduler(client, intervalMs = 60 * 60 * 1000) {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      await checkAndAnnounceBirthdays(guild.id, client).catch(() => {});
    }
  }, intervalMs);
}

async function getRep(guildId, userId) {
  return getJSON(repKey(guildId, userId), 0);
}

async function giveRep(guildId, fromUserId, toUserId) {
  if (fromUserId === toUserId) return { success: false, reason: 'self' };

  const cooldown = await getJSON(repCooldownKey(guildId, fromUserId), 0);
  const now = Date.now();
  if (now - cooldown < CONFIG.repCooldownMs) {
    return { success: false, reason: 'cooldown', msRemaining: CONFIG.repCooldownMs - (now - cooldown) };
  }

  const current = await getRep(guildId, toUserId);
  await setJSON(repKey(guildId, toUserId), current + 1);
  await setJSON(repCooldownKey(guildId, fromUserId), now);
  return { success: true, newRep: current + 1 };
}

// ============================================================================
// STARBOARD
// ============================================================================

const starboardConfigKey = (g) => `starboardConfig:${g}`;
const starboardPostKey = (g, m) => `starboardpost:${g}:${m}`;

async function getStarboardConfig(guildId) {
  return getJSON(starboardConfigKey(guildId), { channelId: null, threshold: 5, emoji: '⭐' });
}

async function setStarboardConfig(guildId, updates) {
  const cfg = await getStarboardConfig(guildId);
  const merged = { ...cfg, ...updates };
  await setJSON(starboardConfigKey(guildId), merged);
  return merged;
}

function matchesEmoji(reaction, configEmoji) {
  return reaction.emoji.name === configEmoji || reaction.emoji.toString() === configEmoji;
}

async function buildStarboardEmbed(message, starCount, emoji) {
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL() })
    .setDescription(message.content || '*[no text content]*')
    .setFooter({ text: `${emoji} ${starCount} | #${message.channel.name}` })
    .setTimestamp(message.createdAt);

  const image = message.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (image) embed.setImage(image.url);
  return embed;
}

async function handleStarboardReaction(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }

  const message = reaction.message;
  if (!message.guild) return;

  const cfg = await getStarboardConfig(message.guild.id);
  if (!cfg.channelId) return;
  if (!matchesEmoji(reaction, cfg.emoji)) return;
  if (message.channel.id === cfg.channelId) return;

  const starCount = reaction.count || 0;
  if (starCount < cfg.threshold) return;

  const starboardChannel = await message.guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!starboardChannel) return;

  const existingPostId = await getJSON(starboardPostKey(message.guild.id, message.id), null);
  const embed = await buildStarboardEmbed(message, starCount, cfg.emoji);
  const content = `${cfg.emoji} **${starCount}** — <#${message.channel.id}>`;

  if (existingPostId) {
    const existingMsg = await starboardChannel.messages.fetch(existingPostId).catch(() => null);
    if (existingMsg) {
      await existingMsg.edit({ content, embeds: [embed] }).catch(() => {});
      return;
    }
  }

  const posted = await starboardChannel.send({ content, embeds: [embed] }).catch(() => null);
  if (posted) await setJSON(starboardPostKey(message.guild.id, message.id), posted.id);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  commands: [],
  handleLevelingMessage,
  handleStarboardReaction,
  startBirthdayScheduler,
  initLevelRoles,
  CONFIG,
};