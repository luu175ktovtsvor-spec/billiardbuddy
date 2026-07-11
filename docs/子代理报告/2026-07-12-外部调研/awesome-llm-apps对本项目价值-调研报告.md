# awesome-llm-apps 对本项目价值 · 调研报告

> 📌 状态:✅现行 · 调研参考(主要服务 task#12 台球知识重策展 + eval) · 2026-07-12 调研员出品,来源全程标注

## 一、仓库定性

Shubhamsaboo/awesome-llm-apps:**11.8 万星的 Python 教学范例合集**(cookbook),约 200 个独立小 demo 分 15 大类,Apache-2.0,更新极勤(几乎日更)。本质是"给人抄作业入门"的教学脚本(50~300 行,Streamlit 一把梭),**不是生产级框架——代码不能直接搬进本项目的 Bun/TS 栈,可借的是思路**。【源码:GitHub API 元数据 + 抽查 15 份 README + 2 份完整源码】

## 二、值得借的 5 条思路(全部"借思路不借代码")

1. **RAG 故障 12 分类清单** → task#12 上线后的排查 checklist。`rag_tutorials/rag_failure_diagnostics_clinic/`:检索幻觉/chunk 切断关键信息/向量相似≠真相关/索引过期/路由错库/多步跑偏/工具编参/记忆丢失/评估盲区/时序/配置漂移/多 agent 踩踏,共 12 种失败模式;"每次诊断存 JSON 攒故障案例库"的做法也可借。落地成本低(译改成台球版清单即可)。
2. **PPT 页"渲染成图 + 多模态 embedding"优于纯文本抽取** → task#12 策展技术选型。`vision_rag/`+`multimodal_agentic_rag/`:整页转图片、用图文同空间的多模态 embedding 去 embed,文字问题也能命中走位图/球型图解,比"抽文字再切块"保真。⚠️前提待查:我们网关接的模型有没有多模态 embedding 能力(仓库没答案,需另查)。
3. **"先判相关性、不相关别硬答"**(Corrective RAG 的简化子思路) → task#12 压低瞎编率。检索结果相关性不够时,要么明说"知识库没覆盖"要么换角度重查;台球是封闭 PPT 语料,不需要它"查网页兜底"那截,也不用引入 LangGraph。
4. **trigger-cases.json 式"该不该触发"测试格式** → eval 板块 + 防"反逻辑死路"回归。每功能点写正例(该触发)+ 形似反例(不该触发)+ `should_trigger` 布尔 + 一句 assert,脚本批量校验。正好对上"斜杠命令/台球功能前端必须露好可触发"的既有风险点。注:该格式源头是 Anthropic 官方 anthropics/skills 的 evals.json,要深挖去看源头。
5. **(条件性)素材库按内容找片段**:ffmpeg 1帧/秒抽帧→缩至1024px→多模态 embedding(一批≤6张)→向量库带时间戳→文字/图检索跳转时间点;拿不到多模态 embedding 时降级为"视觉模型逐帧生成文字描述再做文本 embedding"。仅当剪辑管线需要"按描述从素材堆里找镜头"才适用;参数可借,用 TS 在 sidecar 重写。【源码:multimodal_video_moment_finder/backend/video_store.py 全文】

## 三、明确不用看的部分

- **6 个"带记忆的 App"教程**:全是 Mem0+Qdrant 检索式记忆——和本项目已拍板的"门店画像走常驻注入不走检索"方向相反,代码 30~50 行无增量。
- **generative_ui_agents**:AI 临场生成 UI 组件,与"固定前端、照抄 Codex"的产品形态不对口。
- **多知识库路由/知识图谱 RAG/托管 RAG 服务**:台球是单一 PPT 扁平语料用不上;托管服务与"嵌入走自建 sidecar"方向相反。
- **8 个基础 RAG demo**:LangChain+向量库换皮,互相重复无增量。
- **多 agent 团队/语音/MCP/框架速成课**:对标对象已定死(cc-haha)或板块对不上。
- **PPT/PPTX 专项解析**:全仓库 2245 个文件 grep 过,【未找到】任何 PPT 解析示例——这仓库没有"怎么解析 PPT"的现成答案。

## 四、来源

仓库 https://github.com/Shubhamsaboo/awesome-llm-apps (API 元数据/完整 git tree/各条目 README 与源码均已读,完整 URL 清单在调研原始记录中;结论均标【原文/源码/推断/未找到】)。
