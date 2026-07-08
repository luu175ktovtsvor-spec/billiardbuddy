import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import type { AgentDefinition } from '../agents/agentLoader'
import { textBlock, toolResultBlock, toolUseBlock, userText } from '../types/message'
import type { Model } from '../types/model'
import { resolvePermission } from '../permissions/resolve'
import type { Tool } from '../tools/Tool'
import { readStoredToolResultTool } from '../tools/storedToolResultTool'
import { createContentReplacementState } from '../context/toolResultStorage'
import { Workspace } from '../workspace/workspace'
import { TaskService } from './taskService'
import { TeamService } from './teamService'
import { createTeamTools } from './teamTools'
import { resumeBackgroundAgentTask } from './taskTools'

function fixture(): {
  root: string
  teams: TeamService
  tools: ReturnType<typeof createTeamTools>
  ctx: { workspace: Workspace; conversationId: string; permissionMode: 'ask' }
} {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-'))
  return {
    root,
    teams: new TeamService(root),
    tools: createTeamTools(new TeamService(root)),
    ctx: { workspace: new Workspace(root), conversationId: 'c-team', permissionMode: 'ask' },
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

function extractPeersJson(output: string): Record<string, unknown> {
  const match = output.match(/<peers_json>\n([\s\S]*?)\n<\/peers_json>/)
  if (!match) throw new Error(`missing peers_json block: ${output}`)
  const text = match[1]!
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  return JSON.parse(text) as Record<string, unknown>
}

test('TeamCreate creates a local team and SendMessage writes a teammate inbox', async () => {
  const { root, teams, tools, ctx } = fixture()
  const [teamCreate, , sendMessage, listPeers] = tools
  try {
    const created = JSON.parse(await teamCreate!.execute({ team_name: 'alpha', description: 'coding swarm' }, ctx))
    expect(created.team_name).toBe('alpha')
    expect(created.lead_agent_id).toBe('team-lead@alpha')

    const sent = JSON.parse(await sendMessage!.execute({ to: 'researcher', summary: 'assign task', message: 'Please inspect the parser.' }, ctx))
    expect(sent.success).toBe(true)
    expect(sent.routing.target).toBe('@researcher')

    const inbox = await teams.readMailbox('researcher', 'alpha')
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      from: 'team-lead',
      text: 'Please inspect the parser.',
      summary: 'assign task',
      read: false,
    })

    const peers = await listPeers!.execute({}, ctx)
    expect(peers).toContain('<peers team="alpha"')
    expect(peers).toContain('team-lead (team-lead@alpha)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ListPeers exposes structured peer metadata and inbox previews', async () => {
  const { root, teams, tools, ctx } = fixture()
  const [teamCreate, , , listPeers] = tools
  try {
    await teamCreate!.execute({ team_name: 'peers', description: 'metadata team', agent_type: 'lead-engineer' }, ctx)
    const worktreePath = join(root, 'agent-worktree')
    await teams.mutateTeam('peers', team => {
      team.leadSessionId = 'session-lead'
      team.members.push({
        agentId: 'worker@peers',
        name: 'worker',
        agentType: 'engineer',
        color: 'cyan',
        joinedAt: 123_456,
        tmuxPaneId: '%3',
        cwd: root,
        worktreePath,
        sessionId: 'session-worker',
        subscriptions: ['reviews', 'tests'],
        backendType: 'in-process',
        isActive: true,
        mode: 'plan',
      })
    })
    await teams.writeToMailbox('worker', {
      from: 'team-lead',
      text: 'Check parser & UI <now>.',
      summary: 'check parser',
      timestamp: '2026-07-08T00:00:00.000Z',
    }, 'peers')

    const output = await listPeers!.execute({ includeInbox: true }, ctx)
    expect(output).toContain('<peers team="peers" count="2" active_team="true"')
    expect(output).toContain('lead_session_id="session-lead"')
    expect(output).toContain('<peer name="worker" agent_id="worker@peers" target="worker"')
    expect(output).toContain('backend_type="in-process"')
    expect(output).toContain(`worktree_path="${worktreePath}"`)
    expect(output).toContain('<inbox peer="worker" unread_messages="1">')
    expect(output).toContain('Check parser &amp; UI &lt;now&gt;.')

    const data = extractPeersJson(output)
    expect(data).toMatchObject({
      team_name: 'peers',
      lead_agent_id: 'team-lead@peers',
      lead_session_id: 'session-lead',
      active_team: true,
      peer_count: 2,
      send_message: {
        local_targets: ['team-lead', 'worker'],
        broadcast_target: '*',
        cross_session_targets_enabled: false,
      },
    })
    expect(data.peers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'worker',
        agent_id: 'worker@peers',
        target: 'worker',
        agent_type: 'engineer',
        backend_type: 'in-process',
        session_id: 'session-worker',
        tmux_pane_id: '%3',
        worktree_path: worktreePath,
        active: true,
        unread_messages: 1,
        mode: 'plan',
        subscriptions: ['reviews', 'tests'],
      }),
    ]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ListPeers returns a parseable empty peer set without an active team', async () => {
  const { root, tools, ctx } = fixture()
  const [, , , listPeers] = tools
  try {
    const output = await listPeers!.execute({}, ctx)
    expect(output).toContain('<peers team="" count="0" active_team="false">')
    expect(output).toContain('</peers>')
    expect(extractPeersJson(output)).toMatchObject({
      active_team: false,
      peer_count: 0,
      peers: [],
      send_message: {
        local_targets: [],
        broadcast_target: '*',
        cross_session_targets_enabled: false,
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage broadcasts to non-lead team members only', async () => {
  const { root, teams, tools, ctx } = fixture()
  const [teamCreate, , sendMessage] = tools
  try {
    await teamCreate!.execute({ team_name: 'bravo' }, ctx)
    await teams.mutateTeam('bravo', team => {
      team.members.push(
        {
          agentId: 'researcher@bravo',
          name: 'researcher',
          agentType: 'researcher',
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: root,
          subscriptions: [],
          isActive: false,
        },
        {
          agentId: 'qa@bravo',
          name: 'qa',
          agentType: 'test-runner',
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: root,
          subscriptions: [],
          isActive: false,
        },
      )
    })

    const output = JSON.parse(await sendMessage!.execute({ to: '*', summary: 'sync plan', message: 'Please sync on the migration plan.' }, ctx))
    expect(output.recipients).toEqual(['researcher', 'qa'])
    expect(await teams.readMailbox('researcher', 'bravo')).toHaveLength(1)
    expect(await teams.readMailbox('qa', 'bravo')).toHaveLength(1)
    expect(await teams.readMailbox('team-lead', 'bravo')).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TeamDelete force-confirms, refuses active members, and cleans idle teams', async () => {
  const { root, teams, tools, ctx } = fixture()
  const [teamCreate, teamDelete] = tools
  try {
    await teamCreate!.execute({ team_name: 'cleanup' }, ctx)
    await teams.mutateTeam('cleanup', team => {
      team.members.push({
        agentId: 'worker@cleanup',
        name: 'worker',
        agentType: 'engineer',
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: root,
        subscriptions: [],
        isActive: true,
      })
    })

    const decision = resolvePermission(teamDelete!, {}, ctx)
    expect(decision.behavior).toBe('ask')

    const refused = JSON.parse(await teamDelete!.execute({}, ctx))
    expect(refused.success).toBe(false)
    expect(refused.message).toContain('active member')
    expect(await teams.readTeam('cleanup')).not.toBeNull()

    await teams.mutateTeam('cleanup', team => {
      const worker = team.members.find(member => member.name === 'worker')
      if (worker) worker.isActive = false
    })
    const deleted = JSON.parse(await teamDelete!.execute({}, ctx))
    expect(deleted.success).toBe(true)
    expect(await teams.readTeam('cleanup')).toBeNull()
    expect(await teams.getActiveTeam()).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage supports CC-Haha structured shutdown and plan approval messages', async () => {
  const { root, teams, tools, ctx } = fixture()
  const [teamCreate, , sendMessage] = tools
  try {
    await teamCreate!.execute({ team_name: 'protocol' }, ctx)
    const shutdown = JSON.parse(await sendMessage!.execute({ to: 'worker', message: { type: 'shutdown_request', reason: 'done' } }, ctx))
    expect(shutdown.success).toBe(true)
    expect(shutdown.request_id).toContain('shutdown-worker')
    const workerInbox = await teams.readMailbox('worker', 'protocol')
    expect(JSON.parse(workerInbox[0]!.text)).toMatchObject({ type: 'shutdown_request', from: 'team-lead', reason: 'done' })

    const plan = JSON.parse(await sendMessage!.execute({ to: 'worker', message: { type: 'plan_approval_response', request_id: 'plan-1', approve: true } }, ctx))
    expect(plan.success).toBe(true)
    expect(plan.request_id).toBe('plan-1')
    const updatedInbox = await teams.readMailbox('worker', 'protocol')
    expect(JSON.parse(updatedInbox[1]!.text)).toMatchObject({ type: 'plan_approval_response', requestId: 'plan-1', approved: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage routes plain messages to running background agents before mailbox fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-route-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const [, , sendMessage] = createTeamTools(teams, { tasks })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-route', permissionMode: 'ask' as const }
    const task = await tasks.create({
      title: 'researcher: running',
      kind: 'background_agent',
      conversationId: 'c-route',
      workspaceRoot: root,
      params: { agent: 'researcher', task: 'initial' },
    })
    await tasks.touch(task.id, { status: 'running' })
    const inbox: string[] = []
    const detach = tasks.attachSteerInbox(task.id, inbox)

    const output = JSON.parse(await sendMessage!.execute({ to: 'researcher', summary: 'follow up', message: 'Please inspect the follow-up diff.' }, ctx))
    expect(output.success).toBe(true)
    expect(output.message).toContain('next tool round')
    expect(output.task_id).toBe(task.id)
    expect(inbox).toEqual(['Please inspect the follow-up diff.'])
    expect(await teams.readMailbox('researcher', 'default')).toHaveLength(0)
    detach()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage routes by custom background agent name and reports ambiguous agent type matches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-name-route-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const [, , sendMessage] = createTeamTools(teams, { tasks })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-name-route', permissionMode: 'ask' as const }
    const parserTask = await tasks.create({
      title: 'parser-auditor: running',
      kind: 'background_agent',
      conversationId: 'c-name-route',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'parser-auditor', task: 'parser audit' },
    })
    const uiTask = await tasks.create({
      title: 'ui-auditor: running',
      kind: 'background_agent',
      conversationId: 'c-name-route',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'ui-auditor', task: 'ui audit' },
    })
    await tasks.touch(parserTask.id, { status: 'running' })
    await tasks.touch(uiTask.id, { status: 'running' })
    const parserInbox: string[] = []
    const uiInbox: string[] = []
    const detachParser = tasks.attachSteerInbox(parserTask.id, parserInbox)
    const detachUi = tasks.attachSteerInbox(uiTask.id, uiInbox)

    const named = JSON.parse(await sendMessage!.execute({ to: 'parser-auditor', summary: 'follow parser', message: '继续检查 parser。' }, ctx))
    expect(named.success).toBe(true)
    expect(named.task_id).toBe(parserTask.id)
    expect(parserInbox).toEqual(['继续检查 parser。'])
    expect(uiInbox).toEqual([])

    const ambiguous = JSON.parse(await sendMessage!.execute({ to: 'researcher', summary: 'ambiguous followup', message: '继续检查。' }, ctx))
    expect(ambiguous.success).toBe(false)
    expect(ambiguous.ambiguous).toBe(true)
    expect(ambiguous.message).toContain('Multiple background agents match')
    expect(ambiguous.matches.map((match: { task_id: string }) => match.task_id).sort()).toEqual([parserTask.id, uiTask.id].sort())
    expect(await teams.readMailbox('researcher', 'default')).toHaveLength(0)

    detachParser()
    detachUi()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage resumes a stopped background agent before mailbox fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const model = scriptedModel([{ kind: 'final', text: '续跑完成' }])
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-resume', permissionMode: 'ask' as const }
    const previous = await tasks.create({
      title: 'researcher: old',
      kind: 'background_agent',
      conversationId: 'c-resume',
      workspaceRoot: root,
      params: { agent: 'researcher', task: '检查解析器', context: '原始上下文' },
    })
    await tasks.touch(previous.id, { status: 'completed', result: '旧结论' })
    await tasks.transcript(previous.id).save([
      userText('历史任务:先检查解析器入口。'),
      { role: 'assistant', content: [textBlock('历史结论:解析器入口已经定位。')] },
    ])

    const output = JSON.parse(await sendMessage!.execute({ to: 'researcher', summary: 'resume work', message: '继续检查测试覆盖。' }, ctx))
    expect(output.success).toBe(true)
    expect(output.resumed_from).toBe(previous.id)
    expect(output.agent_id).toBe(previous.id)
    expect(output.task_id).toBe(previous.id)
    expect(await teams.readMailbox('researcher', 'default')).toHaveLength(0)

    const resumed = await waitFor(async () => {
      const task = await tasks.get(output.task_id)
      return task?.status === 'completed' ? task : null
    })
    expect(resumed.params).toMatchObject({
      agent_id: previous.id,
      agent: 'researcher',
      task: '继续检查测试覆盖。',
      resume_source: 'SendMessage',
      previous_status: 'completed',
      replayed_messages: 2,
    })
    expect(resumed.result).toBe('续跑完成')
    const receivedText = model.received[0]!.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(receivedText).toContain('Original task:')
    expect(receivedText).toContain('检查解析器')
    expect(receivedText).toContain('历史任务:先检查解析器入口。')
    expect(receivedText).toContain('历史结论:解析器入口已经定位。')
    expect(receivedText).toContain('New message from team-lead:')
    expect(receivedText).toContain('继续检查测试覆盖。')
    const resumedTranscript = await tasks.transcript(output.task_id).load()
    const resumedTranscriptText = resumedTranscript.flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(resumedTranscriptText).toContain('历史任务:先检查解析器入口。')
    expect(resumedTranscriptText).toContain('继续检查测试覆盖。')
    const previousEvents = await tasks.loadEvents(previous.id)
    expect(previousEvents.some(record => record.event.type === 'started')).toBe(true)
    expect(previousEvents.some(record => record.event.type === 'final' && 'text' in record.event && record.event.text === '续跑完成')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage to an old background task id resumes from the latest resumed descendant', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-chain-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const model = scriptedModel([
      { kind: 'final', text: '第一次续跑完成' },
      { kind: 'final', text: '第二次续跑完成' },
    ])
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-resume-chain', permissionMode: 'ask' as const }
    const original = await tasks.create({
      title: 'researcher: chain root',
      kind: 'background_agent',
      conversationId: 'c-resume-chain',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'chain-agent', task: '初始链路任务' },
    })
    await tasks.touch(original.id, { status: 'completed', result: '初始完成' })
    await tasks.transcript(original.id).save([
      userText('历史任务:初始链路任务。'),
      { role: 'assistant', content: [textBlock('历史结论:初始完成。')] },
    ])

    const first = JSON.parse(await sendMessage!.execute({ to: original.id, summary: 'resume root', message: '第一次继续。' }, ctx))
    expect(first.success).toBe(true)
    expect(first.resumed_from).toBe(original.id)
    expect(first.agent_id).toBe(original.id)
    expect(first.task_id).toBe(original.id)
    await waitFor(async () => {
      const task = await tasks.get(first.task_id)
      return task?.status === 'completed' ? task : null
    })

    const second = JSON.parse(await sendMessage!.execute({ to: original.id, summary: 'resume latest', message: '第二次继续。' }, ctx))
    expect(second.success).toBe(true)
    expect(second.resumed_from).toBe(original.id)
    expect(second.agent_id).toBe(original.id)
    expect(second.task_id).toBe(original.id)
    await waitFor(async () => {
      const task = await tasks.get(second.task_id)
      return task?.status === 'completed' && task.result === '第二次续跑完成' ? task : null
    })
    const secondTask = await tasks.get(second.task_id)
    expect(secondTask?.params).toMatchObject({
      previous_status: 'completed',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage can address resumed background agents by stable agent id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-stable-agent-id-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const model = scriptedModel([
      { kind: 'final', text: '第一次续跑完成' },
      { kind: 'final', text: '第二次续跑完成' },
    ])
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c-stable-agent-id', permissionMode: 'ask' as const }
    const original = await tasks.create({
      id: 'stable_agent_root',
      title: 'researcher: stable root',
      kind: 'background_agent',
      conversationId: 'c-stable-agent-id',
      workspaceRoot: root,
      params: { agent_id: 'stable_agent_identity', agent: 'researcher', name: 'stable-agent', task: '初始任务' },
    })
    await tasks.writeBackgroundAgentMetadata(original.id, {
      agentId: 'stable_agent_identity',
      agent: 'researcher',
      name: 'stable-agent',
      conversationId: 'c-stable-agent-id',
      workspaceRoot: root,
      task: '初始任务',
    })
    await tasks.touch(original.id, { status: 'completed', result: '初始完成' })

    const first = JSON.parse(await sendMessage!.execute({ to: 'stable_agent_identity', summary: 'resume stable', message: '第一次继续。' }, ctx))
    expect(first.success).toBe(true)
    expect(first.resumed_from).toBe(original.id)
    expect(first.agent_id).toBe('stable_agent_identity')
    expect(first.task_id).toBe(original.id)
    await waitFor(async () => {
      const task = await tasks.get(first.task_id)
      return task?.status === 'completed' ? task : null
    })

    const second = JSON.parse(await sendMessage!.execute({ to: 'stable_agent_identity', summary: 'resume latest stable', message: '第二次继续。' }, ctx))
    expect(second.success).toBe(true)
    expect(second.resumed_from).toBe(original.id)
    expect(second.agent_id).toBe('stable_agent_identity')
    expect(second.task_id).toBe(original.id)
    const secondTask = await waitFor(async () => {
      const task = await tasks.get(second.task_id)
      return task?.status === 'completed' && task.result === '第二次续跑完成' ? task : null
    })
    expect(secondTask.params).toMatchObject({
      agent_id: 'stable_agent_identity',
      previous_status: 'completed',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage resumes stopped background agents in their original workspace root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-workspace-'))
  const oldWorkspace = mkdtempSync(join(tmpdir(), 'team-tools-old-workspace-'))
  const currentWorkspace = mkdtempSync(join(tmpdir(), 'team-tools-current-workspace-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    let seenWorkspace = ''
    const whereTool: Tool = {
      name: 'where_am_i',
      description: 'Return the active workspace root.',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_, toolCtx) {
        seenWorkspace = toolCtx.workspace.root
        return seenWorkspace
      },
    }
    let calls = 0
    const model: Model = {
      async step() {
        calls++
        if (calls === 1) {
          return { kind: 'tool_calls', text: 'check cwd', calls: [{ id: 'cwd1', name: 'where_am_i', input: {} }] }
        }
        return { kind: 'final', text: 'workspace checked' }
      },
    }
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [whereTool],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })
    const previous = await tasks.create({
      title: 'researcher: old workspace',
      kind: 'background_agent',
      conversationId: 'c-resume-workspace',
      workspaceRoot: oldWorkspace,
      params: { agent: 'researcher', task: '检查旧工作区' },
    })
    await tasks.touch(previous.id, { status: 'completed', result: '旧工作区完成' })

    const ctx = { workspace: new Workspace(currentWorkspace), conversationId: 'c-resume-workspace', permissionMode: 'ask' as const }
    const output = JSON.parse(await sendMessage!.execute({ to: 'researcher', summary: 'resume cwd', message: '继续在原目录检查。' }, ctx))
    expect(output.success).toBe(true)
    const resumed = await waitFor(async () => {
      const task = await tasks.get(output.task_id)
      return task?.status === 'completed' ? task : null
    })

    expect(seenWorkspace).toBe(new Workspace(oldWorkspace).root)
    expect(resumed.workspaceRoot).toBe(new Workspace(oldWorkspace).root)
    expect(resumed.params).toMatchObject({
      resumed_workspace_root: new Workspace(oldWorkspace).root,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(oldWorkspace, { recursive: true, force: true })
    rmSync(currentWorkspace, { recursive: true, force: true })
  }
})

test('SendMessage resumes stopped background agents from metadata sidecar when task params are incomplete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-meta-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const model = scriptedModel([{ kind: 'final', text: 'metadata 续跑完成' }])
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })
    const previous = await tasks.create({
      title: 'legacy background task',
      kind: 'background_agent',
      conversationId: 'c-resume-meta',
      workspaceRoot: root,
      params: {},
    })
    await tasks.writeBackgroundAgentMetadata(previous.id, {
      agent: 'researcher',
      name: 'parser-auditor',
      description: 'legacy background task',
      conversationId: 'c-resume-meta',
      workspaceRoot: root,
      task: '检查解析器恢复链路',
      context: 'metadata 中保留的原始上下文',
    })
    await tasks.touch(previous.id, { status: 'completed', result: '旧结论' })
    await tasks.transcript(previous.id).save([
      userText('历史任务:检查 metadata sidecar。'),
      { role: 'assistant', content: [textBlock('历史结论:sidecar 已写入。')] },
    ])

    const ctx = { workspace: new Workspace(root), conversationId: 'c-resume-meta', permissionMode: 'ask' as const }
    const output = JSON.parse(await sendMessage!.execute({ to: 'parser-auditor', summary: 'resume from metadata', message: '继续确认恢复。' }, ctx))
    expect(output.success).toBe(true)
    expect(output.resumed_from).toBe(previous.id)
    expect(await teams.readMailbox('parser-auditor', 'default')).toHaveLength(0)

    const resumed = await waitFor(async () => {
      const task = await tasks.get(output.task_id)
      return task?.status === 'completed' ? task : null
    })
    expect(resumed.params).toMatchObject({
      agent: 'researcher',
      name: 'parser-auditor',
      resume_metadata: true,
      resumed_workspace_root: new Workspace(root).root,
    })
    expect(await tasks.readBackgroundAgentMetadata(resumed.id)).toMatchObject({
      agent: 'researcher',
      name: 'parser-auditor',
      task: '继续确认恢复。',
    })
    const receivedText = model.received[0]!.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(receivedText).toContain('检查解析器恢复链路')
    expect(receivedText).toContain('metadata 中保留的原始上下文')
    expect(receivedText).toContain('历史任务:检查 metadata sidecar。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage resumes orphaned stopped background agents from metadata sidecar without a task index entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-orphan-meta-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const model = scriptedModel([{ kind: 'final', text: 'orphan metadata 续跑完成' }])
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })
    await tasks.writeBackgroundAgentMetadata('orphan_agent_1', {
      agent: 'researcher',
      name: 'orphan-parser',
      description: 'orphan parser task',
      conversationId: 'c-resume-orphan-meta',
      workspaceRoot: root,
      task: '只靠磁盘 sidecar 恢复',
      context: 'tasks.json 里没有旧任务',
    })
    await tasks.transcript('orphan_agent_1').save([
      userText('历史任务:从磁盘 sidecar 恢复。'),
      { role: 'assistant', content: [textBlock('历史结论:可以恢复。')] },
    ])

    const ctx = { workspace: new Workspace(root), conversationId: 'c-resume-orphan-meta', permissionMode: 'ask' as const }
    const output = JSON.parse(await sendMessage!.execute({ to: 'orphan-parser', summary: 'resume orphan', message: '继续恢复验证。' }, ctx))
    expect(output.success).toBe(true)
    expect(output.resumed_from).toBe('orphan_agent_1')
    expect(await teams.readMailbox('orphan-parser', 'default')).toHaveLength(0)

    const resumed = await waitFor(async () => {
      const task = await tasks.get(output.task_id)
      return task?.status === 'completed' ? task : null
    })
    expect(resumed.params).toMatchObject({
      agent: 'researcher',
      name: 'orphan-parser',
      resume_metadata: true,
      replayed_messages: 2,
    })
    const receivedText = model.received[0]!.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(receivedText).toContain('只靠磁盘 sidecar 恢复')
    expect(receivedText).toContain('tasks.json 里没有旧任务')
    expect(receivedText).toContain('历史任务:从磁盘 sidecar 恢复。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage resumes background agents with inherited stored tool result access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-stored-results-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const previous = await tasks.create({
      id: 'stored_agent_1',
      title: 'researcher: stored output',
      kind: 'background_agent',
      conversationId: 'c-resume-stored',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'stored-reader', task: '读取大结果' },
    })
    const storeDir = tasks.backgroundAgentToolResultStoreDir(previous.id)
    mkdirSync(storeDir, { recursive: true })
    const fullOutput = `HEAD\n${'x'.repeat(25_000)}\nTAIL`
    const storedPath = join(storeDir, 'run-output.txt')
    writeFileSync(storedPath, fullOutput, 'utf8')
    await tasks.writeBackgroundAgentMetadata(previous.id, {
      agent: 'researcher',
      name: 'stored-reader',
      description: 'researcher: stored output',
      conversationId: 'c-resume-stored',
      workspaceRoot: root,
      toolResultStoreDir: storeDir,
      task: '读取大结果',
    })
    await tasks.touch(previous.id, { status: 'completed', result: '旧任务完成' })
    await tasks.transcript(previous.id).save([
      userText('历史任务:跑一个大输出命令。'),
      { role: 'assistant', content: [toolUseBlock({ id: 'big1', name: 'run_command', input: { command: 'big-output' } })] },
      {
        role: 'user',
        content: [toolResultBlock('big1', [
          `<stored_tool_result tool="run_command" call_id="big1" chars="${fullOutput.length}" bytes="${Buffer.byteLength(fullOutput, 'utf8')}" path="${storedPath}">`,
          '工具结果过长,已写入 path;模型上下文仅保留头尾预览。',
          '<preview_head chars="5">',
          'HEAD',
          '</preview_head>',
          '<preview_tail chars="5">',
          'TAIL',
          '</preview_tail>',
          '</stored_tool_result>',
        ].join('\n'))],
      },
    ])

    let calls = 0
    let secondStepText = ''
    const model: Model = {
      async step(input) {
        calls++
        const text = input.messages.flatMap(message => message.content)
          .map(block => block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : '')
          .join('\n')
        if (calls === 1) {
          const path = text.match(/path="([^"]+)"/)?.[1]
          return { kind: 'tool_calls', calls: [{ id: 'read-stored-1', name: 'read_stored_tool_result', input: { path, tail: true, max_bytes: 16 } }] }
        }
        secondStepText = text
        return { kind: 'final', text: 'stored result recovered' }
      },
    }
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [readStoredToolResultTool],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })

    const ctx = { workspace: new Workspace(root), conversationId: 'c-resume-stored', permissionMode: 'ask' as const }
    const output = JSON.parse(await sendMessage!.execute({ to: 'stored-reader', summary: 'resume stored', message: '读取旧的大结果尾部。' }, ctx))
    expect(output.success).toBe(true)
    const resumed = await waitFor(async () => {
      const task = await tasks.get(output.task_id)
      return task?.status === 'completed' ? task : null
    })

    expect(resumed.params).toMatchObject({
      tool_result_store_dir: storeDir,
      replayed_messages: 3,
    })
    expect(await tasks.readBackgroundAgentMetadata(resumed.id)).toMatchObject({
      toolResultStoreDir: storeDir,
    })
    expect(secondStepText).toContain('<stored_tool_result_read status="completed"')
    expect(secondStepText).toContain('TAIL')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage resume inherits content replacement records before replaying transcript', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-replacements-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const previous = await tasks.create({
      id: 'replacement_agent_1',
      title: 'researcher: replacement output',
      kind: 'background_agent',
      conversationId: 'c-resume-replacements',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'replacement-reader', task: '继承 replacement' },
    })
    const rawOutput = `RAW_HEAD\n${'raw-large-result'.repeat(18_000)}\nRAW_TAIL`
    const replacement = [
      '<stored_tool_result tool="run_command" call_id="big-replay" chars="250000" bytes="250000" path="/tmp/replayed.txt">',
      '工具结果过长,已写入 path;模型上下文仅保留头尾预览。',
      '<preview_head chars="8">',
      'HEAD-OK',
      '</preview_head>',
      '<preview_tail chars="8">',
      'TAIL-OK',
      '</preview_tail>',
      '</stored_tool_result>',
    ].join('\n')
    await tasks.touch(previous.id, { status: 'completed', result: '旧任务完成' })
    await tasks.transcript(previous.id).save([
      userText('历史任务:产生一个会被 replacement 的大结果。'),
      { role: 'assistant', content: [toolUseBlock({ id: 'big-replay', name: 'run_command', input: { command: 'huge-output' } })] },
      { role: 'user', content: [toolResultBlock('big-replay', rawOutput)] },
    ])
    await tasks.transcript(previous.id).appendContentReplacementRecords([
      { kind: 'tool-result', toolUseId: 'big-replay', replacement },
    ])

    let firstStepText = ''
    const model: Model = {
      async step(input) {
        firstStepText = input.messages.flatMap(message => message.content)
          .map(block => block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : '')
          .join('\n')
        return { kind: 'final', text: 'replacement inherited' }
      },
    }
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })

    const ctx = { workspace: new Workspace(root), conversationId: 'c-resume-replacements', permissionMode: 'ask' as const }
    const output = JSON.parse(await sendMessage!.execute({ to: 'replacement-reader', summary: 'resume replacements', message: '继续。' }, ctx))
    expect(output.success).toBe(true)
    const resumed = await waitFor(async () => {
      const task = await tasks.get(output.task_id)
      return task?.status === 'completed' ? task : null
    })

    expect(resumed.result).toBe('replacement inherited')
    expect(firstStepText).toContain('<stored_tool_result tool="run_command"')
    expect(firstStepText).toContain('HEAD-OK')
    expect(firstStepText).not.toContain('raw-large-result')
    const inheritedRecords = await tasks.transcript(output.task_id).loadContentReplacementRecords()
    expect(inheritedRecords).toEqual([{ kind: 'tool-result', toolUseId: 'big-replay', replacement }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('SendMessage resume gap-fills parent content replacement state when sidecar records are missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'team-tools-resume-parent-replacements-'))
  try {
    const teams = new TeamService(root)
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const previous = await tasks.create({
      id: 'replacement_gap_agent_1',
      title: 'researcher: parent replacement output',
      kind: 'background_agent',
      conversationId: 'c-resume-parent-replacements',
      workspaceRoot: root,
      params: { agent: 'researcher', name: 'replacement-gap-reader', task: '继承父 replacement' },
    })
    const rawOutput = `RAW_HEAD\n${'parent-live-large-result'.repeat(18_000)}\nRAW_TAIL`
    const replacement = [
      '<stored_tool_result tool="run_command" call_id="parent-big-replay" chars="250000" bytes="250000" path="/tmp/parent-replayed.txt">',
      '工具结果过长,已写入 path;模型上下文仅保留头尾预览。',
      '<preview_head chars="14">',
      'PARENT-HEAD-OK',
      '</preview_head>',
      '<preview_tail chars="14">',
      'PARENT-TAIL-OK',
      '</preview_tail>',
      '</stored_tool_result>',
    ].join('\n')
    await tasks.touch(previous.id, { status: 'completed', result: '旧任务完成' })
    await tasks.transcript(previous.id).save([
      userText('历史任务:父会话已经替换过这个大结果,但旧 sidechain 没有落 records。'),
      { role: 'assistant', content: [toolUseBlock({ id: 'parent-big-replay', name: 'run_command', input: { command: 'huge-output' } })] },
      { role: 'user', content: [toolResultBlock('parent-big-replay', rawOutput)] },
    ])

    const parentReplacementState = createContentReplacementState()
    parentReplacementState.seenIds.add('parent-big-replay')
    parentReplacementState.replacements.set('parent-big-replay', replacement)

    let firstStepText = ''
    const model: Model = {
      async step(input) {
        firstStepText = input.messages.flatMap(message => message.content)
          .map(block => block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : '')
          .join('\n')
        return { kind: 'final', text: 'parent replacement inherited' }
      },
    }
    const [, , sendMessage] = createTeamTools(teams, {
      tasks,
      resumeBackgroundAgent: (task, message, ctx) => resumeBackgroundAgentTask({
        tasks,
        agents: [agent],
        model,
        baseTools: [],
        baseSystemPrompt: 'base prompt',
      }, task, message, ctx),
    })

    const ctx = {
      workspace: new Workspace(root),
      conversationId: 'c-resume-parent-replacements',
      permissionMode: 'ask' as const,
      contentReplacementState: parentReplacementState,
    }
    const output = JSON.parse(await sendMessage!.execute({ to: 'replacement-gap-reader', summary: 'resume parent replacements', message: '继续。' }, ctx))
    expect(output.success).toBe(true)
    const resumed = await waitFor(async () => {
      const task = await tasks.get(output.task_id)
      return task?.status === 'completed' ? task : null
    })

    expect(resumed.result).toBe('parent replacement inherited')
    expect(firstStepText).toContain('<stored_tool_result tool="run_command"')
    expect(firstStepText).toContain('PARENT-HEAD-OK')
    expect(firstStepText).not.toContain('parent-live-large-result')
    expect(await tasks.transcript(output.task_id).loadContentReplacementRecords()).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
