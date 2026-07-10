# R5 · MCP 修复批验证式审核

审对象:`ts/src/mcp/sanitization.ts`(新)、`ts/src/mcp/binaryStorage.ts`(新)、`ts/src/mcp/client.ts`、`ts/src/agents/agentMcp.ts`、`ts/src/server/index.ts`(超时硬编码删除)。
Spec = `~/Desktop/cc-haha-ref`(`src/utils/sanitization.ts`、`src/services/mcp/client.ts`、`src/utils/mcpOutputStorage.ts`、`src/tools/ReadMcpResourceTool/`)。
方法:逐文件对照 cc 源码亲读 + 全仓 grep 复核数字性声明 + 自写扫描脚本 + `bun test`/`typecheck` 真跑。未改任何源文件。

## CONFIRMED(实锤)

### C1. 工具调用结果里"embedded resource"内容块是图片时,未走视觉回灌,与 cc 行为不一致
- 我们:`ts/src/mcp/client.ts:139-156`(`formatContentBlock`)对 `block.type === 'resource'` 分支(143-151 行)**无条件** `persistMcpBinary` 落盘 + 回 `blobSavedTo` 文字引用,完全不检查 `resource.mimeType` 是否为图片,也从不消费 `route.imageResultSink`(即便调用方 `formatMcpResult`→`executeMcpTool` 传进来的 `route` 明明带着 `imageResultSink`)。
- cc:`~/Desktop/cc-haha-ref/src/services/mcp/client.ts:2515-2551`(`transformResultContent` 的 `case 'resource':` 分支)显式 `isImage = IMAGE_MIME_TYPES.has(resource.mimeType)`,是图片就解码→降采样→组成真实 `type:'image'` 内容块送视觉,只有非图片才落盘。
- 影响:MCP 工具若把截图/生成图**包成 `resource` 内容块**返回(而非顶层 `type:'image'`,规范内合法且部分 server 会这么做,如某些浏览器/文档类工具用 embedded resource 携带图),模型看不到图,只拿到一句"已落盘"的文字——原始审计 finding #17("多模态 MCP server 完全瘸腿")在这条子路径上只修了一半。
- 顶层 `type:'image'` 块本身已验证正确接线(见下方"已验证正确"C2),这条只影响 embedded-resource-as-image 这一种子形态。
- 未见任何测试覆盖这条路径(`client.test.ts` 全文 grep `type: 'resource'` 在测试里 0 命中);代码注释(174-176 行)只提到"prompt 里的 resource 复用同一实现"顺带落盘,没有任何地方标注"这与 cc 对 tool-result 里 image-resource 的处理不同"。判定为未披露的部分回归,不是明确的已知取舍。

## PLAUSIBLE(有疑点,非铁证)

### P1. 大图无尺寸/字节上限,无降采样,可能撑爆上下文/触发供应商 413
- `formatImageContentBlock`(`client.ts:122-130`)对可视觉格式无条件 `Buffer.from(block.data,'base64')` 全量解码 + 整图 push 进 `imageResultSink`(`toImageBlock` 仍整图 base64,未做 resize/降采样),没有任何字节数/像素数上限检查。
- cc 对应路径用原生 `sharp`(`maybeResizeAndDownsampleImageBuffer`)做降采样,强制符合 API 尺寸上限;本仓库代码自己在注释里承认"无原生图像库,不做降采样"(client.ts:120-121),这是项目级已知取舍(与 `tools/imageRead.ts` 里 `read_file` 的同款遗留一致),不是本批次引入的新洞,但复核时任何数十 MB 的 MCP 截图/生成图结果都会被整段送进模型上下文——建议至少加一个硬字节上限(超限直接落盘不进 vision),不需要真降采样也能兜住 OOM/超支付商限的最坏情况。判 PLAUSIBLE 是因为"是否真的在生产场景发生"未实测(需要真连一个返回大图的 MCP server),但代码逻辑层面风险确凿。

## 已验证正确(逐条过了,没问题)

1. **Unicode 净化算法与 cc 逐行等价**:`ts/src/mcp/sanitization.ts:16-56` 的 NFKC + `[\p{Cf}\p{Co}\p{Cn}]` + 5 组显式 codePoint 范围(零宽/双向格式/双向隔离/BOM/私用区)、`MAX_ITERATIONS=10`,与 `~/Desktop/cc-haha-ref/src/utils/sanitization.ts` 字符范围、类目、迭代上限完全一致,只是把裸转义 `​` 改成 `String.fromCodePoint` 构造以避免源文件里出现真实不可见字符——这是工程手法差异,不改变行为。
2. **NFKC 确实会把中文全角标点折叠成半角 ASCII(自测证实)**:自写脚本对 `"。，！？（）：；"`、全角数字/字母、罗马数字㈧、兼容表意字"㍿"跑 `.normalize('NFKC')`,全部被改写(如"，"→","、"㍿"→"株式会社 株式会社")。**但这与 cc 的行为完全一致**——cc 用同一算法,同样会把中文 MCP server 描述里的全角标点折成半角。判定:非本批次引入的偏差,是"对齐 cc"这个硬指标下的必然代价,值得记录但不构成"做错了"。
3. **净化只作用于 MCP 来源字符串,没有误伤 UI/系统文案**:全仓 grep `partiallySanitizeUnicode`/`recursivelySanitizeUnicode`,除 `sanitization.ts` 自身外只有 `client.ts` 一处引用(10 个调用点全部在 tool/resource/prompt 元数据与结果文本路径上),没有渗到其他模块。
4. **源文件不含真实隐形字符字面量**:自写 Python 扫描脚本对 `sanitization.ts`/`sanitization.test.ts`/`client.ts`/`binaryStorage.ts` 逐字符扫危险 codePoint 区间(含 U+E0000-E007F Tag 字符区),四个文件全部 CLEAN,测试文件也用 `String.fromCodePoint` 构造载荷,没有直接敲进不可见字符。
5. **迭代不动点有死循环上限**:`MAX_ITERATIONS=10`,达到后主动 `throw`(不是死循环),行为与 cc 完全一致;该异常会被 `loop.ts` 里 `executeAllowedToolCall` 的外层 `try/catch`(约第 1004/1041 行一带)兜住转成工具失败反馈,不会打崩整个循环。
6. **sink 缺失时优雅降级**:`formatImageContentBlock` 条件 `detected && isVisionSupported(detected) && route.imageResultSink` 三者都要满足才走视觉,任一缺失(含无会话态的单测/adhoc 调用)都会退到 `persistAndDescribe` 落盘,不抛错不丢数据。
7. **mime 标错不构成安全问题**:图片类型判定完全基于魔数字节嗅探(`detectImageFormat`,PNG/JPEG/GIF/WEBP 签名比对),**不信任声明的 `mimeType`**——这比 cc(直接信 `resource.mimeType`/`IMAGE_MIME_TYPES.has()` 来决定是否走 vision)更稳健:声明 `image/png` 但字节不是真图会被正确挡下落盘,声明 `text/plain` 但字节是真图也不会被这套逻辑用到(因为顶层 `type:'image'` 由协议决定,不是靠 mimeType 判断)。
8. **落盘路径无逃逸**:`binaryStorage.ts:44-47` 的 `safeSegment` 把 `label` 里非 `[a-zA-Z0-9_-]` 字符全部替换成 `_` 且截断 64 字符,空值兜底 `'mcp'`;扩展名 `extensionForMimeType` 是固定 switch-case 白名单(逐行比对与 cc `mcpOutputStorage.ts:66-118` 一致),不认识的一律 `.bin`——`label`/`mimeType` 均不可能拼出 `../` 之类逃逸路径。
9. **无 `toolResultStoreDir` 时退回系统临时目录**:`binaryStorage.ts:68-70` 确认,`join(tmpdir(), 'qf-agent-mcp-binary')`,不阻塞调用方。
10. **超时硬编码删除:声称的 6 处全部核实真删干净,没有第 7 处**:`git diff` 精确定位 `server/index.ts` 5 处(1639/1749/2262/2334/2382 行一带,均替换成注释)+ `agentMcp.ts` 1 处(155 行),全仓 grep `toolTimeoutMs`/`120000`/`120_000` 确认再无 MCP 相关硬编码残留(其余 120000/120_000 命中属于问题超时、hooks 超时、ffmpeg 超时等无关模块)。
11. **`mcpToolTimeoutMs()` 对非法 env 值兜底正确**:`client.ts:487-490`,`Number.isFinite(raw) && raw > 0` 双重校验,未设/非数字/负数三种非法输入均正确回落默认值 100_000_000;比 cc 的 `parseInt(...) || DEFAULT`(cc 对负数完全不设防,`-100 || default` 结果是 `-100`)更严格——这是我方比 cc 更安全的正向偏差,不是缺口。
12. **测试数量与声明一致**:`sanitization.test.ts` 5 个 test 块;`client.test.ts` diff 精确显示新增 6 个 `test(`(P0①净化/P0②image/P0②audio/P0③默认超时/P0③超时真接线/P1 resource blob 落盘),均为真实起 HTTP MCP fixture server 的端到端断言,非假绿(断言里显式排除旧行为字符串,如 `not.toMatch(/\[image .*\]$/)` 确保不是退回占位符)。

## 测试与 typecheck 复验结果

```
bun test src/mcp/      → 23 pass / 0 fail / 118 expect() calls
bun test (全量)         → 1597 pass / 0 fail / 7173 expect() calls
bun run typecheck      → exit 0(tsc --noEmit 全绿,此前 client.ts:552 报错已确认清除)
```

## 裁决建议

- **C1(embedded resource 图片未接视觉)**:建议列入后续小修任务——在 `formatContentBlock` 的 `resource` 分支加一个 `resource.mimeType` 是否可视觉格式的判断,复用 `formatImageContentBlock` 同款逻辑(仅限 `formatMcpResult` 场景,`read_mcp_resource`/prompt 场景维持现状落盘,因为那两处本就是"按 URI 拉资源"而非"工具结果里的视觉回灌",与 cc 的 `ReadMcpResourceTool` 行为本就一致)。不算阻断性 bug(顶层 `image` 块——目前最常见形态——已正确工作),但违反了"对齐 cc"的硬指标,应修。
- **P1(大图无上限)**:建议至少加一个字节数硬顶(如 10-20MB),超限直接走落盘分支不进 vision,防止极端场景撑爆上下文/被供应商拒绝;非本批次独有问题,可与 `read_file` 的同款遗留一并排期。
- 其余全部核实通过,超时/落盘/净化三大块的核心声明均站得住,测试是真链路非假绿。可以在标注上述两点后合入。
