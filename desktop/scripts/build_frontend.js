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

// 显式解析软链的深拷贝：遇软链就 realpath 到真目标、拷【实体】,产物里【零软链】。
// 为什么不用 fs.cpSync({dereference:true})：Node 的 dereference 对 pnpm 的软链树有已知 bug——
// 部分软链不被跟随、原样拷成【指向开发机绝对路径的软链】(换机/Windows 即断链崩、且 Windows
// 重建软链会 EPERM/静默崩)。这里自己 realpath 逐个实体化,才真正自包含可移植。
// visited 防 pnpm 潜在环形软链导致无限递归。
function copyResolved(src, dst, visited = new Set()) {
  // 必须用 lstatSync(不跟随软链):Windows 上对"指向目录的软链"做跟随式 statSync 会 EPERM。
  // 遇软链就自己 readlink 解析目标路径、递归拷【真实体】,全程不触发跟随式 stat。
  const lst = fs.lstatSync(src);
  if (lst.isSymbolicLink()) {
    let target = fs.readlinkSync(src);
    if (!path.isAbsolute(target)) target = path.resolve(path.dirname(src), target);
    if (visited.has(target)) return;   // 环形保护(A→B→A)
    visited.add(target);
    copyResolved(target, dst, visited); // 递归拷软链真目标 → 产物是实体、无软链
    visited.delete(target);
    return;
  }
  if (lst.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyResolved(path.join(src, name), path.join(dst, name), visited);
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

// pnpm 的 node_modules 软链指向【绝对路径】(开发机 .pnpm 仓库) → 原样打到别的机器就断、前端起不来。
// 把 dir 内所有"指向 srcRoot 自己"的绝对软链改写成【相对软链】(指向 outRoot 内对应位置)→ 自包含、可移植。
// 保留 pnpm 的 .pnpm 结构不展平(next 靠 .pnpm 同级软链找 @next/env 等依赖)。不跟随软链递归(避环)。
function relinkInto(dir, srcRoot, outRoot) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      let target;
      try { target = fs.readlinkSync(p); } catch { continue; }
      if (path.isAbsolute(target) && target.startsWith(srcRoot)) {
        const outTarget = path.join(outRoot, path.relative(srcRoot, target));
        const relLink = path.relative(path.dirname(p), outTarget);
        fs.rmSync(p, { force: true });
        fs.symlinkSync(relLink, p);
      }
    } else if (e.isDirectory()) {
      relinkInto(p, srcRoot, outRoot);
    }
  }
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

  // 1) 整个 standalone（server.js + package.json + node_modules）拷进去。
  //    dereference:true = 跟随软链把【真实文件】拷进来,产物里【没有任何软链】→
  //    ① 彻底自包含可移植(不再有指向开发机的绝对软链,免 relink 改写);
  //    ② Windows 打包不用创建 dir 软链(fs.cpSync 拷 pnpm .pnpm 软链树在 Windows 会
  //       静默崩/EPERM/EINVAL——本地 Mac 不暴露、CI Windows 才炸)。
  //    代价=体积变大(软链目标被实体化),owner 已定调"体积大无所谓、运行得好优先"。
  copyResolved(STANDALONE, OUT);

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
