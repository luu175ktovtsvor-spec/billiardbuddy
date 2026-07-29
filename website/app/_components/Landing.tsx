"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Workspace = "task" | "image" | "video";
type StoryDetail = { id: string; label: string; copy: string };
type CapabilityItem = { title: string; copy: string };
type CapabilityPhase = { label: string; summary: string; items: CapabilityItem[] };
type CapabilityGroup = {
  id: "organize" | Workspace | "control";
  index: string;
  kicker: string;
  title: string;
  summary: string;
  flow: string[];
  phases: CapabilityPhase[];
};

const workspaces: Array<{ id: Workspace; index: string; name: string; promise: string }> = [
  { id: "task", index: "01", name: "任务空间", promise: "资料、写作与真实文件" },
  { id: "image", index: "02", name: "图片工作台", promise: "参考、候选与持续编辑" },
  { id: "video", index: "03", name: "视频工作台", promise: "素材理解与可控剪辑" },
];

const imageCandidates = [
  { src: "/luma-candidate-hero.webp", alt: "便携桌面灯主视觉候选" },
  { src: "/luma-candidate-side.webp", alt: "便携桌面灯侧面构图候选" },
  { src: "/luma-candidate-top.webp", alt: "便携桌面灯俯拍候选" },
  { src: "/luma-candidate-macro.webp", alt: "便携桌面灯材质微距候选" },
];

function formatPreviewTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `00:${String(safeSeconds).padStart(2, "0")}`;
}

const capabilityGroups: CapabilityGroup[] = [
  {
    id: "organize",
    index: "01",
    kicker: "START & ORGANIZE",
    title: "先把工作放到正确的位置",
    summary: "从新建任务到找到历史结果，项目、任务和媒体创作都有清楚归属",
    flow: ["选择入口", "放入上下文", "开始工作", "持续回来"],
    phases: [
      {
        label: "建立工作",
        summary: "从任务、图片或视频任意一处开始",
        items: [
          { title: "新建任务", copy: "直接开始一次对话，或在指定项目中建立任务" },
          { title: "新建图片项目", copy: "把一次图片创作的参考、候选和版本放在一起" },
          { title: "新建视频项目", copy: "按横屏、竖屏或方形画布建立独立剪辑项目" },
        ],
      },
      {
        label: "组织与查找",
        summary: "工作再多，也能回到原来的上下文",
        items: [
          { title: "项目与最近任务", copy: "按项目查看工作，快速回到最近处理的内容" },
          { title: "置顶、重命名与归档", copy: "整理重要任务，归档后也可以恢复" },
          { title: "搜索历史", copy: "在当前对话或全部任务中查找内容并跳回原处" },
        ],
      },
      {
        label: "持续推进",
        summary: "临时工作和长期项目都能接着做",
        items: [
          { title: "定时任务", copy: "安排需要按时间运行的工作，并接收完成通知" },
          { title: "新窗口与分支任务", copy: "从现有上下文展开另一项工作，不打断当前进度" },
          { title: "项目记忆", copy: "保留项目相关背景，让后续任务继续沿用" },
        ],
      },
    ],
  },
  {
    id: "task",
    index: "02",
    kicker: "TASK WORKSPACE",
    title: "任务空间，把目标真正执行完",
    summary: "输入要求和资料，查看计划与工具过程，随时调整，最后审阅真实结果",
    flow: ["说明目标", "理解资料", "执行任务", "审阅与继续"],
    phases: [
      {
        label: "输入与理解",
        summary: "不只发送一句话，也可以把完整背景交进来",
        items: [
          { title: "文字、语音与附件", copy: "输入要求，口述内容，或加入图片、视频和文档" },
          { title: "引用历史内容", copy: "引用已有消息和附件，让新要求沿用准确上下文" },
          { title: "项目文件与网页资料", copy: "读取当前项目、文档和网页中的真实信息" },
          { title: "命令与工作流", copy: "通过斜杠命令调用已经安装的 Skill 和常用流程" },
        ],
      },
      {
        label: "计划与执行",
        summary: "每一步正在做什么，都能看见",
        items: [
          { title: "计划与进度", copy: "把复杂工作拆成步骤，持续显示当前进展" },
          { title: "读写真实文件", copy: "分析项目内容，并把结果直接写入对应文件" },
          { title: "命令与终端", copy: "运行项目命令，在多个终端标签之间切换" },
          { title: "搜索、浏览与预览", copy: "查找外部资料，操作网页，查看本地页面结果" },
          { title: "工具与子任务", copy: "组合工具处理较长工作，并保留完整活动记录" },
          { title: "权限确认", copy: "在需要时先询问，确认后才执行相应操作" },
        ],
      },
      {
        label: "运行中调整",
        summary: "不用等它结束，方向变化可以立刻处理",
        items: [
          { title: "立即调整", copy: "把新要求送到当前运行，在合适的节点改变方向" },
          { title: "排队继续", copy: "把后续要求和附件排在当前任务之后依次处理" },
          { title: "编辑任务队列", copy: "修改、重排、重试或删除尚未执行的要求" },
          { title: "停止与恢复", copy: "随时停止当前运行，需要时继续未完成的工作" },
        ],
      },
      {
        label: "审阅与恢复",
        summary: "结果、差异和继续工作的入口都在同一处",
        items: [
          { title: "文件与差异审阅", copy: "查看变化文件、项目文件、逐行差异和媒体预览" },
          { title: "逐行批注", copy: "在对应的新旧代码行留下具体意见并继续修改" },
          { title: "查找、复制与引用", copy: "搜索对话，复制结果，或引用其中一段继续讨论" },
          { title: "失败恢复", copy: "运行中断或结果未确认时，保留现场并从原处恢复" },
          { title: "从任意消息继续", copy: "基于历史节点建立旁支任务或新的工作目录" },
        ],
      },
    ],
  },
  {
    id: "image",
    index: "03",
    kicker: "IMAGE WORKBENCH",
    title: "图片工作台，从想法到可交付画面",
    summary: "先把参考和要求说清楚，再生成、比较、局部修改、排版和导出",
    flow: ["建立创意简报", "生成候选", "选定并编辑", "检查与导出"],
    phases: [
      {
        label: "准备创作",
        summary: "先明确什么必须保留，什么可以发挥",
        items: [
          { title: "创作要求", copy: "从一句画面描述建立图片草稿和创意简报" },
          { title: "参考图片角色", copy: "分别标记主体、风格、环境、品牌、Logo 和二维码" },
          { title: "保留与可变内容", copy: "记录已确认事实、必须保留项、可调整项和缺失信息" },
          { title: "精确文字", copy: "单独确认画面中必须准确出现的文字内容" },
        ],
      },
      {
        label: "生成候选",
        summary: "按当前任务选择合适模型和输出方式",
        items: [
          { title: "选择生成模型", copy: "在支持的图片模型之间切换，不锁定单一提供方" },
          { title: "尺寸与质量", copy: "选择画面尺寸和模型支持的质量档位" },
          { title: "一次生成多个候选", copy: "按需要生成 1 至 4 张图片并查看进度" },
          { title: "费用与额度", copy: "提交前查看预计消耗和当月剩余额度" },
        ],
      },
      {
        label: "比较与编辑",
        summary: "每次修改都生成新版本，不覆盖原图",
        items: [
          { title: "候选对比", copy: "放大画布，比较候选，并把满意的图片设为当前版本" },
          { title: "版本与分支", copy: "沿父子版本撤销、重做或从旧版本继续创作" },
          { title: "继续编辑", copy: "对选中版本补充要求，生成保留历史的新版本" },
          { title: "局部重绘", copy: "用画笔蒙版选中区域，只修改需要变化的部分" },
          { title: "图片放大", copy: "将当前版本放大 2 倍、3 倍或 4 倍，并保留为新版本" },
        ],
      },
      {
        label: "排版与交付",
        summary: "生成之后还能完成精确的成品整理",
        items: [
          { title: "图片图层", copy: "调整位置、尺寸、透明度和上下层顺序" },
          { title: "文字图层", copy: "用独立文字层控制内容、字号和位置" },
          { title: "质量评估", copy: "查看评分、问题与改进建议，再决定是否继续修改" },
          { title: "导出当前版本", copy: "把确认后的成品保存到本地继续使用" },
          { title: "删除与恢复项目", copy: "移除不再使用的图片项目，也可以从归档中恢复" },
        ],
      },
    ],
  },
  {
    id: "video",
    index: "04",
    kicker: "VIDEO WORKBENCH",
    title: "视频工作台，把真实素材剪成成片",
    summary: "导入已有视频和音频，先理解内容，再完成画面、声音、字幕和输出",
    flow: ["导入素材", "理解与定方向", "编辑画面和声音", "预览与导出"],
    phases: [
      {
        label: "素材准备",
        summary: "视频从自己的实拍和录音开始",
        items: [
          { title: "选择画布", copy: "建立 9:16 竖屏、16:9 横屏或 1:1 方形项目" },
          { title: "导入多段视频", copy: "把多段实拍素材放入同一个视频项目" },
          { title: "检查素材信息", copy: "识别时长、尺寸、帧率、音视频轨和素材方向" },
          { title: "缺失素材提醒", copy: "源文件移动或丢失时，明确指出需要重新定位的内容" },
          { title: "写下剪辑目标", copy: "说明成片用途、重点和希望保留的内容" },
        ],
      },
      {
        label: "理解与规划",
        summary: "所有建议都能回到具体素材和时间点",
        items: [
          { title: "多类素材证据", copy: "整理语音、画面、声音、镜头和素材角色" },
          { title: "来源与时间点", copy: "每条证据保留素材来源、时间范围、置信度和提醒" },
          { title: "筛选并跳转", copy: "按证据类型或素材筛选，并跳回对应片段" },
          { title: "生成剪辑简报", copy: "汇总目标、渠道、必须保留的文字、方向和信息缺口" },
          { title: "比较剪辑方向", copy: "提供最多 3 个方案，说明各自取舍后再由你选择" },
        ],
      },
      {
        label: "画面时间线",
        summary: "建议进入时间线之后，仍由你精确控制",
        items: [
          { title: "素材与节目预览", copy: "分别查看原始素材和当前成片效果" },
          { title: "裁剪与排序", copy: "调整入点、出点和片段先后顺序" },
          { title: "拆分与移除", copy: "在播放头位置拆分片段，删除不需要的部分" },
          { title: "锁定片段", copy: "保护已经确认的片段，避免后续误改" },
          { title: "时间线版本", copy: "保存每次结构变化，撤销、重做或从旧版本建立分支" },
        ],
      },
      {
        label: "声音与字幕",
        summary: "画面、旁白、音乐和字幕在一个项目中完成",
        items: [
          { title: "导入音乐与旁白", copy: "加入本地音乐或已经录好的旁白音频" },
          { title: "生成旁白", copy: "输入旁白文字，选择内置声音或自己的克隆声音" },
          { title: "管理克隆声音", copy: "在明确授权后，用录音建立、试听和管理声音档案" },
          { title: "音频时间线", copy: "调整开始时间、音量以及淡入淡出" },
          { title: "原声与自动压低", copy: "保留视频原声，并在旁白出现时自动降低原声音量" },
          { title: "从语音生成字幕", copy: "利用带时间点的语音内容建立字幕轨" },
          { title: "编辑字幕轨", copy: "修改字幕文字和时间，在播放头处增删字幕" },
          { title: "字幕样式与导出", copy: "设置字号和底部距离，选择烧录或导出 SRT" },
          { title: "补充语音证据", copy: "录制或上传音频，转写修正后绑定到视频素材" },
        ],
      },
      {
        label: "预览与输出",
        summary: "导出前知道当前预览是否对应最新编辑",
        items: [
          { title: "预览过期提醒", copy: "时间线、声音或字幕变化后，提示重新生成节目预览" },
          { title: "生成或取消预览", copy: "查看本地渲染进度，也可以随时取消" },
          { title: "MP4 与 MOV", copy: "按当前画布、帧率和音视频设置导出成片" },
          { title: "输出核对", copy: "记录时长、大小、音视频轨、尺寸、帧率和文件校验值" },
          { title: "打开导出结果", copy: "渲染完成后直接打开本地成片继续交付" },
        ],
      },
    ],
  },
  {
    id: "control",
    index: "05",
    kicker: "CONTROL & EXTENSIONS",
    title: "最后，把软件调整成自己的工作方式",
    summary: "模型、权限、扩展、数据和桌面体验都有明确设置，不改变三个工作台的职责",
    flow: ["选择模型", "设置边界", "连接能力", "保留自己的数据"],
    phases: [
      {
        label: "模型与权限",
        summary: "能力可以替换，执行边界始终清楚",
        items: [
          { title: "托管或自备模型", copy: "配置不同模型提供方和自己的 API 凭据" },
          { title: "按任务切换模型", copy: "任务空间和图片工作台分别选择适合当前工作的模型" },
          { title: "三种运行权限", copy: "选择每次询问、自动批准或完全访问" },
          { title: "重要操作确认", copy: "费用、删除、提交和发布等操作在执行前确认" },
        ],
      },
      {
        label: "扩展能力",
        summary: "把自己的工具和工作流接入同一个桌面",
        items: [
          { title: "Skills", copy: "安装专门工作方法，通过命令调用或让软件自动选择" },
          { title: "Plugins", copy: "管理包含能力和连接方式的完整扩展" },
          { title: "MCP 服务", copy: "安装和配置外部服务，支持项目级或全局使用" },
          { title: "连接授权", copy: "需要登录的服务通过对应授权流程连接" },
        ],
      },
      {
        label: "桌面与数据",
        summary: "让长期使用保持稳定、顺手和可恢复",
        items: [
          { title: "本地与便携数据位置", copy: "选择系统数据目录或自己的便携存储位置" },
          { title: "代理与隐私", copy: "按网络环境设置代理，并管理相关隐私选项" },
          { title: "终端环境", copy: "选择需要使用的本地 Shell 和终端行为" },
          { title: "语言、主题与通知", copy: "调整界面外观、回复语言和系统通知" },
          { title: "发送与思考方式", copy: "设置消息发送习惯、深度思考和项目记忆" },
          { title: "桌面更新", copy: "查看新版本状态，在准备好时完成应用更新" },
        ],
      },
    ],
  },
];

const PRODUCT_FRAME_WIDTH = 1320;

function ScaledProductFrame({ children, className, height }: { children: React.ReactNode; className: string; height: number }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const resize = () => setScale(Math.min(1, frame.clientWidth / PRODUCT_FRAME_WIDTH));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={frameRef} className={`scaled-product-frame ${className}`} style={{ height: `${height * scale}px` }}>
      <div className="scaled-product-canvas" style={{ width: `${PRODUCT_FRAME_WIDTH}px`, height: `${height}px`, transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

const faqs = [
  ["它和普通 AI 对话有什么不同？", "BilliardBuddy 不只回答问题，还能进入项目、使用工具、修改文件，并保留完整过程。"],
  ["三个工作台必须一起使用吗？", "不需要。任务、图片和视频可以独立使用，也可以按你的工作需要组合。"],
  ["可以自己选择模型吗？", "可以。任务空间支持托管或自备的大语言模型，图片工作台也能选择生成模型。"],
  ["图片和视频是在本机还是云端处理？", "图片生成由你选择的模型服务完成，生成结果、项目和版本保存在你的电脑。视频素材、时间线、预览和导出主要在本机完成；只有需要模型理解、转写或生成旁白时，才会调用所选的在线服务。"],
  ["它会直接修改我的文件吗？", "只有获得相应权限后才会执行。重要操作可以先确认，执行中也能随时停止。"],
  ["升级会覆盖我的项目吗？", "不会。项目、会话、媒体成果和设置独立保存。"],
];

function Brand() {
  return (
    <Link className="brand" href="/" aria-label="BilliardBuddy 首页">
      <span className="brand-icon"><Image unoptimized src="/app-icon.png" width={256} height={256} alt="" /></span>
      <span>BilliardBuddy</span>
    </Link>
  );
}

function Header() {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <nav aria-label="主导航"><a href="#worker-story">完整流程</a><a href="#workspaces">产品界面</a><a href="#capabilities">全部功能</a></nav>
        <a className="header-cta" href="#download">免费下载 <span>↗</span></a>
      </div>
    </header>
  );
}

function PageMotion() {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      const range = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      root.style.setProperty("--page-progress", String(Math.min(1, scrollY / range)));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new IntersectionObserver(
      entries => entries.forEach(entry => entry.isIntersecting && entry.target.classList.add("is-visible")),
      { threshold: 0.12 },
    );
    document.querySelectorAll(".reveal").forEach(node => observer.observe(node));
    update();
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}

function ProductSidebar({ active }: { active: Workspace }) {
  return (
    <aside className="product-sidebar focus-global">
      <div className="sidebar-chrome"><span className="traffic"><i /><i /><i /></span><span className="window-history">‹　›</span><em>▯　⌕</em></div>
      <button className="new-task">＋　新任务 <kbd>⌘ N</kbd></button>
      <nav>
        <span className={active === "image" ? "active" : ""}><i>▧</i>图片工作台</span>
        <span className={active === "video" ? "active" : ""}><i>▷</i>视频工作台</span>
        <span><i>◴</i>计划任务</span>
      </nav>
      <div className="sidebar-group project-list"><b>项目</b><span>▾　内容选题与制作</span><span className={active === "task" ? "active-task" : ""}>　　桌面灯真实体验</span></div>
      <div className="sidebar-group recent"><b>最近</b><span>7 月内容复盘</span><span>品牌合作资料</span></div>
      <div className="sidebar-bottom"><span>☷　全部任务</span><span>▱　归档</span><span>⚙　设置　　◐</span></div>
    </aside>
  );
}

function TaskFocus() {
  return (
    <div className="product-window task-focus">
      <div className="product-shell">
        <ProductSidebar active="task" />
        <header className="workbench-header task-workbench-header"><div><b>桌面灯真实体验</b><small>内容选题与制作</small></div><span className="live-state"><i />就绪</span><em>⌕　⋯　▯　⌁　　—　□　×</em></header>
        <section className="task-thread focus-thread">
          <div className="thread-scroll">
            <div className="thread-date">今天 14:26</div>
            <div className="prompt-bubble"><p>产品资料、实拍笔记和用户反馈都在这个项目里。提炼核心使用场景，写一份产品发布简报和一版 60 秒讲解稿，所有结论保留来源。</p><div className="reference-chips"><span>⌘ 产品资料.pdf</span><span>▤ 实拍笔记.md</span><span>↗ 用户反馈.csv</span></div></div>
            <div className="agent-answer">
              <p>两份文件已经写入项目。产品事实、实拍体验和用户顾虑都保留了对应来源，可以直接审阅。</p>
            </div>
            <div className="run-card focus-run">
              <header><span><i />执行记录</span><b>4 / 4 已完成</b></header>
              <div><i>✓</i><span><b>读取项目资料与实拍笔记</b><small>3 份资料 · 46 条用户反馈</small></span><em>完成</em></div>
              <div><i>✓</i><span><b>核对可用卖点与真实限制</b><small>亮度、续航、移动场景均标出来源</small></span><em>完成</em></div>
              <div><i>✓</i><span><b>写入 产品发布简报.md</b><small>核心场景、事实依据与使用限制</small></span><em>完成</em></div>
              <div><i>✓</i><span><b>写入 60秒讲解稿.md</b><small>开场、体验转折、镜头提示与收尾</small></span><em>完成</em></div>
            </div>
          </div>
          <div className="composer">
            <span>把口播稿再收紧一点，前 3 秒直接说租房桌面的痛点</span><i />
            <div className="composer-toolbar"><span>＋　◉</span><b>询问批准　⌄</b><em>Shift + Enter 换行</em><button>↑</button></div>
          </div>
        </section>
        <aside className="task-dock focus-review">
          <div className="dock-tabs"><span>运行</span><b>审阅</b><span>浏览器</span><span>预览</span></div>
          <header><span>审阅</span><em>内容选题与制作 · main</em></header>
          <div className="review-source-tabs"><b>有变化的文件　2</b><span>项目文件</span></div>
          <div className="changed-file"><i>M</i><span><b>产品发布简报.md</b><small>+ 48 行</small></span></div>
          <div className="changed-file"><i>M</i><span><b>60秒讲解稿.md</b><small>+ 32 行</small></span></div>
          <div className="diff-card"><span>18</span><p><em>+</em> 租房以后，我最先放弃的就是顶灯。</p><span>19</span><p><em>+</em> 不是为了氛围，是晚上剪片时眼睛真的更舒服。</p><span>20</span><p><em>+</em> 这盏灯最适合的，是经常换位置的小桌面。</p></div>
          <div className="review-comment"><span>新文件 · 第 19 行</span><p>把“真的更舒服”换成更具体、可以核对的体验描述</p><button>保存批注</button></div>
        </aside>
      </div>
    </div>
  );
}

function MediaProjectRail({ kind }: { kind: "image" | "video" }) {
  const image = kind === "image";
  return (
    <aside className="media-rail focus-project">
      <header><b>{image ? "图片项目" : "视频项目"}</b><i>＋</i></header>
      <div className="media-project active"><span>{image ? "图" : "片"}</span><div><b>{image ? "桌面灯封面组" : "桌面灯体验短片"}</b><small>{image ? "版本 7 · 4 个候选" : "时间线 4 · 3 段素材"}</small></div><em>•••</em></div>
      <div className="media-project"><span>{image ? "图" : "片"}</span><div><b>{image ? "封面标题延展" : "开箱素材整理"}</b><small>{image ? "版本 3" : "已分析"}</small></div></div>
      <div className="media-project"><span>{image ? "图" : "片"}</span><div><b>{image ? "横版头图" : "夜间桌面素材"}</b><small>{image ? "生成中" : "待剪辑"}</small></div></div>
      <div className="media-rail-footer"><span>最近删除</span><em>⌕</em></div>
    </aside>
  );
}

function ImageFocus() {
  const [selected, setSelected] = useState(0);
  const [currentVersion, setCurrentVersion] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setSelected(value => (value + 1) % imageCandidates.length), 4200);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="product-window image-focus">
      <div className="product-shell">
        <ProductSidebar active="image" />
        <header className="workbench-header"><b>图片工作台</b><button>＋　新项目</button><em>—　□　×</em></header>
        <MediaProjectRail kind="image" />
        <section className="image-stage">
          <header className="surface-toolbar"><span>▤　画布 · 1080 × 1440</span><b>−　100%　＋　　▥ 对比当前版本</b></header>
          <div className="image-canvas">
            <figure>
              <Image unoptimized key={imageCandidates[selected].src} src={imageCandidates[selected].src} width={508} height={764} alt={imageCandidates[selected].alt} />
              <figcaption><small>租房桌面真实体验 / 01</small><b>不用开顶灯<br />桌面也够亮</b><span>一盏可以跟着工作位置走的灯</span></figcaption>
            </figure>
          </div>
          <div className="candidate-strip focus-versions">
            <span>候选 / 版本</span>
            {imageCandidates.map((image, index) => (
              <button key={image.src} data-current={currentVersion === index ? "true" : "false"} className={selected === index ? "active" : ""} onClick={() => setSelected(index)} aria-label={`查看候选 ${index + 1}`}>
                <Image unoptimized src={image.src} width={508} height={764} alt="" /><i>0{index + 1}</i>
              </button>
            ))}
            <div className="version-actions">{selected === currentVersion ? <span>当前版本</span> : <button onClick={() => setCurrentVersion(selected)}>设为当前</button>}<button>导出</button></div>
          </div>
        </section>
        <aside className="image-inspector focus-layers">
          <div className="inspector-tabs"><b>图片设置</b></div>
          <label>模型</label><div className="select-line">GPT Image 2 <span>⌄</span></div>
          <label>{selected === currentVersion ? "从当前版本继续 · 继续编辑" : "所选候选尚未设为当前"}</label>
          <p>保留灯体结构和蓝色玻璃质感，换成更真实的租房书桌环境；标题区域保持干净，人物只出现手部。</p>
          <label>参考素材 · 3 / 8</label>
          <div className="reference-row focus-references">
            <span><Image unoptimized src="/luma-candidate-hero.webp" width={80} height={80} alt="主体参考" /><small>主体</small></span>
            <span><Image unoptimized src="/luma-candidate-top.webp" width={80} height={80} alt="环境参考" /><small>环境</small></span>
            <span><Image unoptimized src="/luma-candidate-macro.webp" width={80} height={80} alt="风格参考" /><small>风格</small></span>
          </div>
          <button className="primary-action" disabled={selected !== currentVersion}>{selected === currentVersion ? "生成编辑版本" : "先设为当前版本"}</button>
          <div className="layer-head"><b>图层与质检</b><span>94 / 100</span></div>
          <div className="layer-list"><span>▨ 基础图像 <em>1080 × 1440</em></span><span>▧ 文字 · 不用开顶灯 <em>72px</em></span><span>▧ 文字 · 桌面也够亮 <em>72px</em></span><small><i />视觉质检 94 / 100</small></div>
          <div className="export-row"><span>撤销　重做</span><button>导出 PNG</button></div>
        </aside>
      </div>
    </div>
  );
}

function VideoFocus() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewTime, setPreviewTime] = useState("00:00");
  const [previewProgress, setPreviewProgress] = useState(0);

  return (
    <div className="product-window video-focus">
      <div className="product-shell">
        <ProductSidebar active="video" />
        <header className="workbench-header"><b>视频工作台</b><span>本地引擎可用</span><button>＋　新项目</button><em>—　□　×</em></header>
        <MediaProjectRail kind="video" />
        <section className="video-stage">
          <header className="surface-toolbar dark"><span>源素材　 <b>节目预览</b></span><em>时间线版本 4　 ·　00:10</em></header>
          <div className="video-preview">
            <div className="video-reel" aria-label="桌面灯体验短片节目预览">
              <video
                ref={videoRef}
                className="reel-footage"
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
                poster="/luma-candidate-hero.webp"
                aria-hidden="true"
                onTimeUpdate={() => {
                  const currentTime = videoRef.current?.currentTime ?? 0;
                  const duration = videoRef.current?.duration ?? 10;
                  setPreviewTime(formatPreviewTime(currentTime));
                  setPreviewProgress(Number.isFinite(duration) && duration > 0 ? currentTime / duration : 0);
                }}
              >
                <source src="/luma-product-film-v1.mp4" type="video/mp4" />
              </video>
              <div className="reel-grade" />
              <div className="reel-copy"><small>桌面真实体验 / 01</small><b>租房以后<br />我先放弃了顶灯</b></div>
              <div className="reel-status"><i /> 产品短片 · 9:16</div>
              <div className="play-control">Ⅱ　 ━━━━━●━━━━　{previewTime} / 00:10　⌗</div>
            </div>
          </div>
          <div className="timeline focus-timeline">
            <header><b>✂　时间线</b><span>保存版本　▾</span></header>
            <div className="timeline-ruler"><span>00:00</span><span>00:03</span><span>00:07</span><span>00:10</span><i style={{ left: `${Math.min(98, Math.max(2, previewProgress * 100))}%` }} /></div>
            <div className="clip-track"><article className="c1"><b>01 正面建立</b><small>0.0 — 3.0s</small><em>裁剪　锁定　拆分</em></article><article className="c2"><b>02 材质环绕</b><small>3.0 — 7.0s</small><em>裁剪　锁定　拆分</em></article><article className="c3"><b>03 回到主视觉</b><small>7.0 — 10.0s</small><em>裁剪　锁定　拆分</em></article></div>
          </div>
        </section>
        <aside className="video-inspector focus-evidence">
          <div className="inspector-tabs"><b>素材与导出</b></div>
          <div className="evidence"><strong>12</strong><span>条已核验证据<small>画面 · 光线 · 材质 · 镜头</small></span></div>
          <label>剪辑目标</label><p>把三段产品素材剪成 10 秒竖版短片。前 3 秒建立正面主视觉，中段突出蓝色玻璃与金属质感，结尾回到稳定构图。</p>
          <button className="analyze">✦ 按目标分析素材</button>
          <label>备选方向 · 最多 3 个</label>
          <div className="edit-plan active"><i>01</i><span><b>产品一致性优先</b><small>灯体结构与主视觉保持一致</small></span><em>已采用</em></div>
          <div className="edit-plan"><i>02</i><span><b>氛围节奏优先</b><small>环境光变化带动转场</small></span><em>采用</em></div>
          <div className="source-proof"><b>素材来源</b><span>桌面灯正面.mp4　00:03</span><span>桌面灯侧面.mp4　00:04</span><span>桌面灯细节.mp4　00:03</span></div>
          <div className="export-line"><span>1080 × 1920</span><span>30 fps</span><span>H.264</span></div><button className="export">导出视频</button>
        </aside>
      </div>
    </div>
  );
}

function HeroStage() {
  const [mode, setMode] = useState<Workspace>("task");
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setMode(current => workspaces[(workspaces.findIndex(item => item.id === current) + 1) % 3].id), 9000);
    return () => clearInterval(timer);
  }, [paused]);
  return (
    <div className="hero-stage" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="stage-switcher">{workspaces.map(item => <button key={item.id} className={mode === item.id ? "active" : ""} onClick={() => setMode(item.id)}><i>{item.index}</i><span><b>{item.name}</b><small>{item.promise}</small></span><em /></button>)}</div>
      <ScaledProductFrame className="stage-window" height={700}>{mode === "task" ? <TaskFocus /> : mode === "image" ? <ImageFocus /> : <VideoFocus />}</ScaledProductFrame>
      <p className="stage-note"><i />点击切换工作台 · 悬停暂停</p>
    </div>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="hero-glow" />
      <div className="hero-grid" aria-hidden="true" />
      <div className="hero-signal signal-left" aria-hidden="true"><i /> PROJECT CONTEXT</div>
      <div className="hero-signal signal-right" aria-hidden="true"><i /> LIVE WORKSPACE</div>
      <div className="hero-copy reveal"><p className="eyebrow"><span>DESKTOP AI WORKSPACE</span><i /> WINDOWS & MACOS</p><h1>说清楚要什么<br /><em>把工作真正做完</em></h1><p>先用任务空间理清目标，再到图片和视频工作台分别推进。最后得到可以继续修改、直接交付的结果。</p><div className="hero-actions"><a href="#worker-story">查看完整流程 <span>↓</span></a><a href="#download">下载桌面版 <span>↗</span></a></div><div className="hero-proof" aria-label="产品关键能力"><span><i>01</i><b>进入真实项目</b></span><span><i>02</i><b>过程持续可见</b></span><span><i>03</i><b>成果继续可改</b></span></div></div>
      <HeroStage />
      <div className="capability-marquee"><div><span>资料整理与报告</span><i /><span>项目文件处理</span><i /><span>图片候选与编辑</span><i /><span>局部重绘与排版</span><i /><span>素材理解与剪辑</span><i /><span>时间线与本地导出</span><i /><span>资料整理与报告</span><i /><span>项目文件处理</span><i /><span>图片候选与编辑</span><i /><span>局部重绘与排版</span></div></div>
    </section>
  );
}

function WorkerStory() {
  return (
    <section id="worker-story" className="creator-story">
      <div className="creator-heading reveal"><p>ONE TASK, TWO CREATIVE BRANCHES</p><h2>一条任务主线<br />分出两条创作分支</h2><span>任务空间先把内容和要求准备好。图片与视频随后分别使用自己的真实素材，不发生图片转视频。</span></div>
      <div className="creator-platform reveal"><i />图片不变成视频 · 两条分支分别开始，最后汇总交付</div>
      <div className="creator-flow branch-flow reveal">
        <article className="branch-root"><i>01</i><em>任务主线</em><h3>先确定内容与依据</h3><p>读取资料和反馈，写出发布简报、讲解稿、画面要求与镜头要求。</p><div className="branch-root-outputs"><span><i>A</i>图片分支：画面要求 · 参考图片</span><span><i>B</i>视频分支：讲解稿 · 实拍视频与口播</span></div></article>
        <article><i>02A</i><em>图片工作台</em><h3>完成静态视觉</h3><p>生成候选、选定版本、局部修改并完成排版。</p><b>独立成果：封面主视觉.png</b></article>
        <article><i>02B</i><em>视频工作台</em><h3>完成动态成片</h3><p>理解视频和音频素材，调整时间线并在本机导出。</p><b>独立成果：10秒产品短片.mp4</b></article>
      </div>
    </section>
  );
}

function BranchSplit() {
  return (
    <section className="branch-split" aria-label="任务结果分为图片与视频两条创作分支">
      <div className="branch-split-copy reveal"><span>TASK READY</span><h3>任务结果准备好<br />两条创作分支分别开始</h3><p>它们共享已经确认的内容方向，但不共享素材，也不会互相转换。</p></div>
      <div className="branch-split-grid reveal">
        <a href="#image-branch"><i>02A</i><span><b>图片分支</b><small>画面要求 · 参考图片</small></span><em>封面主视觉　↓</em></a>
        <a href="#video-branch"><i>02B</i><span><b>视频分支</b><small>讲解稿 · 实拍视频 · 口播</small></span><em>体验成片　↓</em></a>
      </div>
    </section>
  );
}

function VideoBranchIntro() {
  return (
    <section className="video-branch-intro" aria-label="视频分支从自己的视频与音频素材独立开始">
      <div className="video-branch-copy reveal"><span>ANOTHER INDEPENDENT BRANCH</span><h3>视频从自己的素材开始</h3><p>上面的图片成果不会进入视频工作台。这里使用任务阶段确认的讲解稿与镜头要求，再导入真实视频和口播。</p></div>
      <div className="video-branch-inputs reveal"><span>讲解稿</span><i>+</i><span>实拍视频</span><i>+</i><span>口播音频</span><em>↓　视频工作台</em></div>
    </section>
  );
}

function FinalDelivery() {
  return (
    <section className="final-delivery">
      <div className="final-delivery-copy reveal"><p>PROJECT COMPLETE</p><h2>两条创作分支<br />汇成一套完整成果</h2><span>任务、图片和视频分别保留自己的项目、版本与历史，最后一起组成完整交付。</span></div>
      <div className="final-delivery-files reveal"><article><i>01</i><span><b>产品发布简报</b><small>事实、场景与表达依据</small></span><em>MD</em></article><article><i>02</i><span><b>封面主视觉</b><small>候选、排版与版本</small></span><em>PNG</em></article><article><i>03</i><span><b>10 秒产品短片</b><small>源素材与可恢复时间线</small></span><em>MP4</em></article></div>
    </section>
  );
}

function CapabilityAtlas() {
  const [expandedCapability, setExpandedCapability] = useState<CapabilityGroup["id"] | null>(null);

  return (
    <section id="capabilities" className="capability-atlas">
      <div className="capability-heading reveal">
        <p>COMPLETE CAPABILITY MAP</p>
        <h2>从开始一项工作<br />到拿到最终结果</h2>
        <span>这里不是另外一套功能。它把上面的三个工作台按实际使用顺序完全展开，让每一步能做什么都一目了然。</span>
      </div>
      <nav className="capability-index reveal" aria-label="完整功能目录">
        {capabilityGroups.map(group => (
          <a key={group.id} href={`#capability-${group.id}`} data-capability={group.id}>
            <i>{group.index}</i><span>{group.title.split("，")[0]}</span><em>↓</em>
          </a>
        ))}
      </nav>
      <div className="capability-chapters">
        {capabilityGroups.map(group => (
          <article id={`capability-${group.id}`} className="capability-chapter reveal" data-capability={group.id} key={group.id}>
            <header className="capability-chapter-head">
              <div className="capability-number"><span>{group.index}</span><i /></div>
              <div><p>{group.kicker}</p><h3>{group.title}</h3></div>
              <span>{group.summary}</span>
            </header>
            <ol className="capability-flow" aria-label={`${group.title}工作顺序`}>
              {group.flow.map((step, index) => (
                <li key={step}><i>0{index + 1}</i><span>{step}</span>{index < group.flow.length - 1 && <em>→</em>}</li>
              ))}
            </ol>
            <button
              className="capability-expand"
              type="button"
              aria-expanded={expandedCapability === group.id}
              aria-controls={`capability-details-${group.id}`}
              onClick={() => setExpandedCapability(current => current === group.id ? null : group.id)}
            >
              <span>{expandedCapability === group.id ? "收起详细能力" : "展开详细能力"}</span>
              <small>{group.phases.length} 组 · {group.phases.reduce((total, phase) => total + phase.items.length, 0)} 项</small>
              <i>{expandedCapability === group.id ? "−" : "+"}</i>
            </button>
            {expandedCapability === group.id && (
              <div id={`capability-details-${group.id}`} className="capability-phases">
                {group.phases.map((phase, phaseIndex) => (
                  <section className="capability-phase" key={phase.label}>
                    <header><i>{String(phaseIndex + 1).padStart(2, "0")}</i><span><h4>{phase.label}</h4><p>{phase.summary}</p></span></header>
                    <ol>
                      {phase.items.map((item, itemIndex) => (
                        <li key={item.title}>
                          <i>{String(itemIndex + 1).padStart(2, "0")}</i>
                          <span><b>{item.title}</b><small>{item.copy}</small></span>
                        </li>
                      ))}
                    </ol>
                  </section>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      <div className="capability-boundary reveal">
        <i>BOUNDARY</i>
        <p><b>三个工作台可以独立使用，也可以按项目组合</b><span>任务空间负责目标、资料和真实文件；图片工作台负责静态视觉；视频工作台负责已有视频与音频。图片不会自动变成视频，各自的项目和版本也不会被混在一起。</span></p>
        <a href="#download">开始使用 <em>↗</em></a>
      </div>
    </section>
  );
}

function WorkspaceSection({ id, index, kicker, title, copy, bullets, className, details, children }: { id?: string; index: string; kicker: string; title: string; copy: string; bullets: string[]; className: string; details: StoryDetail[]; children: React.ReactNode }) {
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setActive(value => (value + 1) % details.length), 4400);
    return () => clearInterval(timer);
  }, [details.length]);
  return (
    <section id={id} className={`workspace-section ${className}`}>
      <div className="workspace-layout">
        <div className="workspace-heading reveal"><div><p><i>{index}</i><span>{kicker}</span></p><h2>{title}</h2></div><div><p className="workspace-description">{copy}</p><ul>{bullets.map(item => <li key={item}><i>↗</i>{item}</li>)}</ul></div></div>
        <div className="detail-story reveal" role="tablist" aria-label={`${title}界面细节`}>
          {details.map((detail, indexValue) => <button key={detail.id} className={active === indexValue ? "active" : ""} onClick={() => setActive(indexValue)} role="tab" aria-selected={active === indexValue}><i>0{indexValue + 1}</i><span><b>{detail.label}</b><small>{detail.copy}</small></span><em /></button>)}
        </div>
        <div className="workspace-product reveal">
          <ScaledProductFrame className="workspace-viewport" height={760}><div className="workspace-demo" data-focus={details[active].id}>{children}</div></ScaledProductFrame>
        </div>
      </div>
    </section>
  );
}

function LandingPage() {
  const taskDetails = [
    { id: "global", label: "工作都在同一桌面", copy: "随时切换任务、图片、视频和最近项目" },
    { id: "thread", label: "直接说出要求", copy: "文字、附件和项目资料一起进入任务" },
    { id: "run", label: "过程清楚可见", copy: "读取资料、使用工具和修改文件都有记录" },
    { id: "review", label: "逐项审阅结果", copy: "查看文件变化，并在对应位置留下批注" },
  ];
  const imageDetails = [
    { id: "global", label: "独立保存图片项目", copy: "每个项目都有自己的任务和版本" },
    { id: "project", label: "集中管理项目", copy: "多个封面和延展图片一目了然" },
    { id: "references", label: "给参考图分角色", copy: "分别指定主体、风格和环境" },
    { id: "versions", label: "选定版本继续编辑", copy: "比较候选，再调整文字、局部和图层" },
  ];
  const videoDetails = [
    { id: "global", label: "剪辑自己的素材", copy: "导入实拍画面和口播，整理成片" },
    { id: "project", label: "集中管理素材", copy: "素材、分析结果和时间线都有清楚归属" },
    { id: "evidence", label: "先理解素材内容", copy: "结合语音、画面和镜头给出剪辑方向" },
    { id: "timeline", label: "自己控制时间线", copy: "裁剪、拆分、排序、预览和导出都能调整" },
  ];
  return (
    <main><PageMotion /><Header /><Hero /><WorkerStory />
      <div id="workspaces" className="workspace-list">
        <WorkspaceSection index="01" kicker="TASK WORKSPACE" title="第一步，把目标和两条创作分支准备好" copy="同一条任务读取资料和反馈，写出发布简报、讲解稿、画面要求与镜头要求。审阅确认后，图片和视频分别开始。" bullets={["理解项目文件、附件与网页资料", "使用工具完成多步任务", "分别准备图片与视频需要的内容"]} className="task-section" details={taskDetails}><TaskFocus /></WorkspaceSection>
        <BranchSplit />
        <WorkspaceSection id="image-branch" index="02A" kicker="IMAGE BRANCH" title="图片分支，用参考图片完成静态视觉" copy="把画面要求、产品主体和风格参考带入图片项目。比较候选，设为当前版本，再完成文字、图层和局部调整。" bullets={["主体、风格、环境等参考角色", "最多 4 个候选与版本历史", "局部重绘、精确排字、质检与导出"]} className="image-section" details={imageDetails}><ImageFocus /></WorkspaceSection>
        <VideoBranchIntro />
        <WorkspaceSection id="video-branch" index="02B" kicker="VIDEO BRANCH" title="视频分支，用真实视频与音频完成成片" copy="按照已经确认的讲解稿和镜头要求，导入拍好的视频与口播。先理解语音、画面和镜头，再选择方向、调整时间线并导出。" bullets={["带来源的语音、画面和镜头证据", "最多 3 个可选择的剪辑方向", "裁剪、拆分、版本、预览与本地导出"]} className="video-section" details={videoDetails}><VideoFocus /></WorkspaceSection>
        <FinalDelivery />
      </div>
      <CapabilityAtlas />
      <section className="scenarios"><div className="scenario-head reveal"><p>BUILT FOR REAL WORK</p><h2>无论做什么工作<br />都要真正完成</h2></div><div className="scenario-grid reveal"><article><span>01 / 内容工作者</span><h3>从资料到图文、封面和成片</h3><p>保留自己的事实与表达，快速完成不同平台需要的内容。</p></article><article><span>02 / 市场与运营</span><h3>把资料整理成可执行方案</h3><p>完成调研、简报、活动内容和视觉素材。</p></article><article><span>03 / 独立经营者</span><h3>一个人推进更多日常工作</h3><p>处理文案、海报、产品图和已有视频素材。</p></article><article><span>04 / 知识工作者</span><h3>让研究和写作落到文件</h3><p>从真实资料出发，留下可以审阅和交付的结果。</p></article></div></section>
      <section id="control" className="control"><div className="control-copy reveal"><p>YOU STAY IN CONTROL</p><h2>模型可以换<br />工作仍由你掌控</h2><span>自由选择模型和运行权限，项目、版本与成果始终保存在 BilliardBuddy 中。</span></div><div className="control-panel reveal"><div><i>01</i><span><b>自由选择大语言模型</b><small>使用托管模型或自己的模型</small></span><em>托管 / 自备　⌄</em></div><div><i>02</i><span><b>运行权限由你决定</b><small>每次询问、自动批准或完全访问</small></span><em>询问批准　⌄</em></div><div><i>03</i><span><b>重要操作先确认</b><small>费用、删除、提交和发布由你决定</small></span><em>操作前确认</em></div><div><i>04</i><span><b>成果独立保存</b><small>升级不会覆盖项目与会话</small></span><em className="safe">已保护</em></div></div></section>
      <section id="download" className="download"><div className="download-orbit"><i /><i /><i /></div><div className="download-copy reveal"><span className="download-icon"><Image unoptimized src="/app-icon.png" width={256} height={256} alt="" /></span><p>BUILT FOR WINDOWS & MACOS</p><h2>把下一件工作<br />做到真正能交付</h2><span>任务空间、图片工作台、视频工作台，已经在同一个桌面里准备好</span><div><a href="/download/windows">下载 Windows 版 <i>↗</i></a><a href="/download/macos">下载 macOS 版 <i>↗</i></a></div></div></section>
      <section className="faq"><div className="faq-head reveal"><p>FAQ</p><h2>开始之前<br />你可能还想知道</h2></div><div className="faq-list reveal">{faqs.map(([q, a]) => <details key={q}><summary>{q}<i>＋</i></summary><p>{a}</p></details>)}</div></section>
      <footer className="site-footer"><Brand /><p>进入真实工作，留下真实结果</p><nav><a href="#worker-story">完整流程</a><a href="#capabilities">全部功能</a><a href="#control">控制权</a></nav><small>© 2026 BilliardBuddy</small></footer>
    </main>
  );
}

export { LandingPage };
export default LandingPage;
