// 球房管家 · ts-desktop 前端渲染器:WS 连本地 ts 后端,渲染 Codex/Work Buddy 式低噪工具流。
// 事件契约对齐 ts/src/types/events.ts(AgentEvent)与 server WS 帧({type:'event',event} / ready / error / approve_result)。
(function () {
  const $ = (id) => document.getElementById(id);
  const thread = $('thread');
  const wrap = thread.querySelector('.wrap');
  const input = $('input');
  const sendBtn = $('send');
  const statusEl = $('status');
  const emptyEl = $('empty');
  const jumpBtn = $('jump-latest');       // 回到最新药丸(智能滚动)
  const runIndicator = $('run-indicator'); // 运行指示 pill

  const sesslist = $('sesslist');
  const newChatBtn = $('newchat');
  const expertSel = $('expert');
  const wsPathEl = $('ws-path');
  const wsPickBtn = $('ws-pick');
  const wsTreeEl = $('ws-tree');
  const host = window.desktopHost;
  let workspaceRoot = ''; // 空=后端默认工作区(sidecar cwd)
  let lastUserMessage = ''; // 失败时可重试
  const previewEl = $('preview'), pvBody = $('pv-body'), pvTitle = $('pv-title'), pvClose = $('pv-close');
  const changesBtn = $('changes-btn'), changesN = $('changes-n');
  const changedFiles = new Set(); // 本会话改动过的文件(§9 文件变更列表)

  function noteFileChange(output) {
    const re = /<file_change path="([^"]+)"/g; let m; let added = false;
    while ((m = re.exec(String(output || '')))) { const p = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'); if (!changedFiles.has(p)) { changedFiles.add(p); added = true; } }
    if (added) { changesN.textContent = changedFiles.size; changesBtn.classList.add('has'); }
  }
  function showChanges() {
    pvTitle.textContent = '改动文件 (' + changedFiles.size + ')';
    const box = document.createElement('div'); box.className = 'changed';
    if (!changedFiles.size) box.innerHTML = '<div class="cf">这次对话还没改过文件，管家改了会自动记在这儿。</div>';
    [...changedFiles].forEach((p) => {
      const it = el('cf', '<span class="ico">◆</span>' + esc(p.split('/').pop()));
      it.title = p; it.onclick = () => showFile(p);
      box.appendChild(it);
    });
    pvBody.innerHTML = ''; pvBody.appendChild(box); previewEl.classList.add('show');
  }
  async function showFile(path) {
    pvTitle.textContent = path.split('/').pop();
    pvBody.innerHTML = '<pre>正在读取文件…</pre>';
    try {
      const data = await (await fetch('/api/v1/agent/fs/read?path=' + encodeURIComponent(path))).json();
      const pre = document.createElement('pre'); pre.textContent = data.content != null ? data.content : (data.error || '没读到这个文件，确认它还在原位后重试。');
      pvBody.innerHTML = ''; pvBody.appendChild(pre);
    } catch { pvBody.innerHTML = '<pre>没读到这个文件，确认它还在原位后重试。</pre>'; }
    previewEl.classList.add('show');
  }
  changesBtn.addEventListener('click', showChanges);
  pvClose.addEventListener('click', () => previewEl.classList.remove('show'));

  // 后台任务入口(§9)
  const tasksBtn = $('tasks-btn');
  const TASK_STATUS = { queued: '排队中，等空闲就开跑', running: '正在跑', completed: '已完成', failed: '没跑成', interrupted: '已中断' };
  async function showTasks() {
    pvTitle.textContent = '后台任务';
    pvBody.innerHTML = '<div class="changed"><div class="cf">正在读取后台任务…</div></div>';
    try {
      const data = await (await fetch('/tasks?conversationId=' + encodeURIComponent(conversationId) + '&limit=50')).json();
      const list = data.tasks || [];
      const box = document.createElement('div'); box.className = 'changed';
      if (!list.length) box.innerHTML = '<div class="cf">还没有后台任务。把耗时的活交给管家，它会在后台慢慢跑，完成了主动告诉你，你先去忙别的就行。</div>';
      list.forEach((t) => {
        const it = el('cf', '<span class="ico">▣</span>' + esc(t.title || t.id) + ' · ' + esc(TASK_STATUS[t.status] || t.status));
        box.appendChild(it);
      });
      pvBody.innerHTML = ''; pvBody.appendChild(box);
    } catch { pvBody.innerHTML = '<div class="changed"><div class="cf">没读到后台任务，检查后重试。</div></div>'; }
    previewEl.classList.add('show');
  }
  tasksBtn.addEventListener('click', showTasks);

  async function pickWorkspace() {
    let dir = null;
    if (host && typeof host.pickWorkspace === 'function') dir = await host.pickWorkspace(); // Electron 原生文件夹选择器
    else dir = window.prompt('输入工作区文件夹的完整路径：', workspaceRoot || ''); // 浏览器兜底
    if (!dir) return;
    workspaceRoot = dir;
    wsPathEl.textContent = dir; wsPathEl.title = dir;
    loadTree(dir);
  }
  async function loadTree(path) {
    try {
      const data = await (await fetch('/api/v1/agent/fs/list?path=' + encodeURIComponent(path))).json();
      renderTree(wsTreeEl, path, data.entries || [], 0);
    } catch { wsTreeEl.innerHTML = ''; }
  }
  function renderTree(container, base, entries, depth) {
    if (depth === 0) container.innerHTML = '';
    entries.forEach((e) => {
      const node = el('node' + (e.isDir ? ' dir' : ''));
      node.style.paddingLeft = (depth * 12 + 4) + 'px';
      node.innerHTML = '<span class="ico">' + (e.isDir ? '▸' : '·') + '</span>' + esc(e.name);
      const full = base.replace(/\/$/, '') + '/' + e.name;
      if (e.isDir) {
        let expanded = false;
        node.onclick = async () => {
          if (expanded) { let n = node.nextSibling; while (n && Number(n.style.paddingLeft.replace('px','')) > depth * 12 + 4) { const del = n; n = n.nextSibling; del.remove(); } expanded = false; node.querySelector('.ico').textContent = '▸'; return; }
          try {
            const data = await (await fetch('/api/v1/agent/fs/list?path=' + encodeURIComponent(full))).json();
            const frag = document.createElement('div');
            renderTree(frag, full, data.entries || [], depth + 1);
            while (frag.firstChild) node.parentNode.insertBefore(frag.firstChild, node.nextSibling);
            expanded = true; node.querySelector('.ico').textContent = '▾';
          } catch {}
        };
      }
      container.appendChild(node);
    });
  }

  async function loadExperts() {
    try {
      const data = await (await fetch('/api/v1/agent/packs')).json();
      (data.packs || []).forEach((p) => {
        if (!p || !p.id) return;
        const o = document.createElement('option'); o.value = p.id; o.textContent = p.name || p.id;
        if (p.description) o.title = p.description;
        expertSel.appendChild(o);
      });
    } catch { /* 无领域包 → 只有通用助手 */ }
  }
  const newId = () => 'desk-' + Math.random().toString(36).slice(2, 10);
  let conversationId = newId();
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws = null;
  let running = false;
  let assistantEl = null; // 当前 assistant 文本累积节点(.text 容器,内含 .av 值节点)
  let cursorEl = null;    // 流式尾光标(cc AssistantMessage:isStreaming 竖条)
  let pendingDelta = '';  // content_delta 攒批(50ms 节流 flush)
  let flushTimer = null;
  let thinkEl = null;     // 当前思考折叠块(<details class=think>)
  let thinkBody = null;
  let sawStreaming = false; // 本轮是否已收到流式增量(text/thinking 任一)→ 去重步末合并事件
  let streamChars = 0;    // 本轮累计流式字符(估 token = ÷4)
  let runTimer = null, runStart = 0, runVerb = ''; // 运行指示 pill 计时态
  let defaultPermissionMode = 'default'; // 从 /api/settings 读的默认权限档

  async function loadSettings() {
    try {
      const data = await (await fetch('/api/settings')).json();
      if (data.settings && data.settings.defaultPermissionMode) defaultPermissionMode = data.settings.defaultPermissionMode;
    } catch { /* 设置未就绪 → 用默认档 */ }
  }

  function setStatus(online, text) {
    statusEl.className = 'status' + (online ? ' online' : '');
    statusEl.innerHTML = '<span class="dot"></span>' + text;
  }
  // —— 智能滚动跟随 + 回到最新(cc MessageList:isNearBottom 48px 才自动跟随;上滚即停、浮出药丸)——
  const SCROLL_FOLLOW_PX = 48;
  let shouldAutoScroll = true;   // 用户在底部才自动跟随;上滚即停
  let progScroll = false;        // 正在程序化置底
  let ignoreScrollUntil = 0;     // 程序化置底后 ~250ms 忽略窗(防按钮闪)
  let progScrollTop = null;      // 程序化置底目标 scrollTop(区分用户上滚)
  function isNearBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= SCROLL_FOLLOW_PX; }
  function setJump(show) { if (jumpBtn) jumpBtn.classList.toggle('show', !!show); }
  function scrollToBottom() {
    shouldAutoScroll = true; progScroll = true;
    ignoreScrollUntil = performance.now() + 250;
    thread.scrollTop = thread.scrollHeight; progScrollTop = thread.scrollTop;
    setJump(false);
    requestAnimationFrame(() => {
      if (shouldAutoScroll) { thread.scrollTop = thread.scrollHeight; progScrollTop = thread.scrollTop; }
      progScroll = false;
    });
  }
  function scrollDown() { if (shouldAutoScroll) scrollToBottom(); } // 跟随态才贴底(替代旧的无脑置底)
  thread.addEventListener('scroll', () => {
    const matchesProg = progScrollTop !== null && Math.abs(thread.scrollTop - progScrollTop) < 1;
    if (matchesProg && (progScroll || performance.now() < ignoreScrollUntil)) return; // 忽略自己的程序化置底
    const atBottom = isNearBottom();
    shouldAutoScroll = atBottom; setJump(!atBottom);
  }, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    let lastH = null;
    new ResizeObserver((entries) => { // 流式增长:观察 .wrap 高度,跟随态贴底
      const h = entries[0] && entries[0].contentRect ? entries[0].contentRect.height : null;
      if (typeof h === 'number' && isFinite(h)) { if (lastH !== null && Math.abs(h - lastH) < 2) return; lastH = h; }
      if (shouldAutoScroll) scrollToBottom();
    }).observe(wrap);
  }
  if (jumpBtn) jumpBtn.onclick = () => scrollToBottom();
  function el(cls, html) { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  // ============ 助手回复富文本渲染(机制照抄 cc-haha markdown/CodeViewer,颜色/文案照抄 WorkBuddy)============
  // cc 用 marked+DOMPurify+shiki;这里不加依赖,用极简白名单渲染器复刻:①先整体转义(XSS 根治)②代码块抽成卡片(内容走 textContent)
  // ③行内只注入自控白名单标签(strong/em/code/a/del)。流式期间保持纯文本,收尾(settle/final)再规整成 markdown(对齐 cc「未完成 markdown 先按纯文本」)。
  function escAttr(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // URL 白名单:只放行 http(s)/mailto/tel + 相对路径;其它显式协议(javascript:/data:/vbscript: 等)一律拦成 #(防脚本注入)。
  function sanitizeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '#';
    if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.\-]*:/i.test(s)) return '#';   // 有 scheme 但不在白名单 → 拦
    return s;                                            // 无 scheme 的相对路径 → 放行
  }
  // 行内渲染:粗体/斜体/删除线/行内代码/链接。返回 XSS 安全的 HTML 串(所有文本经 esc,只注入自控标签)。
  function renderInline(text) {
    const S = '';                                 // 私有区哨兵,占位抽出的 code/link
    let t = String(text == null ? '' : text).replace(//g, ''); // 先剔除真身里的哨兵,防串扰
    const codes = [], links = [];
    t = t.replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return S + 'C' + (codes.length - 1) + S; }); // 行内代码优先(内容按字面)
    t = t.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g, (m, label, url) => { links.push({ label: label, url: url }); return S + 'L' + (links.length - 1) + S; });
    t = esc(t);                                          // 关键:此后正文全部已转义,任何 <script> 已成实体
    t = t.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?![\w])/g, '$1<em>$2</em>');
    t = t.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
    t = t.replace(/\n/g, '<br>');                        // gfm breaks:软换行成 <br>
    t = t.replace(new RegExp(S + 'L(\\d+)' + S, 'g'), (m, i) => { const L = links[+i]; const u = sanitizeUrl(L.url); return '<a href="' + escAttr(u) + '" target="_blank" rel="noopener noreferrer">' + esc(L.label || u) + '</a>'; });
    t = t.replace(new RegExp(S + 'C(\\d+)' + S, 'g'), (m, i) => '<code class="md-ic">' + esc(codes[+i]) + '</code>');
    return t;
  }
  // 代码卡片(照抄 cc CodeViewer:顶部条=语言标签[+文件名]+行数 / 右侧复制按钮;等宽字体 + overflow-x 横向滚动)。代码内容走 textContent,天然免疫 XSS。
  function makeCodeCard(code, lang, filename) {
    const card = el('code-card');
    const head = el('cc-head');
    const meta = el('cc-meta');
    const langEl = document.createElement('span'); langEl.className = 'cc-lang'; langEl.textContent = lang || '代码'; meta.appendChild(langEl);
    if (filename) { const fn = document.createElement('span'); fn.className = 'cc-file'; fn.textContent = filename; meta.appendChild(fn); }
    const nLines = code.length ? code.split('\n').length : 0;
    const lc = document.createElement('span'); lc.className = 'cc-lines'; lc.textContent = nLines + ' 行'; meta.appendChild(lc);
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'cc-copy'; btn.textContent = '复制';
    btn.addEventListener('click', () => copyText(code, btn));
    head.appendChild(meta); head.appendChild(btn);
    const pre = document.createElement('pre'); pre.className = 'cc-body';
    const codeEl = document.createElement('code'); codeEl.textContent = code; pre.appendChild(codeEl);
    card.appendChild(head); card.appendChild(pre);
    return card;
  }
  // 块级解析:围栏代码块→卡片,标题/水平线/引用/有序无序列表/段落。返回 DOM 节点数组。
  function mdRender(src) {
    const nodes = [];
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const fenceRe = /^(\s*)(`{3,}|~{3,})[ \t]*([^\n]*)$/;
    const headingRe = /^(#{1,6})\s+(.*)$/;
    const hrRe = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
    const ulRe = /^(\s*)[-*+]\s+(.*)$/;
    const olRe = /^(\s*)(\d+)[.)]\s+(.*)$/;
    const quoteRe = /^\s{0,3}>\s?(.*)$/;
    const isBlockStart = (l) => fenceRe.test(l) || headingRe.test(l) || hrRe.test(l) || ulRe.test(l) || olRe.test(l) || quoteRe.test(l);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = fenceRe.exec(line);
      if (fence) {                                        // 围栏代码块(未闭合到 EOF 也照收,不崩)
        const info = fence[3].trim(); let lang = '', filename = '';
        if (info) {
          const colon = info.match(/^([\w+.\-]+):(\S+)/);
          if (colon) { lang = colon[1]; filename = colon[2]; }
          else { const toks = info.split(/\s+/); lang = toks[0] || ''; const tm = info.match(/title\s*=\s*"([^"]+)"|title\s*=\s*(\S+)/i); if (tm) filename = tm[1] || tm[2] || ''; else if (toks[1] && /\./.test(toks[1])) filename = toks[1]; }
        }
        const closeRe = new RegExp('^\\s*' + fence[2][0] + '{' + fence[2].length + ',}\\s*$');
        const buf = []; i++;
        while (i < lines.length) { if (closeRe.test(lines[i])) { i++; break; } buf.push(lines[i]); i++; }
        nodes.push(makeCodeCard(buf.join('\n'), lang, filename)); continue;
      }
      const h = headingRe.exec(line);
      if (h) { const lvl = h[1].length; const node = document.createElement('h' + lvl); node.className = 'md-h md-h' + lvl; node.innerHTML = renderInline(h[2].trim()); nodes.push(node); i++; continue; }
      if (hrRe.test(line)) { const hr = document.createElement('hr'); hr.className = 'md-hr'; nodes.push(hr); i++; continue; }
      if (quoteRe.test(line)) { const buf = []; while (i < lines.length && quoteRe.test(lines[i])) { buf.push(quoteRe.exec(lines[i])[1]); i++; } const bq = document.createElement('blockquote'); bq.className = 'md-quote'; bq.innerHTML = renderInline(buf.join('\n')); nodes.push(bq); continue; }
      if (ulRe.test(line)) { const ul = document.createElement('ul'); ul.className = 'md-ul'; while (i < lines.length && ulRe.test(lines[i])) { const li = document.createElement('li'); li.innerHTML = renderInline(ulRe.exec(lines[i])[2]); ul.appendChild(li); i++; } nodes.push(ul); continue; }
      if (olRe.test(line)) { const ol = document.createElement('ol'); ol.className = 'md-ol'; const first = olRe.exec(line); if (first && first[2] !== '1') ol.setAttribute('start', first[2]); while (i < lines.length && olRe.test(lines[i])) { const li = document.createElement('li'); li.innerHTML = renderInline(olRe.exec(lines[i])[3]); ol.appendChild(li); i++; } nodes.push(ol); continue; }
      const buf = [];
      while (i < lines.length) { const l = lines[i]; if (!l.trim() || isBlockStart(l)) break; buf.push(l); i++; }
      if (buf.length) { const p = document.createElement('p'); p.className = 'md-p'; p.innerHTML = renderInline(buf.join('\n')); nodes.push(p); }
    }
    return nodes;
  }
  // 把累积的原始 markdown 渲进气泡容器(替换纯文本 .av)。空/无解析结果时回退纯文本,绝不留空。
  function renderMarkdownInto(container, raw) {
    if (!container) return;
    const nodes = mdRender(raw);
    container.innerHTML = '';
    container.classList.add('md');
    if (!nodes.length) { container.textContent = String(raw == null ? '' : raw); return; }
    nodes.forEach((n) => container.appendChild(n));
  }
  // —— 复制 + 轻提示 toast(WorkBuddy 中性,去 Claude 字样)——
  function fallbackCopy(text) {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '-1000px'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok; } catch { return false; }
  }
  async function copyText(text, btn) {
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; } else ok = fallbackCopy(text); } catch { ok = fallbackCopy(text); }
    toast(ok ? '已复制' : '复制失败，请手动选择复制');
    if (ok && btn) { const o = btn.textContent; btn.textContent = '已复制'; btn.classList.add('done'); setTimeout(() => { btn.textContent = o; btn.classList.remove('done'); }, 1500); }
  }
  let toastTimer = null;
  function toast(msg) {
    let t = document.getElementById('wb-toast');
    if (!t) { t = document.createElement('div'); t.id = 'wb-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  function hideEmpty() { if (emptyEl) emptyEl.style.display = 'none'; }

  // 文件改动 → 彩色 diff 面板
  function diffLineEl(cls, text) { const s = document.createElement('span'); s.className = 'ln' + (cls ? ' ' + cls : ''); s.textContent = text; return s; }
  function renderUnifiedPatch(box, patch) {
    String(patch).split('\n').forEach((line) => {
      let cls = '';
      if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('+')) cls = 'add';
      else if (line.startsWith('-')) cls = 'del';
      box.appendChild(diffLineEl(cls, line || ' '));
    });
  }
  function diffFromArgs(label, a) {
    if (!/edit_file|patch_file|patch_files|multi_edit|write_file/.test(String(label))) return null;
    const box = document.createElement('div'); box.className = 'diff';
    if (typeof a.patch === 'string') { renderUnifiedPatch(box, a.patch); return box; }
    if (Array.isArray(a.patches)) {
      a.patches.forEach((p) => { if (p && typeof p.patch === 'string') { box.appendChild(diffLineEl('hunk', '── ' + (p.path || ''))); renderUnifiedPatch(box, p.patch); } });
      return box.children.length ? box : null;
    }
    if (Array.isArray(a.edits)) {
      a.edits.forEach((e) => { if (e) { if (e.old_string) box.appendChild(diffLineEl('del', '- ' + e.old_string)); if (e.new_string) box.appendChild(diffLineEl('add', '+ ' + e.new_string)); } });
      return box.children.length ? box : null;
    }
    if (typeof a.content === 'string') { a.content.split('\n').slice(0, 200).forEach((l) => box.appendChild(diffLineEl('add', '+ ' + l))); return box; }
    return null;
  }

  function addUser(text) {
    hideEmpty();
    const m = el('msg user'); m.appendChild(el('bubble', esc(text)));
    wrap.appendChild(m); scrollToBottom(); // 发新用户消息强制回底(cc:user_text → scrollToBottom)
  }
  function ensureAssistant() {
    if (!assistantEl) {
      const m = el('msg assistant'); assistantEl = el('text'); assistantEl._raw = ''; assistantEl._val = el('av'); assistantEl.appendChild(assistantEl._val);
      m.appendChild(assistantEl); wrap.appendChild(m);
    }
    return assistantEl;
  }
  // —— 流式尾光标 + 50ms 节流(cc AssistantMessage 尾光标 + chatStore content_delta 节流)——
  // 流式期间 _val 只放纯文本(_raw 累积原始 markdown);收尾时(settle/final)才用 _raw 规整成富文本,稳定不闪(对齐 cc「未完成 markdown 先按纯文本」)。
  function showCursor(a) { if (!cursorEl) cursorEl = el('wb-cursor'); if (cursorEl.parentNode !== a) a.appendChild(cursorEl); }
  function removeCursor() { if (cursorEl) { try { cursorEl.remove(); } catch {} cursorEl = null; } }
  function assistantAppend(text) { const a = ensureAssistant(); a._raw += text; if (a._val) a._val.textContent = a._raw; showCursor(a); }
  function assistantSet(text) { const a = ensureAssistant(); a._raw = String(text == null ? '' : text); if (a._val) a._val.textContent = a._raw; }
  function flushDelta() { // 立即把攒批 flush 进气泡
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pendingDelta) { const t = pendingDelta; pendingDelta = ''; assistantAppend(t); scrollDown(); }
  }
  function queueDelta(text) { // content_delta 攒进 pendingDelta,每 50ms flush 一次
    pendingDelta += text;
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; const t = pendingDelta; pendingDelta = ''; if (t) { assistantAppend(t); scrollDown(); } }, 50);
  }
  function settleAssistant() { // 文本气泡落定成独立块:先落攒批、去光标,再把 _raw 规整成 markdown 富文本
    flushDelta(); removeCursor();
    if (assistantEl) renderMarkdownInto(assistantEl, assistantEl._raw || '');
    assistantEl = null;
  }
  // —— 思考折叠块(cc ThinkingBlock:思考中+动画点 / 已思考;同轮多段累进同一块)——
  function ensureThink() {
    if (!thinkEl) {
      thinkEl = document.createElement('details'); thinkEl.className = 'think active';
      thinkEl.innerHTML = '<summary><span class="caret"></span><span class="label">思考中</span><span class="dots"></span></summary>';
      thinkBody = el('think-body'); thinkEl.appendChild(thinkBody);
      wrap.appendChild(thinkEl);
    }
    return thinkEl;
  }
  function appendThink(text) {
    ensureThink(); thinkBody.textContent += text;
    if (thinkEl.open) thinkBody.scrollTop = thinkBody.scrollHeight; // 展开+活跃时贴底
    scrollDown();
  }
  function finalizeThink() { // 本段思考收尾:切"已思考"、停动画
    if (thinkEl) {
      thinkEl.classList.remove('active');
      const lb = thinkEl.querySelector('.label'); if (lb) lb.textContent = '已思考';
      thinkEl = null; thinkBody = null;
    }
  }
  // —— 运行指示 pill(cc StreamingIndicator:闪烁✦ + 动词 + 计时 + token 估算)——
  function fmtElapsed(s) { if (s < 60) return s + 's'; return Math.floor(s / 60) + 'm ' + (s % 60) + 's'; }
  function fmtTokens(n) { return n < 1000 ? String(n) : (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'; }
  function renderRun() {
    if (!runIndicator) return;
    const secs = Math.max(0, Math.floor((performance.now() - runStart) / 1000));
    const tok = Math.round(streamChars / 4);
    let h = '<span class="spark">✦</span><span class="verb">' + esc(runVerb) + '</span>';
    if (secs > 0) h += '<span class="meta">' + fmtElapsed(secs) + '</span>';
    if (tok > 0) h += '<span class="meta">· ↓ ' + fmtTokens(tok) + ' tokens</span>';
    runIndicator.innerHTML = h;
  }
  function showRun(verb) {
    runVerb = verb; if (!runIndicator) return;
    runIndicator.classList.add('show');
    if (!runTimer) { runStart = performance.now(); runTimer = setInterval(renderRun, 1000); }
    renderRun();
  }
  function setRunVerb(verb) { if (runIndicator && runIndicator.classList.contains('show') && runVerb !== verb) { runVerb = verb; renderRun(); } }
  function hideRun() { if (runTimer) { clearInterval(runTimer); runTimer = null; } if (runIndicator) runIndicator.classList.remove('show'); }

  function renderEvent(ev) {
    switch (ev.type) {
      case 'content_delta':
        // token 级流式:正文攒批 50ms flush(尾光标);推理增量实时进思考折叠块(思考中)。
        if (ev.channel === 'text' && ev.text) {
          finalizeThink();                 // 正文开始 → 本段思考收尾切"已思考"
          sawStreaming = true;
          streamChars += ev.text.length; setRunVerb('处理中…');
          queueDelta(ev.text);
        } else if (ev.channel === 'thinking' && ev.text) {
          if (assistantEl) settleAssistant(); // 思考到来先把当前文本气泡落定(一轮多气泡分块)
          sawStreaming = true;
          streamChars += ev.text.length; setRunVerb('思考中…');
          appendThink(ev.text);
        }
        break;
      case 'thinking':
        // 步末合并事件(=本步 thinking[+正文]):流式已逐字渲过则整条吞掉去重;非流式模型才落进折叠块。
        if (ev.text && ev.text.trim() && !sawStreaming) {
          if (assistantEl) settleAssistant(); setRunVerb('思考中…'); appendThink(ev.text);
        }
        break;
      case 'command_invocation':
      case 'tool_call': {
        settleAssistant();  // 一轮多气泡分块:文本气泡落定成独立块
        finalizeThink();    // 思考收尾
        setRunVerb('运行中…');
        const label = ev.tool || ev.command || '工具';
        const a = ev.args && typeof ev.args === 'object' ? ev.args : {};
        const path = a.path || (Array.isArray(a.patches) && a.patches[0] && a.patches[0].path) || '';
        const sub = clip(ev.command || path || (ev.args ? JSON.stringify(ev.args) : ''), 90);
        const d = document.createElement('details'); d.className = 'tool'; d.dataset.tool = label;
        d.innerHTML = '<summary><span class="ico">&#9679;</span><span class="name">' + esc(label) + '</span><span class="sub">' + esc(sub) + '</span></summary>';
        // 文件改动工具:直接把 patch/新内容渲成彩色 diff 面板(§6.5 铁律:文件写入 diff 展示),改动过程可见、不等最终答复
        const diff = diffFromArgs(label, a);
        if (diff) { d.appendChild(diff); d.open = true; }
        wrap.appendChild(d); scrollDown();
        break;
      }
      case 'tool_result': {
        noteFileChange(ev.output); // 文件改动记进变更列表(§9)
        // 找最近一个同工具、尚未标结果的折叠块补结果(低噪:默认折叠)
        const blocks = wrap.querySelectorAll('details.tool');
        let target = null;
        for (let i = blocks.length - 1; i >= 0; i--) { if (!blocks[i].dataset.done) { target = blocks[i]; break; } }
        const isErr = ev.output && /error|错误|失败|<tool_use_error>/i.test(ev.output);
        if (target) {
          target.dataset.done = '1';
          target.classList.add(isErr ? 'err' : 'ok');
          const ico = target.querySelector('.ico'); if (ico) ico.innerHTML = isErr ? '&#10007;' : '&#10003;';
          const pre = document.createElement('pre'); pre.textContent = ev.output || ''; target.appendChild(pre);
        }
        finalizeThink(); settleAssistant();
        scrollDown();
        break;
      }
      case 'final':
        finalizeThink();
        flushDelta();                       // 落定攒批
        if (ev.text) assistantSet(ev.text); // final 全文为权威,覆盖流式累积
        settleAssistant();                  // 收尾:去尾光标 + 把 _raw 规整成 markdown 富文本(代码卡片/标题/列表…)
        hideRun();
        scrollDown();
        break;
      case 'steering':
        wrap.appendChild(el('thinking', '↳ 插话:' + esc(ev.content))); scrollDown();
        break;
      case 'context_note':
        if (/压缩|compact/i.test(String(ev.text || ''))) setRunVerb('正在压缩上下文…');
        wrap.appendChild(el('thinking', esc(ev.text))); scrollDown();
        break;
      case 'max_turns_reached':
        wrap.appendChild(el('err-line', '管家连着跑了 ' + ev.maxTurns + ' 个回合，先停下来喘口气。想接着做的话，回一句让它继续。')); scrollDown();
        break;
      case 'approval_request':
        renderApproval(ev); scrollDown();
        break;
      default:
        break; // usage_update / tool_progress / todo_update 等本切片先不渲染
    }
  }

  function renderApproval(ev) {
    const card = el('approval');
    const r = ev.reason || {};
    // 原因/影响(§6.5:显示审批原因、影响范围)
    const reasonLines = [];
    if (r.what) reasonLines.push(r.what);
    if (r.why) reasonLines.push('原因:' + r.why);
    if (r.impact) reasonLines.push('影响:' + r.impact);
    const rememberBtn = ev.rememberable ? '<button class="approve-session">本次对话都允许</button>' : '';
    card.innerHTML = '<div class="head">需要你确认:' + esc(ev.tool) + '</div>' +
      (ev.warning ? '<div class="warn">⚠ ' + esc(ev.warning) + '</div>' : '') +
      '<div class="why">' + esc(clip(reasonLines.join('\n') || (ev.preview || JSON.stringify(ev.args || {})), 400)) + '</div>' +
      '<div class="acts"><button class="approve">允许一次</button>' + rememberBtn + '<button class="reject">拒绝</button></div>';
    // 审批卡内 diff(§6.5 铁律:文件写入 diff 展示 + 必要 diff)
    const diff = diffFromArgs(ev.tool, ev.args && typeof ev.args === 'object' ? ev.args : {});
    if (diff) card.insertBefore(diff, card.querySelector('.acts'));
    const done = (label) => { card.classList.add('done'); card.querySelector('.acts').innerHTML = '<span class="sub">' + label + '</span>'; };
    const approve = (remember) => {
      wsSend({ type: 'approve', tool: ev.tool, args: ev.args, token: ev.token, conversationId: conversationId, permissionMode: 'default', remember_approval: !!remember });
      done(remember ? '已允许（本次对话）' : '已批准，正在执行');
    };
    card.querySelector('.approve').onclick = () => approve(false);
    if (ev.rememberable) card.querySelector('.approve-session').onclick = () => approve(true);
    card.querySelector('.reject').onclick = () => {
      wsSend({ type: 'reject', tool: ev.tool, args: ev.args, conversationId: conversationId });
      done('已拒绝');
    };
    wrap.appendChild(card);
  }

  function wsSend(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  // 会话列表(接后端 /sessions)
  async function refreshSessions() {
    try {
      const data = await (await fetch('/sessions')).json();
      renderSessions(data.sessions || []);
    } catch { /* 后端未就绪时静默 */ }
  }
  function renderSessions(list) {
    if (!list.length) { sesslist.innerHTML = '<div class="empty-s">还没有对话，点上面「新对话」开个头。</div>'; return; }
    sesslist.innerHTML = '';
    list.forEach((s) => {
      const d = el('sess' + (s.id === conversationId ? ' active' : ''));
      d.innerHTML = '<div class="t">' + esc(s.title || '新对话') + '</div><div class="m">' + esc(new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</div>';
      d.onclick = () => switchSession(s.id);
      sesslist.appendChild(d);
    });
  }
  function clearThread() {
    wrap.innerHTML = '';
    assistantEl = null; thinkEl = null; thinkBody = null; sawStreaming = false;
    removeCursor(); if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; } pendingDelta = '';
    hideRun(); shouldAutoScroll = true;
    changedFiles.clear(); changesN.textContent = '0'; changesBtn.classList.remove('has'); previewEl.classList.remove('show');
    if (emptyEl) { const e = emptyEl.cloneNode(true); e.style.display = ''; wrap.appendChild(e); }
  }
  let wantReplay = false; // 切到已有会话时,ready 后请求全量事件重放回填历史
  function reconnect() { if (ws) { try { ws.onclose = null; ws.close(); } catch {} } connect(); }
  function newChat() {
    conversationId = newId(); wantReplay = false;
    running = false; sendBtn.disabled = false;
    clearThread(); reconnect(); refreshSessions();
  }
  function switchSession(id) {
    if (id === conversationId || running) return;
    conversationId = id; wantReplay = true;
    clearThread(); if (emptyEl) emptyEl.style.display = 'none';
    reconnect();
  }
  newChatBtn.addEventListener('click', newChat);
  wsPickBtn.addEventListener('click', pickWorkspace);
  // 原生"文件 → 选择工作区…"菜单动作(§8):走同一条选择器路径。
  if (host && typeof host.onMenu === 'function') {
    host.onMenu(function (action) { if (action === 'pick-workspace') pickWorkspace(); });
  }

  function connect() {
    ws = new WebSocket(wsProto + '//' + location.host + '/agent/ws?conversationId=' + encodeURIComponent(conversationId));
    ws.onopen = () => setStatus(true, '已连接');
    ws.onclose = () => { setStatus(false, '连接断开了，正在重新连上…'); running = false; sendBtn.disabled = false; setTimeout(connect, 1500); };
    ws.onerror = () => setStatus(false, '连接出了点问题，正在重试…');
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ready') {
        setStatus(true, '已连接');
        if (wantReplay) { wantReplay = false; wsSend({ type: 'replay', conversationId: conversationId, after: 0 }); }
        return;
      }
      if (msg.type === 'error') {
        running = false; sendBtn.disabled = false;
        finalizeThink(); settleAssistant(); hideRun();
        const line = el('err-line', '这次没跑成：' + esc(msg.error) + '。检查一下再点重试，或换个说法重新发。 ');
        if (lastUserMessage) {
          const retry = document.createElement('button'); retry.className = 'retry-btn'; retry.textContent = '重试';
          retry.onclick = () => { const t = lastUserMessage; input.value = t; send(); };
          line.appendChild(retry);
        }
        wrap.appendChild(line); scrollDown(); return;
      }
      if (msg.type === 'event' && msg.event) {
        renderEvent(msg.event);
        if (msg.event.type === 'final' || msg.event.type === 'done') { running = false; sendBtn.disabled = false; refreshSessions(); finalizeThink(); settleAssistant(); hideRun(); }
        return;
      }
      if (msg.type === 'approve_result') {
        wrap.appendChild(el('thinking', '这一步已完成：' + esc(clip(msg.result || '', 200))));
        scrollDown();
      }
    };
  }

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    lastUserMessage = text;
    addUser(text);
    input.value = ''; autoGrow();
    if (ws && ws.readyState === WebSocket.OPEN && running) {
      // 运行中 → 插话
      wsSend({ type: 'steer', message: text, conversationId: conversationId });
      return;
    }
    running = true; sendBtn.disabled = true;
    sawStreaming = false; streamChars = 0; showRun('处理中…'); // 起新一轮:重置计时/token,pill 亮"处理中…"
    const run = { type: 'run', message: text, permissionMode: defaultPermissionMode, conversationId: conversationId };
    if (expertSel && expertSel.value) run.enabled_packs = [expertSel.value]; // 挂载专家领域包(影响上下文/工具/系统提示)
    if (workspaceRoot) run.working_dir = workspaceRoot; // 用户选定的工作区(模型在此读写/执行)
    wsSend(run);
  }

  // ============ 斜杠命令面板(cc ChatInput slashMenu:输入 / 弹命令,过滤/↑↓/Enter/Tab/Esc;cc「斜杠命令=技能」)============
  // 契约(后端并行子代理在建):GET /api/v1/agent/commands?conversationId=&enabledPacks= → {commands:[{name,description,source,argHint?}]}
  const cmdPanel = $('cmd-panel');
  let slashOpen = false, slashFilter = '', slashPos = -1, slashIndex = 0;
  let slashCommands = null, slashCmdKey = '', slashFiltered = [], slashRows = [], slashLoading = false;
  // 后端接口未就绪时的桩数据(先按契约自测面板交互;上线后被真实返回覆盖)
  const SLASH_STUB = [
    { name: 'help', description: '看看球房管家能帮你做什么', source: 'builtin' },
    { name: 'clear', description: '清空当前对话，从头开始', source: 'builtin' },
    { name: 'compact', description: '压缩上下文，给长对话瘦身', source: 'builtin' },
    { name: 'skills', description: '浏览当前可用的技能', source: 'skill' },
    { name: '台球', description: '唤起台球运营专家帮你诊断', source: 'billiards', argHint: '<你的问题>' },
    { name: 'billiards:daily-ops', description: '台球房今日运营诊断', source: 'billiards' },
  ];
  function slashKey() { return (expertSel && expertSel.value ? expertSel.value : '') + '|' + conversationId; }
  async function loadSlashCommands() {
    const key = slashKey();
    if (slashCommands && slashCmdKey === key) return;          // 命中缓存(会话/专家没变就不重复拉)
    slashLoading = true; if (slashOpen) renderSlash();
    const packs = expertSel && expertSel.value ? expertSel.value : '';
    const url = '/api/v1/agent/commands?conversationId=' + encodeURIComponent(conversationId) + '&enabledPacks=' + encodeURIComponent(packs);
    let cmds = null;
    try { const data = await (await fetch(url)).json(); if (data && Array.isArray(data.commands)) cmds = data.commands; } catch { /* 接口未就绪 */ }
    slashCommands = cmds || SLASH_STUB;                        // 契约没就绪/拉失败 → 桩数据,面板仍可交互
    slashCmdKey = key; slashLoading = false;
    if (slashOpen) { slashFiltered = filterSlash(slashFilter); if (slashIndex >= slashFiltered.length) slashIndex = 0; renderSlash(); }
  }
  // 触发检测:光标前最近的 / 若在词首(行首或空白后)且其后无空白 → 命令 token(端口 cc findSlashTrigger)
  function findSlashTrigger(value, cursor) {
    const before = value.slice(0, cursor);
    const pos = before.lastIndexOf('/');
    if (pos < 0) return null;
    if (pos > 0 && !/\s/.test(before[pos - 1])) return null;   // 只认词首 /(行首或空白后)
    const filter = before.slice(pos + 1);
    if (filter.includes('\n') || /\s/.test(filter)) return null;
    return { pos, filter };
  }
  // 排序打分(端口 cc getSlashCommandMatchRank):名字精确>前缀>分段前缀>包含>描述>参数提示
  function slashRank(cmd, f) {
    const name = String(cmd.name || '').toLowerCase();
    const parts = name.split(/[:/._-]+/).filter(Boolean);
    if (name === f) return 0;
    if (name.startsWith(f)) return 1;
    if (parts.some((p) => p.startsWith(f))) return 2;
    if (name.includes(f)) return 3;
    if (String(cmd.description || '').toLowerCase().includes(f)) return 4;
    if (String(cmd.argHint || '').toLowerCase().includes(f)) return 5;
    return Infinity;
  }
  function filterSlash(f) {
    const list = slashCommands || [];
    const norm = String(f).toLowerCase();
    if (!norm.trim()) return list.slice();
    return list.map((cmd, i) => ({ cmd, i, r: slashRank(cmd, norm) }))
      .filter((x) => isFinite(x.r)).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.cmd);
  }
  // 来源角标 → 中文标签 + 配色档(内置=中性灰 / 技能=品牌浅染 / 台球=品牌绿+描边)
  function srcMeta(source) {
    const s = String(source || '').toLowerCase();
    if (s === 'skill' || s === 'skills' || s === '技能') return { label: '技能', cls: 'src-skill' };
    if (s.indexOf('billiard') >= 0 || s === '台球' || s === 'pack') return { label: '台球', cls: 'src-billiards' };
    if (!s || s === 'builtin' || s === 'built-in' || s === 'internal' || s === '内置') return { label: '内置', cls: 'src-builtin' };
    return { label: clip(source, 6), cls: 'src-skill' };       // 其它领域包 → 原文当角标
  }
  function detectSlash() {
    const trig = findSlashTrigger(input.value, input.selectionStart);
    if (!trig) { closeSlash(); return; }
    const changed = trig.filter !== slashFilter || !slashOpen;
    slashPos = trig.pos; slashFilter = trig.filter; slashOpen = true;
    loadSlashCommands();                                       // 懒加载 + 缓存
    slashFiltered = filterSlash(slashFilter);
    if (changed || slashIndex >= slashFiltered.length) slashIndex = 0;
    renderSlash();
  }
  function closeSlash() { if (!slashOpen && cmdPanel.hidden) return; slashOpen = false; slashRows = []; cmdPanel.hidden = true; cmdPanel.innerHTML = ''; }
  function updateActive() {
    slashRows.forEach((r, i) => r.classList.toggle('active', i === slashIndex));
    const a = slashRows[slashIndex]; if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' });
  }
  function renderSlash() {
    if (!slashOpen) { cmdPanel.hidden = true; return; }
    cmdPanel.hidden = false; cmdPanel.innerHTML = ''; slashRows = [];
    const list = el('cmd-list');
    if (slashLoading && !slashCommands) list.appendChild(el('cmd-empty', '正在加载命令…'));
    else if (!slashFiltered.length) list.appendChild(el('cmd-empty', '没有匹配的命令，换个词，或直接说你想做什么。'));
    else slashFiltered.forEach((cmd, i) => {
      const meta = srcMeta(cmd.source);
      const row = el('cmd-item' + (i === slashIndex ? ' active' : ''));
      let h = '<span class="cmd-name">/' + esc(cmd.name) + '</span>';
      if (cmd.argHint) h += '<span class="cmd-arg">' + esc(cmd.argHint) + '</span>';
      h += '<span class="cmd-desc">' + esc(cmd.description || '') + '</span>';
      h += '<span class="cmd-src ' + meta.cls + '">' + esc(meta.label) + '</span>';
      row.innerHTML = h;
      row.addEventListener('mouseenter', () => { slashIndex = i; updateActive(); });
      row.addEventListener('mousedown', (e) => e.preventDefault()); // 点击别把输入框失焦(避免选中前面板先收)
      row.addEventListener('click', () => chooseSlash(cmd));
      list.appendChild(row); slashRows.push(row);
    });
    cmdPanel.appendChild(list);
    if (slashFiltered.length) cmdPanel.appendChild(el('cmd-hint', '<kbd>↑↓</kbd> 选择　<kbd>Enter</kbd> 选中　<kbd>Tab</kbd> 补全　<kbd>Esc</kbd> 关闭　·　输入 / 唤起命令'));
  }
  // 把 /filter 替换成 /name +空格(端口 cc replaceSlashToken),光标落到命令名后
  function completeSlash(name) {
    const cursor = slashPos + 1 + slashFilter.length;
    const before = input.value.slice(0, slashPos), after = input.value.slice(cursor);
    const token = '/' + name + ' ';
    input.value = before + token + after;
    const np = before.length + token.length;
    try { input.setSelectionRange(np, np); } catch { /* 失焦时忽略 */ }
    autoGrow(); closeSlash();
  }
  function chooseSlash(cmd) {
    if (!cmd) return;
    completeSlash(cmd.name);
    if (cmd.argHint) input.focus();  // 需要参数 → 只补全,等用户补参数再发
    else send();                     // 无参命令 → 补全并直接发送(台球命令 → 走正常 wsSend run)
  }
  function tabComplete() { const cmd = slashFiltered[slashIndex]; if (cmd) { completeSlash(cmd.name); input.focus(); } }

  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  input.addEventListener('input', () => { autoGrow(); detectSlash(); });
  input.addEventListener('click', detectSlash);                // 点回已存在的 / token 也重开面板
  input.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') detectSlash(); });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;            // 中文输入法组字中不劫持按键
    if (slashOpen && slashFiltered.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashFiltered.length; updateActive(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashFiltered.length) % slashFiltered.length; updateActive(); return; }
      if (e.key === 'Enter') { e.preventDefault(); chooseSlash(slashFiltered[slashIndex]); return; }
      if (e.key === 'Tab') { e.preventDefault(); tabComplete(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    } else if (slashOpen && e.key === 'Escape') { e.preventDefault(); closeSlash(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  document.addEventListener('click', (e) => {                  // 点面板外收起
    if (!slashOpen) return;
    if (cmdPanel.contains(e.target) || e.target === input) return;
    closeSlash();
  });

  connect();
  refreshSessions();
  loadSettings();
  loadExperts();
})();
