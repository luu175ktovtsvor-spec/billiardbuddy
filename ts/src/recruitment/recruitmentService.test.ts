import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecruitmentDataCorruptedError, RecruitmentService } from './recruitmentService'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'recruitment-'))
}

describe('RecruitmentService', () => {
  it('登记候选人:落盘、revision 递增、审计日志追加', async () => {
    const root = await tempRoot()
    const service = new RecruitmentService(root)
    const result = await service.addCandidates([
      { name: '张三', position: '助教', nextAction: '首聊', nextActionDue: '2026-07-17T10:00:00.000Z' },
    ])
    expect(result.added).toHaveLength(1)
    expect(result.added[0]!.stage).toBe('contacted')
    expect(result.added[0]!.stageHistory).toHaveLength(1)

    const persisted = JSON.parse(await readFile(join(root, 'recruitment', 'recruitment.json'), 'utf8')) as { revision: number; candidates: unknown[] }
    expect(persisted.revision).toBe(1)
    expect(persisted.candidates).toHaveLength(1)
    const audit = await readFile(join(root, 'recruitment', 'recruitment-audit.jsonl'), 'utf8')
    expect(audit).toContain('add_candidates')
  })

  it('去重:同名同岗位且未关闭的候选人不重复建;关闭后可重新登记', async () => {
    const service = new RecruitmentService(await tempRoot())
    const first = await service.addCandidates([{ name: '李四', position: '店长' }])
    const dup = await service.addCandidates([{ name: ' 李四 ', position: '店长' }])
    expect(dup.added).toHaveLength(0)
    expect(dup.duplicates).toEqual([{ name: '李四', position: '店长', existingId: first.added[0]!.id }])

    await service.updateStage(first.added[0]!.id, 'closed', { note: '未到店' })
    const again = await service.addCandidates([{ name: '李四', position: '店长' }])
    expect(again.added).toHaveLength(1)
  })

  it('阶段流转留痕并可同步更新下一步', async () => {
    const service = new RecruitmentService(await tempRoot())
    const { added } = await service.addCandidates([{ name: '王五', position: '助教' }])
    const updated = await service.updateStage(added[0]!.id, 'invited', {
      note: '同意周五面试',
      nextAction: '周五 14:00 到店面试',
      nextActionDue: '2026-07-18T06:00:00.000Z',
    })
    expect(updated.stage).toBe('invited')
    expect(updated.stageHistory.map(event => event.stage)).toEqual(['contacted', 'invited'])
    expect(updated.stageHistory[1]!.note).toBe('同意周五面试')
    expect(updated.nextAction).toBe('周五 14:00 到店面试')
  })

  it('今日跟进队列:只含到期/逾期且未入职未关闭,按截止时间排序', async () => {
    const now = Date.parse('2026-07-16T04:00:00.000Z')
    const service = new RecruitmentService(await tempRoot(), { now: () => now })
    const { added } = await service.addCandidates([
      { name: 'A', position: '助教', nextActionDue: '2026-07-16T02:00:00.000Z' },
      { name: 'B', position: '助教', nextActionDue: '2026-07-10T02:00:00.000Z' },
      { name: 'C', position: '助教', nextActionDue: '2026-09-01T02:00:00.000Z' },
      { name: 'D', position: '助教' },
      { name: 'E', position: '助教', nextActionDue: '2026-07-10T01:00:00.000Z', stage: 'hired' },
    ])
    expect(added).toHaveLength(5)
    const due = await service.listCandidates({ dueOnly: true })
    expect(due.map(candidate => candidate.name)).toEqual(['B', 'A'])
  })

  it('草稿闸:sent 必须带证据,否则拒绝;uncertain 不需要', async () => {
    const service = new RecruitmentService(await tempRoot())
    const { added } = await service.addCandidates([{ name: '赵六', position: '服务员' }])
    const draft = await service.saveDraft(added[0]!.id, '您好,我们是 XX 球房,想约您聊聊服务员岗位。')
    expect(draft.status).toBe('drafted')

    expect(service.updateDraftStatus(draft.id, 'sent')).rejects.toThrow('读回证据')
    expect(service.updateDraftStatus(draft.id, 'sent', '   ')).rejects.toThrow('读回证据')

    const uncertain = await service.updateDraftStatus(draft.id, 'uncertain')
    expect(uncertain.status).toBe('uncertain')
    const sent = await service.updateDraftStatus(draft.id, 'sent', '官方 App 会话中可见已发出该消息(2026-07-16 12:01)')
    expect(sent.status).toBe('sent')
    expect(sent.evidence).toContain('已发出')
  })

  it('草稿必须挂在真实候选人上', async () => {
    const service = new RecruitmentService(await tempRoot())
    expect(service.saveDraft('missing', '内容')).rejects.toThrow('候选人不存在')
  })

  it('岗位按名称 upsert,漏斗统计到期数与入职对缺口', async () => {
    const now = Date.parse('2026-07-16T04:00:00.000Z')
    const service = new RecruitmentService(await tempRoot(), { now: () => now })
    await service.upsertPosition('助教', 2)
    await service.upsertPosition(' 助教 ', 1, '暑期缺口')
    const positions = await service.listPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0]!.openings).toBe(1)

    const { added } = await service.addCandidates([
      { name: 'A', position: '助教', stage: 'hired' },
      { name: 'B', position: '助教', nextActionDue: '2026-07-01T00:00:00.000Z' },
    ])
    expect(added).toHaveLength(2)
    const report = await service.funnelReport()
    expect(report.totalCandidates).toBe(2)
    expect(report.stageCounts.hired).toBe(1)
    expect(report.overdueFollowups).toBe(1)
    expect(report.positions).toEqual([{ title: '助教', openings: 1, hired: 1 }])
  })

  it('数据文件损坏时失败关闭:读写都报错,不静默清空', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'recruitment'), { recursive: true })
    await writeFile(join(root, 'recruitment', 'recruitment.json'), '{broken', 'utf8')
    const service = new RecruitmentService(root)
    expect(service.listCandidates()).rejects.toBeInstanceOf(RecruitmentDataCorruptedError)
    expect(service.addCandidates([{ name: 'X', position: 'Y' }])).rejects.toBeInstanceOf(RecruitmentDataCorruptedError)
    // 原文件保持原样,未被覆盖。
    expect(await readFile(join(root, 'recruitment', 'recruitment.json'), 'utf8')).toBe('{broken')
  })
})
