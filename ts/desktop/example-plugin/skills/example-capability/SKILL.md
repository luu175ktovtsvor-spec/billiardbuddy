---
name: example-capability
description: 可挂载能力插件的示例 Skill。开发或验证插件 Skill 发现、启用和调用链时使用；启用插件后并入 Agent 技能库，不代表真实产品能力。
whenToUse: 用户询问该插件提供的能力时(真实插件里换成领域触发词,如"生成人像照""剪辑这段视频""台球运营诊断")
---

# 示例插件能力

这是**可挂载能力插件模板**里的一个示例 skill,用来证明「插件 → skills 并入会话」这条链路端到端通。

真实的可挂载能力(阶段目标 §12/§13/§10)按同样结构做成插件:

- **生图/人像优化**:插件 `skills/` 放"人像优化""换比例""局部重绘"等 skill,`.mcp.json` 接生图模型工具(GPT Image 2 / Seedream)。
- **真实素材剪辑**:插件 skills 放"导入探测""生成剪辑策略""渲染导出"等,编排参考 video-use。
- **台球运营专家**:插件 skills 放运营诊断/话术/活动策划等(知识必须来自真实 PPT 素材,不编造)。

启用插件(`/api/v1/agent/plugins/toggle`)后,`resolveEnabledPluginContributions` 会把这些
skills/.mcp.json 并入本次会话(见 `src/plugins/pluginLoader.ts` + `buildExecutionRegistry`)。

复制模板创建真实插件时，必须替换技术名、中文标题、触发描述和成功标准，并删除所有“示例”措辞；不要直接发布本模板。
