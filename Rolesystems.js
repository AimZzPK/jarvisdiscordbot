// =========================
// ROLE SYSTEMS MODULE
// Handles: Autoroles, Reaction Roles, Button Roles, Dropdown (Select Menu) Roles
// =========================
//
// USAGE IN index.js:
//   const { initRoleSystems, handleAutorole, getRolePanel, getRolePanelList } = require('./roleSystems');
//   initRoleSystems(client, redis, () => dashboardConfig);
//   // in guildMemberAdd: await handleAutorole(member);
//   // in interactionCreate: pass through reaction/button/select role interactions (see hooks below)
//
// Dashboard config shape (config.roleSystems[guildId]):
// {
//   autoroles: { enabled: false, roleIds: [] },
//   panels: [
//     {
//       id: 'panel1',
//       type: 'button' | 'dropdown' | 'reaction',
//       title: 'Pick your roles',
//       description: 'Click a button below',
//       color: '#5865f2',
//       channelId: null,         // where it's posted (informational, set after /setuprolepanel)
//       messageId: null,         // set after posting (for reaction roles)
//       multiSelect: true,       // dropdown/button: can pick more than one
//       placeholder: 'Select your roles', // dropdown only
//       options: [
//         { id: 'opt1', label: 'Gamer', emoji: '🎮', roleId: '1234', description: 'Get gamer pings' }
//       ]
//     }
//   ]
// }

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder } = require('discord.js');

let _client = null;
let _redis = null;
let _getConfig = null;

function initRoleSystems(client, redis, getConfig) {
  _client = client;
  _redis = redis;
  _getConfig = getConfig;
}

// ─── Helpers ──────────────────────────────────────────────────
function getRoleSystemsConfig(guildId) {
  const cfg = _getConfig();
  return cfg.roleSystems?.[guildId] || { autoroles: { enabled: false, roleIds: [] }, panels: [] };
}

function getRolePanelList(guildId) {
  return getRoleSystemsConfig(guildId).panels || [];
}

function getRolePanel(guildId, panelId) {
  return getRolePanelList(guildId).find(p => p.id === panelId) || null;
}

function getAutoroles(guildId) {
  return getRoleSystemsConfig(guildId).autoroles || { enabled: false, roleIds: [] };
}

// ─── Autoroles ────────────────────────────────────────────────
async function handleAutorole(member) {
  try {
    const auto = getAutoroles(member.guild.id);
    if (!auto.enabled || !Array.isArray(auto.roleIds) || auto.roleIds.length === 0) return;
    const validRoleIds = auto.roleIds.filter(id => member.guild.roles.cache.has(id));
    if (validRoleIds.length === 0) return;
    await member.roles.add(validRoleIds, 'Autorole on join');
  } catch (err) {
    console.error('[Autorole] failed:', err.message);
  }
}

// ─── Building Discord components from a panel config ─────────
function buildPanelComponents(panel) {
  const options = panel.options || [];

  if (panel.type === 'dropdown') {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`rolepanel_select__${panel.id}`)
      .setPlaceholder(panel.placeholder || 'Select your roles')
      .setMinValues(0)
      .setMaxValues(panel.multiSelect ? Math.max(1, options.length) : 1)
      .addOptions(
        options.slice(0, 25).map(o => ({
          label: (o.label || 'Role').slice(0, 100),
          value: o.id,
          description: o.description ? o.description.slice(0, 100) : undefined,
          emoji: o.emoji || undefined,
        }))
      );
    return [new ActionRowBuilder().addComponents(menu)];
  }

  // button type (also used as fallback for reaction-style panels rendered as buttons)
  const rows = [];
  for (let i = 0; i < options.length; i += 5) {
    const chunk = options.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      chunk.map(o =>
        new ButtonBuilder()
          .setCustomId(`rolepanel_button__${panel.id}__${o.id}`)
          .setLabel((o.label || 'Role').slice(0, 80))
          .setEmoji(o.emoji || undefined)
          .setStyle(ButtonStyle.Secondary)
      )
    );
    rows.push(row);
  }
  return rows.slice(0, 5); // Discord max 5 action rows
}

function buildPanelEmbed(guild, panel) {
  const color = parseInt((panel.color || '#5865f2').replace(/^#/, ''), 16) || 0x5865f2;
  const lines = (panel.options || []).map(o => `${o.emoji ? o.emoji + ' ' : ''}**${o.label}**${o.roleId ? ` — <@&${o.roleId}>` : ''}${o.description ? `\n${o.description}` : ''}`);
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(panel.title || '🎭 Role Selection')
    .setDescription((panel.description ? panel.description + '\n\n' : '') + lines.join('\n\n'))
    .setFooter({ text: `${guild.name} • Role Panel` })
    .setTimestamp();
}

// ─── Posting a panel (used by /setuprolepanel) ────────────────
async function postRolePanel(channel, panel) {
  const embed = buildPanelEmbed(channel.guild, panel);

  if (panel.type === 'reaction') {
    const msg = await channel.send({ embeds: [embed] });
    for (const o of (panel.options || []).slice(0, 20)) {
      if (o.emoji) {
        try { await msg.react(o.emoji); } catch (err) { console.error('[RolePanel] react failed:', err.message); }
      }
    }
    return msg;
  }

  const components = buildPanelComponents(panel);
  return channel.send({ embeds: [embed], components });
}

// ─── Saving message ID back to config (so reaction roles can be matched) ──
async function saveRolePanelMessageId(guildId, panelId, channelId, messageId) {
  const cfg = _getConfig();
  cfg.roleSystems = cfg.roleSystems || {};
  cfg.roleSystems[guildId] = cfg.roleSystems[guildId] || { autoroles: { enabled: false, roleIds: [] }, panels: [] };
  const panel = cfg.roleSystems[guildId].panels.find(p => p.id === panelId);
  if (panel) {
    panel.channelId = channelId;
    panel.messageId = messageId;
  }
  // Caller is responsible for calling saveDashboardConfig(cfg) after this,
  // since this module doesn't own the save function directly.
  return cfg;
}

// ─── Interaction handlers ──────────────────────────────────────
// Returns true if the interaction was handled by this module.
async function handleRolePanelButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith('rolepanel_button__')) return false;
  if (!interaction.guild) return true;

  const [, panelId, optionId] = interaction.customId.split('__');
  const panel = getRolePanel(interaction.guild.id, panelId);
  if (!panel) {
    await interaction.reply({ content: '❌ This role panel no longer exists.', flags: 64 });
    return true;
  }
  const option = (panel.options || []).find(o => o.id === optionId);
  if (!option || !option.roleId) {
    await interaction.reply({ content: '❌ This role option is misconfigured.', flags: 64 });
    return true;
  }

  const member = interaction.member;
  const hasRole = member.roles.cache.has(option.roleId);

  try {
    if (!panel.multiSelect && !hasRole) {
      // Remove other roles from this panel's options before adding the new one
      const otherRoleIds = (panel.options || []).map(o => o.roleId).filter(id => id && id !== option.roleId && member.roles.cache.has(id));
      if (otherRoleIds.length) await member.roles.remove(otherRoleIds, 'Role panel single-select swap');
    }

    if (hasRole) {
      await member.roles.remove(option.roleId, 'Role panel toggle off');
      await interaction.reply({ content: `➖ Removed role **${option.label}**.`, flags: 64 });
    } else {
      await member.roles.add(option.roleId, 'Role panel toggle on');
      await interaction.reply({ content: `✅ Gave you the **${option.label}** role!`, flags: 64 });
    }
  } catch (err) {
    console.error('[RolePanel] button role toggle failed:', err.message);
    await interaction.reply({ content: '❌ Failed to update your roles. I may be missing **Manage Roles** permission or my role is below the target role.', flags: 64 });
  }
  return true;
}

async function handleRolePanelSelect(interaction) {
  if (!interaction.isStringSelectMenu() || !interaction.customId.startsWith('rolepanel_select__')) return false;
  if (!interaction.guild) return true;

  const panelId = interaction.customId.split('__')[1];
  const panel = getRolePanel(interaction.guild.id, panelId);
  if (!panel) {
    await interaction.reply({ content: '❌ This role panel no longer exists.', flags: 64 });
    return true;
  }

  const selectedIds = interaction.values; // array of option.id
  const allOptions = panel.options || [];
  const selectedRoleIds = allOptions.filter(o => selectedIds.includes(o.id)).map(o => o.roleId).filter(Boolean);
  const allPanelRoleIds = allOptions.map(o => o.roleId).filter(Boolean);

  const member = interaction.member;
  const toAdd = selectedRoleIds.filter(id => !member.roles.cache.has(id));
  const toRemove = allPanelRoleIds.filter(id => !selectedRoleIds.includes(id) && member.roles.cache.has(id));

  try {
    if (toAdd.length) await member.roles.add(toAdd, 'Role panel dropdown select');
    if (toRemove.length) await member.roles.remove(toRemove, 'Role panel dropdown deselect');
    const addedLabels = allOptions.filter(o => toAdd.includes(o.roleId)).map(o => o.label);
    const removedLabels = allOptions.filter(o => toRemove.includes(o.roleId)).map(o => o.label);
    const parts = [];
    if (addedLabels.length) parts.push(`✅ Added: ${addedLabels.join(', ')}`);
    if (removedLabels.length) parts.push(`➖ Removed: ${removedLabels.join(', ')}`);
    await interaction.reply({ content: parts.length ? parts.join('\n') : 'No changes made.', flags: 64 });
  } catch (err) {
    console.error('[RolePanel] dropdown role update failed:', err.message);
    await interaction.reply({ content: '❌ Failed to update your roles. I may be missing **Manage Roles** permission or my role is below the target role.', flags: 64 });
  }
  return true;
}

// ─── Reaction role events (message reaction add/remove) ────────
async function handleReactionAdd(reaction, user) {
  try {
    if (user.bot) return;
    if (!reaction.message.guild) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);

    const guildId = reaction.message.guild.id;
    const panels = getRolePanelList(guildId).filter(p => p.type === 'reaction' && p.messageId === reaction.message.id);
    if (panels.length === 0) return;

    for (const panel of panels) {
      const emojiKey = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
      const option = (panel.options || []).find(o => o.emoji === emojiKey || o.emoji === reaction.emoji.name);
      if (!option || !option.roleId) continue;

      const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
      if (!member) continue;

      if (!panel.multiSelect) {
        const otherRoleIds = (panel.options || []).map(o => o.roleId).filter(id => id && id !== option.roleId && member.roles.cache.has(id));
        if (otherRoleIds.length) await member.roles.remove(otherRoleIds, 'Reaction role single-select swap').catch(() => {});
        // also remove their other reactions on this message for cleanliness
        for (const otherOpt of (panel.options || [])) {
          if (otherOpt.id !== option.id && otherOpt.emoji) {
            const otherReaction = reaction.message.reactions.cache.find(r => (r.emoji.id ? `<:${r.emoji.name}:${r.emoji.id}>` : r.emoji.name) === otherOpt.emoji);
            if (otherReaction) await otherReaction.users.remove(user.id).catch(() => {});
          }
        }
      }

      await member.roles.add(option.roleId, 'Reaction role add').catch(err => console.error('[ReactionRole] add failed:', err.message));
    }
  } catch (err) {
    console.error('[ReactionRole] handleReactionAdd error:', err.message);
  }
}

async function handleReactionRemove(reaction, user) {
  try {
    if (user.bot) return;
    if (!reaction.message.guild) return;
    if (reaction.partial) await reaction.fetch().catch(() => null);

    const guildId = reaction.message.guild.id;
    const panels = getRolePanelList(guildId).filter(p => p.type === 'reaction' && p.messageId === reaction.message.id);
    if (panels.length === 0) return;

    for (const panel of panels) {
      const emojiKey = reaction.emoji.id ? `<:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
      const option = (panel.options || []).find(o => o.emoji === emojiKey || o.emoji === reaction.emoji.name);
      if (!option || !option.roleId) continue;

      const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
      if (!member) continue;

      await member.roles.remove(option.roleId, 'Reaction role remove').catch(err => console.error('[ReactionRole] remove failed:', err.message));
    }
  } catch (err) {
    console.error('[ReactionRole] handleReactionRemove error:', err.message);
  }
}

// ─── Main interaction dispatcher (call from interactionCreate) ─
// Returns true if handled.
async function handleRoleSystemInteraction(interaction) {
  if (await handleRolePanelButton(interaction)) return true;
  if (await handleRolePanelSelect(interaction)) return true;
  return false;
}

module.exports = {
  initRoleSystems,
  getRoleSystemsConfig,
  getRolePanelList,
  getRolePanel,
  getAutoroles,
  handleAutorole,
  postRolePanel,
  saveRolePanelMessageId,
  handleRoleSystemInteraction,
  handleReactionAdd,
  handleReactionRemove,
};
