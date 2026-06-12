"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Star, Sparkles, ChevronRight } from "lucide-react";
import { ROLE_TASKS } from "@/lib/role-workbench-config";
import { api } from "@/lib/api";
import { markdownToPlainText } from "@/lib/utils";
import type { GenerationHistoryItem } from "@/types/generation-history";

/** 按 prompt_key 找回原任务卡，得到友好标题 + 可重跑的卡片 ID。
 * 找不到（自由输入、非工作台类型）则返回 null，不兜底到第一张卡——
 * 用错场景重跑内容必然跑偏。 */
function resolveCard(item: GenerationHistoryItem): { id: string; title: string } | null {
  const params = (item.input_params || {}) as Record<string, unknown>;
  const promptKey = typeof params.prompt_key === "string" ? params.prompt_key : "";
  if (!promptKey) return null;
  for (const tasks of Object.values(ROLE_TASKS)) {
    const card = tasks.find((t) => t.promptKey === promptKey);
    if (card) return { id: card.id, title: card.title };
  }
  return null;
}

/** 收藏内容的展示标题：优先卡片名，其次需求意图首句，最后兜底。 */
function favoriteTitle(item: GenerationHistoryItem, card: { title: string } | null): string {
  if (card) return card.title;
  const params = (item.input_params || {}) as Record<string, unknown>;
  const intent = typeof params.user_intent === "string" ? params.user_intent : "";
  if (intent) return intent.slice(0, 16);
  return "收藏的内容";
}

/** 重跑链接：仅当能找回原卡片且有原始意图时才给出，保证重跑走同一管道、不跑偏。 */
function rerunHref(item: GenerationHistoryItem, card: { id: string } | null): string | null {
  if (!card) return null;
  const params = (item.input_params || {}) as Record<string, unknown>;
  const intent = typeof params.user_intent === "string" ? params.user_intent : "";
  if (!intent) return null;
  return `/dashboard/workbench/${card.id}?intent=${encodeURIComponent(intent)}`;
}

export function MyTemplates() {
  const [items, setItems] = useState<GenerationHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listGenerations({ is_favorite: true, page_size: 6 });
        if (!cancelled) setItems(res.items);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <Star className="h-5 w-5 text-amber-500" />
          <h3 className="text-[17px] font-semibold text-slate-900 lg:text-base">我的收藏</h3>
        </div>
        <div className="p-6 text-center text-sm text-slate-400">加载中…</div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
          <Star className="h-5 w-5 text-amber-500" />
          <h3 className="text-[17px] font-semibold text-slate-900 lg:text-base">我的收藏</h3>
        </div>
        <div className="p-6 text-center">
          <p className="text-[15px] text-slate-500 mb-1 lg:text-sm">还没有收藏内容</p>
          <p className="text-[13px] text-slate-400 lg:text-xs">
            生成满意的内容后点
            <Star className="inline h-3 w-3 text-amber-500 mx-0.5" />
            收藏，下次在这里一键复用
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 text-amber-500" />
          <h3 className="text-[17px] font-semibold text-slate-900 lg:text-base">我的收藏</h3>
          <span className="text-xs text-slate-400">{items.length}条</span>
        </div>
        <Link
          href="/dashboard/history?favorite=1"
          className="inline-flex items-center gap-0.5 rounded-lg px-2 py-2.5 -my-2 -mr-2 text-[13px] text-slate-400 hover:text-brand-600 active:bg-slate-100 lg:text-xs"
        >
          全部
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="divide-y divide-slate-50">
        {items.map((item) => {
          const card = resolveCard(item);
          const title = favoriteTitle(item, card);
          const href = rerunHref(item, card);
          const preview = markdownToPlainText(item.content || item.result || "").slice(0, 50);
          return (
            <div key={item.id} className="flex min-h-[56px] items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-medium text-slate-900 truncate lg:text-sm">{title}</p>
                {preview && <p className="text-[13px] text-slate-500 truncate lg:text-xs">{preview}</p>}
              </div>
              {href && (
                <Link
                  href={href}
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-brand-50 px-3 py-2.5 text-[13px] font-medium text-brand-600 hover:bg-brand-100 active:scale-[0.98] transition-all lg:text-xs"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  再写一条
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
