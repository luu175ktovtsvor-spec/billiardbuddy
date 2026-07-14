#!/bin/bash
# 在大陆 qfgw 主机部署 CPU Whisper 转录运行时。固定源码与模型校验值，可重复执行。
set -euo pipefail

APPDIR=/opt/qfgw
WHISPER_VERSION=1.7.6
SOURCE_SHA256=166140e9a6d8a36f787a2bd77f8f44dd64874f12dd8359ff7c1f4f9acb86202e
MODEL_NAME=ggml-small-q5_1.bin
MODEL_SHA256=ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb
MODEL_REPO=https://www.modelscope.cn/models/cjc1887415157/whisper.cpp.git
MODEL_REVISION=ac12dbec310c2fd6e67398e808c40d80210ce4d0
SOURCE_URL="https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v${WHISPER_VERSION}"
VENDOR_DIR="$APPDIR/vendor"
BUILD_DIR="$APPDIR/build/whisper.cpp-${WHISPER_VERSION}"
BIN_DIR="$APPDIR/bin"
MODEL_DIR="$APPDIR/models"
TMP_DIR="$APPDIR/transcribe-tmp"
ENV_FILE="$APPDIR/gw.env"

cleanup_build_artifacts() {
  rm -rf "$APPDIR/build" "$VENDOR_DIR"
}
trap cleanup_build_artifacts EXIT

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE is missing" >&2
  exit 1
fi

download_verified() {
  local url="$1"
  local dest="$2"
  local expected="$3"
  if [ -f "$dest" ] && [ "$(sha256sum "$dest" | awk '{print $1}')" = "$expected" ]; then
    return
  fi
  local partial="${dest}.part"
  rm -f "$partial"
  curl -fL --retry 4 --retry-delay 2 --connect-timeout 20 -o "$partial" "$url"
  if [ "$(sha256sum "$partial" | awk '{print $1}')" != "$expected" ]; then
    rm -f "$partial"
    echo "checksum mismatch: $dest" >&2
    exit 1
  fi
  mv -f "$partial" "$dest"
}

download_model() {
  local dest="$1"
  if [ -f "$dest" ] && [ "$(sha256sum "$dest" | awk '{print $1}')" = "$MODEL_SHA256" ]; then
    return
  fi
  local repo="$VENDOR_DIR/model-repo"
  rm -rf "$repo"
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 "$MODEL_REPO" "$repo"
  if [ "$(git -C "$repo" rev-parse HEAD)" != "$MODEL_REVISION" ]; then
    echo "unexpected ModelScope revision" >&2
    exit 1
  fi
  git -C "$repo" lfs install --local
  git -C "$repo" lfs pull --include="$MODEL_NAME" --exclude=''
  if [ "$(sha256sum "$repo/$MODEL_NAME" | awk '{print $1}')" != "$MODEL_SHA256" ]; then
    echo "model checksum mismatch" >&2
    exit 1
  fi
  mv -f "$repo/$MODEL_NAME" "$dest"
  rm -rf "$repo"
}

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s#^${key}=.*#${key}=${value}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl cmake build-essential ffmpeg git-lfs

if ! swapon --show=NAME --noheadings | grep -q .; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

mkdir -p "$VENDOR_DIR" "$APPDIR/build" "$BIN_DIR" "$MODEL_DIR" "$TMP_DIR"
chmod 700 "$TMP_DIR"

SOURCE_ARCHIVE="$VENDOR_DIR/whisper.cpp-${WHISPER_VERSION}.tar.gz"
download_verified "$SOURCE_URL" "$SOURCE_ARCHIVE" "$SOURCE_SHA256"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/source"
tar -xzf "$SOURCE_ARCHIVE" --strip-components=1 -C "$BUILD_DIR/source"
cmake -S "$BUILD_DIR/source" -B "$BUILD_DIR/out" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$BUILD_DIR/out" --config Release --target whisper-cli -j2
install -m 755 "$BUILD_DIR/out/bin/whisper-cli" "$BIN_DIR/whisper-cli"

MODEL_PATH="$MODEL_DIR/$MODEL_NAME"
download_model "$MODEL_PATH"
chmod 644 "$MODEL_PATH"

upsert_env GW_TRANSCRIBE_BIN "$BIN_DIR/whisper-cli"
upsert_env GW_TRANSCRIBE_MODEL "$MODEL_PATH"
upsert_env GW_TRANSCRIBE_PROVIDER whisper
upsert_env GW_FFMPEG_BIN /usr/bin/ffmpeg
upsert_env GW_TRANSCRIBE_TMP "$TMP_DIR"
upsert_env GW_TRANSCRIBE_THREADS 2
upsert_env GW_TRANSCRIBE_CONC 1
upsert_env GW_TRANSCRIBE_RPM 12
upsert_env GW_Q_TRANSCRIBE 100
upsert_env GW_TRANSCRIBE_MAX_BYTES 100663296
upsert_env GW_TRANSCRIBE_TIMEOUT_MS 1800000
chmod 600 "$ENV_FILE"

NGINX_SITE=/etc/nginx/sites-available/billiards-gateway
if [ -f "$NGINX_SITE" ]; then
  sed -i 's/client_max_body_size 32m;/client_max_body_size 100m;/' "$NGINX_SITE"
  nginx -t
  systemctl reload nginx
fi

systemctl restart qfgw
systemctl is-active --quiet qfgw
curl -fsS --max-time 8 http://127.0.0.1:8799/healthz | grep -q '"transcription":true'
echo "TRANSCRIPTION_DEPLOYED"
