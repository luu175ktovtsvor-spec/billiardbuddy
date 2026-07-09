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
  const newId = () => 'desk-' + Math.random().toString(36).slice(2, 10);
  let conversationId = newId();
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws = null;
  let running = false;
  let assistantEl = null; // 当前 assistant 文本累积节点

  function setStatus(online, text) {
    statusEl.className = 'status' + (online ? ' online' : '');
    statusEl.innerHTML = '<span class="dot"></span>' + text;
  }
  function scrollDown() { thread.scrollTop = thread.scrollHeight; }
  function el(cls, html) { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  function hideEmpty() { if (emptyEl) emptyEl.style.display = 'none'; }

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
      case 'thinking':
        if (ev.text && ev.text.trim()) { wrap.appendChild(el('thinking', esc(ev.text))); scrollDown(); }
        break;
      case 'command_invocation':
      case 'tool_call': {
        const label = ev.tool || ev.command || '工具';
        const sub = clip(ev.command || (ev.args ? JSON.stringify(ev.args) : ''), 90);
        const d = document.createElement('details'); d.className = 'tool'; d.dataset.tool = label;
        d.innerHTML = '<summary><span class="ico">&#9679;</span><span class="name">' + esc(label) + '</span><span class="sub">' + esc(sub) + '</span></summary>';
        wrap.appendChild(d); scrollDown();
        break;
      }
      case 'tool_result': {
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
    const why = ev.reason ? (ev.reason.why || ev.reason.what || '') : '';
    card.innerHTML = '<div class="head">需要你确认:' + esc(ev.tool) + '</div>' +
      '<div class="why">' + esc(clip((why ? why + '\n' : '') + (ev.preview || JSON.stringify(ev.args || {})), 400)) + '</div>' +
      '<div class="acts"><button class="approve">批准并执行</button><button class="reject">拒绝</button></div>';
    const done = (label) => { card.classList.add('done'); card.querySelector('.acts').innerHTML = '<span class="sub">' + label + '</span>'; };
    card.querySelector('.approve').onclick = () => {
      wsSend({ type: 'approve', tool: ev.tool, args: ev.args, token: ev.token, conversationId: conversationId, permissionMode: 'default' });
      done('已批准并执行');
    };
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
    wsSend({ type: 'run', message: text, permissionMode: 'default', conversationId: conversationId });
  }

  function autoGrow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', send);

  connect();
  refreshSessions();
})();
