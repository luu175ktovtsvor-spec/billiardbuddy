/**
 * 回合末记忆抽取(后台兜底)—— 移植 cc-haha `src/services/extractMemories/extractMemories.ts`
 * + `query/stopHooks.ts:178`(turn 末触发)+ `hasMemoryWritesSince`(节流)+ `drainPendingExtraction`(尾跑)。
 *
 * cc 机制:每轮 query loop 结束(模型给出**无工具调用的最终答复**)时,若主 agent 这轮**没自己写记忆**,
 * 就 fork 一个受限子代理(只读 + 写 memdir),让它回看最近几条消息、把遗漏的耐久事实攒进记忆。
 * 主写路 = 模型自己调 save_memory;这是**兜底网**,防「模型忙完正事忘了存」——正是店主最在意的
 * 「AI 记不住 / 店脑不学 AI 交付」的根因。没有它,记忆只在模型恰好记得时才写。
 *
 * 与 cc 的差异(有意为之、已在差异清单登记):
 *  - 写侧用一等公民工具 `save_memory`(自动带 frontmatter + 维护 MEMORY.md 索引),比 cc 的
 *    「Write 文件 + 手改索引两步」更稳;抽取子代理只给「只读文件工具 + save_memory」。
 *  - 节流判据 = 这轮有没有调过 save_memory(等价 cc `hasMemoryWritesSince` 的 watermark)。
 *  - 不共享父 prompt 缓存(cc runForkedAgent 共享),故只喂**最近消息切片**而非全量 perfect-fork,控成本;
 *    抽取提示词已让模型「只看这几条、别再调查」。
 *  - 品牌中性:提示词绝不出现底层来源 / CLAUDE.md 字样。
 *
 * 互斥 + drain:同一会话同时只跑一个抽取;pending promise 存模块级、按 conversationId 分桶,
 * 主循环在**下一轮召回前** drain(留出后台跑的空档,也保证下轮召回能读到刚抽取的记忆)。
 */

import type { Model } from '../types/model'
import type { Message, ToolUseBlock } from '../types/message'
import type { Workspace } from '../workspace/workspace'
import type { ToolRegistry } from '../tools/registry'
import { ToolRegistry as ToolRegistryCtor } from '../tools/registry'
import { saveMemoryTool, SAVE_MEMORY_TOOL_NAME } from '../tools/saveMemoryTool'
import { sanitizeResumeMessages } from '../harness/messageSanitize'
import { runAgentLoop } from '../harness/loop'

/** 抽取子代理最多喂多少条最近消息(控成本;不共享 prompt 缓存,不跑全量 perfect-fork)。 */
const EXTRACT_RECENT_MESSAGES = 24
/** 抽取子代理轮次上限(save_memory 一步到位;留出「读现有记忆 → 存」两三轮 + 缓冲)。 */
const EXTRACT_MAX_TURNS = 4
/**
 * 抽取 fork 的独立超时(自带信号,**不搭父回合的 signal**):server 的 TurnRegistry.start()
 * 会 abort 上一轮 controller,若 fork 搭父信号,用户一发下一句话抽取就被当场杀死——最常见的
 * 连续对话场景下兜底形同虚设。对齐 cc 的 detached 语义(void executeExtractMemories + drain),
 * fork 独立跑、下轮召回前 drain;超时兜住 runaway。
 */
const EXTRACT_TIMEOUT_MS = 180_000
/** states 表容量上限(桌面长跑进程防无界增长;超出淘汰最老会话的水位,代价只是那会话多跑一次兜底)。 */
const MAX_TRACKED_CONVERSATIONS = 128
/** 抽取子代理可用的只读文件工具白名单(+ save_memory);不给 web/bash/computer,防它「跑去调查」+ 控成本。 */
const EXTRACT_READONLY_TOOLS = new Set(['read_file', 'read_many_files', 'grep', 'glob', 'ls', 'list_directory'])

const EXTRACT_SUBAGENT = { agentId: 'memory-extract', agentType: 'memory-extract' } as const
const EXTRACT_QUERY_SOURCE = 'builtin:memory-extract'

/** 每会话的抽取状态:pending(在飞抽取,供 drain/互斥)+ lastCount(已抽取到的消息水位,防重复抽同一段)。 */
interface ExtractState {
  pending: Promise<void> | null
  lastCount: number
}
const states = new Map<string, ExtractState>()
const stateKey = (conversationId: string | undefined): string => conversationId ?? '__default__'
function getState(conversationId: string | undefined): ExtractState {
  const key = stateKey(conversationId)
  let s = states.get(key)
  if (!s) {
    if (states.size >= MAX_TRACKED_CONVERSATIONS) {
      const oldest = states.keys().next().value
      if (oldest !== undefined) states.delete(oldest)
    }
    s = { pending: null, lastCount: 0 }
    states.set(key, s)
  }
  return s
}

function envTruthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** 抽取兜底是否启用:随 auto-memory 总开关,且可用 BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT 单独关(保留召回)。 */
export function isMemoryExtractionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (envTruthy(env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY) || envTruthy(env.BILLIARDBUDDY_DISABLE_MEMORY)) return false
  if (envTruthy(env.BILLIARDBUDDY_DISABLE_MEMORY_EXTRACT)) return false
  return true
}

/**
 * 主 agent 这一段(水位 sinceIndex 之后)有没有自己调过 save_memory。
 * 有 → 已捕获、无需兜底抽取(等价 cc hasMemoryWritesSince)。
 */
function hasSaveMemorySince(messages: Message[], sinceIndex: number): boolean {
  for (let i = Math.max(0, sinceIndex); i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    if (m.content.some(b => b.type === 'tool_use' && (b as ToolUseBlock).name === SAVE_MEMORY_TOOL_NAME)) return true
  }
  return false
}

/** 从「最近 minCount 条」回退到最近一个干净的用户回合边界(有正文、非 tool_result 载体),再 sanitize 保配对。 */
function safeRecentSlice(messages: Message[], minCount: number): Message[] {
  if (messages.length <= minCount) return sanitizeResumeMessages(messages.slice())
  let start = messages.length - minCount
  while (start > 0) {
    const m = messages[start]
    const isGenuineUserTurn = m?.role === 'user'
      && m.content.some(b => b.type === 'text')
      && !m.content.some(b => b.type === 'tool_result')
    if (isGenuineUserTurn) break
    start--
  }
  return sanitizeResumeMessages(messages.slice(start))
}

/** 抽取子代理只给「只读文件工具 + save_memory」,防它跑去调查、也控成本(对齐 cc 受限工具集意图)。 */
function buildExtractionRegistry(parent: ToolRegistry): ToolRegistry {
  const tools = parent.list().filter(t => EXTRACT_READONLY_TOOLS.has(t.name) && t.isReadOnly)
  if (!tools.some(t => t.name === SAVE_MEMORY_TOOL_NAME)) tools.push(saveMemoryTool)
  return new ToolRegistryCtor(tools)
}

/** 抽取指令(品牌中性、中文):只从这几条对话里提炼耐久事实,用 save_memory 存;没有就什么都别做。 */
function buildExtractDirective(recentCount: number): string {
  return [
    '你现在是「记忆抽取子代理」。回看上面对话的最近约 ' + recentCount + ' 条消息,把其中值得长期记住、',
    '但还没存进记忆的耐久事实攒进记忆库。这是一次后台兜底:主对话可能忙完正事忘了存,你负责补上。',
    '',
    '- 只看这几条对话内容本身来提炼,别再去 grep 源码 / 读代码 / 跑命令核实——你的任务是从对话里提炼,不是调查。',
    '- 判据同你的记忆系统提示:user(用户画像)/ feedback(做事反馈,含为什么)/ project(门店近况,相对日期换绝对)',
    '  / reference(外部资料指针)。不该存的(代码写法、git 历史、临时状态、密钥隐私、从文件/命令能查到的)一律不存。',
    '- 安全红线:只存用户在对话里明确说过或纠正过的事实,拿不准就不存,禁止凭空补全 / 推测 / 编造门店信息。',
    '- 用 save_memory 存;存前先想有没有可更新的同名记忆(可先 read_file/grep 记忆库),别写重复条目。',
    '- 如果这几条消息里没有值得长期记的耐久事实,就什么都别做、直接结束,别硬凑。',
  ].join('\n')
}

/**
 * turn 末触发(fire-and-forget):主 agent 给出最终答复、循环真停时调。
 * 节流(这轮已写记忆 / 无新消息)→ 跳过;否则 fork 受限子代理后台抽取,pending 存模块级供 drain。
 * 全程 best-effort:任何异常都吞掉,绝不抛回主循环。
 * 注意不收父回合 signal:fork 自带独立超时(见 EXTRACT_TIMEOUT_MS),否则下一轮 TurnRegistry
 * abort 上一轮 controller 时抽取被连坐杀死。
 */
export function maybeExtractMemories(input: {
  conversationId: string | undefined
  model: Model
  registry: ToolRegistry
  workspace: Workspace
  systemPrompt: string
  messages: Message[]
}): void {
  if (!isMemoryExtractionEnabled()) return
  const state = getState(input.conversationId)
  if (state.pending) return // 互斥:上一轮抽取还在飞,让它跑完(下轮 drain);别叠加。
  // 压缩会把消息数组换成短摘要(length 骤缩):水位归零,别让 length<=lastCount 恒真、抽取长期哑火。
  if (input.messages.length < state.lastCount) state.lastCount = 0
  const sinceIndex = state.lastCount
  if (input.messages.length <= sinceIndex) return // 无新消息。
  if (hasSaveMemorySince(input.messages, sinceIndex)) {
    // 主 agent 这轮已自己写过记忆 → 无需兜底,推进水位跳过。
    state.lastCount = input.messages.length
    return
  }
  const recent = safeRecentSlice(input.messages, EXTRACT_RECENT_MESSAGES)
  if (recent.length === 0) return
  const prevCount = state.lastCount
  state.lastCount = input.messages.length // 先推水位防重复调度;失败再回滚,下轮重试一次。
  state.pending = runExtraction({ ...input, recent })
    .catch(() => { state.lastCount = Math.min(state.lastCount, prevCount) })
    .finally(() => { state.pending = null })
}

async function runExtraction(input: {
  model: Model
  registry: ToolRegistry
  workspace: Workspace
  systemPrompt: string
  recent: Message[]
}): Promise<void> {
  const registry = buildExtractionRegistry(input.registry)
  const gen = runAgentLoop({
    model: input.model,
    registry,
    workspace: input.workspace,
    systemPrompt: input.systemPrompt,
    initialMessages: input.recent,
    userMessage: buildExtractDirective(input.recent.length),
    maxTurns: EXTRACT_MAX_TURNS,
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS), // 独立超时,不搭父信号(防下一轮 interrupt 连坐)。
    subagent: EXTRACT_SUBAGENT, // 标 subagent → fork 内不再递归召回/抽取。
    querySource: EXTRACT_QUERY_SOURCE,
  })
  for await (const _ of gen) { /* 抽取产出即写盘副作用,事件流丢弃 */ }
}

/** 等本会话在飞的抽取跑完(主循环下轮召回前调,保证读到刚抽取的记忆 + 不叠加)。 */
export async function drainPendingExtraction(conversationId: string | undefined): Promise<void> {
  const p = states.get(stateKey(conversationId))?.pending
  if (p) await p.catch(() => { /* drain 只等待、不传播错误 */ })
}

/** 测试用:清空模块级抽取状态。 */
export function __resetExtractStateForTest(): void {
  states.clear()
}
