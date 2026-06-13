const crypto = require('crypto');
const { createSession, setSessionCookie } = require('../../lib/helpers');

module.exports = async (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');

  // Stash a temporary "pending" session holding the OAuth state, so the
  // callback can verify it (CSRF protection).
  const sessionId = await createSession({ oauthState: state, pending: true });
  setSessionCookie(res, sessionId);

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'consent',
  });

  res.writeHead(302, { Location: `https://discord.com/oauth2/authorize?${params.toString()}` });
  res.end();
};