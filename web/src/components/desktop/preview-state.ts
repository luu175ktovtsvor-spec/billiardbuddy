import type { PreviewItem } from "./preview-panel";

type FileChangePreview = Extract<PreviewItem, { kind: "file_pending" | "file_pending_list" | "file_error" | "file_error_list" | "diff" | "diff_list" }>;

function isFileChangePreview(item: PreviewItem | null): item is FileChangePreview {
  return item?.kind === "file_pending" || item?.kind === "file_pending_list" || item?.kind === "file_error" || item?.kind === "file_error_list" || item?.kind === "diff" || item?.kind === "diff_list";
}

function previewPaths(item: FileChangePreview): string[] {
  if (item.kind === "diff_list") return item.changes.map(change => change.path);
  if (item.kind === "file_pending_list") return item.paths;
  if (item.kind === "file_error_list") return item.paths;
  return [item.path];
}

function normalizePreviewPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function samePreviewPath(a: string, b: string): boolean {
  const left = normalizePreviewPath(a);
  const right = normalizePreviewPath(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function overlapsPath(a: FileChangePreview, b: FileChangePreview): boolean {
  const bPaths = previewPaths(b);
  return previewPaths(a).some(path => bPaths.some(other => samePreviewPath(path, other)));
}

export function nextPreviewItem(current: PreviewItem | null, incoming: PreviewItem): PreviewItem {
  if (!isFileChangePreview(incoming)) return incoming;
  if (incoming.kind === "file_pending" || incoming.kind === "file_pending_list") return incoming;
  if (
    isFileChangePreview(current) &&
    (current.kind === "file_pending" || current.kind === "file_pending_list") &&
    !overlapsPath(current, incoming)
  ) {
    return current;
  }
  return incoming;
}

export function isRestorablePreview(value: unknown): value is PreviewItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PreviewItem>;
  if (item.kind === "poster") return typeof item.imageUrl === "string";
  if (item.kind === "video") return typeof item.videoUrl === "string";
  if (item.kind === "content") return typeof item.text === "string";
  if (item.kind === "file") return typeof item.text === "string";
  if (item.kind === "sheet" || item.kind === "doc" || item.kind === "diff") return typeof item.path === "string";
  if (item.kind === "diff_list") return Array.isArray(item.changes) && item.changes.length > 0 && item.changes.every(change => typeof change?.path === "string");
  if (item.kind === "file_pending") return typeof item.path === "string" && typeof item.tool === "string";
  if (item.kind === "file_pending_list") return Array.isArray(item.paths) && item.paths.length > 0 && item.paths.every(path => typeof path === "string") && typeof item.tool === "string";
  if (item.kind === "file_error") return typeof item.path === "string" && typeof item.tool === "string" && typeof item.message === "string";
  if (item.kind === "file_error_list") return Array.isArray(item.paths) && item.paths.length > 0 && item.paths.every(path => typeof path === "string") && typeof item.tool === "string" && typeof item.message === "string";
  return false;
}
