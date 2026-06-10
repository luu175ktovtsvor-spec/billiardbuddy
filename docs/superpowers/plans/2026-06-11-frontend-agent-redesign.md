# 前端交互重构 + Agent 架构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将前端从单页信息墙重构为 L1/L2/L3 三层页面架构，新增多 Agent 协作能力，提升交互体验和移动端适配。

**Architecture:** 前端采用 Next.js App Router 的动态路由实现 L1→L2→L3 页面层级。后端新增编排引擎（Orchestrator）支持多 Agent 并发协作。现有 API 合约不变，纯 UI 重构不涉及后端改动。

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, TailwindCSS, Lucide React, react-markdown, FastAPI, SQLAlchemy

---

## 文件结构总览

### 新增文件

| 文件 | 职责 |
|------|------|
| `web/src/components/ui/toast.tsx` | Toast 通知组件（全局复用） |
| `web/src/components/ui/breadcrumb.tsx` | 面包屑导航组件 |
| `web/src/app/dashboard/workbench/[cardId]/page.tsx` | L3 任务执行页 |
| `web/src/app/dashboard/workbench/collaborate/page.tsx` | L3' 协作任务页 |
| `web/src/app/dashboard/posters/[conversationId]/page.tsx` | L3 对话执行页 |
| `web/src/app/dashboard/store-settings/[module]/page.tsx` | L3 模块编辑页 |
| `server/services/orchestrator.py` | Agent 编排引擎 |
| `server/api/v1/orchestrate.py` | 协作任务 API 路由 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `web/src/lib/role-workbench-config.ts` | 调整 MVP_ROLES 排序 |
| `web/src/app/dashboard/page.tsx` | 新增常用任务区域 |
| `web/src/app/dashboard/workbench/page.tsx` | 精简为 L2（仅角色Tab+卡片列表） |
| `web/src/app/dashboard/posters/page.tsx` | 重写为 L2 对话列表页 |
| `web/src/app/dashboard/store-settings/page.tsx` | 重写为 L2 模块入口页 |
| `web/src/components/layout/sidebar.tsx` | 适配新路由 |
| `web/src/components/layout/mobile-nav.tsx` | 适配新路由 |
| `server/api/v1/router.py` | 注册新路由 |

---

## Task 1: 创建 Toast 通知组件

**Files:**
- Create: `web/src/components/ui/toast.tsx`

- [ ] **Step 1: 创建 Toast 组件**

```tsx
// web/src/components/ui/toast.tsx
"use client";

import { createContext, useCallback, useContext, useState, useEffect } from "react";
import { CheckCircle, XCircle, AlertCircle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = "success") => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle className="h-4 w-4 text-emerald-500" />,
  error: <XCircle className="h-4 w-4 text-red-500" />,
  warning: <AlertCircle className="h-4 w-4 text-amber-500" />,
  info: <Info className="h-4 w-4 text-indigo-500" />,
};

const BG_COLORS: Record<ToastType, string> = {
  success: "bg-emerald-50 border-emerald-200",
  error: "bg-red-50 border-red-200",
  warning: "bg-amber-50 border-amber-200",
  info: "bg-indigo-50 border-indigo-200",
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-4 py-3 shadow-lg animate-[slideIn_0.3s_ease-out] ${BG_COLORS[toast.type]}`}
    >
      {ICONS[toast.type]}
      <p className="text-sm text-slate-700 flex-1">{toast.message}</p>
      <button onClick={onDismiss} className="text-slate-400 hover:text-slate-600">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 在 Dashboard layout 中注册 ToastProvider**

Read `web/src/app/dashboard/layout.tsx` to find the wrapper element, then add `<ToastProvider>` around `{children}`.

```tsx
// 在 dashboard/layout.tsx 中添加 import
import { ToastProvider } from "@/components/ui/toast";

// 在 return 的最外层 div 内部包裹 children
<ToastProvider>
  {children}
</ToastProvider>
```

- [ ] **Step 3: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`
Expected: 构建成功，无 TypeScript 错误

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ui/toast.tsx web/src/app/dashboard/layout.tsx
git commit -m "feat: 添加 Toast 通知组件"
```

---

## Task 2: 创建面包屑导航组件

**Files:**
- Create: `web/src/components/ui/breadcrumb.tsx`

- [ ] **Step 1: 创建 Breadcrumb 组件**

```tsx
// web/src/components/ui/breadcrumb.tsx
"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export interface BreadcrumbItem {
  label: string;
  href?: string; // 无 href 则为当前页（不可点击）
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-slate-500 mb-4">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-slate-300">/</span>}
          {item.href ? (
            <Link
              href={item.href}
              className="flex items-center gap-1 hover:text-indigo-600 transition-colors"
            >
              {i === 0 && <ChevronLeft className="h-3.5 w-3.5" />}
              {item.label}
            </Link>
          ) : (
            <span className="text-slate-900 font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add web/src/components/ui/breadcrumb.tsx
git commit -m "feat: 添加面包屑导航组件"
```

---

## Task 3: 调整角色排序

**Files:**
- Modify: `web/src/lib/role-workbench-config.ts:1557`

- [ ] **Step 1: 修改 MVP_ROLES 排序**

```typescript
// web/src/lib/role-workbench-config.ts line 1557
// Before:
export const MVP_ROLES: WorkbenchRole[] = ["manager", "assistant_manager", "frontdesk", "boss", "operator", "coach"];

// After:
export const MVP_ROLES: WorkbenchRole[] = ["boss", "manager", "assistant_manager", "coach", "frontdesk", "operator"];
```

- [ ] **Step 2: 验证 workbench-config.ts 的 ROLE_OPTIONS 已是正确顺序**

Read `web/src/lib/workbench-config.ts` lines 12-19，确认 ROLE_OPTIONS 顺序已经是 `boss, manager, assistant_manager, coach, frontdesk, operator`。如果是，无需修改。

- [ ] **Step 3: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/role-workbench-config.ts
git commit -m "fix: 调整角色Tab排序为老板→店长→助教管理→教练→前厅→运营"
```

---

## Task 4: 添加卡片使用频率排序和 Dashboard 常用任务

**Files:**
- Modify: `web/src/app/dashboard/page.tsx`

- [ ] **Step 1: 读取当前 Dashboard 页面**

Read `web/src/app/dashboard/page.tsx`，理解当前结构。

- [ ] **Step 2: 新增 getTopCards 工具函数**

在 `web/src/lib/role-workbench-config.ts` 文件末尾添加：

```typescript
// 获取跨角色 Top N 常用卡片
export function getTopCards(n: number = 6): RoleTaskCard[] {
  if (typeof window === "undefined") return [];
  try {
    const usage: Record<string, number> = JSON.parse(
      localStorage.getItem("workbench_card_usage") || "{}"
    );
    const allCards = Object.values(ROLE_TASKS).flat();
    return allCards
      .sort((a, b) => (usage[b.id] || 0) - (usage[a.id] || 0))
      .slice(0, n);
  } catch {
    return Object.values(ROLE_TASKS).flat().slice(0, n);
  }
}
```

- [ ] **Step 3: 重写 Dashboard 首页**

重写 `web/src/app/dashboard/page.tsx`，保留门店信息、配额、今日推荐，新增常用任务区域，移除快捷入口卡片。

核心改动：在页面顶部（门店信息下方）新增"常用任务"网格，显示 `getTopCards(6)` 的结果，每张卡片显示 emoji + 标题 + 角色来源 + 使用次数，点击通过 `router.push(`/dashboard/workbench/${card.id}`)` 跳转到 L3 任务执行页。

```tsx
// 关键新增部分（在门店信息卡片下方）
import { getTopCards, ROLE_LABELS } from "@/lib/role-workbench-config";
import { useRouter } from "next/navigation";

// 在组件内
const topCards = getTopCards(6);
const router = useRouter();

// 渲染
<div className="mb-6">
  <h3 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
    <span>🔥</span> 常用任务
  </h3>
  <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
    {topCards.map((card) => (
      <button
        key={card.id}
        onClick={() => router.push(`/dashboard/workbench/${card.id}`)}
        className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-left hover:border-indigo-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
      >
        <span className="text-2xl">{card.sceneTags[0] === "经营分析" ? "📊" : card.sceneTags[0] === "客户维护" ? "📱" : "📋"}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 truncate">{card.title}</p>
          <p className="text-xs text-slate-400">{ROLE_LABELS[card.role]}</p>
        </div>
      </button>
    ))}
  </div>
</div>
```

同时移除原来的 4 个快捷入口卡片（workbench/posters/history/store-settings 链接）。

- [ ] **Step 4: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add web/src/app/dashboard/page.tsx web/src/lib/role-workbench-config.ts
git commit -m "feat: Dashboard新增常用任务区域，卡片按使用频率排序"
```

---

## Task 5: 精简工作台为 L2 页面

**Files:**
- Modify: `web/src/app/dashboard/workbench/page.tsx`

- [ ] **Step 1: 读取当前工作台页面**

Read `web/src/app/dashboard/workbench/page.tsx`，标记需要保留和移除的部分。

- [ ] **Step 2: 重写工作台页面**

将 1169 行的工作台页面精简为 ~200 行的 L2 列表页。保留：面包屑、角色 Tab（含协作 Tab）、任务卡片网格。移除：门店画像、配额、知识库、自由输入、生成结果、下一步建议。

```tsx
// web/src/app/dashboard/workbench/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import type { StoreResponse } from "@/types/store";
import type { WorkbenchRole } from "@/types/generate";
import {
  ROLE_TASKS,
  MVP_ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  getOutputLabels,
  type RoleTaskCard,
} from "@/lib/role-workbench-config";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Brain, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

function getTaskCardUsage(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("workbench_card_usage") || "{}");
  } catch {
    return {};
  }
}

export default function WorkbenchPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [storeLoading, setStoreLoading] = useState(true);
  const [activeRole, setActiveRole] = useState<string>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("workbench_role") || "manager";
    return "manager";
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setStoreLoading(true);
    api.getMyStore()
      .then((s) => { if (!cancelled) setStore(s); })
      .catch(() => { if (!cancelled) setStore(null); })
      .finally(() => { if (!cancelled) setStoreLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("workbench_role", activeRole);
    }
  }, [activeRole]);

  if (authLoading || storeLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>;
  }
  if (!isAuthenticated) return null;
  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，AI 工作台才能根据你的门店生成内容。" />;
  }

  const currentTasks = (ROLE_TASKS[activeRole as keyof typeof ROLE_TASKS] || []).sort((a, b) => {
    const usage = getTaskCardUsage();
    const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
    const pa = order[a.priority] ?? 9;
    const pb = order[b.priority] ?? 9;
    if (pa === pb) return (usage[b.id] || 0) - (usage[a.id] || 0);
    return pa - pb;
  });

  const allRoles: Array<{ key: string; label: string; isCollab?: boolean }> = [
    ...MVP_ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
    { key: "collaborate", label: "🤝 协作", isCollab: true },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[{ label: "返回首页", href: "/dashboard" }, { label: "AI 工作台" }]} />

      <div className="flex items-center gap-2 mb-4">
        <Brain className="h-5 w-5 text-indigo-600" />
        <h2 className="text-xl font-bold text-slate-900">AI 工作台</h2>
      </div>

      {/* 角色 Tab */}
      <div className="mb-4 flex gap-2 rounded-lg bg-white border border-slate-200 p-1 overflow-x-auto shadow-sm">
        {allRoles.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => {
              if (r.isCollab) {
                router.push("/dashboard/workbench/collaborate");
              } else {
                setActiveRole(r.key);
              }
            }}
            className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition-all duration-150 ${
              activeRole === r.key && !r.isCollab
                ? "bg-slate-50 text-slate-900 shadow-sm"
                : r.isCollab
                ? "text-indigo-600 hover:bg-indigo-50"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <p className="mb-4 text-sm text-slate-500">
        {ROLE_DESCRIPTIONS[activeRole as keyof typeof ROLE_DESCRIPTIONS]}。点击卡片进入生成。
      </p>

      {/* 任务卡片网格 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {currentTasks.map((card) => (
          <div
            key={card.id}
            onClick={() => router.push(`/dashboard/workbench/${card.id}`)}
            className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm cursor-pointer hover:border-indigo-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <h4 className="text-sm font-semibold text-slate-900">{card.title}</h4>
              {card.priority === "P0" && (
                <span className="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-600">推荐</span>
              )}
            </div>
            <p className="mb-2 text-xs text-slate-500 leading-relaxed">{card.description}</p>
            {card.sceneTags.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {card.sceneTags.map((tag) => (
                  <span key={tag} className="inline-block rounded-full bg-slate-50 px-2 py-0.5 text-xs text-slate-500">{tag}</span>
                ))}
              </div>
            )}
            <div className="mt-auto text-xs text-slate-400">{getOutputLabels(card.outputPackage)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add web/src/app/dashboard/workbench/page.tsx
git commit -m "refactor: 工作台精简为L2列表页，移除输入/结果/配额等"
```

---

## Task 6: 创建 L3 任务执行页

**Files:**
- Create: `web/src/app/dashboard/workbench/[cardId]/page.tsx`

- [ ] **Step 1: 创建动态路由目录和页面**

```tsx
// web/src/app/dashboard/workbench/[cardId]/page.tsx
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getErrorMessage } from "@/lib/utils";
import type { GenerationResponse, WorkbenchRole, TargetCustomerType, OutputPackageItem } from "@/types/generate";
import { getTaskById, ROLE_LABELS, MODULE_LABELS, getOutputLabels, type RoleTaskCard } from "@/lib/role-workbench-config";
import { ROLE_OPTIONS, CUSTOMER_TYPE_OPTIONS, OUTPUT_PACKAGE_GROUPS, DEFAULT_OUTPUT_PACKAGE, RECOMMENDED_OUTPUT_COMBOS, getOutputPackageLabel } from "@/lib/workbench-config";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { useToast } from "@/components/ui/toast";
import { Sparkles, Copy, Check, RefreshCw, Pencil, ImageIcon, MoreHorizontal, Loader2 } from "lucide-react";

const OUTPUT_OPTIONS = OUTPUT_PACKAGE_GROUPS.flatMap((g) => g.items);

function TaskExecutionContent() {
  const { cardId } = useParams<{ cardId: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const card = getTaskById(cardId);

  const [intent, setIntent] = useState("");
  const [role, setRole] = useState<WorkbenchRole>("manager");
  const [targetCustomer, setTargetCustomer] = useState<TargetCustomerType>("all");
  const [outputPackage, setOutputPackage] = useState<OutputPackageItem[]>(DEFAULT_OUTPUT_PACKAGE);
  const [extraNote, setExtraNote] = useState("");
  const [generating, setGenerating] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [result, setResult] = useState<GenerationResponse | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [effectRating, setEffectRating] = useState<string | null>(null);
  const [showRepurpose, setShowRepurpose] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [showOutputCustom, setShowOutputCustom] = useState(false);
  const [quota, setQuota] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  const [lastUsedCardId, setLastUsedCardId] = useState<string | null>(null);

  const resultRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const generatingCardIdRef = useRef<string | null>(null);

  // Pre-fill from card
  useEffect(() => {
    if (card) {
      setIntent(card.userIntentTemplate);
      setRole(card.role);
      setTargetCustomer(card.targetCustomerType);
      setOutputPackage(card.outputPackage);
    }
  }, [card]);

  // Load quota
  useEffect(() => {
    if (!isAuthenticated) return;
    api.getQuota()
      .then((res) => setQuota({ used: res.monthly_generations_used, limit: res.monthly_generation_limit, remaining: res.remaining }))
      .catch(() => {});
  }, [isAuthenticated]);

  // Save preferences
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("workbench_role", role);
      localStorage.setItem("workbench_target", targetCustomer);
      localStorage.setItem("workbench_package", JSON.stringify(outputPackage));
    }
  }, [role, targetCustomer, outputPackage]);

  // Track usage
  const trackUsage = (id: string) => {
    try {
      const usage: Record<string, number> = JSON.parse(localStorage.getItem("workbench_card_usage") || "{}");
      usage[id] = (usage[id] || 0) + 1;
      localStorage.setItem("workbench_card_usage", JSON.stringify(usage));
    } catch {}
  };

  const handleGenerate = async () => {
    if (!intent.trim()) return;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (card) {
      trackUsage(card.id);
      setLastUsedCardId(card.id);
    }

    setError("");
    setResult(null);
    setStreamingContent("");
    setGenerating(true);
    generatingCardIdRef.current = card?.id || null;

    try {
      await api.streamWorkbench(
        {
          user_intent: intent.trim(),
          role,
          target_customer_type: targetCustomer || undefined,
          output_package: outputPackage.length > 0 ? outputPackage : undefined,
          extra_note: extraNote || undefined,
          prompt_key: card?.promptKey,
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
          if (convId) { conversationIdRef.current = convId; setConversationId(convId); }
          generatingCardIdRef.current = null;
          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
        },
        (msg) => { if (!controller.signal.aborted) { setError(msg); generatingCardIdRef.current = null; } },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) { setError(getErrorMessage(err)); generatingCardIdRef.current = null; }
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
    }
  };

  const handleCopy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    toast("已复制到剪贴板");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = async (rating: "good" | "bad") => {
    if (!result?.generation_id) return;
    try { await api.submitFeedback(result.generation_id, rating); setEffectRating(rating); } catch {}
  };

  if (authLoading) return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>;
  if (!card) return <div className="mx-auto max-w-5xl py-10 text-center text-slate-500">任务卡片未找到</div>;

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[
        { label: "工作台", href: "/dashboard/workbench" },
        { label: ROLE_LABELS[role], href: "/dashboard/workbench" },
        { label: card.title },
      ]} />

      {/* 配额提示 */}
      {quota && quota.remaining <= 5 && quota.remaining > 0 && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-600">
          本月剩余 {quota.remaining} 次生成额度
        </div>
      )}
      {quota && quota.remaining <= 0 && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600">
          本月额度已用完
        </div>
      )}

      {/* 输入区 */}
      <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4 sm:p-6 shadow-sm">
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
            placeholder="描述你想做什么..."
          />
          <p className="mt-1 text-right text-xs text-slate-400">{intent.length}/500</p>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">我的岗位</label>
            <select value={role} onChange={(e) => setRole(e.target.value as WorkbenchRole)} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none">
              {ROLE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">目标客户</label>
            <select value={targetCustomer} onChange={(e) => setTargetCustomer(e.target.value as TargetCustomerType)} className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none">
              {CUSTOMER_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
        </div>

        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium text-slate-700">想要输出</label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {RECOMMENDED_OUTPUT_COMBOS.map((combo) => {
              const isActive = JSON.stringify(outputPackage.sort()) === JSON.stringify(combo.packages.sort());
              return (
                <button key={combo.key} type="button" onClick={() => setOutputPackage(combo.packages)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${isActive ? "border-indigo-500 bg-indigo-600 text-white" : "border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100"}`}>
                  {combo.label}
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => setShowOutputCustom(!showOutputCustom)} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
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
                        <label key={opt.value} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer transition-colors ${checked ? "border-indigo-500 bg-indigo-50 text-indigo-600" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                          <input type="checkbox" checked={checked} onChange={() => setOutputPackage((prev) => checked ? prev.filter((v) => v !== opt.value) : [...prev, opt.value])} className="h-3 w-3 rounded border-slate-300 text-indigo-600" />
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

        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium text-slate-700">
            补充说明 <span className="text-slate-400 font-normal">(选填)</span>
          </label>
          <textarea rows={2} maxLength={200} value={extraNote} onChange={(e) => setExtraNote(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none"
            placeholder="如：不要太长、别写优惠" />
        </div>

        <button type="button" disabled={generating || !intent.trim()} onClick={handleGenerate}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
          {generating ? (<><Loader2 className="h-4 w-4 animate-spin" /> AI 正在生成中...</>) : (<><Sparkles className="h-4 w-4" /> 生成运营成品</>)}
        </button>
      </div>

      {/* 生成结果 */}
      <div ref={resultRef}>
        {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>}

        {generating && !result && (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm p-4">
            <div className="flex items-center gap-2 mb-2">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
              <p className="text-sm font-medium text-indigo-600">AI 正在生成中...</p>
            </div>
            {streamingContent && (
              <div className="prose prose-sm prose-slate max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
                <span className="inline-block w-0.5 h-4 bg-indigo-600 animate-pulse ml-0.5 align-text-bottom" />
              </div>
            )}
          </div>
        )}

        {result && !generating && (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">生成结果</p>
              <span className="text-xs text-slate-400">{new Date(result.created_at).toLocaleString("zh-CN")}</span>
            </div>
            <div className="px-4 py-4">
              {editing ? (
                <textarea value={editedContent} onChange={(e) => setEditedContent(e.target.value)}
                  className="w-full min-h-[200px] rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-y" />
              ) : (
                <div className="prose prose-sm max-w-none prose-slate prose-headings:text-slate-900 prose-p:text-slate-700">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.content}</ReactMarkdown>
                </div>
              )}
            </div>
            <div className="border-t border-slate-100 px-4 py-3">
              <div className="flex gap-2 mb-2">
                <button onClick={() => handleCopy(editing ? editedContent : result.content)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "已复制" : "一键复制"}
                </button>
              </div>
              {editing ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => { setResult({ ...result, content: editedContent }); setEditing(false); }}
                    className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition-colors">
                    <Check className="h-3 w-3" /> 保存修改
                  </button>
                  <button onClick={() => setEditing(false)}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors">
                    取消
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-xs">
                  <button onClick={handleGenerate} disabled={generating} className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors">
                    <RefreshCw className="h-3 w-3" /> 重新生成
                  </button>
                  <button onClick={() => { setEditedContent(result.content); setEditing(true); }}
                    className="inline-flex items-center gap-1 text-slate-500 hover:text-indigo-600 transition-colors">
                    <Pencil className="h-3 w-3" /> 编辑
                  </button>
                  <div className="flex items-center gap-1 ml-auto">
                    <button onClick={() => handleFeedback("good")} className={`px-2 py-1 rounded transition-colors ${effectRating === "good" ? "bg-green-100 text-green-700" : "text-slate-400 hover:text-green-600"}`}>👍</button>
                    <button onClick={() => handleFeedback("bad")} className={`px-2 py-1 rounded transition-colors ${effectRating === "bad" ? "bg-red-100 text-red-700" : "text-slate-400 hover:text-red-600"}`}>👎</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 基于此优化 */}
        {result && !generating && conversationId && (
          <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
            <p className="text-xs text-indigo-600 mb-2">💡 基于上一条结果继续优化：</p>
            <div className="flex gap-2">
              <input type="text" placeholder="想改哪里？直接说..."
                className="flex-1 rounded-md border border-indigo-200 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    const target = e.target as HTMLInputElement;
                    const note = target.value.trim();
                    if (!note) return;
                    target.value = "";
                    setGenerating(true);
                    setEditing(false);
                    setError("");
                    setResult(null);
                    setStreamingContent("");
                    try {
                      await api.streamWorkbench(
                        { user_intent: intent.trim(), role, target_customer_type: targetCustomer || undefined, output_package: outputPackage.length > 0 ? outputPackage : undefined, extra_note: note, conversation_id: conversationIdRef.current || undefined },
                        (token) => setStreamingContent((prev) => prev + token),
                        (fullContent, generationId, convId) => {
                          setResult({ generation_id: generationId, type: "workbench", sub_type: role, content: fullContent, created_at: new Date().toISOString(), profile_suggestions: null });
                          setStreamingContent("");
                          if (convId) { conversationIdRef.current = convId; setConversationId(convId); }
                        },
                        (msg) => setError(msg),
                      );
                    } catch (err) { setError(getErrorMessage(err)); }
                    finally { setGenerating(false); }
                  }
                }}
              />
            </div>
          </div>
        )}

        {/* 空状态 */}
        {!result && !generating && !error && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white py-16 px-6 text-center shadow-sm">
            <p className="text-sm font-medium text-slate-500 mb-1">生成结果会显示在这里</p>
            <p className="text-xs text-slate-400">点击上方「生成运营成品」开始</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TaskExecutionPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>}>
      <TaskExecutionContent />
    </Suspense>
  );
}
```

- [ ] **Step 2: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add "web/src/app/dashboard/workbench/[cardId]/page.tsx"
git commit -m "feat: 新增L3任务执行页，从工作台卡片点击进入"
```

---

## Task 7: 重写生图页面为 L2 列表 + L3 对话

**Files:**
- Modify: `web/src/app/dashboard/posters/page.tsx` → 重写为 L2 列表
- Create: `web/src/app/dashboard/posters/[conversationId]/page.tsx` → L3 对话执行页

- [ ] **Step 1: 重写 posters/page.tsx 为 L2 对话列表**

将当前 574 行的生图页面精简为 ~100 行的对话列表页。只保留：面包屑、新建对话按钮、对话列表。点击对话跳转到 `/dashboard/posters/[conversationId]`。

核心结构：
```tsx
// 简化后的 L2 页面
<div className="mx-auto max-w-5xl">
  <Breadcrumb items={[{ label: "返回首页", href: "/dashboard" }, { label: "AI 生图" }]} />
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-xl font-bold text-slate-900">AI 生图</h2>
    <button onClick={handleNewConversation} className="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500">
      <Plus className="h-4 w-4" /> 新建对话
    </button>
  </div>
  <div className="space-y-2">
    {conversations.map((conv) => (
      <div key={conv.id} onClick={() => router.push(`/dashboard/posters/${conv.id}`)}
        className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 cursor-pointer hover:border-indigo-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98]">
        {conv.thumbnail_url ? (
          <img src={api.resolveUrl(conv.thumbnail_url)} alt="" className="h-12 w-12 rounded-lg object-cover" />
        ) : (
          <div className="h-12 w-12 rounded-lg bg-slate-100 flex items-center justify-center"><ImageIcon className="h-5 w-5 text-slate-400" /></div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-700 truncate">{conv.title}</p>
          <p className="text-xs text-slate-400">{conv.message_count} 轮 · {new Date(conv.updated_at).toLocaleDateString("zh-CN")}</p>
        </div>
      </div>
    ))}
    {conversations.length === 0 && (
      <div className="text-center py-16 text-sm text-slate-400">暂无对话，点击「新建对话」开始</div>
    )}
  </div>
</div>
```

- [ ] **Step 2: 创建 L3 对话执行页**

创建 `web/src/app/dashboard/posters/[conversationId]/page.tsx`，将当前生图页面的对话流+输入区+图片操作迁移到这里。

核心结构：面包屑（← 返回列表 / 对话标题）+ 对话消息流 + 底部输入区（textarea + 比例 + 质量 + 参考图 + 发送）。

- [ ] **Step 3: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add web/src/app/dashboard/posters/page.tsx "web/src/app/dashboard/posters/[conversationId]/page.tsx"
git commit -m "refactor: 生图页面拆分为L2列表页+L3对话执行页"
```

---

## Task 8: 重写门店设置为 L2 模块入口 + L3 编辑页

**Files:**
- Modify: `web/src/app/dashboard/store-settings/page.tsx` → 重写为 L2
- Create: `web/src/app/dashboard/store-settings/[module]/page.tsx` → L3

- [ ] **Step 1: 重写 store-settings/page.tsx 为 L2 模块入口**

将 1420 行的门店设置页面精简为 ~120 行的模块入口页。显示 5 个模块卡片：基本信息 / 运营画像 / 品牌风格 / 定价体系 / 广告语，每个卡片显示完成状态。

```tsx
// 模块入口卡片
const MODULES = [
  { slug: "basic", label: "基本信息", icon: "📋", desc: "门店名称、地址、电话、营业时间" },
  { slug: "profile", label: "运营画像", icon: "📊", desc: "门店类型、客群、定价、特色服务" },
  { slug: "branding", label: "品牌风格", icon: "🎨", desc: "品牌调性、Logo、主色调" },
  { slug: "pricing", label: "定价体系", icon: "💰", desc: "台费标准、套餐设计、会员卡" },
  { slug: "slogan", label: "广告语", icon: "📝", desc: "门店宣传语、文案风格" },
];

// 渲染
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
  {MODULES.map((m) => (
    <button key={m.slug} onClick={() => router.push(`/dashboard/store-settings/${m.slug}`)}
      className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-5 text-left hover:border-indigo-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98]">
      <span className="text-2xl">{m.icon}</span>
      <div>
        <p className="text-sm font-semibold text-slate-900">{m.label}</p>
        <p className="text-xs text-slate-400 mt-1">{m.desc}</p>
      </div>
    </button>
  ))}
</div>
```

同时保留团队成员入口链接。

- [ ] **Step 2: 创建 L3 模块编辑页**

创建 `web/src/app/dashboard/store-settings/[module]/page.tsx`。

路由参数 `module` 映射到表单内容：
- `basic` → 基本信息表单（门店名称、地址、电话、营业时间等）
- `profile` → 运营画像表单（门店类型、客群、定价、特色服务等）
- `branding` → 品牌风格表单
- `pricing` → 定价体系表单
- `slogan` → 广告语表单

从当前 1420 行的 store-settings/page.tsx 中提取各模块的表单代码，按 module 参数渲染对应模块。

```tsx
// 核心路由逻辑
const { module } = useParams<{ module: string }>();
const validModules = ["basic", "profile", "branding", "pricing", "slogan"];
if (!validModules.includes(module)) return <div>模块不存在</div>;

// 根据 module 渲染对应表单
// basic → 从原页面提取基本信息表单
// profile → 从原页面提取运营画像表单
// ...
```

- [ ] **Step 3: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add web/src/app/dashboard/store-settings/page.tsx "web/src/app/dashboard/store-settings/[module]/page.tsx"
git commit -m "refactor: 门店设置拆分为L2模块入口+L3编辑页"
```

---

## Task 9: 更新侧边栏和移动端导航

**Files:**
- Modify: `web/src/components/layout/sidebar.tsx`
- Modify: `web/src/components/layout/mobile-nav.tsx`

- [ ] **Step 1: 更新 sidebar.tsx 活跃状态逻辑**

当前侧边栏的活跃状态逻辑需要适配新的子路由。例如 `/dashboard/workbench/xxx` 应该高亮"AI 工作台"，`/dashboard/posters/xxx` 应该高亮"AI 生图"。

```tsx
// sidebar.tsx 的活跃状态判断
const isActive = (href: string) => {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname.startsWith(href);
};
```

这段逻辑已经是前缀匹配，应该能自动适配新路由。只需确认无需修改即可。

- [ ] **Step 2: 确认 mobile-nav.tsx 无需修改**

同理，mobile-nav.tsx 使用 `pathname.startsWith(item.href)`，应该能自动适配。

- [ ] **Step 3: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add web/src/components/layout/sidebar.tsx web/src/components/layout/mobile-nav.tsx
git commit -m "chore: 确认导航组件适配新路由结构"
```

---

## Task 10: 添加全局 CSS 动画

**Files:**
- Modify: `web/src/app/globals.css`

- [ ] **Step 1: 添加 slideIn 动画**

```css
/* web/src/app/globals.css 末尾添加 */
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 2: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add web/src/app/globals.css
git commit -m "feat: 添加全局过渡动画（slideIn/slideUp）"
```

---

## Task 11: 后端 — 创建 Agent 编排引擎

**Files:**
- Create: `server/services/orchestrator.py`

- [ ] **Step 1: 读取现有 services 结构**

Read `server/services/` 目录，了解现有 service 的模式（特别是 `content_service.py` 和 `poster_service.py`）。

- [ ] **Step 2: 创建 orchestrator.py**

```python
# server/services/orchestrator.py
"""Agent 编排引擎 — 多角色协作生成"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from server.services.ai.factory import ProviderFactory
from server.services.ai.prompt_engine import get_prompt_engine
from server.core.tenant import get_current_store_id


# 内存存储协作任务状态（生产环境可替换为 Redis）
_tasks: dict[str, dict] = {}


COLLABORATION_SCENARIOS = {
    "activity_planning": {
        "name": "策划活动",
        "default_roles": ["coach", "frontdesk", "operator", "manager"],
        "description": "多角色协作策划一场完整活动",
    },
    "store_opening": {
        "name": "新店开业",
        "default_roles": ["boss", "manager", "frontdesk", "operator"],
        "description": "新店开业全流程筹备",
    },
    "staff_training": {
        "name": "员工培训",
        "default_roles": ["manager", "coach", "frontdesk"],
        "description": "员工入职和技能培训",
    },
    "business_review": {
        "name": "经营复盘",
        "default_roles": ["boss", "manager", "operator"],
        "description": "月度/季度经营分析",
    },
}


async def analyze_task(description: str) -> list[str]:
    """用 AI 分析任务描述，判断需要哪些角色"""
    engine = get_prompt_engine()
    provider = ProviderFactory.create_text("deepseek-v4-flash")

    prompt = f"""分析以下任务描述，判断需要哪些台球房角色参与协作。

可选角色：boss(老板), manager(店长), assistant_manager(助教管理), coach(教练), frontdesk(前厅), operator(运营)

任务描述：{description}

请只返回需要的角色 key，用逗号分隔，不要其他内容。例如：coach,frontdesk,operator"""

    result = await provider.generate(prompt, max_tokens=100)
    roles = [r.strip() for r in result.split(",") if r.strip()]
    valid_roles = {"boss", "manager", "assistant_manager", "coach", "frontdesk", "operator"}
    return [r for r in roles if r in valid_roles]


async def run_agent(role: str, description: str, store_id: str) -> str:
    """运行单个 Agent 生成内容"""
    engine = get_prompt_engine()
    provider = ProviderFactory.create_text("deepseek-v4-flash")

    # 获取角色的 system prompt
    role_prompts = {
        "boss": "你是台球房的老板/经营负责人，关注全店经营状况、成本控制和战略决策。",
        "manager": "你是台球房的店长，负责全店日常运营管理。",
        "assistant_manager": "你是台球房的助教管理，负责助教团队管理和推广。",
        "coach": "你是台球房的教练，负责教学和竞技客户维护。",
        "frontdesk": "你是台球房的前厅主管，负责客户接待和前台管理。",
        "operator": "你是台球房的运营负责人，负责内容和数据分析。",
    }

    system_prompt = role_prompts.get(role, "你是台球房运营专家。")
    full_prompt = f"""{system_prompt}

请根据以下任务，从你的专业角度生成相关内容：

任务：{description}

要求：
1. 内容要专业、实用、可直接执行
2. 结合台球房行业特点
3. 用清晰的结构输出"""

    return await provider.generate(full_prompt, max_tokens=2000)


async def start_task(
    task_type: str,
    description: str,
    store_id: str,
    roles: Optional[list[str]] = None,
    auto_orchestrate: bool = True,
) -> dict:
    """发起协作任务"""
    task_id = str(uuid.uuid4())

    if auto_orchestrate and not roles:
        roles = await analyze_task(description)
    elif not roles:
        scenario = COLLABORATION_SCENARIOS.get(task_type, {})
        roles = scenario.get("default_roles", ["manager"])

    task = {
        "task_id": task_id,
        "task_type": task_type,
        "description": description,
        "store_id": store_id,
        "roles": roles,
        "status": "running",
        "agents": [
            {"role": r, "status": "pending", "content": None}
            for r in roles
        ],
        "summary": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _tasks[task_id] = task

    # 后台并发执行各 Agent
    asyncio.create_task(_execute_agents(task_id))

    return task


async def _execute_agents(task_id: str):
    """并发执行所有 Agent"""
    task = _tasks.get(task_id)
    if not task:
        return

    store_id = task["store_id"]
    description = task["description"]

    async def run_one(agent: dict):
        agent["status"] = "running"
        try:
            content = await asyncio.wait_for(
                run_agent(agent["role"], description, store_id),
                timeout=30,
            )
            agent["status"] = "completed"
            agent["content"] = content
        except asyncio.TimeoutError:
            agent["status"] = "skipped"
            agent["content"] = "[超时跳过]"
        except Exception as e:
            agent["status"] = "failed"
            agent["content"] = f"[失败: {str(e)}]"

    await asyncio.gather(*[run_one(a) for a in task["agents"]])

    # 汇总
    completed = [a for a in task["agents"] if a["status"] == "completed"]
    if completed:
        task["summary"] = "\n\n---\n\n".join(
            f"### {a['role']} Agent\n\n{a['content']}"
            for a in completed
        )
        task["status"] = "completed"
    else:
        task["status"] = "failed"


def get_task(task_id: str) -> Optional[dict]:
    """查询任务状态"""
    return _tasks.get(task_id)


def cancel_task(task_id: str) -> bool:
    """取消任务"""
    task = _tasks.get(task_id)
    if not task:
        return False
    task["status"] = "cancelled"
    for agent in task["agents"]:
        if agent["status"] in ("pending", "running"):
            agent["status"] = "cancelled"
    return True
```

- [ ] **Step 3: 验证 Python 语法**

Run: `cd server && python -c "from server.services.orchestrator import start_task, get_task, cancel_task; print('OK')"`

- [ ] **Step 4: Commit**

```bash
git add server/services/orchestrator.py
git commit -m "feat: 新增Agent编排引擎，支持多角色并发协作"
```

---

## Task 12: 后端 — 创建协作任务 API

**Files:**
- Create: `server/api/v1/orchestrate.py`
- Modify: `server/api/v1/router.py`

- [ ] **Step 1: 读取现有 API 路由模式**

Read `server/api/v1/router.py` 和 `server/api/v1/generate.py`（前 50 行），了解路由注册模式和请求/响应模型。

- [ ] **Step 2: 创建 orchestrate.py**

```python
# server/api/v1/orchestrate.py
"""协作任务 API"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession

from server.core.security import get_current_user
from server.core.tenant import get_current_store_id
from server.db.session import get_db
from server.services.orchestrator import (
    start_task, get_task, cancel_task,
    COLLABORATION_SCENARIOS,
)

router = APIRouter(prefix="/orchestrate", tags=["orchestrate"])


class OrchestrateRequest(BaseModel):
    task_type: str
    description: str
    roles: Optional[list[str]] = None
    auto_orchestrate: bool = True


class OrchestrateResponse(BaseModel):
    task_id: str
    status: str
    agents: list[dict]
    summary: Optional[str] = None


@router.post("", response_model=OrchestrateResponse)
async def create_orchestration(
    req: OrchestrateRequest,
    current_user=Depends(get_current_user),
    store_id: str = Depends(get_current_store_id),
):
    """发起协作任务"""
    if req.task_type not in COLLABORATION_SCENARIOS and req.task_type != "custom":
        raise HTTPException(status_code=400, detail=f"未知任务类型: {req.task_type}")

    task = await start_task(
        task_type=req.task_type,
        description=req.description,
        store_id=store_id,
        roles=req.roles,
        auto_orchestrate=req.auto_orchestrate,
    )
    return task


@router.get("/{task_id}", response_model=OrchestrateResponse)
async def get_orchestration(
    task_id: str,
    current_user=Depends(get_current_user),
):
    """查询协作任务状态"""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task


@router.post("/{task_id}/cancel")
async def cancel_orchestration(
    task_id: str,
    current_user=Depends(get_current_user),
):
    """取消协作任务"""
    success = cancel_task(task_id)
    if not success:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"status": "cancelled"}
```

- [ ] **Step 3: 注册路由**

在 `server/api/v1/router.py` 中添加：

```python
from server.api.v1 import orchestrate

# 在 include_router 部分添加
api_router.include_router(orchestrate.router)
```

- [ ] **Step 4: 验证 Python 语法**

Run: `cd server && python -c "from server.api.v1.orchestrate import router; print('OK')"`

- [ ] **Step 5: Commit**

```bash
git add server/api/v1/orchestrate.py server/api/v1/router.py
git commit -m "feat: 新增协作任务API（发起/查询/取消）"
```

---

## Task 13: 创建前端协作任务页

**Files:**
- Create: `web/src/app/dashboard/workbench/collaborate/page.tsx`

- [ ] **Step 1: 创建协作任务页**

```tsx
// web/src/app/dashboard/workbench/collaborate/page.tsx
"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { useToast } from "@/components/ui/toast";
import { Loader2, CheckCircle, Clock, XCircle, Send } from "lucide-react";

const SCENARIOS = [
  { type: "activity_planning", emoji: "🏆", name: "策划活动", desc: "周赛/月赛/节日活动" },
  { type: "store_opening", emoji: "🎉", name: "新店开业", desc: "开业筹备全流程" },
  { type: "staff_training", emoji: "📚", name: "员工培训", desc: "新人入职/技能提升" },
  { type: "business_review", emoji: "📊", name: "经营复盘", desc: "月度/季度经营分析" },
];

interface AgentStatus {
  role: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  content: string | null;
}

interface TaskResult {
  task_id: string;
  status: string;
  agents: AgentStatus[];
  summary: string | null;
}

const ROLE_NAMES: Record<string, string> = {
  boss: "老板 Agent", manager: "店长 Agent", assistant_manager: "助教管理 Agent",
  coach: "教练 Agent", frontdesk: "前厅 Agent", operator: "运营 Agent",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  completed: <CheckCircle className="h-4 w-4 text-emerald-500" />,
  running: <Loader2 className="h-4 w-4 text-amber-500 animate-spin" />,
  pending: <Clock className="h-4 w-4 text-slate-300" />,
  failed: <XCircle className="h-4 w-4 text-red-500" />,
  skipped: <XCircle className="h-4 w-4 text-slate-400" />,
};

const STATUS_LABELS: Record<string, string> = {
  completed: "已完成", running: "生成中...", pending: "等待中", failed: "失败", skipped: "跳过",
};

export default function CollaboratePage() {
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [taskResult, setTaskResult] = useState<TaskResult | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleStart = async () => {
    if (!selectedScenario || !description.trim()) return;
    setLoading(true);
    try {
      const token = api.getToken();
      const res = await fetch(`${api.baseUrl}/api/v1/orchestrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ task_type: selectedScenario, description: description.trim(), auto_orchestrate: true }),
      });
      const data = await res.json();
      setTaskResult(data);
      // Start polling
      if (data.task_id) startPolling(data.task_id);
    } catch {
      toast("发起协作失败", "error");
    } finally {
      setLoading(false);
    }
  };

  const startPolling = (taskId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const token = api.getToken();
        const res = await fetch(`${api.baseUrl}/api/v1/orchestrate/${taskId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        setTaskResult(data);
        if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {}
    }, 2000);
  };

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  if (!isAuthenticated) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[{ label: "工作台", href: "/dashboard/workbench" }, { label: "🤝 协作任务" }]} />

      <h2 className="text-xl font-bold text-slate-900 mb-4">🤝 协作任务</h2>
      <p className="text-sm text-slate-500 mb-6">多个 Agent 协作完成复杂任务，一次生成完整方案。</p>

      {/* 场景选择 */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {SCENARIOS.map((s) => (
          <button key={s.type} onClick={() => setSelectedScenario(s.type)}
            className={`rounded-lg border p-4 text-center transition-all duration-200 ${
              selectedScenario === s.type
                ? "border-indigo-500 bg-indigo-50 shadow-sm"
                : "border-slate-200 bg-white hover:border-indigo-200"
            }`}>
            <span className="text-3xl block mb-2">{s.emoji}</span>
            <p className="text-sm font-semibold text-slate-900">{s.name}</p>
            <p className="text-xs text-slate-400 mt-1">{s.desc}</p>
          </button>
        ))}
      </div>

      {/* 任务描述 */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 mb-6">
        <label className="mb-2 block text-sm font-medium text-slate-700">任务描述</label>
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none"
          placeholder="例如：策划一场周末台球挑战赛，预算3000元，目标吸引新客户" />
        <button onClick={handleStart} disabled={loading || !selectedScenario || !description.trim()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {loading ? "启动中..." : "🚀 启动协作"}
        </button>
      </div>

      {/* 协作进度 */}
      {taskResult && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 mb-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">协作进度</h3>
          <div className="space-y-2">
            {taskResult.agents.map((a) => (
              <div key={a.role} className="flex items-center gap-3 py-2 border-b border-slate-50 last:border-0">
                {STATUS_ICONS[a.status]}
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-700">{ROLE_NAMES[a.role] || a.role}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  a.status === "completed" ? "bg-emerald-50 text-emerald-600" :
                  a.status === "running" ? "bg-amber-50 text-amber-600" :
                  a.status === "failed" ? "bg-red-50 text-red-600" :
                  "bg-slate-50 text-slate-400"
                }`}>{STATUS_LABELS[a.status]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 汇总结果 */}
      {taskResult?.summary && (
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-700">📄 汇总方案</p>
            <p className="text-xs text-slate-400 mt-1">{taskResult.agents.length} 个 Agent 协作</p>
          </div>
          <div className="px-4 py-4 prose prose-sm max-w-none prose-slate">
            {taskResult.summary.split("\n\n---\n\n").map((section, i) => (
              <div key={i} className={i > 0 ? "mt-4 pt-4 border-t border-slate-100" : ""}>
                {section}
              </div>
            ))}
          </div>
          <div className="border-t border-slate-100 px-4 py-3 flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(taskResult.summary || ""); toast("已复制全部"); }}
              className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors">
              📋 复制全部
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 验证构建通过**

Run: `cd web && pnpm build 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add "web/src/app/dashboard/workbench/collaborate/page.tsx"
git commit -m "feat: 新增协作任务页，支持多Agent并发+进度展示+汇总"
```

---

## Task 14: 端到端验证

- [ ] **Step 1: 启动前端开发服务器**

Run: `cd web && pnpm dev`
预期：开发服务器启动成功

- [ ] **Step 2: 验证 Dashboard 首页**

打开 http://localhost:3000/dashboard
- 确认显示常用任务区域
- 确认门店信息和配额正常显示
- 确认快捷入口已移除

- [ ] **Step 3: 验证工作台 L2**

点击侧边栏"AI 工作台"
- 确认角色 Tab 排序：老板→店长→助教管理→教练→前厅→运营→协作
- 确认卡片按使用频率排序
- 确认面包屑显示"← 返回首页 / AI 工作台"

- [ ] **Step 4: 验证任务执行页 L3**

点击任意任务卡片
- 确认跳转到 `/dashboard/workbench/[cardId]`
- 确认面包屑显示正确层级
- 确认输入区、生成按钮正常
- 点击生成，确认流式输出正常

- [ ] **Step 5: 验证生图页面**

点击侧边栏"AI 生图"
- 确认显示对话列表（L2）
- 点击对话，确认跳转到对话执行页（L3）
- 确认新建对话功能正常

- [ ] **Step 6: 验证门店设置**

点击侧边栏"门店设置"
- 确认显示模块入口卡片（L2）
- 点击模块，确认跳转到编辑页（L3）
- 确认表单数据加载正常

- [ ] **Step 7: 验证 Toast 提示**

在任务执行页复制内容
- 确认右上角弹出 Toast 提示"已复制到剪贴板"
- 确认 3 秒后自动消失

- [ ] **Step 8: 停止开发服务器，最终构建验证**

Run: `cd web && pnpm build 2>&1 | tail -10`
预期：构建成功

- [ ] **Step 9: 最终 Commit**

```bash
git add .
git commit -m "feat: 前端交互重构完成 — L1/L2/L3页面架构+Agent协作+微交互"
```

---

## 实施顺序建议

| 顺序 | Task | 内容 | 预计时间 |
|------|------|------|---------|
| 1 | Task 1-2 | UI 组件（Toast + Breadcrumb） | 15 min |
| 2 | Task 3 | 角色排序 | 5 min |
| 3 | Task 4 | Dashboard 常用任务 | 30 min |
| 4 | Task 5-6 | 工作台 L2 + L3 | 45 min |
| 5 | Task 7 | 生图页面拆分 | 30 min |
| 6 | Task 8 | 门店设置拆分 | 30 min |
| 7 | Task 9-10 | 导航适配 + CSS 动画 | 10 min |
| 8 | Task 11-12 | 后端编排引擎 + API | 30 min |
| 9 | Task 13 | 前端协作任务页 | 30 min |
| 10 | Task 14 | 端到端验证 | 20 min |

**总计约 3.5 小时**
