#!/usr/bin/env node
// 把 FastAPI 后端用 PyInstaller 打成单可执行(--onedir)，供 electron-builder 作 extraResources 塞进安装包。
// 全本地：打包后用户机器无需装 Python/依赖。
//
// 用法：cd desktop && node scripts/build_backend.js
// 产物：desktop/resources/backend/billiards_backend/（可执行 + 依赖），electron-builder 拷进 app。
//
// 知识库护城河（关键）：
//   ① 本脚本先生成一个一次性 Fernet key；
//   ② 用它跑 server/scripts/build_prompts_pack.py，把明文 prompts/*.yaml 加密成 server/prompts.enc；
//   ③ 把同一个 key 烘进 PyInstaller 入口 desktop_entry.py（os.environ.setdefault）；
//   ④ PyInstaller 用 --add-data 只带【加密块 prompts.enc】+ report_forms，绝不带明文 prompts/ 目录；
//   ⑤ 运行时 PromptEngine 用烘进的 key 解密 bundle 根的 prompts.enc，加载 171 模板。
//   安装包里只有加密块，同行解开包也抄不走知识库（抬高门槛，非绝对不可破）。
//
// ⚠️ PyInstaller hidden-import 地狱：uvicorn/starlette 等动态导入的子模块漏一个，打包后运行时才报
//    ModuleNotFound(打包期不报)。下面 hiddenImports 已按真实依赖列齐；新增依赖要补这里。

const { spawnSync, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "..");      // 仓库根
const SERVER = path.join(ROOT, "server");
const OUT = path.join(__dirname, "..", "resources", "backend");
const ENTRY = path.join(SERVER, "desktop_entry.py"); // PyInstaller 入口(uvicorn 起 main:app)
const PACK_ENC = path.join(SERVER, "prompts.enc");   // 加密知识库块
const KEY_PLACEHOLDER = "__PROMPTS_PACK_KEY__";

// 动态导入、PyInstaller 静态分析抓不到的，逐个列(每加一个后端依赖都回来补)
const hiddenImports = [
  // ── uvicorn 动态加载的协议/事件循环/lifespan 实现（漏一个起不来）
  "uvicorn", "uvicorn.logging", "uvicorn.loops", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
  "uvicorn.protocols", "uvicorn.protocols.http", "uvicorn.protocols.http.auto",
  "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.http.httptools_impl",
  "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
  "uvicorn.protocols.websockets.websockets_impl", "uvicorn.protocols.websockets.wsproto_impl",
  "uvicorn.lifespan", "uvicorn.lifespan.on", "uvicorn.lifespan.off",
  // ── anyio 后端
  "anyio", "anyio._backends._asyncio",
  // ── DB：SQLite + aiosqlite 方言
  "aiosqlite", "sqlalchemy.dialects.sqlite", "sqlalchemy.dialects.sqlite.aiosqlite",
  // ── 校验/邮箱/密码
  "email_validator", "bcrypt",
  // ── 知识库加密（Fernet）+ BYOK 加密
  "cryptography", "cryptography.fernet", "cryptography.hazmat.backends.openssl",
  // ── 农历节日换算 / Excel 导出
  "borax", "borax.calendars", "borax.calendars.festivals2", "openpyxl",
  // ── PDF/Word/PPT 读取（read_file 里懒加载，PyInstaller 静态分析必漏）
  "pypdf", "docx", "pptx", "lxml", "lxml.etree",
  // ── 本会话新增的 agent 模块里【只懒加载、PyInstaller 静态分析可能漏】的（top-level 导入的已自动收）
  "services.agent.output_styles", "services.agent.hooks_config", "services.agent.im_telegram",
  // ── 生视频(火山方舟 Seedance)：generate_video 工具里【懒加载】services.video_service → ark_video，
  //    无任何顶层导入路径，PyInstaller 静态分析必漏 → 不补这里则打包后点"生成视频"运行时 ModuleNotFound。
  "services.video_service", "services.ai.providers.ark_video",
];

// 运行时数据文件：加密知识库块(prompts.enc，放 bundle 根)、报表表单(report_forms)。
// ⚠️ 绝不带明文 prompts/ 目录——护城河。
const sep = process.platform === "win32" ? ";" : ":";
const addData = [];
addData.push(`--add-data=${PACK_ENC}${sep}.`);          // prompts.enc → bundle 根
const reportForms = path.join(SERVER, "report_forms");
if (fs.existsSync(reportForms)) addData.push(`--add-data=${reportForms}${sep}report_forms`);
// 内置技能 / 输出风格（数据目录，运行时 _bundled_*_dir() 从 sys._MEIPASS/<name> 读）—— 必须显式带，否则装出来就丢。
const bundledSkills = path.join(SERVER, "skills");
if (fs.existsSync(bundledSkills)) addData.push(`--add-data=${bundledSkills}${sep}skills`);
const bundledStyles = path.join(SERVER, "output-styles");
if (fs.existsSync(bundledStyles)) addData.push(`--add-data=${bundledStyles}${sep}output-styles`);
// bge 语义模型(~90MB)：构建期下到 .fastembed-model/fastembed_cache/，--add-data 进包根的
// fastembed_cache/。装机后 embedder.py 据 sys._MEIPASS 找它、离线直接语义嵌入(不联网下载)。
const fembedCache = ensureFastembedModel();
if (fembedCache) addData.push(`--add-data=${fembedCache}${sep}fastembed_cache`);

function ensureFastembedModel() {
  // 构建期把 bge-small-zh 语义模型下到 .fastembed-model/fastembed_cache/(gitignore)，供 --add-data 进包。
  // 已下过就复用(下一次构建不重下)。下载失败返回 null → 不打模型，运行时自动回退词面嵌器(不崩)。
  const cacheDir = path.join(__dirname, "..", ".fastembed-model", "fastembed_cache");
  const hasModel = () => fs.existsSync(cacheDir) &&
    fs.readdirSync(cacheDir).some((d) => d.toLowerCase().includes("bge-small-zh"));
  if (hasModel()) { console.log("② bge 语义模型已就绪(复用) →", cacheDir); return cacheDir; }
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log("② 下载 bge-small-zh 语义模型(~90MB) →", cacheDir, "…");
  const r = spawnSync("uv", ["run", "python", "-c",
    `from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-zh-v1.5', cache_dir=r'${cacheDir}'); print('bge ready')`],
    { cwd: SERVER, stdio: "inherit" });
  if (r.status !== 0 || !hasModel()) { console.error("⚠️ bge 模型下载失败，本次不打包模型(运行时回退词面嵌器)"); return null; }
  return cacheDir;
}

function genFernetKey() {
  // 用后端环境的 cryptography 生成一个 Fernet key（与解密同库，避免格式不匹配）
  const out = execSync(
    `uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`,
    { cwd: SERVER, encoding: "utf-8" }
  );
  return out.trim();
}

function buildPromptsPack(key) {
  console.log("① 加密知识库 → server/prompts.enc …");
  const r = spawnSync("uv", ["run", "python", "scripts/build_prompts_pack.py"], {
    cwd: SERVER,
    stdio: "inherit",
    env: { ...process.env, PROMPTS_PACK_KEY: key },
  });
  if (r.status !== 0) { console.error("❌ 知识库加密失败"); process.exit(1); }
  if (!fs.existsSync(PACK_ENC)) { console.error("❌ prompts.enc 未生成"); process.exit(1); }
}

function bakeKeyIntoEntry(key) {
  // 把 key 烘进 desktop_entry.py（替换占位符）。先复位再替换 —— 让构建可重复。
  console.log("② 把知识库 key 烘进 desktop_entry.py …");
  let src = fs.readFileSync(ENTRY, "utf-8");
  src = src.replace(
    /os\.environ\.setdefault\("PROMPTS_PACK_KEY", "[^"]*"\)/,
    `os.environ.setdefault("PROMPTS_PACK_KEY", "${KEY_PLACEHOLDER}")`
  );
  src = src.replace(KEY_PLACEHOLDER, key);
  fs.writeFileSync(ENTRY, src);
}

function restoreEntryPlaceholder() {
  // 构建后把入口里的真实 key 复位回占位符，别把密钥写死提交进仓库。
  let src = fs.readFileSync(ENTRY, "utf-8");
  src = src.replace(
    /os\.environ\.setdefault\("PROMPTS_PACK_KEY", "[^"]*"\)/,
    `os.environ.setdefault("PROMPTS_PACK_KEY", "${KEY_PLACEHOLDER}")`
  );
  fs.writeFileSync(ENTRY, src);
}

function runPyInstaller() {
  console.log("③ PyInstaller 打包后端…(首次较慢)");
  fs.mkdirSync(OUT, { recursive: true });
  const args = [
    "run", "pyinstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "billiards_backend",
    "--distpath", OUT,
    "--workpath", path.join(__dirname, "..", ".pyinstaller-build"),
    "--specpath", path.join(__dirname, "..", ".pyinstaller-build"),
    ...hiddenImports.flatMap((m) => ["--hidden-import", m]),
    // collect-all：把整个包的子模块/数据/动态库都收进来（这些库内部大量动态 import）
    "--collect-all", "uvicorn",
    "--collect-submodules", "sqlalchemy",
    "--collect-all", "borax",
    "--collect-all", "email_validator",
    // MCP 官方 SDK + 其动态 import 的依赖（mcp 内部 + jsonschema/referencing 动态加载校验器）
    "--collect-all", "mcp",
    "--collect-all", "jsonschema",
    "--collect-all", "jsonschema_specifications",
    // 语义检索(店脑/知识"按意思找料")：把 fastembed + onnxruntime 收进包，bge 模型(~90MB)经
    // 上面 addData 预打包 → 装机后离线直接语义嵌入(不再退化成词面匹配)。这俩库内部大量动态
    // import + 原生动态库，必须 --collect-all 才收全。torch 不需要(fastembed 用 onnxruntime 推理)继续排除。
    "--collect-all", "fastembed",
    "--collect-all", "onnxruntime",
    "--exclude-module", "torch",
    ...addData,
    ENTRY,
  ];
  const r = spawnSync("uv", args, { cwd: SERVER, stdio: "inherit" });
  if (r.status !== 0) { console.error("❌ 后端打包失败，退出码", r.status); process.exit(1); }
}

function main() {
  const key = genFernetKey();
  buildPromptsPack(key);
  bakeKeyIntoEntry(key);
  try {
    runPyInstaller();
  } finally {
    restoreEntryPlaceholder(); // 无论成败都复位，避免把密钥写死进入口源码
  }
  console.log(`✅ 后端打包完成 → ${OUT}/billiards_backend/`);
  console.log("（electron-builder 经 extraResources 把它拷进安装包 resources/backend）");
}

main();
