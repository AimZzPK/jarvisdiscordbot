const { requireSession, destroySession, clearSessionCookie } = require('../../lib/helpers');

module.exports = async (req, res) => {
  const { sessionId } = await requireSession(req);
  await destroySession(sessionId);
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/' });
  res.end();
};