import type { AskQuestionField } from "@/lib/api";

type FieldPayload = Record<string, unknown>;

function isEmptyValue(value: unknown): boolean {
  return value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
}

function valueText(field: AskQuestionField, value: unknown): string {
  if (field.type === "boolean") return value === true ? "是" : "否";
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join("、");
  return String(value ?? "");
}

export function questionFieldAnswerDisplay(fields: AskQuestionField[], payload: FieldPayload): string {
  const lines: string[] = [];
  for (const field of fields) {
    const value = payload[field.name];
    if (isEmptyValue(value)) continue;
    const text = valueText(field, value).trim();
    if (!text) continue;
    lines.push(`${field.label}：${text}`);
  }
  return lines.length ? lines.join("\n") : "已提交";
}

export function safeExternalQuestionUrl(value: string | undefined | null): string {
  const raw = value?.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}
