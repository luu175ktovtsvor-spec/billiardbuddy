#!/usr/bin/env node
import { gzipSync } from "node:zlib"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileSync } from "node:fs"

const __dirname = dirname(fileURLToPath(import.meta.url))

const SAMPLE_BODY = {
  machine_id: "smoke-test-machine",
  batch: [
    {
      kind: "event",
      ref_id: "smoke-e1",
      payload: {
        id: "smoke-e1",
        event: "agent_chat",
        store_id: "store-1",
        user_id: "user-1",
        props: { tool: "generate_image" },
        created_at: "2026-07-02T10:00:00Z",
      },
    },
    {
      kind: "gen",
      ref_id: "smoke-g1",
      payload: {
        id: "smoke-g1",
        store_id: "store-1",
        type: "image",
        sub_type: "poster",
        prompt_used: "秋日促销海报",
        result: "https://example.com/poster.png",
        model_used: "gpt-image-2",
        tokens_used: 1234,
        effect_rating: "good",
        effect_note: null,
        is_favorite: true,
        source_rec_id: null,
        conversation_id: "conv-1",
        created_at: "2026-07-02T10:01:00Z",
      },
    },
    {
      kind: "trace",
      ref_id: "conv-1",
      payload: {
        conversation_id: "conv-1",
        path: "/local/path/conv-1.jsonl",
        content: "{\"role\":\"user\",\"content\":\"帮我做张海报\"}\n{\"role\":\"assistant\",\"content\":\"好的\"}\n",
      },
    },
    {
      kind: "store",
      ref_id: "store-1",
      payload: {
        snapshot: { id: "store-1", name: "示例台球房", city: "杭州" },
      },
    },
  ],
}

function parseOutPath() {
  const outFlag = process.argv.find(arg => arg.startsWith("--out="))
  if (outFlag) return resolve(process.cwd(), outFlag.slice("--out=".length))
  return resolve(__dirname, "sample.json.gz")
}

const outPath = parseOutPath()
const payload = Buffer.from(JSON.stringify(SAMPLE_BODY), "utf8")
writeFileSync(outPath, gzipSync(payload))
console.log(`wrote ${outPath}`)
