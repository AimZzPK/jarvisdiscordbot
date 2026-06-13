const {
  requireSession,
  destroySession,
  createSession,
  setSessionCookie,
  discordFetch,
} = require('../../lib/helpers');

module.exports = async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    res.writeHead(302, { Location: '/?error=' + encodeURIComponent(error) });
    return res.end();
  }

  if (!code || !state) {
    res.writeHead(302, { Location: '/?error=missing_params' });
    return res.end();
  }

  // Verify state against the pending session created in login.js
  const { session: pendingSession, sessionId: oldSessionId } = await requireSession(req);
  if (!pendingSession || pendingSession.oauthState !== state) {
    res.writeHead(302, { Location: '/?error=invalid_state' });
    return res.end();
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      console.error('Token exchange failed:', text);
      res.writeHead(302, { Location: '/?error=token_exchange_failed' });
      return res.end();
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    // Fetch the user's identity
    const user = await discordFetch('/users/@me', access_token);

    // Fetch the user's guilds (for permission checks later)
    const guilds = await discordFetch('/users/@me/guilds', access_token);

    // Clean up the pending session, create a real one
    await destroySession(oldSessionId);

    const sessionId = await createSession({
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        global_name: user.global_name,
      },
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + (expires_in || 0) * 1000,
      guilds: guilds.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        permissions: g.permissions,
      })),
    });

    setSessionCookie(res, sessionId);

    res.writeHead(302, { Location: '/dashboard.html' });
    res.end();
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.writeHead(302, { Location: '/?error=server_error' });
    res.end();
  }
};