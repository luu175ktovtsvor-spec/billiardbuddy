import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowDefinition } from '../../shared/contracts/workflows'
import { bundledWorkflowDefinitions } from './bundledWorkflows'
import { WorkflowDefinitionStore } from './definitionStore'

async function tempUserDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workflow-defs-'))
  const dir = join(root, 'definitions')
  await mkdir(dir, { recursive: true })
  return dir
}

const bundledSample: WorkflowDefinition = {
  id: 'sample-flow',
  name: '示例流程',
  description: '',
  billiardsMode: false,
  source: 'bundled',
  steps: [{ id: 's1', title: '第一步', instruction: '做点事' }],
}

describe('WorkflowDefinitionStore', () => {
  it('内置定义全部通过契约校验', () => {
    expect(() => new WorkflowDefinitionStore({ userDir: '/nonexistent', bundled: bundledWorkflowDefinitions })).not.toThrow()
    expect(bundledWorkflowDefinitions.length).toBeGreaterThanOrEqual(2)
    for (const definition of bundledWorkflowDefinitions) {
      expect(definition.source).toBe('bundled')
      expect(definition.billiardsMode).toBe(true)
    }
  })

  it('用户目录不存在时只返回内置定义', async () => {
    const store = new WorkflowDefinitionStore({ userDir: '/nonexistent/workflow-defs', bundled: [bundledSample] })
    const { workflows, issues } = await store.list()
    expect(workflows.map(w => w.id)).toEqual(['sample-flow'])
    expect(issues).toEqual([])
  })

  it('加载用户定义并强制 source=user;非法文件跳过并记录问题', async () => {
    const dir = await tempUserDir()
    await writeFile(join(dir, 'my-flow.json'), JSON.stringify({
      id: 'my-flow',
      name: '自定义流程',
      source: 'bundled', // 用户不能伪装成内置
      steps: [{ id: 's1', title: '步骤', instruction: '指令' }],
    }), 'utf8')
    await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
    await writeFile(join(dir, 'invalid.json'), JSON.stringify({ id: 'BAD_ID', name: '', steps: [] }), 'utf8')

    const store = new WorkflowDefinitionStore({ userDir: dir, bundled: [bundledSample] })
    const { workflows, issues } = await store.list()
    expect(workflows.map(w => w.id).sort()).toEqual(['my-flow', 'sample-flow'])
    expect(workflows.find(w => w.id === 'my-flow')?.source).toBe('user')
    expect(issues.map(issue => issue.file).sort()).toEqual(['broken.json', 'invalid.json'])
  })

  it('用户定义与内置同 id 时用户覆盖内置', async () => {
    const dir = await tempUserDir()
    await writeFile(join(dir, 'override.json'), JSON.stringify({
      id: 'sample-flow',
      name: '用户改写版',
      steps: [{ id: 's1', title: '改写步骤', instruction: '改写指令' }],
    }), 'utf8')
    const store = new WorkflowDefinitionStore({ userDir: dir, bundled: [bundledSample] })
    const definition = await store.get('sample-flow')
    expect(definition?.name).toBe('用户改写版')
    expect(definition?.source).toBe('user')
  })

  it('get 未知 id 返回 null', async () => {
    const store = new WorkflowDefinitionStore({ userDir: '/nonexistent', bundled: [bundledSample] })
    expect(await store.get('missing')).toBeNull()
  })
})
