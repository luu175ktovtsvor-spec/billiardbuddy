/** §2 Phase-0 风险闸:三个原生/运行时依赖在 Bun 下各跑一次,记 ok/回退。
 *  用变量说明符 import(spec) → tsc 不做模块解析(any),故删掉 spike 重依赖后本脚本仍 typecheck 通;
 *  真跑前先按需装:bun add sharp @huggingface/transformers smart-whisper(+ bun pm trust 跑原生 postinstall)。
 *  结论落 ts/docs/W1-native-plugin-findings.md。 */
type Finding = { name: string; ok: boolean; detail: string }
const findings: Finding[] = []

// 变量说明符:避免 tsc 在依赖未装时报 TS2307;缺包时运行时抛、被 catch 记为 fail。
async function tryImport(spec: string): Promise<any> {
  return await import(spec)
}

// (a) 图像:sharp(原生 libvips)。研究说能跑;不行退 Bun.Image(1.3.14 内置)。
try {
  const sharp = (await tryImport('sharp')).default
  const b = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer()
  findings.push({ name: 'sharp', ok: b.length > 0, detail: `png ${b.length}B · libvips ${sharp.versions?.vips ?? 'n/a'}` })
} catch (e) {
  findings.push({ name: 'sharp', ok: false, detail: `failed: ${(e as Error).message}` })
}

// (b) 嵌入:@huggingface/transformers 的 Node build 走原生 onnxruntime-node(device cpu),不是 WASM
//     (WASM 后端只在浏览器 build)。生产模型 bge-m3 的精确验证在 W7。
try {
  const { pipeline } = await tryImport('@huggingface/transformers')
  const extract = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: 'cpu' })
  const out = await extract('台球 billiards', { pooling: 'mean', normalize: true })
  findings.push({ name: 'transformers.js(onnxruntime-node cpu)', ok: !!out, detail: `dims=${JSON.stringify(out.dims)}` })
} catch (e) {
  findings.push({ name: 'transformers.js', ok: false, detail: `failed: ${(e as Error).message}` })
}

// (c) whisper.cpp N-API 绑定:能否在 Bun 下加载(node-gyp 编出的 .node)。全量转录验证在 W9。
try {
  const mod = await tryImport('smart-whisper')
  findings.push({ name: 'whisper(smart-whisper N-API)', ok: !!mod?.Whisper, detail: `loaded: ${Object.keys(mod).slice(0, 4).join(',')}` })
} catch (e) {
  findings.push({ name: 'whisper', ok: false, detail: `load failed under Bun: ${(e as Error).message}` })
}

console.log(JSON.stringify(findings, null, 2))
const failed = findings.filter(f => !f.ok)
console.log(`\n${findings.length - failed.length}/${findings.length} OK. 失败项走回退(Node 子进程 / 纯 JS)。`)
if (failed.length) process.exit(1)
