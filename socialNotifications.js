// =========================
// SOCIAL NOTIFICATIONS MODULE
// =========================
// Polls YouTube, Twitch, and TikTok for new uploads / live streams / posts
// and sends an embed announcement to the configured Discord channel.
//
// Usage (from index.js):
//   const { initSocialNotifications } = require('./socialNotifications');
//   initSocialNotifications(client, redis, () => dashboardConfig, EmbedBuilder);
//
// Config shape (set via /setnotify), read live from dashboardConfig:
//   dashboardConfig.socialNotifications[guildId] = {
//     youtube: { channels: ['UCxxxx', ...], channelId, pingRoleId },
//     twitch:  { streamers: ['name', ...], channelId, pingRoleId },
//     tiktok:  { accounts: ['username', ...], channelId, pingRoleId }
//   }

const axios = require('axios');

const CHECK_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

// =========================
// REDIS "LAST SEEN" HELPERS
// =========================
// We track the last seen video/stream/post ID per (platform, target) so we
// never double-post after a restart or duplicate check.

async function getLastSeen(redis, platform, key) {
  try {
    const val = await redis.get(`social-lastseen-${platform}-${key}`);
    return val || null;
  } catch {
    return null;
  }
}

async function setLastSeen(redis, platform, key, value) {
  try {
    await redis.set(`social-lastseen-${platform}-${key}`, value);
  } catch (err) {
    console.error(`[SocialNotify] Failed to save last seen for ${platform}/${key}:`, err.message);
  }
}

// =========================
// SMALL HELPERS
// =========================

function truncate(str, max = 200) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

async function sendAnnouncement(client, channelId, pingRoleId, embed) {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    const content = pingRoleId ? `<@&${pingRoleId}>` : undefined;
    await channel.send({ content, embeds: [embed] });
  } catch (err) {
    console.error('[SocialNotify] Failed to send announcement:', err.message);
  }
}

// =========================
// YOUTUBE
// =========================
// Uses the YouTube Data API v3 (same YOUTUBE_API_KEY already used elsewhere
// in the bot for /youtube and link previews). Checks each channel's uploads
// for a new "most recent video" via the search endpoint ordered by date.

async function checkYoutubeChannel(client, redis, EmbedBuilder, ytChannelId, targetChannelId, pingRoleId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return; // silently skip — handled by one-time warning at startup

  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: apiKey,
        channelId: ytChannelId,
        part: 'snippet',
        order: 'date',
        maxResults: 1,
        type: 'video',
      },
    });

    const item = res.data.items?.[0];
    if (!item) return;

    const videoId = item.id.videoId;
    const lastSeen = await getLastSeen(redis, 'youtube', ytChannelId);

    // First run for this channel — store baseline, don't announce old content
    if (lastSeen === null) {
      await setLastSeen(redis, 'youtube', ytChannelId, videoId);
      return;
    }

    if (lastSeen === videoId) return; // nothing new

    await setLastSeen(redis, 'youtube', ytChannelId, videoId);

    const { title, channelTitle, thumbnails, publishedAt } = item.snippet;
    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setAuthor({ name: `${channelTitle} just posted a new video!` })
      .setTitle(title)
      .setURL(`https://youtube.com/watch?v=${videoId}`)
      .setImage(thumbnails?.high?.url || thumbnails?.default?.url)
      .setFooter({ text: 'JARVIS • YouTube Notifications' })
      .setTimestamp(new Date(publishedAt));

    await sendAnnouncement(client, targetChannelId, pingRoleId, embed);
  } catch (err) {
    console.error(`[SocialNotify] YouTube check failed for ${ytChannelId}:`, err?.response?.data?.error?.message || err.message);
  }
}

// =========================
// TWITCH
// =========================
// Requires TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET (app access token flow).
// If not configured, Twitch checks are skipped entirely (logged once).

let twitchToken = null;
let twitchTokenExpiry = 0;
let twitchWarned = false;

async function getTwitchToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    if (!twitchWarned) {
      console.warn('[SocialNotify] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set — Twitch notifications disabled.');
      twitchWarned = true;
    }
    return null;
  }

  if (twitchToken && Date.now() < twitchTokenExpiry) return twitchToken;

  try {
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      },
    });
    twitchToken = res.data.access_token;
    // refresh a bit early to avoid edge-of-expiry failures
    twitchTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return twitchToken;
  } catch (err) {
    console.error('[SocialNotify] Failed to get Twitch token:', err?.response?.data || err.message);
    return null;
  }
}

async function checkTwitchStreamer(client, redis, EmbedBuilder, username, targetChannelId, pingRoleId) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = await getTwitchToken();
  if (!token || !clientId) return;

  try {
    const res = await axios.get('https://api.twitch.tv/helix/streams', {
      params: { user_login: username },
      headers: {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
      },
    });

    const stream = res.data.data?.[0];
    const lastSeen = await getLastSeen(redis, 'twitch', username);

    if (!stream) {
      // Not live — clear "currently live" marker so next time they go live we announce again
      if (lastSeen && lastSeen !== 'offline') {
        await setLastSeen(redis, 'twitch', username, 'offline');
      }
      return;
    }

    // Already announced this specific stream session
    if (lastSeen === stream.id) return;

    await setLastSeen(redis, 'twitch', username, stream.id);

    const thumbnailUrl = (stream.thumbnail_url || '')
      .replace('{width}', '1280')
      .replace('{height}', '720');

    const embed = new EmbedBuilder()
      .setColor(0x9146ff)
      .setAuthor({ name: `${stream.user_name} is now live on Twitch!` })
      .setTitle(stream.title || 'Untitled stream')
      .setURL(`https://twitch.tv/${username}`)
      .addFields(
        { name: '🎮 Game', value: stream.game_name || 'Unknown', inline: true },
        { name: '👀 Viewers', value: `${stream.viewer_count ?? 0}`, inline: true }
      )
      .setImage(thumbnailUrl ? `${thumbnailUrl}?t=${Date.now()}` : null)
      .setFooter({ text: 'JARVIS • Twitch Notifications' })
      .setTimestamp();

    await sendAnnouncement(client, targetChannelId, pingRoleId, embed);
  } catch (err) {
    console.error(`[SocialNotify] Twitch check failed for ${username}:`, err?.response?.data || err.message);
  }
}

// =========================
// TIKTOK
// =========================
// TikTok has no official free public API for "latest video by username".
// This does a best-effort fetch of the public profile page and pulls the
// most recent video ID out of the embedded page data. TikTok changes its
// page structure often, so this is the least reliable of the three checks
// and may silently stop working if TikTok changes their site — that's a
// TikTok-side limitation, not a bug in the bot's logic.

let tiktokWarned = false;

async function checkTiktokAccount(client, redis, EmbedBuilder, username, targetChannelId, pingRoleId) {
  try {
    const res = await axios.get(`https://www.tiktok.com/@${username}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      },
      timeout: 10000,
    });

    const html = res.data;
    const match = html.match(/"webapp\.video-detail"[\s\S]*?"id":"(\d+)"/) ||
      html.match(/\/video\/(\d+)/);

    if (!match) {
      if (!tiktokWarned) {
        console.warn(`[SocialNotify] Could not parse TikTok page for @${username} — TikTok may have changed their page structure.`);
        tiktokWarned = true;
      }
      return;
    }

    const videoId = match[1];
    const lastSeen = await getLastSeen(redis, 'tiktok', username);

    if (lastSeen === null) {
      await setLastSeen(redis, 'tiktok', username, videoId);
      return;
    }

    if (lastSeen === videoId) return;

    await setLastSeen(redis, 'tiktok', username, videoId);

    const embed = new EmbedBuilder()
      .setColor(0x000000)
      .setAuthor({ name: `@${username} just posted a new TikTok!` })
      .setDescription(`🎬 New video from **@${username}**`)
      .setURL(`https://www.tiktok.com/@${username}/video/${videoId}`)
      .setFooter({ text: 'JARVIS • TikTok Notifications' })
      .setTimestamp();

    await sendAnnouncement(client, targetChannelId, pingRoleId, embed);
  } catch (err) {
    console.error(`[SocialNotify] TikTok check failed for @${username}:`, err.message);
  }
}

// =========================
// MAIN POLL LOOP
// =========================

async function pollAll(client, redis, getDashboardConfig, EmbedBuilder) {
  const dashboardConfig = getDashboardConfig();
  const allConfigs = dashboardConfig.socialNotifications || {};

  for (const guildId of Object.keys(allConfigs)) {
    const gc = allConfigs[guildId];
    if (!gc) continue;

    // YouTube
    if (gc.youtube?.channels?.length && gc.youtube.channelId) {
      for (const ytChannelId of gc.youtube.channels) {
        await checkYoutubeChannel(client, redis, EmbedBuilder, ytChannelId, gc.youtube.channelId, gc.youtube.pingRoleId);
      }
    }

    // Twitch
    if (gc.twitch?.streamers?.length && gc.twitch.channelId) {
      for (const username of gc.twitch.streamers) {
        await checkTwitchStreamer(client, redis, EmbedBuilder, username, gc.twitch.channelId, gc.twitch.pingRoleId);
      }
    }

    // TikTok
    if (gc.tiktok?.accounts?.length && gc.tiktok.channelId) {
      for (const username of gc.tiktok.accounts) {
        await checkTiktokAccount(client, redis, EmbedBuilder, username, gc.tiktok.channelId, gc.tiktok.pingRoleId);
      }
    }
  }
}

// =========================
// PUBLIC ENTRY POINT
// =========================

/**
 * Starts the social notification polling loop.
 *
 * @param {Client} client - the Discord.js client
 * @param {Redis} redis - the Upstash Redis client instance
 * @param {Function} getDashboardConfig - function returning the live dashboardConfig object
 * @param {EmbedBuilder} EmbedBuilder - discord.js EmbedBuilder class
 */
function initSocialNotifications(client, redis, getDashboardConfig, EmbedBuilder) {
  console.log(`✅ Social notifications initialized (checking every ${CHECK_INTERVAL_MS / 60000} min)`);

  // Run once shortly after startup, then on the regular interval.
  setTimeout(() => {
    pollAll(client, redis, getDashboardConfig, EmbedBuilder).catch(err =>
      console.error('[SocialNotify] Initial poll failed:', err.message)
    );
  }, 15_000);

  setInterval(() => {
    pollAll(client, redis, getDashboardConfig, EmbedBuilder).catch(err =>
      console.error('[SocialNotify] Poll loop failed:', err.message)
    );
  }, CHECK_INTERVAL_MS);
}

module.exports = { initSocialNotifications };