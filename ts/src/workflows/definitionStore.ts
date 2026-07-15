// 工作流定义仓库:内置定义 + 用户目录 JSON 定义(<stateRoot>/workflows/definitions/*.json)。
// 用户定义经契约 Schema 解析,非法文件跳过并记录问题(不让单个坏文件拖垮列表);
// 用户定义与内置定义同 id 时用户覆盖内置(允许自定义调整内置流程)。

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowDefinitionSchema, type WorkflowDefinition } from '../../shared/contracts/workflows'

export interface WorkflowDefinitionIssue {
  file: string
  message: string
}

export interface WorkflowDefinitionListing {
  workflows: WorkflowDefinition[]
  issues: WorkflowDefinitionIssue[]
}

export interface WorkflowDefinitionStoreOptions {
  userDir: string
  bundled?: WorkflowDefinition[]
}

export class WorkflowDefinitionStore {
  private readonly userDir: string
  private readonly bundled: WorkflowDefinition[]

  constructor(opts: WorkflowDefinitionStoreOptions) {
    this.userDir = opts.userDir
    this.bundled = (opts.bundled ?? []).map(definition =>
      workflowDefinitionSchema.parse({ ...definition, source: 'bundled' }))
  }

  async list(): Promise<WorkflowDefinitionListing> {
    const issues: WorkflowDefinitionIssue[] = []
    const byId = new Map<string, WorkflowDefinition>()
    for (const definition of this.bundled) byId.set(definition.id, definition)

    let entries: string[] = []
    try {
      entries = await readdir(this.userDir)
    } catch {
      // 用户目录不存在 = 没有自定义工作流。
    }
    for (const entry of entries.filter(name => name.endsWith('.json')).sort()) {
      const file = join(this.userDir, entry)
      let raw = ''
      try {
        raw = await readFile(file, 'utf8')
      } catch (err) {
        issues.push({ file: entry, message: err instanceof Error ? err.message : String(err) })
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        issues.push({ file: entry, message: 'invalid JSON' })
        continue
      }
      const result = workflowDefinitionSchema.safeParse(
        typeof parsed === 'object' && parsed !== null ? { ...parsed, source: 'user' } : parsed,
      )
      if (!result.success) {
        issues.push({ file: entry, message: result.error.issues[0]?.message ?? 'invalid workflow definition' })
        continue
      }
      byId.set(result.data.id, result.data)
    }
    return { workflows: [...byId.values()], issues }
  }

  async get(id: string): Promise<WorkflowDefinition | null> {
    const { workflows } = await this.list()
    return workflows.find(definition => definition.id === id) ?? null
  }
}
