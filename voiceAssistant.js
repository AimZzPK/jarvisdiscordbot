// =========================================================
// JARVIS VOICE ASSISTANT MODULE
// =========================================================
// 24/7 always-listening voice chat: VC audio -> Groq Whisper (STT)
// -> Groq LLM (reuses your existing personality) -> Piper TTS -> VC playback
//
// Drop this file next to your main bot file and require/init it from there.
// See INTEGRATION NOTES at the bottom of this file for the 3 edits
// you need to make in your main file.
// =========================================================

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  EndBehaviorType,
  getVoiceConnection,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

// =========================
// CONFIG / TUNABLES
// =========================
const SILENCE_DEBOUNCE_MS = 900;     // how long someone must be silent before we treat their utterance as "done"
const MIN_AUDIO_MS = 350;            // ignore blips shorter than this (coughs, clicks)
const MAX_UTTERANCE_MS = 30_000;     // hard cap per utterance so one person can't hog the pipeline
const RECONNECT_DELAY_MS = 5000;
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH || '/app/piper/en_US-lessac-medium.onnx';
const PIPER_BIN_PATH = process.env.PIPER_BIN_PATH || '/app/piper/piper';

// Per-guild state
// guildId -> { connection, player, channelId, busy: bool, lastSpeakerLock: userId|null }
const voiceSessions = new Map();

// Per-user-per-guild audio capture state while they are actively speaking
// key = `${guildId}-${userId}` -> { chunks: Buffer[], startedAt, silenceTimer }
const activeCaptures = new Map();

// =========================
// PIPER TTS (free, local, neural)
// =========================
// Piper reads text on stdin and writes raw 16-bit PCM (or wav) audio on stdout
// depending on flags. We use --output_raw for a simple raw PCM pipe straight
// into an Opus/PCM audio resource, no temp files needed.
function piperSpeak(text) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PIPER_BIN_PATH)) {
      return reject(new Error(`Piper binary not found at ${PIPER_BIN_PATH}. See setup notes.`));
    }
    const proc = spawn(PIPER_BIN_PATH, [
      '--model', PIPER_MODEL_PATH,
      '--output_raw',
    ]);

    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', () => {}); // piper logs model load info to stderr, ignore
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && chunks.length === 0) {
        return reject(new Error(`Piper exited with code ${code} and produced no audio`));
      }
      resolve(Buffer.concat(chunks));
    });

    proc.stdin.write(text);
    proc.stdin.end();
  });
}

// Piper's --output_raw emits 22050Hz, 16-bit, mono PCM by default for most voices.
// Discord voice wants 48000Hz stereo Opus via createAudioResource, which will
// transcode for us as long as we tell it the input format correctly.
function pcmBufferToResource(pcmBuffer, inputSampleRate = 22050) {
  const stream = new PassThrough();
  stream.end(pcmBuffer);
  return createAudioResource(stream, {
    inputType: StreamType.Raw,
    inlineVolume: false,
    metadata: { sampleRate: inputSampleRate },
  });
}

// NOTE: discordjs/voice's Raw StreamType expects 48000Hz stereo 16-bit PCM.
// Piper outputs 22050Hz mono. We need to resample. Easiest no-extra-binary
// approach: use ffmpeg (you already depend on @ffmpeg-installer/ffmpeg).
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

function resamplePcmWithFfmpeg(pcmBuffer, inRate = 22050) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-f', 's16le', '-ar', String(inRate), '-ac', '1', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      'pipe:1',
    ]);
    const out = [];
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', () => {});
    proc.on('error', reject);
    proc.on('close', () => resolve(Buffer.concat(out)));
    proc.stdin.write(pcmBuffer);
    proc.stdin.end();
  });
}

async function speakInVoice(session, text) {
  if (!text || !text.trim()) return;
  try {
    const t0 = Date.now();
    const rawPcm = await piperSpeak(text);
    const t1 = Date.now();
    const resampled = await resamplePcmWithFfmpeg(rawPcm, 22050);
    const t2 = Date.now();
    const resource = pcmBufferToResource(resampled, 48000);
    session.player.play(resource);
    await entersState(session.player, AudioPlayerStatus.Playing, 5000).catch(() => {});
    const t3 = Date.now();
    console.log(`[Voice TIMING] piper=${t1 - t0}ms ffmpeg_resample=${t2 - t1}ms play_start=${t3 - t2}ms`);
    await new Promise((resolve) => {
      session.player.once(AudioPlayerStatus.Idle, resolve);
    });
  } catch (err) {
    console.error('[Voice TTS] failed:', err.message);
  }
}

// =========================
// GROQ WHISPER STT
// =========================
async function transcribeWithGroq(groq, pcmBuffer) {
  // Wrap raw PCM (48000Hz mono after our downmix below) into a minimal WAV
  // header so Whisper's API can read it without needing ffmpeg round-trip.
  const wavBuffer = pcmToWav(pcmBuffer, 48000, 1, 16);
  const tmpPath = path.join(os.tmpdir(), `jarvis-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  fs.writeFileSync(tmpPath, wavBuffer);
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-large-v3-turbo',
      response_format: 'text',
      language: 'en',
    });
    return (typeof transcription === 'string' ? transcription : transcription.text || '').trim();
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

function pcmToWav(pcmData, sampleRate, channels, bitDepth) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);
  return Buffer.concat([header, pcmData]);
}

// =========================
// CORE: subscribe to a user's audio in VC
// =========================
function listenToUser(session, userId, receiver, deps) {
  const { groq, getReplyForVoice, guildId } = deps;
  const capKey = `${guildId}-${userId}`;

  // Already capturing this user — discordjs/voice fires speaking start once
  // per "speaking session", so this guards against double-subscription.
  if (activeCaptures.has(capKey)) return;

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual }, // we manage end ourselves via silence debounce
  });
  const pcmStream = opusStream.pipe(new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }));

  const capture = { chunks: [], startedAt: Date.now(), silenceTimer: null, opusStream, pcmStream };
  activeCaptures.set(capKey, capture);

  const hardStopTimer = setTimeout(() => finalizeCapture(capKey, deps), MAX_UTTERANCE_MS);

  pcmStream.on('data', (chunk) => {
    capture.chunks.push(chunk);
    if (capture.silenceTimer) clearTimeout(capture.silenceTimer);
    capture.silenceTimer = setTimeout(() => {
      clearTimeout(hardStopTimer);
      finalizeCapture(capKey, deps);
    }, SILENCE_DEBOUNCE_MS);
  });

  pcmStream.on('error', () => cleanupCapture(capKey));
  opusStream.on('error', () => cleanupCapture(capKey));
}

function cleanupCapture(capKey) {
  const capture = activeCaptures.get(capKey);
  if (!capture) return;
  if (capture.silenceTimer) clearTimeout(capture.silenceTimer);
  try { capture.opusStream.destroy(); } catch {}
  try { capture.pcmStream.destroy(); } catch {}
  activeCaptures.delete(capKey);
}

async function finalizeCapture(capKey, deps) {
  const capture = activeCaptures.get(capKey);
  if (!capture) return;
  cleanupCapture(capKey);

  const durationMs = Date.now() - capture.startedAt;
  if (durationMs < MIN_AUDIO_MS || capture.chunks.length === 0) return;

  const [guildId, userId] = capKey.split('-');
  const session = voiceSessions.get(guildId);
  if (!session) return;

  // "Only respond to most recent speaker, drop overlaps" —
  // claim the lock for this utterance; if someone else's finalize beats us
  // to it while we're transcribing, we just let this run anyway since the
  // lock here is about *not starting a reply while one is already playing*,
  // not about dropping audio capture itself.
  const pcmBuffer = Buffer.concat(capture.chunks);

  try {
    const { groq, getReplyForVoice } = deps;
    const tCaptureEnd = Date.now();
    const transcript = await transcribeWithGroq(groq, pcmBuffer);
    const tSttDone = Date.now();
    if (!transcript || transcript.length < 2) return;

    console.log(`[Voice] ${userId} said: "${transcript}"`);
    console.log(`[Voice TIMING] stt=${tSttDone - tCaptureEnd}ms (audio_ms=${durationMs})`);

    // Drop overlap: if JARVIS is currently speaking/processing, skip this
    // utterance entirely rather than queueing it.
    if (session.busy) {
      console.log('[Voice] busy — dropping overlapping utterance');
      return;
    }
    session.busy = true;
    session.lastSpeakerLock = userId;

    try {
      const tLlmStart = Date.now();
      const replyText = await getReplyForVoice({ guildId, userId, transcript });
      const tLlmDone = Date.now();
      console.log(`[Voice TIMING] llm=${tLlmDone - tLlmStart}ms total_before_tts=${tLlmDone - tCaptureEnd}ms`);
      if (replyText) await speakInVoice(session, replyText);
    } finally {
      session.busy = false;
      session.lastSpeakerLock = null;
    }
  } catch (err) {
    console.error('[Voice] pipeline error:', err.message);
    session.busy = false;
  }
}

// =========================
// PUBLIC API
// =========================

/**
 * Join (or move to) a voice channel and start always-listening mode.
 * Call this on bot ready for every guild with a configured voice channel,
 * and from the /setvoicechannel command handler.
 */
async function joinAndListen(client, guild, channelId, deps) {
  const existing = voiceSessions.get(guild.id);
  if (existing && existing.channelId === channelId && existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    return existing; // already connected to the right channel
  }
  if (existing) {
    try { existing.connection.destroy(); } catch {}
    voiceSessions.delete(guild.id);
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // must hear users to transcribe them
    selfMute: false,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);

  const session = { connection, player, channelId, busy: false, lastSpeakerLock: null };
  voiceSessions.set(guild.id, session);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      // real disconnect (kicked, channel deleted, etc.) — try a clean rejoin
      console.warn(`[Voice] lost connection in guild ${guild.id}, retrying in ${RECONNECT_DELAY_MS}ms`);
      voiceSessions.delete(guild.id);
      setTimeout(() => {
        joinAndListen(client, guild, channelId, deps).catch((e) =>
          console.error('[Voice] reconnect failed:', e.message)
        );
      }, RECONNECT_DELAY_MS);
    }
  });

  // Subscribe to every current + future speaker in the channel
  const receiver = connection.receiver;
  receiver.speaking.on('start', (userId) => {
    // ignore the bot itself and anyone already being captured
    if (userId === client.user.id) return;
    listenToUser(session, userId, receiver, { ...deps, guildId: guild.id });
  });

  console.log(`[Voice] joined channel ${channelId} in guild ${guild.id} — always-listening active`);
  return session;
}

function leaveVoice(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session) return false;
  try { session.connection.destroy(); } catch {}
  voiceSessions.delete(guildId);
  // clean any in-flight captures for this guild
  for (const key of activeCaptures.keys()) {
    if (key.startsWith(`${guildId}-`)) cleanupCapture(key);
  }
  return true;
}

/**
 * Call this once after client login + dashboardConfig load to auto-join
 * every guild that has a voiceChannels[guildId] configured (true 24/7).
 */
async function initVoiceAssistant(client, getDashboardConfig, deps) {
  const cfg = getDashboardConfig();
  const voiceChannels = cfg.voiceChannels || {};
  for (const [guildId, channelId] of Object.entries(voiceChannels)) {
    try {
      const guild = await client.guilds.fetch(guildId);
      await joinAndListen(client, guild, channelId, deps);
    } catch (err) {
      console.error(`[Voice] failed to auto-join guild ${guildId}:`, err.message);
    }
  }
}

module.exports = {
  joinAndListen,
  leaveVoice,
  initVoiceAssistant,
  voiceSessions,
};

// =========================================================
// INTEGRATION NOTES — edits needed in your main bot file
// =========================================================
//
// 1) At the top of your main file:
//
//    const { joinAndListen, leaveVoice, initVoiceAssistant } = require('./voiceAssistant');
//
// 2) Add a slash command (next to your other dashboardConfig-driven ones):
//
//    new SlashCommandBuilder()
//      .setName('setvoicechannel')
//      .setDescription('Set the voice channel JARVIS joins 24/7 and listens in')
//      .addChannelOption(o => o.setName('channel').setDescription('Voice channel').setRequired(true).addChannelTypes(2))
//      .setDMPermission(false),
//    new SlashCommandBuilder()
//      .setName('leavevoice')
//      .setDescription('Make JARVIS leave the voice channel')
//      .setDMPermission(false),
//
//    Handler:
//
//    if (interaction.commandName === 'setvoicechannel') {
//      if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
//      if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need Manage Server permission.', flags: 64 });
//      const channel = interaction.options.getChannel('channel');
//      dashboardConfig.voiceChannels = dashboardConfig.voiceChannels || {};
//      dashboardConfig.voiceChannels[interaction.guild.id] = channel.id;
//      await saveDashboardConfig(dashboardConfig);
//      await joinAndListen(client, interaction.guild, channel.id, voiceDeps);
//      return interaction.reply(`✅ JARVIS will now stay in <#${channel.id}> 24/7 and listen for voice chat.`);
//    }
//
//    if (interaction.commandName === 'leavevoice') {
//      if (!interaction.guild) return interaction.reply({ content: '❌ Server only', flags: 64 });
//      if (!interaction.member.permissions.has('ManageGuild')) return interaction.reply({ content: '❌ You need Manage Server permission.', flags: 64 });
//      delete dashboardConfig.voiceChannels?.[interaction.guild.id];
//      await saveDashboardConfig(dashboardConfig);
//      leaveVoice(interaction.guild.id);
//      return interaction.reply('👋 Left the voice channel.');
//    }
//
// 3) In your clientReady handler, after loadDashboardConfig():
//
//    const voiceDeps = {
//      groq, // your existing groq client (works fine for Whisper too — same OpenAI-compatible client)
//      getReplyForVoice: async ({ guildId, userId, transcript }) => {
//        // Reuse your existing personality/mode system. Kept deliberately
//        // simple — swap in your `system` prompt builder from messageCreate
//        // if you want VC replies to share memory/modes with text chat.
//        const activeMode = getActiveMode(guildId);
//        const modeData = MODES[activeMode];
//        const res = await groq.chat.completions.create({
//          model: 'llama-3.1-8b-instant',
//          messages: [
//            { role: 'system', content: `You are JARVIS speaking out loud in a Discord voice channel. ${modeData.prompt} Keep replies SHORT — 1-2 sentences, since this gets read aloud via TTS. No emojis, no markdown, no asterisks — plain spoken text only.` },
//            { role: 'user', content: transcript },
//          ],
//          temperature: 0.85,
//          max_tokens: 120,
//        });
//        return res.choices[0].message.content;
//      },
//    };
//
//    await initVoiceAssistant(client, () => dashboardConfig, voiceDeps);
//
// =========================================================
// REQUIRED DEPLOYMENT SETUP (Railway, Dockerfile-based service)
// =========================================================
//
// Railway needs to build a container that has Piper installed. Use a
// Dockerfile (not pure Nixpacks) so you can fetch the Piper binary + model:
//
//   FROM node:20-bookworm-slim
//   RUN apt-get update && apt-get install -y wget tar ca-certificates && rm -rf /var/lib/apt/lists/*
//   WORKDIR /app
//   # Piper binary (Linux x64) — check https://github.com/rhasspy/piper/releases for latest
//   RUN wget -q https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz \
//       && tar -xzf piper_linux_x86_64.tar.gz -C /app \
//       && mv /app/piper /app/piper-bin \
//       && mkdir -p /app/piper && mv /app/piper-bin/* /app/piper/ \
//       && rm piper_linux_x86_64.tar.gz
//   # A voice model — lessac-medium is a good free default
//   RUN wget -q -O /app/piper/en_US-lessac-medium.onnx \
//       https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
//       && wget -q -O /app/piper/en_US-lessac-medium.onnx.json \
//       https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
//   COPY package*.json ./
//   RUN npm install --production
//   COPY . .
//   CMD ["node", "index.js"]
//
// Set Railway's builder to "Dockerfile" in service settings.
// Env vars needed: PIPER_BIN_PATH=/app/piper/piper, PIPER_MODEL_PATH=/app/piper/en_US-lessac-medium.onnx
// (the module already defaults to these paths, so you may not need to set them at all)
//
// npm packages to add: prism-media, @discordjs/voice, @ffmpeg-installer/ffmpeg
// (you already have these in your main file's requires — just confirm they're in package.json)
//
// Also required at the OS level inside the container: libopus (for prism-media's
// opus decoding) and ffmpeg (already covered via @ffmpeg-installer/ffmpeg).
// libopus usually needs: apt-get install -y libopus0 libopus-dev — add that to
// the Dockerfile's apt-get install line above if you hit Opus decode errors.
// =========================================================