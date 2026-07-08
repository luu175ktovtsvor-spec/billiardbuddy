#!/usr/bin/env node
// Build server/prompts.enc from prompt YAML without starting Python.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const ROOT = path.join(__dirname, "..", "..");
const SERVER = path.join(ROOT, "server");
const PROMPTS_DIR = path.join(SERVER, "prompts");
const PACK_ENC = path.join(SERVER, "prompts.enc");

function urlsafeBase64(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function urlsafeBase64Decode(text) {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function isValidFernetKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}=$/.test(key)) return false;
  return urlsafeBase64Decode(key).length === 32;
}

function fernetEncrypt(plainText, key) {
  if (!isValidFernetKey(key)) {
    throw new Error(
      "PROMPTS_PACK_KEY is not a valid Fernet key. It must be a 44-character urlsafe-base64 key ending with '='."
    );
  }

  const rawKey = urlsafeBase64Decode(key);
  const signingKey = rawKey.subarray(0, 16);
  const encryptionKey = rawKey.subarray(16);
  const iv = crypto.randomBytes(16);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));

  const cipher = crypto.createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plainText, "utf8")), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x80]), timestamp, iv, ciphertext]);
  const signature = crypto.createHmac("sha256", signingKey).update(body).digest();
  return urlsafeBase64(Buffer.concat([body, signature]));
}

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

function main() {
  const key = process.env.PROMPTS_PACK_KEY;
  if (!key) {
    throw new Error("PROMPTS_PACK_KEY is required to build server/prompts.enc.");
  }
  const templates = buildTemplates();
  fs.writeFileSync(PACK_ENC, fernetEncrypt(JSON.stringify(templates), key));
  const bytes = fs.statSync(PACK_ENC).size;
  console.log(`OK encrypted prompt pack -> ${PACK_ENC} (${bytes} bytes, ${Object.keys(templates).length} templates)`);
}

main();
