export interface StoreDocSourceHit {
  sourceId: string;
  fileName: string;
  chunkLabel?: string;
  confidence?: string;
  score?: string;
  matchedTerms: string[];
  why?: string;
  excerpt?: string;
  path?: string;
}

export interface StoreDocSourcesResult {
  hits: StoreDocSourceHit[];
}

interface RawStoreDocSourceHit {
  source_id?: unknown;
  sourceId?: unknown;
  file_name?: unknown;
  fileName?: unknown;
  chunk_index?: unknown;
  chunkLabel?: unknown;
  confidence?: unknown;
  score?: unknown;
  matched_terms?: unknown;
  matchedTerms?: unknown;
  why?: unknown;
  excerpt?: unknown;
  path?: unknown;
}

function fieldLine(entry: string, label: string): string {
  const match = entry.match(new RegExp(`^${label}:(.*)$`, "m"));
  return match?.[1]?.trim() || "";
}

function splitMatchedTerms(value: string): string[] {
  if (!value || value === "无") return [];
  return value.split("、").map((item) => item.trim()).filter(Boolean).slice(0, 8);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => !!item)
    .slice(0, 8);
}

function hitFromJson(raw: RawStoreDocSourceHit): StoreDocSourceHit | null {
  const sourceId = stringValue(raw.source_id) || stringValue(raw.sourceId);
  const fileName = stringValue(raw.file_name) || stringValue(raw.fileName);
  if (!sourceId || !fileName) return null;
  const chunkIndex = typeof raw.chunk_index === "number" && Number.isFinite(raw.chunk_index)
    ? raw.chunk_index
    : undefined;
  return {
    sourceId,
    fileName,
    chunkLabel: stringValue(raw.chunkLabel) || (chunkIndex !== undefined ? `片段 ${chunkIndex + 1}` : undefined),
    confidence: stringValue(raw.confidence),
    score: stringValue(raw.score),
    matchedTerms: stringList(raw.matched_terms).length ? stringList(raw.matched_terms) : stringList(raw.matchedTerms),
    why: stringValue(raw.why),
    excerpt: stringValue(raw.excerpt),
    path: stringValue(raw.path),
  };
}

function parseJsonSources(text: string): StoreDocSourcesResult | null {
  const block = text.match(/<store_doc_sources_json>\s*([\s\S]*?)\s*<\/store_doc_sources_json>/);
  if (!block) return null;
  try {
    const parsed = JSON.parse(block[1] || "{}") as { hits?: unknown };
    const hits = Array.isArray(parsed.hits)
      ? parsed.hits
        .filter((item): item is RawStoreDocSourceHit => !!item && typeof item === "object" && !Array.isArray(item))
        .map(hitFromJson)
        .filter((item): item is StoreDocSourceHit => !!item)
      : [];
    return hits.length ? { hits } : null;
  } catch {
    return null;
  }
}

export function parseStoreDocSources(text: string | undefined | null): StoreDocSourcesResult | null {
  if (!text) return null;
  const jsonSources = parseJsonSources(text);
  if (jsonSources) return jsonSources;

  const block = text.match(/<store_doc_sources>\s*([\s\S]*?)\s*<\/store_doc_sources>/);
  if (!block) return null;

  const body = block[1] || "";
  const hits: StoreDocSourceHit[] = [];
  const entryRe = /(?:^|\n)\[(S\d+)\]\s+([\s\S]+?)(?=\n\[S\d+\]\s+|\s*$)/g;
  for (const match of body.matchAll(entryRe)) {
    const sourceId = match[1];
    const entry = (match[2] || "").trim();
    const lines = entry.split("\n");
    const header = lines[0] || "";
    const parts = header.split(" · ").map((item) => item.trim()).filter(Boolean);
    const fileName = parts[0] || sourceId;
    const chunkLabel = parts.find((part) => part.startsWith("片段 "));
    const confidence = parts.find((part) => part.startsWith("可信度:"))?.slice("可信度:".length).trim();
    const score = parts.find((part) => part.startsWith("分数:"))?.slice("分数:".length).trim();
    hits.push({
      sourceId,
      fileName,
      chunkLabel,
      confidence,
      score,
      matchedTerms: splitMatchedTerms(fieldLine(entry, "匹配")),
      why: fieldLine(entry, "原因") || undefined,
      excerpt: fieldLine(entry, "摘录") || undefined,
      path: fieldLine(entry, "路径") || undefined,
    });
  }

  return hits.length ? { hits } : null;
}
