// 台球运营领域包 · 硬数字「单一可信源」
//
// 来源铁律:本文件是 16 条可核对硬规则/硬数字的唯一转录源,逐条点回
//   `~/Desktop/球房-PPT底本-本地存档/PPT硬规则对照表.md`(带 PPT 行号)。
// 其它知识只 **引用** 本文件(按 id),不各自抄硬数字,避免"改一处漏三处"漂移。
// 行号 = `PPT原件全文-台球房运营7.23.txt` 的文本行号(可 `awk 'NR==N'` 定位);page = PPT 原页码。
//
// ⚠️ 金额/档位类是"参考值",因城市/门店差异自定;系数/占比/平台上限类是 PPT 写死值。
//   每条 kind 标明,别把参考档位当成必须照抄的死数。

export type HardSpecKind = 'fixed' | 'reference'

export interface HardSpec {
  /** 对照表编号 1-16,稳定不变,供其它知识按 id 引用。 */
  id: number
  category: string
  /** 硬规则一句话。 */
  rule: string
  /** PPT 出处:文本行号(可含范围)+ 原页码。 */
  ppt: { line: string; page: string }
  /** PPT 原文节录(剥离第三方专名后)。 */
  quote: string
  /** fixed = PPT 写死值照用;reference = 参考值,门店可自定。 */
  kind: HardSpecKind
  /** 落地口径提醒(避免误用)。 */
  note?: string
}

export const HARD_SPECS: HardSpec[] = [
  // 一、定价 / 产品结构
  {
    id: 1,
    category: '定价/产品结构',
    rule: '引流台数量占大厅球台的 1/4 ~ 1/5',
    ppt: { line: '422', page: '76' },
    quote: '引流价格 引流台数量占比大厅球台数量的 1/4 或 1/5',
    kind: 'fixed',
    note: '说的是"引流台台数占比",不是"引流产品/团购数量占比",别混。',
  },
  {
    id: 2,
    category: '定价/产品结构',
    rule: '价格尾数"8"调为"9"',
    ppt: { line: '425', page: '76' },
    quote: '小技巧:价格尾数"8" 调为"9"',
    kind: 'fixed',
  },
  {
    id: 3,
    category: '定价/产品结构',
    rule: '团购品类减至 4-5 个、集中做爆款',
    ppt: { line: '395、397', page: '70' },
    quote: '团购品类优化,设置爆款产品;团购产品类别减少至 4-5 个,品类太多不利于爆款单量积累',
    kind: 'fixed',
  },
  // 二、充值 / 会员卡
  {
    id: 4,
    category: '充值/会员卡',
    rule: '会员卡改一卡通(取消大额充赠锁客)',
    ppt: { line: '385、423', page: '68/76' },
    quote: '会员卡已经不能成为锁客手段……建议会员卡取消,全部改为一卡通;充值体系 一卡通,送器材券,促进客户多维度消费',
    kind: 'fixed',
  },
  {
    id: 5,
    category: '充值/会员卡',
    rule: '一卡通参考档位:充1000送99 / 充3000送399 / 充5000送799 / 充10000送1999',
    ppt: { line: '386-387', page: '68' },
    quote: '充1000送99元 充3000送399元 充5000送799元 充10000送1999元',
    kind: 'reference',
    note: '参考档位,因城市/门店自定。本金全场可用,赠送金额仅限台位费(PPT 388 行)。',
  },
  // 三、平台运营 / 评分 / 好评
  {
    id: 6,
    category: '平台运营/评分',
    rule: '美团金牌店铺三条件:经营评分≥80 + 星级≥4 + 大众点评≥3.5',
    ppt: { line: '909-912', page: '113' },
    quote: '美团金牌店铺达成条件:美团经营评分≥80、星级≥4、大众点评星级≥3.5',
    kind: 'fixed',
  },
  {
    id: 7,
    category: '平台运营/评分',
    rule: '美团评分档:及格 4.6 / 良好 4.8 / 优秀 4.9',
    ppt: { line: '890', page: '111' },
    quote: '及格4.6 ;良好4.8 ;优秀4.9',
    kind: 'fixed',
  },
  {
    id: 8,
    category: '平台运营/好评',
    rule: '好评每日节奏(平台上限):美团每日 ≤10 条、大众点评每日 ≤5 条',
    ppt: { line: '960、966', page: '118/119' },
    quote: '美团每日评价不超过10条;(大众点评)3张图片+15个文字,每日最多5条',
    kind: 'fixed',
  },
  {
    id: 9,
    category: '平台运营/好评',
    rule: '好评日目标示例(某店日报样本):抖音 6 / 美团 8 / 大众 3',
    ppt: { line: '1812', page: '234' },
    quote: '好评:抖音6条 美团 8条 大众3条',
    kind: 'reference',
    note: '这是日目标示例值,不是平台上限;别写成"抖音全要/不限"。',
  },
  {
    id: 10,
    category: '平台运营/好评',
    rule: '养评操作要求:3 张图 + 字数≥15 + 关 WiFi + 关定位 + 多视角;同账号隔天评、验券后隔 20 分钟再评',
    ppt: { line: '936、943-944、951、966', page: '116/117' },
    quote: '关掉定位、断开WiFi、三张图片、多个视角、15字以上;下次评价最少要隔天进行;验券后需间隔20分钟以后进行评价',
    kind: 'fixed',
    note: '口径:只禁批量假号机刷/买好评;放行引导真实到店客户按平台规则评价。',
  },
  {
    id: 11,
    category: '平台运营/好评',
    rule: '开业刷团购节奏:第1天7单→第2天8-9→4天后稳定13-15,连刷7天;7天后评分≥4.2,后每天涨0.1,两周达4.7-4.8',
    ppt: { line: '819', page: '105' },
    quote: '助教小组轮流买券刷团购评分,第一天7单,第二天8-9单,四天后稳定在13-15单,连续刷7天。新店7天后评分不会低于4.2分……',
    kind: 'fixed',
    note: '"刷团购"= 助教小组真实到店买券按规则评价养分,不是假号机刷。',
  },
  // 四、人员配置 / 助教激励 / PK
  {
    id: 12,
    category: '人员配置',
    rule: '人员配置(约45台规模最小配置):店长1 + 前厅主管1 + 助教管理≥3 + 教练2 + 保洁3;满编另含助教40/前台组长3/服务生16/收银4',
    ppt: { line: '291、766-779', page: '49/96' },
    quote: '店长1名/前厅主管1名/助教管理至少3名/教练2名/保洁3名;满编:助教40名、前台组长3名、服务生16名、收银4名',
    kind: 'reference',
    note: '291 行为满编满岗,766-779 为开业期分阶段到位的最小配置;按规模分档。',
  },
  {
    id: 13,
    category: '助教激励',
    rule: '助教月业绩奖励阶梯:当月总业绩 >170h 奖 500 / >200h 奖 1000 / >230h 奖 1500',
    ppt: { line: '2149', page: '277' },
    quote: '当月总业绩超过170小时奖励500元;超过200小时奖励1000元;超过230小时奖励1500元',
    kind: 'reference',
    note: '参考值,因城市差异大、门店自定。',
  },
  {
    id: 14,
    category: '助教激励',
    rule: '助教 PK 系数(陪打时长第一名):日 ×0.2 / 周 ×0.3 / 月 ×0.5(每月最后一天除外)',
    ppt: { line: '2150-2152', page: '277' },
    quote: '当月个人日陪打时长第一名奖励所有助教当月总陪打时长*0.2元;周*0.3元;月*0.5元(每月最后一天除外)',
    kind: 'fixed',
    note: '系数为 PPT 写死值;金额随门店实际陪打时长计算。',
  },
  // 五、活动 / 竞技局
  {
    id: 15,
    category: '活动/竞技局',
    rule: '抢一大战:报名费 10 元、奖金 200-500 元、下午两点/晚上七点开、提前预热、让条件',
    ppt: { line: '1761-1766', page: '226' },
    quote: '抢一大战;报名费十元;奖金200—500;下午两点;晚上七点;提前预热;让条件',
    kind: 'reference',
    note: '奖金为区间参考,具体门店定。让条件=增加偶然性、拉平水平差。',
  },
  // 六、营销底层方法论
  {
    id: 16,
    category: '营销方法论',
    rule: '营销方程式(本质四步):识别 → 创造 → 传播 → 交付',
    ppt: { line: '36-37', page: '7' },
    quote: '营销的本质:识别——创造——传播——交付',
    kind: 'fixed',
    note: '与战略层"营+销"框架同源(第 9 页起)。',
  },
]

const HARD_SPEC_BY_ID = new Map<number, HardSpec>(HARD_SPECS.map(spec => [spec.id, spec]))

export function hardSpec(id: number): HardSpec | undefined {
  return HARD_SPEC_BY_ID.get(id)
}

/** 按关键词粗筛相关硬数字(供 billiards_ops_checklist 工具按场景带出)。 */
export function findHardSpecs(query: string): HardSpec[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const KEYWORDS: Record<string, number[]> = {
    定价: [1, 2], 价格: [1, 2], 引流台: [1], 团购: [3, 11], 爆款: [3],
    充值: [4, 5], 会员: [4, 5], 一卡通: [4, 5],
    评分: [6, 7], 金牌: [6], 好评: [8, 9, 10, 11], 评价: [8, 9, 10], 刷: [10, 11], 开业: [11],
    人员: [12], 配置: [12], 招聘: [12], 排班: [12],
    助教: [13, 14], 激励: [13, 14], 奖励: [13, 14], pk: [14], 陪打: [14],
    活动: [15], 抢一: [15], 比赛: [15], 赛事: [15],
    营销: [16], 定位: [16],
  }
  const ids = new Set<number>()
  for (const [key, list] of Object.entries(KEYWORDS)) {
    if (q.includes(key)) list.forEach(id => ids.add(id))
  }
  return [...ids].sort((a, b) => a - b).map(id => HARD_SPEC_BY_ID.get(id)!).filter(Boolean)
}

/** 渲染一条硬数字为带出处的一行文本。 */
export function formatHardSpec(spec: HardSpec): string {
  const tag = spec.kind === 'fixed' ? 'PPT写死' : '参考值'
  return `[#${spec.id} ${spec.category}·${tag} | PPT ${spec.ppt.line}行/第${spec.ppt.page}页] ${spec.rule}${spec.note ? `(${spec.note})` : ''}`
}
