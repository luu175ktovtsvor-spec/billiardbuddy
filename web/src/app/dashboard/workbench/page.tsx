"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getErrorMessage } from "@/lib/utils";
import { ApiError } from "@/types/api";
import type { StoreResponse } from "@/types/store";
import type {
  GenerationResponse,
  WorkbenchRole,
  TargetCustomerType,
  OutputPackageItem,
} from "@/types/generate";
import {
  ROLE_TASKS,
  MVP_ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  MODULE_LABELS,
  getOutputLabels,
  type RoleTaskCard,
} from "@/lib/role-workbench-config";
import {
  ROLE_OPTIONS,
  CUSTOMER_TYPE_OPTIONS,
  OUTPUT_PACKAGE_GROUPS,
  DEFAULT_OUTPUT_PACKAGE,
  RECOMMENDED_OUTPUT_COMBOS,
  getOutputPackageLabel,
} from "@/lib/workbench-config";
import { Brain, Sparkles, ArrowRight, Copy, Check, RefreshCw, Pencil, Wand2, ImageIcon, BookOpen, ChevronDown, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";
import Link from "next/link";

const OUTPUT_OPTIONS = OUTPUT_PACKAGE_GROUPS.flatMap((g) => g.items);

/* 任务卡片使用频率（存储在 localStorage） */
function getTaskCardUsage(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("workbench_card_usage") || "{}");
  } catch {
    return {};
  }
}

function trackTaskCardUsage(cardId: string) {
  const usage = getTaskCardUsage();
  usage[cardId] = (usage[cardId] || 0) + 1;
  localStorage.setItem("workbench_card_usage", JSON.stringify(usage));
}

export default function WorkbenchPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>}>
      <WorkbenchPage />
    </Suspense>
  );
}

function WorkbenchPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();

  /* Store */
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [storeLoading, setStoreLoading] = useState(true);

  /* Role tabs for task cards — synced with role select */
  const [activeRole, setActiveRole] = useState<string>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("workbench_role") || "manager";
    return "manager";
  });

  /* Workbench form - load from localStorage */
  const [intent, setIntent] = useState("");
  const [role, setRole] = useState<WorkbenchRole>(() => {
    if (typeof window !== "undefined") return (localStorage.getItem("workbench_role") as WorkbenchRole) || "manager";
    return "manager";
  });
  const [targetCustomer, setTargetCustomer] = useState<TargetCustomerType>(() => {
    if (typeof window !== "undefined") return (localStorage.getItem("workbench_target") as TargetCustomerType) || "all";
    return "all";
  });
  const [outputPackage, setOutputPackage] = useState<OutputPackageItem[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("workbench_package");
      if (saved) try { return JSON.parse(saved); } catch {}
    }
    return DEFAULT_OUTPUT_PACKAGE;
  });
  const [extraNote, setExtraNote] = useState("");

  /* Generation */
  const [generating, setGenerating] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [result, setResult] = useState<GenerationResponse | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [knowledgeItems, setKnowledgeItems] = useState<{ key: string; name: string }[]>([]);
  const [knowledgeExpanded, setKnowledgeExpanded] = useState(false);
  const [showOutputCustom, setShowOutputCustom] = useState(false);
  const [lastUsedCardId, setLastUsedCardId] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [effectRating, setEffectRating] = useState<string | null>(null);
  const [showRepurpose, setShowRepurpose] = useState(false);
  const [repurposing, setRepurposing] = useState(false);
  const [batchResults, setBatchResults] = useState<string[]>([]);
  const [batchGenerating, setBatchGenerating] = useState(false);

  /* Model (hidden from user, always use default) */
  const [selectedModel, setSelectedModel] = useState<string>("deepseek-v4-flash");

  /* Refs */
  const inputSectionRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /* Load store */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setStoreLoading(true);
    api.getMyStore()
      .then((s) => { if (!cancelled) setStore(s); })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setStore(null);
        else setStore(null);
      })
      .finally(() => { if (!cancelled) setStoreLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  /* Save user preferences to localStorage */
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("workbench_role", role);
      localStorage.setItem("workbench_target", targetCustomer);
      localStorage.setItem("workbench_package", JSON.stringify(outputPackage));
    }
  }, [role, targetCustomer, outputPackage]);

  /* Pre-fill from URL params (e.g. from posters page) */
  useEffect(() => {
    const urlIntent = searchParams.get("intent");
    const urlExtraNote = searchParams.get("extra_note");
    if (urlIntent) setIntent(urlIntent);
    if (urlExtraNote) setExtraNote(urlExtraNote);
  }, [searchParams]);

  /* Load knowledge list */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api.listKnowledge()
      .then((res) => { if (!cancelled) setKnowledgeItems(res.items); })
      .catch(() => {});
    api.getQuota()
      .then((res) => { if (!cancelled) setQuota({ used: res.monthly_generations_used, limit: res.monthly_generation_limit, remaining: res.remaining }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  /* Handle task card click — pre-fill and auto-generate with streaming */
  const handleCardClick = async (card: RoleTaskCard) => {
    // Abort previous request if running
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 记录使用频率
    trackTaskCardUsage(card.id);

    setIntent(card.userIntentTemplate);
    setRole(card.role);
    setActiveRole(card.role);
    setTargetCustomer(card.targetCustomerType);
    setLastUsedCardId(card.id);
    setOutputPackage(card.outputPackage);
    setExtraNote("");
    setError("");
    setResult(null);
    setStreamingContent("");
    setConversationId(null); // 新任务卡片开始新对话
    setGenerating(true);

    try {
      await api.streamWorkbench(
        {
          user_intent: card.userIntentTemplate,
          role: card.role,
          target_customer_type: card.targetCustomerType,
          output_package: card.outputPackage.length > 0 ? card.outputPackage : undefined,
          prompt_key: card.promptKey,
          model: selectedModel || undefined,
          conversation_id: conversationId || undefined,
        },
        (token) => setStreamingContent((prev) => prev + token),
        (fullContent, generationId, convId) => {
          setResult({
            generation_id: generationId,
            type: "workbench",
            sub_type: card.promptKey || card.role,
            content: fullContent,
            created_at: new Date().toISOString(),
            profile_suggestions: null,
          });
          setStreamingContent("");
          if (convId) setConversationId(convId);
          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
        },
        (msg) => {
          if (!controller.signal.aborted) setError(msg);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(getErrorMessage(err));
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
    }
  };

  /* Handle free-form generate with streaming */
  const handleGenerate = async () => {
    if (!intent.trim()) return;

    // Abort previous request if running
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setError("");
    setResult(null);
    setStreamingContent("");
    setGenerating(true);

    try {
      await api.streamWorkbench(
        {
          user_intent: intent.trim(),
          role,
          target_customer_type: targetCustomer || undefined,
          output_package: outputPackage.length > 0 ? outputPackage : undefined,
          extra_note: extraNote || undefined,
          model: selectedModel || undefined,
          conversation_id: conversationId || undefined,
        },
        (token) => setStreamingContent((prev) => prev + token),
        (fullContent, generationId, convId) => {
          setResult({
            generation_id: generationId,
            type: "workbench",
            sub_type: role,
            content: fullContent,
            created_at: new Date().toISOString(),
            profile_suggestions: null,
          });
          setStreamingContent("");
          if (convId) setConversationId(convId);
          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
        },
        (msg) => {
          if (!controller.signal.aborted) setError(msg);
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(getErrorMessage(err));
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
    }
  };

  /* Copy */
  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /* Feedback */
  const handleFeedback = async (rating: "good" | "bad") => {
    if (!result?.generation_id) return;
    try {
      await api.submitFeedback(result.generation_id, rating);
      setEffectRating(rating);
    } catch {
      // 静默处理
    }
  };

  /* Repurpose */
  const handleRepurpose = async (platform: string) => {
    if (!result?.generation_id) return;
    setRepurposing(true);
    setShowRepurpose(false);
    try {
      const token = api.getToken();
      const res = await fetch(`${api.baseUrl}/api/v1/generate/repurpose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          generation_id: result.generation_id,
          target_platform: platform,
        }),
      });
      const data = await res.json();
      if (data.content) {
        setResult({ ...result, content: data.content });
      }
    } catch {
      // 静默处理
    } finally {
      setRepurposing(false);
    }
  };

  /* Batch Generate */
  const handleBatchGenerate = async (contentType: string) => {
    setBatchGenerating(true);
    setBatchResults([]);
    try {
      const token = api.getToken();
      const res = await fetch(`${api.baseUrl}/api/v1/generate/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content_type: contentType,
          count: 5,
          extra_note: extraNote || undefined,
        }),
      });
      const data = await res.json();
      if (data.items) {
        setBatchResults(data.items);
      }
    } catch {
      // 静默处理
    } finally {
      setBatchGenerating(false);
    }
  };

  /* Loading states */
  if (authLoading || storeLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-slate-500">加载中...</p>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，AI 工作台才能根据你的门店生成内容。" />;
  }

  const currentTasks = ROLE_TASKS[activeRole as keyof typeof ROLE_TASKS] || [];
  const completeness = store?.operation_profile_completeness;

  return (
    <div className="mx-auto max-w-5xl">
      {/* 顶部标题区 */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Brain className="h-5 w-5 text-indigo-600" />
          <h2 className="text-xl font-bold text-slate-900">AI 工作台</h2>
        </div>
        <p className="text-sm text-slate-500">
          按岗位选任务一键生成，或用大白话描述需求让 AI 帮你做。
        </p>
      </div>

      {/* 门店画像完整度 */}
      {completeness && completeness.overall_score > 0 ? (
        <div className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-slate-900">AI 运营画像完整度</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                completeness.overall_score >= 70
                  ? "bg-emerald-50 border border-emerald-200 text-emerald-600"
                  : completeness.overall_score >= 40
                  ? "bg-amber-50 border border-amber-200 text-amber-600"
                  : "bg-red-50 border border-red-200 text-red-600"
              }`}
            >
              {completeness.overall_score}%
            </span>
          </div>
          <div className="mb-2 h-1.5 w-full rounded-full bg-slate-200">
            <div
              className={`h-1.5 rounded-full transition-all ${
                completeness.overall_score >= 70
                  ? "bg-emerald-500"
                  : completeness.overall_score >= 40
                  ? "bg-amber-500"
                  : "bg-red-500"
              }`}
              style={{ width: `${completeness.overall_score}%` }}
            />
          </div>
          <div className="space-y-0.5 text-xs text-slate-500">
            {completeness.completed_modules.length > 0 && (
              <p>已完善：{completeness.completed_modules.map((m) => MODULE_LABELS[m] || m).join("、")}</p>
            )}
            {completeness.suggested_modules.length > 0 && (
              <p className="text-orange-600">
                建议补充：{completeness.suggested_modules.map((m) => MODULE_LABELS[m] || m).join("、")}
              </p>
            )}
            {completeness.suggested_modules.length > 0 && (
              <Link href="/dashboard/store-settings" className="inline-block mt-1 text-indigo-600 hover:text-indigo-600 font-medium">
                去补充门店资料 →
              </Link>
            )}
          </div>
        </div>
      ) : (
        <div className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
          <p className="text-sm text-slate-500">
            AI 运营画像还没完善，当前也可以先使用；补充后，生成内容会更贴近本店。
            <Link href="/dashboard/store-settings" className="ml-2 text-indigo-600 hover:text-indigo-600 font-medium">
              去补充 →
            </Link>
          </p>
        </div>
      )}

      {/* 配额使用情况 */}
      {quota && quota.limit > 0 && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-slate-700">本月生成次数</span>
            <span className="text-sm text-slate-500">
              {quota.used} / {quota.limit}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-200">
            <div
              className={`h-1.5 rounded-full transition-all ${
                quota.used / quota.limit >= 0.9
                  ? "bg-red-500"
                  : quota.used / quota.limit >= 0.7
                  ? "bg-amber-500"
                  : "bg-indigo-500"
              }`}
              style={{ width: `${Math.min((quota.used / quota.limit) * 100, 100)}%` }}
            />
          </div>
          {quota.remaining <= 5 && quota.remaining > 0 && (
            <p className="mt-1 text-xs text-amber-600">本月剩余 {quota.remaining} 次</p>
          )}
          {quota.remaining <= 0 && (
            <p className="mt-1 text-xs text-red-600">本月额度已用完</p>
          )}
        </div>
      )}

      {/* AI 已掌握的行业知识 */}
      {knowledgeItems.length > 0 && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white shadow-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setKnowledgeExpanded((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-indigo-600" />
              <span className="text-sm font-medium text-slate-700">AI 已掌握的行业知识</span>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600">{knowledgeItems.length} 项</span>
            </div>
            <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${knowledgeExpanded ? "rotate-180" : ""}`} />
          </button>
          {knowledgeExpanded && (
            <div className="border-t border-slate-100 px-4 py-3">
              <div className="flex flex-wrap gap-2">
                {knowledgeItems.map((item) => (
                  <span
                    key={item.key}
                    className="rounded-full bg-slate-50 border border-slate-200 px-2.5 py-1 text-xs text-slate-600"
                  >
                    {item.name}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                这些知识让 AI 更懂台球房行业，生成内容更专业、更接地气。
              </p>
            </div>
          )}
        </div>
      )}

      {/* ─── Section 1: 岗位快捷入口 ─── */}
      <div className="mb-6">
        {/* 岗位切换 */}
        <div className="mb-4 flex gap-2 rounded-lg bg-white border border-slate-200 p-1 overflow-x-auto shadow-sm">
          {MVP_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => { setActiveRole(r); setRole(r as WorkbenchRole); }}
              className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeRole === r
                  ? "bg-slate-50 text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {ROLE_LABELS[r]}
            </button>
          ))}
        </div>

        <p className="mb-3 text-sm text-slate-500">
          {ROLE_DESCRIPTIONS[activeRole as keyof typeof ROLE_DESCRIPTIONS]}。点击任务卡片，自动填入参数并生成。
        </p>

        {/* 任务卡片网格 */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {currentTasks
            .sort((a, b) => {
              const usage = getTaskCardUsage();
              const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
              const pa = order[a.priority] ?? 9;
              const pb = order[b.priority] ?? 9;
              // 同优先级按使用频率排序（高频在前）
              if (pa === pb) {
                return (usage[b.id] || 0) - (usage[a.id] || 0);
              }
              return pa - pb;
            })
            .map((card) => (
              <div
                key={card.id}
                className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-200 hover:shadow transition-all"
              >
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-900">{card.title}</h4>
                  {card.priority === "P0" && (
                    <span className="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-600">
                      推荐
                    </span>
                  )}
                </div>
                <p className="mb-2 text-xs text-slate-500 leading-relaxed">{card.description}</p>
                {card.sceneTags.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {card.sceneTags.map((tag) => (
                      <span key={tag} className="inline-block rounded-full bg-slate-50 px-2 py-0.5 text-xs text-slate-500">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mb-2 text-xs text-slate-400">{getOutputLabels(card.outputPackage)}</div>
                {card.inputHints && card.inputHints.length > 0 && (
                  <div className="mb-2 rounded bg-slate-50 px-2 py-1.5 text-xs">
                    <span className="font-medium text-slate-500">可补充：</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {card.inputHints.map((hint) => (
                        <button
                          key={hint}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExtraNote((prev) => prev ? `${prev}，${hint}` : hint);
                          }}
                          className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                        >
                          {hint}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => handleCardClick(card)}
                    disabled={generating}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                  >
                    {generating ? "生成中..." : "一键生成"}
                    <ArrowRight className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBatchGenerate(card.outputPackage[0] || "moments")}
                    disabled={batchGenerating}
                    className="px-3 py-2 text-xs text-slate-500 border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  >
                    {batchGenerating ? "生成中..." : "批量5条"}
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>

      {/* ─── Section 2: 自由输入区 ─── */}
      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 sm:p-6 shadow-sm" ref={inputSectionRef}>
        <h3 className="mb-4 text-sm font-semibold text-slate-900">自由输入</h3>

        {/* Intent input */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-slate-700">
            我想做什么 <span className="text-red-600">*</span>
          </label>
          <textarea
            rows={3}
            maxLength={500}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none"
            placeholder="例如：好久没联系老客户了，帮我发几句话约他们来打球"
          />
          <p className="mt-1 text-right text-xs text-slate-400">{intent.length}/500</p>
        </div>

        {/* Role + Customer */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">我的岗位</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as WorkbenchRole)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">目标客户</label>
            <select
              value={targetCustomer}
              onChange={(e) => setTargetCustomer(e.target.value as TargetCustomerType)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Output package */}
        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium text-slate-700">想要输出</label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {RECOMMENDED_OUTPUT_COMBOS.map((combo) => {
              const isActive = JSON.stringify(outputPackage.sort()) === JSON.stringify(combo.packages.sort());
              return (
                <button
                  key={combo.key}
                  type="button"
                  onClick={() => setOutputPackage(combo.packages)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    isActive
                      ? "border-indigo-500 bg-indigo-600 text-white"
                      : "border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
                  }`}
                >
                  {combo.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setShowOutputCustom(!showOutputCustom)}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            {showOutputCustom ? "收起自定义 ▲" : "自定义输出 ▼"}
          </button>
          {showOutputCustom && (
            <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              {OUTPUT_PACKAGE_GROUPS.map((group) => (
                <div key={group.key}>
                  <p className="mb-1 text-xs font-medium text-slate-400 uppercase tracking-wide">{group.label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.items.map((opt) => {
                      const checked = outputPackage.includes(opt.value);
                      return (
                        <label
                          key={opt.value}
                          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors ${
                            checked
                              ? "border-indigo-500 bg-indigo-50 text-indigo-600"
                              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setOutputPackage((prev: OutputPackageItem[]) =>
                                checked ? prev.filter((v) => v !== opt.value) : [...prev, opt.value]
                              );
                            }}
                            className="h-3 w-3 rounded border-slate-300 text-indigo-600"
                          />
                          {opt.label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Extra note */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-slate-700">
            补充说明 <span className="text-slate-400 font-normal">(选填)</span>
          </label>
          <textarea
            rows={2}
            maxLength={200}
            value={extraNote}
            onChange={(e) => setExtraNote(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none"
            placeholder="如：不要太长、别写优惠"
          />
        </div>

        {/* Generate button */}
        <button
          type="button"
          disabled={generating || !intent.trim()}
          onClick={handleGenerate}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {generating ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              AI 正在生成中...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              生成运营成品
            </>
          )}
        </button>
      </div>

      {/* ─── Section 3: 生成结果 ─── */}
      <div ref={resultRef}>
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {generating && !result && (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-sm font-medium text-indigo-600">AI 正在生成中...</p>
              </div>
            </div>
            {streamingContent && (
              <div className="px-4 py-4">
                <div className="prose prose-sm prose-slate max-w-none">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {streamingContent}
                  </ReactMarkdown>
                  <span className="inline-block w-0.5 h-4 bg-indigo-600 animate-pulse ml-0.5 align-text-bottom" />
                </div>
              </div>
            )}
          </div>
        )}

        {result && !generating && (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            {/* Header */}
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">生成结果</p>
                <span className="text-xs text-slate-400">
                  {new Date(result.created_at).toLocaleString("zh-CN")}
                </span>
              </div>
              {intent && (
                <p className="mt-1 text-xs text-slate-500 truncate">本次需求：{intent}</p>
              )}
              {outputPackage.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {outputPackage.map((pkg) => (
                    <span key={pkg} className="inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600">
                      {getOutputPackageLabel(pkg)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Content */}
            <div className="px-4 py-4">
              {editing ? (
                <textarea
                  value={editedContent}
                  onChange={(e) => setEditedContent(e.target.value)}
                  className="w-full min-h-[200px] rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-y"
                />
              ) : (
                <div className="prose prose-sm max-w-none prose-slate prose-headings:text-slate-900 prose-p:text-slate-700 prose-strong:text-slate-900 prose-li:text-slate-700 prose-th:bg-slate-50 prose-th:text-slate-700 prose-td:text-slate-600">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {result.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            {/* Profile suggestions */}
            {result.profile_suggestions && result.profile_suggestions.length > 0 && (
              <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
                <div className="mb-2 flex items-center gap-2">
                  <p className="text-xs font-medium text-amber-600">让结果更准：</p>
                  <Link href="/dashboard/store-settings" className="text-xs font-medium text-indigo-600 underline hover:text-indigo-600">
                    去补充
                  </Link>
                </div>
                <div className="space-y-1.5">
                  {result.profile_suggestions.map((s, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs text-amber-600">
                      <span className="mt-0.5 shrink-0">●</span>
                      <span><span className="font-medium">{s.title}</span> — {s.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="border-t border-slate-100 px-4 py-3">
              {/* Primary action */}
              <div className="mb-2">
                <button
                  type="button"
                  onClick={() => handleCopy(editing ? editedContent : result.content)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "已复制到剪贴板" : "一键复制"}
                </button>
              </div>
              {/* Secondary actions */}
              {editing ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setResult({ ...result, content: editedContent });
                      setEditing(false);
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition-colors"
                  >
                    <Check className="h-3 w-3" />
                    保存修改
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setEditedContent(result.content);
                      setEditing(true);
                    }}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <Pencil className="h-3 w-3" />
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setGenerating(true);
                      setEditing(false);
                      setError("");
                      setResult(null);
                      setStreamingContent("");
                      try {
                        await api.streamWorkbench(
                          {
                            user_intent: intent.trim(),
                            role,
                            target_customer_type: targetCustomer || undefined,
                            output_package: outputPackage.length > 0 ? outputPackage : undefined,
                            extra_note: extraNote || undefined,
                            model: selectedModel || undefined,
                            conversation_id: conversationId || undefined,
                          },
                          (token) => setStreamingContent((prev) => prev + token),
                          (fullContent, generationId, convId) => {
                            setResult({
                              generation_id: generationId,
                              type: "workbench",
                              sub_type: role,
                              content: fullContent,
                              created_at: new Date().toISOString(),
                              profile_suggestions: null,
                            });
                            setStreamingContent("");
                            if (convId) setConversationId(convId);
                          },
                          (msg) => setError(msg),
                        );
                      } catch (err) {
                        setError(getErrorMessage(err));
                      } finally {
                        setGenerating(false);
                      }
                    }}
                    disabled={generating}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <Wand2 className="h-3 w-3" />
                    基于此优化
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    disabled={generating}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <RefreshCw className="h-3 w-3" />
                    重新生成
                  </button>
                  <Link
                    href={`/dashboard/posters?prompt=${encodeURIComponent(result.content.substring(0, 200))}`}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <ImageIcon className="h-3 w-3" />
                    生成配套海报
                  </Link>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowRepurpose(!showRepurpose)}
                      disabled={repurposing}
                      className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                    >
                      <RefreshCw className="h-3 w-3" />
                      {repurposing ? "变体中..." : "变体为..."}
                    </button>
                    {showRepurpose && (
                      <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-10 min-w-[140px]">
                        {[
                          { platform: "douyin", label: "抖音文案" },
                          { platform: "xiaohongshu", label: "小红书文案" },
                          { platform: "group_notice", label: "群公告" },
                          { platform: "wechat_moments", label: "朋友圈" },
                        ].map((p) => (
                          <button
                            key={p.platform}
                            onClick={() => handleRepurpose(p.platform)}
                            className="block w-full text-left px-4 py-2 text-sm hover:bg-slate-50 first:rounded-t-lg last:rounded-b-lg"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-auto">
                    <button
                      type="button"
                      onClick={() => handleFeedback("good")}
                      className={`px-2 py-1 rounded text-xs transition-colors ${
                        effectRating === "good"
                          ? "bg-green-100 text-green-700"
                          : "text-slate-400 hover:text-green-600 hover:bg-green-50"
                      }`}
                    >
                      👍
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFeedback("bad")}
                      className={`px-2 py-1 rounded text-xs transition-colors ${
                        effectRating === "bad"
                          ? "bg-red-100 text-red-700"
                          : "text-slate-400 hover:text-red-600 hover:bg-red-50"
                      }`}
                    >
                      👎
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Batch generate results */}
        {batchResults.length > 0 && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-slate-700">批量生成结果（{batchResults.length} 条）</p>
              <button
                type="button"
                onClick={() => setBatchResults([])}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                清空
              </button>
            </div>
            <div className="space-y-3">
              {batchResults.map((item, idx) => (
                <div key={idx} className="rounded-lg border border-slate-100 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="prose prose-sm prose-slate max-w-none flex-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {item}
                      </ReactMarkdown>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(item)}
                      className="shrink-0 text-xs text-slate-400 hover:text-indigo-600"
                    >
                      复制
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!result && !generating && !error && batchResults.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white py-16 px-6 text-center shadow-sm">
            <p className="text-sm font-medium text-slate-500 mb-1">生成结果会显示在这里</p>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs">
              点击上方任务卡片一键生成，或在自由输入区描述你的需求。
            </p>
          </div>
        )}

        {/* Next step guidance after generation */}
        {result && !generating && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="mb-3 text-sm font-medium text-slate-700">接下来你可以：</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {ROLE_TASKS[role]
                ?.filter((c) => c.id !== lastUsedCardId)
                .slice(0, 3)
                .map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => handleCardClick(card)}
                    disabled={generating}
                    className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-200 hover:bg-indigo-50/50 transition-all"
                  >
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
                    <div>
                      <p className="text-xs font-medium text-slate-700">{card.title}</p>
                      <p className="text-xs text-slate-400 line-clamp-1">{card.description}</p>
                    </div>
                  </button>
                ))}
            </div>
            <button
              type="button"
              onClick={() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="mt-3 text-xs text-indigo-500 hover:text-indigo-600 transition-colors"
            >
              查看全部任务 ↑
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
