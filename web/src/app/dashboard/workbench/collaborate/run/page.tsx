"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { ApiError, type OrchestrationTask } from "@/types/api";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/layout/page-header";
import { useToast } from "@/components/ui/toast";
import { Loader2, CheckCircle, Clock, XCircle, Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownToPlainText } from "@/lib/utils";

/* 协作执行页:场景馆选完场景跳到这里,纯执行/对话感。
 * type/name/preset 由 URL 携带;preset 预填任务描述(custom 预设模板)。 */

const ROLE_NAMES: Record<string, string> = {
  boss: "老板 Agent",
  manager: "店长 Agent",
  assistant_manager: "助教管理 Agent",
  coach: "教练 Agent",
  frontdesk: "前厅 Agent",
  operator: "运营 Agent",
};

function CollaborateRunInner() {
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();
  const searchParams = useSearchParams();

  const taskType = searchParams.get("type") || "custom";
  const scenarioName = searchParams.get("name") || "多人协作";
  const preset = searchParams.get("preset") || "";

  const [description, setDescription] = useState(preset);
  const [taskResult, setTaskResult] = useState<OrchestrationTask | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleStart = async () => {
    if (!description.trim()) return;
    setLoading(true);
    try {
      // 统一走 api 封装：带 X-Store-Id、401 自动刷新、非 2xx 抛 ApiError
      const data = await api.startOrchestration({
        task_type: taskType,
        description: description.trim(),
        auto_orchestrate: true,
      });
      setTaskResult(data);
      if (data.task_id) startPolling(data.task_id);
    } catch (err) {
      toast(err instanceof ApiError ? err.detail : "发起协作失败", "error");
    } finally {
      setLoading(false);
    }
  };

  const startPolling = (taskId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.getOrchestration(taskId);
        setTaskResult(data);
        if (
          data.status === "completed" ||
          data.status === "failed" ||
          data.status === "cancelled"
        ) {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch (err) {
        // 任务丢失/登录过期：停止轮询并提示，避免无限卡"等待中"
        if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
          if (pollRef.current) clearInterval(pollRef.current);
          toast(err.status === 404 ? "任务已丢失，请重新发起协作" : "登录已过期，请重新登录", "error");
        }
        // 网络抖动等其他错误：下个周期重试
      }
    }, 2000);
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  if (!isAuthenticated) return null;

  return (
    <div className="mx-auto max-w-5xl pb-24 lg:pb-0">
      <PageHeader title={scenarioName} backHref="/dashboard/workbench/collaborate" />
      <Breadcrumb
        items={[
          { label: "工作台", href: "/dashboard/workbench" },
          { label: "协作任务", href: "/dashboard/workbench/collaborate" },
          { label: scenarioName },
        ]}
      />

      <h2 className="hidden text-xl font-bold text-slate-900 mb-2 lg:block">{scenarioName}</h2>
      <p className="mb-5 text-[15px] leading-relaxed text-slate-500 lg:text-sm">
        把目标说清楚一点(预算、时间、想达成什么),方案会更落地。
      </p>

      {/* Task description */}
      <div className="rounded-2xl bg-white p-4 mb-6">
        <label className="mb-2 block text-sm font-medium text-slate-700">
          任务描述
        </label>
        <textarea
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-xl bg-[#F2F2F7] px-3 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none"
          placeholder="例如：策划一场周末台球挑战赛，预算3000元，目标吸引新客户"
        />
        {/* 手机吸底主按钮（含安全区），桌面回到卡片内原位置 */}
        <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-100 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:static lg:mt-3 lg:border-0 lg:bg-transparent lg:p-0">
          <button
            onClick={handleStart}
            disabled={loading || !description.trim()}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-[15px] font-medium text-white hover:bg-brand-500 active:scale-[0.98] disabled:opacity-50 transition-all"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {loading ? "发起中..." : "发起协作"}
          </button>
        </div>
      </div>

      {/* 三阶段进度条 */}
      {taskResult && (
        <div className="rounded-2xl bg-white p-4 mb-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">协作进度</h3>
          <div className="mb-4 flex items-center gap-2 overflow-x-auto text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {[
              { key: "planning", label: "① 指挥官规划" },
              { key: "executing", label: "② 岗位分头执行" },
              { key: "synthesizing", label: "③ 整合成方案" },
            ].map((step, i) => {
              const order = ["planning", "executing", "synthesizing"];
              const cur = taskResult.status === "completed" ? 3 : order.indexOf(taskResult.stage || "planning");
              const done = i < cur || taskResult.status === "completed";
              const active = i === cur && taskResult.status === "running";
              return (
                <div key={step.key} className="flex shrink-0 items-center gap-2">
                  <span className={`whitespace-nowrap rounded-full px-2.5 py-1 ${
                    done ? "bg-emerald-50 text-emerald-600"
                    : active ? "bg-amber-50 text-amber-600"
                    : "bg-slate-50 text-slate-400"
                  }`}>
                    {active && <Loader2 className="inline h-3 w-3 animate-spin mr-1" />}
                    {done && !active && "✓ "}
                    {step.label}
                  </span>
                  {i < 2 && <span className="text-slate-300">→</span>}
                </div>
              );
            })}
          </div>

          {/* 指挥官框架 */}
          {taskResult.framework && (
            <details className="mb-3 rounded-xl border border-brand-100 bg-brand-50/50 p-3" open={taskResult.status === "running"}>
              <summary className="cursor-pointer text-xs font-semibold text-brand-700">协作框架（指挥官制定，各岗位据此分工）</summary>
              <div className="mt-2 prose prose-xs max-w-none prose-slate text-xs">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{taskResult.framework}</ReactMarkdown>
              </div>
            </details>
          )}

          {taskResult.stage === "planning" && taskResult.status === "running" && (
            <p className="mb-3 text-xs text-slate-400">指挥官正在制定协作框架（约 20-40 秒）…</p>
          )}
          <div className="space-y-2">
            {(taskResult.agents ?? []).map((a) => (
              <div
                key={a.role}
                className="flex items-center gap-3 py-2 border-b border-slate-50 last:border-0"
              >
                {a.status === "completed" ? (
                  <CheckCircle className="h-4 w-4 text-emerald-500" />
                ) : a.status === "running" ? (
                  <Loader2 className="h-4 w-4 text-amber-500 animate-spin" />
                ) : a.status === "failed" ? (
                  <XCircle className="h-4 w-4 text-red-500" />
                ) : (
                  <Clock className="h-4 w-4 text-slate-300" />
                )}
                <p className="text-sm font-medium text-slate-700 flex-1">
                  {ROLE_NAMES[a.role] || a.role}
                </p>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    a.status === "completed"
                      ? "bg-emerald-50 text-emerald-600"
                      : a.status === "running"
                        ? "bg-amber-50 text-amber-600"
                        : a.status === "failed"
                          ? "bg-red-50 text-red-600"
                          : "bg-slate-50 text-slate-400"
                  }`}
                >
                  {a.status === "completed"
                    ? "已完成"
                    : a.status === "running"
                      ? "生成中..."
                      : a.status === "failed"
                        ? "失败"
                        : "等待中"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary result */}
      {taskResult?.summary && (
        <div className="rounded-2xl bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-700">完整方案</p>
            <p className="text-xs text-slate-400 mt-1">
              {(taskResult.agents ?? []).length} 个岗位按统一框架协作产出 · 已存入生成历史，可回看/收藏
            </p>
          </div>
          <div className="px-4 py-4 prose prose-sm max-w-none prose-slate">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {taskResult.summary}
            </ReactMarkdown>
          </div>
          <div className="border-t border-slate-100 px-4 py-3">
            <button
              onClick={() => {
                navigator.clipboard.writeText(markdownToPlainText(taskResult.summary || ""));
                toast("已复制全部");
              }}
              className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-4 text-[15px] font-medium text-white hover:bg-brand-500 active:scale-[0.98] transition-all lg:w-auto"
            >
              复制全部
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CollaborateRunPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-brand-600" />
        </div>
      }
    >
      <CollaborateRunInner />
    </Suspense>
  );
}
