"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Upload, CheckCircle2, RefreshCw, Send, Smartphone, X } from "lucide-react";
import { useDesktop } from "@/hooks/use-desktop";
import type { LoginStatus, PublishPlatform } from "@/types/electron";

/* 一键发布(桌面端专属):AI 出内容 → 选视频 → 扫码登录自有号 → 人点确认 → 本地 RPA 发抖音。
 * 半自动 + 人确认 = 既能"代执行真实发布",又规避平台代发布红线。web 浏览器版自动提示去桌面版。 */

const LOGIN_LABEL: Record<LoginStatus, string> = {
  waiting: "等待扫码…",
  scanned: "已扫码,请在手机上确认",
  success: "登录成功",
  expired: "二维码已过期,请刷新",
  error: "登录失败,请重试",
};

export default function PublishPage() {
  const { isDesktop, electron } = useDesktop();
  const [platforms, setPlatforms] = useState<PublishPlatform[]>([]);
  const [platform, setPlatform] = useState("douyin");
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [loginStatus, setLoginStatus] = useState<LoginStatus | null>(null);

  const [videoPath, setVideoPath] = useState("");
  const [videoName, setVideoName] = useState("");
  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");

  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<{ pct?: number; msg?: string } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; url?: string; error?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 进入页:从 URL 预填 AI 生成的标题/话题(?title=..&tags=a,b),并订阅桌面事件
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("title")) setTitle(sp.get("title") || "");
    if (sp.get("tags")) setTagsInput((sp.get("tags") || "").replace(/,/g, " "));
  }, []);

  useEffect(() => {
    if (!electron) return;
    electron.publish.platforms().then(setPlatforms).catch(() => {});
    const off1 = electron.publish.onQrcode((p) => { setQr(p.dataUrl); setLoginStatus("waiting"); });
    const off2 = electron.publish.onLoginStatus((p) => {
      setLoginStatus(p.status);
      if (p.status === "success") { setLoggedIn(true); setQr(null); }
    });
    const off3 = electron.publish.onProgress((p) => setProgress({ pct: p.pct, msg: p.msg }));
    return () => { off1(); off2(); off3(); };
  }, [electron]);

  // 切平台时查登录态
  useEffect(() => {
    if (!electron) return;
    setLoggedIn(null);
    electron.publish.checkLogin(platform).then((r) => setLoggedIn(r.loggedIn)).catch(() => setLoggedIn(false));
  }, [electron, platform]);

  const startLogin = () => {
    if (!electron) return;
    setQr(null); setLoginStatus("waiting");
    electron.publish.startLogin(platform).catch(() => setLoginStatus("error"));
  };

  const pickVideo = () => fileRef.current?.click();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    // Electron 的 File 带本地 path
    setVideoPath((f as File & { path?: string }).path || "");
    setVideoName(f.name);
  };

  const tags = tagsInput.split(/[\s,，#]+/).map((t) => t.trim()).filter(Boolean);

  const doPublish = async () => {
    if (!electron || !videoPath || !title.trim()) return;
    setPublishing(true); setResult(null); setProgress({ pct: 0, msg: "准备中…" });
    try {
      const r = await electron.publish.post(platform, { videoPath, title: title.trim(), tags });
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : "发布失败" });
    } finally {
      setPublishing(false);
    }
  };

  // ── 非桌面端:提示去桌面版 ──
  if (!isDesktop) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <Smartphone className="mx-auto mb-4 h-12 w-12 text-slate-300" />
        <h1 className="mb-2 text-lg font-semibold text-slate-900">一键发布是桌面版功能</h1>
        <p className="text-sm text-slate-500">
          发抖音用的是你自己的账号、在你电脑上扫码发布(更安全、不封号)。请下载安装「台球运营管家」桌面版后使用。
        </p>
      </div>
    );
  }

  const canPublish = loggedIn && videoPath && title.trim() && !publishing;

  return (
    <div className="mx-auto max-w-2xl pb-24">
      <h1 className="mb-1 text-xl font-bold text-slate-900">一键发布</h1>
      <p className="mb-6 text-sm text-slate-500">用你自己的号、在本机扫码发布;内容和封面你定,点确认才发。</p>

      {/* 平台 */}
      <div className="mb-4 flex gap-2">
        {platforms.map((p) => (
          <button key={p.id} type="button" disabled={!p.enabled} onClick={() => setPlatform(p.id)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              platform === p.id ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"
            } disabled:opacity-40`}>
            {p.name}{!p.enabled && "(待开放)"}
          </button>
        ))}
      </div>

      {/* 登录态 */}
      <div className="mb-4 rounded-2xl border border-slate-100 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-slate-700">账号登录</span>
          {loggedIn === null ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            : loggedIn ? <span className="inline-flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="h-4 w-4" />已登录</span>
            : <button type="button" onClick={startLogin} className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-3 py-1.5 text-sm text-brand-600"><RefreshCw className="h-3.5 w-3.5" />扫码登录</button>}
        </div>
        {qr && (
          <div className="flex flex-col items-center gap-2 py-3">
            <img src={qr} alt="登录二维码" className="h-44 w-44 rounded-lg border border-slate-100" />
            <p className="text-xs text-slate-500">{loginStatus ? LOGIN_LABEL[loginStatus] : "用对应 App 扫码登录你的账号"}</p>
          </div>
        )}
      </div>

      {/* 内容 */}
      <div className="space-y-4 rounded-2xl border border-slate-100 bg-white p-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">视频文件</label>
          <input ref={fileRef} type="file" accept="video/*" onChange={onFile} className="hidden" />
          <button type="button" onClick={pickVideo}
            className="flex w-full items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <Upload className="h-4 w-4" />{videoName || "选择本地视频…"}
          </button>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">标题/文案</label>
          <textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={2}
            placeholder="标题(可从 AI 生成的脚本带过来)"
            className="w-full rounded-xl bg-slate-50 px-3.5 py-2.5 text-[15px] text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-slate-700">话题标签(空格分隔)</label>
          <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)}
            placeholder="本地台球 同城探店 约球搭子"
            className="h-11 w-full rounded-xl bg-slate-50 px-3.5 text-[15px] text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/30" />
          {tags.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">{tags.map((t) => <span key={t} className="rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-600">#{t}</span>)}</div>}
        </div>
      </div>

      {/* 发布进度/结果 */}
      {progress && publishing && (
        <div className="mt-4 rounded-2xl bg-slate-50 p-4">
          <div className="mb-1.5 flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />{progress.msg || "发布中…"}</div>
          <div className="h-1.5 w-full rounded-full bg-slate-200"><div className="h-1.5 rounded-full bg-brand-500 transition-all" style={{ width: `${progress.pct || 0}%` }} /></div>
        </div>
      )}
      {result && (
        <div className={`mt-4 rounded-2xl p-4 text-sm ${result.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {result.ok ? <>✅ 发布成功{result.url && <>　<a href={result.url} target="_blank" rel="noreferrer" className="underline">查看作品</a></>}</> : <>⚠️ {result.error}</>}
        </div>
      )}

      {/* 吸底:人点确认才发 */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-100 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          {!loggedIn && <p className="flex-1 text-xs text-slate-400">先扫码登录你的账号</p>}
          {loggedIn && !videoPath && <p className="flex-1 text-xs text-slate-400">选个视频再发</p>}
          {loggedIn && videoPath && <p className="flex-1 text-xs text-slate-400">确认无误,点发布(用你的号真实发出)</p>}
          <button type="button" disabled={!canPublish} onClick={doPublish}
            className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-6 text-sm font-medium text-white disabled:opacity-40">
            {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}确认发布
          </button>
        </div>
      </div>
    </div>
  );
}
