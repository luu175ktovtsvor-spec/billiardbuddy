"use client";

import { useEffect, useState } from "react";
import { Pencil, Check, Trash2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/auth-context";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/utils";
import type { StoreMemoryItem } from "@/types/store";

/* 「AI 眼里的你的店」——店脑可视化 + 人在环纠错。
 * 店脑由生成/对话后台自动学习，这里让老板看见它学到了什么、改错删错。 */
export default function StoreBrainPage() {
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<StoreMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api
      .getStoreMemory()
      .then((d) => { if (!cancelled) setItems(d); })
      .catch((e) => { if (!cancelled) toast(getErrorMessage(e), "error"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const save = async (id: string) => {
    const content = draft.trim();
    if (!content) return;
    try {
      const updated = await api.updateStoreMemory(id, content);
      setItems((prev) => prev.map((m) => (m.id === id ? updated : m)));
      setEditId(null);
      toast("已更新", "success");
    } catch (e) {
      toast(getErrorMessage(e), "error");
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteStoreMemory(id);
      setItems((prev) => prev.filter((m) => m.id !== id));
      toast("已删除", "success");
    } catch (e) {
      toast(getErrorMessage(e), "error");
    }
  };

  const groups = items.reduce<Record<string, StoreMemoryItem[]>>((acc, m) => {
    (acc[m.type_label] ||= []).push(m);
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-2xl pb-24 lg:pb-0">
      <PageHeader title="AI 眼里的你的店" backHref="/dashboard" />
      <p className="px-1 py-3 text-[15px] leading-relaxed text-slate-500">
        你越用，AI 越懂这家店——下面是它学到的。记错了点铅笔改、点垃圾桶删；多用工作台和对话，它会自己长。
      </p>

      {loading ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl bg-white py-12 text-center">
          <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-2xl">
            🧠
          </span>
          <p className="mb-1 text-[15px] font-medium text-slate-700">AI 还在认识你的店</p>
          <p className="px-8 text-sm text-slate-400">
            多用几次工作台或 AI 对话，它会自动记住你店的特点和你的偏好，越用越准。
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {Object.entries(groups).map(([label, list]) => (
            <div key={label}>
              <h2 className="mb-2 px-1 text-[13px] font-medium text-slate-400">{label}</h2>
              <div className="overflow-hidden rounded-2xl bg-white">
                {list.map((m, i) => (
                  <div
                    key={m.id}
                    className={`flex items-start gap-2 px-4 py-3 ${i > 0 ? "border-t border-slate-100" : ""}`}
                  >
                    {editId === m.id ? (
                      <>
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={2}
                          autoFocus
                          className="flex-1 resize-none rounded-xl bg-[#F2F2F7] px-3 py-2 text-[15px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                        />
                        <button
                          type="button"
                          onClick={() => save(m.id)}
                          aria-label="保存"
                          className="mt-1 shrink-0 text-brand-600 active:scale-90 transition-transform"
                        >
                          <Check className="h-5 w-5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="flex-1 text-[15px] leading-relaxed text-slate-800">{m.content}</p>
                        <button
                          type="button"
                          onClick={() => { setDraft(m.content); setEditId(m.id); }}
                          aria-label="编辑"
                          className="mt-0.5 shrink-0 text-slate-300 hover:text-brand-600 active:scale-90 transition-transform"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(m.id)}
                          aria-label="删除"
                          className="mt-0.5 shrink-0 text-slate-300 hover:text-red-500 active:scale-90 transition-transform"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
