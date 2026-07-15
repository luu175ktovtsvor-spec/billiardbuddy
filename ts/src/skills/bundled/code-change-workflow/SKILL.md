---
name: code-change-workflow
user-invocable: false
description: "写代码、改配置、调试仓库问题时的取数/编辑/验证工具节奏。只在任务确实要碰代码或仓库时加载；经营、生图、剪视频等业务任务不要用。"
whenToUse: "当前用户目标需要读代码、编辑文件、装依赖、跑构建或测试、排查代码报错，或做任何软件工程改动时使用。"
---

# 写代码时的工具节奏

## 先摸清改动面，再动手

- 陌生项目先 `list_dir({recursive:true,max_depth:2})` 摸目录；大仓库用 `grep_files({files_only:true})`、`glob_files` 或 `code_outline` 定位候选。
- 用 `grep_files({ranges:true})` 或 `code_outline({ranges:true})` 产出聚焦窗口，配合 `read_many_files({ranges})` 精读。
- `grep_files` 的 path/paths 可以是目录也可以是具体文件；只搜几个文件时就把范围收窄到那几个文件，别退回 shell grep。
- 用 `read_file` 或 `read_many_files({ranges})` 做聚焦阅读；paths/ranges 接受单值，多文件/多窗口用数组。
- 编辑前先读目标文件，让"读后写"保护能识别并发改动；进陌生目录先调 `list_project_instructions({path})`。
- 挑最小够用的编辑工具：一处精确替换用 `edit_file`；一个文件多处替换用 `multi_edit_file`；复杂 hunk 用 `patch_file`；需要几个文件一起校验并应用、且要保留可回滚 diff 的连贯多文件改动用 `patch_files`。
- 要查实现历史、回归起源或改动理由时用 `git_history({paths})`，优先它的只读历史，别用 shell 乱翻。
- `<stored_tool_result path="...">` 预览给的上下文不够时，用 `read_stored_tool_result` 补窗口，别直接 shell cat 任意路径。
- 在子包里跑命令用 `run_command({cwd:"子目录", command:"..."})`，不要拼 `cd ... && ...`。
- 改完用 `git_status({include_diff:true, staged:"both"})` 或返回的 file_change/diff 核对实际改动(含 staged/unstaged/untracked)，再跑贴近改动的验证，如实汇报结果。

## 改完就地验证

- 改代码、配置、脚本或前端样式后，先跑贴近这处改动的验证，再说完成。
- 进陌生子目录或建新文件前，若还没读过适用的项目指令，先调 `list_project_instructions({path})`。
- 用 `project_diagnostics` 在改动文件附近发现 `package.json` 里的安全脚本，跑自动检查(如 typecheck、lint)；涉及行为改动时显式跑 `check:"test"`，需要聚焦某些用例时带上 `test_paths`。
- `project_diagnostics` 给出的候选测试只是线索，不代表已经跑过——线索要接着用 `test_paths` 真正执行。
- 没有可用脚本、跑不了、或验证环境缺失时，别声称成功，说清楚跑不了什么、剩多大风险。
- 需要更完整的端到端行为验证(不只是 typecheck/单测)时，叠加 `verify` skill。
