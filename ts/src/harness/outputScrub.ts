import type { AgentEvent } from '../types/events'
import { scrubProviderIdentifiers, scrubProviderIdentifiersWith } from '../model/publicModelNames'

/**
 * 白标第二层防护:用户可见的助手文本出口兜底清洗。
 *
 * 第一层是系统提示(buildAntiReveal)"劝"模型别自曝身份;但那只是提示,极端越狱下模型
 * 理论上仍可能吐真名。这一层做的是"出口硬清":把送达客户端前的助手文本(final 权威全文 +
 * content_delta 流式增量 + thinking)统一过一遍脱敏器,真名到不了用户眼前。纵深防御。
 *
 * token 表复用 #38 的 publicModelNames(单一事实源,不另写一份黑名单);聊天正文场景把命中
 * 的真名换成"本助手"这种散文友好的中性口径(#38 默认的"AI 通道"在对话正文里读着突兀),
 * 系统旁白 context_note 仍用 #38 原口径。
 */

/** 聊天正文里读起来自然的中性代称(替代 #38 面向报错的"AI 通道")。 */
const PROSE_NEUTRAL = '本助手'

/** 聊天正文脱敏:命中真名/供应商/endpoint → 换成散文友好的中性代称。复用 #38 的 token 表。 */
export function scrubProseIdentifiers(text: string): string {
  return scrubProviderIdentifiersWith(text, PROSE_NEUTRAL)
}

/**
 * carry-over 缓冲窗口(字符):流式增量可能把一个禁词切成两半(如 "Clau"+"de"),
 * 每次 hold 住尾部这么长一段不发,跟下一个 delta 拼上再清,清完把安全前缀放出。
 * 取值须远大于最长可能被切断的真名/模型 id(如 doubao-seedream-4-5-251128、
 * claude-sonnet-4-5-2025xxxx 约 26 字),留足余量,保证禁词绝不会有一半被抢先发出。
 */
const HOLD = 48

interface ChannelBuffer {
  /** 本通道到目前为止累计收到的原始文本(未清洗)。 */
  raw: string
  /** 已经发出去的(清洗后)字符数——scrubbed 空间的偏移,防重发。 */
  emitted: number
}

function newBuffer(): ChannelBuffer {
  return { raw: '', emitted: 0 }
}

/**
 * 助手文本出口清洗器(有状态,每个回合一个实例)。
 * push(event) 把一个 harness 事件转换成 0..n 个"已脱敏、可安全发送"的事件;
 * flush() 在流结束时吐出各通道 hold 住的尾巴。
 *
 * - content_delta:走 carry-over 缓冲,逐通道(text/thinking 各一份)累积+清洗+按窗口放行。
 * - final:先 flush 掉各通道 hold 住的尾巴(补完打字机),再吐权威全文的脱敏版(必清)。
 * - thinking(整块):整段脱敏(若展示给用户)。
 * - context_note:系统旁白,沿用 #38 原口径脱敏(不改 #38 行为)。
 * - 其它事件:原样透传。
 */
export function createChatOutputScrubber(): {
  push(event: AgentEvent): AgentEvent[]
  flush(): AgentEvent[]
} {
  const buffers: Record<'text' | 'thinking', ChannelBuffer> = {
    text: newBuffer(),
    thinking: newBuffer(),
  }

  /** 把一段新增量喂进某通道,返回此刻可安全放行的(清洗后)片段。 */
  function feed(channel: 'text' | 'thinking', text: string): string {
    const buf = buffers[channel]
    buf.raw += text
    const scrubbed = scrubProseIdentifiers(buf.raw)
    // 尾部 HOLD 字符可能藏着"半个禁词",先不发;之前已发的前缀是稳定的(禁词一旦成型即被替换)。
    const safeEnd = Math.max(buf.emitted, scrubbed.length - HOLD)
    if (safeEnd <= buf.emitted) return ''
    const out = scrubbed.slice(buf.emitted, safeEnd)
    buf.emitted = safeEnd
    return out
  }

  /** flush 某通道 hold 住的剩余尾巴,并把该通道缓冲清零(下一段重新开始)。 */
  function flushChannel(channel: 'text' | 'thinking'): AgentEvent[] {
    const buf = buffers[channel]
    const scrubbed = scrubProseIdentifiers(buf.raw)
    const out = scrubbed.slice(buf.emitted)
    buffers[channel] = newBuffer()
    return out ? [{ type: 'content_delta', channel, text: out }] : []
  }

  function push(event: AgentEvent): AgentEvent[] {
    switch (event.type) {
      case 'content_delta': {
        const out = feed(event.channel, event.text)
        return out ? [{ type: 'content_delta', channel: event.channel, text: out }] : []
      }
      case 'final': {
        // final 是覆盖流式累积的权威全文:先补完各通道打字机尾巴,再发脱敏后的全文。
        const flushed = [...flushChannel('text'), ...flushChannel('thinking')]
        return [...flushed, { type: 'final', text: scrubProseIdentifiers(event.text) }]
      }
      case 'thinking':
        return [{ type: 'thinking', text: scrubProseIdentifiers(event.text) }]
      case 'context_note':
        // 系统旁白:沿用 #38 原口径("AI 通道"),不改 #38 已有行为/测试。
        return [{ ...event, text: scrubProviderIdentifiers(event.text) }]
      default:
        return [event]
    }
  }

  function flush(): AgentEvent[] {
    return [...flushChannel('text'), ...flushChannel('thinking')]
  }

  return { push, flush }
}
