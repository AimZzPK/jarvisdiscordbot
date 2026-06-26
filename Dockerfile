# =========================================================
# JARVIS Bot — Dockerfile for Railway (voice assistant build)
# =========================================================
# Set Railway's service builder to "Dockerfile" (Settings → Build → Builder).
# Railway auto-detects this file at the repo root by default.

FROM node:20-bookworm-slim

# ---------------------------------------------------------
# OS packages:
#   wget, ca-certificates, tar  -> fetching/extracting Piper
#   libopus0                    -> required by prism-media's Opus decoder
#                                   (without this, voice capture throws at runtime)
#   ffmpeg is NOT installed via apt here — @ffmpeg-installer/ffmpeg pulls its
#   own static binary via npm, so we don't need the system package.
# ---------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget \
      ca-certificates \
      tar \
      libopus0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---------------------------------------------------------
# PIPER TTS BINARY
# ---------------------------------------------------------
# rhasspy/piper is archived (read-only) as of Oct 2025. "Latest" release is
# permanently pinned at tag 2023.11.14-2, so we pin that tag explicitly
# rather than hitting /releases/latest (no functional difference for an
# archived repo, but explicit is clearer than relying on redirect behavior).
#
# The extracted folder layout has varied across Piper's history, so instead
# of hardcoding a path we extract to a staging dir and locate the `piper`
# executable wherever it landed.
RUN mkdir -p /tmp/piper-extract && \
    wget -q https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
      -O /tmp/piper.tar.gz && \
    tar -xzf /tmp/piper.tar.gz -C /tmp/piper-extract && \
    rm /tmp/piper.tar.gz && \
    PIPER_DIR=$(dirname "$(find /tmp/piper-extract -type f -name piper -perm -u+x | head -n1)") && \
    mkdir -p /app/piper && \
    cp -r "$PIPER_DIR"/. /app/piper/ && \
    rm -rf /tmp/piper-extract && \
    chmod +x /app/piper/piper

# Sanity check the binary actually runs in this container (fails the build
# loudly here instead of failing silently at 3am when someone talks in VC)
RUN /app/piper/piper --help > /dev/null

# ---------------------------------------------------------
# VOICE MODEL: en_US-ryan-high
# ---------------------------------------------------------
# `high` quality models are larger (~110MB+) than `medium` ones (~60MB) and
# cost more CPU per synthesis call — watch the `[Voice TIMING] piper=...ms`
# logs after deploying. If it's too slow on your Railway tier, swap to a
# medium-quality male voice (e.g. en_US-joe-medium) instead.
#
# wget --tries/--timeout: HuggingFace occasionally throttles or blips on
# large file downloads mid-build; without retries a transient failure here
# kills the whole image build. -q is dropped in favor of explicit error
# checking via `set -e`-style && chaining plus a post-download size check,
# since a silently truncated .onnx file is worse than a loud build failure.
RUN wget --tries=3 --timeout=60 -O /app/piper/en_US-ryan-high.onnx \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx && \
    wget --tries=3 --timeout=60 -O /app/piper/en_US-ryan-high.onnx.json \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json && \
    test -s /app/piper/en_US-ryan-high.onnx && \
    test -s /app/piper/en_US-ryan-high.onnx.json

# ---------------------------------------------------------
# APP
# ---------------------------------------------------------
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PIPER_BIN_PATH=/app/piper/piper
ENV PIPER_MODEL_PATH=/app/piper/en_US-ryan-high.onnx

CMD ["node", "index.js"]