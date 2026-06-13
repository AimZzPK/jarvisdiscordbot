const { requireSession, discordFetch, hasManageGuild } = require('../lib/helpers');

module.exports = async (req, res) => {
  const { session } = await requireSession(req);

  if (!session || session.pending || !session.user) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'not_authenticated' }));
  }

  try {
    // Guilds the user has Manage Server permission in
    const manageable = (session.guilds || []).filter(g => hasManageGuild(g.permissions));

    // Guilds the bot is currently in (via bot token)
    const botGuilds = await discordFetch('/users/@me/guilds', process.env.DISCORD_TOKEN, 'Bot');
    const botGuildIds = new Set(botGuilds.map(g => g.id));

    const result = manageable
      .filter(g => botGuildIds.has(g.id))
      .map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon
          ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`
          : null,
      }));

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ guilds: result }));
  } catch (err) {
    console.error('guilds error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
};