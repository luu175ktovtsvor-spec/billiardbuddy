"use client";

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { ApiError, type OrchestrationTask } from "@/types/api";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { useToast } from "@/components/ui/toast";
import { Loader2, CheckCircle, Clock, XCircle, Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const SCENARIOS = [
  { type: "activity_planning", emoji: "🏆", name: "策划活动", desc: "周赛/月赛/节日活动" },
  { type: "store_opening", emoji: "🎉", name: "新店开业", desc: "开业筹备全流程" },
  { type: "staff_training", emoji: "📚", name: "员工培训", desc: "新人入职/技能提升" },
  { type: "business_review", emoji: "📊", name: "经营复盘", desc: "月度/季度经营分析" },
];

const ROLE_NAMES: Record<string, string> = {
  boss: "老板 Agent",
  manager: "店长 Agent",
  assistant_manager: "助教管理 Agent",
  coach: "教练 Agent",
  frontdesk: "前厅 Agent",
  operator: "运营 Agent",
};

export default function CollaboratePage() {
  const { isAuthenticated } = useAuth();
  const { toast } = useToast();
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [taskResult, setTaskResult] = useState<OrchestrationTask | null>(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleStart = async () => {
    if (!selectedScenario || !description.trim()) return;
    setLoading(true);
    try {
      // 统一走 api 封装：带 X-Store-Id、401 自动刷新、非 2xx 抛 ApiError
      const data = await api.startOrchestration({
        task_type: selectedScenario,
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
    <div className="mx-auto max-w-5xl">
      <Breadcrumb
        items={[
          { label: "工作台", href: "/dashboard/workbench" },
          { label: "🤝 协作任务" },
        ]}
      />

      <h2 className="text-xl font-bold text-slate-900 mb-2">🤝 协作任务</h2>
      <p className="text-sm text-slate-500 mb-6">
        多个 Agent 协作完成复杂任务，一次生成完整方案。
      </p>

      {/* Scenario selection */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {SCENARIOS.map((s) => (
          <button
            key={s.type}
            onClick={() => setSelectedScenario(s.type)}
            className={`rounded-lg border p-4 text-center transition-all duration-200 ${
              selectedScenario === s.type
                ? "border-indigo-500 bg-indigo-50 shadow-sm"
                : "border-slate-200 bg-white hover:border-indigo-200"
            }`}
          >
            <span className="text-3xl block mb-2">{s.emoji}</span>
            <p className="text-sm font-semibold text-slate-900">{s.name}</p>
            <p className="text-xs text-slate-400 mt-1">{s.desc}</p>
          </button>
        ))}
      </div>

      {/* Task description */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 mb-6">
        <label className="mb-2 block text-sm font-medium text-slate-700">
          任务描述
        </label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none"
          placeholder="例如：策划一场周末台球挑战赛，预算3000元，目标吸引新客户"
        />
        <button
          onClick={handleStart}
          disabled={loading || !selectedScenario || !description.trim()}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {loading ? "启动中..." : "🚀 启动协作"}
        </button>
      </div>

      {/* Collaboration progress */}
      {taskResult && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 mb-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-1">协作进度</h3>
          {taskResult.status === "running" && (
            <p className="mb-3 text-xs text-slate-400">
              所有岗位 Agent 同时并行生成（不是卡住了），全部完成后会自动综合成一份统一方案
            </p>
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
        <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-semibold text-slate-700">📄 汇总方案</p>
            <p className="text-xs text-slate-400 mt-1">
              {(taskResult.agents ?? []).length} 个 Agent 协作 · 方案已自动存入生成历史，可随时回看收藏
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
                navigator.clipboard.writeText(taskResult.summary || "");
                toast("已复制全部");
              }}
              className="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
            >
              📋 复制全部
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
