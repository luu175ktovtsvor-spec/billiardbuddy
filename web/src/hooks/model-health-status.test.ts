import { describe, expect, it } from "vitest";
import { modelHealthStatusText, sanitizeModelHealthError } from "./model-health-status";
import type { ModelStatusResponse } from "@/lib/api";

function status(overrides: Partial<ModelStatusResponse> = {}): ModelStatusResponse {
  return {
    ok: true,
    activeId: "primary",
    fallbackCount: 1,
    runtime: {
      source: "saved-provider",
      providerId: "primary",
      providerName: "Primary",
      summary: {
        apiFormat: "openai_chat",
        baseUrl: "https://primary.example/v1",
        model: "primary-model",
        hasApiKey: true,
        hasAuthToken: false,
      },
    },
    ...overrides,
  };
}

describe("modelHealthStatusText", () => {
  it("formats ready status with fallback count", () => {
    const out = modelHealthStatusText(status());
    expect(out).toMatchObject({ tone: "ok", label: "AI 通道正常 · 1 个备用" });
    expect(out.detail).toContain("Primary");
  });

  it("formats cooling status without exposing raw secrets", () => {
    const out = modelHealthStatusText(status({
      runtime: {
        source: "saved-provider",
        providerId: "backup",
        providerName: "Backup",
        summary: {
          apiFormat: "openai_chat",
          baseUrl: "https://backup.example/v1",
          model: "backup-model",
          hasApiKey: true,
          hasAuthToken: false,
        },
      },
      health: [{
        source: "saved-provider",
        providerId: "primary",
        providerName: "Primary",
        label: "Primary",
        model: "primary-model",
        state: "cooling",
        failureCount: 2,
        cooldownMsRemaining: 61_000,
        lastError: "HTTP 502 Bearer sk-live-secret api_key=raw-secret",
        failureCategory: "transient",
      }],
    }));
    expect(out).toMatchObject({ tone: "warn", label: "备用接管中 · 1 个冷却" });
    expect(out.detail).toContain("Backup");
    expect(out.detail).toContain("Primary 失败 2 次");
    expect(out.detail).toContain("约 2 分钟后重试");
    expect(out.detail).toContain("Bearer [redacted]");
    expect(out.detail).toContain("api_key=[redacted]");
    expect(out.detail).not.toContain("live-secret");
    expect(out.detail).not.toContain("raw-secret");
  });

  it("labels configuration cooldown distinctly", () => {
    const out = modelHealthStatusText(status({
      health: [{
        source: "saved-provider",
        providerId: "primary",
        providerName: "Primary",
        label: "Primary",
        model: "primary-model",
        state: "cooling",
        failureCount: 1,
        cooldownMsRemaining: 600_000,
        lastError: "模型请求失败 401:invalid api key",
        failureCategory: "configuration",
      }],
    }));
    expect(out.detail).toContain("Primary 配置失败 1 次");
    expect(out.detail).toContain("约 10 分钟后重试");
  });

  it("formats missing provider as not ready", () => {
    expect(modelHealthStatusText(null)).toMatchObject({ tone: "warn", label: "AI 通道未就绪" });
  });

  it("sanitizes provider errors for all UI surfaces", () => {
    const out = sanitizeModelHealthError("Authorization: Bearer raw-token sk-live-secret api_key = another-secret");
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("sk-[redacted]");
    expect(out).toContain("api_key = [redacted]");
    expect(out).not.toContain("raw-token");
    expect(out).not.toContain("live-secret");
    expect(out).not.toContain("another-secret");
  });
});
