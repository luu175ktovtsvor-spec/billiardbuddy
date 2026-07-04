#!/usr/bin/env node
// 把 FastAPI 后端用 PyInstaller 打成单可执行(--onedir)，供 electron-builder 作 extraResources 塞进安装包。
// 全本地：打包后用户机器无需装 Python/依赖。
//
// 用法：cd desktop && node scripts/build_backend.js
// 产物：desktop/resources/backend/billiards_backend/（可执行 + 依赖），electron-builder 拷进 app。
//
// 知识库护城河（关键）：
//   ① 本脚本先拿一个 Fernet key——CI 上读 env.BUNDLED_PROMPTS_PACK_KEY(与运行时 bundled.env 解密同一把，
//      见 resolveFernetKey 的注释)，本地开发机没设这个变量就随机生成一次性 key；
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

// Windows 上 Python 默认 stdout 是 cp1252,打印脚本里的 ✅/❌/① 等非 ASCII 会 UnicodeEncodeError
// 直接崩(明明加密/打包本身成功了,只是打成功消息时挂)。强制所有 python 子进程用 UTF-8 输出。
// 放在这里 → 下面所有 spawnSync("uv"/python...) 都继承(macOS 本就 UTF-8,设了无副作用)。
process.env.PYTHONUTF8 = "1";
process.env.PYTHONIOENCODING = "utf-8";

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
  // ── 场景方案成品(开业/会员卡/比赛)：make_scene_plan 工具里【懒加载】services.scene_plan.render，
  //    保守起见连同 manifest 一起显式列(与上面 video_service 同款风险，见 D-Task-7)。
  "services.scene_plan.manifest", "services.scene_plan.render",
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
// 视频渲染资产：V2 模板/渲染脚本 + CJK 字体 + whisper 权重。装机出片/口播必需(见审查 P0-2)。
// 运行时用 sys._MEIPASS 解析(template_render._bundled_dir / transcribe / ffbin 的 frozen 分支)。
const videoAssets = path.join(SERVER, "services", "video_edit", "assets");
if (fs.existsSync(videoAssets)) addData.push(`--add-data=${videoAssets}${sep}video_edit_assets`);
const cjkFonts = path.join(SERVER, "assets", "fonts");
if (fs.existsSync(cjkFonts)) addData.push(`--add-data=${cjkFonts}${sep}assets_fonts`);
// 场景方案(开业/会员卡/比赛)成品模板：同一套离屏渲染管道(_render_html_frames)的另一份 template.html，
// 运行时用 sys._MEIPASS 解析(services/scene_plan/render.py 的 _asset 落点，照抄视频模板的打包方式)。
const scenePlanAssets = path.join(SERVER, "services", "scene_plan", "assets");
if (fs.existsSync(scenePlanAssets)) addData.push(`--add-data=${scenePlanAssets}${sep}scene_plan_assets`);
// ⚠️ whisper 口播权重(~1.4G)【不再打进包】——装包会到 1.7G 劝退用户。改成"按需下载":
// 抽出来放 owner 服务器(见 desktop/src/model-downloader.js + bundled.env 的 QF_MODEL_BASE_URL),
// 用户首次打开主界面时后台下、存 userData/models,以后不再下。核心程序装完立刻能用,只口播要等它。
// (ensureWhisperModel 保留:仅用于"把模型下到本地→上传服务器托管"这条运维路径,不进 --add-data。)
console.log("③ whisper 口播权重不打进包(按需下载),安装包体积由此从 ~1.7G 降到 ~500M");

function ensureWhisperModel() {
  // 口播转录用的 faster-whisper-medium(~1.4G)。本地有就复用(开发机/复跑不重下);
  // CI 上没有 → 用 faster_whisper.download_model 下到 server/ml_models/faster-whisper-medium(扁平实体),
  // 供 --add-data 打进包。装机后 transcribe.py 从 sys._MEIPASS/faster-whisper-medium 离线加载。
  // 下载失败返回 null → 不打 whisper,运行时口播不可用但其余功能正常(非致命)。
  const dir = path.join(SERVER, "ml_models", "faster-whisper-medium");
  const hasModel = () => fs.existsSync(path.join(dir, "model.bin"));
  if (hasModel()) { console.log("③ whisper 权重已就绪(复用) →", dir); return dir; }
  fs.mkdirSync(dir, { recursive: true });
  console.log("③ 下载 faster-whisper-medium 权重(~1.4G,较慢) →", dir, "…");
  const r = spawnSync("uv", ["run", "python", "-c",
    `from faster_whisper import download_model; download_model('medium', output_dir=r'${dir}'); print('whisper ready')`],
    { cwd: SERVER, stdio: "inherit" });
  if (r.status !== 0 || !hasModel()) { console.error("⚠️ whisper 权重下载失败，本次不打包(口播转录装机版不可用)"); return null; }
  // 与 bge 同理:HF 下载可能留软链,Windows NSIS 处理软链会报"目录名无效"。就地实体化兜底。
  dereferenceSymlinksInPlace(dir);
  return dir;
}

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
  // HuggingFace 缓存 snapshots/<hash>/*.json 是【软链】指向 ../../blobs/<sha>。PyInstaller 原样打进包后,
  // Windows 上 NSIS 处理这些软链会报"目录名无效"、整个安装包做不出来(Mac 无此限)。就地把软链换成实体文件。
  dereferenceSymlinksInPlace(cacheDir);
  return cacheDir;
}

// 就地把目录树里所有软链替换成其真目标的实体拷贝(bge 缓存的 HF 软链 → 实体,Windows NSIS 才吞得下)。
function dereferenceSymlinksInPlace(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      const real = fs.realpathSync(p);
      const isDir = fs.statSync(real).isDirectory();
      fs.rmSync(p, { force: true });
      if (isDir) fs.cpSync(real, p, { recursive: true, dereference: true });
      else fs.copyFileSync(real, p);
    } else if (e.isDirectory()) {
      dereferenceSymlinksInPlace(p);
    }
  }
}

function genFernetKey() {
  // 用后端环境的 cryptography 生成一个 Fernet key（与解密同库，避免格式不匹配）
  const out = execSync(
    `uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`,
    { cwd: SERVER, encoding: "utf-8" }
  );
  return out.trim();
}

// Fernet key 合法性校验：32 字节原始数据，urlsafe-base64 编码后固定 44 个字符、末位 1 个 '=' 填充。
// 跟 cryptography.fernet.Fernet() 内部的校验规则同源(base64 解码后必须正好 32 字节)，这里用纯 JS
// 判断，不需要再拉起一次 python 子进程。
function isValidFernetKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}=$/.test(key)) return false;
  const raw = Buffer.from(key.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return raw.length === 32;
}

// ── CI 知识库密钥"双源冲突"坑（打包前必读）──────────────────────
// 本函数原来每次构建都随机生成一把新 key 去加密 prompts.enc、再烘进 desktop_entry.py 供运行时解密——
// 这本身自洽(加密/解密用同一把随机 key)。但 CI workflow（.github/workflows/desktop-build-win.yml）
// 另外把仓库 secret `BUNDLED_PROMPTS_PACK_KEY` 写进了 desktop/bundled.env 的 `PROMPTS_PACK_KEY` 行，
// 而 desktop_entry.py 用 `os.environ.setdefault("PROMPTS_PACK_KEY", "<烘进的随机 key>")`——
// setdefault 只在变量【未被设置过】时才生效，bundled.env 里已存在的 PROMPTS_PACK_KEY 会先一步
// 被读进环境、压过烘进去的值 → 运行时拿去解密的 key 变成了 secret 里那把，跟当初加密用的随机 key
// 对不上 → 台球知识库在 CI 出的包上整个解不开(本地手动打包没配这个环境变量，走不到这条坑)。
// 修法：加密阶段也去读同一个 `BUNDLED_PROMPTS_PACK_KEY`——CI 上就用它同时加密 + 烘入(两边天然一致)；
// 没设这个变量的本地开发机，行为不变(仍随机生成，跟以前一样能跑，只是不需要跟任何外部 secret 对齐)。
function resolveFernetKey() {
  const envKey = process.env.BUNDLED_PROMPTS_PACK_KEY;
  if (envKey && envKey.trim()) {
    const key = envKey.trim();
    if (!isValidFernetKey(key)) {
      // 格式不对就硬报错退出，绝不静默回退随机 key——静默回退会让这次"看似成功"的构建
      // 其实又双写了一把新 key，CI 包照样解不开，且更难排查(表面上流程走完了)。
      console.error(
        "❌ 环境变量 BUNDLED_PROMPTS_PACK_KEY 不是合法的 Fernet key" +
        "(应为 32 字节数据的 urlsafe-base64 编码，固定 44 个字符、末位 1 个 '=')。" +
        "请检查该 secret 是否被截断/误填/换行污染，修好后重新构建。"
      );
      process.exit(1);
    }
    console.log("① 使用 BUNDLED_PROMPTS_PACK_KEY 加密知识库(与运行时 bundled.env 解密用同一把 key，CI 场景)");
    return key;
  }
  return genFernetKey();
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
    // tzdata：Windows 系统不带时区库，zoneinfo("Asia/Shanghai") 靠 pip 的 tzdata 提供数据。
    // 漏收 → 后端首启即崩 ZoneInfoNotFoundError（1.0.1 真机事故根因，日志实锤）。纯数据包，collect-all 收全。
    "--collect-all", "tzdata",
    // 语义检索(店脑/知识"按意思找料")：把 fastembed + onnxruntime 收进包，bge 模型(~90MB)经
    // 上面 addData 预打包 → 装机后离线直接语义嵌入(不再退化成词面匹配)。这俩库内部大量动态
    // import + 原生动态库，必须 --collect-all 才收全。torch 不需要(fastembed 用 onnxruntime 推理)继续排除。
    "--collect-all", "fastembed",
    "--collect-all", "onnxruntime",
    // U4(E3c)：生图后 OCR 校验硬文字要素(店名/日期/价格/联系方式)有没有被模型"抽风"画错。
    // rapidocr_onnxruntime 把中文检测/识别/方向分类三个 onnx 模型(~16MB，含 config.yaml)直接
    // 放在自己包目录的 models/ 子目录里(不像 fastembed 那样要另外 --add-data 外部缓存目录)——
    // 但这些是【数据文件】，PyInstaller 默认只跟 import 图走静态分析，不会自动带非代码文件，
    // 必须显式 --collect-all 才能把 models/*.onnx + config.yaml 一起收进包。它依赖的 opencv/
    // shapely 走 pyinstaller-hooks-contrib 的现成 hook 自动收（本项目已装该 hooks 包，见
    // server/.venv 里 pyinstaller-hooks-contrib 依赖），pyclipper 是普通 C 扩展，PyInstaller
    // 默认的二进制依赖扫描能自动跟上，都不用手动 collect-all。
    "--collect-all", "rapidocr_onnxruntime",
    "--exclude-module", "torch",
    ...addData,
    ENTRY,
  ];
  const r = spawnSync("uv", args, { cwd: SERVER, stdio: "inherit" });
  if (r.status !== 0) { console.error("❌ 后端打包失败，退出码", r.status); process.exit(1); }
}

function main() {
  const key = resolveFernetKey();
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
