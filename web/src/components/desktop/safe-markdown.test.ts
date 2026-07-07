import { describe, expect, test } from "vitest";

import { safeMarkdownUrl } from "./safe-markdown-url";

describe("safeMarkdownUrl", () => {
  test("allows http, https and local relative URLs", () => {
    expect(safeMarkdownUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeMarkdownUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeMarkdownUrl("/uploads/poster.png")).toBe("/uploads/poster.png");
    expect(safeMarkdownUrl("./local.md")).toBe("./local.md");
    expect(safeMarkdownUrl("#section")).toBe("#section");
  });

  test("blocks script, data, mail and protocol-relative URLs", () => {
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("data:text/html;base64,AAAA")).toBe("");
    expect(safeMarkdownUrl("mailto:test@example.com")).toBe("");
    expect(safeMarkdownUrl("//example.com/script.js")).toBe("");
  });
});
