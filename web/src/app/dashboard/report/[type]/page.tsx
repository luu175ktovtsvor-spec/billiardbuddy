"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Download, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { ReportForm } from "@/components/report/report-form";
import { reportTypeLabel } from "@/lib/report-types";
import { getErrorMessage } from "@/lib/utils";
import { isWeChat } from "@/lib/wechat";
import { useToast } from "@/components/ui/toast";
import type { ReportData, ReportSchema, ReportSubmitResponse } from "@/types/report";

/** AI 叙事渲染：## 开头当小标题，其余当段落（narrative 是短 markdown）。 */
function Narrative({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-[15px] leading-relaxed text-slate-700">
      {text
        .split("\n")
        .filter((l) => l.trim())
        .map((line, i) =>
          line.trim().startsWith("#") ? (
            <h4 key={i} className="pt-1 text-[15px] font-semibold text-slate-900">
              {line.replace(/^#+\s*/, "")}
            </h4>
          ) : (
            <p key={i}>{line}</p>
          ),
        )}
    </div>
  );
}

export default function ReportFillPage() {
  const params = useParams<{ type: string }>();
  const reportType = params.type;
  const router = useRouter();
  const { toast } = useToast();

  const [schema, setSchema] = useState<ReportSchema | null>(null);
  const [value, setValue] = useState<ReportData>({});
  const [note, setNote] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ReportSubmitResponse | null>(null);
  const [nlText, setNlText] = useState("");
  const [extracting, setExtracting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getReportSchema(reportType);
        if (cancelled) return;
        setSchema(s);
        setValue(s.shape === "roster" ? { rows: [{}] } : {});
      } catch (err) {
        if (!cancelled) setLoadErr(getErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reportType]);

  async function submit() {
    setSubmitting(true);
    try {
      setResult(await api.submitReport(reportType, value, note));
    } catch (err) {
      toast(getErrorMessage(err)); // 配额用尽(429)时后端带提额引导文案
    } finally {
      setSubmitting(false);
    }
  }

  async function extractFromNL() {
    setExtracting(true);
    try {
      const res = await api.extractReport(reportType, nlText);
      if (Object.keys(res.data).length === 0) {
        toast("没识别到数字，换个说法或直接填下面");
      } else {
        setValue((v) => ({ ...v, ...res.data }));
        toast("已帮你填好，核对一下");
      }
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setExtracting(false);
    }
  }

  async function download() {
    if (!result) return;
    try {
      const blob = await api.exportReport(result.report_id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${reportType}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      if (isWeChat()) toast("微信里若没开始下载，点右上角「···」用浏览器打开");
    } catch (err) {
      toast(getErrorMessage(err));
    }
  }

  const title = reportTypeLabel(reportType);

  if (loadErr) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={title} backHref="/dashboard/report" />
        <p className="py-16 text-center text-sm text-slate-500">{loadErr}</p>
      </div>
    );
  }

  if (!schema) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={title} backHref="/dashboard/report" />
        <p className="py-16 text-center text-sm text-slate-400">加载中…</p>
      </div>
    );
  }

  // ─── 结果页：AI 叙事 + 下载 Excel ───
  if (result) {
    return (
      <div className="mx-auto max-w-2xl pb-24 lg:pb-0">
        <PageHeader title={title} backHref="/dashboard/report" />
        <div className="rounded-2xl bg-white p-5">
          <div className="mb-3 flex items-center gap-2 text-brand-600">
            <Sparkles className="h-5 w-5" />
            <span className="text-[15px] font-semibold">AI 已帮你写好</span>
          </div>
          <Narrative text={result.narrative} />
        </div>

        <div className="fixed inset-x-0 bottom-0 border-t border-slate-100 bg-white/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0">
          <div className="mx-auto flex max-w-2xl gap-2.5">
            <button
              type="button"
              onClick={download}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-600 py-3.5 text-[15px] font-medium text-white active:scale-[0.98] transition-transform"
            >
              <Download className="h-5 w-5" />下载 Excel
            </button>
            <button
              type="button"
              onClick={() => router.push("/dashboard/report")}
              className="rounded-xl bg-slate-100 px-5 py-3.5 text-[15px] text-slate-700 active:scale-[0.98] transition-transform"
            >
              完成
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── 填写页 ───
  return (
    <div className="mx-auto max-w-2xl pb-24 lg:pb-0">
      <PageHeader title={title} backHref="/dashboard/report" />
      <h1 className="mb-4 hidden text-[22px] font-semibold text-slate-900 lg:block">{title}</h1>

      {schema.shape !== "roster" && (
        <div className="mb-3 rounded-2xl bg-brand-50 p-4">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-brand-700">
            <Sparkles className="h-4 w-4" />说一句话，AI 帮你填
          </h3>
          <textarea
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            rows={2}
            placeholder="随口把今天的数字说一遍（营业额、充值、加微、好评…），AI 自动填进下表"
            className="w-full resize-none rounded-xl border border-brand-100 bg-white px-3 py-2.5 text-[15px] focus:border-brand-600 focus:outline-none"
          />
          <button
            type="button"
            onClick={extractFromNL}
            disabled={extracting || !nlText.trim()}
            className="mt-2 flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white active:scale-[0.98] transition-transform disabled:opacity-60"
          >
            {extracting ? "识别中…" : "AI 帮我填"}
          </button>
        </div>
      )}

      <ReportForm schema={schema} value={value} onChange={setValue} />

      <div className="mt-3 rounded-2xl bg-white p-4">
        <h3 className="mb-1.5 text-[13px] font-medium text-slate-500">补充说明（选填）</h3>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="今天有什么值得记的（特殊活动、客诉、亮点），AI 会写进日报"
          className="w-full resize-none rounded-xl border border-slate-200 px-3 py-2.5 text-[15px] focus:border-brand-600 focus:outline-none"
        />
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-slate-100 bg-white/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0">
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="mx-auto flex w-full max-w-2xl items-center justify-center gap-1.5 rounded-xl bg-brand-600 py-3.5 text-[15px] font-medium text-white active:scale-[0.98] transition-transform disabled:opacity-60"
        >
          <Sparkles className="h-5 w-5" />
          {submitting ? "AI 正在写…" : "生成日报"}
        </button>
      </div>
    </div>
  );
}
