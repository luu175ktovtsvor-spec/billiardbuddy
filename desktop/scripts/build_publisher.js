#!/usr/bin/env node
// 把发布内核(publisher/cli.py + 四平台 uploader + patchright)用 PyInstaller 打成独立可执行,
// 让用户【免装 Python】也能用发布功能。产物 → desktop/resources/publisher-bin/billiards_publisher/。
//
// 用法:cd desktop && node scripts/build_publisher.js
// CI 里默认不跑(见 .github/workflows/desktop-build-win.yml 的 BUILD_PUBLISHER gate)——
// 因为 PyInstaller 打包 patchright 的【driver(node 二进制 + playwright 包数据)】是出名难调的,
// 需在真 Windows 上反复摸通 hidden-import/collect 清单后再开。本脚本是经过设计的首版,但
// "一次成功"不保证,属于待 Windows CI 摸通的部分。
//
// ⚠️ 浏览器内核:base.py 用 channel="chrome" → 用【系统已装的 Google Chrome】,不下载 chromium。
//    所以打包只需带 patchright 的 Python 包 + driver;用户机器要装 Chrome(绝大多数有)。
//    若要彻底免依赖,可改 channel="chromium" 并在首次发布时自动 `patchright install chromium`
//    (带进度 UI),那是 P0.2 的进阶项,本版先走 system Chrome。
//
// 环境:用 uv 起一个【临时环境】装 pyinstaller + patchright(不污染 server 的 uv 工程)。

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PUBLISHER = path.join(__dirname, "..", "publisher");
const OUT = path.join(__dirname, "..", "resources", "publisher-bin");
const ENTRY = path.join(PUBLISHER, "cli.py");

// cli.py 动态 import 这些本地模块(importlib),PyInstaller 静态分析抓不到 → 显式 hidden-import。
const localModules = [
  "base",
  "douyin_uploader", "dy_selectors",
  "kuaishou_uploader", "ks_selectors",
  "shipinhao_uploader", "sph_selectors",
  "xiaohongshu_uploader", "xhs_selectors",
];

function main() {
  if (!fs.existsSync(ENTRY)) { console.error(`❌ 未找到发布内核入口:${ENTRY}`); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  console.log("PyInstaller 打包发布内核(临时 env: pyinstaller + patchright)…");

  const args = [
    "run", "--no-project",
    "--with", "pyinstaller",
    "--with", "patchright>=1.49,<2",
    "pyinstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "billiards_publisher",
    "--distpath", OUT,
    "--workpath", path.join(__dirname, "..", ".pyinstaller-build-publisher"),
    "--specpath", path.join(__dirname, "..", ".pyinstaller-build-publisher"),
    // 本地模块在 publisher/ 目录,加进搜索路径 + 逐个 hidden-import(动态加载)
    "--paths", PUBLISHER,
    ...localModules.flatMap((m) => ["--hidden-import", m]),
    // patchright 内部大量动态 import + 自带 driver/数据,全收
    "--collect-all", "patchright",
    ENTRY,
  ];
  const r = spawnSync("uv", args, { cwd: PUBLISHER, stdio: "inherit" });
  if (r.status !== 0) { console.error("❌ 发布内核打包失败,退出码", r.status); process.exit(1); }
  console.log(`✅ 发布内核打包完成 → ${OUT}/billiards_publisher/`);
  console.log("（package.json extraResources 把它拷进安装包 resources/publisher-bin；publish.js 优先用它）");
}

main();
