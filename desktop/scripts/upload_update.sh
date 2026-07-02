#!/usr/bin/env bash
# 发布桌面自动更新:把 electron-builder 产物(安装包 + blockmap + latest.yml)传到更新私服。
#
# 用法: bash desktop/scripts/upload_update.sh <产物目录>
#   产物目录 = CI artifact 解压后的目录,或本地打包的 desktop/dist(需含 latest.yml、*.exe、*.exe.blockmap)
#
# 顺序铁律:先传 exe + blockmap、最后传 latest.yml——
# 客户端只认 latest.yml,若先传它,用户会在安装包还没就位时下到 404。
set -euo pipefail

DIR="${1:-desktop/dist}"
HOST="root@47.77.237.250"   # zzyppz.cn 的直连 IP(本机 DNS 被代理劫持成 fake-ip,域名 ssh 不通;known_hosts 已信任该 IP)
DEST="/var/www/desktop-updates"

YML="$DIR/latest.yml"
[ -f "$YML" ] || { echo "❌ 找不到 $YML(目录不对,或打包没生成更新清单)"; exit 1; }
VERSION=$(grep '^version:' "$YML" | awk '{print $2}' | tr -d '\r')
[ -n "$VERSION" ] || { echo "❌ latest.yml 里读不到版本号"; exit 1; }

EXE=$(find "$DIR" -maxdepth 1 -name "*Setup*${VERSION}.exe" | head -1)
[ -n "$EXE" ] || { echo "❌ 找不到 ${VERSION} 版安装包 exe(latest.yml 和 exe 必须同一次打包产出)"; exit 1; }
BLOCKMAP="${EXE}.blockmap"

echo "→ 发布版本 ${VERSION}"
echo "→ 上传安装包 $(basename "$EXE")($(du -h "$EXE" | cut -f1))…"
scp -q "$EXE" "$HOST:$DEST/"
if [ -f "$BLOCKMAP" ]; then
  scp -q "$BLOCKMAP" "$HOST:$DEST/"
  echo "→ blockmap 已上传(老客户端可差量下载)"
fi
echo "→ 最后上传 latest.yml(此刻起所有客户端可见新版)…"
scp -q "$YML" "$HOST:$DEST/"

echo "→ 验证线上清单:"
curl -s --max-time 15 "https://zzyppz.cn/desktop/latest.yml" | head -4
echo "✅ 发布完成:已装用户下次打开软件将自动更新到 ${VERSION}"
