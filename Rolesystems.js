// =========================
// ROLE SYSTEMS (autoroles + role panels: button/dropdown/reaction)
// =========================
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');

let _client = null;
let _redis = null;
let _getConfig = null; // () => dashboardConfig

function initRoleSystems(client, redis, getConfig) {
  _client = client;
  _redis = redis;
  _getConfig = getConfig;
}

// ── Config helpers ─────────────────────────────────────────────
function getRoleSystemsConfig(guildId) {
  const cfg = _getConfig();
  return cfg.roleSystems?.[guildId] || { autoroles: { enabled: false, roleIds: [] }, panels: [] };
}

function getRolePanelList(guildId) {
  return getRoleSystemsConfig(guildId).panels || [];
}

function getRolePanel(guildId, panelId) {
  const panels = getRolePanelList(guildId);
  return panels.find(p => p.id === panelId) || null;
}

// ── Autorole on join ───────────────────────────────────────────
async function handleAutorole(member) {
  try {
    const rs = getRoleSystemsConfig(member.guild.id);
    if (!rs.autoroles?.enabled) return;
    const roleIds = rs.autoroles.roleIds || [];
    if (roleIds.length === 0) return;
    for (const roleId of roleIds) {
      const role = member.guild.roles.cache.get(roleId);
      if (!role) continue;
      try {
        await member.roles.add(role, 'Autorole on join');
      } catch (err) {
        console.error(`[Autorole] Failed to add role ${roleId} to ${member.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Autorole] handleAutorole error:', err.message);
  }
}

// ── Build & post a role panel message ─────────────────────────
function buildPanelEmbed(panel) {
  const color = /^#[0-9a-fA-F]{6}$/.test(panel.color) ? parseInt(panel.color.slice(1), 16) : 0x5865f2;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(panel.title || '🎭 Role Selection')
    .setTimestamp();

  if (panel.type === 'reaction') {
    const lines = (panel.options || [])
      .filter(o => o.roleId)
      .map(o => `${o.emoji || '🔘'} — <@&${o.roleId}>${o.description ? ` — ${o.description}` : ''}`);
    embed.setDescription(`${panel.description ? panel.description + '\n\n' : ''}${lines.join('\n')}`);
  } else {
    embed.setDescription(panel.description || 'Select your roles below.');
  }

  return embed;
}

function buildPanelComponents(panel) {
  const options = (panel.options || []).filter(o => o.roleId);

  if (panel.type === 'button') {
    const rows = [];
    for (let i = 0; i < options.slice(0, 25).length; i += 5) {
      const row = new ActionRowBuilder().addComponents(
        options.slice(i, i + 5).map(o =>
          new ButtonBuilder()
            .setCustomId(`rolepanel_btn__${panel.id}__${o.roleId}`)
            .setLabel(o.label || 'Role')
            .setEmoji(o.emoji && o.emoji.trim() ? o.emoji.trim() : undefined)
            .setStyle(ButtonStyle.Secondary)
        )
      );
      rows.push(row);
    }
    return rows;
  }

  if (panel.type === 'dropdown') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rolepanel_select__${panel.id}`)
      .setPlaceholder(panel.placeholder || 'Select your roles')
      .setMinValues(0)
      .setMaxValues(panel.multiSelect ? Math.max(1, options.length) : 1)
      .addOptions(
        options.slice(0, 25).map(o => ({
          label: (o.label || 'Role').slice(0, 100),
          value: o.roleId,
          description: o.description ? o.description.slice(0, 100) : undefined,
          emoji: o.emoji && o.emoji.trim() ? o.emoji.trim() : undefined,
        }))
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }

  // reaction type has no components — uses message reactions instead
  return [];
}

async function postRolePanel(channel, panel) {
  const embed = buildPanelEmbed(panel);
  const components = buildPanelComponents(panel);
  const msg = await channel.send({ embeds: [embed], components });

  if (panel.type === 'reaction') {
    const options = (panel.options || []).filter(o => o.roleId && o.emoji);
    for (const o of options.slice(0, 20)) {
      try {
        await msg.react(o.emoji.trim());
      } catch (err) {
        console.error(`[RolePanel] Failed to react with ${o.emoji} on panel ${panel.id}:`, err.message);
      }
    }
  }

  return msg;
}

async function saveRolePanelMessageId(guildId, panelId, channelId, messageId) {
  const cfg = _getConfig();
  cfg.roleSystems = cfg.roleSystems || {};
  cfg.roleSystems[guildId] = cfg.roleSystems[guildId] || { autoroles: { enabled: false, roleIds: [] }, panels: [] };
  const panels = cfg.roleSystems[guildId].panels || [];
  const panel = panels.find(p => p.id === panelId);
  if (panel) {
    panel.channelId = channelId;
    panel.messageId = messageId;
  }
  return cfg;
}

// ── Button / dropdown interaction handling ─────────────────────
async function toggleRole(member, roleId, panel) {
  const has = member.roles.cache.has(roleId);
  const role = member.guild.roles.cache.get(roleId);
  if (!role) return { ok: false, error: 'Role no longer exists.' };

  try {
    if (has) {
      await member.roles.remove(role, `Role panel: ${panel.id}`);
      return { ok: true, added: false, roleId };
    } else {
      if (!panel.multiSelect && panel.type !== 'button') {
        // single-select dropdown: remove other roles from this panel first
        const otherRoleIds = (panel.options || []).map(o => o.roleId).filter(id => id && id !== roleId);
        for (const otherId of otherRoleIds) {
          if (member.roles.cache.has(otherId)) {
            await member.roles.remove(otherId, `Role panel: ${panel.id} (single-select swap)`).catch(() => {});
          }
        }
      }
      await member.roles.add(role, `Role panel: ${panel.id}`);
      return { ok: true, added: true, roleId };
    }
  } catch (err) {
    console.error('[RolePanel] toggleRole failed:', err.message);
    return { ok: false, error: 'I might be missing permissions or my role is positioned below that role.' };
  }
}

async function handleRoleSystemInteraction(interaction) {
  if (!interaction.guild) return false;

  // ── Button-based role toggle ──
  if (interaction.isButton() && interaction.customId.startsWith('rolepanel_btn__')) {
    const [, panelId, roleId] = interaction.customId.split('__');
    const panel = getRolePanel(interaction.guild.id, panelId);
    if (!panel) {
      await interaction.reply({ content: '❌ This role panel no longer exists.', flags: 64 });
      return true;
    }
    const member = interaction.member;
    const result = await toggleRole(member, roleId, panel);
    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.error}`, flags: 64 });
      return true;
    }
    await interaction.reply({
      content: result.added ? `✅ Added role <@&${roleId}>` : `➖ Removed role <@&${roleId}>`,
      flags: 64,
    });
    return true;
  }

  // ── Dropdown-based role select ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('rolepanel_select__')) {
    const panelId = interaction.customId.split('__')[1];
    const panel = getRolePanel(interaction.guild.id, panelId);
    if (!panel) {
      await interaction.reply({ content: '❌ This role panel no longer exists.', flags: 64 });
      return true;
    }
    const member = interaction.member;
    const selectedIds = interaction.values; // role IDs chosen this submission
    const allOptionRoleIds = (panel.options || []).map(o => o.roleId).filter(Boolean);

    const added = [], removed = [];
    try {
      for (const roleId of allOptionRoleIds) {
        const shouldHave = selectedIds.includes(roleId);
        const has = member.roles.cache.has(roleId);
        if (shouldHave && !has) {
          await member.roles.add(roleId, `Role panel: ${panel.id}`);
          added.push(roleId);
        } else if (!shouldHave && has) {
          await member.roles.remove(roleId, `Role panel: ${panel.id}`);
          removed.push(roleId);
        }
      }
    } catch (err) {
      console.error('[RolePanel] dropdown sync failed:', err.message);
      await interaction.reply({ content: '❌ Failed to update roles. I might be missing permissions.', flags: 64 });
      return true;
    }

    const parts = [];
    if (added.length) parts.push(`✅ Added: ${added.map(id => `<@&${id}>`).join(', ')}`);
    if (removed.length) parts.push(`➖ Removed: ${removed.map(id => `<@&${id}>`).join(', ')}`);
    await interaction.reply({ content: parts.length ? parts.join('\n') : 'No role changes.', flags: 64 });
    return true;
  }

  return false;
}

// ── Reaction-role handling ──────────────────────────────────────
function findReactionPanel(guildId, messageId, emoji) {
  const panels = getRolePanelList(guildId).filter(p => p.type === 'reaction' && p.messageId === messageId);
  for (const panel of panels) {
    const option = (panel.options || []).find(o => o.roleId && o.emoji && o.emoji.trim() === emoji);
    if (option) return { panel, option };
  }
  return null;
}

async function handleReactionAdd(reaction, user) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
    const guild = reaction.message.guild;
    if (!guild) return;

    const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
    const found = findReactionPanel(guild.id, reaction.message.id, emoji);
    if (!found) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const role = guild.roles.cache.get(found.option.roleId);
    if (!role) return;

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, `Reaction role panel: ${found.panel.id}`).catch(err =>
        console.error('[RolePanel] reaction add failed:', err.message)
      );
    }
  } catch (err) {
    console.error('[RolePanel] handleReactionAdd error:', err.message);
  }
}

async function handleReactionRemove(reaction, user) {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);
    if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
    const guild = reaction.message.guild;
    if (!guild) return;

    const emoji = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
    const found = findReactionPanel(guild.id, reaction.message.id, emoji);
    if (!found) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const role = guild.roles.cache.get(found.option.roleId);
    if (!role) return;

    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role, `Reaction role panel: ${found.panel.id}`).catch(err =>
        console.error('[RolePanel] reaction remove failed:', err.message)
      );
    }
  } catch (err) {
    console.error('[RolePanel] handleReactionRemove error:', err.message);
  }
}

module.exports = {
  initRoleSystems,
  getRolePanelList,
  getRolePanel,
  handleAutorole,
  postRolePanel,
  saveRolePanelMessageId,
  handleRoleSystemInteraction,
  handleReactionAdd,
  handleReactionRemove,
};