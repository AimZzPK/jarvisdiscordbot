// =========================
// SOCIAL NOTIFICATIONS
// YouTube · TikTok · Twitch
// =========================
// Drop-in module for JARVIS bot.
// Call initSocialNotifications(client, redis, dashboardConfig, saveDashboardConfig, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle)
// after the bot is ready.

const axios = require('axios');

// ── Polling intervals (ms) ────────────────────────────────────────
const YOUTUBE_INTERVAL = 5  * 60 * 1000;  // 5 min
const TWITCH_INTERVAL  = 2  * 60 * 1000;  // 2 min
const TIKTOK_INTERVAL  = 10 * 60 * 1000;  // 10 min (RSS, be gentle)

// ── Twitch token cache ────────────────────────────────────────────
let twitchToken = null;
let twitchTokenExpiry = 0;

async function getTwitchToken() {
  if (twitchToken && Date.now() < twitchTokenExpiry - 60_000) return twitchToken;
  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id:     process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type:    'client_credentials',
    },
  });
  twitchToken = res.data.access_token;
  twitchTokenExpiry = Date.now() + res.data.expires_in * 1000;
  return twitchToken;
}

// ── Helpers ───────────────────────────────────────────────────────
function fmtNum(n) {
  if (!n) return '0';
  const num = parseInt(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

// ── Notification sender ───────────────────────────────────────────
async function sendNotification(client, guildId, platform, cfg, embed, pingRoleId) {
  if (!cfg?.channelId) return;
  try {
    const channel = await client.channels.fetch(cfg.channelId);
    const content = pingRoleId ? `<@&${pingRoleId}>` : '';
    await channel.send({ content, embeds: [embed] });
  } catch (err) {
    console.error(`[SocialNotify][${platform}] Failed to send to guild ${guildId}:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// YOUTUBE
// ═══════════════════════════════════════════════════════════════════
async function pollYouTube(client, redis, dashboardConfig, EmbedBuilder) {
  if (!process.env.YOUTUBE_API_KEY) return;

  const notifyCfg = dashboardConfig.socialNotifications || {};

  for (const [guildId, cfg] of Object.entries(notifyCfg)) {
    const ytChannels = cfg.youtube?.channels || [];
    if (!ytChannels.length || !cfg.youtube?.channelId) continue;

    for (const ytChannelId of ytChannels) {
      try {
        // Fetch latest video from channel
        const searchRes = await axios.get('https://www.googleapis.com/youtube/v3/search', {
          params: {
            key:        process.env.YOUTUBE_API_KEY,
            channelId:  ytChannelId,
            part:       'snippet',
            order:      'date',
            maxResults: 1,
            type:       'video',
          },
        });

        const item = searchRes.data.items?.[0];
        if (!item) continue;

        const videoId   = item.id?.videoId;
        const title     = item.snippet?.title;
        const thumb     = item.snippet?.thumbnails?.maxres?.url || item.snippet?.thumbnails?.high?.url;
        const channelName = item.snippet?.channelTitle;
        const publishedAt = item.snippet?.publishedAt;

        if (!videoId) continue;

        // Check if already sent
        const seenKey = `yt-seen-${guildId}-${ytChannelId}`;
        const lastSeen = await redis.get(seenKey).catch(() => null);
        if (lastSeen === videoId) continue;

        // Fetch extra stats
        let viewCount = '?', likeCount = '?', duration = '';
        try {
          const statsRes = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
            params: { key: process.env.YOUTUBE_API_KEY, id: videoId, part: 'statistics,contentDetails' },
          });
          const stats = statsRes.data.items?.[0];
          viewCount = fmtNum(stats?.statistics?.viewCount);
          likeCount = fmtNum(stats?.statistics?.likeCount);
          // Parse ISO 8601 duration
          const raw = stats?.contentDetails?.duration || '';
          const m = raw.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
          if (m) {
            const h = m[1] ? `${m[1]}:` : '';
            const min = String(m[2] || '0').padStart(h ? 2 : 1, '0');
            const sec = String(m[3] || '0').padStart(2, '0');
            duration = `${h}${min}:${sec}`;
          }
        } catch {}

        const embed = new EmbedBuilder()
          .setColor(0xff0000)
          .setAuthor({ name: `📺 ${channelName}`, iconURL: 'https://www.youtube.com/favicon.ico' })
          .setTitle(title)
          .setURL(`https://www.youtube.com/watch?v=${videoId}`)
          .setDescription(`**${channelName}** just uploaded a new video!`)
          .addFields(
            { name: '👀 Views',    value: viewCount,  inline: true },
            { name: '👍 Likes',    value: likeCount,  inline: true },
            { name: '⏱️ Duration', value: duration || '—', inline: true },
          )
          .setImage(thumb || null)
          .setFooter({ text: 'JARVIS • YouTube Notifications' })
          .setTimestamp(publishedAt ? new Date(publishedAt) : undefined);

        await sendNotification(client, guildId, 'YouTube', cfg.youtube, embed, cfg.youtube?.pingRoleId);
        await redis.set(seenKey, videoId);
      } catch (err) {
        console.error(`[SocialNotify][YouTube] Error for guild ${guildId} / channel ${ytChannelId}:`, err.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// TWITCH
// ═══════════════════════════════════════════════════════════════════
async function pollTwitch(client, redis, dashboardConfig, EmbedBuilder) {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return;

  const notifyCfg = dashboardConfig.socialNotifications || {};

  for (const [guildId, cfg] of Object.entries(notifyCfg)) {
    const streamers = cfg.twitch?.streamers || [];
    if (!streamers.length || !cfg.twitch?.channelId) continue;

    let token;
    try { token = await getTwitchToken(); } catch (err) {
      console.error('[SocialNotify][Twitch] Token error:', err.message);
      continue;
    }

    const headers = {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
    };

    for (const login of streamers) {
      try {
        const streamRes = await axios.get('https://api.twitch.tv/helix/streams', {
          headers,
          params: { user_login: login },
        });

        const stream = streamRes.data.data?.[0];
        const liveKey  = `twitch-live-${guildId}-${login}`;
        const wasLive  = await redis.get(liveKey).catch(() => null);

        if (!stream) {
          // Went offline — clear live flag
          if (wasLive) await redis.del(liveKey).catch(() => {});
          continue;
        }

        // Already notified for this stream session
        if (wasLive === stream.id) continue;

        // Fetch user info for profile image
        let profileImg = null, displayName = stream.user_name, description = '';
        try {
          const userRes = await axios.get('https://api.twitch.tv/helix/users', {
            headers, params: { login },
          });
          const user = userRes.data.data?.[0];
          profileImg  = user?.profile_image_url;
          displayName = user?.display_name || stream.user_name;
          description = user?.description || '';
        } catch {}

        // Fetch game name
        let gameName = stream.game_name || '?';

        const thumb = stream.thumbnail_url
          ?.replace('{width}', '1280')
          ?.replace('{height}', '720');

        const embed = new EmbedBuilder()
          .setColor(0x9146ff)
          .setAuthor({ name: `🔴 ${displayName} is LIVE on Twitch!`, iconURL: profileImg || undefined })
          .setTitle(stream.title || 'Untitled Stream')
          .setURL(`https://twitch.tv/${login}`)
          .setDescription(description ? description.slice(0, 200) : `**${displayName}** just went live!`)
          .addFields(
            { name: '🎮 Game',    value: gameName,                    inline: true },
            { name: '👥 Viewers', value: fmtNum(stream.viewer_count), inline: true },
            { name: '🌐 Watch',   value: `[twitch.tv/${login}](https://twitch.tv/${login})`, inline: true },
          )
          .setImage(thumb || null)
          .setFooter({ text: 'JARVIS • Twitch Notifications' })
          .setTimestamp(stream.started_at ? new Date(stream.started_at) : undefined);

        await sendNotification(client, guildId, 'Twitch', cfg.twitch, embed, cfg.twitch?.pingRoleId);
        await redis.set(liveKey, stream.id);
      } catch (err) {
        console.error(`[SocialNotify][Twitch] Error for guild ${guildId} / streamer ${login}:`, err.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// TIKTOK  (RSS via Proxitok / nitter-style — no API key needed)
// ═══════════════════════════════════════════════════════════════════
async function pollTikTok(client, redis, dashboardConfig, EmbedBuilder) {
  const notifyCfg = dashboardConfig.socialNotifications || {};

  for (const [guildId, cfg] of Object.entries(notifyCfg)) {
    const accounts = cfg.tiktok?.accounts || [];
    if (!accounts.length || !cfg.tiktok?.channelId) continue;

    for (const username of accounts) {
      try {
        // Use proxitok RSS (community-run, no API key)
        const rssUrl = `https://proxitok.pussthecat.org/@${username}/rss`;
        const rssRes = await axios.get(rssUrl, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 JARVIS-Bot/1.0' },
        });

        // Parse the first <item> from the RSS XML
        const xml = rssRes.data;
        const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        if (!items.length) continue;

        const first = items[0];
        const link  = (first.match(/<link>(.*?)<\/link>/) || [])[1]?.trim();
        const titleMatch = (first.match(/<title>(.*?)<\/title>/) || [])[1];
        const title  = titleMatch ? titleMatch.replace(/<!\[CDATA\[|\]\]>/g, '').trim() : 'New TikTok video';
        const pubDate = (first.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim();
        const videoId = link?.split('/').pop()?.split('?')[0];

        if (!videoId || !link) continue;

        const seenKey = `tt-seen-${guildId}-${username}`;
        const lastSeen = await redis.get(seenKey).catch(() => null);
        if (lastSeen === videoId) continue;

        const embed = new EmbedBuilder()
          .setColor(0x010101)
          .setAuthor({ name: `🎵 @${username} posted on TikTok` })
          .setTitle(title.slice(0, 256))
          .setURL(link)
          .setDescription(`**@${username}** just posted a new TikTok!\n\n[▶ Watch on TikTok](${link})`)
          .setFooter({ text: 'JARVIS • TikTok Notifications' })
          .setTimestamp(pubDate ? new Date(pubDate) : undefined);

        await sendNotification(client, guildId, 'TikTok', cfg.tiktok, embed, cfg.tiktok?.pingRoleId);
        await redis.set(seenKey, videoId);
      } catch (err) {
        // RSS proxy may go down — log but don't crash
        console.error(`[SocialNotify][TikTok] Error for guild ${guildId} / @${username}:`, err.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// INIT — call this once after client is ready
// ═══════════════════════════════════════════════════════════════════
function initSocialNotifications(client, redis, getDashboardConfig, EmbedBuilder) {
  console.log('📡 Social notifications initialised');

  // Stagger start times so all three don't fire at once
  setTimeout(() => {
    pollYouTube(client, redis, getDashboardConfig(), EmbedBuilder);
    setInterval(() => pollYouTube(client, redis, getDashboardConfig(), EmbedBuilder), YOUTUBE_INTERVAL);
  }, 5_000);

  setTimeout(() => {
    pollTwitch(client, redis, getDashboardConfig(), EmbedBuilder);
    setInterval(() => pollTwitch(client, redis, getDashboardConfig(), EmbedBuilder), TWITCH_INTERVAL);
  }, 15_000);

  setTimeout(() => {
    pollTikTok(client, redis, getDashboardConfig(), EmbedBuilder);
    setInterval(() => pollTikTok(client, redis, getDashboardConfig(), EmbedBuilder), TIKTOK_INTERVAL);
  }, 30_000);
}

module.exports = { initSocialNotifications };