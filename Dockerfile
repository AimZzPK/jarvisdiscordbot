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
# IMPORTANT: rhasspy/piper is archived (read-only) as of Oct 2025.
# "Latest" release is permanently pinned at tag 2023.11.14-2 — this is fine,
# it still works, just won't get future updates. The maintained successor
# (OHF-Voice/piper1-gpl) is a Python package, which is more setup for less
# gain here, so we stick with the old static binary.
#
# We pin the exact tag (not /releases/latest) since for an archived repo
# there is no meaningful difference, and pinning avoids any ambiguity.
#
# The extracted folder name has varied across Piper's history (sometimes
# `piper/`, sometimes flat). Rather than hardcode a layout, we extract to a
# staging dir and locate the `piper` executable wherever it landed.
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
# VOICE MODEL (en_US-lessac-medium — free, good default quality)
# ---------------------------------------------------------
RUN wget -q -O /app/piper/en_US-lessac-medium.onnx \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx && \
    wget -q -O /app/piper/en_US-lessac-medium.onnx.json \
      https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json

# ---------------------------------------------------------
# APP
# ---------------------------------------------------------
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PIPER_BIN_PATH=/app/piper/piper
ENV PIPER_MODEL_PATH=/app/piper/en_US-lessac-medium.onnx

CMD ["node", "index.js"]