"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { ByokValidateResult } from "@/types/store";
import { Sheet } from "@/components/ui/sheet";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

// 常见 OpenAI 兼容供应商的快填（点一下自动填 base_url + 一个推荐模型名）
const PRESETS = [
  { label: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  { label: "小米 MiMo", base_url: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5" },
];

const inputCls =
  "w-full rounded-xl bg-[#F2F2F7] px-4 py-3 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20";

export function ByokConfigSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyMask, setKeyMask] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ByokValidateResult | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setSaved(false);
    setTestResult(null);
    setApiKey("");
    api
      .getByokConfig()
      .then((c) => {
        if (cancelled) return;
        setEnabled(c.enabled);
        setBaseUrl(c.base_url || "");
        setModel(c.model || "");
        setKeyConfigured(c.key_configured);
        setKeyMask(c.key_mask || "");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.detail : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const buildBody = () => ({
    enabled,
    base_url: baseUrl.trim() || null,
    model: model.trim() || null,
    // 只在填了新 key 时才提交（不填则后端保留原 key）
    ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError("");
    try {
      setTestResult(await api.validateByokConfig(buildBody()));
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "测试失败");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const c = await api.updateByokConfig(buildBody());
      setEnabled(c.enabled);
      setBaseUrl(c.base_url || "");
      setModel(c.model || "");
      setKeyConfigured(c.key_configured);
      setKeyMask(c.key_mask || "");
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="AI 模型配置（自带 Key）">
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        </div>
      ) : (
        <div className="space-y-4 pb-2">
          {/* 这块是干嘛的 */}
          <div className="rounded-xl bg-brand-50/60 p-3 text-[13px] leading-relaxed text-slate-600">
            接入你自己的大模型 API Key 后，AI 生成就走<b>你自己的账户</b>——成本和并发你自己掌控，不挤平台共享额度。适合用量大、或想用更强模型（如 deepseek-v4-pro）的门店。<b>不开启则用平台默认，无需配置。</b>
          </div>

          {/* 启用开关 */}
          <div className="flex items-center justify-between rounded-xl bg-white px-4 py-3 ring-1 ring-slate-100">
            <div className="min-w-0 pr-3">
              <p className="text-[15px] font-medium text-slate-800">启用自带 Key</p>
              <p className="mt-0.5 text-xs text-slate-400">开启后，本店所有 AI 生成都走你配置的 Key</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${enabled ? "bg-brand-600" : "bg-slate-300"}`}
            >
              <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-[22px]" : "translate-x-0.5"}`} />
            </button>
          </div>

          {/* 供应商快填 */}
          <div className="flex flex-wrap gap-2">
            <span className="self-center text-xs text-slate-400">快填：</span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  setBaseUrl(p.base_url);
                  setModel(p.model);
                }}
                className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 transition-colors active:scale-[0.97] active:bg-slate-200"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* base_url */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">接口地址（base_url）</label>
            <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
            <p className="mt-1 px-1 text-xs text-slate-400">填大模型的 OpenAI 兼容接口地址。点上面「快填」自动带入。</p>
          </div>

          {/* api_key */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">API Key</label>
            <input
              type="password"
              autoComplete="off"
              className={inputCls}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyConfigured ? `已配置 ${keyMask}，留空则不修改` : "sk-..."}
            />
            <p className="mt-1 px-1 text-xs text-slate-400">你的大模型 API Key，加密保存、绝不明文展示。{keyConfigured ? "已配置，留空保存则保留原 Key。" : ""}</p>
          </div>

          {/* model */}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">模型名（model）</label>
            <input className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-v4-pro" />
            <p className="mt-1 px-1 text-xs text-slate-400">如 deepseek-v4-pro（守规更稳）/ deepseek-v4-flash（更便宜）/ mimo-v2.5。</p>
          </div>

          {/* 测试结果 */}
          {testResult && (
            <div className={`flex items-start gap-2 rounded-xl p-3 text-[13px] ${testResult.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
              {testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{testResult.ok ? `连接正常（模型 ${testResult.model || "已响应"}）` : `连接失败：${testResult.error || "请检查配置"}`}</span>
            </div>
          )}
          {error && <p className="px-1 text-sm text-red-600">{error}</p>}
          {saved && <p className="px-1 text-sm text-emerald-600">已保存。本店 AI 生成{enabled ? "已切换到你的 Key。" : "仍用平台默认（未启用）。"}</p>}

          {/* 操作 */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || saving}
              className="flex-1 rounded-xl bg-slate-100 py-3 text-[15px] font-medium text-slate-700 transition-transform active:scale-[0.98] disabled:opacity-50"
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || testing}
              className="flex-1 rounded-xl bg-brand-600 py-3 text-[15px] font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
