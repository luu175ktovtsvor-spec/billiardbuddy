#!/usr/bin/env node
// 把 web 的 Next.js standalone 产物组装进 desktop/resources/frontend/app/，供 electron-builder
// 作 extraResources 塞进安装包。运行时 frontend.js 用 Electron 的 Node 跑 app/server.js。
//
// 用法：
//   1) 先在 web 出 standalone 产物（务必带正确的反代目标，烘进 server.js）：
//        cd web && API_PROXY_URL=http://127.0.0.1:8077 pnpm build
//      （不要设 NEXT_PUBLIC_API_URL → 前端走相对路径 → 同源 → server.js 反代到后端，零跨域）
//   2) cd desktop && node scripts/build_frontend.js
//
// standalone 产物的标准布局（Next.js 官方）：server.js 自带最小 node_modules，但【不含】
// .next/static 和 public，必须手动拷到 server.js 同级：
//   app/
//     server.js
//     package.json
//     node_modules/
//     .next/static/   ← 从 web/.next/static 拷
//     public/         ← 从 web/public 拷

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");   // 仓库根
const WEB = path.join(ROOT, "web");
const STANDALONE = path.join(WEB, ".next", "standalone");
const OUT = path.join(__dirname, "..", "resources", "frontend", "app");

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function cp(src, dst, opts = {}) { fs.cpSync(src, dst, { recursive: true, ...opts }); }

// pnpm 软链树在跨平台打包上两难:①保留软链→Windows fs.cpSync 拷不动 + NSIS 报"目录名无效"打不出安装包;
// ②按软链拍扁→丢 .pnpm 兄弟关系,next 找不到 styled-jsx 前端起不来(2026-07-02 两个坑都踩过)。
// 解法=hoisted 扁平化:把 .pnpm 里每个包都提到顶层 node_modules/<包名> 成实体,next 和它的兄弟依赖
// (styled-jsx/@next/env…)全在顶层同级 → 标准 node 解析找得到、产物零软链、Windows/NSIS 都吞得下。
// 这是 OS 无关的(纯实体文件),Mac 上 server.js 能起=Windows 也能起。

// 把一个真实包目录拷成实体(其内部一般无嵌套 node_modules,深拷即可;遇软链跟随实体化兜底)。
function copyRealDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isSymbolicLink()) {
      const real = fs.realpathSync(s);
      if (fs.statSync(real).isDirectory()) copyRealDir(real, d);
      else fs.copyFileSync(real, d);
    } else if (e.isDirectory()) {
      copyRealDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// 扫 .pnpm 收集每个包的【真实体目录】,提升到 outNM/<包名>(顶层扁平)。scoped 包(@scope/name)一并处理。
function hoistPnpm(srcNM, outNM) {
  fs.mkdirSync(outNM, { recursive: true });
  const pnpmDir = path.join(srcNM, ".pnpm");
  const seen = new Set();
  // 先扫 .pnpm/<pkg@ver>/node_modules/ 下的真实包(每个 .pnpm 条目自己那个包是实体,兄弟依赖是软链跳过)
  if (fs.existsSync(pnpmDir)) {
    for (const verDir of fs.readdirSync(pnpmDir)) {
      const nm = path.join(pnpmDir, verDir, "node_modules");
      if (!fs.existsSync(nm)) continue;
      for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
        if (e.name.startsWith("@")) {                       // scoped: @scope/name
          for (const sub of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
            hoistOne(path.join(nm, e.name, sub.name), `${e.name}/${sub.name}`, outNM, seen);
          }
        } else {
          hoistOne(path.join(nm, e.name), e.name, outNM, seen);
        }
      }
    }
  }
  // 再扫顶层 node_modules 里的实体(非软链)包,补齐(如 .pnpm 没覆盖到的)
  for (const e of fs.readdirSync(srcNM, { withFileTypes: true })) {
    if (e.name === ".pnpm") continue;
    if (e.name.startsWith("@")) {
      for (const sub of fs.readdirSync(path.join(srcNM, e.name), { withFileTypes: true })) {
        maybeHoistTop(path.join(srcNM, e.name, sub.name), `${e.name}/${sub.name}`, outNM, seen);
      }
    } else {
      maybeHoistTop(path.join(srcNM, e.name), e.name, outNM, seen);
    }
  }
}
function hoistOne(srcPkg, name, outNM, seen) {
  if (seen.has(name)) return;                 // 同名只提第一个(traced standalone 基本单版本,冲突概率低)
  let st; try { st = fs.lstatSync(srcPkg); } catch { return; }
  if (st.isSymbolicLink()) return;            // .pnpm 里的软链是"指向别的包"的兄弟链,跳过(别的条目会提它)
  if (!st.isDirectory()) return;
  seen.add(name);
  copyRealDir(srcPkg, path.join(outNM, name));
}
function maybeHoistTop(srcPkg, name, outNM, seen) {
  if (seen.has(name)) return;
  let st; try { st = fs.lstatSync(srcPkg); } catch { return; }
  const realDir = st.isSymbolicLink() ? (() => { try { return fs.realpathSync(srcPkg); } catch { return null; } })() : srcPkg;
  if (!realDir) return;
  try { if (!fs.statSync(realDir).isDirectory()) return; } catch { return; }
  seen.add(name);
  copyRealDir(realDir, path.join(outNM, name));
}

function main() {
  // ① 先用【正确的反代目标】出 standalone —— 防漏设 API_PROXY_URL（默认会变 8000 → 前端连不上后端 8077 → 登录 500）。
  //    把构建收进本脚本，打包流程就不会再忘设这个 env。
  const proxy = process.env.API_PROXY_URL || "http://127.0.0.1:8077";
  // 先清旧 .next：残留的上一次 standalone 会让本次 build 的文件追踪 scandir 到它
  // → Windows EPERM(node_modules/react)。清掉保证每次都是干净单次构建(本地重打也受益)。
  rmrf(path.join(WEB, ".next"));
  console.log(`① 构建前端 standalone（API_PROXY_URL=${proxy}，server.js 反代到后端）…`);
  // shell:true 必须——Windows 上 pnpm 是 pnpm.cmd 批处理,Node 22 起(CVE-2024-27980 修复后)
  // 不加 shell 直接 spawn .cmd 会 EINVAL/瞬间失败(macOS 上 pnpm 是真可执行文件不受影响)。
  // 参数只有 "build" 无空格/特殊字符,shell:true 拼接安全。
  const built = spawnSync("pnpm", ["build"], { cwd: WEB, env: { ...process.env, API_PROXY_URL: proxy }, stdio: "inherit", shell: true });
  if (built.status !== 0) { console.error("❌ 前端构建失败"); process.exit(1); }

  if (!fs.existsSync(path.join(STANDALONE, "server.js"))) {
    console.error(`❌ 未找到 standalone 产物：${STANDALONE}/server.js`);
    console.error("   先跑：cd web && API_PROXY_URL=http://127.0.0.1:8077 pnpm build");
    process.exit(1);
  }
  console.log("② 组装前端 standalone → resources/frontend/app/ …");
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // 1a) 先拷 standalone 里 node_modules 以外的东西(server.js / package.json / 应用自身产物…)。
  for (const e of fs.readdirSync(STANDALONE, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const s = path.join(STANDALONE, e.name), d = path.join(OUT, e.name);
    if (e.isDirectory()) cp(s, d); else fs.copyFileSync(s, d);
  }
  // 1b) node_modules 走 hoisted 扁平化(见上方注释):零软链、跨平台、Windows/NSIS 吞得下。
  hoistPnpm(path.join(STANDALONE, "node_modules"), path.join(OUT, "node_modules"));

  // 2) .next/static（standalone 不含，必须补）
  const staticSrc = path.join(WEB, ".next", "static");
  if (fs.existsSync(staticSrc)) cp(staticSrc, path.join(OUT, ".next", "static"));
  else console.warn("⚠️ 未找到 web/.next/static");

  // 3) public（门店上传以外的静态资源）
  const publicSrc = path.join(WEB, "public");
  if (fs.existsSync(publicSrc)) cp(publicSrc, path.join(OUT, "public"));

  console.log(`✅ 前端组装完成 → ${OUT}`);
  console.log("   server.js + .next/static + public 就位（electron-builder 经 extraResources 拷进包）");
}

try {
  main();
} catch (e) {
  // 显式打印完整堆栈——否则打包脚本崩了在 CI 里只看到 exit 1、看不到真因(踩过)。
  console.error("❌ build_frontend 失败：", e && e.stack ? e.stack : e);
  process.exit(1);
}
