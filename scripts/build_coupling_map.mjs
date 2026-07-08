#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

export const ROOT = path.resolve(path.dirname(__filename), "..");
export const API_TS = path.join(ROOT, "web", "src", "lib", "api.ts");
export const ROUTER_PY = path.join(ROOT, "server", "api", "v1", "router.py");
export const ROUTE_DIR = path.join(ROOT, "server", "api", "v1");
export const DOC = path.join(ROOT, "docs", "耦合地图与改动检查清单.md");

export const API_PREFIX = "/api/v1";
export const AUTO_BEGIN = "<!-- AUTO-GENERATED:coupling-wiring BEGIN -->";
export const AUTO_END = "<!-- AUTO-GENERATED:coupling-wiring END -->";

const METHOD_DEF = /^\s*(?:(?:private|public)\s+)?(?:async\s+)?(?:get\s+)?([A-Za-z_]\w*)\s*[<(]/;
const REQUEST_CALL =
  /request<[^>]*>\(\s*["'](GET|POST|PUT|DELETE|PATCH)["']\s*,\s*[`"'](\/[^`"']*)|request\(\s*["'](GET|POST|PUT|DELETE|PATCH)["']\s*,\s*[`"'](\/[^`"']*)/g;
const FETCH_PATH = /fetch\(\s*`\$\{this\.baseUrl\}(\/[^`]*)`/;
const FETCH_METHOD = /method:\s*["'](GET|POST|PUT|DELETE|PATCH)["']/;

const INCLUDE_ROUTER = /include_router\(\s*(\w+)\s*,\s*prefix\s*=\s*["'](\/[^"']*)["']/g;
const IMPORT_ROUTER = /from\s+api\.v1\.(\w+)\s+import\s+router\s+as\s+(\w+)/g;
const ROUTE_DECO = /@router\.(get|post|put|delete|patch)\(\s*["']([^"']*)["']/;
const DEF = /^\s*async\s+def\s+(\w+)|^\s*def\s+(\w+)/;

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function uniqueBy(items, keyFn) {
  const seen = new Map();
  for (const item of items) {
    seen.set(keyFn(item), item);
  }
  return Array.from(seen.values());
}

function compareText(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function normalizeEndpoint(inputPath) {
  let endpoint = inputPath.split("?", 1)[0];
  endpoint = endpoint.replace(/\$\{[^}]*\}/g, "{}");
  endpoint = endpoint.replace(/\{[^}]*\}/g, "{}");
  endpoint = endpoint.replace(/\/\/+/g, "/");
  if (endpoint.length > 1 && endpoint.endsWith("/")) {
    endpoint = endpoint.slice(0, -1);
  }
  return endpoint;
}

export function extractFrontendCalls(apiTs = API_TS) {
  const lines = readText(apiTs).split(/\r?\n/);
  const calls = [];
  let currentMethod = "?";

  for (const [index, line] of lines.entries()) {
    const methodMatch = METHOD_DEF.exec(line);
    if (methodMatch && !["if", "for", "while", "switch", "catch", "return"].includes(methodMatch[1])) {
      currentMethod = methodMatch[1];
    }

    for (const match of line.matchAll(REQUEST_CALL)) {
      const verb = match[1] ?? match[3];
      const endpoint = match[2] ?? match[4];
      calls.push({ method: currentMethod, verb, endpoint: normalizeEndpoint(endpoint) });
    }

    const fetchMatch = FETCH_PATH.exec(line);
    if (fetchMatch) {
      let verb = "GET";
      for (let j = index; j < Math.min(index + 6, lines.length); j += 1) {
        const verbMatch = FETCH_METHOD.exec(lines[j]);
        if (verbMatch) {
          verb = verbMatch[1];
          break;
        }
      }
      calls.push({ method: currentMethod, verb, endpoint: normalizeEndpoint(fetchMatch[1]) });
    }
  }

  return uniqueBy(calls, (call) => `${call.method}\0${call.verb}\0${call.endpoint}`).sort(
    (a, b) => compareText(a.endpoint, b.endpoint) || compareText(a.verb, b.verb) || compareText(a.method, b.method),
  );
}

function routerPrefixMap(routerPy = ROUTER_PY) {
  const text = readText(routerPy);
  const aliasToFile = new Map();
  for (const match of text.matchAll(IMPORT_ROUTER)) {
    aliasToFile.set(match[2], match[1]);
  }

  const prefixes = new Map();
  for (const match of text.matchAll(INCLUDE_ROUTER)) {
    const alias = match[1];
    const prefix = match[2];
    const file = aliasToFile.get(alias);
    if (file) {
      prefixes.set(file, prefix);
    }
  }
  return prefixes;
}

function servicesIn(routeFile) {
  const found = new Set();
  for (const line of readText(routeFile).split(/\r?\n/)) {
    const match = /from\s+services\.?(\w+)?/.exec(line);
    if (match?.[1]) {
      found.add(match[1]);
    }
    const aiMatch = /from\s+services\.ai\.(\w+)/.exec(line);
    if (aiMatch?.[1]) {
      found.add(`ai.${aiMatch[1]}`);
    }
  }
  return Array.from(found).sort();
}

export function extractBackendRoutes(routerPy = ROUTER_PY, routeDir = ROUTE_DIR) {
  const prefixMap = routerPrefixMap(routerPy);
  const routes = [];

  for (const [file, prefix] of prefixMap.entries()) {
    const routeFile = path.join(routeDir, `${file}.py`);
    if (!fs.existsSync(routeFile)) {
      continue;
    }

    const services = servicesIn(routeFile);
    const lines = readText(routeFile).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const deco = ROUTE_DECO.exec(line);
      if (!deco) {
        continue;
      }

      const verb = deco[1].toUpperCase();
      const subpath = deco[2];
      let func = "?";
      for (let j = index + 1; j < Math.min(index + 6, lines.length); j += 1) {
        const defMatch = DEF.exec(lines[j]);
        if (defMatch) {
          func = defMatch[1] ?? defMatch[2];
          break;
        }
      }
      const endpoint = normalizeEndpoint(`${API_PREFIX}${prefix}${subpath}`);
      routes.push({ endpoint, verb, func, file, services });
    }
  }

  return uniqueBy(
    routes,
    (route) => `${route.endpoint}\0${route.verb}\0${route.func}\0${route.file}\0${route.services.join("\0")}`,
  ).sort((a, b) => compareText(a.endpoint, b.endpoint) || compareText(a.verb, b.verb));
}

export function match(calls, routes) {
  const routeIndex = new Map(routes.map((route) => [`${route.endpoint}\0${route.verb}`, route]));
  const wired = [];
  const dead = [];

  for (const call of calls) {
    const route = routeIndex.get(`${call.endpoint}\0${call.verb}`) ?? null;
    if (route) {
      wired.push([call, route]);
    } else {
      dead.push([call, route]);
    }
  }

  const called = new Set(calls.map((call) => `${call.endpoint}\0${call.verb}`));
  const orphan = routes.filter((route) => !called.has(`${route.endpoint}\0${route.verb}`));
  return [wired, dead, orphan];
}

export function render(calls, routes) {
  const [wired, dead, orphan] = match(calls, routes);
  const out = [
    AUTO_BEGIN,
    "",
    "> 本块由 `scripts/build_coupling_map.mjs` 自动生成，勿手改；改了接口跑 `/coupling-map` 重生。",
    `> 前端调用 ${calls.length} 处 · 后端路由 ${routes.length} 个 · 已接通 ${wired.length} · 死方法 ${dead.length} · 无前端调用的路由 ${orphan.length}`,
    "",
    "### 接线表（前端 api.ts → 后端路由 → service）",
    "",
    "| 前端方法 | HTTP | 端点 | 后端函数 | service |",
    "|---|---|---|---|---|",
  ];

  for (const [call, route] of wired) {
    const service = route.services.join(", ") || "—";
    out.push(`| \`${call.method}\` | ${call.verb} | \`${call.endpoint}\` | \`${route.func}\`(${route.file}) | ${service} |`);
  }

  out.push("");
  if (dead.length > 0) {
    out.push("### ⚠️ 死方法（前端在调，后端无此路由 → 调用必失败）");
    out.push("");
    for (const [call] of dead) {
      out.push(`- \`${call.method}\` → ${call.verb} \`${call.endpoint}\``);
    }
    out.push("");
  }

  if (orphan.length > 0) {
    out.push("### 无前端调用的后端路由（agent/内部/SSE 直连可能正常，仅供核对）");
    out.push("");
    for (const route of orphan) {
      out.push(`- ${route.verb} \`${route.endpoint}\` ← \`${route.func}\`(${route.file})`);
    }
    out.push("");
  }

  out.push(AUTO_END);
  return out.join("\n");
}

export function writeIntoDoc(block, doc = DOC) {
  const text = readText(doc);
  const begin = text.indexOf(AUTO_BEGIN);
  const end = text.indexOf(AUTO_END);
  let next;

  if (begin >= 0 && end >= 0) {
    next = text.slice(0, begin) + block + text.slice(end + AUTO_END.length);
  } else {
    next = `${text.trimEnd()}\n\n## 接线表（机械层自动生成）\n\n${block}\n`;
  }

  if (next !== text) {
    fs.writeFileSync(doc, next, "utf8");
    return true;
  }
  return false;
}

export function main(argv = process.argv.slice(2)) {
  const calls = extractFrontendCalls();
  const routes = extractBackendRoutes();
  const block = render(calls, routes);

  if (argv.includes("--write")) {
    const changed = writeIntoDoc(block);
    console.log(`${changed ? "已更新" : "无变化"}：${DOC}`);
  } else {
    console.log(block);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
