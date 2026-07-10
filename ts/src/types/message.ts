/**
 * 内核消息格式 = Anthropic content-block:tool_use/tool_result 块、无 role:'tool'、system 单列。
 * 出方向由 ts/src/proxy 翻译成 OpenAI chat 喂国产模型;内部只认这套块。
 */
export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
export interface ImageBlock { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
/**
 * 文档块(PDF 视觉通道):对齐 cc FileReadTool 的 DocumentBlockParam(source.media_type:'application/pdf')。
 * cc 把 PDF 当"文档 content-block"直接喂给模型看(不是当 UTF-8 文本读成乱码)。#46 只接了 image,PDF 这条
 * 通道原缺失(读合同/PDF 拿到乱码)。⚠️向后兼容:只挂在顶层 ContentBlock 联合里、**不进** ToolResultContentBlock
 * (那会破坏 model 侧 toAnthropicToolResultContentBlock 的 text|image 签名);document 走"随 tool_result 尾随进
 * 同一条 user 消息的顶层块"这条路(见 fileReadTool 的 documentResultSink + loop followup 组装)。未识别 document
 * 块的旧 reader 一律走 if-链兜底(不匹配即跳过),不抛错。
 */
export interface DocumentBlock { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
/**
 * tool_result 的 content 承载:兼容旧的纯文本 string,或(多模态)块数组 text/image——对齐 cc 的
 * ToolResultBlockParam.content(见 FileReadTool.mapToolResultToToolResultBlockParam:图片走
 * [{type:'image',source}])。string 时行为与旧版完全一致(向后兼容);数组时由 model/proxy 序列化成
 * Anthropic image content-block / OpenAI image_url。
 */
export type ToolResultContentBlock = TextBlock | ImageBlock
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | ToolResultContentBlock[]; is_error?: boolean }

export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | DocumentBlock | ToolUseBlock | ToolResultBlock

/**
 * 事件日志戳记(对齐 cc TranscriptMessage:uuid/parentUuid + sessionId/cwd/gitBranch provenance)。
 * 内核内存里的消息可以带这些字段,但**喂给模型前 proxy/model 只读 role/content**(见
 * model/AnthropicMessagesModel.toAnthropicMessage、proxy/toOpenAiChatRequest.convertMessage 与
 * proxy/messagePairing.normalizeMessagesForAPI —— 都显式重建 {role,content}),故戳记永不外泄给上游模型。
 * 落盘时由 memory/Transcript 打戳(append-only 事件日志按 parentUuid 链重建),load() 回内存前一律剥回
 * 干净的 {role,content}(向后兼容既有消费者/UI/压缩链路),链稳定性靠 Transcript 内部按内容比对复用盘上 uuid。
 */
export interface MessageProvenance {
  /** 本条消息在事件日志里的稳定标识(cc:uuid)。 */
  uuid?: string
  /** 父消息 uuid;null = 链的根(新会话首条 / 压缩边界)。 */
  parentUuid?: string | null
  /** 归属会话 id(= conversationId)。 */
  sessionId?: string
  /** 产出这条消息时的工作区根(cc:cwd)。 */
  cwd?: string
  /** 产出这条消息时的 git 分支(尽力而为,读 .git/HEAD)。 */
  gitBranch?: string
  /** 写入时间戳(ISO)。 */
  timestamp?: string
}

/** 内部消息:content 恒为块数组(不用 string|Block[] 双态);role 只有 user/assistant,system 单列。 */
export type Message =
  | ({ role: 'user'; content: ContentBlock[] } & MessageProvenance)
  | ({ role: 'assistant'; content: ContentBlock[] } & MessageProvenance)

export const textBlock = (text: string): TextBlock => ({ type: 'text', text })

/** PDF 文档块(base64):对齐 cc 的 document content-block,喂给模型视觉查看。 */
export const documentBlock = (data: string): DocumentBlock =>
  ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })

export const toolUseBlock = (call: ToolCall): ToolUseBlock =>
  ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })

export const toolResultBlock = (toolUseId: string, content: string | ToolResultContentBlock[], isError = false): ToolResultBlock =>
  isError
    ? { type: 'tool_result', tool_use_id: toolUseId, content, is_error: true }
    : { type: 'tool_result', tool_use_id: toolUseId, content }

export const userText = (text: string): Message => ({ role: 'user', content: [textBlock(text)] })
