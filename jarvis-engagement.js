// jarvis-engagement.js
//
// Engagement pack: Leveling/XP, Economy, Birthdays, Rep, Starboard.
// Wired to work with your existing index.js out of the box:
//   - commands            -> already consumed via jarvisEngagement.commands
//   - handleLevelingMessage -> already called in your messageCreate handler
//   - handleStarboardReaction -> already called in messageReactionAdd
//   - startBirthdayScheduler -> already called once in clientReady
//
// Dashboard integration (leveling on/off + level roles) is exposed via
// isLevelingEnabled / setLevelingEnabled / getLevelRoles / setLevelRole /
// removeLevelRole — your dashboard's config API route can `require` this
// file directly and call those functions. See the patch notes provided
// alongside this file for the exact config.js + dashboard.html changes.

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const { randomUUID } = require('crypto');
const { Redis } = require('@upstash/redis');

// Same credentials your bot already uses in index.js.
const REDIS = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================================================================
// STORAGE HELPERS
// (@upstash/redis auto-serializes/deserializes JSON on get/set)
// ============================================================================

async function getJSON(key, fallback = null) {
  try {
    const val = await REDIS.get(key);
    return val ?? fallback;
  } catch {
    return fallback;
  }
}

async function setJSON(key, value) {
  return REDIS.set(key, value);
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
const xpUsersKey = (g) => `xpusers:${g}`;
const levelRolesKey = (g) => `levelroles:${g}`;
const levelingEnabledKey = (g) => `levelingEnabled:${g}`;

function xpForLevel(level) {
  return 5 * level ** 2 + 50 * level + 100;
}

function levelFromXp(totalXp) {
  let level = 0;
  while (totalXp >= xpForLevel(level + 1)) level++;
  return level;
}

async function isLevelingEnabled(guildId) {
  const val = await getJSON(levelingEnabledKey(guildId), true);
  return val !== false;
}

async function setLevelingEnabled(guildId, enabled) {
  await setJSON(levelingEnabledKey(guildId), !!enabled);
  return !!enabled;
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
  await REDIS.sadd(xpUsersKey(guildId), userId).catch(() => {});
  return { ...data, leveledUp: data.level > prevLevel, prevLevel };
}

async function getLeaderboard(guildId, limit = 10) {
  const userIds = await REDIS.smembers(xpUsersKey(guildId)).catch(() => []);
  const entries = await Promise.all(
    (userIds || []).map(async (userId) => {
      const data = await getUserXp(guildId, userId);
      return { userId, ...data };
    })
  );
  return entries.sort((a, b) => b.xp - a.xp).slice(0, limit);
}

async function getLevelRoles(guildId) {
  return getJSON(levelRolesKey(guildId), {});
}

async function setLevelRole(guildId, level, roleId) {
  const roles = await getLevelRoles(guildId);
  roles[String(level)] = roleId;
  await setJSON(levelRolesKey(guildId), roles);
  return roles;
}

async function removeLevelRole(guildId, level) {
  const roles = await getLevelRoles(guildId);
  delete roles[String(level)];
  await setJSON(levelRolesKey(guildId), roles);
  return roles;
}

const xpCooldowns = new Map();

async function handleLevelingMessage(message) {
  if (message.author.bot || !message.guild) return;
  if (!(await isLevelingEnabled(message.guild.id))) return;

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
// SLASH COMMANDS
// ============================================================================

function formatMs(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

const commands = [
  // --- /rank ---
  {
    data: new SlashCommandBuilder()
      .setName('rank')
      .setDescription("Check your (or someone else's) level and XP")
      .addUserOption((opt) => opt.setName('user').setDescription('User to check').setRequired(false)),
    async execute(interaction) {
      const target = interaction.options.getUser('user') || interaction.user;
      const data = await getUserXp(interaction.guild.id, target.id);
      const nextLevelXp = xpForLevel(data.level + 1);
      const currentLevelXp = xpForLevel(data.level);
      const progress = data.xp - currentLevelXp;
      const needed = nextLevelXp - currentLevelXp;
      const barLength = 20;
      const filled = Math.round((progress / needed) * barLength);
      const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
        .setTitle(`Level ${data.level}`)
        .setDescription(`${bar}\n${progress} / ${needed} XP to next level`)
        .setFooter({ text: `Total XP: ${data.xp}` });

      await interaction.reply({ embeds: [embed] });
    },
  },

  // --- /levelboard ---
  {
    data: new SlashCommandBuilder().setName('levelboard').setDescription('Show the server XP leaderboard'),
    async execute(interaction) {
      await interaction.deferReply();
      const top = await getLeaderboard(interaction.guild.id, 10);
      if (!top.length) return interaction.editReply('No one has earned XP yet.');

      const lines = await Promise.all(
        top.map(async (entry, i) => {
          const member = await interaction.guild.members.fetch(entry.userId).catch(() => null);
          const name = member ? member.user.username : `Unknown (${entry.userId})`;
          const medal = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
          return `${medal} **${name}** — Level ${entry.level} (${entry.xp} XP)`;
        })
      );

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🏆 ${interaction.guild.name} Leaderboard`)
        .setDescription(lines.join('\n'));

      await interaction.editReply({ embeds: [embed] });
    },
  },

  // --- /setlevelrole ---
  {
    data: new SlashCommandBuilder()
      .setName('setlevelrole')
      .setDescription('Assign a role reward for reaching a level')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addIntegerOption((opt) => opt.setName('level').setDescription('Level required').setRequired(true).setMinValue(1))
      .addRoleOption((opt) => opt.setName('role').setDescription('Role to grant').setRequired(true)),
    async execute(interaction) {
      const level = interaction.options.getInteger('level');
      const role = interaction.options.getRole('role');

      if (role.managed || role.id === interaction.guild.id) {
        return interaction.reply({ content: "I can't assign that role.", flags: 64 });
      }

      const roles = await setLevelRole(interaction.guild.id, level, role.id);
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('Level role set')
        .setDescription(
          `Members reaching **Level ${level}** will now receive ${role}.\n\nCurrent mappings:\n` +
            Object.entries(roles)
              .sort((a, b) => Number(a[0]) - Number(b[0]))
              .map(([lvl, roleId]) => `• Level ${lvl} → <@&${roleId}>`)
              .join('\n')
        );

      await interaction.reply({ embeds: [embed] });
    },
  },

  // --- /balance ---
  {
    data: new SlashCommandBuilder()
      .setName('balance')
      .setDescription("Check your (or someone else's) balance")
      .addUserOption((opt) => opt.setName('user').setDescription('User to check').setRequired(false)),
    async execute(interaction) {
      const target = interaction.options.getUser('user') || interaction.user;
      const wallet = await getWallet(interaction.guild.id, target.id);
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
        .setDescription(`${CONFIG.currency} **${wallet.balance.toLocaleString()}**`);
      await interaction.reply({ embeds: [embed] });
    },
  },

  // --- /daily ---
  {
    data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily reward'),
    async execute(interaction) {
      const result = await claimDaily(interaction.guild.id, interaction.user.id);
      if (!result.success) {
        return interaction.reply({
          content: `⏳ You already claimed today. Come back in **${formatMs(result.msRemaining)}**.`,
          flags: 64,
        });
      }
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('Daily reward claimed!')
        .setDescription(
          `You received ${CONFIG.currency} **${result.reward}**\n🔥 Streak: **${result.streak}** day(s)\n\nNew balance: ${CONFIG.currency} ${result.wallet.balance.toLocaleString()}`
        );
      await interaction.reply({ embeds: [embed] });
    },
  },

  // --- /work ---
  {
    data: new SlashCommandBuilder().setName('work').setDescription('Work a shift to earn some coins'),
    async execute(interaction) {
      const result = await workShift(interaction.guild.id, interaction.user.id);
      if (!result.success) {
        return interaction.reply({
          content: `⏳ You're tired. Rest for **${formatMs(result.msRemaining)}** before working again.`,
          flags: 64,
        });
      }
      const jobs = [
        'fixed a bug in production',
        'debugged JARVIS at 3am',
        'moderated a heated chat',
        'streamed on Twitch',
        'wrote a Discord bot command',
        'answered support tickets',
      ];
      const job = jobs[Math.floor(Math.random() * jobs.length)];
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setDescription(
          `You ${job} and earned ${CONFIG.currency} **${result.earnings}**\n\nNew balance: ${CONFIG.currency} ${result.wallet.balance.toLocaleString()}`
        );
      await interaction.reply({ embeds: [embed] });
    },
  },

  // --- /pay ---
  {
    data: new SlashCommandBuilder()
      .setName('pay')
      .setDescription('Send coins to another user')
      .addUserOption((opt) => opt.setName('user').setDescription('Who to pay').setRequired(true))
      .addIntegerOption((opt) => opt.setName('amount').setDescription('Amount to send').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      const target = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');

      if (target.id === interaction.user.id) return interaction.reply({ content: "You can't pay yourself.", flags: 64 });
      if (target.bot) return interaction.reply({ content: "You can't pay a bot.", flags: 64 });

      const result = await payUser(interaction.guild.id, interaction.user.id, target.id, amount);
      if (!result.success) {
        return interaction.reply({ content: `❌ You don't have enough ${CONFIG.currency} to send that.`, flags: 64 });
      }

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setDescription(`${interaction.user} paid ${target} ${CONFIG.currency} **${amount.toLocaleString()}**`);
      await interaction.reply({ embeds: [embed] });
    },
  },

  // --- /shop ---
  {
    data: new SlashCommandBuilder()
      .setName('shop')
      .setDescription('Browse and buy items from the server shop')
      .addSubcommand((sub) => sub.setName('view').setDescription('View shop items'))
      .addSubcommand((sub) =>
        sub.setName('buy').setDescription('Buy an item by its ID').addStringOption((opt) => opt.setName('id').setDescription('Item ID').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('additem')
          .setDescription('(Admin) Add an item to the shop')
          .addStringOption((opt) => opt.setName('name').setDescription('Item name').setRequired(true))
          .addIntegerOption((opt) => opt.setName('price').setDescription('Price in coins').setRequired(true).setMinValue(1))
          .addRoleOption((opt) => opt.setName('role').setDescription('Role granted on purchase (optional)').setRequired(false))
      ),
    // NOTE: permission checks for subcommands must be done at runtime below —
    // discord.js does not support setDefaultMemberPermissions() on a
    // subcommand builder, only on the top-level command.
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guild.id;

      if (sub === 'additem' && !interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '❌ You need **Manage Server** permission to add shop items.', flags: 64 });
      }

      if (sub === 'view') {
        const items = await getShop(guildId);
        if (!items.length) return interaction.reply('The shop is empty. Ask an admin to add items with `/shop additem`.');
        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('🛒 Server Shop')
          .setDescription(items.map((i) => `**${i.name}** — ${CONFIG.currency} ${i.price.toLocaleString()}\n\`ID: ${i.id}\``).join('\n\n'));
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'buy') {
        const id = interaction.options.getString('id');
        const result = await buyItem(guildId, interaction.user.id, id);
        if (!result.success) {
          const msg = result.reason === 'not_found' ? 'Item not found.' : `You don't have enough ${CONFIG.currency}.`;
          return interaction.reply({ content: `❌ ${msg}`, flags: 64 });
        }
        if (result.item.roleId) {
          const role = interaction.guild.roles.cache.get(result.item.roleId);
          if (role) await interaction.member.roles.add(role).catch(() => {});
        }
        return interaction.reply(`✅ You bought **${result.item.name}**!`);
      }

      if (sub === 'additem') {
        const name = interaction.options.getString('name');
        const price = interaction.options.getInteger('price');
        const role = interaction.options.getRole('role');
        const item = { id: randomUUID().slice(0, 8), name, price, roleId: role ? role.id : null };
        await addShopItem(guildId, item);
        return interaction.reply(`✅ Added **${name}** (${CONFIG.currency} ${price}) to the shop. ID: \`${item.id}\``);
      }
    },
  },

  // --- /gamble ---
  {
    data: new SlashCommandBuilder()
      .setName('gamble')
      .setDescription('Try your luck')
      .addSubcommand((sub) =>
        sub
          .setName('coinflip')
          .setDescription('Bet on a coin flip')
          .addIntegerOption((opt) => opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1))
          .addStringOption((opt) =>
            opt
              .setName('choice')
              .setDescription('Heads or tails')
              .setRequired(true)
              .addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' })
          )
      )
      .addSubcommand((sub) =>
        sub.setName('slots').setDescription('Spin the slot machine').addIntegerOption((opt) => opt.setName('amount').setDescription('Amount to bet').setRequired(true).setMinValue(1))
      ),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const amount = interaction.options.getInteger('amount');
      const guildId = interaction.guild.id;
      const userId = interaction.user.id;

      if (sub === 'coinflip') {
        const choice = interaction.options.getString('choice');
        const result = await coinflip(guildId, userId, amount, choice);
        if (!result.success) return interaction.reply({ content: `❌ You don't have enough ${CONFIG.currency}.`, flags: 64 });

        const embed = new EmbedBuilder()
          .setColor(result.won ? 0x57f287 : 0xed4245)
          .setDescription(
            `The coin landed on **${result.result}**.\n` +
              (result.won ? `You won ${CONFIG.currency} **${amount}**!` : `You lost ${CONFIG.currency} **${amount}**.`) +
              `\n\nNew balance: ${CONFIG.currency} ${result.wallet.balance.toLocaleString()}`
          );
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'slots') {
        const result = await slots(guildId, userId, amount);
        if (!result.success) return interaction.reply({ content: `❌ You don't have enough ${CONFIG.currency}.`, flags: 64 });

        const embed = new EmbedBuilder()
          .setColor(result.net > 0 ? 0x57f287 : 0xed4245)
          .setTitle('🎰 Slots')
          .setDescription(
            `[ ${result.reels.join(' | ')} ]\n\n` +
              (result.net > 0
                ? `You won ${CONFIG.currency} **${result.net}**!`
                : result.net === 0
                ? "Break even — you didn't lose anything extra."
                : `You lost ${CONFIG.currency} **${Math.abs(result.net)}**.`) +
              `\n\nNew balance: ${CONFIG.currency} ${result.wallet.balance.toLocaleString()}`
          );
        return interaction.reply({ embeds: [embed] });
      }
    },
  },

  // --- /birthday ---
  {
    data: new SlashCommandBuilder()
      .setName('birthday')
      .setDescription('Manage birthdays')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set your birthday')
          .addIntegerOption((opt) => opt.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12))
          .addIntegerOption((opt) => opt.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31))
      )
      .addSubcommand((sub) => sub.setName('remove').setDescription('Remove your birthday'))
      .addSubcommand((sub) => sub.setName('list').setDescription('List all upcoming birthdays'))
      .addSubcommand((sub) =>
        sub
          .setName('channel')
          .setDescription('(Admin) Set the channel for birthday announcements')
          .addChannelOption((opt) => opt.setName('channel').setDescription('Announcement channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
      ),
    // Same note as /shop: permission check for the admin subcommand happens
    // at runtime, not on the subcommand builder.
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guild.id;

      if (sub === 'channel' && !interaction.member.permissions.has('ManageGuild')) {
        return interaction.reply({ content: '❌ You need **Manage Server** permission to set the birthday channel.', flags: 64 });
      }

      if (sub === 'set') {
        const month = interaction.options.getInteger('month');
        const day = interaction.options.getInteger('day');
        const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        await setBirthday(guildId, interaction.user.id, mmdd);
        return interaction.reply(`🎂 Birthday set to **${mmdd}**.`);
      }

      if (sub === 'remove') {
        await removeBirthday(guildId, interaction.user.id);
        return interaction.reply('🗑️ Your birthday has been removed.');
      }

      if (sub === 'list') {
        const all = await getAllBirthdays(guildId);
        const entries = Object.entries(all);
        if (!entries.length) return interaction.reply('No birthdays set yet.');
        const sorted = entries.sort((a, b) => a[1].localeCompare(b[1]));
        const embed = new EmbedBuilder()
          .setColor(0xeb459e)
          .setTitle('🎂 Birthdays')
          .setDescription(sorted.map(([userId, mmdd]) => `<@${userId}> — ${mmdd}`).join('\n'));
        return interaction.reply({ embeds: [embed] });
      }

      if (sub === 'channel') {
        const channel = interaction.options.getChannel('channel');
        await setBirthdayChannel(guildId, channel.id);
        return interaction.reply(`✅ Birthday announcements will be posted in ${channel}.`);
      }
    },
  },

  // --- /rep ---
  {
    data: new SlashCommandBuilder()
      .setName('rep')
      .setDescription('Give reputation to another user, or check reputation')
      .addUserOption((opt) => opt.setName('user').setDescription('User to give rep to or check').setRequired(false)),
    async execute(interaction) {
      const target = interaction.options.getUser('user');
      const guildId = interaction.guild.id;

      if (!target) {
        const rep = await getRep(guildId, interaction.user.id);
        return interaction.reply(`⭐ You have **${rep}** reputation.`);
      }

      if (target.id === interaction.user.id) {
        const rep = await getRep(guildId, target.id);
        return interaction.reply({ content: `You can't give rep to yourself. You have **${rep}** rep.`, flags: 64 });
      }

      if (target.bot) {
        const rep = await getRep(guildId, target.id);
        return interaction.reply(`⭐ ${target.username} has **${rep}** reputation.`);
      }

      const result = await giveRep(guildId, interaction.user.id, target.id);
      if (!result.success) {
        if (result.reason === 'cooldown') {
          return interaction.reply({ content: `⏳ You can give rep again in **${formatMs(result.msRemaining)}**.`, flags: 64 });
        }
        return interaction.reply({ content: '❌ Something went wrong.', flags: 64 });
      }

      const embed = new EmbedBuilder()
        .setColor(0xeb459e)
        .setDescription(`⭐ ${interaction.user} gave a reputation point to ${target}! They now have **${result.newRep}** rep.`);
      await interaction.reply({ embeds: [embed] });
    },
  },

  // --- /starboard ---
  {
    data: new SlashCommandBuilder()
      .setName('starboard')
      .setDescription('Configure the starboard')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('setup')
          .setDescription('Set the starboard channel and reaction threshold')
          .addChannelOption((opt) => opt.setName('channel').setDescription('Channel to post starred messages').addChannelTypes(ChannelType.GuildText).setRequired(true))
          .addIntegerOption((opt) => opt.setName('threshold').setDescription('Reactions needed (default 5)').setMinValue(1).setRequired(false))
          .addStringOption((opt) => opt.setName('emoji').setDescription('Reaction emoji to track (default ⭐)').setRequired(false))
      )
      .addSubcommand((sub) => sub.setName('status').setDescription('Show current starboard config')),
    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guild.id;

      if (sub === 'setup') {
        const channel = interaction.options.getChannel('channel');
        const threshold = interaction.options.getInteger('threshold') ?? undefined;
        const emoji = interaction.options.getString('emoji') ?? undefined;
        const updates = { channelId: channel.id };
        if (threshold !== undefined) updates.threshold = threshold;
        if (emoji !== undefined) updates.emoji = emoji;
        const cfg = await setStarboardConfig(guildId, updates);
        return interaction.reply(`✅ Starboard set to ${channel} — messages need **${cfg.threshold}x ${cfg.emoji}** to be featured.`);
      }

      if (sub === 'status') {
        const cfg = await getStarboardConfig(guildId);
        const embed = new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('⭐ Starboard Config')
          .setDescription(cfg.channelId ? `Channel: <#${cfg.channelId}>\nThreshold: **${cfg.threshold}x ${cfg.emoji}**` : 'Starboard is not set up yet. Use `/starboard setup`.');
        return interaction.reply({ embeds: [embed] });
      }
    },
  },
];

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  commands,
  handleLevelingMessage,
  handleStarboardReaction,
  startBirthdayScheduler,
  CONFIG,

  // Dashboard-callable getters/setters (used by config.js API route)
  isLevelingEnabled,
  setLevelingEnabled,
  getLevelRoles,
  setLevelRole,
  removeLevelRole,
  getStarboardConfig,
  setStarboardConfig,
  getBirthdayConfig,
  setBirthdayChannel,
};