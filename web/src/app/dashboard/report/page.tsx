"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Download, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { REPORT_TYPES, reportTypeLabel } from "@/lib/report-types";
import { formatDateTime, getErrorMessage } from "@/lib/utils";
import { isWeChat } from "@/lib/wechat";
import { useToast } from "@/components/ui/toast";
import type { ReportListItem } from "@/types/report";

export default function ReportListPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [items, setItems] = useState<ReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setItems(await api.listReports());
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.listReports();
        if (!cancelled) setItems(res);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function download(reportId: string, type: string | null) {
    try {
      const blob = await api.exportReport(reportId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${type ?? "report"}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      if (isWeChat()) toast("微信里若没开始下载，点右上角「···」用浏览器打开");
    } catch (err) {
      toast(getErrorMessage(err));
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="日报" backHref="/dashboard" />
      <h1 className="mb-4 hidden text-[22px] font-semibold text-slate-900 lg:block">日报</h1>

      {/* 写今天的日报 */}
      <section className="mb-6">
        <h2 className="mb-2 text-[13px] font-medium text-slate-500">写今天的日报</h2>
        <div className="grid grid-cols-2 gap-2.5">
          {REPORT_TYPES.map((r) => (
            <button
              key={r.type}
              type="button"
              onClick={() => router.push(`/dashboard/report/${r.type}`)}
              className="flex items-center gap-2.5 rounded-2xl bg-white p-4 text-left active:scale-[0.98] transition-transform"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50">
                <FileText className="h-5 w-5 text-brand-600" />
              </span>
              <span className="text-[15px] font-medium text-slate-900">{r.label}</span>
            </button>
          ))}
        </div>
      </section>

      {/* 历史日报 */}
      <section>
        <h2 className="mb-2 text-[13px] font-medium text-slate-500">历史日报</h2>
        {loading ? (
          <p className="py-10 text-center text-sm text-slate-400">加载中…</p>
        ) : error ? (
          <div className="py-10 text-center">
            <p className="text-sm text-slate-500">{error}</p>
            <button onClick={fetchReports} className="mt-2 text-sm text-brand-600">
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-2xl bg-white py-10 text-center text-sm text-slate-400">
            还没有日报，点上面写一份吧
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <div key={it.id} className="flex items-center gap-3 rounded-2xl bg-white p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium text-slate-900">
                    {it.title || reportTypeLabel(it.report_type)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">{formatDateTime(it.created_at)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => download(it.id, it.report_type)}
                  className="flex h-10 items-center gap-1 rounded-xl bg-slate-100 px-3 text-sm text-slate-700 active:scale-[0.97] transition-transform"
                >
                  <Download className="h-4 w-4" />
                  Excel
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
