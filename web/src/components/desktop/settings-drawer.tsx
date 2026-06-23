"use client";

/**
 * Codex 风「设置」抽屉（替代老 web 的门店设置/BYOK 抽屉）：右侧滑出、浅色默认·跟随系统。
 * 只保留单窗口产品真正需要的两件事：① 门店名（没有则自动建一个）；② AI 模型 key（纯 BYOK，管家的钥匙）。
 * 从侧栏齿轮点开。BYOK 走和原来一致的接口：getByokConfig / updateByokConfig / validateByokConfig。
 */
import { useEffect, useState } from "react";
import { X, Loader2, Check, Cpu, Image as ImageIcon, Store, ShieldCheck, Puzzle, Plus, Trash2, AlertTriangle, Download } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";

type McpServer = { name: string; command?: string; status?: string; tools?: number; disabled?: boolean };
type McpPreset = { id: string; name: string; desc: string; command: string; args: string[] };
type PluginItem = { name: string; enabled: boolean; description: string; components: Record<string, number> };

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
  { name: "即梦 Seedream", base: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seedream-4-0" },
  { name: "通义万相", base: "https://dashscope.aliyuncs.com/api/v1", model: "wan2.6-t2i" },
  { name: "智谱 CogView", base: "https://open.bigmodel.cn/api/paas/v4", model: "cogview-4" },
];
const PRESET_CHIP = "rounded-md border border-black/[0.1] bg-black/[0.02] px-2 py-1 text-[11.5px] text-[#3a3a3c] transition hover:border-[#007AFF]/40 hover:bg-[#007AFF]/10 hover:text-[#007AFF] active:scale-[0.97] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]";

export function SettingsDrawer({
  open,
  onClose,
  onStoreNameChange,
}: {
  open: boolean;
  onClose: () => void;
  onStoreNameChange?: (name: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [storeName, setStoreName] = useState("");
  // 文字模型
  const [baseUrl, setBaseUrl] = useState("");
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

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setMsg(null);
    (async () => {
      const [s, b, sk, pl, mc, mp] = await Promise.allSettled([
        api.getMyStore(), api.getByokConfig(),
        api.listSkills(), api.listPlugins(), api.listMcp(), api.listMcpPresets(),
      ]);
      if (cancelled) return;
      if (s.status === "fulfilled" && s.value) {
        setStoreId(s.value.id);
        setStoreName(s.value.name || "");
      } else {
        setStoreId(null);
        setStoreName("");
      }
      if (b.status === "fulfilled" && b.value) {
        setBaseUrl(b.value.base_url || "");
        setModel(b.value.model || "");
        setKeyMask(b.value.key_configured ? b.value.key_mask || "已配置" : "");
        setImgBaseUrl(b.value.image_base_url || "");
        setImgModel(b.value.image_model || "");
        setImgKeyMask(b.value.image_key_configured ? b.value.image_key_mask || "已配置" : "");
      }
      if (sk.status === "fulfilled") setSkills(sk.value.skills || []);
      if (pl.status === "fulfilled") setPlugins(pl.value.plugins || []);
      if (mc.status === "fulfilled") setMcp(mc.value.servers || []);
      if (mp.status === "fulfilled") setMcpPresets(mp.value.presets || []);
      setApiKey("");
      setImgApiKey("");
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  async function saveStore() {
    const name = storeName.trim();
    if (!name) { setMsg({ kind: "err", text: "请先给门店起个名" }); return false; }
    if (storeId) {
      await api.updateStore({ name });
    } else {
      const res = await api.createStore({ name });
      setStoreId(res.id);
      api.setStoreId(res.id);
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
      <button type="button" aria-label="关闭设置" onClick={onClose} className="fixed inset-0 z-[60] cursor-default bg-black/30 dark:bg-black/50" />
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
            </section>

            {/* AI 文字模型 */}
            <section className="mb-6">
              <p className="mb-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">
                <Cpu className="h-3.5 w-3.5" /> AI 文字模型（你自带的 key）
              </p>
              <p className="mb-2 text-[11.5px] leading-snug text-[#86868b] dark:text-[#8a8c93]">点一下你的供应商，自动填好地址和模型——你只要贴上自己的 key。模型名可再改。</p>
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
                <ImageIcon className="h-3.5 w-3.5" /> AI 生图模型（选填，做海报用）
              </p>
              <p className="mb-2 text-[11.5px] leading-snug text-[#86868b] dark:text-[#8a8c93]">同样一键选——叠 Logo/二维码选「硅基流动·叠Logo首选」最稳。</p>
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
                    className="inline-flex items-center gap-1 rounded-md border border-black/[0.1] bg-black/[0.02] px-2 py-1 text-[11.5px] text-[#3a3a3c] transition hover:border-[#007AFF]/40 hover:text-[#007AFF] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]">
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
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition disabled:opacity-60 ${added ? "border-[#10a37f]/30 bg-[#10a37f]/10 text-[#10a37f]" : "border-black/[0.1] bg-black/[0.02] text-[#3a3a3c] hover:border-[#007AFF]/40 hover:text-[#007AFF] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]"}`}>
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
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#10a37f] px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-[#0e906f] disabled:opacity-50">
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
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-[#10a37f]" : "bg-[#ff9500]"}`} />
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[#3a3a3c] dark:text-[#c8cace]">
                            {x.name}
                            <span className="ml-1.5 text-[11px] text-[#a1a1a6]">{ok ? `已连上 · ${x.tools ?? 0} 个工具` : "没连上"}</span>
                          </span>
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
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-black/[0.1] bg-black/[0.02] px-3 text-[12px] text-[#3a3a3c] transition hover:border-[#007AFF]/40 hover:text-[#007AFF] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]">
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
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-[#10a37f] text-[13px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.99] disabled:opacity-50">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} 保存
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
