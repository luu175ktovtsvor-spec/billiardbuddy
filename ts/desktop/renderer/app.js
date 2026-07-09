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

  const sesslist = $('sesslist');
  const newChatBtn = $('newchat');
  const expertSel = $('expert');
  const wsPathEl = $('ws-path');
  const wsPickBtn = $('ws-pick');
  const wsTreeEl = $('ws-tree');
  const host = window.desktopHost;
  let workspaceRoot = ''; // 空=后端默认工作区(sidecar cwd)
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
    if (!changedFiles.size) box.innerHTML = '<div class="cf">本会话还没有文件改动</div>';
    [...changedFiles].forEach((p) => {
      const it = el('cf', '<span class="ico">◆</span>' + esc(p.split('/').pop()));
      it.title = p; it.onclick = () => showFile(p);
      box.appendChild(it);
    });
    pvBody.innerHTML = ''; pvBody.appendChild(box); previewEl.classList.add('show');
  }
  async function showFile(path) {
    pvTitle.textContent = path.split('/').pop();
    pvBody.innerHTML = '<pre>加载中…</pre>';
    try {
      const data = await (await fetch('/api/v1/agent/fs/read?path=' + encodeURIComponent(path))).json();
      const pre = document.createElement('pre'); pre.textContent = data.content != null ? data.content : (data.error || '(读取失败)');
      pvBody.innerHTML = ''; pvBody.appendChild(pre);
    } catch { pvBody.innerHTML = '<pre>(读取失败)</pre>'; }
    previewEl.classList.add('show');
  }
  changesBtn.addEventListener('click', showChanges);
  pvClose.addEventListener('click', () => previewEl.classList.remove('show'));

  async function pickWorkspace() {
    let dir = null;
    if (host && typeof host.pickWorkspace === 'function') dir = await host.pickWorkspace(); // Electron 原生文件夹选择器
    else dir = window.prompt('输入工作区文件夹的绝对路径:', workspaceRoot || ''); // 浏览器兜底
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
  let assistantEl = null; // 当前 assistant 文本累积节点
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
  function scrollDown() { thread.scrollTop = thread.scrollHeight; }
  function el(cls, html) { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

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
    wrap.appendChild(m); scrollDown();
  }
  function ensureAssistant() {
    if (!assistantEl) {
      const m = el('msg assistant'); assistantEl = el('text', ''); m.appendChild(assistantEl);
      wrap.appendChild(m);
    }
    return assistantEl;
  }

  function renderEvent(ev) {
    switch (ev.type) {
      case 'content_delta':
        // token 级流式:正文增量打字机式追加到当前 assistant 节点(推理增量本切片先不逐字渲，靠完整 thinking 事件)。
        if (ev.channel === 'text' && ev.text) { ensureAssistant().textContent += ev.text; scrollDown(); }
        break;
      case 'thinking':
        if (ev.text && ev.text.trim()) { wrap.appendChild(el('thinking', esc(ev.text))); scrollDown(); }
        break;
      case 'command_invocation':
      case 'tool_call': {
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
        assistantEl = null;
        scrollDown();
        break;
      }
      case 'final':
        ensureAssistant().textContent = ev.text || '';
        assistantEl = null;
        scrollDown();
        break;
      case 'steering':
        wrap.appendChild(el('thinking', '↳ 插话:' + esc(ev.content))); scrollDown();
        break;
      case 'context_note':
        wrap.appendChild(el('thinking', esc(ev.text))); scrollDown();
        break;
      case 'max_turns_reached':
        wrap.appendChild(el('err-line', '已达最大回合数(' + ev.maxTurns + '),已停止。')); scrollDown();
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
    const rememberBtn = ev.rememberable ? '<button class="approve-session">本会话允许</button>' : '';
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
      done(remember ? '已允许(本会话)' : '已批准并执行');
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
    if (!list.length) { sesslist.innerHTML = '<div class="empty-s">还没有会话</div>'; return; }
    sesslist.innerHTML = '';
    list.forEach((s) => {
      const d = el('sess' + (s.id === conversationId ? ' active' : ''));
      d.innerHTML = '<div class="t">' + esc(s.title || '新会话') + '</div><div class="m">' + esc(new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</div>';
      d.onclick = () => switchSession(s.id);
      sesslist.appendChild(d);
    });
  }
  function clearThread() {
    wrap.innerHTML = '';
    assistantEl = null;
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

  function connect() {
    ws = new WebSocket(wsProto + '//' + location.host + '/agent/ws?conversationId=' + encodeURIComponent(conversationId));
    ws.onopen = () => setStatus(true, '已连接');
    ws.onclose = () => { setStatus(false, '已断开,重连中…'); running = false; sendBtn.disabled = false; setTimeout(connect, 1500); };
    ws.onerror = () => setStatus(false, '连接错误');
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ready') {
        setStatus(true, '已连接');
        if (wantReplay) { wantReplay = false; wsSend({ type: 'replay', conversationId: conversationId, after: 0 }); }
        return;
      }
      if (msg.type === 'error') { wrap.appendChild(el('err-line', '错误:' + esc(msg.error))); scrollDown(); return; }
      if (msg.type === 'event' && msg.event) {
        renderEvent(msg.event);
        if (msg.event.type === 'final' || msg.event.type === 'done') { running = false; sendBtn.disabled = false; refreshSessions(); }
        return;
      }
      if (msg.type === 'approve_result') {
        wrap.appendChild(el('thinking', '工具已执行:' + esc(clip(msg.result || '', 200))));
        scrollDown();
      }
    };
  }

  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    addUser(text);
    input.value = ''; autoGrow();
    if (ws && ws.readyState === WebSocket.OPEN && running) {
      // 运行中 → 插话
      wsSend({ type: 'steer', message: text, conversationId: conversationId });
      return;
    }
    running = true; sendBtn.disabled = true;
    const run = { type: 'run', message: text, permissionMode: defaultPermissionMode, conversationId: conversationId };
    if (expertSel && expertSel.value) run.enabled_packs = [expertSel.value]; // 挂载专家领域包(影响上下文/工具/系统提示)
    if (workspaceRoot) run.working_dir = workspaceRoot; // 用户选定的工作区(模型在此读写/执行)
    wsSend(run);
  }

  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', send);

  connect();
  refreshSessions();
  loadSettings();
  loadExperts();
})();
