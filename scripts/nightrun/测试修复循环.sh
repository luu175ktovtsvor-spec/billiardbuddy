#!/usr/bin/env bash
# 测试修复循环:跑测试 -> 挂了就起一个全新 claude 会话修"第一个失败" -> 再跑测试 -> 直到全绿或到上限。
# 这是"外部硬闸"打法:绿不绿由 scripts/test.sh 说了算,不由 AI 自己说了算。
# 用法:  bash scripts/nightrun/测试修复循环.sh [--dry-run] [最多修几轮]
# 例子:  bash scripts/nightrun/测试修复循环.sh        # 默认最多 8 轮
# 停法:  Ctrl+C;或另开终端 touch scripts/nightrun/STOP
# 注意:  要求 git 工作区干净再跑(夜里改的东西早上 git diff 一眼看清);硬要带着未提交改动跑,加环境变量 NIGHT_ALLOW_DIRTY=1
set -u

# ===== 旋钮 =====
MODEL="${QF_NIGHT_MODEL:-sonnet}"
DEFAULT_MAX=8

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/scripts/nightrun"
LOGDIR="$DIR/logs"; STOP="$DIR/STOP"

DRY=0; MAX="$DEFAULT_MAX"
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) MAX="$a" ;;
  esac
done

command -v claude >/dev/null 2>&1 || { echo "找不到 claude 命令"; exit 1; }
mkdir -p "$LOGDIR"
[ -f "$STOP" ] && { echo "发现遗留的 STOP 文件,先删: rm \"$STOP\""; exit 1; }

if [ "${NIGHT_ALLOW_DIRTY:-0}" != "1" ] && [ -n "$(cd "$ROOT" && git status --porcelain)" ]; then
  echo "git 工作区不干净。先提交/收拾好再跑,夜里改的东西才能一眼分清。"
  echo "(明知故犯请加 NIGHT_ALLOW_DIRTY=1)"
  exit 1
fi

if [ "$DRY" = 1 ]; then
  echo "[dry-run] 流程演习: 跑 bash scripts/test.sh -> 若挂, claude -p 修第一个失败(模型 $MODEL, 最多 $MAX 轮) -> 循环到全绿"
  echo "[dry-run] 不跑测试、不调 claude、不花钱。结束。"
  exit 0
fi

i=0
while :; do
  [ -f "$STOP" ] && { echo "发现 STOP 文件,收工"; exit 2; }
  echo "== 第 $i 轮测试: bash scripts/test.sh"
  out="$( (cd "$ROOT" && bash scripts/test.sh) 2>&1 )"; code=$?
  if [ "$code" -eq 0 ]; then
    echo "== 全绿 ✅ (共修了 $i 轮)"
    if [ "$i" -gt 0 ] && [ "${NIGHT_NO_COMMIT:-0}" != "1" ] && [ -n "$(cd "$ROOT" && git status --porcelain)" ]; then
      ( cd "$ROOT" && git add -A && git commit -q -m "夜跑测试修复: 全绿(共 $i 轮)

scripts/test.sh 全绿后由夜跑循环自动本地提交(未 push,待 owner review)。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" )
      echo "   已本地提交一笔;早上 review: git log -1 -p"
    else
      echo "   早上看改动: cd \"$ROOT\" && git diff --stat"
    fi
    exit 0
  fi
  if [ "$i" -ge "$MAX" ]; then
    echo "== 到达 $MAX 轮上限仍未全绿,收工。人来接手。"
    exit 1
  fi
  i=$((i+1))
  log="$LOGDIR/修复-第${i}轮-$(date +%Y%m%d-%H%M%S).log"
  tail_out="$(printf '%s' "$out" | tail -100)"
  echo "   测试红了(退出码 $code) -> 起新会话修第 $i 轮, 日志: $log"

  prompt=$(cat <<EOF
项目回归测试挂了。下面是 bash scripts/test.sh 输出的最后 100 行。
你的任务:只修"第一个失败",遵守项目 CLAUDE.md 的 bug 修复纪律——最小修复、一次只改一处、不顺手重构。
红线:禁止用跳过测试(skip/xit)、删测试、放宽断言、关检查的方式换绿;那不算修复,算造假。
改完自己重跑 bash scripts/test.sh 确认你修的那个失败消失了再收工。
无人值守:不要向我提问;不 git commit。
测试输出:
$tail_out
EOF
)
  ( cd "$ROOT" && claude -p "$prompt" --model "$MODEL" --dangerously-skip-permissions ) >"$log" 2>&1 </dev/null
  echo "   本轮修复会话退出码: $?"
done
