#!/usr/bin/env node
// Render docs/知识manifest.md from prompt YAML and knowledge keyword tables without starting Python.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../desktop/package.json", import.meta.url));
const yaml = require("js-yaml");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PROMPTS_DIR = path.join(ROOT, "server", "prompts");
const CONTENT_SERVICE = path.join(ROOT, "server", "services", "content_service.py");
const OUT = path.join(ROOT, "docs", "知识manifest.md");

const ROLE_PREFIX = "rules.role.";
const KNOWLEDGE_PREFIX = "knowledge.";

function walkYamlFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkYamlFiles(fullPath));
    else if (entry.isFile() && fullPath.endsWith(".yaml")) files.push(fullPath);
  }
  return files.sort();
}

function withPyYamlEofChomping(source) {
  if (source.endsWith("\n")) return source;

  const lines = source.split("\n");
  let openBlockHeader = -1;
  let openBlockMatch = null;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(\s*[^#\s][^:\n]*:\s*)([|>])([0-9]*[+-]?|[+-][0-9]*)?(\s*(?:#.*)?)$/);
    if (!match) continue;

    const headerIndent = lines[i].match(/^\s*/)[0].length;
    let closesBeforeEof = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      const indent = lines[j].match(/^\s*/)[0].length;
      if (indent <= headerIndent) {
        closesBeforeEof = true;
        break;
      }
    }
    if (!closesBeforeEof) {
      openBlockHeader = i;
      openBlockMatch = match;
    }
  }
  if (openBlockHeader < 0 || !openBlockMatch) return source;

  const indicator = openBlockMatch[3] || "";
  if (indicator.includes("-") || indicator.includes("+")) return source;
  lines[openBlockHeader] = `${openBlockMatch[1]}${openBlockMatch[2]}${indicator}-${openBlockMatch[4]}`;
  return lines.join("\n");
}

function buildTemplates() {
  const templates = {};
  for (const file of walkYamlFiles(PROMPTS_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    const data = yaml.load(withPyYamlEofChomping(source));
    if (data && typeof data === "object" && typeof data.key === "string" && data.key) {
      templates[data.key] = data;
    }
  }
  return templates;
}

function extractAssignedLiteral(source, name) {
  const assignMatch = new RegExp(`${name}\\s*(?::[^=]+)?=\\s*[{]`).exec(source);
  if (!assignMatch) throw new Error(`Cannot find ${name} assignment in ${CONTENT_SERVICE}`);

  const start = assignMatch.index + assignMatch[0].lastIndexOf("{");
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Cannot parse ${name} literal in ${CONTENT_SERVICE}`);
}

function parseKnowledgeConstants() {
  const source = fs.readFileSync(CONTENT_SERVICE, "utf8");
  const coreLiteral = extractAssignedLiteral(source, "CORE_KNOWLEDGE_KEYS");
  const keywordsLiteral = extractAssignedLiteral(source, "KNOWLEDGE_KEYWORDS");
  const coreKeys = [...coreLiteral.matchAll(/["'](knowledge\.[^"']+)["']/g)].map((m) => m[1]);
  const keywords = vm.runInNewContext(`(${keywordsLiteral})`, Object.freeze({}), {
    filename: CONTENT_SERVICE,
    timeout: 1000,
  });
  return { coreKeys: new Set(coreKeys), keywords };
}

function isCoreKnowledge(key, coreKeys) {
  return coreKeys.has(key) || key.startsWith("knowledge.daily_workflow");
}

function buildManifest() {
  const templates = buildTemplates();
  const { coreKeys, keywords } = parseKnowledgeConstants();
  const knowledgeKeys = Object.keys(templates).filter((k) => k.startsWith(KNOWLEDGE_PREFIX)).sort();

  const roleRequired = {};
  const roleNames = {};
  for (const [key, data] of Object.entries(templates)) {
    if (!key.startsWith(ROLE_PREFIX)) continue;
    roleRequired[key] = Array.isArray(data.required_knowledge) ? data.required_knowledge.slice() : [];
    roleNames[key] = data.name || key;
  }

  const requiredBy = Object.fromEntries(knowledgeKeys.map((key) => [key, []]));
  const ghost = new Set();
  for (const roleKey of Object.keys(roleRequired).sort()) {
    for (const knowledgeKey of roleRequired[roleKey]) {
      if (requiredBy[knowledgeKey]) requiredBy[knowledgeKey].push(roleKey);
      else ghost.add(knowledgeKey);
    }
  }

  const entries = knowledgeKeys.map((key) => {
    const data = templates[key] || {};
    const roles = requiredBy[key] || [];
    const isIndex = key.endsWith("_index");
    return {
      key,
      name: data.name || "",
      required_by_roles: roles,
      has_description: Boolean(data.description),
      is_render_class: Object.hasOwn(data, "template"),
      keywords: Array.isArray(keywords[key]) ? keywords[key].slice() : [],
      is_core: isCoreKnowledge(key, coreKeys),
      is_index: isIndex,
      is_dead: roles.length === 0 && !isIndex,
    };
  });

  const templateKeys = new Set(Object.keys(templates));
  return {
    entries,
    orphan_keyword_keys: Object.keys(keywords).filter((key) => !templateKeys.has(key)).sort(),
    missing_core_keys: [...coreKeys].filter((key) => !templateKeys.has(key)).sort(),
    ghost_required_keys: [...ghost].sort(),
    role_names: roleNames,
    dead_keys: entries.filter((e) => e.is_dead).map((e) => e.key),
    render_class_without_description: entries
      .filter((e) => e.is_render_class && !e.has_description)
      .map((e) => e.key),
  };
}

function roleShort(roleKey) {
  return roleKey.replace(ROLE_PREFIX, "");
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function renderMarkdown() {
  const m = buildManifest();
  const entries = m.entries;
  const total = entries.length;
  const dead = m.dead_keys;
  const orphan = m.orphan_keyword_keys;
  const noDesc = m.render_class_without_description;
  const noKw = entries.filter((e) => !e.keywords.length && !e.is_core).map((e) => e.key);
  const coreKeys = entries.filter((e) => e.is_core).map((e) => e.key);

  const lines = [];
  lines.push("# 知识库可观测 manifest（X-3 · 自动生成）");
  lines.push("");
  lines.push(
    "> 本文件由 `scripts/gen_knowledge_manifest.mjs` 生成，**勿手改**——" +
      "改了下次重跑会被覆盖。机器可读断言由 `server/tests/test_knowledge_manifest.py` 守门（那条绿=这份表健康）。"
  );
  lines.push(">");
  lines.push(`> 生成日期：${todayIso()}　|　数据源：Prompt YAML + \`content_service.KNOWLEDGE_KEYWORDS\`。`);
  lines.push("");

  lines.push("## 一眼看健康");
  lines.push("");
  lines.push(`- 知识总条数：**${total}**`);
  lines.push(
    `- ① 死料（没角色列入 required_knowledge）：**${dead.length}** ` +
      (dead.length ? `❌ ${dead}` : "✅ 无死料")
  );
  lines.push(
    `- ② 孤儿关键词（KNOWLEDGE_KEYWORDS 指向不存在的知识）：**${orphan.length}** ` +
      (orphan.length ? `❌ ${orphan}` : "✅ 无孤儿")
  );
  lines.push(
    `- ③ 渲染类缺 description：**${noDesc.length}** ` +
      (noDesc.length ? `❌ ${noDesc}` : "✅ 全有 description")
  );
  lines.push(
    `- 幽灵引用（角色 required_knowledge 指向不存在的知识）：**${m.ghost_required_keys.length}** ` +
      (m.ghost_required_keys.length ? `❌ ${m.ghost_required_keys}` : "✅ 无")
  );
  lines.push(`- 核心知识（恒注入，CORE + daily_workflow*）：**${coreKeys.length}** 条`);
  lines.push(`- 无关键词条目（非核心，靠语义/内容召回，不算缺陷，仅供留意）：**${noKw.length}** 条`);
  lines.push("");

  lines.push("## 角色（required_knowledge 来源）");
  lines.push("");
  lines.push("| 角色 key | 显示名 | 列入知识条数 |");
  lines.push("|---|---|---|");
  const roleCount = Object.fromEntries(Object.keys(m.role_names).map((roleKey) => [roleKey, 0]));
  for (const entry of entries) {
    for (const roleKey of entry.required_by_roles) {
      roleCount[roleKey] = (roleCount[roleKey] || 0) + 1;
    }
  }
  for (const roleKey of Object.keys(m.role_names).sort()) {
    lines.push(`| \`${roleShort(roleKey)}\` | ${m.role_names[roleKey]} | ${roleCount[roleKey] || 0} |`);
  }
  lines.push("");

  lines.push("## 每条知识 → 覆盖矩阵");
  lines.push("");
  lines.push(
    "列含义：**被哪些角色列入**（required_knowledge，空且非 L1 域目录页=死料）｜" +
      "**desc** 有无 description｜**关键词** 有无 KNOWLEDGE_KEYWORDS 命中词（核心知识标 🔒，恒注入不靠关键词）。"
  );
  lines.push("");
  lines.push("| knowledge key | 名称 | 被哪些角色列入 | desc | 关键词 |");
  lines.push("|---|---|---|---|---|");
  for (const entry of entries.sort((a, b) => a.key.localeCompare(b.key))) {
    const roleList = entry.required_by_roles.map(roleShort).join("、");
    const roles = roleList || (entry.is_index ? "L1 域目录页（look_up_knowledge 召回）" : "**❌ 无（死料）**");
    const desc = entry.has_description ? "✅" : "❌";
    let kw;
    if (entry.is_core) kw = "🔒 核心恒注入";
    else if (entry.keywords.length) kw = `✅（${entry.keywords.length} 词）`;
    else kw = "—（靠语义/内容）";
    const name = String(entry.name).replaceAll("|", "丨");
    lines.push(`| \`${entry.key}\` | ${name} | ${roles} | ${desc} | ${kw} |`);
  }
  lines.push("");

  lines.push("## 怎么读这份表");
  lines.push("");
  lines.push("- **某条「被哪些角色列入」为空且不是 L1 域目录页** → 死料，这条知识永远注不进任何对话。要么删、要么在角色 YAML 的 `required_knowledge` 登记。");
  lines.push("- **desc 为 ❌** → 缺 description，Agent/语义召回挑不到它（A-2 守门，渲染类必须有）。去 `prompts/knowledge/<file>.yaml` 补 `description:`。");
  lines.push("- **关键词为「—」** → 没配 KNOWLEDGE_KEYWORDS（非缺陷）。它靠语义/内容 bigram 召回；若该知识很想被精确关键词命中，可在 `content_service.KNOWLEDGE_KEYWORDS` 补词。");
  lines.push("- **🔒 核心恒注入** → CORE_KNOWLEDGE_KEYS 或 `daily_workflow*`，每轮都注，不依赖关键词。");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const markdown = renderMarkdown();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, markdown, "utf8");
  console.log(`written: ${OUT}`);
}

main();
