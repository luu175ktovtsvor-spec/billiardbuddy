"use client";

// 桌面首启 BYOK「3 步傻瓜向导」(B-1)：装好软件第一次用，老板按 3 步把自己的大模型接上。
// ① 选供应商（点卡片自动填好地址和模型）→ ② 粘密钥 + 测试连接 → ③ 连上了、开始用。
// 居中浮层，文案说人话；不替代设置里的 ByokConfigSheet（那个管"改/多供应商/生图"）。

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { ByokConfigIn } from "@/types/store";
import { Loader2, CheckCircle2, ArrowLeft, X, ExternalLink } from "lucide-react";

// 文字模型供应商：8 家国内主流 + 其它自己填。
// 每张带一句"去哪开通"的人话指引和官网链接，新手照着走就能拿到 Key；
// 不预填具体型号——步骤 2 里让老板自己去官网看有哪些模型、复制模型名填。
type Provider = {
  id: string;
  label: string;
  desc: string; // 一句话介绍
  guide: string; // 去哪开通注册充值
  url: string; // 官网/拿 Key 页面（点开在系统浏览器打开）
  base_url: string;
  custom?: boolean; // 自己填：进步骤 2 后地址也可改
  recommended?: boolean;
};

const PROVIDERS: Provider[] = [
  {
    id: "deepseek",
    label: "DeepSeek（深度求索）",
    desc: "国内主流、便宜又稳，做台球房文案足够用，新手首选。",
    guide: "去 platform.deepseek.com 注册 → 充几块钱 → 在「API Keys」点新建，复制那串密钥。",
    url: "https://platform.deepseek.com/api_keys",
    base_url: "https://api.deepseek.com",
    recommended: true,
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    desc: "模型多、一个 Key 多模型、新人常送额度。",
    guide: "去 cloud.siliconflow.cn 注册 → 账户 → 在「API 密钥」点新建。",
    url: "https://cloud.siliconflow.cn/account/ak",
    base_url: "https://api.siliconflow.cn/v1",
  },
  {
    id: "volcengine",
    label: "火山方舟 · 豆包",
    desc: "字节豆包，稳、企业级。",
    guide: "火山引擎控制台 → 方舟 → API Key（模型名填的是「接入点 ID / Model ID」，不是普通模型名）。",
    url: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    id: "bailian",
    label: "通义百炼 · 阿里",
    desc: "阿里通义，模型全。",
    guide: "去 bailian.console.aliyun.com 控制台 → API-KEY。",
    url: "https://bailian.console.aliyun.com/",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    desc: "智谱 GLM 系列。",
    guide: "去 open.bigmodel.cn 控制台 → API Keys。",
    url: "https://open.bigmodel.cn/",
    base_url: "https://open.bigmodel.cn/api/paas/v4/",
  },
  {
    id: "moonshot",
    label: "Kimi · 月之暗面",
    desc: "Kimi，长文本强。",
    guide: "去 platform.moonshot.cn 控制台 → API Keys。",
    url: "https://platform.moonshot.cn/console/api-keys",
    base_url: "https://api.moonshot.cn/v1",
  },
  {
    id: "mimo",
    label: "小米 MiMo",
    desc: "小米出品、响应快、性价比高。",
    guide: "去 mimo.mi.com 用小米账号登录 → API Keys。",
    url: "https://mimo.mi.com/",
    base_url: "https://api.xiaomimimo.com/v1",
  },
  {
    id: "custom",
    label: "其它 · 自己填",
    desc: "任意 OpenAI 兼容的都行（硅基 / 火山 / 通义…）。",
    guide: "到你那家官网拿地址、模型名、密钥，下一步手动填。",
    url: "",
    base_url: "",
    custom: true,
  },
];

// 在系统浏览器打开外链：Electron 主进程已用 setWindowOpenHandler 把 window.open(http...) 转交系统浏览器；
// 普通网页里就是新标签打开。统一走这个，省得各处重复。
function openExternal(url: string) {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

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
    setModel(""); // 不预填型号——步骤 2 让老板去官网看可用模型、自己填
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

              {/* 自己填的供应商：接口地址也露出来让填（选好的厂商已自动带好地址） */}
              {provider.custom && (
                <div className="mt-4">
                  <label className="mb-1 block text-[13px] font-medium text-[#1d1d1f]">接口地址</label>
                  <input
                    className={inputCls}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://你的模型地址/v1"
                  />
                </div>
              )}

              {/* 模型名：所有厂商都要填（型号各家不同、也常更新，去官网看了再填最准） */}
              <div className="mt-4">
                <label className="mb-1 block text-[13px] font-medium text-[#1d1d1f]">模型名</label>
                <input
                  className={inputCls}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="粘贴你在该厂商选的模型名"
                />
                {provider.id === "volcengine" && (
                  <p className="mt-1.5 text-[12px] leading-snug text-[#86868b]">
                    火山填的是「接入点 ID / Model ID」，不是普通模型名。
                  </p>
                )}
                {provider.url && (
                  <button
                    type="button"
                    onClick={() => openExternal(provider.url)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-[#007AFF] transition-colors hover:underline"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    去 {provider.label} 官网看有哪些模型、复制模型名填这里
                  </button>
                )}
              </div>

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
