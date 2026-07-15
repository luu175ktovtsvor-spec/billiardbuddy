// 内置经营工作流定义。原则:只读现有资料、产物落盘、不对外发送、缺关键事实列「待确认」而不是编造。
// 对外发送/发布类动作不进入内置工作流,须由用户在会话里逐条确认后执行。

import type { WorkflowDefinition } from '../../shared/contracts/workflows'

export const bundledWorkflowDefinitions: WorkflowDefinition[] = [
  {
    id: 'venue-daily-report',
    name: '营业日报',
    description: '从工作目录的真实经营资料整理当日情况,生成可核对的日报文件。适合配合定时任务在打烊后自动运行。',
    billiardsMode: true,
    source: 'bundled',
    steps: [
      {
        id: 'collect',
        title: '收集当日资料',
        instruction: [
          '在当前工作目录内查找与今天(以系统日期为准)相关的经营资料:营业数据、台费/助教/商品流水、交接班记录、值班备注等。',
          '只使用真实存在的文件内容,逐项列出:今日关键数字、与近期相比的异常点、缺失的资料。',
          '任何拿不到的数字一律标注「待确认」,严禁估算或编造。不要修改任何原始文件。',
        ].join('\n'),
      },
      {
        id: 'draft',
        title: '生成日报草稿',
        instruction: [
          '基于上一步收集到的事实,撰写一份门店营业日报,包含:当日概况、关键数字、异常与原因线索、待办与建议。',
          '所有「待确认」项原样保留在日报中,单独列一节,不要用推测填充。',
          '把日报保存为工作目录下的新 Markdown 文件(文件名含日期,例如 日报-YYYY-MM-DD.md),不要覆盖已有文件。',
        ].join('\n'),
      },
      {
        id: 'verify',
        title: '核对数字与收尾',
        instruction: [
          '打开刚生成的日报文件,逐项对照第一步收集到的原始资料核对数字;发现不一致就修正日报并说明修正原因。',
          '最后输出:日报文件路径、核对结论(哪些数字有原始依据、哪些仍待确认)、建议明天跟进的事项。',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'recruitment-daily-prep',
    name: '招聘每日准备',
    description: '梳理今日待跟进候选人并准备话术草稿(只生成草稿,不发送)。发送动作由用户在 BOSS 官方产品内自行完成或在会话中逐条确认。',
    billiardsMode: true,
    source: 'bundled',
    steps: [
      {
        id: 'review',
        title: '梳理今日待跟进',
        instruction: [
          '调用 recruitment_list_candidates(due_today=true) 获取今日到期和逾期的候选人队列,再调用 recruitment_funnel_report 看整体漏斗与岗位缺口。',
          '整理出今日应跟进的候选人清单,按截止时间排序,标注每人当前阶段和下一步动作。',
          '若招聘记录为空:如实说明,并提示用户可以在对话里让管家登记岗位缺口和候选人;不要虚构候选人,也不要另建平行的表格文件。',
        ].join('\n'),
      },
      {
        id: 'draft',
        title: '准备跟进话术草稿',
        instruction: [
          '为上一步队列中每位需要联系的候选人起草一条跟进消息:称呼具体、说明来意、给出明确的下一步(如邀约到店时间)。',
          '工资、排班、门店地址等必须逐字准确的信息,只使用招聘记录和门店资料中真实存在的内容;没有的写「【待补充】」占位。',
          '每条草稿用 recruitment_save_draft 保存到对应候选人名下。只生成草稿,严禁尝试向任何外部平台发送消息,也不要把草稿标记为已发送。',
        ].join('\n'),
      },
      {
        id: 'summary',
        title: '汇总今日清单',
        instruction: [
          '输出今日招聘跟进摘要:待跟进人数、已保存草稿数、其中含「待补充」占位的条目、逾期最久的候选人,以及建议用户优先处理的前三件事。',
          '提醒用户:在 BOSS 官方产品里发送后,把结果告诉管家即可回填状态(有发送证据记 sent,没有记 uncertain)。',
        ].join('\n'),
      },
    ],
  },
]
