"use client";

/**
 * Codex 风「设置」抽屉（替代老 web 的门店设置/BYOK 抽屉）：右侧滑出、浅色默认·跟随系统。
 * A2(2026-07-03)：两套"高级模式"整体下线，普通老板看到的只剩四块——门店信息 / 门店记忆 /
 * 外观 / 字体大小。自带 key/MCP/插件/技能那整块高级 UI 不再挂载（代码原样留着，见 SHOW_ADVANCED_SETTINGS）；
 * 后端接口（getByokConfig / updateByokConfig / validateByokConfig / MCP / plugins / skills）全保留。
 */
import { useEffect, useState } from "react";
import { X, Loader2, Check, Cpu, Image as ImageIcon, Store, ShieldCheck, Puzzle, Plus, Trash2, AlertTriangle, Download, Brain, ChevronRight, DatabaseBackup, RotateCcw, ArrowUp, ArrowDown, Power } from "lucide-react";

import { api, type ModelProviderItem, type ModelStatusResponse } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { applyTheme, getTheme, type ThemeMode } from "@/lib/theme";
import { applyFontSize, getFontSize, type FontSizeMode } from "@/lib/font-size";
import { useDesktop } from "@/hooks/use-desktop";
import { modelHealthStatusText, sanitizeModelHealthError } from "@/hooks/model-health-status";
import type { StoreMemoryItem } from "@/types/store";

type McpServer = { name: string; command?: string; status?: string; tools?: number; disabled?: boolean };
type McpPreset = { id: string; name: string; desc: string; command: string; args: string[] };
type PluginItem = { name: string; enabled: boolean; description: string; components: Record<string, number> };
type ModelHealthItem = NonNullable<ModelStatusResponse["health"]>[number];
type ModelHealthHistoryItem = NonNullable<ModelStatusResponse["healthHistory"]>[number];

const INPUT =
  "w-full rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2 text-[13px] text-[#1d1d1f] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]";
const LABEL = "mb-1 block text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]";

// 一键选供应商预设：店主点一下 → 自动填好地址+模型，只需再贴自己的 key。端点均已验证（2026-06 实爬各家官方文档）。
// 排序≈真实用量（OpenRouter 全球榜 + 国内调用量）：DeepSeek/MiniMax/千问/Kimi/GLM 居前；豆包国内调用量第一。
// 模型名是【可改的合理默认】（各家型号更新快，base_url 才是关键、已逐一核验）。文心/混元因调用量偏低未纳入。
const TEXT_PRESETS = [
  { name: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" },
  { name: "MiniMax", base: "https://api.minimaxi.com/v1", model: "MiniMax-M2.5" },
  { name: "通义千问", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { name: "Kimi 月之暗面", base: "https://api.moonshot.cn/v1", model: "kimi-k2.6" },
  { name: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.6" },
  { name: "豆包 火山方舟", base: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6-251015" },
  { name: "小米 MiMo", base: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5" },
  { name: "硅基流动", base: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3.2" },
];
const IMAGE_PRESETS = [
  { name: "硅基流动·叠Logo首选", base: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen-Image-Edit-2509" },
  { name: "即梦 Seedream", base: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedream-4-5-251128" },
  { name: "通义万相", base: "https://dashscope.aliyuncs.com/api/v1", model: "wan2.6-t2i" },
  { name: "智谱 CogView", base: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-4" },
];
const PRESET_CHIP = "rounded-md border border-black/[0.1] bg-black/[0.02] px-2 py-1 text-[11.5px] text-[#3a3a3c] transition hover:border-[#10a37f]/40 hover:bg-[#10a37f]/10 hover:text-[#10a37f] active:scale-[0.97] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]";

// A2(2026-07-03)：两套"高级模式"整体下线——小白产品零模型名、零 MCP 字样。BYOK/MCP/插件/技能的
// 后端接口（/stores/me/byok、/agent/mcp/*、/agent/plugins、/agent/skills）全部保留，只是前端不再挂载
// 这块 UI；下面这段代码原样留着不删，未来要接回只需把这个常量翻成 true（不用重写）。
const SHOW_ADVANCED_SETTINGS = false;

function healthItemKey(item: ModelHealthItem, index: number): string {
  if (item.providerId) return `provider:${item.providerId}`;
  return `${item.source}:${item.model}:${index}`;
}

function cooldownLabel(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `约 ${Math.ceil(seconds / 60)} 分钟`;
}

function cooldownReasonLabel(item: ModelHealthItem): string {
  if (item.failureCategory === "configuration") return "配置冷却";
  if (item.failureCategory === "rate_limit") return "限流冷却";
  return "冷却";
}

function healthHistoryText(item: ModelHealthHistoryItem): string {
  if (item.kind === "success") return "恢复可用";
  if (item.kind === "clear") return "手动重试";
  if (item.failureCategory === "configuration") return `配置失败${item.failureCount ? ` ${item.failureCount} 次` : ""}`;
  if (item.failureCategory === "rate_limit") return `限流${item.failureCount ? ` ${item.failureCount} 次` : ""}`;
  return `失败${item.failureCount ? ` ${item.failureCount} 次` : ""}`;
}

function healthHistoryTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function SettingsDrawer({
  open,
  onClose,
  onStoreNameChange,
}: {
  open: boolean;
  onClose: () => void;
  onStoreNameChange?: (name: string) => void;
}) {
  const { isDesktop, electron } = useDesktop();
  // D-Task-4 开机自动启动：定时任务要 app 开着才会跑。null=还没读到/不支持，桌面版才读取展示。
  const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
  const [autoLaunchBusy, setAutoLaunchBusy] = useState(false);
  // P1-10 深浅色:亮/暗/跟随系统。客户端再读真实偏好(避免 SSR 不一致)。
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  useEffect(() => { setThemeMode(getTheme()); }, []);
  // B4：字号三档(标准/大/特大)，客户端再读真实偏好(避免 SSR 不一致)。
  const [fontSizeMode, setFontSizeMode] = useState<FontSizeMode>("standard");
  useEffect(() => { setFontSizeMode(getFontSize()); }, []);
  const [loading, setLoading] = useState(true);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [storeName, setStoreName] = useState("");
  // P1-6 门店素材：logo / 收款码（生图叠图、海报留资用）
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [qrcodeUrl, setQrcodeUrl] = useState<string | null>(null);
  const [qrcodeText, setQrcodeText] = useState("");
  const [uploadingKind, setUploadingKind] = useState<"logo" | "qrcode" | null>(null);
  // M3 门店记忆管理面：门店事实与偏好（看/改/删）+ 手动加"我的店规矩"
  const [memories, setMemories] = useState<StoreMemoryItem[]>([]);
  const [newRule, setNewRule] = useState("");
  const [memBusy, setMemBusy] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  // 文字模型
  const [baseUrl, setBaseUrl] = useState("");
  // 内置模型展示名（后端配置驱动，换模型时跟着变）
  const [labels, setLabels] = useState({ text: "MiMo V2.5", image: "GPT Image-2" });
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [keyMask, setKeyMask] = useState("");
  // 生图模型
  const [imgBaseUrl, setImgBaseUrl] = useState("");
  const [imgApiKey, setImgApiKey] = useState("");
  const [imgModel, setImgModel] = useState("");
  const [imgKeyMask, setImgKeyMask] = useState("");
  // 扩展（技能只读展示；插件/MCP 可管理）
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [mcpPresets, setMcpPresets] = useState<McpPreset[]>([]);
  // MCP「加」表单
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpCmd, setMcpCmd] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [extBusy, setExtBusy] = useState<string | null>(null); // 正在处理的扩展项标识（防重复点）
  // 从 GitHub 装插件
  const [pluginRepo, setPluginRepo] = useState("");
  // 生图 model↔供应商校验提示（温和，不拦保存）
  const [imgWarn, setImgWarn] = useState("");
  const [modelStatus, setModelStatus] = useState<ModelStatusResponse | null>(null);
  const [healthDetailsOpen, setHealthDetailsOpen] = useState(false);
  const [clearingHealth, setClearingHealth] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState<string | null>(null);

  // G-c 数据安全兜底：设置抽屉「备份店铺数据」一键导出(主库快照 + uploads 打包 zip)
  const [exporting, setExporting] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setMsg(null);
    setShowAdvanced(false);
    setHealthDetailsOpen(false);
    (async () => {
      // A2：高级区(BYOK/MCP/插件/技能)不再挂载，对应的加载请求也一并停掉，省无谓请求。
      const [s, b, modelHealth] = await Promise.allSettled([
        api.getMyStore(), api.getByokConfig(), api.getModelStatus(),
      ]);
      if (cancelled) return;
      if (s.status === "fulfilled" && s.value) {
        setStoreId(s.value.id);
        setStoreName(s.value.name || "");
        setLogoUrl(s.value.logo_url || null);
        setQrcodeUrl(s.value.qrcode_url || null);
        setQrcodeText(s.value.qrcode_text || "");
      } else {
        setStoreId(null);
        setStoreName("");
        setQrcodeText("");
      }
      if (b.status === "fulfilled" && b.value) {
        setLabels({
          text: b.value.bundled_model_label || "MiMo V2.5",
          image: b.value.bundled_image_label || "GPT Image-2",
        });
        setBaseUrl(b.value.base_url || "");
        setModel(b.value.model || "");
        setKeyMask(b.value.key_configured ? b.value.key_mask || "已配置" : "");
        setImgBaseUrl(b.value.image_base_url || "");
        setImgModel(b.value.image_model || "");
        setImgKeyMask(b.value.image_key_configured ? b.value.image_key_mask || "已配置" : "");
      }
      setModelStatus(modelHealth.status === "fulfilled" ? modelHealth.value : null);
      void refreshMemories();  // M3：拉店脑记忆
      setApiKey("");
      setImgApiKey("");
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open]);

  // D-Task-4 开机自启：只在桌面版、且这次抽屉真打开了才去读，浏览器版 electron?.app 不存在直接跳过。
  useEffect(() => {
    if (!open || !electron?.app) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await electron.app!.getAutoLaunch();
        if (!cancelled) setAutoLaunch(r.enabled);
      } catch {
        if (!cancelled) setAutoLaunch(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open, electron]);

  if (!open) return null;

  const modelHealthText = modelHealthStatusText(modelStatus);
  const modelHealthClass = modelHealthText.tone === "warn"
    ? "border-[#d4901f]/20 bg-[#d4901f]/[0.07] text-[#9a6a10] dark:border-[#d4a843]/20 dark:bg-[#d4a843]/[0.08] dark:text-[#d4a843]"
    : "border-[#10a37f]/20 bg-[#10a37f]/[0.06] text-[#10a37f]";
  const providerHealthRows = modelStatus?.health || [];
  const providerHealthHistory = modelStatus?.healthHistory || [];
  const providerConfigRows = modelStatus?.providers || [];

  // D-Task-4：开机自启开关，失败故障安全(不抛，只提示)
  async function toggleAutoLaunch() {
    if (!electron?.app || autoLaunch === null) return;
    const next = !autoLaunch;
    setAutoLaunchBusy(true);
    try {
      const r = await electron.app.setAutoLaunch(next);
      if (r.ok) {
        setAutoLaunch(next);
      } else {
        setMsg({ kind: "err", text: r.error ? `没设成开机自启：${r.error}` : "没设成开机自启" });
      }
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setAutoLaunchBusy(false);
    }
  }

  // G-c 数据安全兜底：把主库快照 + uploads(海报/二维码/视频等产出) 打包 zip，
  // 走系统「另存为」写到用户自己选的位置(桌面/U盘/网盘同步文件夹)——电脑坏了也能找回。
  // 直接拿字节自己转 base64(不走 JSON+base64 的 renderDeliverable 那条路)：导出包可能带较大的
  // 历史图片/视频，JSON 包一层字符串对内存更不友好，字节流更省。
  async function exportStoreData() {
    if (!electron?.files?.save) { setMsg({ kind: "err", text: "当前环境不支持保存到电脑，请用桌面版" }); return; }
    setExporting(true); setMsg(null);
    try {
      const res = await fetch(api.exportDataUrl());
      if (!res.ok) {
        let detail = "";
        try { detail = (await res.json())?.detail || ""; } catch { /* 非 JSON 响应，走默认文案 */ }
        throw new Error(detail || "导出失败，请稍后再试");
      }
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const cd = res.headers.get("content-disposition") || "";
      const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
      const defaultName = m ? decodeURIComponent(m[1]) : `球房数据备份-${Date.now()}.zip`;
      const r = await electron.files.save({
        defaultName,
        base64: btoa(binary),
        title: "备份店铺数据到电脑",
        filters: [{ name: "压缩包", extensions: ["zip"] }],
      });
      if (r.canceled) setMsg({ kind: "ok", text: "已取消" });
      else if (r.error) setMsg({ kind: "err", text: r.error });
      else setMsg({ kind: "ok", text: `已备份到：${r.path}` });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setExporting(false);
    }
  }

  async function clearProviderHealth(item: ModelHealthItem, index: number) {
    const key = healthItemKey(item, index);
    setClearingHealth(key);
    setMsg(null);
    try {
      const payload = item.providerId ? { providerId: item.providerId } : { source: item.source };
      const res = await api.clearModelHealth(payload);
      setModelStatus(res.status);
      setMsg({ kind: "ok", text: res.cleared > 0 ? "已允许这个 AI 通道重新尝试" : "这个 AI 通道已经不在冷却中" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setClearingHealth(null);
    }
  }

  async function refreshModelStatus() {
    const status = await api.getModelStatus();
    setModelStatus(status);
    return status;
  }

  async function setSavedProviderEnabled(provider: ModelProviderItem, enabled: boolean) {
    const key = `${provider.id}:enabled`;
    setProviderBusy(key);
    setMsg(null);
    try {
      await api.setProviderEnabled(provider.id, enabled);
      await refreshModelStatus();
      setMsg({ kind: "ok", text: enabled ? "已启用这个备用通道" : "已停用这个备用通道" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setProviderBusy(null);
    }
  }

  async function moveSavedProvider(provider: ModelProviderItem, direction: -1 | 1) {
    const providers = modelStatus?.providers || [];
    const index = providers.findIndex((item) => item.id === provider.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= providers.length) return;
    const ids = providers.map((item) => item.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    const key = `${provider.id}:move`;
    setProviderBusy(key);
    setMsg(null);
    try {
      await api.reorderProviders(ids);
      await refreshModelStatus();
      setMsg({ kind: "ok", text: "已调整 AI 通道优先级" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setProviderBusy(null);
    }
  }

  // M3：拉店脑记忆 + 增删改
  async function refreshMemories() {
    try { setMemories(await api.getStoreMemory()); } catch { /* 拿不到就空 */ }
  }
  async function addRule() {
    const c = newRule.trim();
    if (!c) return;
    setMemBusy("add"); setMsg(null);
    try { await api.addStoreMemory(c); setNewRule(""); await refreshMemories(); setMsg({ kind: "ok", text: "已保存店规矩" }); }
    catch (e) { setMsg({ kind: "err", text: getErrorMessage(e) }); }
    finally { setMemBusy(null); }
  }
  async function deleteMem(id: string) {
    setMemBusy(id); setMsg(null);
    try { await api.deleteStoreMemory(id); await refreshMemories(); }
    catch (e) { setMsg({ kind: "err", text: getErrorMessage(e) }); }
    finally { setMemBusy(null); }
  }
  async function saveEdit() {
    if (!editId) return;
    const c = editText.trim();
    if (!c) { setEditId(null); return; }
    setMemBusy(editId); setMsg(null);
    try { await api.updateStoreMemory(editId, c); setEditId(null); await refreshMemories(); }
    catch (e) { setMsg({ kind: "err", text: getErrorMessage(e) }); }
    finally { setMemBusy(null); }
  }

  async function uploadAsset(kind: "logo" | "qrcode", file: File) {
    setUploadingKind(kind); setMsg(null);
    try {
      const r = kind === "logo" ? await api.uploadLogo(file) : await api.uploadQrcode(file, qrcodeText);
      if (kind === "logo") setLogoUrl(r.url); else setQrcodeUrl(r.url);
      setMsg({ kind: "ok", text: kind === "logo" ? "门店 Logo 已上传" : "收款码已上传" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setUploadingKind(null);
    }
  }

  async function saveStore() {
    const name = storeName.trim();
    if (!name) { setMsg({ kind: "err", text: "请先给门店起个名" }); return false; }
    const qrcode_text = qrcodeText.trim() || null;
    if (storeId) {
      await api.updateStore({ name, qrcode_text });
    } else {
      const res = await api.createStore({ name, qrcode_text });
      setStoreId(res.id);
    }
    onStoreNameChange?.(name);
    return true;
  }

  async function saveAll() {
    setSaving(true);
    setMsg(null);
    try {
      const okStore = await saveStore();
      if (!okStore) { setSaving(false); return; }
      if (showAdvanced) {
        await api.updateByokConfig({
          enabled: true,
          base_url: baseUrl.trim() || null,
          api_key: apiKey.trim() || undefined, // 不传=保留原 key
          model: model.trim() || null,
          image_enabled: !!(imgBaseUrl.trim() || imgModel.trim() || imgApiKey.trim()),
          image_base_url: imgBaseUrl.trim() || null,
          image_api_key: imgApiKey.trim() || undefined,
          image_model: imgModel.trim() || null,
        });
        setApiKey("");
        setImgApiKey("");
      }
      setMsg({ kind: "ok", text: "已保存" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  async function testText() {
    setTesting(true);
    setMsg(null);
    try {
      const r = await api.validateByokConfig({
        enabled: true,
        base_url: baseUrl.trim() || null,
        api_key: apiKey.trim() || undefined,
        model: model.trim() || null,
      });
      setMsg(r.ok ? { kind: "ok", text: `连接成功${r.model ? `：${r.model}` : ""}` } : { kind: "err", text: r.error || "连接失败" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setTesting(false);
    }
  }

  // 生图 model↔供应商温和校验（失焦时查目录；不匹配只给提示、不拦保存）
  async function checkImageModel(base: string, m: string) {
    if (!base.trim() || !m.trim()) { setImgWarn(""); return; }
    try {
      const r = await api.validateImageModel(base.trim(), m.trim());
      setImgWarn(r.ok ? "" : (r.message || ""));
    } catch {
      setImgWarn("");
    }
  }

  // —— 扩展管理：刷新 MCP 列表/状态 + 插件列表 ——
  async function reloadExtensions() {
    const [mc, pl] = await Promise.allSettled([api.listMcp(), api.listPlugins()]);
    if (mc.status === "fulfilled") setMcp(mc.value.servers || []);
    if (pl.status === "fulfilled") setPlugins(pl.value.plugins || []);
  }

  async function runExt(key: string, fn: () => Promise<{ ok: boolean; message: string }>) {
    setExtBusy(key);
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ kind: r.ok ? "ok" : "err", text: r.message });
      if (r.ok) await reloadExtensions();
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setExtBusy(null);
    }
  }

  async function addMcpFromForm() {
    const name = mcpName.trim(), cmd = mcpCmd.trim();
    if (!name || !cmd) { setMsg({ kind: "err", text: "名字和命令都要填（命令比如 npx 或 uvx）" }); return; }
    const args = mcpArgs.trim() ? mcpArgs.trim().split(/\s+/) : [];
    await runExt("mcp-add", () => api.addMcp({ name, command: cmd, args }));
    setMcpName(""); setMcpCmd(""); setMcpArgs(""); setShowMcpForm(false);
  }

  async function addMcpPreset(p: McpPreset) {
    await runExt(`preset-${p.id}`, () => api.addMcp({ name: p.id, command: p.command, args: p.args }));
  }

  return (
    <>
      <button type="button" aria-label="关闭设置" onClick={onClose} data-modal-open className="fixed inset-0 z-[60] cursor-default bg-black/30 dark:bg-black/50" />
      <aside className="fixed right-0 top-0 z-[61] flex h-full w-[440px] max-w-[92vw] flex-col border-l border-black/[0.08] bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#16181d]">
        <div className="flex h-[52px] items-center justify-between border-b border-black/[0.08] px-5 dark:border-white/[0.06]">
          <span className="font-mono text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">设置</span>
          <button onClick={onClose} aria-label="关闭" className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.06] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-[13px] text-[#86868b] dark:text-[#6e7077]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {/* 门店 */}
            <section className="mb-6">
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">
                <Store className="h-3.5 w-3.5" /> 门店
              </p>
              <label className={LABEL}>门店名称</label>
              <input className={INPUT} value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="例如：楠米台球·万象城店" />
              <p className="mt-1.5 text-[11.5px] leading-snug text-[#a1a1a6] dark:text-[#6e7077]">门店名会用进管家给你写的文案里。填得越准，越像你自己的店。</p>

              {/* P1-6 门店素材：logo / 收款码（做海报时叠到图上） */}
              <p className="mb-2 mt-4 flex items-center gap-1.5 text-[12.5px] font-medium text-[#3a3a3c] dark:text-[#c8cace]">
                <ImageIcon className="h-3.5 w-3.5 text-[#86868b] dark:text-[#6e7077]" /> 门店素材（做海报叠图用·选填）
              </p>
              <div className="flex gap-3">
                {([["logo", "门店 Logo", logoUrl], ["qrcode", "收款码", qrcodeUrl]] as const).map(([kind, label, url]) => (
                  <label key={kind} title={`点击上传${label}`}
                    className="group flex h-24 w-24 cursor-pointer flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-dashed border-black/[0.15] bg-black/[0.015] text-[11px] text-[#86868b] transition hover:border-[#10a37f]/50 hover:bg-[#10a37f]/[0.04] dark:border-white/[0.12] dark:bg-white/[0.02] dark:text-[#6e7077]">
                    <input type="file" accept="image/*" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAsset(kind, f); e.currentTarget.value = ""; }} />
                    {uploadingKind === kind ? (
                      <Loader2 className="h-5 w-5 animate-spin text-[#10a37f]" />
                    ) : url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={api.resolveUrl(url)} alt={label} className="h-full w-full object-contain p-1" />
                    ) : (
                      <><Plus className="h-4 w-4" /><span>{label}</span></>
                    )}
                  </label>
                ))}
              </div>
              <label className={`${LABEL} mt-3`}>二维码内容</label>
              <input className={INPUT} value={qrcodeText} onChange={(e) => setQrcodeText(e.target.value)} placeholder="https://..." />
              <p className="mt-1.5 text-[11.5px] leading-snug text-[#a1a1a6] dark:text-[#6e7077]">传了 Logo / 收款码，做海报时管家能帮你叠到图上。</p>
            </section>

            {/* M3 门店记忆：门店事实与偏好（看/改/删）+ 手动店规矩 */}
            <section className="mb-6">
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">
                <Brain className="h-3.5 w-3.5" /> 门店记忆
              </p>
              <p className="mb-2 text-[11.5px] leading-snug text-[#86868b] dark:text-[#8a8c93]">用于回答的门店事实与偏好，可随时修改或删除。手动添加的店规矩不会被自动记录覆盖。</p>
              <div className="mb-2.5 flex gap-1.5">
                <input className={INPUT} value={newRule} onChange={(e) => setNewRule(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void addRule(); }}
                  placeholder="添加店规矩，比如：周二会员日五折" />
                <button onClick={() => void addRule()} disabled={memBusy === "add" || !newRule.trim()}
                  className="app-primary-action shrink-0 rounded-md px-3 text-[12.5px] transition disabled:opacity-50">
                  {memBusy === "add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "添加"}
                </button>
              </div>
              {/* 待确认(pending)无确认按钮,放这里只会误导;这里只显示已生效的手动/自动记录。 */}
              {memories.some((m) => m.source === "pending") && (
                <div className="mb-2 rounded-md bg-[#d4901f]/10 px-2.5 py-1.5 text-[11px] leading-snug text-[#9a6a10] dark:text-[#d4a843]">
                  有 {memories.filter((m) => m.source === "pending").length} 条「待确认」资料，请到顶部「知识库」里的「门店记忆」确认后使用。
                </div>
              )}
              {memories.filter((m) => m.source !== "pending").length === 0 ? (
                <div className="text-[11.5px] text-[#a1a1a6]">尚未添加资料。对话中确认的偏好会显示在这里，也可以手动添加店规矩。</div>
              ) : (
                <div className="space-y-1.5">
                  {memories.filter((m) => m.source !== "pending").sort((a, b) => (a.source === "manual" ? 0 : 1) - (b.source === "manual" ? 0 : 1)).map((m) => (
                    <div key={m.id} className="flex items-start gap-2 rounded-md border border-black/[0.06] bg-black/[0.015] px-2.5 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                      <span className={`mt-0.5 shrink-0 rounded px-1 py-px text-[9px] ${m.source === "manual" ? "bg-[#10a37f]/12 text-[#10a37f]" : "bg-black/[0.05] text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]"}`}>
                        {m.source === "manual" ? "我定的" : "自动记住"}
                      </span>
                      {editId === m.id ? (
                        <input className={`${INPUT} min-w-0 flex-1`} value={editText} autoFocus
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void saveEdit(); if (e.key === "Escape") setEditId(null); }} />
                      ) : (
                        <span className="min-w-0 flex-1 text-[12px] leading-snug text-[#3a3a3c] dark:text-[#c8cace]">{m.content}</span>
                      )}
                      {editId === m.id ? (
                        <button onClick={() => void saveEdit()} className="shrink-0 text-[11px] font-medium text-[#10a37f]">存</button>
                      ) : (
                        <button onClick={() => { setEditId(m.id); setEditText(m.content); }} className="shrink-0 text-[11px] text-[#a1a1a6] transition hover:text-[#10a37f]">改</button>
                      )}
                      <button onClick={() => void deleteMem(m.id)} disabled={memBusy === m.id} title="删除"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#a1a1a6] transition hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:opacity-50">
                        {memBusy === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* D.5：全内置·开箱即用 —— 让非技术老板一眼知道默认不用配 key */}
            <section className="mb-5 rounded-lg border border-[#10a37f]/20 bg-[#10a37f]/[0.06] px-3.5 py-2.5">
              <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-[#10a37f]">
                <Cpu className="h-3.5 w-3.5" /> 已内置、开箱即用
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-[#3a3a3c] dark:text-[#c8cace]">
                对话、看图、做海报、做视频的 AI 都已经内置好了，<b>打开就能用，什么都不用配</b>。
              </p>
              <div
                className={`mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${modelHealthClass}`}
                title={modelHealthText.detail}
              >
                {modelHealthText.tone === "warn" ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Check className="h-3.5 w-3.5 shrink-0" />}
                <span className="truncate">{modelHealthText.label}</span>
              </div>
              {(providerHealthRows.length > 0 || providerHealthHistory.length > 0 || providerConfigRows.length > 0) && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setHealthDetailsOpen((v) => !v)}
                    aria-expanded={healthDetailsOpen}
                    className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#6e6e73] transition hover:text-[#10a37f] dark:text-[#9a9ca3] dark:hover:text-[#70d7bd]"
                  >
                    <ChevronRight className={`h-3.5 w-3.5 transition-transform ${healthDetailsOpen ? "rotate-90" : ""}`} />
                    AI 通道详情
                  </button>
                  {healthDetailsOpen && (
                    <div className="mt-2 overflow-hidden border-y border-black/[0.07] dark:border-white/[0.07]">
                      {providerHealthRows.map((item, index) => {
                        const cooling = item.state === "cooling";
                        const key = healthItemKey(item, index);
                        const busy = clearingHealth === key;
                        return (
                          <div key={key} className="flex items-start gap-2 border-b border-black/[0.06] py-2 last:border-b-0 dark:border-white/[0.06]">
                            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cooling ? "bg-[#d4901f]" : "bg-[#10a37f]"}`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span className="truncate text-[12px] font-medium text-[#3a3a3c] dark:text-[#dfe1e5]">{item.label}</span>
                                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] ${cooling ? "bg-[#d4901f]/10 text-[#9a6a10] dark:text-[#d4a843]" : "bg-[#10a37f]/10 text-[#10a37f]"}`}>
                                  {cooling ? `${cooldownReasonLabel(item)} ${cooldownLabel(item.cooldownMsRemaining)}` : "就绪"}
                                </span>
                              </div>
                              <p className="mt-0.5 truncate text-[11px] text-[#86868b] dark:text-[#8a8c93]">{item.model}</p>
                              {cooling && item.lastError && (
                                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-[#9a6a10] dark:text-[#d4a843]">{sanitizeModelHealthError(item.lastError)}</p>
                              )}
                            </div>
                            {cooling && (
                              <button
                                type="button"
                                onClick={() => void clearProviderHealth(item, index)}
                                disabled={busy}
                                title="清除冷却，下一轮重新尝试这个通道"
                                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2 text-[11px] text-[#3a3a3c] transition hover:border-[#10a37f]/35 hover:text-[#10a37f] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#c8cace]"
                              >
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                                重试
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {providerHealthHistory.length > 0 && (
                        <div className="border-t border-black/[0.07] py-2 dark:border-white/[0.07]">
                          <div className="mb-1.5 text-[11px] font-medium text-[#86868b] dark:text-[#8a8c93]">最近排障记录</div>
                          {providerHealthHistory.slice(0, 5).map((item, index) => (
                            <div key={`${item.key}-${item.ts}-${index}`} className="flex min-w-0 items-start gap-2 py-1">
                              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${item.kind === "success" ? "bg-[#10a37f]" : item.kind === "clear" ? "bg-[#86868b]" : "bg-[#d4901f]"}`} />
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-[11.5px] font-medium text-[#3a3a3c] dark:text-[#dfe1e5]">{item.label}</span>
                                  <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-0.5 text-[10.5px] text-[#6e6e73] dark:bg-white/[0.05] dark:text-[#8a8c93]">{healthHistoryText(item)}</span>
                                  <span className="shrink-0 text-[10.5px] text-[#a1a1a6] dark:text-[#6e7077]">{healthHistoryTime(item.ts)}</span>
                                </div>
                                {item.error && <p className="mt-0.5 line-clamp-1 text-[11px] text-[#9a6a10] dark:text-[#d4a843]">{sanitizeModelHealthError(item.error)}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {providerConfigRows.length > 0 && (
                        <div className="border-t border-black/[0.07] py-2 dark:border-white/[0.07]">
                          <div className="mb-1.5 text-[11px] font-medium text-[#86868b] dark:text-[#8a8c93]">保存通道优先级</div>
                          {providerConfigRows.map((provider, index) => {
                            const active = modelStatus?.activeId === provider.id;
                            const runtimeNow = modelStatus?.runtime?.providerId === provider.id;
                            const toggleBusy = providerBusy === `${provider.id}:enabled`;
                            const moveBusy = providerBusy === `${provider.id}:move`;
                            return (
                              <div key={provider.id} className="flex items-center gap-2 py-1.5">
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-w-0 items-center gap-1.5">
                                    <span className={`truncate text-[12px] font-medium ${provider.enabled ? "text-[#3a3a3c] dark:text-[#dfe1e5]" : "text-[#9a9ca3]"}`}>{provider.name}</span>
                                    {active && runtimeNow && <span className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[10.5px] text-[#10a37f]">当前</span>}
                                    {active && !runtimeNow && <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-0.5 text-[10.5px] text-[#86868b] dark:bg-white/[0.06]">默认</span>}
                                    {!active && runtimeNow && <span className="shrink-0 rounded bg-[#d4901f]/10 px-1.5 py-0.5 text-[10.5px] text-[#9a6a10] dark:text-[#d4a843]">接管中</span>}
                                    {!provider.enabled && <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-0.5 text-[10.5px] text-[#86868b] dark:bg-white/[0.06]">停用</span>}
                                  </div>
                                  <p className="mt-0.5 truncate text-[11px] text-[#86868b] dark:text-[#8a8c93]">{provider.model}</p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => void moveSavedProvider(provider, -1)}
                                    disabled={index === 0 || !!providerBusy}
                                    title="优先级上移"
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.08] bg-white text-[#6e6e73] transition hover:border-[#10a37f]/35 hover:text-[#10a37f] disabled:opacity-35 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#c8cace]"
                                  >
                                    {moveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void moveSavedProvider(provider, 1)}
                                    disabled={index === providerConfigRows.length - 1 || !!providerBusy}
                                    title="优先级下移"
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.08] bg-white text-[#6e6e73] transition hover:border-[#10a37f]/35 hover:text-[#10a37f] disabled:opacity-35 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#c8cace]"
                                  >
                                    {moveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDown className="h-3.5 w-3.5" />}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void setSavedProviderEnabled(provider, !provider.enabled)}
                                    disabled={!!providerBusy}
                                    title={provider.enabled ? "停用这个候选通道" : "启用这个候选通道"}
                                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.08] bg-white text-[#6e6e73] transition hover:border-[#10a37f]/35 hover:text-[#10a37f] disabled:opacity-35 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-[#c8cace]"
                                  >
                                    {toggleBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* P1-10 外观:亮/暗/跟随系统(默认跟随)。普通路径就能切,不用进高级。 */}
            <section className="mb-5">
              <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">外观</div>
              <div className="inline-flex rounded-lg border border-black/[0.08] bg-black/[0.015] p-0.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                {([["light", "亮"], ["dark", "暗"], ["system", "跟随系统"]] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => { applyTheme(mode); setThemeMode(mode); }}
                    className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
                      themeMode === mode
                        ? "bg-white text-[#1d1d1f] shadow-sm dark:bg-white/[0.12] dark:text-[#e6e7e9]"
                        : "text-[#86868b] hover:text-[#1d1d1f] dark:text-[#8a8c93] dark:hover:text-[#e6e7e9]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* B4：字号三档(标准/大/特大)，老板年龄层高感知，同一「外观」区紧跟深浅色切换。 */}
              <div className="mb-1.5 mt-4 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">字号大小</div>
              <div className="inline-flex rounded-lg border border-black/[0.08] bg-black/[0.015] p-0.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                {([["standard", "标准"], ["large", "大"], ["xlarge", "特大"]] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => { applyFontSize(mode); setFontSizeMode(mode); }}
                    className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition ${
                      fontSizeMode === mode
                        ? "bg-white text-[#1d1d1f] shadow-sm dark:bg-white/[0.12] dark:text-[#e6e7e9]"
                        : "text-[#86868b] hover:text-[#1d1d1f] dark:text-[#8a8c93] dark:hover:text-[#e6e7e9]"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-[#a1a1a6] dark:text-[#6e7077]">看不清小字就选「大」或「特大」，界面文字和按钮跟着一起放大。</p>
            </section>

            {/* D-Task-4 开机自动启动：定时任务(每天写文案/每周出周报)要 app 开着才会跑，
                只在桌面版、且拿得到开关状态时才露出；浏览器版/取不到状态直接不挂载这段。 */}
            {isDesktop && electron?.app && autoLaunch !== null && (
              <section className="mb-5">
                <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">开机自动启动</div>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-black/[0.08] bg-black/[0.015] px-3.5 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <p className="text-[11.5px] leading-snug text-[#3a3a3c] dark:text-[#c8cace]">
                    想要每天固定时间自动出文案/周报，需要开机就打开这个软件。默认关；开着 app 时定时任务才会跑。
                  </p>
                  <button
                    type="button"
                    onClick={() => void toggleAutoLaunch()}
                    disabled={autoLaunchBusy}
                    aria-pressed={autoLaunch}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${autoLaunch ? "bg-[#10a37f]" : "bg-black/[0.15] dark:bg-white/[0.18]"}`}
                  >
                    <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${autoLaunch ? "left-[18px]" : "left-0.5"}`} />
                  </button>
                </div>
              </section>
            )}

            {/* G-c 数据安全兜底：电脑坏了数据不至于全丢。软件已在后台每天自动备份主库，
                这里再给一个"现在就要一份"的按钮，打包存到自己电脑/U盘/网盘同步文件夹。 */}
            {isDesktop && (
              <section className="mb-5">
                <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">
                  <DatabaseBackup className="h-3.5 w-3.5" /> 数据安全
                </div>
                <div className="rounded-lg border border-black/[0.08] bg-black/[0.015] px-3.5 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
                  <p className="mb-2.5 text-[11.5px] leading-snug text-[#3a3a3c] dark:text-[#c8cace]">
                    软件已经每天自动在本机备份一份门店数据。想现在就存一份到别的地方（比如 U 盘、网盘同步文件夹），点这里打包下载——万一电脑坏了，数据不至于全丢。
                  </p>
                  <button
                    type="button"
                    onClick={() => void exportStoreData()}
                    disabled={exporting}
                    className="inline-flex items-center gap-1.5 rounded-md border border-black/[0.1] bg-black/[0.02] px-3 py-1.5 text-[12.5px] text-[#3a3a3c] transition hover:bg-black/[0.04] active:scale-[0.98] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
                  >
                    {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DatabaseBackup className="h-3.5 w-3.5" />}
                    {exporting ? "打包中…" : "备份店铺数据到电脑"}
                  </button>
                </div>
              </section>
            )}

            {/* A2：两套"高级模式"整体下线——设置抽屉只剩门店信息/门店记忆/外观/字体大小四块，
                零模型名、零 MCP 字样。下面这个入口按钮 + 它展开的整块高级内容原样留着不删，只是
                不再挂载；SHOW_ADVANCED_SETTINGS 翻成 true 即可一日接回。 */}
            {SHOW_ADVANCED_SETTINGS && (
              <>
            <section className="mb-5">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between rounded-lg border border-black/[0.08] bg-black/[0.015] px-3.5 py-2.5 text-left transition hover:bg-black/[0.03] dark:border-white/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05]"
                aria-expanded={showAdvanced}
              >
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium text-[#3a3a3c] dark:text-[#c8cace]">高级设置</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-[#86868b] dark:text-[#8a8c93]">进阶选项。日常使用不需要改这里。</span>
                </span>
                <ChevronRight className={`h-4 w-4 shrink-0 text-[#a1a1a6] transition-transform ${showAdvanced ? "rotate-90" : ""}`} />
              </button>
            </section>

            {showAdvanced && (
              <>
            {/* AI 文字模型（高级·可选 BYOK） */}
            <section className="mb-6">
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">
                <Cpu className="h-3.5 w-3.5" /> 高级 · 文字模型（用我自己的 key · 可选）
              </p>
              <p className="mb-2 text-[11.5px] leading-snug text-[#86868b] dark:text-[#8a8c93]">默认已内置 {labels.text}、不用填这里。只有想换成自己的文字模型才填：点一下供应商自动填好地址和模型，再贴你的 key。</p>
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {TEXT_PRESETS.map((p) => (
                  <button key={p.name} type="button" onClick={() => { setBaseUrl(p.base); setModel(p.model); }} className={PRESET_CHIP}>{p.name}</button>
                ))}
              </div>
              <div className="space-y-2.5">
                <div><label className={LABEL}>接口地址 Base URL</label><input className={INPUT} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" /></div>
                <div><label className={LABEL}>API Key</label><input className={INPUT} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyMask ? `已配置（${keyMask}），留空不改` : "sk-…"} autoComplete="off" />
                  <p className="mt-1 text-[11px] leading-snug text-[#a1a1a6] dark:text-[#6e7077]">还没有 key？到上面选的那家供应商官网注册登录，在「API 密钥 / API Keys」页新建一个，复制回来贴上即可。</p></div>
                <div><label className={LABEL}>模型名</label><input className={INPUT} value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-v4-flash" /></div>
              </div>
              <button onClick={testText} disabled={testing}
                className="mt-2.5 inline-flex items-center gap-1.5 rounded-md border border-black/[0.1] bg-black/[0.02] px-3 py-1.5 text-[12.5px] text-[#3a3a3c] transition hover:bg-black/[0.04] active:scale-[0.98] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]">
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} 测试连接
              </button>
            </section>

            {/* AI 生图模型 */}
            <section className="mb-2">
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">
                <ImageIcon className="h-3.5 w-3.5" /> 高级 · 生图模型（用我自己的 key · 选填）
              </p>
              <p className="mb-2 text-[11.5px] leading-snug text-[#86868b] dark:text-[#8a8c93]">默认已内置 {labels.image}、不用填。想换自己的生图模型才填——同样一键选；叠 Logo/二维码选「硅基流动·叠Logo首选」最稳。</p>
              <div className="mb-2.5 flex flex-wrap gap-1.5">
                {IMAGE_PRESETS.map((p) => (
                  <button key={p.name} type="button" onClick={() => { setImgBaseUrl(p.base); setImgModel(p.model); setImgWarn(""); }} className={PRESET_CHIP}>{p.name}</button>
                ))}
              </div>
              <div className="space-y-2.5">
                <div><label className={LABEL}>接口地址 Base URL</label><input className={INPUT} value={imgBaseUrl} onChange={(e) => setImgBaseUrl(e.target.value)} onBlur={(e) => checkImageModel(e.target.value, imgModel)} placeholder="https://api.siliconflow.cn/v1" /></div>
                <div><label className={LABEL}>API Key</label><input className={INPUT} type="password" value={imgApiKey} onChange={(e) => setImgApiKey(e.target.value)} placeholder={imgKeyMask ? `已配置（${imgKeyMask}），留空不改` : "sk-…"} autoComplete="off" /></div>
                <div><label className={LABEL}>模型名</label><input className={INPUT} value={imgModel} onChange={(e) => setImgModel(e.target.value)} onBlur={(e) => checkImageModel(imgBaseUrl, e.target.value)} placeholder="Qwen/Qwen-Image" /></div>
              </div>
              {imgWarn && (
                <p className="mt-2 flex items-start gap-1.5 rounded-md bg-[#ff9500]/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-[#bf6a00] dark:text-[#ffb454]">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {imgWarn}
                </p>
              )}
            </section>

            {/* 扩展：技能（只读）+ MCP（可管理）+ 插件（可管理） */}
            <section className="mb-2 mt-2">
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">
                <Puzzle className="h-3.5 w-3.5" /> 扩展能力（给管家加新本事）
              </p>

              {/* MCP 服务器：列已配 + 一键加预设 + 自定义加 + 删/停 */}
              <div className="mb-4">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[12.5px] font-medium text-[#3a3a3c] dark:text-[#c8cace]">外接工具（MCP）· {mcp.length}</span>
                  <button type="button" onClick={() => setShowMcpForm((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-md border border-black/[0.1] bg-black/[0.02] px-2 py-1 text-[11.5px] text-[#3a3a3c] transition hover:border-[#10a37f]/40 hover:text-[#10a37f] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]">
                    <Plus className="h-3 w-3" /> 自己加
                  </button>
                </div>
                <p className="mb-2 text-[11.5px] leading-snug text-[#a1a1a6] dark:text-[#6e7077]">MCP 是给管家外接的小工具（联网搜、抓网页、记忆…）。下面这几个免费、不用申请 key，点一下就装。</p>

                {/* 免 key 预设一键加 */}
                {mcpPresets.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {mcpPresets.map((p) => {
                      const added = mcp.some((s) => s.name === p.id);
                      return (
                        <button key={p.id} type="button" title={p.desc}
                          disabled={added || extBusy === `preset-${p.id}`}
                          onClick={() => addMcpPreset(p)}
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition disabled:opacity-60 ${added ? "border-[#10a37f]/30 bg-[#10a37f]/10 text-[#10a37f]" : "border-black/[0.1] bg-black/[0.02] text-[#3a3a3c] hover:border-[#10a37f]/40 hover:text-[#10a37f] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]"}`}>
                          {extBusy === `preset-${p.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : added ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                          {p.name}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* 自定义加表单 */}
                {showMcpForm && (
                  <div className="mb-2 space-y-2 rounded-lg border border-black/[0.08] bg-black/[0.015] p-2.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
                    <div><label className={LABEL}>名字（自己取）</label><input className={INPUT} value={mcpName} onChange={(e) => setMcpName(e.target.value)} placeholder="例如 fetch" /></div>
                    <div><label className={LABEL}>命令</label><input className={INPUT} value={mcpCmd} onChange={(e) => setMcpCmd(e.target.value)} placeholder="npx 或 uvx" /></div>
                    <div><label className={LABEL}>参数（空格分开，没有就留空）</label><input className={INPUT} value={mcpArgs} onChange={(e) => setMcpArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-xxx" /></div>
                    <button type="button" onClick={addMcpFromForm} disabled={extBusy === "mcp-add"}
                      className="app-primary-action inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition disabled:opacity-50">
                      {extBusy === "mcp-add" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} 加上
                    </button>
                  </div>
                )}

                {/* 已配 server 列表（连接状态 + 删/停） */}
                {mcp.length ? (
                  <div className="space-y-1.5">
                    {mcp.map((x) => {
                      const ok = x.status === "connected";
                      return (
                        <div key={x.name} className="flex items-center gap-2 rounded-md border border-black/[0.06] bg-black/[0.015] px-2.5 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${x.disabled ? "bg-[#b0b0b5]" : ok ? "bg-[#10a37f]" : "bg-[#ff9500]"}`} />
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[#3a3a3c] dark:text-[#c8cace]">
                            {x.name}
                            <span className="ml-1.5 text-[11px] text-[#a1a1a6]">{x.disabled ? "已停用" : ok ? `已连上 · ${x.tools ?? 0} 个工具` : "没连上"}</span>
                          </span>
                          {/* P1：启用/停用开关（之前只有删除）。停用=不删配置、只是这次不挂它的工具。 */}
                          <button type="button" title={x.disabled ? "已停用 · 点击启用" : "已启用 · 点击停用"} disabled={extBusy === `mcp-tog-${x.name}`}
                            onClick={() => runExt(`mcp-tog-${x.name}`, () => api.toggleMcp(x.name, !x.disabled))}
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] transition disabled:opacity-50 ${x.disabled ? "text-[#a1a1a6] hover:bg-black/[0.05] dark:hover:bg-white/[0.06]" : "bg-[#10a37f]/10 text-[#10a37f] hover:bg-[#10a37f]/15"}`}>
                            {extBusy === `mcp-tog-${x.name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (x.disabled ? "已停用" : "已启用")}
                          </button>
                          <button type="button" title="删除" disabled={extBusy === `mcp-del-${x.name}`}
                            onClick={() => runExt(`mcp-del-${x.name}`, () => api.removeMcp(x.name))}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#a1a1a6] transition hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:opacity-50">
                            {extBusy === `mcp-del-${x.name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : <div className="text-[11.5px] text-[#a1a1a6]">还没接外接工具。点上面任意一个免费的试试。</div>}
              </div>

              {/* 插件：启停 + 从 GitHub 装 */}
              <div className="mb-4">
                <div className="mb-1.5 text-[12.5px] font-medium text-[#3a3a3c] dark:text-[#c8cace]">插件 · {plugins.length}</div>
                <p className="mb-2 text-[11.5px] leading-snug text-[#a1a1a6] dark:text-[#6e7077]">插件能一次性给管家装上一整套技能/风格/工具。装好后这里能开关它。</p>
                {plugins.length > 0 && (
                  <div className="mb-2 space-y-1.5">
                    {plugins.map((p) => (
                      <div key={p.name} className="flex items-center gap-2 rounded-md border border-black/[0.06] bg-black/[0.015] px-2.5 py-1.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[#3a3a3c] dark:text-[#c8cace]">
                          {p.name}{p.description ? <span className="ml-1.5 text-[11px] text-[#a1a1a6]">{p.description}</span> : null}
                        </span>
                        <button type="button" disabled={extBusy === `pl-${p.name}`}
                          onClick={() => runExt(`pl-${p.name}`, () => api.togglePlugin(p.name, !p.enabled))}
                          className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition disabled:opacity-50 ${p.enabled ? "bg-[#10a37f]/10 text-[#10a37f] hover:bg-[#10a37f]/20" : "bg-black/[0.05] text-[#86868b] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:text-[#9a9ca3]"}`}>
                          {extBusy === `pl-${p.name}` ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" /> : p.enabled ? "已启用" : "已停用"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-1.5">
                  <input className={INPUT} value={pluginRepo} onChange={(e) => setPluginRepo(e.target.value)} placeholder="从 GitHub 装：owner/repo" />
                  <button type="button" disabled={!pluginRepo.trim() || extBusy === "pl-install"}
                    onClick={() => runExt("pl-install", () => api.installPlugin(pluginRepo.trim())).then(() => setPluginRepo(""))}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-black/[0.1] bg-black/[0.02] px-3 text-[12px] text-[#3a3a3c] transition hover:border-[#10a37f]/40 hover:text-[#10a37f] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]">
                    {extBusy === "pl-install" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} 装
                  </button>
                </div>
              </div>

              {/* 技能：只读展示（放技能目录或装插件即自动出现在 / 命令面板） */}
              <div>
                <div className="mb-1.5 text-[12.5px] font-medium text-[#3a3a3c] dark:text-[#c8cace]">技能 · {skills.length}</div>
                {skills.length ? (
                  <div className="space-y-0.5 text-[12px]">
                    {skills.slice(0, 10).map((x) => (
                      <div key={x.name} className="truncate text-[#3a3a3c] dark:text-[#c8cace]">· /{x.name} <span className="text-[#a1a1a6]">{x.description}</span></div>
                    ))}
                  </div>
                ) : <div className="text-[11.5px] text-[#a1a1a6]">还没有技能。装个插件就会带技能进来，出现在 / 命令面板里。</div>}
              </div>
            </section>
              </>
            )}
              </>
            )}
          </div>
        )}

        {/* 底部：消息 + 保存 */}
        {!loading && (
          <div className="border-t border-black/[0.08] px-5 py-3 dark:border-white/[0.06]">
            {msg && (
              <p className={`mb-2 flex items-center gap-1.5 text-[12.5px] ${msg.kind === "ok" ? "text-[#10a37f]" : "text-[#ff3b30] dark:text-[#ff8585]"}`}>
                {msg.kind === "ok" ? <Check className="h-3.5 w-3.5" /> : null} {msg.text}
              </p>
            )}
            <button onClick={saveAll} disabled={saving}
              className="app-primary-action flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition active:scale-[0.99] disabled:opacity-50">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} 保存
            </button>
            {/* B-Task-2 合规署名：MiSans 官方 EULA 要求嵌入使用需署名。 */}
            <p className="mt-2 text-center text-[10.5px] leading-snug text-[#6e6e73] dark:text-[#98989d]">本软件界面字体使用小米 MiSans</p>
          </div>
        )}
      </aside>
    </>
  );
}
