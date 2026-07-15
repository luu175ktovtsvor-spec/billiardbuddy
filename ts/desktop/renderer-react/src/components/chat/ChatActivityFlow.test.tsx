import { expect, mock, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatBlock } from '../../stores/chatStore'

mock.module('dompurify', () => ({ default: { sanitize: (raw: string) => raw } }))

const { Block, groupBlocks, splitTurns } = await import('./MessageList')
const { shouldShowInitialWaiting } = await import('./StreamingIndicator')
const { ThinkingBlock } = await import('./ThinkingBlock')
const { ToolCallGroup } = await import('./ToolCallGroup')
const { concatenatedToolParts, summarizeActivity, visibleActivityTools } = await import('./toolMeta')

function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
}

test('原始思考正文不展示，完成态也不遗留泛化占位行', () => {
  const active = render(<ThinkingBlock content="正在核对源码证据" isActive />)
  expect(active).toContain('正在思考')
  expect(active).not.toContain('正在核对源码证据')
  expect(active).not.toContain('qf-cursor')

  const completed = render(<ThinkingBlock content="已经核对完源码证据" isActive={false} />)
  expect(completed).toBe('')
  expect(completed).not.toContain('已经核对完源码证据')
})

test('媒体成品被拆成独立活动项，不会埋进前后工具组', () => {
  const blocks: ChatBlock[] = [
    { id: 'user-media', kind: 'user', text: '导出视频' },
    { id: 'read-before', kind: 'tool', tool: 'read_file', input: { path: 'brief.md' }, status: 'ok' },
    { id: 'task-output', kind: 'tool', tool: 'TaskOutput', input: { task_id: 'v1' }, status: 'ok', output: '<media_result><video_url>/exports/final.mp4</video_url></media_result>' },
    { id: 'read-after', kind: 'tool', tool: 'read_file', input: { path: 'manifest.json' }, status: 'ok' },
    { id: 'assistant-media', kind: 'assistant', text: '视频已经生成', streaming: false },
  ]
  const turn = splitTurns(groupBlocks(blocks)).find(entry => entry.type === 'turn')
  if (turn?.type !== 'turn') throw new Error('没有生成媒体回合')
  expect(turn.items).toHaveLength(4)
  expect(turn.items.map(item => item.key)).toEqual(['read-before', 'task-output', 'read-after', 'assistant-media'])
  const media = turn.items[1]
  expect(media?.kind).toBe('tool-group')
  if (media?.kind !== 'tool-group') throw new Error('媒体结果没有生成独立活动项')
  expect(media.blocks.map(block => block.id)).toEqual(['task-output'])
})

test('工具活动组用思考状态接管组头，不在明细里重复暴露思考正文', () => {
  const blocks: ChatBlock[] = [
    { id: 'tool-1', kind: 'tool', tool: 'read_file', input: { file_path: '/tmp/a.ts' }, status: 'ok' },
    { id: 'thinking-1', kind: 'thinking', text: '不应在工具明细里重复出现', active: true },
  ]
  const html = render(<ToolCallGroup blocks={blocks} />)
  expect(html).toContain('正在思考')
  expect(html).not.toContain('不应在工具明细里重复出现')
})

test('阶段独白、工具活动和最终回复保持真实时序，流式正文不渲染字符光标', () => {
  const blocks: ChatBlock[] = [
    { id: 'user-1', kind: 'user', text: '检查项目' },
    { id: 'commentary-1', kind: 'assistant', text: '我先看一下项目结构。', streaming: false },
    { id: 'thinking-1', kind: 'thinking', text: '先阅读文件', active: false },
    { id: 'tool-1', kind: 'tool', tool: 'read_file', input: { file_path: '/tmp/a.ts' }, status: 'ok' },
    { id: 'assistant-1', kind: 'assistant', text: '这是最终结论', streaming: true },
  ]
  const turn = splitTurns(groupBlocks(blocks)).find((entry) => entry.type === 'turn')
  expect(turn?.type).toBe('turn')
  if (turn?.type !== 'turn') throw new Error('没有生成回合')
  expect(turn.items.map(item => item.key)).toEqual(['commentary-1', 'thinking-1', 'assistant-1'])
  expect(turn.items[1]?.kind).toBe('tool-group')

  const response = render(<Block block={{ id: 'assistant-stream', kind: 'assistant', text: '流式正文没有字符光标', streaming: true }} />)
  expect(response).not.toContain('qf-cursor')
})

test('回合运行中的助手文字保持为独立阶段独白', () => {
  const blocks: ChatBlock[] = [
    { id: 'user-running', kind: 'user', text: '检查项目' },
    { id: 'commentary-running', kind: 'assistant', text: '我先看一下这个项目的结构。', streaming: false },
    { id: 'tool-running', kind: 'tool', tool: 'list_dir', input: { path: '/tmp/project' }, status: 'running' },
  ]
  const turn = splitTurns(groupBlocks(blocks)).find((entry) => entry.type === 'turn')
  if (turn?.type !== 'turn') throw new Error('没有生成运行中回合')

  expect(turn.items[0]?.kind).toBe('block')
  expect(turn.items[0]?.kind === 'block' && turn.items[0].block.kind === 'assistant').toBe(true)
  expect(turn.items[1]?.kind).toBe('tool-group')
})

test('技能和工具加载保留在活动流，大结果分页回读仍隐藏', () => {
  const items = groupBlocks([
    { id: 'skill-1', kind: 'tool', tool: 'use_skill', input: { skill: 'Project Change Router' }, status: 'ok' },
    { id: 'search-1', kind: 'tool', tool: 'tool_search', input: { query: '读取文件' }, status: 'ok' },
    { id: 'stored-1', kind: 'tool', tool: 'read_stored_tool_result', input: { path: 'tool-1.txt' }, status: 'ok' },
  ])
  expect(items).toHaveLength(1)
  expect(items[0]?.kind).toBe('tool-group')
  if (items[0]?.kind !== 'tool-group') throw new Error('工具没有生成活动组')
  expect(items[0].blocks.filter((block) => block.kind === 'tool').map((block) => block.tool)).toEqual(['use_skill', 'tool_search'])

  const html = render(<ToolCallGroup blocks={items[0].blocks} />)
  expect(html).toContain('已加载工具')
  expect(html).not.toContain('read_stored_tool_result')
})

test('尚无活动事件时只显示轻量等待分隔行，活动出现后由活动区接管', () => {
  expect(shouldShowInitialWaiting('running', [{ id: 'user-1', kind: 'user', text: '开始' }])).toBe(true)
  expect(shouldShowInitialWaiting('idle', [{ id: 'user-1', kind: 'user', text: '开始' }])).toBe(false)
  expect(shouldShowInitialWaiting('running', [
      { id: 'user-1', kind: 'user', text: '开始' },
      { id: 'thinking-1', kind: 'thinking', text: '分析中', active: true },
  ])).toBe(false)
})

test('完成后的活动组默认折叠，已恢复的拼接工具错误不再外露', () => {
  const blocks: ChatBlock[] = [
    { id: 'bad-1', kind: 'tool', tool: 'list_dirlist_dirlist_dir', input: {}, status: 'error', output: '错误:未知工具' },
    { id: 'folder-1', kind: 'tool', tool: 'list_dir', input: { path: '成都' }, status: 'ok', output: '18 行输出' },
    { id: 'folder-2', kind: 'tool', tool: 'list_dir', input: { path: '晋江' }, status: 'ok', output: '34 行输出' },
    { id: 'image-1', kind: 'tool', tool: 'read_file', input: { path: '候选-1.jpg' }, status: 'ok' },
    { id: 'image-2', kind: 'tool', tool: 'read_file', input: { path: '候选-2.jpg' }, status: 'ok' },
  ]

  const html = render(<ToolCallGroup blocks={blocks} />)
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('已列出文件')
  expect(html).toContain('已读取文件')
  expect(html).not.toContain('list_dirlist_dirlist_dir')
  expect(html).not.toContain('出错了')
})

test('活动摘要使用当前 Codex 的分类口径，不暴露逐项执行轨迹', () => {
  expect(summarizeActivity([
    ...Array.from({ length: 5 }, (_, index) => ({ tool: 'list_dir', status: 'ok' as const, input: { path: `folder-${index}` } })),
    ...Array.from({ length: 3 }, () => ({ tool: 'select_image_candidates', status: 'ok' as const })),
    ...Array.from({ length: 7 }, (_, index) => ({ tool: 'read_file', status: 'ok' as const, input: { path: `image-${index}.jpg` } })),
  ])).toBe('已列出文件已筛选图片已读取文件')
})

test('未恢复的错误仍保留但不强制展开整组', () => {
  const html = render(<ToolCallGroup blocks={[
    { id: 'read-ok', kind: 'tool', tool: 'read_file', input: { path: 'a.txt' }, status: 'ok' },
    { id: 'command-failed', kind: 'tool', tool: 'run_command', input: { command: 'bad' }, status: 'error', output: '命令失败' },
  ]} />)
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('出错了')
  expect(html).not.toContain('命令失败')
})

test('回合级摘要也排除已成功重试的拼接工具错误', () => {
  const tools = visibleActivityTools([
    { id: 'bad-read', tool: 'read_fileread_file', status: 'error' as const },
    { id: 'good-read', tool: 'read_file', status: 'ok' as const, input: { path: 'a.txt' } },
  ])
  expect(tools.map((tool) => tool.id)).toEqual(['good-read'])
  expect(summarizeActivity(tools)).toBe('已读取文件')
})

test('同名与混合工具名粘连都识别为 provider 协议噪音', () => {
  expect(concatenatedToolParts('read_many_filesread_many_files')).toEqual(['read_many_files', 'read_many_files'])
  expect(concatenatedToolParts('read_many_filesread_file')).toEqual(['read_many_files', 'read_file'])
  expect(concatenatedToolParts('read_file')).toBeNull()

  expect(visibleActivityTools([
    { id: 'mixed', tool: 'read_many_filesread_file', status: 'error' as const },
    { id: 'real', tool: 'run_command', status: 'error' as const },
  ]).map((tool) => tool.id)).toEqual(['real'])
})
