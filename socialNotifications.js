// =========================================================
// JARVIS SOCIAL NOTIFICATIONS MODULE — YouTube + Twitch
// =========================================================
// Rebuilt module. The original file was accidentally overwritten with no
// backup, so this is a fresh implementation built to match the exact
// contract your index.js already expects:
//
//   const { initSocialNotifications } = require('./socialNotifications');
//   initSocialNotifications(client, redis, () => dashboardConfig, EmbedBuilder);
//
// Config shape read from dashboardConfig (matches your /setnotify commands):
//   dashboardConfig.socialNotifications[guildId] = {
//     youtube: { channels: [ucId, ...], channelId, pingRoleId },
//     twitch:  { streamers: [username, ...], channelId, pingRoleId },
//   }
//
// TikTok support was intentionally dropped — it was already failing
// ("[SocialNotify] Could not parse TikTok page...") since TikTok has no
// public API and scraping their page breaks whenever they change markup.
//
// Required env vars:
//   YOUTUBE_API_KEY        (you already have this — same one /youtube uses)
//   TWITCH_CLIENT_ID
//   TWITCH_CLIENT_SECRET
// =========================================================

const axios = require('axios');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes, matches your original log line

// Redis keys used to remember "last seen" so we don't post duplicate alerts:
//   social-lastvideo-<youtubeChannelId>   -> last posted video ID
//   social-livestate-<twitchUsername>     -> 'live' | 'offline' (last known state)
const YT_LASTVIDEO_PREFIX = 'social-lastvideo-';
const TWITCH_LIVESTATE_PREFIX = 'social-livestate-';

let twitchTokenCache = { token: null, expiresAt: 0 };

// ---------------------------------------------------------
// TWITCH AUTH (app access token, client-credentials flow)
// ---------------------------------------------------------
async function getTwitchToken() {
  if (twitchTokenCache.token && Date.now() < twitchTokenCache.expiresAt - 60_000) {
    return twitchTokenCache.token;
  }
  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials',
    },
  });
  twitchTokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + res.data.expires_in * 1000,
  };
  return twitchTokenCache.token;
}

async function twitchApi(endpoint, params) {
  const token = await getTwitchToken();
  const res = await axios.get(`https://api.twitch.tv/helix/${endpoint}`, {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
    params,
  });
  return res.data;
}

// ---------------------------------------------------------
// YOUTUBE CHECK — new upload detection
// ---------------------------------------------------------
async function checkYoutubeChannel(redis, ucChannelId) {
  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: process.env.YOUTUBE_API_KEY,
        channelId: ucChannelId,
        part: 'snippet',
        order: 'date',
        maxResults: 1,
        type: 'video',
      },
    });
    const latest = res.data.items?.[0];
    if (!latest) return null;

    const videoId = latest.id.videoId;
    const lastSeenKey = `${YT_LASTVIDEO_PREFIX}${ucChannelId}`;
    const lastSeen = await redis.get(lastSeenKey);

    if (lastSeen === videoId) return null; // already posted this one

    await redis.set(lastSeenKey, videoId);
    if (!lastSeen) return null; // first-ever check for this channel — don't blast an alert for old content, just establish baseline

    return {
      videoId,
      title: latest.snippet.title,
      channelTitle: latest.snippet.channelTitle,
      thumbnail: latest.snippet.thumbnails?.high?.url,
      url: `https://youtube.com/watch?v=${videoId}`,
    };
  } catch (err) {
    console.error(`[SocialNotify] YouTube check failed for ${ucChannelId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------
// TWITCH CHECK — went-live detection
// ---------------------------------------------------------
async function checkTwitchStreamer(redis, username) {
  try {
    const data = await twitchApi('streams', { user_login: username });
    const stream = data.data?.[0];
    const stateKey = `${TWITCH_LIVESTATE_PREFIX}${username}`;
    const lastState = await redis.get(stateKey);
    const isLiveNow = !!stream;

    await redis.set(stateKey, isLiveNow ? 'live' : 'offline');

    if (isLiveNow && lastState !== 'live') {
      return {
        title: stream.title,
        game: stream.game_name,
        viewerCount: stream.viewer_count,
        thumbnail: stream.thumbnail_url?.replace('{width}', '640').replace('{height}', '360'),
        url: `https://twitch.tv/${username}`,
      };
    }
    return null;
  } catch (err) {
    console.error(`[SocialNotify] Twitch check failed for ${username}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------
// MAIN POLL LOOP
// ---------------------------------------------------------
async function pollAll(client, redis, getDashboardConfig, EmbedBuilder) {
  const cfg = getDashboardConfig();
  const allGuildConfigs = cfg.socialNotifications || {};

  for (const [guildId, guildCfg] of Object.entries(allGuildConfigs)) {
    // ── YouTube ──
    const yt = guildCfg.youtube;
    if (yt?.channels?.length && yt.channelId) {
      for (const ucId of yt.channels) {
        const result = await checkYoutubeChannel(redis, ucId);
        if (!result) continue;
        try {
          const channel = await client.channels.fetch(yt.channelId);
          const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle(result.title)
            .setURL(result.url)
            .setAuthor({ name: result.channelTitle })
            .setThumbnail(result.thumbnail)
            .setDescription('🔴 New video just dropped!')
            .setFooter({ text: 'JARVIS • YouTube Alerts' })
            .setTimestamp();
          const ping = yt.pingRoleId ? `<@&${yt.pingRoleId}> ` : '';
          await channel.send({ content: `${ping}📺 New upload from **${result.channelTitle}**!`, embeds: [embed] });
        } catch (err) {
          console.error(`[SocialNotify] Failed to post YouTube alert for guild ${guildId}:`, err.message);
        }
      }
    }

    // ── Twitch ──
    const tw = guildCfg.twitch;
    if (tw?.streamers?.length && tw.channelId) {
      for (const username of tw.streamers) {
        const result = await checkTwitchStreamer(redis, username);
        if (!result) continue;
        try {
          const channel = await client.channels.fetch(tw.channelId);
          const embed = new EmbedBuilder()
            .setColor(0x9146ff)
            .setTitle(result.title || `${username} is live!`)
            .setURL(result.url)
            .setImage(result.thumbnail)
            .addFields(
              { name: '🎮 Game', value: result.game || 'N/A', inline: true },
              { name: '👀 Viewers', value: `${result.viewerCount}`, inline: true }
            )
            .setFooter({ text: 'JARVIS • Twitch Alerts' })
            .setTimestamp();
          const ping = tw.pingRoleId ? `<@&${tw.pingRoleId}> ` : '';
          await channel.send({ content: `${ping}🟣 **${username}** just went live on Twitch!`, embeds: [embed] });
        } catch (err) {
          console.error(`[SocialNotify] Failed to post Twitch alert for guild ${guildId}:`, err.message);
        }
      }
    }
  }
}

// ---------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------
function initSocialNotifications(client, redis, getDashboardConfig, EmbedBuilder) {
  if (!process.env.YOUTUBE_API_KEY) {
    console.warn('[SocialNotify] YOUTUBE_API_KEY not set — YouTube checks will fail.');
  }
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.warn('[SocialNotify] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set — Twitch checks will fail.');
  }

  // Run once shortly after boot, then on a fixed interval
  setTimeout(() => {
    pollAll(client, redis, getDashboardConfig, EmbedBuilder).catch((err) =>
      console.error('[SocialNotify] poll error:', err.message)
    );
  }, 10_000);

  setInterval(() => {
    pollAll(client, redis, getDashboardConfig, EmbedBuilder).catch((err) =>
      console.error('[SocialNotify] poll error:', err.message)
    );
  }, POLL_INTERVAL_MS);

  console.log(`✅ Social notifications initialized (checking every ${POLL_INTERVAL_MS / 60000} min)`);
}

module.exports = { initSocialNotifications };