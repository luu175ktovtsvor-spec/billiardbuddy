// 台球运营领域包 · 「第一个注册的领域包」定义
//
// 这里把台球知识装配成一个通用 DomainPack:入口命令 /台球(+ 别名)、只读知识检索、
// 挂载注入的知识目录和统计句柄。核心(registry / domainPacks 门面)只认
// DomainPack 接口,不感知台球细节;新增别的领域包照此写一个模块并注册即可,不改核心。
//
// 知识内容沿用 ./index 的策展装配,本文件只做「装成 pack」。

import type { Tool } from '../../tools/Tool'
import type { DomainPack } from '../types'
import { renderSessionStartContext, renderKnowledgeMatches, billiardsPackStats } from './index'

const billiardsKnowledgeSearchTool: Tool = {
  name: 'billiards_knowledge_search',
  description: 'Search the enabled billiards operations knowledge base for relevant sourced facts and reference figures. This tool returns knowledge only; use normal Agent reasoning and tools to complete the user task.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The billiards operations topic or question to search for.' },
    },
    required: ['query'],
  },
  isReadOnly: true,
  async execute(input: unknown): Promise<string> {
    const body = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) throw new Error('billiards_knowledge_search 需要非空 query')
    return [
      '<domain_knowledge pack="billiards">',
      `查询:${query}`,
      renderKnowledgeMatches(query),
      '</domain_knowledge>',
    ].join('\n')
  },
}

/** 台球运营知识包(第一个注册的 pack)。 */
export const billiardsPack: DomainPack = {
  id: 'billiards',
  name: '台球运营知识库',
  description: '挂载台球运营知识库,让通用 Agent 在回答和执行任务时使用相关领域知识。',
  version: '2.0.0',
  aliases: ['billiard', 'pool', '台球', '球房', '台球房'],
  defaultEnabled: false,
  commands: [
    {
      name: '台球',
      description: '挂载台球运营知识库',
      whenToUse: '用户希望当前会话使用台球运营知识时;也可直接敲 /台球。',
      aliases: ['billiards', '球房', '台球房', 'pool', 'billiard'],
      prompt: [
        '当前会话已挂载台球运营知识库。继续按通用 Agent 的正常方式理解并完成用户任务。',
        '需要知识目录之外的具体做法或数字时,调用 billiards_knowledge_search;涉及本店自身事实时,从用户输入或门店资料中获取。',
      ].join('\n'),
    },
  ],
  tools: [billiardsKnowledgeSearchTool],
  sessionStartContext: renderSessionStartContext(),
  knowledge: { stats: () => billiardsPackStats() },
}
