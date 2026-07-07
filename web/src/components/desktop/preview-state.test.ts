import { describe, expect, test } from "vitest";

import type { PreviewItem } from "./preview-panel";
import { isRestorablePreview, nextPreviewItem } from "./preview-state";

describe("nextPreviewItem", () => {
  test("focuses the latest started file mutation immediately", () => {
    const current: PreviewItem = { kind: "poster", imageUrl: "/poster.png" };
    const incoming: PreviewItem = { kind: "file_pending", path: "/tmp/a.ts", tool: "patch_file" };

    expect(nextPreviewItem(current, incoming)).toBe(incoming);
  });

  test("replaces a pending file preview with its completed diff", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/tmp/a.ts", tool: "patch_file" };
    const incoming: PreviewItem = { kind: "diff", path: "/tmp/a.ts", backupPath: "/tmp/a.ts.bak" };

    expect(nextPreviewItem(current, incoming)).toBe(incoming);
  });

  test("replaces pending previews when paths differ only by absolute workspace prefix", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/workspace/project/src/a.ts", tool: "patch_file" };
    const incoming: PreviewItem = { kind: "diff", path: "src/a.ts", backupPath: "/workspace/project/.backups/a.ts" };

    expect(nextPreviewItem(current, incoming)).toBe(incoming);
  });

  test("replaces a pending file preview with a completed multi-file diff that includes it", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/tmp/a.ts", tool: "patch_files" };
    const incoming: PreviewItem = {
      kind: "diff_list",
      changes: [
        { path: "/tmp/a.ts", backupPath: "/tmp/a.ts.bak" },
        { path: "/tmp/b.ts", backupPath: "/tmp/b.ts.bak" },
      ],
    };

    expect(nextPreviewItem(current, incoming)).toBe(incoming);
  });

  test("replaces a pending multi-file preview with its completed diff list", () => {
    const current: PreviewItem = { kind: "file_pending_list", paths: ["/tmp/a.ts", "/tmp/b.ts"], tool: "patch_files" };
    const incoming: PreviewItem = {
      kind: "diff_list",
      changes: [
        { path: "/tmp/a.ts", backupPath: "/tmp/a.ts.bak" },
        { path: "/tmp/b.ts", backupPath: "/tmp/b.ts.bak" },
      ],
    };

    expect(nextPreviewItem(current, incoming)).toBe(incoming);
  });

  test("replaces a pending multi-file preview with its multi-file error state", () => {
    const current: PreviewItem = { kind: "file_pending_list", paths: ["/tmp/a.ts", "/tmp/b.ts"], tool: "patch_files" };
    const incoming: PreviewItem = {
      kind: "file_error_list",
      paths: ["/tmp/a.ts", "/tmp/b.ts"],
      tool: "patch_files",
      message: "context mismatch",
    };

    expect(nextPreviewItem(current, incoming)).toBe(incoming);
  });

  test("keeps the newer pending file visible when an older file finishes", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/tmp/b.ts", tool: "write_file" };
    const incoming: PreviewItem = { kind: "diff", path: "/tmp/a.ts", backupPath: "/tmp/a.ts.bak" };

    expect(nextPreviewItem(current, incoming)).toBe(current);
  });

  test("keeps the newer pending file visible when a different relative path finishes", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/workspace/project/src/b.ts", tool: "write_file" };
    const incoming: PreviewItem = { kind: "diff", path: "src/a.ts", backupPath: "/workspace/project/.backups/a.ts" };

    expect(nextPreviewItem(current, incoming)).toBe(current);
  });

  test("keeps the newer pending file visible when an older multi-file diff finishes", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/tmp/c.ts", tool: "write_file" };
    const incoming: PreviewItem = {
      kind: "diff_list",
      changes: [
        { path: "/tmp/a.ts", backupPath: "/tmp/a.ts.bak" },
        { path: "/tmp/b.ts", backupPath: "/tmp/b.ts.bak" },
      ],
    };

    expect(nextPreviewItem(current, incoming)).toBe(current);
  });

  test("keeps a newer pending multi-file preview visible when an older file finishes", () => {
    const current: PreviewItem = { kind: "file_pending_list", paths: ["/tmp/b.ts", "/tmp/c.ts"], tool: "patch_files" };
    const incoming: PreviewItem = { kind: "diff", path: "/tmp/a.ts", backupPath: "/tmp/a.ts.bak" };

    expect(nextPreviewItem(current, incoming)).toBe(current);
  });

  test("keeps a newer pending file visible when an older multi-file mutation fails", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/tmp/c.ts", tool: "write_file" };
    const incoming: PreviewItem = {
      kind: "file_error_list",
      paths: ["/tmp/a.ts", "/tmp/b.ts"],
      tool: "patch_files",
      message: "context mismatch",
    };

    expect(nextPreviewItem(current, incoming)).toBe(current);
  });

  test("replaces the current pending file with its error state", () => {
    const current: PreviewItem = { kind: "file_pending", path: "/tmp/b.ts", tool: "write_file" };
    const incoming: PreviewItem = { kind: "file_error", path: "/tmp/b.ts", tool: "write_file", message: "blocked" };

    expect(nextPreviewItem(current, incoming)).toBe(incoming);
  });

  test("restores persisted multi-file error previews", () => {
    expect(isRestorablePreview({
      kind: "file_error_list",
      paths: ["/tmp/a.ts", "/tmp/b.ts"],
      tool: "patch_files",
      message: "context mismatch",
    })).toBe(true);

    expect(isRestorablePreview({
      kind: "file_error_list",
      paths: [],
      tool: "patch_files",
      message: "context mismatch",
    })).toBe(false);
  });
});
