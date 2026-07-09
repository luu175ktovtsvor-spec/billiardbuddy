// 领域包(domain pack)通用接口 · 可插拔架构地基
//
// 领域包 = 我们特有的一类「插件」:一整套可挂载的领域能力(领域上下文 + 命令 + 工具 + 知识 + 守卫)。
// 台球(billiards)只是「第一个注册的领域包」,不是产品边界;新增一个领域包 = 注册一个模块,不改核心。
//
// 这里只放**纯接口**(无运行时值),避免 registry / 各 pack 模块 / domainPacks 门面之间形成运行时循环依赖。

import type { Tool } from '../tools/Tool'

/** 领域包内置的斜杠命令(渐进披露入口/子流程)。 */
export interface DomainPackCommand {
  name: string
  description: string
  whenToUse?: string
  allowedTools?: string[]
  /** 额外的斜杠别名(如入口命令 /台球 也接受 /billiards、/球房);仅进 byName 解析,不在清单里重复出条。 */
  aliases?: string[]
  prompt: string
}

/**
 * 领域知识句柄(可选)。当前 sessionStartContext 已内联策展摘要,这里给面板/报告一个稳定的统计入口,
 * 并为后续 RAG/深度检索(嵌入走 Node sidecar)预留位置——pack 自持知识细节,核心不感知其形状。
 */
export interface DomainPackKnowledge {
  /** 供面板/报告的覆盖度统计(条目数/按域分布等),形状由 pack 自定。 */
  stats?: () => Record<string, unknown>
  [key: string]: unknown
}

/**
 * 领域守卫句柄(可选)。对一段文本做领域级红线/脱敏扫描(禁词、须脱敏第三方专名等);
 * 返回值形状由 pack 自定(核心只当它是"能扫一段文本"的能力),真正的语义级防编造后续接 RAG。
 */
export interface DomainPackGuardrails {
  /** 对一段文本做守卫扫描,返回命中项(结构由 pack 决定)。 */
  scan?: (text: string) => unknown
  [key: string]: unknown
}

/**
 * 一个领域包的完整定义。核心通过统一接口发现/装载/启停/版本管理它,不硬编码任何具体 pack。
 * 必填 = id/name/description/sessionStartContext;其余(命令/工具/知识/守卫/版本/别名)按需提供。
 */
export interface DomainPack {
  id: string
  name: string
  description: string
  /** 语义化版本(缺省 '0.0.0'),供升级/兼容判断与面板展示。 */
  version?: string
  /** 入口别名:/台球、pool、球房 等都能解析到本包。 */
  aliases?: string[]
  /** 首启是否默认挂载(默认 false = 通用助手,用户显式选才挂)。 */
  defaultEnabled?: boolean
  /** 挂载时经 SessionStart hook 注入的领域上下文(策展摘要)。 */
  sessionStartContext: string
  suggestedSkills?: string[]
  commands?: DomainPackCommand[]
  tools?: Tool[]
  /** 领域知识句柄(可选,供统计/未来 RAG)。 */
  knowledge?: DomainPackKnowledge
  /** 领域守卫句柄(可选,禁词/脱敏扫描等)。 */
  guardrails?: DomainPackGuardrails
}

/** 出口给前端/面板的稳定 pack 元信息(不含运行时函数/prompt 全文)。 */
export interface PublicDomainPack {
  id: string
  name: string
  description: string
  version: string
  aliases: string[]
  default_enabled: boolean
  suggested_skills: string[]
  suggested_commands: string[]
  suggested_tools: string[]
}
