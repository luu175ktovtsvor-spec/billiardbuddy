#!/usr/bin/env bash
# 对标夜跑(真施工版):每个模块起一个全新 claude 会话——对标分析 -> 直接施工掰回分叉 -> 补行为对齐测试,
# 然后由本循环用 scripts/test.sh 做外部验收:绿了才本地提交一笔、标记完成;红了把现场收进 git stash 留证,明晚重试。
# 绝不 push。早上用 git log 逐笔 review,不满意 git revert 单个模块即可。
#
# 用法:  bash scripts/nightrun/对标夜跑.sh [--dry-run] [最多跑几个模块]
# 例子:  bash scripts/nightrun/对标夜跑.sh 1         # 首跑试水 1 个模块
#        bash scripts/nightrun/对标夜跑.sh           # 默认 3 个(施工比纯报告重)
# 保守模式: NIGHT_REPORT_ONLY=1 bash ... (只出分叉报告不碰代码,老行为)
# 不提交:   NIGHT_NO_COMMIT=1 bash ... (只跑 1 个模块,改动留工作区)
# 停法:  Ctrl+C;或 touch scripts/nightrun/STOP(干完当前模块收工)
set -u

# ===== 旋钮 =====
MODEL="${QF_NIGHT_MODEL:-sonnet}"
DEFAULT_MAX=3

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/scripts/nightrun"
LIST="$DIR/对标模块清单.txt"
STATE_DIR="$DIR/state"; STATE="$STATE_DIR/对标已完成.txt"
LOGDIR="$DIR/logs"; STOP="$DIR/STOP"
REPORT_ONLY="${NIGHT_REPORT_ONLY:-0}"
NO_COMMIT="${NIGHT_NO_COMMIT:-0}"

DRY=0; MAX="$DEFAULT_MAX"
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) MAX="$a" ;;
  esac
done

command -v claude >/dev/null 2>&1 || { echo "找不到 claude 命令"; exit 1; }
[ -f "$LIST" ] || { echo "缺模块清单: $LIST"; exit 1; }
mkdir -p "$STATE_DIR" "$LOGDIR"; touch "$STATE"
[ -f "$STOP" ] && { echo "发现遗留 STOP 文件,先删: rm \"$STOP\""; exit 1; }

if [ "$NO_COMMIT" = "1" ] && [ "$MAX" -gt 1 ]; then
  echo "NIGHT_NO_COMMIT=1 时改动会堆在工作区分不清模块,本次强制只跑 1 个。"
  MAX=1
fi

# 施工模式要求 git 干净(每模块提交后树会回到干净,模块间互不污染)
if [ "$REPORT_ONLY" != "1" ] && [ "$DRY" != "1" ]; then
  if [ -n "$(cd "$ROOT" && git status --porcelain)" ]; then
    echo "git 工作区不干净。施工型夜跑要求干净起步(每模块一笔提交,早上才可逐笔 review)。"
    echo "先处理掉未提交改动;或用 NIGHT_REPORT_ONLY=1 跑纯报告模式。"
    exit 1
  fi
fi

DATE_TAG="$(date +%Y-%m-%d)"
MODE_DESC="施工"; [ "$REPORT_ONLY" = "1" ] && MODE_DESC="纯报告"
echo "== 对标夜跑($MODE_DESC)开始: 上限 $MAX 个模块, 模型 $MODEL, dry-run=$DRY"
count=0; ok=0; bad=0

while IFS= read -r mod <&3; do
  case "$mod" in ""|\#*) continue ;; esac
  grep -qxF "$mod" "$STATE" && continue
  [ -f "$STOP" ] && { echo "-- 发现 STOP,收工"; break; }
  [ "$count" -ge "$MAX" ] && { echo "-- 到达上限 $MAX,收工"; break; }

  count=$((count+1))
  safe="$(printf '%s' "$mod" | tr ' /' '--')"
  log="$LOGDIR/对标-$safe-$(date +%Y%m%d-%H%M%S).log"
  echo "[$count/$MAX] 开跑: $mod"

  if [ "$REPORT_ONLY" = "1" ]; then
    prompt=$(cat <<EOF
先读本项目 .claude/commands/对标.md,严格执行其中的分析流程(第 1-4 步),对标目标模块 = $mod。
本次为无人值守纯报告模式:只产出分叉清单和掰回方案,落 docs/子代理报告/$DATE_TAG-对标夜跑/;不改 ts/ 源码、不 git commit、不向我提问。
EOF
)
  else
    prompt=$(cat <<EOF
先读本项目 .claude/commands/对标.md,把第 1-3 步(读参考实现/读我们实现/出分叉清单)严格执行,对标目标模块 = $mod,分叉清单照规约落 docs/子代理报告/$DATE_TAG-对标夜跑/。
然后**直接施工**(夜跑已获对本清单模块的施工授权,不适用"等拍板"):按项目 CLAUDE.md 的对标铁律把内核分叉掰回 cc-haha——替换而非叠加,产品层边界(白标/网关/领域包/生图等)不动;同步补行为对齐测试(刁钻边界判得跟 cc 一致)。
纪律:
1. 红线:禁止跳过/删除/放宽测试换绿;禁止动 .env、git 配置;不 git commit、不 push(循环负责提交)。
2. 改完必须自己跑 bash scripts/test.sh,全绿才允许收工;修不绿就在报告里如实写卡在哪。
3. 无人值守:不向我提问;拿不准的边界在报告里写明假设;单模块工程量过大时,完成其中风险最低的一部分并在报告里写清剩余施工清单,别硬吃。
EOF
)
  fi

  if [ "$DRY" = 1 ]; then
    echo "        [dry-run] claude -p <${MODE_DESC}提示词> --model $MODEL --dangerously-skip-permissions"
    continue
  fi

  ( cd "$ROOT" && claude -p "$prompt" --model "$MODEL" --dangerously-skip-permissions ) >"$log" 2>&1 </dev/null
  ccode=$?
  echo "        会话退出码 $ccode,日志: $log"

  if [ "$REPORT_ONLY" = "1" ]; then
    if [ "$ccode" -eq 0 ]; then printf '%s\n' "$mod" >> "$STATE"; ok=$((ok+1)); else bad=$((bad+1)); fi
    continue
  fi

  # ===== 外部硬闸:不信会话自述,循环亲自跑测试 =====
  testlog="$LOGDIR/验收-$safe-$(date +%Y%m%d-%H%M%S).log"
  ( cd "$ROOT" && bash scripts/test.sh ) >"$testlog" 2>&1
  tcode=$?
  if [ "$tcode" -eq 0 ] && [ "$ccode" -eq 0 ]; then
    if [ "$NO_COMMIT" = "1" ]; then
      echo "        ✅ 测试全绿;按 NIGHT_NO_COMMIT 改动留在工作区待你查看"
    else
      ( cd "$ROOT" && git add -A && git commit -q -m "夜跑对标施工: $mod

外部验收 scripts/test.sh 全绿后由夜跑循环自动本地提交(未 push,待 owner review)。
分叉清单与施工报告: docs/子代理报告/$DATE_TAG-对标夜跑/

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" )
      echo "        ✅ 测试全绿,已本地提交一笔(git log 可查)"
    fi
    printf '%s\n' "$mod" >> "$STATE"; ok=$((ok+1))
  else
    echo "        ❌ 验收未过(会话=$ccode 测试=$tcode),现场收进 stash 留证,不标完成"
    ( cd "$ROOT" && git add -A && git stash push -q -m "夜跑失败现场: $mod $(date +%m%d-%H%M)" ) 2>/dev/null
    bad=$((bad+1))
  fi
done 3< "$LIST"

echo "== 收工($MODE_DESC): 处理 $count 个(验收通过 $ok / 未过 $bad)"
echo "   报告: $ROOT/docs/子代理报告/$DATE_TAG-对标夜跑/"
echo "   早上三件套: git log --oneline -10(昨晚提交) | git stash list(失败现场) | 翻报告"
