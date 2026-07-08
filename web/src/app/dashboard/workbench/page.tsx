"use client";

/**
 * 工作台容器窗口(/dashboard/workbench)· E1-C1 基建:
 * 把原先两扇独立窗口(生成工作室 /dashboard/studio、视频创作工作区 /dashboard/video)合成
 * 一扇窗口的两个可用面板(生图/视频)。
 *
 * 改壳不改瓤:StudioPage/VideoWorkspacePage 内部零改动,原样 import 进来条件渲染——同一时刻只
 * 挂载当前激活的那一个,不用 display:none 同时挂两个(两页各自的根节点都是 `h-screen`,即视口整高;
 * 若把 tab 切换条做成常规文档流里的一个 header 再把整页塞进剩余的 flex-1,子页面仍会按 100vh 撑开、
 * 超出 flex-1 让出来的那部分高度,底部会被裁掉或多出一层滚动——这正是工作单点名要留意的坑)。
 * 解法:容器本身就是 `h-screen`,子页面独占这一整屏(它自己就是 100vh,天然贴合);tab 切换条用
 * 绝对定位浮在右上角(两页顶部横条右侧都是空的,不挡标题/图标),不占任何文档流高度,不会挤压子页面。
 *
 * openWorkbench 带参打开两条通路都在这接:
 *  ① 首次开窗:main.js 把 mode/payload 拼进 URL query(?panel=video&sourceId=xxx),这里用
 *     useSearchParams 读初始面板 + payload(Next App Router 用 useSearchParams 必须包 Suspense)。
 *  ② 已开着的窗口再被 openWorkbench 调用:main.js 转发 "workbench:navigate" 事件,这里订阅切面板/换 payload。
 * payload 只作为轻量导航上下文保存在 data 属性里;真图/大对象不走这条通路。
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Image as ImageIcon, Film } from "lucide-react";

import StudioPage from "@/app/dashboard/studio/page";
import { VideoWorkspacePage } from "@/app/dashboard/video/VideoWorkspace";

type Panel = "image" | "video";
type WorkbenchPayload = Record<string, string> | null;

function isPanel(v: string | null | undefined): v is Panel {
  return v === "image" || v === "video";
}

const TABS: { id: Panel; label: string; Icon: typeof ImageIcon }[] = [
  { id: "image", label: "生图", Icon: ImageIcon },
  { id: "video", label: "视频", Icon: Film },
];

function WorkbenchContainer() {
  const searchParams = useSearchParams();
  const [panel, setPanel] = useState<Panel>(() => (isPanel(searchParams.get("panel")) ? (searchParams.get("panel") as Panel) : "image"));
  // URL 上除 panel/workbench 外剩下的参数当轻量 payload 先存着——真图/大对象从不走这条通路。
  const [payload, setPayload] = useState<WorkbenchPayload>(() => {
    const entries: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      if (key !== "panel" && key !== "workbench") entries[key] = value;
    });
    return Object.keys(entries).length ? entries : null;
  });

  // 已开着的工作台窗口收到再次 openWorkbench(...) 的调用:main.js 转发过来的切面板/换 payload 事件。
  useEffect(() => {
    if (!window.electron?.onWorkbenchNavigate) return;
    let cancelled = false;
    const off = window.electron.onWorkbenchNavigate((p) => {
      if (cancelled) return;
      if (isPanel(p?.mode)) setPanel(p.mode as Panel);
      if (p?.payload) setPayload(p.payload);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return (
    <div
      className="relative h-screen w-full"
      data-workbench-panel={panel}
      data-workbench-payload={payload ? JSON.stringify(payload) : undefined}
    >
      {panel === "image" && <StudioPage />}
      {panel === "video" && <VideoWorkspacePage />}

      {/* tab 切换条:绝对定位浮在右上角,不占文档流高度(两页自己的顶部横条右侧都是空的,不挡标题)。 */}
      <div className="app-no-drag absolute right-4 top-2 z-10 flex items-center gap-1 rounded-full border border-black/[0.08] bg-white/90 p-1 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-[#141519]/90">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setPanel(t.id)}
            title={t.label}
            className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium transition active:scale-[0.97] ${
              panel === t.id
                ? "app-active-neutral"
                : "text-[#6e6e73] hover:bg-black/[0.05] dark:text-[#9a9ca3] dark:hover:bg-white/[0.08]"
            }`}
          >
            <t.Icon className="h-3.5 w-3.5" /> {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function WorkbenchPage() {
  return (
    <Suspense fallback={<div className="flex h-screen w-full items-center justify-center text-[13px] text-[#86868b] dark:text-[#6e7077]">加载中…</div>}>
      <WorkbenchContainer />
    </Suspense>
  );
}
