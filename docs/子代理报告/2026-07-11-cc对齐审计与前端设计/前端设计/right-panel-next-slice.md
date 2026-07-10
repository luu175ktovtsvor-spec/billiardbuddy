# 右侧预览面板(下一片·以 Codex 为权威参考)

owner 陆续给的 Codex 真机截图(存 ~/Desktop/Codex/),下一片子代理对着做:

## 核心行为
1. **点工具行文件名 → 右侧打开该文件内容**(代码+行号+语法高亮)。v2 已接"文件名可点+点击触发 openFileInPreview(path) 事件"契约,本片消费它。
2. **多标签页**:右侧顶部一排打开的文件标签(审阅 / permissionUpdate.ts / filePathRules.ts / readIgnoreFilter.ts / autoEditSafety.ts / resolve.ts...),当前标签高亮。
3. **标签可开可关**:点标签切换文件;点标签关闭按钮关掉该标签。右上还有 + 新建、放大、最小化、面板开关。
4. **面包屑**:球房运营AI助手-桌面版 › ts › src › permissions › filePathRules.ts + "打开"按钮。
5. **文件夹树状图**(最右):ts > src > permissions > canonical.ts...,当前文件高亮;文件带增删徽章(+/−,Codex 审阅态)。
6. **hover 文件名 → 完整绝对路径 tooltip**(v2 已做行内 tooltip,右侧面板一致)。

## 参考分层
- 交互/审阅面板(diff、文件树+/−徽章、分支对比、多标签、代码查看器) = **Codex 为主**(我们是 coding agent 底座,右侧"变更/审阅"态就按 Codex)。
- 简单文件预览/产物预览 = WorkBuddy 为辅。
- 白标:不露真实 model/provider;台球店主非代码任务时,"变更"态降级为朴素"改了哪些文件/产物"。

## 归属
本片改 renderer-react 的 workspace/workbench(右侧面板)组件 + 一个 workspacePanelStore(多标签/打开文件状态)。派发前按 owner 规矩先出方案给 owner 过目。
