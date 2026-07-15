import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecruitmentService } from './recruitmentService'
import { createRecruitmentTools } from './recruitmentTools'

async function makeTools() {
  const service = new RecruitmentService(await mkdtemp(join(tmpdir(), 'recruitment-tools-')))
  const tools = createRecruitmentTools(service)
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return { service, byName }
}

describe('recruitment tools', () => {
  it('注册九个窄工具,读写属性正确', async () => {
    const { byName } = await makeTools()
    expect([...byName.keys()].sort()).toEqual([
      'recruitment_add_candidates',
      'recruitment_funnel_report',
      'recruitment_list_candidates',
      'recruitment_list_drafts',
      'recruitment_save_draft',
      'recruitment_set_followup',
      'recruitment_update_draft',
      'recruitment_update_stage',
      'recruitment_upsert_position',
    ])
    expect(byName.get('recruitment_list_candidates')!.isReadOnly).toBe(true)
    expect(byName.get('recruitment_funnel_report')!.isReadOnly).toBe(true)
    expect(byName.get('recruitment_add_candidates')!.isReadOnly).toBe(false)
  })

  it('端到端一条链:登记→草稿→回填 sent(带证据)→漏斗', async () => {
    const { byName } = await makeTools()
    const added = JSON.parse(await byName.get('recruitment_add_candidates')!.execute({
      candidates: [{ name: '张三', position: '助教', external_ref: '张三·前台教练·5年经验', next_action: '发送首聊', next_action_due: '2026-07-16T10:00:00.000Z' }],
    }, {} as never) as string) as { added: Array<{ id: string }> }
    const candidateId = added.added[0]!.id

    const draft = JSON.parse(await byName.get('recruitment_save_draft')!.execute({
      candidate_id: candidateId,
      content: '您好,看到您有教练经验,我们球房在招助教,方便聊聊吗?',
    }, {} as never) as string) as { id: string; status: string }
    expect(draft.status).toBe('drafted')

    const sent = JSON.parse(await byName.get('recruitment_update_draft')!.execute({
      draft_id: draft.id,
      status: 'sent',
      evidence: 'BOSS 会话中可见该消息已发出(用户回填)',
    }, {} as never) as string) as { status: string }
    expect(sent.status).toBe('sent')

    const report = JSON.parse(await byName.get('recruitment_funnel_report')!.execute({}, {} as never) as string) as { totalCandidates: number }
    expect(report.totalCandidates).toBe(1)
  })

  it('sent 无证据被拒绝(确定性闸,模型跳步也拦得住)', async () => {
    const { byName } = await makeTools()
    const added = JSON.parse(await byName.get('recruitment_add_candidates')!.execute({
      candidates: [{ name: '李四', position: '店长' }],
    }, {} as never) as string) as { added: Array<{ id: string }> }
    const draft = JSON.parse(await byName.get('recruitment_save_draft')!.execute({
      candidate_id: added.added[0]!.id,
      content: '草稿',
    }, {} as never) as string) as { id: string }
    expect(byName.get('recruitment_update_draft')!.execute({ draft_id: draft.id, status: 'sent' }, {} as never))
      .rejects.toThrow('读回证据')
  })

  it('非法参数在工具边界被拒(空数组、未知 stage)', async () => {
    const { byName } = await makeTools()
    expect(byName.get('recruitment_add_candidates')!.execute({ candidates: [] }, {} as never))
      .rejects.toThrow('参数不合法')
    expect(byName.get('recruitment_update_stage')!.execute({ candidate_id: 'x', stage: 'ghosted' }, {} as never))
      .rejects.toThrow('参数不合法')
  })

  it('今日队列走 due_today 过滤', async () => {
    const { byName } = await makeTools()
    await byName.get('recruitment_add_candidates')!.execute({
      candidates: [
        { name: '甲', position: '助教', next_action_due: '2020-01-01T00:00:00.000Z' },
        { name: '乙', position: '助教', next_action_due: '2099-01-01T00:00:00.000Z' },
      ],
    }, {} as never)
    const due = JSON.parse(await byName.get('recruitment_list_candidates')!.execute({ due_today: true }, {} as never) as string) as { count: number; candidates: Array<{ name: string }> }
    expect(due.count).toBe(1)
    expect(due.candidates[0]!.name).toBe('甲')
  })
})
