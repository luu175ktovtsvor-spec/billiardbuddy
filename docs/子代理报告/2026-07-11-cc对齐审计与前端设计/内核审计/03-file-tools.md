# 文件工具(read/write/edit/patch)cc-haha 对齐差异审计

> 只读审计,两仓库均未改动。spec = `~/Desktop/cc-haha-ref` 当前源码(非文档)。现状 = `/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树未提交改动已计入)。

## 范围与方法

- cc 侧亲读:`src/tools/FileReadTool/{FileReadTool,prompt,limits}.ts`、`src/tools/FileWriteTool/{FileWriteTool,prompt}.ts`、
  `src/tools/FileEditTool/{FileEditTool,utils,types,prompt}.ts`、`src/tools/NotebookEditTool/NotebookEditTool.ts`、
  `src/utils/{file,fileRead,fileHistory,readFileInRange}.ts`、`src/constants/{files,apiLimits}.ts`、`src/tools.ts`。
- 我方亲读:`ts/src/tools/{fileReadTool,fileIoSafety,fileWriteTool,fileEditTool,fileHistory,fileHistoryTool,notebookEditTool,imageRead,pdfRead}.ts`、
  `ts/src/tools/Tool.ts`、`ts/src/harness/loop.ts`(image/document sink 接线)、`ts/src/server/services/sessionRewindService.ts`、
  `ts/docs/alignment-notes.md`(项目自己记录的有意分叉)、`ts/src/tools/fileTools.test.ts`(用测试断言反向验证真实行为,不采信代码注释里的"已对齐"说法)。

---

## 发现表

| # | 行为点 | cc 行为 + file:line | 我们 + file:line 或"缺" | 分类 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|
| 1 | **行号格式(cat -n)** | Read 结果强制加行号,紧凑格式 `N\t`(或旧版 `     N→`);`addLineNumbers` `~/Desktop/cc-haha-ref/src/utils/file.ts:290-319`,调用点 `FileReadTool.ts:730-732`;prompt 显式声明 `Results are returned using cat -n format` `FileReadTool/prompt.ts:20`;Edit 工具 prompt 要求模型剥离该前缀 `FileEditTool/prompt.ts:9-18` | **缺**。`read_file` 直接回原始 `content`(整读见 `ts/src/tools/fileReadTool.ts:112`,分段读 `buildFocusedRead` `ts/src/tools/fileReadTool.ts:349-380` 也不加行号)。测试断言实锤:`fileTools.test.ts:35-38` `expect(...).toBe('hello')`(裸内容,零前缀)。全仓 grep `addLineNumbers`/`cat -n` 命中为零 | gap | **P0** | M |
| 2 | 整文件读字节上限 | `maxSizeBytes` 默认 256KB(`MAX_OUTPUT_SIZE` `utils/file.ts:48`),仅在**无 limit** 时对**整文件大小**做 pre-read 校验、超限直接 throw(不截断)`readFileInRange.ts:95-101` | **阈值精确对齐**:`FULL_READ_MAX_BYTES = 256*1024` `ts/src/tools/fileIoSafety.ts:81`,同样 pre-read throw 不截断 `ts/src/tools/fileReadTool.ts:93-98` | aligned | — | — |
| 3 | 整文件读 token 二级上限 | 除字节上限外还有 `maxTokens` 默认 25000,读后用 `roughTokenCountEstimationForFileType` + 可选 API 精确计数二次校验、超限 throw `FileReadTool.ts:760-777`,`limits.ts` `DEFAULT_MAX_OUTPUT_TOKENS=25000` | **缺**:无任何 token 估算/二次校验,只有字节上限一层闸 | gap | P2 | M(需要 token 估算基建,非本模块单文件能补) |
| 4 | 同范围重复读去重(file_unchanged stub) | offset/limit 与上次相同且 mtime 未变 → 返回 `file_unchanged` stub 而非整段内容,省 token `FileReadTool.ts:541-578`,`mapToolResultToToolResultBlockParam` 的 `file_unchanged` 分支 `FileReadTool.ts:691-696`,文案 `prompt.ts:14` | **缺**:`ctx.fileReads` 只记 mtime/size 供写前校验用,`read_file` 每次都全量返回,无 dedup/stub 机制 | gap | P2 | S-M |
| 5 | 图片视觉 content-block 通道 | Read 命中图片扩展名 → base64 image content-block 直接进 `tool_result.content` `FileReadTool.ts:882-908` 生成、`mapToolResultToToolResultBlockParam` image 分支 `FileReadTool.ts:659-674`;按 vision token 预算用原生 sharp 重采样 `readImageWithTokenBudget` | **已做,机制对齐**:`imageRead.ts` 純代码判格式/宽高/token 估算,`fileReadTool.ts:74-81,471-506` 组装,`ctx.imageResultSink` 由 `loop.ts:966-972` 串行一一对应组进 tool_result content(`Tool.ts:90-95`)。**唯一差**:超 vision 预算时 cc 用 sharp 降采样再送,我们无重采样能力、原图直送 + 文本提示(`fileReadTool.ts:429-430` 注释已自认) | deviation(已知自认的能力缺口,非漏抄) | P2 | L(需要图像处理原生库) |
| 6 | PDF 文档视觉 content-block 通道 | 命中 PDF → 作为顶层 `document` block 随补充 user 消息喂给模型(`newMessages`),`tool_result` 本身只回元信息文本 `FileReadTool.ts:1016-1033`;>10 页且未给 `pages` 直接报错要求用 `pages` 分页(`PDF_AT_MENTION_INLINE_THRESHOLD=10` `FileReadTool.ts:966-972`);超 `PDF_EXTRACT_SIZE_THRESHOLD`(3MB)或模型不支持整份 PDF 时走 poppler 逐页转图像块降级 | **主干已做,机制对齐**:`pdfRead.ts` 纯代码生成 document block,`fileReadTool.ts:84-88,444-461` 组装,`ctx.documentResultSink` 由 `loop.ts:623-625,714-722` 组进尾随 user 消息顶层块(与 cc 的 `newMessages` 语义一致)。**缺**:`pages` 参数完全忽略(自认见 `fileReadTool.ts` description/schema 注释)、无 20 页/请求上限、无 >10 页报错闸、无 poppler 降级路(说明文字已自认"只走文档块直送") | deviation(部分已做+已知子缺口) | P1 | M(pages 分页闸)/L(poppler 降级路,需要外部二进制) |
| 7 | Notebook(.ipynb)**读**结构化通道 | Read 命中 `.ipynb` → 解析 cells、按 cell 拆分 text/image 输出块,`mapNotebookCellsToToolResult` 生成结构化 `tool_result`(含每个 cell 的 image 输出转真图像块)`FileReadTool.ts:838-880`,超大小给 jq 用法提示而非硬读 | **完全缺**:`read_file` 无 `.ipynb` 分支(`grep ipynb/notebook` 在 `fileReadTool.ts`/`fileIoSafety.ts` 零命中),`.ipynb` 不在二进制黑名单 → 落进通用文本分支,原样吐整份 JSON(含 base64 图片输出、metadata 噪声),模型看不到结构化 cell/图像视觉渲染 | gap | **P1** | M(结构化解析不难,视觉输出转图像块工作量稍大) |
| 8 | Notebook **编辑** | `NotebookEditTool`:replace/insert/delete,cell_id 或 `cell-N` 兜底索引,按 `nbformat`/`nbformat_minor` 决定是否生成新 cell id `NotebookEditTool.ts:379-390`,写前必须先 Read `NotebookEditTool.ts:218-237` | **对齐良好**:`notebookEditTool.ts` 逻辑几乎逐一对应(`shouldEmitCellIds` `notebookEditTool.ts:213-217` 判据与 cc 一致;replace/insert/delete 三态、cell-N 兜底解析均有)。唯一联动缺口是上面 #7——"先 Read" 校验存在,但那次 Read 给模型看到的是未结构化原始 JSON | aligned(编辑本身) | — | — |
| 9 | 危险设备路径拦截 | `BLOCKED_DEVICE_PATHS` 12 项(`/dev/zero,random,urandom,full,stdin,tty,console,stdout,stderr,/dev/fd/{0,1,2}`)+ `/proc/*/fd/{0,1,2}` 前缀匹配,只做字符串比较不做 IO,`/dev/null` 故意放行 `FileReadTool.ts:97-129`,pre-read 校验 `FileReadTool.ts:488-496` | **字节级对齐**:`BLOCKED_DEVICE_PATHS` 集合与判定函数逐项相同 `ts/src/tools/fileIoSafety.ts:15-44`,pre-read 调用点 `ts/src/tools/fileReadTool.ts:70-72` | aligned | — | — |
| 10 | UTF-16/UTF-8-BOM 编码探测 | 只识别 UTF-16LE BOM(`FF FE`)→`utf16le`;`EF BB BF` 探测到但仍回 `utf8`(因为 `Buffer.toString('utf8')` 本就不剥离该字节序列,原样往返);其余一律 `utf8`,`detectEncodingForResolvedPath` `fileRead.ts:20-49` | **判定表逐字对齐**:`detectEncodingFromBuffer` `ts/src/tools/fileIoSafety.ts:51-55` 同一决策表(只测 buffer 头部,非读已解析路径,功能等价) | aligned | — | — |
| 11 | CRLF 行尾归一化往返(**Read 显示层 LF 化 + Edit 内部 LF 空间处理 + 写回按原文件行尾重建**) | Read 展示内容强制 LF(`readFileInRange` 逐行剥 `\r` `readFileInRange.ts:162-181` 快路径、`254-260`/`306-310` 流式路径);Edit 读入时 `raw.replaceAll('\r\n','\n')` 全部转 LF 做匹配 `fileRead.ts:88-97`,写回时按检测到的原始行尾类型把 LF 转回 CRLF `writeTextContent` `file.ts:84-98`,`FileEditTool.ts:447-491` 全链路都在用 `readFileSyncWithMetadata`/`writeTextContent` 保这个往返 | **完全缺(Read/Edit 均未处理,仅 patch_file 例外)**:`read_file` 只 `buffer.toString(encoding)` + 剥 BOM,不动 `\r` (`ts/src/tools/fileReadTool.ts:109-110`);`edit_file`/`multi_edit_file` 的 `readFileForEdit` 同样不做 CRLF→LF 归一化(`ts/src/tools/fileEditTool.ts:443-448`),`old_string`/`new_string` 直接在带 `\r` 的原始内容上做字符串匹配——若文件是 CRLF 行尾而模型按 Read 展示的内容(同样带 `\r`,因为我们没剥)组 `old_string` 理论上还能碰巧命中,但只要模型习惯性只用 `\n` 组 `old_string`(cc 生态的通用假设)就会匹配失败或产生 `\r\n`/`\n` 混合的脏文件。唯独 `patch_file`/`patch_files` 的 `applyUnifiedPatch` 自己做了 `\r\n`→`\n` 归一化再按检测到的换行符重建(`ts/src/tools/fileEditTool.ts:505,551-553`),`edit_file`/`multi_edit_file` 无此保护。`fileTools.test.ts` 全文 grep 无一条 CRLF 用例 | gap | **P1** | M(复用 patch_file 已有的 CRLF 检测/重建逻辑即可,非从零写) |
| 12 | old_string 唯一性 + replace_all | 多处匹配且 `replace_all` 为假 → 报错列出匹配数,提示放大上下文或设 `replace_all` `FileEditTool.ts:329-343`;quote 归一化匹配 `findActualString` `utils.ts:73-93` | **对齐**:`fileEditTool.ts:134-140,202-205` 同语义报错;归一化匹配范围**更宽**(见下条) | aligned(核心语义) | — | — |
| 13 | Edit/Write 引擎模糊匹配范围 | 仅**弯引号→直引号**归一化(`'‘’“”'`4 个字符)`utils.ts:21-37`,无空白容差、无其它标点归一化 | **更宽的归一化**:`PUNCT_EQUIV` 覆盖 14 组中文标点(，。：；！？（）【】｛｝、及中文引号)`ts/src/tools/fileEditTool.ts:79-97`,`normalizeForMatch`/`findMatches` `ts/src/tools/fileEditTool.ts:464-489`。产品面向中文用户,判断是合理的主动加宽,但严格讲不在四类"有意分叉"白名单里 | deviation(疑似合理但未登记为官方 intentional-delta) | P2(建议登记进 alignment-notes.md,非代码改动) | S |
| 14 | 归一化匹配后,新字符串的引号风格回填 | 当 `old_string` 靠弯引号归一化才匹配上时,把同样的弯引号风格套回 `new_string`,保持文件原有排版 `preserveQuoteStyle` `utils.ts:104-199`,调用点 `FileEditTool.ts:474-479` | **缺**:`applyReplacements` 直接用原始 `input.new_string` 替换,不做任何回填 `ts/src/tools/fileEditTool.ts:492-502` | gap | P2(体验细节) | S |
| 15 | Write 覆盖已存在文件前必须先 Read | `validateInput`:无 `readTimestamp`(或 `isPartialView`,仅用于"自动附件/非显式 Read 注入"场景,不含真实 offset/limit 范围读)→ 拒绝 `FileWriteTool.ts:198-206`;文件不存在时直接放行(可创建新文件,不需要先读)`FileWriteTool.ts:186-196` | **对齐**:`assertFreshOverwrite` 同语义——文件不存在放行,存在则要求 `ctx.fileReads.get(abs)` 命中 `ts/src/tools/fileWriteTool.ts:51-61`。注:cc 的 `isPartialView` 标记只用于给"未经真实 Read 工具调用、只是自动注入上下文"的文件(如 CLAUDE.md/记忆文件)打标,真实带 offset/limit 的显式 Read **不会**触发该标记——我方没有等价"自动注入"概念,因此这条不构成漏抄 | aligned | — | — |
| 16 | Write/Edit 写前 staleness 二次校验(防外部改动覆盖) | mtime 变化时,若是"整读"(`offset===undefined && limit===undefined`)且内容比对完全相同 → 仍放行(容忍 Windows 云同步/杀软只改 mtime 不改内容的假阳性)`FileWriteTool.ts:279-295`、`FileEditTool.ts:451-468`;否则报 `FILE_UNEXPECTEDLY_MODIFIED_ERROR` | **弱化版**:只比对 `mtimeMs`+`size` 是否等于读时快照,不做内容兜底比对(`ts/src/tools/fileWriteTool.ts:57`、`ts/src/tools/fileEditTool.ts:438`)。多数情况下等价(size 变化时两边结论一致),但 cc 能容忍的"mtime 变了但内容/size 都没变"这类假阳性,我方会误判成"已被外部修改"而拒绝写入 | deviation | P2 | S |
| 17 | Edit 对空 `old_string` 的三种既定语义:①**文件不存在** + `old_string===''` → 视为新建文件(相当于用 Edit 工具建文件)②**文件存在且非空** + `old_string===''` → 拒绝("文件已存在,不能新建")③**文件存在且为空** + `old_string===''` → 放行(空文件写入内容) | `FileEditTool.ts:223-264` 三分支齐全 | **完全缺,且在最上游就被堵死**:`validateInput` 硬性要求 `old_string.length>0`,否则统一报"需要非空 old_string"`ts/src/tools/fileEditTool.ts:384`——不管文件是否存在、是否为空,都无法通过 `edit_file` 传空 `old_string`。等价于 cc 的三种语义在我方**一种都不支持**(①②③全部报同一个错误,不区分场景) | gap | P1(功能缺口,#17 直接对应任务给的"已知待办核对 5. 空文件") | S |
| 18 | 文件不存在时的"你是不是想输入…"提示 | `findSimilarFile`(同目录下同名不同后缀)`file.ts:178-207` + `suggestPathUnderCwd`("掉了仓库目录前缀"模式识别)`file.ts:228-267`,ENOENT 时拼进错误消息 `FileReadTool.ts:613-655`、`FileEditTool.ts:229-238` | **缺**:`read_file` 对 `stat(abs)` 直接 `await`,ENOENT 原样抛出 Node 原生错误(`ENOENT: no such file or directory, stat '...'`),无相似文件名/cwd 前缀纠错提示。全仓 grep "findSimilarFile/did you mean/你是不是想" 在文件工具目录零命中 | gap | P2 | S-M |
| 19 | 读目录报错 | 显式 `stats.isDirectory()` 预检,自定义消息 `EISDIR: illegal operation on a directory, read '${filePath}'` `readFileInRange.ts:89-93`(先于 ENOENT 分支,不会误触发"did you mean") | **无预检,靠 Node 原生 `fs.readFile` 对目录抛的 EISDIR 冒泡**(`ts/src/tools/fileReadTool.ts:99`);错误文案不同但同属 EISDIR 语义,模型都能读懂"这是目录不是文件" | deviation(结果等价,实现方式不同) | P2 | S |
| 20 | 编辑超大文件保护(防整读 OOM) | `MAX_EDIT_FILE_SIZE = 1024*1024*1024`(1GiB),pre-read `stat` 校验,超限报错并给出人类可读大小 `FileEditTool.ts:79-84,185-200` | **数值对齐**:`MAX_EDIT_FILE_SIZE = 1024*1024*1024` `ts/src/tools/fileIoSafety.ts:143`,pre-write `stat` 校验 `ts/src/tools/fileEditTool.ts:430-437` | aligned | — | — |
| 21 | 二进制扩展名黑名单(非 PDF/图片时报错、不当文本硬读) | `BINARY_EXTENSIONS` 约 90 项(图片/视频/音频/压缩/可执行/Office/字体/字节码/数据库/设计稿/Flash/lock 等)`constants/files.ts:5-112`,`hasBinaryExtension` 判定 `constants/files.ts:117-120`,Read 排除 PDF/图片走视觉通道 `FileReadTool.ts:474-486` | **逐项对齐**:`BINARY_EXTENSIONS` 集合与 cc 完全一致(同分类同数量)`ts/src/tools/fileIoSafety.ts:88-113`,`hasBinaryExtension` `ts/src/tools/fileIoSafety.ts:116-120`,调用点排除 PDF/图片同理 `ts/src/tools/fileReadTool.ts:74-92`;另加一层"内容嗅探"(`looksBinaryBuffer`,NUL 字节/控制字符占比)覆盖扩展名伪装场景,cc 该逻辑存在于 `constants/files.ts:131-156`(`isBinaryContent`)但**未见被 FileReadTool 实际调用**(cc 只在 pre-read 靠扩展名判断,没有内容嗅探兜底)——我方反而比 cc 多一层防御 | aligned(核心)+ deviation(我方多一层内容嗅探,更严格,属加固非缺口) | — | — |
| 22 | 分段读(offset/limit)的字节上限 | 只有整读(无 `limit`)才传 `maxBytes`;显式给了 `limit` 的分段读**不设字节上限**,只受读完之后的 `maxTokens`(25000)后验校验 `FileReadTool.ts:501-521`(`limit === undefined ? maxSizeBytes : undefined`) | **额外加了硬字节闸**:`DEFAULT_RANGE_BYTES=120_000`/`MAX_RANGE_BYTES=300_000` `ts/src/tools/fileReadTool.ts:23-24`,`buildFocusedRead` 内按此截断并打 `truncated_bytes` 标记 `ts/src/tools/fileReadTool.ts:349-380`。无 token 估算基建时的合理替代品,但行为确实与 cc 不同(cc 允许长范围只要塞进 25000 token) | deviation(合理但未登记) | P2 | S(登记进 alignment-notes.md 即可,非代码改动) |
| 23 | fileHistory / checkpoint 存储模型 | `FileHistorySnapshot` 以 **user 消息级** 快照为键,`trackedFileBackups` 记录该时刻"正在追踪的全部文件"各自 backup,`fileHistoryRewind` 按快照批量恢复/删除 `fileHistory.ts` 全文 | **不同存储形状,行为等价并已自证**:每次真实写前记一条 per-file `FileHistoryRecord`(绑定发起写的 **assistant 消息** uuid),`SessionRewindService` 按"user 消息区间"聚合、批量恢复多文件,详见 `ts/src/tools/fileHistory.ts` + `ts/src/server/services/sessionRewindService.ts` + 项目自己写的对齐笔记 `ts/docs/alignment-notes.md`(逐条写清 cc 怎么做/我们怎么做/为什么不一样,含"部分失败无回滚"等继承风险的如实记录) | **intentional-delta**(存储红线③:append-only JSONL 无 SQL,决定了不能照抄 cc 的 in-memory 快照结构) | — | — |
| 24 | 工具集范围 | 当前 `tools.ts:204-207` 只注册 `Read/Edit/Write/NotebookEdit` 四个文件工具,**无** MultiEdit、**无**任何 unified-diff/patch 工具(`grep MultiEditTool/ApplyPatch/PatchTool` 在 `src/tools/`、`src/tools.ts` 均零命中) | **多出三个 cc 当前没有的工具**:`multi_edit_file`(单文件多组 old_string/new_string 原子应用)、`patch_file`/`patch_files`(unified diff hunk 引擎,含上下文不匹配时的"附近候选行"纠错提示)`ts/src/tools/fileEditTool.ts:161-365`。这不是漏抄,是产品自建的能力扩展(题面模块范围明确要求审计 patch 引擎,故列出以说明:这套 patch 引擎在 cc 当前源码里没有对应物,无法做"跟 cc 判得一模一样"的行为对齐,只能自建测试锁边界) | deviation(功能性新增,非缺口) | — | — |

---

## 已知待办核对结果

1. **图片/PDF/notebook 视觉 content-block 通道(架构级缺口)** — **部分仍缺,部分已做**(推翻"整体缺失"的旧认知)：
   - 图片:**已做**,机制对齐(见发现 #5),差距仅在无重采样能力这一点自认的能力缺口。
   - PDF:**已做**,机制对齐(见发现 #6),但缺 `pages` 分页闸/>10 页报错/poppler 降级路径。
   - Notebook:**仍缺**(见发现 #7)—— `read_file` 完全没有 `.ipynb` 结构化分支,原样吐整份 JSON;`NotebookEdit` 工具本身写得不错(发现 #8),但看不到干净的读侧支撑它。

2. **整文件读大小上限(据称 9957154 已做)** — **已做且阈值精确对齐**:256KB(`0.25*1024*1024`)一字不差,行为(pre-read 抛错不截断)也对齐。见发现 #2。唯一缺的是 cc 还有一层 token 数二级上限(发现 #3),我方没有。

3. **UTF-16/BOM 保留** — **探测逻辑真做了,精确对齐**(发现 #10):只认 UTF-16LE BOM,EF BB BF 仍归 utf8,和 cc `detectEncodingForResolvedPath` 判定表逐字一致。**但"保留"不完整**:编码保留了(写回复用探测到的 encoding),**行尾(CRLF/LF)没有保留/往返**(发现 #11)——这是本次审计新挖到的真缺口,不在"已知待办"原始四项里但直接关联"BOM/编码处理"这条审计维度,建议并入同一条待办跟踪。

4. **危险设备路径拦截** — **已做,清单与 cc 完全一致**(发现 #9),12 项设备路径 + `/proc/*/fd/{0,1,2}` 前缀规则逐项对齐,无遗漏无多余。

5. **P6 行为对齐:同输入两边返回结构逐条对比**
   - 不存在文件:cc 有"你是不是想输入…"纠错提示,我方**无**(发现 #18,gap)。
   - 目录:两边都靠 EISDIR 语义报错,文案不同但结果等价(发现 #19,deviation 但不构成功能缺口)。
   - 空文件:cc 的 Edit 工具支持对空文件传空 `old_string` 写入内容,我方**完全不支持**(发现 #17,gap,直接对应本条待办)。
   - 超长行:两边均未发现任何单行截断特判,无差异可报。
   - 二进制:黑名单逐项对齐(发现 #21),我方还多一层内容嗅探兜底(更严格)。

6. **fileHistory/backup 链(messageId 绑定的 per-write 前像记录)vs cc trackedFileBackups(per-user-message 快照)** — **行为等价,且是项目自己审查过并写了对齐笔记的 intentional-delta**(发现 #23)。存储形状不同(per-write 记录 vs per-message 快照)是 append-only JSONL 红线决定的,但通过 `SessionRewindService` 按轮次聚合,对外"按某条历史消息回退、批量恢复多文件"的行为与 cc 语义对齐,且笔记里如实记录了"部分失败无回滚"（cc 原实现同样没处理,继承风险）和"工作区外文件回滚未覆盖"两处已知局限。这条**不是缺口**,是审计应确认"文档属实"的少数几条之一——确认属实。

7. **Write 覆盖已存在文件必须先 Read 的闸** — **两边一致**(发现 #15)。文件不存在时都放行创建,存在时都要求命中读快照。cc 有一个我方没有的旁支概念(`isPartialView`,专门给"未经真实 Read 调用就被自动注入上下文的文件"如 CLAUDE.md 打标,逼这类文件也要走真 Read 才能写)——我方没有对应的"自动注入上下文"机制,所以这条不构成漏抄,只是两边的"上下文注入模型"本身不同。

---

## 统计与 Top 5 gap 摘要(供最终回复引用)

- aligned: 9 条(#2,#9,#10,#12,#15,#16→其实是 deviation 不是 aligned,已按分类表为准,#20,#21,#8 编辑侧)
- gap: 8 条(#1,#3,#4,#7,#11,#14,#17,#18)
- deviation: 6 条(#6 部分,#13,#16,#19,#22,#5 部分)
- intentional-delta: 1 条(#23,已有文档佐证)
- deviation(功能新增,非缺口): 1 条(#24)

Top 5(P0/P1)：
1. **#1 P0** — Read 完全没有 cat-n 行号,`fileTools.test.ts:37` 测试实锤返回裸内容,cc 全套"行号前缀+Edit 剥前缀"约定在我方不存在。
2. **#11 P1** — CRLF 文件读/编辑不做行尾归一化往返(仅 patch_file 例外),Windows 风格换行文件 `edit_file` 大概率匹配失败或写出 `\r\n`/`\n` 混合脏内容。
3. **#7 P1** — Notebook 读无结构化通道,`.ipynb` 当普通文本整份吐 JSON(含 base64 图片输出噪声),`NotebookEdit` 工具本身写得对但读侧拖后腿。
4. **#17 P1** — `edit_file` 硬性拒绝空 `old_string`,cc 支持的"空 old_string 建新文件/写入空文件"三种语义在我方一种都不通。
5. **#6 P1** — PDF 通道主干已做,但 `pages` 分页参数完全忽略、无 >10 页报错闸、无 poppler 逐页降级路,大 PDF 场景体验落后 cc。
