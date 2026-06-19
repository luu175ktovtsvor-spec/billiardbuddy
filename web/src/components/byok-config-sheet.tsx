"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { ByokValidateResult, ByokProfile } from "@/types/store";
import { Sheet } from "@/components/ui/sheet";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

// 常见 OpenAI 兼容供应商的快填（点一下自动填 base_url + 一个推荐模型名）
const PRESETS = [
  { label: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  { label: "小米 MiMo", base_url: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5" },
];

// 生图供应商预设（少而精·主流强）：点一下自动填 base_url + 推荐模型。
// base_url 与后端 resolve_image_kind 路由严格一致；叠图场景优先填 Qwen-Image-Edit-2509。
// editLogo=true 表示该模型支持「图生图」，能叠 Logo / 二维码。
const IMAGE_PRESETS = [
  {
    label: "硅基流动",
    base_url: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen-Image-Edit-2509",
    note: "一个 Key 多模型、新人送额度，最省事；这个模型支持传参考图，能叠 Logo/二维码。",
    recommended: true,
    editLogo: true,
  },
  {
    label: "火山·即梦 Seedream",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-4-0",
    note: "字节出品、效果强，约 0.2 元/张；支持传图编辑，能叠 Logo/二维码。",
    editLogo: true,
  },
  {
    label: "通义万相（阿里）",
    base_url: "https://dashscope.aliyuncs.com/api/v1",
    model: "wanx2.1-t2i-turbo",
    note: "阿里主流文生图、效果强；原生异步约 1-2 分钟，叠图请改用硅基/火山。",
    editLogo: false,
  },
  {
    label: "智谱 CogView-4",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    model: "cogview-4",
    note: "主流、便宜（约 0.06 元/张）；纯文生图，不做叠图。",
    editLogo: false,
  },
];

// 海外·降级：大陆通常调不通，仅自带 OpenAI Key 能直连时用，单列弱化在末尾。
const IMAGE_PRESET_OVERSEAS = {
  label: "OpenAI gpt-image",
  base_url: "https://api.openai.com/v1",
  model: "gpt-image-2",
  note: "海外模型，大陆一般调不通；仅你自带 OpenAI Key 且能直连时再选。",
};

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
  // 生图模型（与文字分开配）
  const [imageEnabled, setImageEnabled] = useState(false);
  const [imageBaseUrl, setImageBaseUrl] = useState("");
  const [imageApiKey, setImageApiKey] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [imageKeyConfigured, setImageKeyConfigured] = useState(false);
  const [imageKeyMask, setImageKeyMask] = useState("");
  // 做海报自动出图上限（B-5）：null=用默认(5)；>=0=上限(0=每张先问)；-1=老板关闭上限闸
  const [autoSpendLimit, setAutoSpendLimit] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ByokValidateResult | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // 多供应商配置档（CC Switch 式）
  const [profiles, setProfiles] = useState<ByokProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [busyProfile, setBusyProfile] = useState("");

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
        setImageEnabled(c.image_enabled);
        setImageBaseUrl(c.image_base_url || "");
        setImageModel(c.image_model || "");
        setImageKeyConfigured(c.image_key_configured);
        setImageKeyMask(c.image_key_mask || "");
        setAutoSpendLimit(c.agent_auto_spend_limit ?? null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.detail : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    api.listByokProfiles()
      .then((r) => { if (!cancelled) setProfiles(r.profiles); })
      .catch(() => { /* 配置档拿不到不挡主流程 */ });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const activateProfile = async (name: string) => {
    setBusyProfile(name);
    setError("");
    try {
      const r = await api.activateByokProfile(name);
      setProfiles(r.profiles);
      const c = await api.getByokConfig();   // 激活已写进 store.byok_*，刷新表单回显
      setEnabled(c.enabled);
      setBaseUrl(c.base_url || "");
      setModel(c.model || "");
      setKeyConfigured(c.key_configured);
      setKeyMask(c.key_mask || "");
      setApiKey("");
      setImageEnabled(c.image_enabled);
      setImageBaseUrl(c.image_base_url || "");
      setImageModel(c.image_model || "");
      setImageKeyConfigured(c.image_key_configured);
      setImageKeyMask(c.image_key_mask || "");
      setImageApiKey("");
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "切换失败");
    } finally {
      setBusyProfile("");
    }
  };

  const deleteProfile = async (name: string) => {
    setBusyProfile(name);
    try {
      const r = await api.deleteByokProfile(name);
      setProfiles(r.profiles);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "删除失败");
    } finally {
      setBusyProfile("");
    }
  };

  const saveAsProfile = async () => {
    const name = profileName.trim();
    if (!name) { setError("先给这套配置起个名（如 DeepSeek、备用号）"); return; }
    setBusyProfile(name);
    setError("");
    try {
      const r = await api.saveByokProfile({
        name,
        base_url: baseUrl.trim() || null,
        model: model.trim() || null,
        ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
      });
      setProfiles(r.profiles);
      setProfileName("");
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败");
    } finally {
      setBusyProfile("");
    }
  };

  const buildBody = () => ({
    enabled,
    base_url: baseUrl.trim() || null,
    model: model.trim() || null,
    // 只在填了新 key 时才提交（不填则后端保留原 key）
    ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
    image_enabled: imageEnabled,
    image_base_url: imageBaseUrl.trim() || null,
    image_model: imageModel.trim() || null,
    ...(imageApiKey.trim() ? { image_api_key: imageApiKey.trim() } : {}),
    agent_auto_spend_limit: autoSpendLimit,
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
      setImageEnabled(c.image_enabled);
      setImageBaseUrl(c.image_base_url || "");
      setImageModel(c.image_model || "");
      setImageKeyConfigured(c.image_key_configured);
      setImageKeyMask(c.image_key_mask || "");
      setImageApiKey("");
      setAutoSpendLimit(c.agent_auto_spend_limit ?? null);
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

          {/* 多供应商配置档：存好几套、一键切换（CC Switch 式） */}
          {profiles.length > 0 && (
            <div>
              <p className="mb-2 text-[13px] font-medium text-slate-700">已存的配置（点切换即生效）</p>
              <div className="space-y-2">
                {profiles.map((p) => (
                  <div
                    key={p.name}
                    className={`flex items-center gap-2 rounded-xl border p-3 ${
                      p.is_active ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[14px] font-medium text-slate-800">{p.name}</span>
                        {p.is_active && (
                          <span className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] text-white">使用中</span>
                        )}
                        {!p.has_key && <span className="text-[11px] text-amber-500">缺 Key</span>}
                      </div>
                      <p className="truncate text-[12px] text-slate-400">
                        {p.model || "默认模型"} · {p.base_url || "默认地址"}
                      </p>
                    </div>
                    {!p.is_active && p.has_key && (
                      <button
                        type="button"
                        onClick={() => activateProfile(p.name)}
                        disabled={!!busyProfile}
                        className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-[13px] text-white disabled:opacity-50"
                      >
                        {busyProfile === p.name ? <Loader2 className="h-4 w-4 animate-spin" /> : "切换"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteProfile(p.name)}
                      disabled={!!busyProfile}
                      aria-label="删除"
                      className="shrink-0 text-slate-300 hover:text-rose-500 disabled:opacity-50"
                    >
                      <XCircle className="h-5 w-5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 把当前填写的内容存成一套配置（方便以后一键切回） */}
          <div className="flex gap-2">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="给当前配置起个名，存起来（如 DeepSeek、备用号）"
              className={inputCls}
            />
            <button
              type="button"
              onClick={saveAsProfile}
              disabled={!!busyProfile || !profileName.trim()}
              className="shrink-0 rounded-xl bg-slate-100 px-4 text-[14px] text-slate-700 disabled:opacity-50"
            >
              存为一套
            </button>
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

          {/* 生图模型（与文字分开配：文字多用 DeepSeek、生图用 OpenAI gpt-image，Key 通常不同） */}
          <div className="space-y-3 rounded-xl bg-slate-50 p-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0 pr-3">
                <p className="text-[15px] font-medium text-slate-800">生图模型（做海报用，可选）</p>
                <p className="mt-0.5 text-xs text-slate-400">选下面的国内主流生图模型、填你自己的 Key 就行。和文字模型的 Key 通常不是同一个，单独配。不开则用平台默认。</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={imageEnabled}
                onClick={() => setImageEnabled((v) => !v)}
                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${imageEnabled ? "bg-brand-600" : "bg-slate-300"}`}
              >
                <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${imageEnabled ? "translate-x-[22px]" : "translate-x-0.5"}`} />
              </button>
            </div>
            {imageEnabled && (
              <>
                {/* 生图供应商预设卡：点一下自动填 base_url + 推荐模型。硅基默认推荐置顶。 */}
                <div>
                  <p className="mb-2 text-[13px] font-medium text-slate-700">选一个生图供应商（点卡片自动填地址和模型）</p>
                  <div className="space-y-2">
                    {IMAGE_PRESETS.map((p) => {
                      const active = imageBaseUrl.trim() === p.base_url;
                      return (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => {
                            setImageBaseUrl(p.base_url);
                            setImageModel(p.model);
                          }}
                          className={`w-full rounded-xl border p-3 text-left transition-colors active:scale-[0.99] ${
                            active ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white hover:border-slate-300"
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[14px] font-medium text-slate-800">{p.label}</span>
                            {p.recommended && (
                              <span className="rounded bg-brand-600 px-1.5 py-0.5 text-[10px] text-white">推荐</span>
                            )}
                            {p.editLogo && (
                              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600">可叠 Logo/二维码</span>
                            )}
                            {active && (
                              <span className="ml-auto text-[11px] font-medium text-brand-600">已选</span>
                            )}
                          </div>
                          <p className="mt-1 text-[12px] leading-snug text-slate-400">{p.note}</p>
                        </button>
                      );
                    })}
                    {/* 海外·降级：弱化在末尾 */}
                    <button
                      type="button"
                      onClick={() => {
                        setImageBaseUrl(IMAGE_PRESET_OVERSEAS.base_url);
                        setImageModel(IMAGE_PRESET_OVERSEAS.model);
                      }}
                      className={`w-full rounded-xl border border-dashed p-3 text-left transition-colors active:scale-[0.99] ${
                        imageBaseUrl.trim() === IMAGE_PRESET_OVERSEAS.base_url
                          ? "border-brand-300 bg-brand-50"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-slate-500">更多 · {IMAGE_PRESET_OVERSEAS.label}</span>
                        {imageBaseUrl.trim() === IMAGE_PRESET_OVERSEAS.base_url && (
                          <span className="ml-auto text-[11px] font-medium text-brand-600">已选</span>
                        )}
                      </div>
                      <p className="mt-1 text-[12px] leading-snug text-slate-400">{IMAGE_PRESET_OVERSEAS.note}</p>
                    </button>
                  </div>
                </div>
                <input className={inputCls} value={imageBaseUrl} onChange={(e) => setImageBaseUrl(e.target.value)} placeholder="接口地址，如 https://api.siliconflow.cn/v1" />
                <input
                  type="password"
                  autoComplete="off"
                  className={inputCls}
                  value={imageApiKey}
                  onChange={(e) => setImageApiKey(e.target.value)}
                  placeholder={imageKeyConfigured ? `已配置 ${imageKeyMask}，留空则不修改` : "生图模型的 Key，sk-..."}
                />
                <input className={inputCls} value={imageModel} onChange={(e) => setImageModel(e.target.value)} placeholder="模型名（点上面卡片自动带入，如 Qwen/Qwen-Image-Edit-2509）" />

                {/* B-5：做海报自动出图上限——老板可调/可关（他自己的生图 Key 和钱，应由他掌控） */}
                <div className="rounded-lg bg-white px-3 py-2.5 ring-1 ring-slate-100">
                  <p className="text-[13px] font-medium text-slate-800">做海报自动出图上限</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-slate-400">
                    选了「跳过确认」时，一次任务最多自动出几张就停下来问你，免得手滑批量出图烧了你的 Key。这是你自己的钱，随你调或关掉。
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    {autoSpendLimit === -1 ? (
                      <span className="flex-1 text-[13px] text-slate-500">已关闭上限（不拦，我自己盯着花费）</span>
                    ) : (
                      <div className="flex flex-1 items-center gap-1.5 text-[13px] text-slate-600">
                        <input
                          type="number"
                          min={0}
                          value={autoSpendLimit ?? 5}
                          onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            setAutoSpendLimit(Number.isNaN(n) ? null : Math.max(0, n));
                          }}
                          className="w-16 rounded-lg bg-[#F2F2F7] px-2.5 py-1.5 text-center text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                        />
                        <span>张/次（默认 5）</span>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setAutoSpendLimit(autoSpendLimit === -1 ? 5 : -1)}
                      className="ml-auto shrink-0 rounded-lg bg-slate-100 px-3 py-1.5 text-[13px] text-slate-600 transition active:scale-[0.98]"
                    >
                      {autoSpendLimit === -1 ? "重新开启上限" : "关闭上限"}
                    </button>
                  </div>
                </div>
              </>
            )}
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
