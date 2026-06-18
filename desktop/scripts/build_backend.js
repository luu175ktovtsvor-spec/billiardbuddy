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
];

// 运行时数据文件：加密知识库块(prompts.enc，放 bundle 根)、报表表单(report_forms)。
// ⚠️ 绝不带明文 prompts/ 目录——护城河。
const sep = process.platform === "win32" ? ";" : ":";
const addData = [];
addData.push(`--add-data=${PACK_ENC}${sep}.`);          // prompts.enc → bundle 根
const reportForms = path.join(SERVER, "report_forms");
if (fs.existsSync(reportForms)) addData.push(`--add-data=${reportForms}${sep}report_forms`);

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
