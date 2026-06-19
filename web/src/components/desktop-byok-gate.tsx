"use client";

// 桌面版首启引导:纯 BYOK 模式下,老板必须先填自己的大模型 Key,AI 才能工作。
// 没填时在首页顶部弹一条显眼提示 + 一键打开设置面板,避免"装了却一让 AI 写就报错、不知去哪填"。
// 仅桌面端(window.electron)显示;浏览器版用平台 key,不显示。

import { useCallback, useEffect, useState } from "react";
import { Sparkles, KeyRound } from "lucide-react";
import { useDesktop } from "@/hooks/use-desktop";
import { api } from "@/lib/api";
import { ByokOnboardingWizard } from "@/components/byok-onboarding-wizard";

export function DesktopByokGate() {
  const { isDesktop } = useDesktop();
  const [needsKey, setNeedsKey] = useState(false);
  const [checked, setChecked] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const check = useCallback(async () => {
    try {
      const c = await api.getByokConfig();
      // "可用" = 启用 BYOK 且已配置 key;否则桌面无可用大模型 key
      setNeedsKey(!(c.enabled && c.key_configured));
    } catch {
      // 拿不到状态(非 owner / 接口错)不挡路,避免误挡
      setNeedsKey(false);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    (async () => {
      await check();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [isDesktop, check]);

  if (!isDesktop || !checked || !needsKey) return null;

  return (
    <>
      <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100">
            <KeyRound className="h-5 w-5 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold text-amber-900">先填入你的大模型 Key，AI 才能开工</p>
            <p className="mt-1 text-[13px] leading-relaxed text-amber-700">
              桌面版用你自己的大模型账号（如 DeepSeek），费用走你的账号、数据留在本机。
              填一次就行，之后写文案/做方案/改报表都能用。
            </p>
            <button
              onClick={() => setWizardOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-[14px] font-medium text-white transition active:scale-[0.98]"
            >
              <Sparkles className="h-4 w-4" />
              立即设置 Key
            </button>
          </div>
        </div>
      </div>
      <ByokOnboardingWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onDone={() => {
          void check(); // 向导填好后复查:配上了就自动撤掉提示条
        }}
      />
    </>
  );
}
