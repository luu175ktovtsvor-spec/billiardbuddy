import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { textBlock, userText, type Message } from '../types/message'
import { Transcript } from './transcript'

/** 读盘上所有行(含孤儿分支)成条目,用于断言"append 不覆写、旧行留痕"。 */
function rawEntries(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

/** 干净比对:剥掉 provenance 戳只比 role+content。 */
function plain(messages: Message[]): Array<{ role: string; content: unknown }> {
  return messages.map(m => ({ role: m.role, content: m.content }))
}

const asst = (text: string): Message => ({ role: 'assistant', content: [textBlock(text)] })

describe('Transcript (append-only 事件日志)', () => {
  test('append 只追加新增行、绝不覆写;load 按 parentUuid 链重建等价', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-append-'))
    try {
      const tr = new Transcript(root, 'conv_1')
      await tr.append([userText('a')])
      const afterFirst = readFileSync(tr.path, 'utf8')
      await tr.append([userText('a'), asst('b')]) // 尾部新增一条
      await tr.append([userText('a'), asst('b'), userText('c')]) // 再新增一条

      // load 拿到完整活跃链(剥 provenance 后)== 期望序列
      expect(plain(await tr.load())).toEqual(plain([userText('a'), asst('b'), userText('c')]))

      // 不覆写:第一次写的内容仍是文件的前缀(逐字节)
      expect(readFileSync(tr.path, 'utf8').startsWith(afterFirst)).toBe(true)
      // 盘上恰好 3 行(每次只追加了 delta,没重写已存在的行)
      expect(rawEntries(tr.path).length).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('每条落盘消息带稳定 uuid + parentUuid 链 + provenance 戳(sessionId/cwd)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-stamp-'))
    try {
      const tr = new Transcript(root, 'conv_2', { provenance: { cwd: '/ws/x' } })
      await tr.append([userText('a')])
      await tr.append([userText('a'), asst('b')])
      const rows = rawEntries(tr.path)
      expect(rows.length).toBe(2)
      // uuid 存在且唯一
      const [u0, u1] = [rows[0]!.uuid as string, rows[1]!.uuid as string]
      expect(typeof u0).toBe('string')
      expect(u0).not.toBe(u1)
      // 链:第一条 parentUuid=null(根),第二条 parentUuid=第一条 uuid
      expect(rows[0]!.parentUuid).toBeNull()
      expect(rows[1]!.parentUuid).toBe(u0)
      // provenance 戳:sessionId=conversationId、cwd 内嵌、timestamp 存在
      expect(rows[0]!.sessionId).toBe('conv_2')
      expect(rows[0]!.cwd).toBe('/ws/x')
      expect(typeof rows[0]!.timestamp).toBe('string')

      // uuid 稳定:公共前缀那条(a)再 append 时不重写、uuid 不变
      await tr.append([userText('a'), asst('b'), userText('c')])
      const rows2 = rawEntries(tr.path)
      expect(rows2[0]!.uuid).toBe(u0) // 'a' 的 uuid 稳定
      expect(rows2[1]!.uuid).toBe(u1) // 'b' 的 uuid 稳定
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('前缀改写(压缩式)→ 重接 parentUuid 写新分支,load 拿新链,旧行留痕不删', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rebranch-'))
    try {
      const tr = new Transcript(root, 'conv_3')
      await tr.append([userText('u1'), asst('a1'), userText('u2'), asst('a2')])
      const before = rawEntries(tr.path).length
      expect(before).toBe(4)

      // 模拟压缩:把前缀换成一条摘要 + 保留尾巴(内容与原 [u1,a1] 不同 → 从 index 0 分叉)
      const compacted: Message[] = [userText('[摘要] 前情'), userText('u2'), asst('a2')]
      await tr.append(compacted)

      // load 拿到的是新分支(活跃链),不含被压缩掉的 u1/a1
      expect(plain(await tr.load())).toEqual(plain(compacted))

      // 旧行留痕:文件仍含原始 4 行 + 新分支 3 行(append-only 不删)
      const rows = rawEntries(tr.path)
      expect(rows.length).toBe(before + compacted.length)
      // 新分支根的 parentUuid 为 null(压缩边界重接成新根)
      const newRoot = rows[before]!
      expect(newRoot.parentUuid).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('recordCompaction 追加 compact-boundary:压缩前历史留盘不重写,load 裁窗、loadFullHistory 拿全量', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-compact-'))
    try {
      const tr = new Transcript(root, 'conv_compact')
      const history: Message[] = [userText('u0'), asst('a0'), userText('u1'), asst('a1'), userText('u2'), asst('a2')]
      // 真实回合:压缩触发时只有一部分历史落过盘(saveTranscript 只在收尾),尾巴 u2/a2 仍只在内存。
      await tr.append(history.slice(0, 4))
      const rowsSaved = rawEntries(tr.path)
      expect(rowsSaved.length).toBe(4)

      // 压缩:一条摘要 + 保留最近两条(u2/a2)。压缩不重写历史,先把压缩前全量补齐落盘,再 append 一条 compact-boundary + 压缩后消息。
      const postCompact: Message[] = [userText('[此前对话摘要] 前情'), userText('u2'), asst('a2')]
      await tr.recordCompaction(history, postCompact, { trigger: 'auto', preTokens: 12345, messagesSummarized: history.length - postCompact.length })

      // load() 只回压缩后窗口(= cc getMessagesAfterCompactBoundary)
      expect(plain(await tr.load())).toEqual(plain(postCompact))

      // 盘上仍有压缩前历史(压缩不重写):已落盘的 4 行逐字节没变,之前只在内存的 u2/a2 也被补齐落盘,再是 boundary + 3 条压缩后消息
      const raw = readFileSync(tr.path, 'utf8')
      expect(raw.startsWith(rowsSaved.map(r => JSON.stringify(r)).join('\n'))).toBe(true)
      const rows = rawEntries(tr.path)
      // 4(已落盘)+ 2(压缩前补齐 u2/a2)+ 1(boundary)+ 3(压缩后消息)
      expect(rows.length).toBe(6 + 1 + postCompact.length)
      const boundary = rows[6]!
      expect(boundary.type).toBe('compact-boundary')
      expect(boundary.trigger).toBe('auto')
      expect(boundary.preTokens).toBe(12345)
      // 边界 parentUuid 接上压缩前最后一条消息(补齐落盘的 a2),摘要接上边界 —— 全量历史仍在一条活跃链上
      expect(boundary.parentUuid).toBe(rows[5]!.uuid)
      expect(rows[7]!.parentUuid).toBe(boundary.uuid as string)

      // loadFullHistory() 拿到压缩前全量 + 压缩后窗口(边界标记被过滤掉,不是 Message)
      expect(plain(await tr.loadFullHistory())).toEqual(plain([...history, ...postCompact]))

      // 压缩后继续 append:与压缩后视图 dedup,只追加真正新增的一条,不再 fork、不重复压缩后消息
      await tr.append([...postCompact, userText('u3')])
      expect(plain(await tr.load())).toEqual(plain([...postCompact, userText('u3')]))
      expect(rawEntries(tr.path).length).toBe(6 + 1 + postCompact.length + 1)

      // resume:全新实例从盘重建 —— load 仍裁窗、loadFullHistory 仍全量
      const resumed = new Transcript(root, 'conv_compact')
      expect(plain(await resumed.load())).toEqual(plain([...postCompact, userText('u3')]))
      expect(plain(await resumed.loadFullHistory())).toEqual(plain([...history, ...postCompact, userText('u3')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('resume:新实例从盘重建活跃链后继续 append,uuid 复用不复写', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-resume-'))
    try {
      const first = new Transcript(root, 'conv_4')
      await first.append([userText('a'), asst('b')])
      const rowsBefore = rawEntries(first.path)

      // 全新实例(等价另一个进程 resume):load 出活跃链,续接后只追加新 delta
      const resumed = new Transcript(root, 'conv_4')
      const history = await resumed.load()
      expect(plain(history)).toEqual(plain([userText('a'), asst('b')]))
      await resumed.append([...history, userText('c')])

      const rowsAfter = rawEntries(resumed.path)
      expect(rowsAfter.length).toBe(3)
      // 前两行逐字节没变(uuid/戳没被复写)
      expect(rowsAfter[0]).toEqual(rowsBefore[0]!)
      expect(rowsAfter[1]).toEqual(rowsBefore[1]!)
      // 第三行链到第二行
      expect(rowsAfter[2]!.parentUuid).toBe(rowsBefore[1]!.uuid)
      expect(plain(await resumed.load())).toEqual(plain([userText('a'), asst('b'), userText('c')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('save 整表重置(fork 播种):覆写为新链、旧内容清掉', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-save-'))
    try {
      const tr = new Transcript(root, 'conv_5')
      await tr.append([userText('old1'), asst('old2'), userText('old3')])
      await tr.save([userText('seed1'), asst('seed2')])
      // save 是唯一允许覆写处:盘上只剩新链两行
      expect(rawEntries(tr.path).length).toBe(2)
      expect(plain(await tr.load())).toEqual(plain([userText('seed1'), asst('seed2')]))
      // save 后继续 append 走增量
      await tr.append([userText('seed1'), asst('seed2'), userText('seed3')])
      expect(rawEntries(tr.path).length).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('扁平布局(主会话)+ 子目录布局(子代理)路径正确', () => {
    // 默认:transcripts/ 子目录(子代理/后台任务)
    expect(new Transcript('/root', 'c').path).toBe(join('/root', 'transcripts', 'c.jsonl'))
    // 扁平:cc projects/<slug>/<id>.jsonl(主会话)
    expect(new Transcript('/root/projects/slug', 'c', { subdir: '' }).path).toBe(join('/root/projects/slug', 'c.jsonl'))
  })

  test('拒绝危险 conversation id', () => {
    expect(() => new Transcript('/tmp', '../x')).toThrow('非法 conversation id')
    expect(() => new Transcript('/tmp', 'a'.repeat(129))).toThrow('非法 conversation id')
  })

  test('坏行跳过,不让单行损坏拖垮 load', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-bad-'))
    try {
      const tr = new Transcript(root, 'conv_6')
      await tr.append([userText('a'), asst('b')])
      await Bun.write(tr.path, `${readFileSync(tr.path, 'utf8')}not-json\n`)
      expect(plain(await tr.load())).toEqual(plain([userText('a'), asst('b')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('loadPage 按活跃链分页,seq 单调,hasMore/after 正确', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-page-'))
    try {
      const tr = new Transcript(root, 'conv_page')
      await tr.append([userText('a'), asst('b'), userText('c'), asst('d')])

      const first = await tr.loadPage({ limit: 2 })
      expect(first.messages.map(r => [r.seq, r.message.content[0]])).toEqual([
        [1, textBlock('a')],
        [2, textBlock('b')],
      ])
      expect(first.nextSeq).toBe(2)
      expect(first.hasMore).toBe(true)

      const second = await tr.loadPage({ after: first.nextSeq, limit: 10 })
      expect(second.messages.map(r => r.seq)).toEqual([3, 4])
      expect(second.hasMore).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Transcript.rewindTo (message 级 rewind,append-only:追加 rewind-boundary 分支,不重写历史)', () => {
  test('rewindTo 后 load()/loadFullHistory() 裁短到目标之前;重开新实例(模拟重启)视图仍是裁短的', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rewind-'))
    try {
      const tr = new Transcript(root, 'conv_rw1')
      await tr.append([userText('u1'), asst('a1'), userText('u2'), asst('a2'), userText('u3'), asst('a3')])
      const rows = rawEntries(tr.path)
      const u2Uuid = rows[2]!.uuid as string // userText('u2') 的 uuid

      const { removedUuids } = await tr.rewindTo(u2Uuid)
      // 移除段 = u2,a2,u3,a3 四条 Message(边界不计入)
      expect(removedUuids.length).toBe(4)
      expect(removedUuids).toEqual([rows[2]!.uuid, rows[3]!.uuid, rows[4]!.uuid, rows[5]!.uuid] as string[])

      // 同实例内 load()/loadFullHistory() 立即裁短到 u2 之前
      expect(plain(await tr.load())).toEqual(plain([userText('u1'), asst('a1')]))
      expect(plain(await tr.loadFullHistory())).toEqual(plain([userText('u1'), asst('a1')]))

      // append-only:盘上原 6 行一字不少,只是新追加了一条 rewind-boundary
      const rawAfter = rawEntries(tr.path)
      expect(rawAfter.length).toBe(7)
      expect(rawAfter[6]!.type).toBe('rewind-boundary')
      expect(rawAfter[6]!.targetUuid).toBe(u2Uuid)
      expect(rawAfter[6]!.parentUuid).toBe(rows[1]!.uuid) // 接回 u2 前一条(a1)

      // 重开新实例(模拟进程重启):load()/loadFullHistory() 从盘重建后视图仍是裁短的
      const resumed = new Transcript(root, 'conv_rw1')
      expect(plain(await resumed.load())).toEqual(plain([userText('u1'), asst('a1')]))
      expect(plain(await resumed.loadFullHistory())).toEqual(plain([userText('u1'), asst('a1')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rewind 后 append 新消息:新消息 parentUuid 接对(=保留段最后一条),重建链正确', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rewind-append-'))
    try {
      const tr = new Transcript(root, 'conv_rw2')
      await tr.append([userText('u1'), asst('a1'), userText('u2'), asst('a2')])
      const rows = rawEntries(tr.path)
      const u2Uuid = rows[2]!.uuid as string
      const a1Uuid = rows[1]!.uuid as string

      await tr.rewindTo(u2Uuid)
      // 续接新一轮:u1,a1(保留段)+ 全新 u2'
      const kept = await tr.load()
      await tr.append([...kept, userText('u2-new')])

      expect(plain(await tr.load())).toEqual(plain([userText('u1'), asst('a1'), userText('u2-new')]))

      const rawAfter = rawEntries(tr.path)
      // 6(原 4 行 + 1 行 boundary)已有,追加 1 行新消息 = 6
      expect(rawAfter.length).toBe(6)
      const newMsgRow = rawAfter[5]!
      expect(newMsgRow.role).toBe('user')
      expect(newMsgRow.parentUuid).toBe(a1Uuid) // 接回保留段最后一条(a1),跳过中间的 rewind-boundary

      // 重建链正确:新实例 resume 也一致
      const resumed = new Transcript(root, 'conv_rw2')
      expect(plain(await resumed.load())).toEqual(plain([userText('u1'), asst('a1'), userText('u2-new')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rewind 跨 compact-boundary:回退到压缩点之前,load 应回到未压缩视图', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rewind-compact-'))
    try {
      const tr = new Transcript(root, 'conv_rw3')
      const history: Message[] = [userText('u0'), asst('a0'), userText('u1'), asst('a1')]
      await tr.append(history)
      const rowsBeforeCompact = rawEntries(tr.path)
      const u0Uuid = rowsBeforeCompact[0]!.uuid as string

      const postCompact: Message[] = [userText('[摘要] 前情'), userText('u2'), asst('a2')]
      await tr.recordCompaction(history, postCompact, { trigger: 'auto' })
      // 压缩后 load() 只看到摘要窗口
      expect(plain(await tr.load())).toEqual(plain(postCompact))

      // 回退到压缩点之前的 u0(压缩前历史里的第一条消息)
      const { removedUuids } = await tr.rewindTo(u0Uuid)
      // 移除段 = u0 起到当前 tip 的全部 Message:u0,a0,u1,a1(压缩前) + 摘要,u2,a2(压缩后) = 7 条
      expect(removedUuids.length).toBe(7)

      // load() 回到未压缩视图:压缩点已经不在活跃链上了(掰回到 u0 之前 = 空)
      expect(plain(await tr.load())).toEqual([])
      expect(plain(await tr.loadFullHistory())).toEqual([])

      // 续接新消息:parent 应为 null(目标是链首)
      await tr.append([userText('fresh-start')])
      const rawAfter = rawEntries(tr.path)
      expect(rawAfter.at(-1)!.parentUuid).toBeNull()
      expect(plain(await tr.load())).toEqual(plain([userText('fresh-start')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rewind 到链首:parentUuid=null,load() 归零;续接新消息 parent=null', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rewind-root-'))
    try {
      const tr = new Transcript(root, 'conv_rw4')
      await tr.append([userText('u1'), asst('a1'), userText('u2')])
      const rows = rawEntries(tr.path)
      const u1Uuid = rows[0]!.uuid as string

      const { removedUuids } = await tr.rewindTo(u1Uuid)
      expect(removedUuids.length).toBe(3) // u1,a1,u2 全部移除
      expect(plain(await tr.load())).toEqual([])

      const rawAfter = rawEntries(tr.path)
      expect(rawAfter.at(-1)!.type).toBe('rewind-boundary')
      expect(rawAfter.at(-1)!.parentUuid).toBeNull()

      await tr.append([userText('brand-new')])
      expect(plain(await tr.load())).toEqual(plain([userText('brand-new')]))
      const newRow = rawEntries(tr.path).at(-1)!
      expect(newRow.parentUuid).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('targetUuid 不在活跃链里抛错', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rewind-notfound-'))
    try {
      const tr = new Transcript(root, 'conv_rw5')
      await tr.append([userText('u1'), asst('a1')])
      await expect(tr.rewindTo('not-a-real-uuid')).rejects.toThrow('不在活跃链里')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('连续两次 rewind:第二次在第一次保留段内再回退一层,视图正确', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rewind-twice-'))
    try {
      const tr = new Transcript(root, 'conv_rw6')
      await tr.append([userText('u1'), asst('a1'), userText('u2'), asst('a2'), userText('u3'), asst('a3')])
      const rows = rawEntries(tr.path)
      const u3Uuid = rows[4]!.uuid as string
      const u2Uuid = rows[2]!.uuid as string

      await tr.rewindTo(u3Uuid) // 第一次:掰掉 u3,a3
      expect(plain(await tr.load())).toEqual(plain([userText('u1'), asst('a1'), userText('u2'), asst('a2')]))

      await tr.rewindTo(u2Uuid) // 第二次:在保留段里再掰掉 u2,a2
      expect(plain(await tr.load())).toEqual(plain([userText('u1'), asst('a1')]))

      // 重开实例验证持久化正确
      const resumed = new Transcript(root, 'conv_rw6')
      expect(plain(await resumed.load())).toEqual(plain([userText('u1'), asst('a1')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rewind 后 loadPage 的 seq 正确(按裁短后的活跃链重新编号)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-rewind-page-'))
    try {
      const tr = new Transcript(root, 'conv_rw7')
      await tr.append([userText('a'), asst('b'), userText('c'), asst('d')])
      const rows = rawEntries(tr.path)
      const cUuid = rows[2]!.uuid as string

      await tr.rewindTo(cUuid)
      const page = await tr.loadPage({ limit: 10 })
      expect(page.messages.map(r => [r.seq, r.message.content[0]])).toEqual([
        [1, textBlock('a')],
        [2, textBlock('b')],
      ])
      expect(page.hasMore).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('遗留无 uuid 戳的老格式文件续写:append 后 load() 仍看到全部老消息(重打戳成连续链,老裸行留痕)', async () => {
    // 现实场景:子代理/后台任务转录仍走默认 subdir 'transcripts' 老路径,可能有存量老格式(裸 {role,content},
    // 无 uuid/parentUuid 戳)文件被 resume。续写后老历史绝不能从活跃链上消失(回归:nearestMessageUuid 曾对
    // 无戳条目返回 undefined → 新消息 parentUuid=null → reconstructChain 从新 tip 回溯够不到老历史)。
    const root = mkdtempSync(join(tmpdir(), 'tr-legacy-'))
    try {
      const dir = join(root, 'transcripts')
      const legacyLines = [
        JSON.stringify({ role: 'user', content: [textBlock('old-u1')] }),
        JSON.stringify({ role: 'assistant', content: [textBlock('old-a1')] }),
      ].join('\n')
      await Bun.write(join(dir, 'legacy.jsonl'), `${legacyLines}\n`)

      const tr = new Transcript(root, 'legacy')
      const loaded = await tr.load()
      expect(plain(loaded)).toEqual(plain([userText('old-u1'), asst('old-a1')]))

      await tr.append([...loaded, userText('new-u2')])
      // 老消息全部保留 + 新消息续上(同实例)
      expect(plain(await tr.load())).toEqual(plain([userText('old-u1'), asst('old-a1'), userText('new-u2')]))

      // 盘上:2 行老裸行留痕(append-only 不删)+ 3 行重打戳的新链(old-u1', old-a1', new-u2')
      const rows = rawEntries(tr.path)
      expect(rows.length).toBe(5)
      expect(rows[0]!.uuid).toBeUndefined() // 老裸行原样未动
      expect(rows[1]!.uuid).toBeUndefined()
      expect(typeof rows[2]!.uuid).toBe('string') // 重打戳的链:null → old-u1' → old-a1' → new-u2'
      expect(rows[2]!.parentUuid).toBeNull()
      expect(rows[3]!.parentUuid).toBe(rows[2]!.uuid)
      expect(rows[4]!.parentUuid).toBe(rows[3]!.uuid)

      // 全新实例(模拟重启/另一进程 resume)从盘重建仍完整
      const resumed = new Transcript(root, 'legacy')
      expect(plain(await resumed.load())).toEqual(plain([userText('old-u1'), asst('old-a1'), userText('new-u2')]))
      expect(plain(await resumed.loadFullHistory())).toEqual(plain([userText('old-u1'), asst('old-a1'), userText('new-u2')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('遗留裸文件零新增直接 recordCompaction:loadFullHistory 仍看到压缩前全部消息(早退不绕过重打戳)', async () => {
    // 回归:append 的"无新增早退"(k >= messages.length)曾排在重打戳扫描之前——resume 老裸文件后零新增
    // 直接压缩时,append(history) 早退、重打戳不触发,boundary 的 parent 取链尾裸条目 `uuid ?? null` = null,
    // 压缩前历史从完整历史里消失。修后:等长全匹配且前缀有裸条目 → 也走重打戳;仅"传入严格更短"保留早退。
    const root = mkdtempSync(join(tmpdir(), 'tr-legacy-compact-'))
    try {
      const dir = join(root, 'transcripts')
      await Bun.write(join(dir, 'legacy.jsonl'), [
        JSON.stringify({ role: 'user', content: [textBlock('old-u1')] }),
        JSON.stringify({ role: 'assistant', content: [textBlock('old-a1')] }),
      ].join('\n') + '\n')

      const tr = new Transcript(root, 'legacy')
      const history = await tr.load()
      expect(plain(history)).toEqual(plain([userText('old-u1'), asst('old-a1')]))

      // 零新增,直接压缩(resume 后立即触发 auto-compact 的真实场景)
      await tr.recordCompaction(history, [userText('[摘要] 前情')], { trigger: 'auto' })

      // 完整历史 = 压缩前 2 条 + 摘要 1 条,一条不丢;load() 裁窗只回摘要
      expect(plain(await tr.loadFullHistory())).toEqual(plain([userText('old-u1'), asst('old-a1'), userText('[摘要] 前情')]))
      expect(plain(await tr.load())).toEqual(plain([userText('[摘要] 前情')]))

      // 盘上:2 裸行留痕 + 2 重打戳 + 1 boundary + 1 摘要 = 6 行;boundary 接上重打戳的 old-a1'
      const rows = rawEntries(tr.path)
      expect(rows.length).toBe(6)
      expect(rows[4]!.type).toBe('compact-boundary')
      expect(rows[4]!.parentUuid).toBe(rows[3]!.uuid)

      // 重启后仍完整
      const resumed = new Transcript(root, 'legacy')
      expect(plain(await resumed.loadFullHistory())).toEqual(plain([userText('old-u1'), asst('old-a1'), userText('[摘要] 前情')]))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('loadFullHistoryStamped 滤掉无戳裸条目;rewindTo 空目标直接拒(不诡异匹配裸行)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tr-bare-stamped-'))
    try {
      const dir = join(root, 'transcripts')
      await Bun.write(join(dir, 'bare.jsonl'), `${JSON.stringify({ role: 'user', content: [textBlock('x')] })}\n`)
      const tr = new Transcript(root, 'bare')
      // 全裸文件:stamped 读法不产出 uuid:undefined 的记录(裸条目没有 uuid 身份,没法作 rewind 目标)
      expect(await tr.loadFullHistoryStamped()).toEqual([])
      // 空/undefined 目标直接拒——findIndex 的 `e.uuid === undefined` 曾会匹配上第一条裸行
      await expect(tr.rewindTo(undefined as unknown as string)).rejects.toThrow('不能为空')
      await expect(tr.rewindTo('')).rejects.toThrow('不能为空')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
