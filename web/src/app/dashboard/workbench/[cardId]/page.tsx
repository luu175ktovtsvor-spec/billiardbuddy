"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getErrorMessage } from "@/lib/utils";
import type {
  GenerationResponse,
  WorkbenchRole,
  TargetCustomerType,
  OutputPackageItem,
} from "@/types/generate";
import {
  getTaskById,
  ROLE_TASKS,
  ROLE_LABELS,
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
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { useToast } from "@/components/ui/toast";
import {
  Sparkles,
  Copy,
  Check,
  RefreshCw,
  Pencil,
  Loader2,
  MoreHorizontal,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";

/* ─── helpers ─── */

function trackTaskCardUsage(cardId: string) {
  try {
    const usage: Record<string, number> = JSON.parse(
      localStorage.getItem("workbench_card_usage") || "{}"
    );
    usage[cardId] = (usage[cardId] || 0) + 1;
    localStorage.setItem("workbench_card_usage", JSON.stringify(usage));
  } catch {
    // ignore
  }
}

/* ─── inner page (needs Suspense boundary for useParams) ─── */

function TaskExecutionPageInner() {
  const params = useParams<{ cardId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const cardId = params.cardId as string;
  const card = getTaskById(cardId);

  /* ─── form state — pre-filled from card ─── */
  const [intent, setIntent] = useState("");
  const [role, setRole] = useState<WorkbenchRole>("manager");
  const [targetCustomer, setTargetCustomer] = useState<TargetCustomerType>("all");
  const [outputPackage, setOutputPackage] = useState<OutputPackageItem[]>(DEFAULT_OUTPUT_PACKAGE);
  const [extraNote, setExtraNote] = useState("");
  const [showOutputCustom, setShowOutputCustom] = useState(false);

  /* ─── generation state ─── */
  const [generating, setGenerating] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [result, setResult] = useState<GenerationResponse | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [effectRating, setEffectRating] = useState<string | null>(null);
  const [showRepurpose, setShowRepurpose] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [repurposing, setRepurposing] = useState(false);
  const [quota, setQuota] = useState<{
    used: number;
    limit: number;
    remaining: number;
  } | null>(null);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  /* ─── model (hidden, always default) ─── */
  const [selectedModel] = useState<string>("deepseek-v4-flash");

  /* ─── refs ─── */
  const inputSectionRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /* ─── pre-fill form from card data on mount ─── */
  useEffect(() => {
    if (card) {
      // URL 带 intent 时优先（历史页"继续对话"跳转传入）
      const urlIntent = searchParams.get("intent");
      setIntent(urlIntent || card.userIntentTemplate);
      setRole(card.role);
      setTargetCustomer(card.targetCustomerType);
      setOutputPackage(card.outputPackage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);

  /* ─── load quota ─── */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api
      .getQuota()
      .then((res) => {
        if (!cancelled)
          setQuota({
            used: res.monthly_generations_used,
            limit: res.monthly_generation_limit,
            remaining: res.remaining,
          });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  /* ─── streaming generation ─── */
  const doGenerate = async (opts?: { optimizeNote?: string; isCardClick?: boolean }) => {
    if (!intent.trim()) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setError("");
    setResult(null);
    setStreamingContent("");
    setEditing(false);
    setEffectRating(null);
    setShowMoreActions(false);
    setShowRepurpose(false);
    setGenerating(true);

    if (opts?.isCardClick && card) {
      trackTaskCardUsage(card.id);
    }

    try {
      const extra = opts?.optimizeNote || extraNote || undefined;
      await api.streamWorkbench(
        {
          user_intent: intent.trim(),
          role,
          target_customer_type: targetCustomer || undefined,
          output_package: outputPackage.length > 0 ? outputPackage : undefined,
          extra_note: extra,
          prompt_key: card?.promptKey,
          model: selectedModel || undefined,
          conversation_id: conversationIdRef.current || undefined,
        },
        (token) => setStreamingContent((prev) => prev + token),
        (fullContent, generationId, convId) => {
          setResult({
            generation_id: generationId,
            type: "workbench",
            sub_type: card?.promptKey || role,
            content: fullContent,
            created_at: new Date().toISOString(),
            profile_suggestions: null,
          });
          setStreamingContent("");
          if (convId) {
            conversationIdRef.current = convId;
            setConversationId(convId);
          }
          setTimeout(
            () =>
              resultRef.current?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              }),
            100
          );
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

  /* ─── auto-generate on card click ─── */
  const autoGeneratedRef = useRef(false);
  useEffect(() => {
    if (card && !autoGeneratedRef.current && intent) {
      autoGeneratedRef.current = true;
      doGenerate({ isCardClick: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id, intent]);

  /* ─── copy ─── */
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
    toast("已复制到剪贴板", "success");
    setTimeout(() => setCopied(false), 2000);
  };

  /* ─── feedback ─── */
  const handleFeedback = async (rating: "good" | "bad") => {
    if (!result?.generation_id) return;
    try {
      await api.submitFeedback(result.generation_id, rating);
      setEffectRating(rating);
      toast(rating === "good" ? "感谢反馈" : "收到，我们会改进", "success");
    } catch {
      // silent
    }
  };

  /* ─── repurpose ─── */
  const handleRepurpose = async (platform: string) => {
    if (!result?.generation_id) return;
    setRepurposing(true);
    setShowRepurpose(false);
    setShowMoreActions(false);
    try {
      // 统一走 api 封装：带 X-Store-Id（多门店不串店）、401 自动刷新、非 2xx 抛错
      const data = await api.repurposeContent(result.generation_id, platform);
      setResult({ ...result, content: data.content });
      toast("已转换为" + platform + "版本", "success");
    } catch (err) {
      toast(getErrorMessage(err) || "转换失败，请重试", "error");
    } finally {
      setRepurposing(false);
    }
  };

  /* ─── loading ─── */
  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  /* ─── card not found ─── */
  if (!card) {
    return (
      <div className="mx-auto max-w-3xl">
        <Breadcrumb
          items={[
            { label: "返回首页", href: "/dashboard" },
            { label: "AI 工作台", href: "/dashboard/workbench" },
            { label: "任务不存在" },
          ]}
        />
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-sm text-slate-500 mb-4">
            找不到该任务卡片，可能已被移除。
          </p>
          <button
            type="button"
            onClick={() => router.push("/dashboard/workbench")}
            className="text-sm text-indigo-600 hover:text-indigo-500"
          >
            返回工作台
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* ─── Breadcrumb ─── */}
      <Breadcrumb
        items={[
          { label: "AI 工作台", href: "/dashboard/workbench" },
          { label: ROLE_LABELS[card.role] },
          { label: card.title },
        ]}
      />

      {/* ─── Card header ─── */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-900">{card.title}</h2>
        <p className="mt-1 text-sm text-slate-500">{card.description}</p>
        {card.sceneTags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {card.sceneTags.map((tag) => (
              <span
                key={tag}
                className="inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-500"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ─── Quota warning ─── */}
      {quota && quota.remaining <= 5 && quota.remaining > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs text-amber-700">
            本月剩余 {quota.remaining} 次生成额度
          </p>
        </div>
      )}
      {quota && quota.remaining <= 0 && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-700">本月额度已用完</p>
        </div>
      )}

      {/* ─── Input section ─── */}
      <div
        ref={inputSectionRef}
        className="mb-6 rounded-lg border border-slate-200 bg-white p-4 sm:p-6 shadow-sm"
      >
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
          <p className="mt-1 text-right text-xs text-slate-400">
            {intent.length}/500
          </p>
        </div>

        {/* Input hints from card */}
        {card.inputHints && card.inputHints.length > 0 && (
          <div className="mb-4 rounded-lg bg-slate-50 px-3 py-2.5">
            <p className="mb-1.5 text-xs font-medium text-slate-500">
              可补充说明：
            </p>
            <div className="flex flex-wrap gap-1.5">
              {card.inputHints.map((hint) => (
                <button
                  key={hint}
                  type="button"
                  onClick={() =>
                    setExtraNote((prev) =>
                      prev ? `${prev}，${hint}` : hint
                    )
                  }
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-500 hover:border-indigo-300 hover:text-indigo-600 transition-colors"
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Role + Customer */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              我的岗位
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as WorkbenchRole)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              目标客户
            </label>
            <select
              value={targetCustomer}
              onChange={(e) =>
                setTargetCustomer(e.target.value as TargetCustomerType)
              }
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
            >
              {CUSTOMER_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Output package — recommended combos */}
        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium text-slate-700">
            想要输出
          </label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {RECOMMENDED_OUTPUT_COMBOS.map((combo) => {
              const isActive =
                JSON.stringify([...outputPackage].sort()) ===
                JSON.stringify([...combo.packages].sort());
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
                  <p className="mb-1 text-xs font-medium text-slate-400 uppercase tracking-wide">
                    {group.label}
                  </p>
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
                                checked
                                  ? prev.filter((v) => v !== opt.value)
                                  : [...prev, opt.value]
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
            补充说明{" "}
            <span className="text-slate-400 font-normal">(选填)</span>
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
          onClick={() => doGenerate()}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 active:scale-[0.98]"
        >
          {generating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
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

      {/* ─── Result section ─── */}
      <div ref={resultRef}>
        {/* Error */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* Streaming */}
        {generating && !result && (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                <p className="text-sm font-medium text-indigo-600">
                  AI 正在生成中...
                </p>
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
                <div className="mt-2 text-xs text-slate-400 text-right">
                  已生成 {streamingContent.length} 字
                </div>
              </div>
            )}
          </div>
        )}

        {/* Final result */}
        {result && !generating && (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            {/* Header */}
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">
                  生成结果
                </p>
                <span className="text-xs text-slate-400">
                  {new Date(result.created_at).toLocaleString("zh-CN")}
                </span>
              </div>
              {intent && (
                <p className="mt-1 text-xs text-slate-500 truncate">
                  本次需求：{intent}
                </p>
              )}
              {outputPackage.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {outputPackage.map((pkg) => (
                    <span
                      key={pkg}
                      className="inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-600"
                    >
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
            {result.profile_suggestions &&
              result.profile_suggestions.length > 0 && (
                <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
                  <div className="mb-2 flex items-center gap-2">
                    <p className="text-xs font-medium text-amber-600">
                      让结果更准：
                    </p>
                    <Link
                      href="/dashboard/store-settings"
                      className="text-xs font-medium text-indigo-600 underline hover:text-indigo-600"
                    >
                      去补充
                    </Link>
                  </div>
                  <div className="space-y-1.5">
                    {result.profile_suggestions.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 text-xs text-amber-600"
                      >
                        <span className="mt-0.5 shrink-0">●</span>
                        <span>
                          <span className="font-medium">{s.title}</span> —{" "}
                          {s.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            {/* Actions */}
            <div className="border-t border-slate-100 px-4 py-3">
              {/* Primary: copy */}
              <div className="flex gap-2 mb-2">
                <button
                  type="button"
                  onClick={() =>
                    handleCopy(editing ? editedContent : result.content)
                  }
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-all duration-150 active:scale-[0.98]"
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copied ? "已复制到剪贴板" : "一键复制"}
                </button>
              </div>

              {/* "Based on this" optimization */}
              {conversationId && (
                <div className="mb-2 rounded-md border border-indigo-200 bg-indigo-50 p-2.5">
                  <p className="text-xs text-indigo-600 mb-1.5">
                    基于上一条结果继续优化：
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="想改哪里？直接说..."
                      className="flex-1 rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          const target = e.target as HTMLInputElement;
                          const optimizeNote = target.value.trim();
                          if (!optimizeNote) return;
                          target.value = "";
                          await doGenerate({ optimizeNote });
                        }
                      }}
                    />
                  </div>
                </div>
              )}

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
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => doGenerate()}
                    disabled={generating}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                  >
                    <RefreshCw className="h-3 w-3" />
                    重新生成
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowMoreActions(!showMoreActions)}
                      className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors"
                    >
                      <MoreHorizontal className="h-3 w-3" />
                      更多
                    </button>
                    {showMoreActions && (
                      <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-lg z-10 min-w-[160px]">
                        <button
                          type="button"
                          onClick={() => {
                            setEditedContent(result.content);
                            setEditing(true);
                            setShowMoreActions(false);
                          }}
                          className="flex items-center gap-2 w-full text-left px-4 py-2 text-sm hover:bg-slate-50 rounded-t-lg"
                        >
                          <Pencil className="h-3 w-3" /> 编辑
                        </button>
                        <Link
                          href={`/dashboard/posters/new?prompt=${encodeURIComponent(
                            result.content.substring(0, 200)
                          )}`}
                          className="flex items-center gap-2 w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
                          onClick={() => setShowMoreActions(false)}
                        >
                          生成配套海报
                        </Link>
                        <button
                          type="button"
                          onClick={() => setShowRepurpose(!showRepurpose)}
                          className="flex items-center gap-2 w-full text-left px-4 py-2 text-sm hover:bg-slate-50"
                        >
                          <RefreshCw className="h-3 w-3" /> 变体为...
                        </button>
                        {showRepurpose && (
                          <div className="border-t border-slate-100">
                            {[
                              { platform: "douyin", label: "抖音文案" },
                              {
                                platform: "xiaohongshu",
                                label: "小红书文案",
                              },
                              {
                                platform: "group_notice",
                                label: "群公告",
                              },
                              {
                                platform: "wechat_moments",
                                label: "朋友圈",
                              },
                            ].map((p) => (
                              <button
                                key={p.platform}
                                onClick={() => handleRepurpose(p.platform)}
                                className="block w-full text-left px-8 py-2 text-sm hover:bg-slate-50"
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Feedback */}
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

        {/* Empty state */}
        {!result && !generating && !error && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white py-16 px-6 text-center shadow-sm">
            <Sparkles className="h-8 w-8 text-indigo-300 mb-2" />
            <p className="text-sm font-medium text-slate-500 mb-1">
              点击上方按钮开始生成
            </p>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs">
              AI 将根据你的需求和门店信息，生成专业的运营内容。
            </p>
          </div>
        )}

        {/* Next step guidance after generation */}
        {result && !generating && (
          <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="mb-3 text-sm font-medium text-slate-700">
              接下来你可以：
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(ROLE_TASKS[role] || [])
                .filter((c: RoleTaskCard) => c.id !== cardId)
                .slice(0, 2)
                .map((nextCard: RoleTaskCard) => (
                <Link
                  key={nextCard.id}
                  href={`/dashboard/workbench/${nextCard.id}`}
                  className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-200 hover:bg-indigo-50/50 transition-all"
                >
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
                  <div>
                    <p className="text-xs font-medium text-slate-700">
                      {nextCard.title}
                    </p>
                    <p className="text-xs text-slate-400 line-clamp-1">
                      {nextCard.description}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
            <button
              type="button"
              onClick={() => router.push("/dashboard/workbench")}
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

/* ─── page wrapper with Suspense ─── */

export default function TaskExecutionPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
        </div>
      }
    >
      <TaskExecutionPageInner />
    </Suspense>
  );
}
