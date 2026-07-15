import { describe, expect, it } from 'bun:test'
import {
  workflowDefinitionSchema,
  workflowRunSchema,
} from './workflows'

const validDefinition = {
  id: 'venue-daily-report',
  name: '营业日报',
  description: '收集当日经营数据并生成日报',
  billiardsMode: true,
  steps: [
    { id: 'collect', title: '收集资料', instruction: '读取工作目录内的当日经营数据。' },
    { id: 'draft', title: '生成日报', instruction: '基于上一步结果撰写日报草稿并保存为文件。' },
  ],
  source: 'bundled',
}

describe('workflowDefinitionSchema', () => {
  it('接受合法定义并填充默认值', () => {
    const parsed = workflowDefinitionSchema.parse({
      id: 'a-flow',
      name: '示例',
      steps: [{ id: 's1', title: '第一步', instruction: '做点事' }],
    })
    expect(parsed.description).toBe('')
    expect(parsed.billiardsMode).toBe(false)
    expect(parsed.source).toBe('user')
  })

  it('接受完整的内置定义', () => {
    expect(workflowDefinitionSchema.parse(validDefinition).steps).toHaveLength(2)
  })

  it('拒绝空步骤列表', () => {
    expect(workflowDefinitionSchema.safeParse({ ...validDefinition, steps: [] }).success).toBe(false)
  })

  it('拒绝非法 id(大写/下划线/空)', () => {
    for (const id of ['Upper-Case', 'has_underscore', '', '-leading-dash']) {
      expect(workflowDefinitionSchema.safeParse({ ...validDefinition, id }).success).toBe(false)
    }
  })

  it('拒绝重复步骤 id', () => {
    const dup = {
      ...validDefinition,
      steps: [
        { id: 'same', title: 'A', instruction: 'a' },
        { id: 'same', title: 'B', instruction: 'b' },
      ],
    }
    expect(workflowDefinitionSchema.safeParse(dup).success).toBe(false)
  })
})

describe('workflowRunSchema', () => {
  const validRun = {
    id: 'run-1',
    workflowId: 'venue-daily-report',
    workflowName: '营业日报',
    trigger: 'manual',
    status: 'completed',
    conversationId: 'conv-1',
    startedAt: '2026-07-16T09:00:00.000Z',
    completedAt: '2026-07-16T09:05:00.000Z',
    steps: [
      { stepId: 'collect', title: '收集资料', status: 'completed', summary: '已收集' },
      { stepId: 'draft', title: '生成日报', status: 'completed' },
    ],
  }

  it('接受合法运行记录', () => {
    expect(workflowRunSchema.parse(validRun).steps).toHaveLength(2)
  })

  it('拒绝未知状态', () => {
    expect(workflowRunSchema.safeParse({ ...validRun, status: 'paused' }).success).toBe(false)
  })

  it('旧记录缺 conversationId/completedAt 仍可读(可选字段兼容)', () => {
    const { conversationId: _c, completedAt: _t, ...legacy } = validRun
    expect(workflowRunSchema.safeParse(legacy).success).toBe(true)
  })
})
