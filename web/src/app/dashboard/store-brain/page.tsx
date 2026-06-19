"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, Check, Trash2, Loader2, Plus, X } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/auth-context";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { getErrorMessage } from "@/lib/utils";
import type { StoreMemoryItem } from "@/types/store";

/* 「我的店规矩」+「AI 眼里的你的店」——店脑两分区。
 * 上：我的店规矩（老板亲定的 manual）——本店价格 / 不准写的词 / 招牌活动 / 必带卖点这类，
 *     老板「加一条」默认进这里；常驻置顶、突出可编辑。
 * 下：AI 学到的（auto）——后台从平时使用里自动学到的，可改可删；老板一改就升级成店规矩。 */
export default function StoreBrainPage() {
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<StoreMemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // 「加一条」店规矩
  const [adding, setAdding] = useState(false);
  const [newRule, setNewRule] = useState("");
  const [saving, setSaving] = useState(false);

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

  // 按来源分两区：manual=我的店规矩、auto=AI 学到的（缺 source 的老数据按 auto 处理）。
  const { manual, auto } = useMemo(() => {
    const manual: StoreMemoryItem[] = [];
    const auto: StoreMemoryItem[] = [];
    for (const m of items) (m.source === "manual" ? manual : auto).push(m);
    return { manual, auto };
  }, [items]);

  const save = async (id: string) => {
    const content = draft.trim();
    if (!content) return;
    try {
      const updated = await api.updateStoreMemory(id, content);
      // 老板改过的条目后端会升级成 manual，整条替换让它自动归位到「我的店规矩」。
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

  const addRule = async () => {
    const content = newRule.trim();
    if (!content || saving) return;
    setSaving(true);
    try {
      // 老板「加一条」=店规矩，后端 POST 默认存为 manual。
      const created = await api.addStoreMemory(content);
      setItems((prev) => [created, ...prev]);
      setNewRule("");
      setAdding(false);
      toast("已加进我的店规矩", "success");
    } catch (e) {
      toast(getErrorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  // 单条记忆行（编辑/显示），manual 与 auto 复用。
  const row = (m: StoreMemoryItem, i: number) => (
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
  );

  return (
    <div className="mx-auto max-w-2xl pb-24 lg:pb-0">
      <PageHeader title="我的店规矩" backHref="/dashboard" />

      {loading ? (
        <div className="flex justify-center py-16 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-7">
          {/* ── 区一：我的店规矩（老板定的，置顶突出）────────────────── */}
          <section>
            <div className="mb-2 flex items-baseline justify-between px-1">
              <h2 className="text-[17px] font-semibold text-slate-900">我的店规矩</h2>
              <span className="text-xs text-slate-400">老板定的·最优先</span>
            </div>
            <p className="mb-3 px-1 text-[13px] leading-relaxed text-slate-500">
              本店价格、不准写的词、招牌活动、必带卖点……你定的规矩 AI 写东西时一律照办，绝不会被它自己改掉。
            </p>

            <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white shadow-sm">
              {manual.length > 0 && <div>{manual.map(row)}</div>}

              {/* 加一条（默认进店规矩 / manual） */}
              {adding ? (
                <div className={`flex items-start gap-2 px-4 py-3 ${manual.length > 0 ? "border-t border-slate-100" : ""}`}>
                  <textarea
                    value={newRule}
                    onChange={(e) => setNewRule(e.target.value)}
                    rows={2}
                    autoFocus
                    placeholder="比如：台费 25/小时，别写成 20；招牌是夜场 39 元畅打；不准提「最便宜」"
                    className="flex-1 resize-none rounded-xl bg-[#F2F2F7] px-3 py-2 text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                  <button
                    type="button"
                    onClick={addRule}
                    disabled={saving || !newRule.trim()}
                    aria-label="保存这条店规矩"
                    className="mt-1 shrink-0 text-brand-600 disabled:text-slate-300 active:scale-90 transition-transform"
                  >
                    {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAdding(false); setNewRule(""); }}
                    aria-label="取消"
                    className="mt-1 shrink-0 text-slate-300 hover:text-slate-500 active:scale-90 transition-transform"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className={`flex w-full items-center gap-2 px-4 py-3 text-left text-[15px] font-medium text-brand-600 transition-colors hover:bg-brand-50/60 active:bg-brand-50 ${manual.length > 0 ? "border-t border-slate-100" : ""}`}
                >
                  <Plus className="h-4 w-4" />
                  加一条店规矩
                </button>
              )}
            </div>

            {manual.length === 0 && !adding && (
              <p className="mt-2 px-1 text-[13px] text-slate-400">
                还没定规矩。把你最在意的几条先加上——AI 以后写文案、做活动都按这个来。
              </p>
            )}
          </section>

          {/* ── 区二：AI 学到的（自动）──────────────────────────────── */}
          <section>
            <div className="mb-2 flex items-baseline justify-between px-1">
              <h2 className="text-[15px] font-semibold text-slate-700">AI 学到的</h2>
              <span className="text-xs text-slate-400">自动·可改可删</span>
            </div>
            <p className="mb-3 px-1 text-[13px] leading-relaxed text-slate-500">
              AI 从你平时的使用里学到的，可改可删。记错了点铅笔改、点垃圾桶删；你一改，它就升级成上面的「我的店规矩」。
            </p>

            {auto.length === 0 ? (
              <div className="rounded-2xl bg-white py-10 text-center">
                <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-xl">
                  🧠
                </span>
                <p className="mb-1 text-[15px] font-medium text-slate-700">AI 还在认识你的店</p>
                <p className="px-8 text-sm text-slate-400">
                  多用几次工作台或 AI 对话，它会自动记住你店的特点和你的偏好，越用越准。
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl bg-white">
                {auto.map(row)}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
