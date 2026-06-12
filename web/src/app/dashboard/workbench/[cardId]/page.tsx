"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getErrorMessage, markdownToPlainText, formatDateTime } from "@/lib/utils";
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
import { PageHeader } from "@/components/layout/page-header";
import { Sheet } from "@/components/ui/sheet";
import { QuotaBadge } from "@/components/quota-badge";
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
  Star,
} from "lucide-react";
import Link from "next/link";

/* ─── helpers ─── */

/** 微调预设：把"用户不知道怎么说的调整话"变成可点的按钮 */
const TWEAK_PRESETS = [
  "更口语一点，像店里人随手发的",
  "更简短，控制在三五句",
  "更有吸引力，让人想来",
  "换个角度再写一版",
  "去掉表情符号，正式一点",
];

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
  const [quotaVersion, setQuotaVersion] = useState(0);
  // null=未知(不禁用);0=用尽 → 禁用生成按钮并显示提额出口
  const [quotaRemaining, setQuotaRemaining] = useState<number | null>(null);
  const quotaExhausted = quotaRemaining !== null && quotaRemaining <= 0;
  // 结果里的占位符数量(【请填写/请补充】)——大于 0 时引导用户补门店资料
  const placeholderCount = result?.content
    ? (result.content.match(/【请(填写|补充)/g) || []).length
    : 0;
  const [badNoteOpen, setBadNoteOpen] = useState(false);
  const [isFavorited, setIsFavorited] = useState(false);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  /* ─── model (hidden, always default) ─── */
  const [selectedModel] = useState<string>("deepseek-v4-flash");

  /* ─── refs ─── */
  const inputSectionRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // 记录上次生成的完整参数：失败重试时原样重放（含微调指令），不丢 optimizeNote
  const lastGenOptsRef = useRef<{ optimizeNote?: string; isCardClick?: boolean } | undefined>(undefined);

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

  /* ─── streaming generation ─── */
  const doGenerate = async (opts?: { optimizeNote?: string; isCardClick?: boolean }) => {
    lastGenOptsRef.current = opts;
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
    setIsFavorited(false);
    setBadNoteOpen(false);
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
          setQuotaVersion((v) => v + 1); // 生成完成后实时刷新配额展示
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

  /* 进入卡片不再自动生成：先让用户看到预填的需求、按需修改补充，再手动点「生成」。
     仅记录卡片使用次数（用于首页常用任务排序）。 */
  useEffect(() => {
    if (card) trackTaskCardUsage(card.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);

  /* ─── copy ─── */
  const handleCopy = async (text: string) => {
    // 复制纯文本：粘到微信不带 ** ## 等 Markdown 记号
    const plain = markdownToPlainText(text);
    try {
      await navigator.clipboard.writeText(plain);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = plain;
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
      if (rating === "good") {
        toast("已存入门店金牌范文，AI 之后会参考这条的风格", "success");
      } else {
        // 点踩时收集一句话原因，注入后续生成的"避免清单"
        setBadNoteOpen(true);
      }
    } catch {
      // silent
    }
  };

  const handleBadNoteSubmit = async (note: string) => {
    setBadNoteOpen(false);
    if (!result?.generation_id || !note.trim()) return;
    try {
      await api.submitFeedback(result.generation_id, "bad", note.trim());
      toast("已记录，之后生成会避开这个问题", "success");
    } catch {
      // silent
    }
  };

  /* ─── favorite ─── */
  const handleToggleFavorite = async () => {
    if (!result?.generation_id) return;
    try {
      const res = await api.toggleFavorite(result.generation_id);
      setIsFavorited(res.is_favorite);
      toast(res.is_favorite ? "已收藏，历史页「只看收藏」可找到" : "已取消收藏", "success");
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
      // 切换到变体的新记录 id：否则之后"编辑→保存"会把变体文本写进原始记录，
      // 污染历史和已标"效果好"的金牌范文
      setResult({ ...result, content: data.content, generation_id: data.generation_id || result.generation_id });
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
        <Loader2 className="h-6 w-6 animate-spin text-brand-600" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  /* ─── card not found ─── */
  if (!card) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="AI 生成" backHref="/dashboard/workbench" />
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
            className="inline-flex min-h-[44px] items-center text-sm text-brand-600 hover:text-brand-500"
          >
            返回工作台
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-24 lg:pb-0">
      {/* ─── 手机端顶栏：深层页底部 Tab 已隐藏，← 是唯一返回出口（桌面端隐藏，由 Breadcrumb 接管） ─── */}
      <PageHeader title={card?.title || "AI 生成"} backHref="/dashboard/workbench" />

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

      {/* ─── Quota（试用/套餐 · 实时余量 · 提额引导）─── */}
      <QuotaBadge refreshKey={quotaVersion} onQuota={(q) => setQuotaRemaining(q.remaining)} />

      {/* ─── Input section ─── */}
      <div
        ref={inputSectionRef}
        className="mb-6 rounded-2xl bg-white p-4 sm:p-6 shadow-sm"
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
            className="w-full min-h-[96px] rounded-lg bg-[#F2F2F7] px-3 py-2 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none"
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
                  className="inline-flex min-h-[44px] items-center rounded-full bg-slate-100 px-3 text-xs text-slate-500 hover:border-brand-300 hover:text-brand-600 transition-colors active:scale-[0.98]"
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
              className="w-full min-h-[44px] rounded-lg bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none"
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
              className="w-full min-h-[44px] rounded-lg bg-white px-3 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none"
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
                  className={`inline-flex min-h-[44px] items-center rounded-full border px-3 text-xs transition-colors active:scale-[0.98] ${
                    isActive
                      ? "border-brand-500 bg-brand-600 text-white"
                      : "border-brand-200 bg-brand-50 text-brand-600 hover:bg-brand-100"
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
            className="inline-flex min-h-[44px] items-center text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            {showOutputCustom ? "收起自定义 ▲" : "自定义输出 ▼"}
          </button>
          {showOutputCustom && (
            <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3">
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
                          className={`flex min-h-[44px] items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs cursor-pointer transition-colors ${
                            checked
                              ? "border-brand-500 bg-brand-50 text-brand-600"
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
                            className="h-3 w-3 rounded border-slate-300 text-brand-600"
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
            className="w-full rounded-lg bg-[#F2F2F7] px-3 py-2 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none"
            placeholder="如：不要太长、别写优惠"
          />
        </div>

        {/* Generate button：额度用尽时直接禁用并给出口,不让用户点了再撞 429 */}
        {/* 手机端吸底固定（微信 App 感），桌面端回归卡片内静态布局 */}
        <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-100 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:static lg:border-0 lg:bg-transparent lg:p-0">
          <button
            type="button"
            disabled={generating || !intent.trim() || quotaExhausted}
            onClick={() => doGenerate()}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-base font-medium text-white hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 active:scale-[0.98]"
          >
            {quotaExhausted ? (
              <span className="text-sm leading-snug">
                本月额度已用完 · 联系您的服务商提升，当月立即生效
              </span>
            ) : generating ? (
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
      </div>

      {/* ─── Result section ─── */}
      <div ref={resultRef}>
        {/* Error */}
        {error && (
          <div className="mb-4 flex items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4">
            <p className="flex-1 text-sm text-red-600">{error}</p>
            <button
              type="button"
              onClick={() => doGenerate(lastGenOptsRef.current)}
              disabled={generating}
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-xl border border-red-200 bg-white px-4 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 active:scale-[0.98]"
            >
              重试
            </button>
          </div>
        )}

        {/* Streaming */}
        {generating && !result && (
          <div className="rounded-2xl bg-white">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
                <p className="text-sm font-medium text-brand-600">
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
                  <span className="inline-block w-0.5 h-4 bg-brand-600 animate-pulse ml-0.5 align-text-bottom" />
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
          <div className="rounded-2xl bg-white">
            {/* Header */}
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">
                  生成结果
                </p>
                <span className="text-xs text-slate-400">
                  {formatDateTime(result.created_at)}
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
                      className="inline-block rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-600"
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
                  className="w-full min-h-[200px] rounded-lg border border-brand-200 bg-[#F2F2F7] px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-y"
                />
              ) : (
                <div className="prose prose-sm max-w-none prose-slate prose-headings:text-slate-900 prose-p:text-slate-700 prose-strong:text-slate-900 prose-li:text-slate-700 prose-th:bg-slate-50 prose-th:text-slate-700 prose-td:text-slate-600">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {result.content}
                  </ReactMarkdown>
                </div>
              )}
            </div>

            {/* 占位符引导:内容里有【请填写/请补充】= 门店资料缺对应信息,
                指给用户最短的补全路径,而不是让他每次手动替换 */}
            {!editing && !generating && placeholderCount > 0 && (
              <div className="border-t border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-xs text-amber-700">
                  内容里有 {placeholderCount} 处需要手动补的信息（如价格、时间）。
                  若是价格类：到
                  <Link href="/dashboard/store-settings" className="mx-0.5 font-medium text-brand-600 underline">
                    门店设置
                  </Link>
                  补全「定价体系」，并在运营画像的「团购/价格规则」里开启允许写价格，重新生成即可直接带真实价格。
                </p>
              </div>
            )}

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
                      className="text-xs font-medium text-brand-600 underline hover:text-brand-600"
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
                  className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-500 transition-all duration-150 active:scale-[0.98]"
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {copied ? "已复制到剪贴板" : "一键复制"}
                </button>
              </div>

              {/* 字数与朋友圈折叠提示 */}
              {result.content && (() => {
                const charCount = (editing ? editedContent : result.content).replace(/\s/g, "").length;
                const foldRisk = charCount > 120 && outputPackage.includes("moments");
                return (
                  <p className="mb-2 text-xs text-slate-400">
                    约 {charCount} 字
                    {foldRisk && <span className="text-amber-600">——超过约 120 字发朋友圈会被折叠成一行，建议点「更简短」</span>}
                  </p>
                );
              })()}

              {/* "Based on this" optimization（编辑态收起，防止未保存的修改被 AI 重新生成吞掉） */}
              {conversationId && !editing && (
                <div className="mb-2 rounded-md border border-brand-200 bg-brand-50 p-2.5">
                  <p className="text-xs text-brand-600 mb-1.5">
                    基于上一条结果继续优化（点一下或直接说）：
                  </p>
                  <div className="mb-2 flex gap-2 overflow-x-auto pb-0.5">
                    {TWEAK_PRESETS.map((t) => (
                      <button
                        key={t}
                        type="button"
                        disabled={generating}
                        onClick={() => doGenerate({ optimizeNote: t })}
                        className="h-9 shrink-0 rounded-full border border-brand-200 bg-white px-3 text-xs text-brand-600 hover:bg-brand-100 disabled:opacity-50 transition-colors active:scale-[0.98]"
                      >
                        {t.split("，")[0]}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="想改哪里？直接说..."
                      className="min-h-[44px] flex-1 rounded-lg border border-brand-200 bg-white px-3 py-1.5 text-[15px] text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none"
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
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={async () => {
                      setResult({ ...result, content: editedContent });
                      setEditing(false);
                      // 同步存回历史：历史页看到的就是实际发出去的版本，刷新不丢
                      if (result.generation_id) {
                        try {
                          await api.updateGenerationContent(result.generation_id, editedContent);
                          toast("修改已保存到历史", "success");
                        } catch {
                          toast("修改已应用，但保存到历史失败", "error");
                        }
                      }
                    }}
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-brand-200 bg-brand-50 px-4 text-sm font-medium text-brand-600 hover:bg-brand-100 transition-colors active:scale-[0.98]"
                  >
                    <Check className="h-4 w-4" />
                    保存修改
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(false)}
                    className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors active:scale-[0.98]"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-sm">
                  <button
                    type="button"
                    onClick={() => doGenerate()}
                    disabled={generating}
                    className="inline-flex h-10 items-center gap-1.5 text-slate-500 hover:text-brand-600 transition-colors"
                  >
                    <RefreshCw className="h-4 w-4" />
                    重新生成
                  </button>
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowMoreActions(!showMoreActions)}
                      className="inline-flex h-10 items-center gap-1.5 text-slate-500 hover:text-brand-600 transition-colors"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                      更多
                    </button>
                    {/* 更多操作：底部抽屉（手机端替代悬浮下拉，整行大 cell 可点） */}
                    <Sheet
                      open={showMoreActions}
                      onClose={() => setShowMoreActions(false)}
                      title="更多操作"
                    >
                      <div className="space-y-1 pb-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditedContent(result.content);
                            setEditing(true);
                            setShowMoreActions(false);
                          }}
                          className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-slate-700 hover:bg-slate-50 active:bg-slate-100"
                        >
                          <Pencil className="h-4 w-4 text-slate-400" /> 编辑
                        </button>
                        <Link
                          href={`/dashboard/posters/new?prompt=${encodeURIComponent(
                            result.content.substring(0, 200)
                          )}`}
                          className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-slate-700 hover:bg-slate-50 active:bg-slate-100"
                          onClick={() => setShowMoreActions(false)}
                        >
                          <ArrowRight className="h-4 w-4 text-slate-400" /> 生成配套海报
                        </Link>
                        <button
                          type="button"
                          onClick={() => setShowRepurpose(!showRepurpose)}
                          className="flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-slate-700 hover:bg-slate-50 active:bg-slate-100"
                        >
                          <RefreshCw className="h-4 w-4 text-slate-400" /> 变体为...
                        </button>
                        {showRepurpose && (
                          <div className="grid grid-cols-2 gap-2 pt-1">
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
                                type="button"
                                onClick={() => handleRepurpose(p.platform)}
                                className="h-12 rounded-xl bg-white text-[15px] text-slate-700 hover:bg-slate-50 transition-all active:scale-[0.98]"
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </Sheet>
                  </div>
                  {/* Feedback */}
                  <div className="flex items-center gap-1 ml-auto">
                    <button
                      type="button"
                      onClick={handleToggleFavorite}
                      title={isFavorited ? "取消收藏" : "收藏，历史页随时找回"}
                      className="flex h-10 w-10 items-center justify-center rounded-lg transition-colors text-slate-400 hover:text-amber-600 hover:bg-amber-50 active:scale-[0.98]"
                    >
                      <Star className={`h-4 w-4 ${isFavorited ? "fill-amber-500 text-amber-500" : ""}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleFeedback("good")}
                      title="效果好：AI 会学习这条的风格"
                      className={`flex h-10 w-10 items-center justify-center rounded-lg text-base transition-colors active:scale-[0.98] ${
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
                      className={`flex h-10 w-10 items-center justify-center rounded-lg text-base transition-colors active:scale-[0.98] ${
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

              {/* 点踩原因（可跳过）：填了会进入后续生成的"避免清单"，让差评真正改变行为 */}
              {badNoteOpen && (
                <div className="mt-2 rounded-md border border-red-100 bg-red-50 p-2.5">
                  <p className="mb-1.5 text-xs text-red-500">哪里不满意？说一句，之后生成会避开这个问题（可跳过）</p>
                  <input
                    type="text"
                    maxLength={100}
                    autoFocus
                    placeholder="例：太官方了 / 太长了 / 不像我们店的语气"
                    className="w-full min-h-[44px] rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[15px] text-slate-900 placeholder-slate-400 focus:border-red-400 focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleBadNoteSubmit((e.target as HTMLInputElement).value);
                      } else if (e.key === "Escape") {
                        setBadNoteOpen(false);
                      }
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!result && !generating && !error && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white py-16 px-6 text-center shadow-sm">
            <Sparkles className="h-8 w-8 text-brand-300 mb-2" />
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
          <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
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
                  className="flex items-start gap-2 rounded-xl p-3 text-left hover:border-brand-200 hover:bg-brand-50/50 transition-all active:scale-[0.98]"
                >
                  <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-400" />
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
              className="mt-1 inline-flex min-h-[44px] items-center text-xs text-brand-500 hover:text-brand-600 transition-colors"
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
          <Loader2 className="h-6 w-6 animate-spin text-brand-600" />
        </div>
      }
    >
      <TaskExecutionPageInner />
    </Suspense>
  );
}
