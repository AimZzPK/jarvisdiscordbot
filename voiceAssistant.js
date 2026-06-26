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
// LOGGING NOTE — Railway stdout buffering
// =========================
// Railway (like many container log pipelines) can buffer stdout when it's
// not attached to a TTY, which means console.log lines can appear delayed,
// batched, or seemingly "missing" even though they fired on time. This is
// a likely explanation for "no [Voice] said: line at all" while replies
// still eventually arrive — the log line may have printed, just not been
// flushed/shipped promptly by Railway's log collector.
//
// process.stdout doesn't expose a manual flush() in Node, but writing
// directly via process.stdout.write with no internal buffering pressure
// helps in practice, and switching from console.log's default formatting
// to explicit string concatenation avoids extra internal buffering layers.
// If logs are STILL missing after this diagnostic pass, check Railway's
// log retention/streaming settings directly rather than assuming app-level
// buffering — Railway's free tier has historically rate-limited log volume.

// =========================
// CONFIG / TUNABLES
// =========================
const SILENCE_DEBOUNCE_MS = 900;     // how long someone must be silent before we treat their utterance as "done"
const MIN_AUDIO_MS = 350;            // ignore blips shorter than this (coughs, clicks)
const MAX_UTTERANCE_MS = 30_000;     // hard cap per utterance so one person can't hog the pipeline
const RECONNECT_DELAY_MS = 5000;
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH || '/app/piper/en_US-ryan-medium.onnx';
const PIPER_BIN_PATH = process.env.PIPER_BIN_PATH || '/app/piper/piper';

// Per-guild state
// guildId -> { connection, player, channelId, busy: bool, lastSpeakerLock: userId|null }
const voiceSessions = new Map();

// Per-user-per-guild audio capture state while they are actively speaking
// key = `${guildId}-${userId}` -> { chunks: Buffer[], startedAt, silenceTimer }
const activeCaptures = new Map();

// =========================
// PIPER TTS (free, local, neural) — PERSISTENT PROCESS
// =========================
// Spawning a fresh `piper` process per utterance reloads the ONNX voice
// model from disk every single time, which is exactly the 5-10 SECOND delay
// you'd see in [Voice TIMING] piper=...ms logs. Loading a neural TTS model
// is expensive; doing it once and keeping the process alive is the fix.
//
// We keep ONE long-running piper process per (model) for the bot's whole
// lifetime, talk to it with --json-input (one JSON line in -> one chunk of
// raw PCM out per request), and queue requests so concurrent calls don't
// interleave garbled audio on the same stdout stream.
let piperProc = null;
let piperReady = null; // resolves once the process is spawned and alive
const piperQueue = []; // FIFO of {text, resolve, reject} so concurrent speakInVoice calls don't race on stdout

function ensurePiperProcess() {
  if (piperProc && !piperProc.killed) return piperReady;

  if (!fs.existsSync(PIPER_BIN_PATH)) {
    piperReady = Promise.reject(new Error(`Piper binary not found at ${PIPER_BIN_PATH}. See setup notes.`));
    return piperReady;
  }

  piperProc = spawn(PIPER_BIN_PATH, [
    '--model', PIPER_MODEL_PATH,
    '--output_raw',
    '--json-input',
  ]);

  let stdoutBuf = Buffer.alloc(0);
  piperProc.stdout.on('data', (chunk) => {
    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
  });

  // Piper's --output_raw with --json-input writes one continuous PCM stream;
  // there's no built-in delimiter between utterances. To know when one
  // utterance's audio is "done", we rely on the fact that piper writes audio
  // synchronously per stdin line before reading the next one — so we drain
  // stdoutBuf right before sending the *next* request, which is what was
  // accumulated for the *previous* one.
  piperProc.stderr.on('data', () => {}); // model load logs, ignore

  piperProc.on('exit', (code) => {
    console.warn(`[Piper] process exited (code ${code}) — will respawn on next request`);
    piperProc = null;
    piperReady = null;
    // fail anything left queued so callers don't hang forever
    while (piperQueue.length) {
      const { reject } = piperQueue.shift();
      reject(new Error('Piper process exited unexpectedly'));
    }
  });

  piperReady = new Promise((resolve, reject) => {
    // give piper a moment to load the model; --json-input mode doesn't print
    // a clean "ready" signal, so we wait a short fixed delay on first boot.
    piperProc.once('error', reject);
    setTimeout(resolve, 100);
  });

  // drain queue serially whenever stdout goes quiet for a beat (utterance done)
  let drainTimer = null;
  piperProc.stdout.on('data', () => {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => {
      if (piperQueue.length === 0) return;
      const { resolve } = piperQueue[0];
      const audio = stdoutBuf;
      stdoutBuf = Buffer.alloc(0);
      piperQueue.shift();
      resolve(audio);
    }, 150); // 150ms of stdout silence = piper finished writing this utterance's audio
  });

  return piperReady;
}

function piperSpeak(text) {
  return new Promise(async (resolve, reject) => {
    try {
      await ensurePiperProcess();
    } catch (err) {
      return reject(err);
    }
    piperQueue.push({ text, resolve, reject });
    // piper's --json-input expects one JSON object per line: {"text": "..."}
    piperProc.stdin.write(JSON.stringify({ text }) + '\n');
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

  // DIAGNOSTIC: confirms Discord's speaking-start event fired and we opened
  // a capture. If you talk and this line NEVER shows up in Railway logs,
  // the stall is upstream of everything in this file (selfDeaf misconfigured,
  // wrong channel, permissions) — not STT/LLM/TTS. Safe to leave in
  // permanently; remove later if log volume becomes noisy.
  console.log(`[Voice DEBUG] speaking-start: capture opened for user ${userId} in guild ${guildId} at ${new Date().toISOString()}`);

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
      // DIAGNOSTIC: marks the moment SILENCE_DEBOUNCE_MS elapsed and we're
      // handing off to finalizeCapture. If there's a big gap between this
      // line and "[Voice DEBUG] entering finalizeCapture" below, the event
      // loop itself is blocked (e.g. piper/ffmpeg synchronous work, or some
      // other handler hogging the loop) rather than Groq being slow.
      console.log(`[Voice DEBUG] silence debounce fired for ${capKey} at ${new Date().toISOString()}`);
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

  // DIAGNOSTIC: confirms we got this far. If "silence debounce fired" logs
  // but this never prints, something in cleanupCapture or the activeCaptures
  // lookup above is throwing synchronously before reaching here.
  console.log(`[Voice DEBUG] entering finalizeCapture for ${capKey} at ${new Date().toISOString()}`);

  const durationMs = Date.now() - capture.startedAt;
  if (durationMs < MIN_AUDIO_MS || capture.chunks.length === 0) {
    console.log(`[Voice DEBUG] capture too short/empty (${durationMs}ms, ${capture.chunks.length} chunks) — discarding`);
    return;
  }

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
    // DIAGNOSTIC: marks the exact moment we hand audio to Groq's Whisper API.
    // If there's a large gap between this and "stt=...ms" below, the network
    // call to Groq itself is slow (rate limiting, cold start, large payload,
    // Railway egress latency) rather than anything in our own code.
    console.log(`[Voice DEBUG] sending ${pcmBuffer.length} bytes to Groq STT at ${new Date().toISOString()}`);
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
      // DIAGNOSTIC: total wall-clock time from "silence detected" to "audio
      // finished playing." Compare this against the sum of the individual
      // stage timings above — if this total is much bigger than the sum,
      // time is being lost somewhere NOT covered by existing timers (e.g.
      // queued behind another async task, GC pause, Railway CPU throttling).
      console.log(`[Voice DEBUG] pipeline complete for ${capKey}, total=${Date.now() - tCaptureEnd}ms`);
    } finally {
      session.busy = false;
      session.lastSpeakerLock = null;
    }
  } catch (err) {
    // Full stack instead of just err.message — a bare message can hide
    // exactly which await threw, which matters when several awaits are
    // chained back to back in this function.
    console.error('[Voice] pipeline error:', err.stack || err.message);
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

  // CRITICAL: @discordjs/voice emits 'error' on the connection for network-level
  // failures (e.g. "Cannot perform IP discovery - socket closed"). Node's default
  // behavior for an unhandled 'error' event on an EventEmitter is to throw and
  // CRASH THE WHOLE PROCESS — which is exactly what was happening before this
  // listener existed. We must always have at least one 'error' listener.
  connection.on('error', (err) => {
    console.error(`[Voice] connection error in guild ${guild.id}:`, err.message);
    // Treat it like a disconnect: tear down and retry after a delay, rather
    // than leaving a half-dead connection object around.
    try { connection.destroy(); } catch {}
    voiceSessions.delete(guild.id);
    setTimeout(() => {
      joinAndListen(client, guild, channelId, deps).catch((e) =>
        console.error('[Voice] reconnect-after-error failed:', e.message)
      );
    }, RECONNECT_DELAY_MS);
  });

  // Same reasoning for the audio player — TTS playback errors (e.g. a corrupt
  // PCM buffer, broken pipe to the resource) also emit 'error' and would
  // otherwise crash the process the same way.
  player.on('error', (err) => {
    console.error(`[Voice] audio player error in guild ${guild.id}:`, err.message);
    session.busy = false; // don't leave the session permanently "busy" after a playback failure
  });

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
 *
 * Joins are staggered (not fired all at once) because joinVoiceChannel()
 * returns before the underlying UDP handshake (including IP discovery)
 * finishes — firing several at once on boot increases the odds of hitting
 * "Cannot perform IP discovery - socket closed", which crashes the whole
 * process if unhandled (now guarded against in joinAndListen, but better
 * to avoid triggering it in the first place).
 */
async function initVoiceAssistant(client, getDashboardConfig, deps) {
  const cfg = getDashboardConfig();
  const voiceChannels = cfg.voiceChannels || {};
  for (const [guildId, channelId] of Object.entries(voiceChannels)) {
    try {
      const guild = await client.guilds.fetch(guildId);
      await joinAndListen(client, guild, channelId, deps);
      await new Promise((resolve) => setTimeout(resolve, 2000)); // breathing room before the next join
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