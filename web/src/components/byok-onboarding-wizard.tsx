"use client";

// 桌面首启 BYOK「3 步傻瓜向导」(B-1)：装好软件第一次用，老板按 3 步把自己的大模型接上。
// ① 选供应商（点卡片自动填好地址和模型）→ ② 粘密钥 + 测试连接 → ③ 连上了、开始用。
// 居中浮层，文案说人话；不替代设置里的 ByokConfigSheet（那个管"改/多供应商/生图"）。

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { ByokConfigIn } from "@/types/store";
import { Loader2, CheckCircle2, ArrowLeft, X } from "lucide-react";

// 文字模型供应商：DeepSeek 推荐置顶、小米 MiMo、其它自己填。
// 每张带一句"去哪开通"的人话指引，新手照着走就能拿到 Key。
type Provider = {
  id: string;
  label: string;
  desc: string; // 一句话介绍
  guide: string; // 去哪开通注册充值
  base_url: string;
  model: string;
  custom?: boolean; // 自己填：进步骤 2 后地址/模型也可改
  recommended?: boolean;
};

const PROVIDERS: Provider[] = [
  {
    id: "deepseek",
    label: "DeepSeek（深度求索）",
    desc: "国内主流、便宜又稳，做台球房文案足够用，新手首选。",
    guide: "去 platform.deepseek.com 注册、充几块钱、在「API Keys」里点新建，复制那串密钥。",
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    recommended: true,
  },
  {
    id: "mimo",
    label: "小米 MiMo",
    desc: "小米出品，响应快、性价比高，也能跑。",
    guide: "去小米开放平台注册开通、充值后创建一个密钥，复制下来。",
    base_url: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5",
  },
  {
    id: "custom",
    label: "其它 · 自己填",
    desc: "用别家模型（硅基流动 / 火山 / 通义等任意 OpenAI 兼容的都行）。",
    guide: "到你那家模型的官网拿到接口地址、模型名和密钥，下一步手动填。",
    base_url: "",
    model: "",
    custom: true,
  },
];

const inputCls =
  "w-full rounded-lg bg-[#f5f5f7] px-3.5 py-2.5 text-[14px] text-[#1d1d1f] placeholder-[#86868b] focus:outline-none focus:ring-2 focus:ring-[#007AFF]/25";

export function ByokOnboardingWizard({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 每次打开重置到第一步
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setProvider(null);
    setBaseUrl("");
    setModel("");
    setApiKey("");
    setTesting(false);
    setSaving(false);
    setError("");
  }, [open]);

  if (!open) return null;

  const pickProvider = (p: Provider) => {
    setProvider(p);
    setBaseUrl(p.base_url);
    setModel(p.model);
    setError("");
    setStep(2);
  };

  // 步骤2 → 步骤3：测试连接（带上当前填的地址/模型/密钥），通了才放行
  const handleTest = async () => {
    setError("");
    if (!apiKey.trim()) {
      setError("先把你的密钥粘进来。");
      return;
    }
    if (!baseUrl.trim() || !model.trim()) {
      setError("接口地址和模型名都要填上（选 DeepSeek/小米会自动带好）。");
      return;
    }
    setTesting(true);
    try {
      const body: ByokConfigIn = {
        enabled: true,
        base_url: baseUrl.trim(),
        model: model.trim(),
        api_key: apiKey.trim(),
      };
      const res = await api.validateByokConfig(body);
      if (res.ok) {
        setStep(3);
      } else {
        setError(friendlyTestError(res.error));
      }
    } catch (err) {
      setError(err instanceof ApiError ? friendlyTestError(err.detail) : "测试没成功，检查下网络再试。");
    } finally {
      setTesting(false);
    }
  };

  // 步骤3：保存并启用，然后收尾
  const handleStart = async () => {
    setError("");
    setSaving(true);
    try {
      const body: ByokConfigIn = {
        enabled: true,
        base_url: baseUrl.trim(),
        model: model.trim(),
        api_key: apiKey.trim(),
      };
      await api.updateByokConfig(body);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "保存失败，再点一次试试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4">
      <div className="w-full max-w-[460px] rounded-2xl bg-white shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
        {/* 顶部：进度点 + 关闭 */}
        <div className="flex items-center justify-between px-5 pt-5">
          <div className="flex items-center gap-2">
            {([1, 2, 3] as const).map((s) => (
              <span
                key={s}
                className={`h-2 rounded-full transition-all ${
                  s === step ? "w-6 bg-[#007AFF]" : s < step ? "w-2 bg-[#28c840]" : "w-2 bg-[#e5e5ea]"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-lg p-1 text-[#86868b] transition-colors hover:bg-[#f5f5f7] active:scale-[0.98]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-5 pt-3">
          {/* 步骤一：选供应商 */}
          {step === 1 && (
            <div>
              <h2 className="text-[17px] font-semibold text-[#1d1d1f]">先挑一家大模型</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[#86868b]">
                桌面版用你自己的大模型账号干活，费用走你的账号、数据全留在本机。还没有的话照卡片里的指引去开通，三五分钟搞定。
              </p>
              <div className="mt-4 space-y-2.5">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => pickProvider(p)}
                    className="w-full rounded-xl border border-[#e5e5ea] bg-white p-3.5 text-left transition-colors hover:border-[#007AFF]/40 active:scale-[0.98]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-medium text-[#1d1d1f]">{p.label}</span>
                      {p.recommended && (
                        <span className="rounded bg-[#007AFF] px-1.5 py-0.5 text-[10px] font-medium text-white">推荐</span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] leading-snug text-[#1d1d1f]/70">{p.desc}</p>
                    <p className="mt-1.5 text-[12px] leading-snug text-[#86868b]">去哪开通：{p.guide}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 步骤二：粘密钥 + 测试连接 */}
          {step === 2 && provider && (
            <div>
              <button
                type="button"
                onClick={() => {
                  setStep(1);
                  setError("");
                }}
                className="-ml-1 mb-2 inline-flex items-center gap-1 rounded-lg px-1 py-0.5 text-[13px] text-[#86868b] transition-colors hover:bg-[#f5f5f7]"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                换一家
              </button>
              <h2 className="text-[17px] font-semibold text-[#1d1d1f]">粘上你的密钥</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[#86868b]">{provider.guide}</p>

              {/* 自己填的供应商：地址和模型也露出来让填 */}
              {provider.custom && (
                <div className="mt-4 space-y-2.5">
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-[#1d1d1f]">接口地址</label>
                    <input
                      className={inputCls}
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://你的模型地址/v1"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-[#1d1d1f]">模型名</label>
                    <input
                      className={inputCls}
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="如 deepseek-v4-pro"
                    />
                  </div>
                </div>
              )}

              <div className="mt-4">
                <label className="mb-1 block text-[13px] font-medium text-[#1d1d1f]">你的密钥</label>
                <input
                  type="password"
                  autoComplete="off"
                  className={inputCls}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="把那串密钥粘进来（sk-...）"
                />
                <p className="mt-1.5 text-[12px] leading-snug text-[#86868b]">
                  密钥加密存在你这台电脑上，绝不上传、也不会明文显示。
                </p>
              </div>

              {error && <p className="mt-3 text-[13px] text-[#ff3b30]">{error}</p>}

              <button
                type="button"
                onClick={handleTest}
                disabled={testing}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#007AFF] py-2.5 text-[15px] font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
              >
                {testing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在连…
                  </>
                ) : (
                  "测试连接"
                )}
              </button>
            </div>
          )}

          {/* 步骤三：连上了 */}
          {step === 3 && (
            <div className="py-2 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#28c840]/10">
                <CheckCircle2 className="h-8 w-8 text-[#28c840]" />
              </div>
              <h2 className="mt-3 text-[17px] font-semibold text-[#1d1d1f]">连上了！</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[#86868b]">
                你的大模型已经接好。点「开始用」就能让 AI 帮你写文案、做活动、出海报了。
              </p>
              {error && <p className="mt-3 text-[13px] text-[#ff3b30]">{error}</p>}
              <button
                type="button"
                onClick={handleStart}
                disabled={saving}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-[#007AFF] py-2.5 text-[15px] font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    保存中…
                  </>
                ) : (
                  "开始用"
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 把后端返回的技术错误翻成老板能看懂的人话
function friendlyTestError(raw?: string): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("401") || s.includes("unauthorized") || s.includes("invalid") || s.includes("api key")) {
    return "密钥不对或没生效，检查下是不是复制全了、对应的是这家供应商。";
  }
  if (s.includes("404") || s.includes("model")) {
    return "找不到这个模型，确认下模型名和供应商对得上。";
  }
  if (s.includes("timeout") || s.includes("timed out") || s.includes("connect") || s.includes("network")) {
    return "连不上接口地址，检查下网络和地址是否填对。";
  }
  if (s.includes("余额") || s.includes("balance") || s.includes("quota") || s.includes("402")) {
    return "账户余额不足，去供应商那边充点钱再试。";
  }
  return raw ? `没连上：${raw}` : "没连上，检查下密钥和地址再试一次。";
}
