import { registerBundledSkill } from '../bundledSkills.js'
import { BILLIARDS_KNOWLEDGE_FILES } from './billiardsKnowledge.js'

type BilliardsOperationsSkill = {
  name: string
  displayName: string
  description: string
  whenToUse: string
  prompt: string
}

const COMMON_INSTRUCTIONS = `## 共同工作方式

- 直接理解用户说的经营目标，由 Agent 在内部选择模型、工具、Skill、文件格式和技术实现。
- 先使用用户已经给出的信息并产出有用内容。缺失事实会明显改变结论或对外承诺时，把相关问题合并成一轮简短普通话。
- 用“已知事实 / 待确认 / 建议 / 下一步”区分信息，清楚标注知识资料、行业示例和本次推断。
- 需要球房经营方法时，先按需读取本 Skill 目录下的 references/README.md，再读取与当前任务直接相关的参考文件。
- 价格、日期、地址、人数、排班、薪酬、优惠、负责人、期限和对外承诺以用户或已核实资料为准。
- 默认先交付可检查的草稿。涉及对外发布、联系、付款或修改真实业务状态时，集中展示最终对象和内容，由用户确认本批执行范围。`

export const BILLIARDS_OPERATIONS_SKILLS: readonly BilliardsOperationsSkill[] = [
  {
    name: 'venue-daily-review',
    displayName: '复盘今天经营',
    description: '把球房营业数据和当天情况整理成看得懂、能继续跟进的经营复盘。',
    whenToUse: '用户要写店长日报、看营业数据、解释变化、找问题、复盘当天情况或安排下一营业日动作时使用。',
    prompt: `# 复盘今天经营

把用户已有的经营数据和当天事实整理成一份能继续跟进的日报或复盘。

1. 读取用户当前消息和明确指定的表格、文档或记录，先确认日期、门店、单位和统计口径。
2. 检查分项与合计、重复记录和前后可比性。无法核实的值标成待确认，不静默修改。
3. 只有口径一致时才计算环比、同比、占比或转化率。没有目标或对比期时，只描述现状，不硬说“异常”。
4. 按“经营概览、关键变化、可能原因、待确认问题、已处理事项、下一步动作”输出。原因必须与事实分开，负责人和期限只使用用户确认值。
5. 用户给了固定模板就保持字段和顺序；要求更新文件时保留原始数据和来源，不覆盖唯一原件。`,
  },
  {
    name: 'venue-campaign-planning',
    displayName: '策划门店活动',
    description: '围绕拉新、复购、空闲时段、比赛或节日目标做一套能落地的球房活动。',
    whenToUse: '用户要做球房活动、比赛、组局、拉新、复购、充值、节日营销、宣传文案或活动复盘时使用。',
    prompt: `# 策划门店活动

围绕一次明确的经营目标设计完整活动，不先套促销模板。

1. 从用户输入中提取目标、对象、时间、场地和人员条件、预算、容量、真实产品与可兑现权益。
2. 把“做个活动”转成可观察目标，再设计客户从看到内容、报名或到店、现场参与到后续跟进的完整路径。
3. 方案覆盖机制、规则、现场分工、容量、物资、成本风险和异常处理。缺少成本或容量时把可行性标为待确认。
4. 用户确认活动事实后，再准备渠道文案、员工口径和图片 Brief。需要海报时交给“做海报和图片”工作台 Skill；精确文字必须沿用已确认内容。
5. 选择少量可采集指标并说明来源和观察窗口。活动结束后分开写真实结果、执行偏差、用户反馈和下次调整。`,
  },
  {
    name: 'customer-follow-up',
    displayName: '跟进和维护客户',
    description: '根据真实到店和沟通记录准备一对一邀约、回访、复购和跟进安排。',
    whenToUse: '用户要整理客户情况、写邀约或回访话术、维护老客、安排跟进队列、组局邀请或复盘客户转化时使用。',
    prompt: `# 跟进和维护客户

把零散客户事实整理成有对象、有目的、有下一步的跟进安排。

1. 使用用户提供或指定资料中可核验的到店、消费、练球、沟通、权益和本人表达，以这些服务事实理解客户需求。
2. 先写每位客户的已知背景、这次联系目的和建议下一步，再写简短、自然、可修改的草稿。
3. 离店感谢、活动邀约、沉默客户唤回、真实评价邀请、组局和问题回访使用不同意图，为每位客户保留与本次目的相关的事实。
4. 价格、时间、地址、名额、规则和权益以真实可兑现内容为准；评价邀请围绕客户自愿分享的真实体验。
5. 默认交付待审核草稿和跟进队列。只有外部结果被真实读回或用户回填后，才能记录已发送、已回复或已预约。`,
  },
  {
    name: 'venue-inspection-followup',
    displayName: '巡店和整改',
    description: '把巡店记录、照片和现场问题整理成负责人、期限、验收证据与复查安排。',
    whenToUse: '用户要巡店、检查安全卫生或设备、整理现场照片、分派问题、催办整改、复查或生成闭环报告时使用。',
    prompt: `# 巡店和整改

把现场观察变成可以核验关闭的问题，不生成一张通用检查表就结束。

1. 从照片、录音转写、表格或记录中提取门店、区域、时间、可观察现象和已有处理。图片中看不到的内容标成未知。
2. 根据本次目标选择安全、环境、设备、前厅服务、库存、员工执行或客户体验等检查视角；未检查不等于合格。
3. 每个问题保留证据、实际影响、当前状态、建议动作和验收条件。优先级要能回溯到现场影响或用户规则。
4. 避免“加强管理”这类无法验收的表述。停机、采购、处罚或对外沟通只作为待确认建议。
5. 只有新的复查证据或用户明确回填后才标记完成；需要持续跟踪时更新用户指定的同一事实源。`,
  },
  {
    name: 'staff-performance-coaching',
    displayName: '带教和辅导员工',
    description: '依据真实岗位和表现记录准备一对一沟通、训练、复查与公平的团队激励。',
    whenToUse: '用户要带教店长、教练、助教、前厅或服务人员，分析表现、准备沟通、安排训练、设目标或设计团队激励时使用。',
    prompt: `# 带教和辅导员工

把真实工作表现转成具体反馈、练习和复查。

1. 从岗位要求、排班、服务反馈、训练记录和经营数据中提取观察周期、已约定目标和具体行为，区分事实、管理者观察、员工自述和待确认信息。
2. 使用“情境—行为—影响—下一步”准备沟通：先肯定有证据的有效行为，再说明需要改善的具体动作和影响。
3. 把目标拆成员工能练习、管理者能观察的动作，安排示范、演练、现场反馈和复查。员工有不同解释时保留分歧并建议补证。
4. 评价依据岗位职责、可观察行为、数据来源和双方已确认的工作目标。涉及薪酬、处分或解聘时，把事实和建议交给负责人按本店真实制度决定。
5. 用户明确要设计激励时，先确认参与对象、周期、指标来源、可控性、预算和异常处理，再组合服务、协作、销售与改进等指标。`,
  },
] as const

export function registerBilliardsOperationsSkills(): void {
  for (const skill of BILLIARDS_OPERATIONS_SKILLS) {
    const content = `${skill.prompt}\n\n${COMMON_INSTRUCTIONS}`
    registerBundledSkill({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      allowedTools: ['Read', 'Grep', 'Glob'],
      userInvocable: true,
      files: BILLIARDS_KNOWLEDGE_FILES,
      desktopDiscovery: {
        displayName: skill.displayName,
        content,
      },
      async getPromptForCommand(args) {
        return [{
          type: 'text',
          text: args.trim()
            ? `${content}\n\n## 用户这次的要求\n\n${args.trim()}`
            : content,
        }]
      },
    })
  }
}
