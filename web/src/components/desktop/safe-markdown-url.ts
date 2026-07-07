import { defaultUrlTransform } from "react-markdown";

export function safeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//")) return "";
  const transformed = defaultUrlTransform(trimmed);
  if (!transformed) return "";
  if (/^https?:\/\//i.test(transformed)) return transformed;
  if (transformed.startsWith("/") || transformed.startsWith("#") || transformed.startsWith("./") || transformed.startsWith("../")) {
    return transformed;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(transformed) ? "" : transformed;
}
