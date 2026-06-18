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

const ROOT = path.join(__dirname, "..", "..");   // 仓库根
const WEB = path.join(ROOT, "web");
const STANDALONE = path.join(WEB, ".next", "standalone");
const OUT = path.join(__dirname, "..", "resources", "frontend", "app");

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function cp(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

function main() {
  if (!fs.existsSync(path.join(STANDALONE, "server.js"))) {
    console.error(`❌ 未找到 standalone 产物：${STANDALONE}/server.js`);
    console.error("   先跑：cd web && API_PROXY_URL=http://127.0.0.1:8077 pnpm build");
    process.exit(1);
  }
  console.log("组装前端 standalone → resources/frontend/app/ …");
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 整个 standalone（server.js + package.json + 精简 node_modules）
  cp(STANDALONE, OUT);

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

main();
