const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SESSION_PREFIX = 'dash-session-';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ─── Session management ──────────────────────────────────────
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(data) {
  const sessionId = generateSessionId();
  await redis.set(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(data), { ex: SESSION_TTL_SECONDS });
  return sessionId;
}

async function getSession(sessionId) {
  if (!sessionId) return null;
  try {
    const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return null;
  }
}

async function destroySession(sessionId) {
  if (!sessionId) return;
  await redis.del(`${SESSION_PREFIX}${sessionId}`);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function setSessionCookie(res, sessionId) {
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  const parts = [
    `dash_session=${encodeURIComponent(sessionId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isProd) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'dash_session=; Path=/; HttpOnly; Max-Age=0');
}

async function requireSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.dash_session;
  const session = await getSession(sessionId);
  return { session, sessionId };
}

// ─── Memory helpers (same store the bot uses) ────────────────
const MEMORY_KEY = 'jarvis-memory';

async function loadMemory() {
  try {
    const data = await redis.get(MEMORY_KEY);
    return data ? (typeof data === 'string' ? JSON.parse(data) : data) : {};
  } catch {
    return {};
  }
}

async function saveMemory(memory) {
  await redis.set(MEMORY_KEY, JSON.stringify(memory));
}

// ─── Discord API helpers ─────────────────────────────────────
const DISCORD_API = 'https://discord.com/api/v10';

async function discordFetch(endpoint, token, tokenType = 'Bearer') {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    headers: { Authorization: `${tokenType} ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord API ${endpoint} failed: ${res.status} ${text}`);
  }
  return res.json();
}

const MANAGE_GUILD = 0x20n; // 0x00000020

function hasManageGuild(permissions) {
  try {
    const perms = BigInt(permissions);
    return (perms & MANAGE_GUILD) === MANAGE_GUILD;
  } catch {
    return false;
  }
}

module.exports = {
  redis,
  createSession,
  getSession,
  destroySession,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  requireSession,
  loadMemory,
  saveMemory,
  discordFetch,
  hasManageGuild,
  generateSessionId,
};