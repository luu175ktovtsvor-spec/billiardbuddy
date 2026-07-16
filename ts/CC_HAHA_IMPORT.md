# CC-Haha 内核导入说明 / Upstream Import Provenance

本目录 (`ts/`) 是 **cc-haha** 参考实现的全量导入，作为球房项目的 Agent 内核基线。
This directory (`ts/`) is a full, verbatim import of the **cc-haha** reference
implementation, serving as the agent kernel baseline for the billiard project.

## 上游来源 / Upstream source

| 项 | 值 |
|----|----|
| Repository | https://github.com/NanmiCoder/cc-haha.git |
| Branch | `main` |
| Commit | `d318b1b49213b9a0445f82681876003580e41263` |
| Upstream subject | `无标题` (2026-07-07) |
| Import date | 2026-07-16 |
| Tracked files imported | 3429 (100% of upstream tree) |
| License | 见 `ts/LICENSE`（允许衍生作品，署名保留） |

## 导入方式 / Import method

使用 `git archive` 从上游提交生成快照并解包到 `ts/`，不经过零散复制：

```bash
git -C <cc-haha> archive --format=tar d318b1b | tar -x -C <repo>/ts
```

- 不含 `.git`、`node_modules`、构建产物、缓存、密钥或 `.env`。
- 保留可执行位（如 `ts/bin/claude-haha` = 100755）。
- 保留 `ts/LICENSE`、`ts/README.md`、`ts/README.en.md`、`ts/CONTRIBUTING.md` 及版权署名。

## 覆盖与一致性核对 / Coverage & integrity proof

导入后逐文件比对，证明与上游字节级一致：

```bash
# 上游: 模式 + blob 哈希 + 路径
git -C <cc-haha> ls-tree -r d318b1b | awk -F'\t' '{split($1,a," ");print a[1]" "a[3]" "$2}' | sort
# 导入: 剥离 ts/ 前缀后同格式
git ls-files -s ts/ | awk -F'\t' '{split($1,a," ");print a[1]" "a[2]" "substr($2,4)}' | sort
# diff 为空 => 全部 3429 文件 mode + 内容哈希完全一致
```

结果：**diff 为空**，3429 个文件的 mode 与 blob 哈希全部一致。

## 后续同步 / Re-syncing with upstream

拉取上游新提交 `<new-sha>` 后，用同一方式覆盖导入并重新核对：

```bash
git rm -r ts && mkdir ts
git -C <cc-haha> archive --format=tar <new-sha> | tar -x -C <repo>/ts
git add -f ts
# 再跑上面的 ls-tree/ls-files 哈希比对确认一致
```

或将 cc-haha 添加为远程后，用 `git diff` 比对 `ts/` 与目标 tree。

## 边界说明 / Boundary notes

- 本次为**全量导入基线**，未做任何球房化改写（品牌、文案、模型网关、领域知识均未改）。
- 外层服务 `gateway/` `relay/` `dataeye/` 未被改写或删除，且不在运行时 import `ts/`。
- 仓库外层的质量门与 Skill 治理工具（`scripts/quality_gate.sh`、`scripts/quality/check-architecture.ts`、
  `scripts/quality/validate-skills.ts`、`.github/workflows/*`）仍指向旧 `ts/` 结构，尚未与本内核接通——属于下一阶段接线工作，本阶段不触碰。
