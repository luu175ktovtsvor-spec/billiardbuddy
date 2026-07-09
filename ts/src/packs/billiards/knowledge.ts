// 台球运营领域包 · 5 域结构化知识(PPT-only,每条带 PPT 行号出处)
//
// 铁律:每条 points 都来自 `PPT原件全文-台球房运营7.23.txt` 原文,src 标文本行号+页码,可回溯审计。
//   PPT 没有的(借鉴/衍生/杜撰)一律不写。第三方门店名/人名/城市/机构名已全部脱敏,只搬逻辑。
//   硬数字不在此各自抄,统一引用 hardSpecs.ts 的 id(见 hardSpecRefs)。
//
// freedom 三分层(沿用老结构):
//   skeleton   = 骨架/框架(可让模型据此自延伸场景)
//   red_line   = 红线/底线(措辞与边界要守)
//   hard_number= 挂硬数字(细节以 hardSpecs.ts 为准)

export type BilliardsDomain =
  | 'marketing'      // 营销:定位/定价/产品促销/传播
  | 'customer-ops'   // 客户运营:分类/转化/私域/前厅
  | 'talent-mgmt'    // 人才管理:助教体系/店长/组织
  | 'strategy'       // 战略:营销方程式/营vs销/行业分析
  | 'data-analysis'  // 数据分析:目标/复盘/ROI/控场

export type Freedom = 'skeleton' | 'red_line' | 'hard_number'

export interface KnowledgeEntry {
  id: string
  domain: BilliardsDomain
  freedom: Freedom
  title: string
  /** 每条要点用 PPT 原文措辞,不改写成营销腔。 */
  points: string[]
  /** PPT 出处:文本行号(可含范围)+ 页码。 */
  src: { line: string; page: string }
  /** 引用的硬数字 id(细节以 hardSpecs.ts 为准,不在此重抄)。 */
  hardSpecRefs?: number[]
}

export const DOMAIN_META: Record<BilliardsDomain, { name: string; blurb: string }> = {
  marketing: { name: '营销', blurb: '定位定江山、定价定生死;产品促销要目标导向;传播靠平台矩阵 + 内容两型' },
  'customer-ops': { name: '客户运营', blurb: '四大类客户差异化;引流→服务→转化→复购→裂变闭环' },
  'talent-mgmt': { name: '人才管理', blurb: '助教体系(招-育-用-留)+ 上钟 SOP + 店长五大能力' },
  strategy: { name: '战略', blurb: '营销方程式 识别→创造→传播→交付;营(战略)vs 销(执行)' },
  'data-analysis': { name: '数据分析', blurb: '定目标→跟踪→复盘;ROI 经营表;控场只控金额不坐庄' },
}

export const KNOWLEDGE: KnowledgeEntry[] = [
  // ───────── marketing 营销 ─────────
  {
    id: 'mkt-misconception', domain: 'marketing', freedom: 'skeleton',
    title: '营销的误解',
    points: ['把"抖音达人、美团、抖音团购、地推、充值大额赠送、点助教免台费、免费畅打"当成营销本身,其实这些只是手段。'],
    src: { line: '27-30', page: '6' },
  },
  {
    id: 'mkt-positioning-types', domain: 'marketing', freedom: 'skeleton',
    title: '球房定位四类型',
    points: [
      '球房定位分四类:社区球房、竞技商业球房、竞技球房、商业球房;结合一线到五线城市来定。',
      '定位=给客户一个买我们的理由,是针对竞争对手在客户头脑里建立的优势位置(定位理论)。',
      '"定位定江山"。',
    ],
    src: { line: '186-202、256', page: '23/25/36' },
  },
  {
    id: 'mkt-pricing-core', domain: 'marketing', freedom: 'hard_number',
    title: '定价定生死·四个核心',
    points: [
      '"定价定生死";台球俱乐部四大盈利点=台费、商品费、器材费、助教管理费,先想清哪个定价最重要。',
      '定价四核心:分区定价(引流区/贵宾区/竞技区/包厢)、标准价格(对标同行)、引流价格、充值体系(一卡通、送器材券)。',
      '不建议大额赠送活动;价格尾数"8"调为"9"。',
      '定价常见病:定价过高/过低、竞争压力大就大幅降价、长期促销(伤价格体系)。',
    ],
    src: { line: '274-286、419-425', page: '39/41/62' },
    hardSpecRefs: [1, 2, 4, 5],
  },
  {
    id: 'mkt-promo', domain: 'marketing', freedom: 'skeleton',
    title: '产品促销·目标导向',
    points: [
      '促销的目的="我想让谁干什么"(目标导向,不是无脑打折)。',
      '促销操作:助教免费体验(首单养消费习惯)、充值送器材券(培养兴趣)、入会赠器材(提高沉没成本、增强粘性)。',
      '注意:"助教免费体验"是拉新促销手段,与"把助教服务写成免费/赠品"是两回事,别混。',
    ],
    src: { line: '434-447', page: '64/65' },
  },
  {
    id: 'mkt-two-selling-points', domain: 'marketing', freedom: 'skeleton',
    title: '两大卖点·氛围与人情世故',
    points: [
      '台球俱乐部两大卖点:氛围、人情世故。',
      '氛围靠感官营造:听觉(音乐)、触觉(温度)、视觉(人气)、嗅觉(香氛)。',
      '商业俱乐部氛围主要取决于助教数量,竞技俱乐部氛围主要取决于竞技客户基数。',
    ],
    src: { line: '454-480', page: '67/68/70-72' },
  },
  {
    id: 'mkt-channel-matrix', domain: 'marketing', freedom: 'skeleton',
    title: '传播·平台矩阵与内容两型',
    points: [
      '传播两大阵地:本地生活(美团、大众点评、抖音本地推、达人)+ 内容平台(抖音矩阵、交友软件、快手、视频号、小红书)。',
      '线上曝光四目的:品牌曝光、流量拉新、用户互动、直接转化。',
      '内容两型:流量型走"擦边",获客型讲"产品卖点"。',
      '本地同城靠员工抖音矩阵 + 门店本地推;做好 5 公里内流量导入(小城市做本地网红、大城市做区域网红)。',
      '品牌传播三部曲:差异化、重复性(反复抢占心智)、高感知。',
    ],
    src: { line: '534-595', page: '77-87' },
  },
  {
    id: 'mkt-groupbuy', domain: 'marketing', freedom: 'hard_number',
    title: '团购优化·做爆款',
    points: ['抖音、美团团购品类优化、设置爆款产品;团购品类减至 4-5 个,品类太多不利于爆款单量积累。'],
    src: { line: '394-397', page: '70' },
    hardSpecRefs: [3],
  },

  // ───────── customer-ops 客户运营 ─────────
  {
    id: 'cus-four-types', domain: 'customer-ops', freedom: 'skeleton',
    title: '四大类客户·特点与核心需求',
    points: [
      '四大类客户:散客(消费弱、频次低)、竞技客户、助教客户、追分客户。',
      '核心需求:散客要线下社交、竞技客户要技术交流、助教客户要异性情绪价值、追分客户要赢钱。',
      '维护误区:以貌取人、看到 9.9 的客户就反感不维护;在大客户身上投入精力过大;防止钓鱼客户、防止教练员同流合污。',
    ],
    src: { line: '498-530', page: '75/76' },
  },
  {
    id: 'cus-loop', domain: 'customer-ops', freedom: 'skeleton',
    title: '客户运营五步闭环',
    points: [
      '客户运营闭环:引流→服务→裂变→转化→复购。',
      '引流四误区:点助教免台费(把助教当陪打)、开业免费畅打(吸引不到优质客户)、大额充值赠送(留不住客户)、开业前低价预充值(客户质量不高)。',
      '球房引流四路:助教引流、管理层引流、团购、线上曝光(分员工引流与门店引流)。',
    ],
    src: { line: '835-872', page: '108-110' },
  },
  {
    id: 'cus-drainage-link', domain: 'customer-ops', freedom: 'skeleton',
    title: '助教/教练引流链路',
    points: [
      '助教引流核心链路:公域引流→私域导流→社群维护(抖音短视频+直播、交友软件加好友)。',
      '教练引流核心链路:客户身份→熟悉客户→引导到店(进同行店消费、结交打球搭子)。',
    ],
    src: { line: '876-886', page: '111/112' },
  },
  {
    id: 'cus-conversion', domain: 'customer-ops', freedom: 'red_line',
    title: '客户转化流程与要点',
    points: [
      '三种球房转化逻辑:商业球房(散客→助教/竞技)、竞技球房(散客→竞技→朋友)、社区球房(散客→朋友)。',
      '客户转化流程五步:管理层接待→引导到台→过程互动→二次邀约→客户反馈;管理层接待作用=分辨客户、精准销售、尊重。',
      '转化要点:散客→助教客户(免费体验/人情世故/撒娇/上钟沟通);散客→竞技客户(小游戏/球技指导/会员比赛活动);竞技→追分客户(组局/私杆保养/帮助谈门/控制赌博金额)。',
      '红线:竞技/追分转化里门店只"控制赌博金额",不亲自参与金钱博弈、不做庄家、不从赌注抽成。',
    ],
    src: { line: '979-1022', page: '121-124' },
  },
  {
    id: 'cus-deepen', domain: 'customer-ops', freedom: 'skeleton',
    title: '转化的目的·复购裂变',
    points: ['做深转化=提升优质客户基数与复购价值;服务和转化做好,复购自然产生,进而口碑、裂变。'],
    src: { line: '1026-1030', page: '125' },
  },
  {
    id: 'cus-tagging', domain: 'customer-ops', freedom: 'skeleton',
    title: '散客细分与客户打标签',
    points: [
      '初次进店散客细分四型:娱乐型、刚上瘾、仅限朋友、竞技客户,针对不同人群定不同维护策略。',
      '打标签方法:备注=名字+初次进店时间+客户类型+球技档位;描述=距离+消费频次+分区。',
    ],
    src: { line: '1672-1724', page: '215/221' },
  },

  // ───────── talent-mgmt 人才管理 ─────────
  {
    id: 'tal-assistant-mgmt', domain: 'talent-mgmt', freedom: 'skeleton',
    title: '助教管理·职责与画像',
    points: [
      '助教管理四工作重点:招聘、面试、培训·筛选、带教;四项职责:搭助教团队、扛业绩指标、让助教赚到钱、持续招聘保稳定。',
      '助教岗位要求排序:个人形象 > 沟通能力 > 台球技术。',
      '人才选-育-用-留:选(年龄/经历/能力匹配)、育(培训/带教)、用(任务/目标)、留(绩效/评估/晋升/淘汰)。',
    ],
    src: { line: '1102-1245', page: '138/152-157' },
  },
  {
    id: 'tal-recruit', domain: 'talent-mgmt', freedom: 'skeleton',
    title: '助教招聘·渠道与话术',
    points: [
      '招聘渠道:BOSS直聘、交友软件、抖音、快手、小红书同城、校园群、转介绍、扫街、同业挖人。',
      '招聘话术技巧:以非助教岗位面试转化、线上不提及助教工作、晚 11 点至凌晨 3 点发招聘私信。',
      '面试技巧:夸/破冰→了解过往工作与收入→抛出高薪心动→打消顾虑(当亲人/带赚钱/提供保护)→心灵鸡汤→谈职业前景。',
    ],
    src: { line: '1261-1349', page: '159-169' },
  },
  {
    id: 'tal-shift-sop', domain: 'talent-mgmt', freedom: 'skeleton',
    title: '上钟标准服务 SOP 与技巧',
    points: [
      '助教工作四块:定目标任务(日/月)、标准服务、练上钟技巧(抢局/赞美/人情世故)、增加业绩量(坚持拓客/客户分类)。',
      '上钟 SOP:"能不让客户动手就不让客户动手"(自我介绍/主动沟通/台面保持/拿杆收杆架杆/点烟);送客送至电梯口、面对面向助教管理报备、及时发感谢信息。',
      '上钟技巧:抢局、抢大局(赌注)、崇拜、撒娇、肢体接触、了解喜好、人情世故;目的=获得客户尊重喜爱、主动权反转。',
    ],
    src: { line: '1364-1407', page: '172-176' },
  },
  {
    id: 'tal-persona', domain: 'talent-mgmt', freedom: 'skeleton',
    title: '美女人设与红包文化',
    points: [
      '打造精致美女人设(性感/可爱/飒爽/潮酷);助教管理协助沟通、引导加微信。',
      '助教红包文化:买单红包、生日红包、交易红包、发私包。',
      '助教禁忌:抽烟、对打、扎堆、迟到、举止不雅、嚼舌根、男友进店、打扮不得体。',
      '助教管理终极能力:空挂、凶助教。',
    ],
    src: { line: '1483-1572', page: '186-199' },
  },
  {
    id: 'tal-self-respect', domain: 'talent-mgmt', freedom: 'red_line',
    title: '助教疑难问题·自爱底线',
    points: [
      '客户对助教有想法时,应对三原则:自爱、诚信、人情世故。',
      '红线(PPT 自身立的底线):助教守自爱、不越界、不滑向实际性交易;颜值/暧昧感/情绪价值可作营销氛围,但助教提供的始终是台球陪打陪练。客人越界(动手动脚/要特殊服务)时保护助教、把话拉回打球。',
    ],
    src: { line: '1541-1542', page: '194' },
  },
  {
    id: 'tal-manager-abilities', domain: 'talent-mgmt', freedom: 'skeleton',
    title: '店长五大能力与人员配置',
    points: [
      '店长五大能力:营销能力、数据分析能力、团队搭建能力、组织活动能力、解决问题能力。',
      '约 45 台规模人员配置见硬数字 #12(店长1/前厅主管1/助教管理≥3/教练2/保洁3,满编另含助教40等)。',
    ],
    src: { line: '291、766-779、1901-1905', page: '49/96/241' },
    hardSpecRefs: [12],
  },
  {
    id: 'tal-incentive', domain: 'talent-mgmt', freedom: 'hard_number',
    title: '助教激励·奖励与 PK',
    points: [
      '球房 PK 机制:管理层 PK、助教 PK、助教奖励机制;奖励以陪打时长为核心。',
      '月累计时长阶梯奖励见硬数字 #13;日/周/月陪打时长第一名系数奖励见硬数字 #14。',
    ],
    src: { line: '2122-2152', page: '273/277' },
    hardSpecRefs: [13, 14],
  },

  // ───────── strategy 战略 ─────────
  {
    id: 'str-equation', domain: 'strategy', freedom: 'skeleton',
    title: '营销方程式·识别→创造→传播→交付',
    points: [
      '营销的本质=识别→创造→传播→交付:清晰客户画像、了解客户真需求、围绕需求打造优质产品、对外传播吸引优质客户消费。',
    ],
    src: { line: '34-37', page: '7' },
    hardSpecRefs: [16],
  },
  {
    id: 'str-ying-xiao', domain: 'strategy', freedom: 'skeleton',
    title: '营(战略)vs 销(执行)',
    points: [
      '"营"是战略层面:行业分析、选择赛道、市场调研、定位、定价、产品、客群分类、客户真需求、传播。',
      '"销"是执行层面:团队搭建、运营策略、销售策略、推广渠道。',
    ],
    src: { line: '45-47、755-757', page: '9/99' },
  },
  {
    id: 'str-industry-analysis', domain: 'strategy', freedom: 'skeleton',
    title: '行业分析·赛道与市场调研',
    points: [
      '行业发展路径:街头游戏→竞技(自发)→商业化发展→竞技(专业服务),对应街头/商业球房/竞技球房;行业进入爆发期,专业化、精细化运营才是生存之道。',
      '选择赛道=俱乐部;市场调研维度:城市、位置、业态、租金、人流量。',
      '场地租赁关注:层高、柱间距、消防、免租期、装修期、水电费、广告牌位置/面积、电梯停车指引等硬件与合同项。',
      '对周边 3km 竞对经营数据详细摸底后再给新开球房定位。',
    ],
    src: { line: '55-181', page: '11-22' },
  },
  {
    id: 'str-redefine', domain: 'strategy', freedom: 'skeleton',
    title: '给行业带来的四个"重新定义"',
    points: ['客户分类(商业球房四大类客户)、人才画像(各管理岗职责)、运营体系(定位/运营/数据/管理)、球房布局(引流区/引流台概念)。'],
    src: { line: '623-636', page: '93' },
  },

  // ───────── data-analysis 数据分析 ─────────
  {
    id: 'da-goals', domain: 'data-analysis', freedom: 'skeleton',
    title: '定目标·分层与经营表',
    points: [
      '定目标任务分日任务/月任务;店长目标分层:月度、季度、年度。',
      '店长要会做投资回报周期经营表(计划书),并做阶段性目标分析、跟踪、复盘。',
    ],
    src: { line: '1365-1377、1901-1957', page: '172/241-249' },
  },
  {
    id: 'da-manager-metrics', domain: 'data-analysis', freedom: 'skeleton',
    title: '店长四大数据 + 老板抓的指标',
    points: [
      '店长四大数据管理:助教数据、教练数据、前厅数据、总营业额数据;助教数据看平均陪打时长与人事指标。',
      '老板抓店长的指标:营业额及利润、人事指标、台费(团购占比)、当日助教上班人数、平均陪打时长、商品费、器材费。',
    ],
    src: { line: '1961-1991', page: '250-254' },
  },
  {
    id: 'da-closed-loop', domain: 'data-analysis', freedom: 'skeleton',
    title: '数据分析闭环与趋势拆解',
    points: [
      '数据分析闭环三问:最关注什么数据、数据从何而来、有数据后有没有进一步动作;数据从计费系统后台读取→提取记录→形成可视化图表。',
      '日经营看日营业额趋势图,并拆五类趋势:总台费、助教费、商品费、团购费、卡充值。',
      '营销数据:促销期营业额同促销前对比,是否达成目标、差/超多少都要精确计算。',
    ],
    src: { line: '2075-2111', page: '264-270' },
  },
  {
    id: 'da-gambling-floor', domain: 'data-analysis', freedom: 'red_line',
    title: '控场底线·只控金额不坐庄',
    points: [
      '竞技/追分客户转化中门店要"控制赌博金额"(控场摁风险)。',
      '红线(PPT 全篇只有"控制赌博金额",无盘口/抽成):门店只提供场地和氛围、只控制赌博金额,不亲自参与客人之间的金钱博弈、不做庄家、不从赌注抽成、不设赌局盘面、不做资金拆借。',
    ],
    src: { line: '1022', page: '124' },
  },
]

// 两条 PPT 自身立的真底线(独立于挂载、始终守;= 安全红线在领域里的落点)
export const SAFETY_FLOORS: { title: string; text: string; src: { line: string; page: string } }[] = [
  {
    title: '助教守自爱、不滑向实际性交易',
    text: 'PPT 疑难问题原则=自爱/诚信/人情世故;颜值/暧昧感/情绪价值可作营销氛围,但助教提供的始终是台球陪打陪练,不营销实际性交易,客人越界则保护助教、拉回打球。',
    src: { line: '1541-1542', page: '194' },
  },
  {
    title: '门店只控金额、不亲自坐庄',
    text: 'PPT 全篇只写"控制赌博金额",无盘口/抽成;门店只做场地和氛围、控制赌博金额,不做庄家、不从赌注抽成、不设赌局盘面、不做资金拆借。',
    src: { line: '1022', page: '124' },
  },
]

export function knowledgeByDomain(domain: BilliardsDomain): KnowledgeEntry[] {
  return KNOWLEDGE.filter(entry => entry.domain === domain)
}

// 场景关键词 → 知识条目 id 索引(供无分隔的中文长查询也能命中,和 hardSpecs 同套路)。
const KNOWLEDGE_KEYWORDS: Record<string, string[]> = {
  定位: ['mkt-positioning-types', 'str-industry-analysis'],
  定价: ['mkt-pricing-core'], 价格: ['mkt-pricing-core'], 台费: ['mkt-pricing-core'],
  充值: ['mkt-pricing-core'], 会员: ['mkt-pricing-core'], 一卡通: ['mkt-pricing-core'],
  促销: ['mkt-promo'], 活动: ['mkt-promo', 'tal-incentive'], 团购: ['mkt-groupbuy', 'cus-loop'], 爆款: ['mkt-groupbuy'],
  氛围: ['mkt-two-selling-points'], 卖点: ['mkt-two-selling-points'],
  传播: ['mkt-channel-matrix'], 短视频: ['mkt-channel-matrix'], 抖音: ['mkt-channel-matrix', 'cus-drainage-link'],
  引流: ['cus-loop', 'cus-drainage-link'], 获客: ['cus-drainage-link', 'tal-recruit'],
  客户: ['cus-four-types', 'cus-conversion'], 散客: ['cus-four-types'], 追分: ['cus-four-types', 'cus-conversion'],
  转化: ['cus-conversion'], 复购: ['cus-deepen'], 裂变: ['cus-deepen'], 标签: ['cus-tagging'],
  助教: ['tal-assistant-mgmt', 'tal-shift-sop', 'tal-incentive'], 招聘: ['tal-recruit'], 上钟: ['tal-shift-sop'],
  人设: ['tal-persona'], 红包: ['tal-persona'], 店长: ['tal-manager-abilities', 'da-manager-metrics'],
  激励: ['tal-incentive'], pk: ['tal-incentive'], 陪打: ['tal-incentive'],
  营销: ['str-equation', 'str-ying-xiao'], 战略: ['str-ying-xiao'], 调研: ['str-industry-analysis'], 选址: ['str-industry-analysis'], 租赁: ['str-industry-analysis'],
  数据: ['da-manager-metrics', 'da-closed-loop'], 目标: ['da-goals'], 复盘: ['da-goals', 'da-closed-loop'], roi: ['da-goals'],
  赌: ['da-gambling-floor', 'cus-conversion'], 控场: ['da-gambling-floor'], 自爱: ['tal-self-respect'],
}
const KNOWLEDGE_BY_ID = new Map(KNOWLEDGE.map(e => [e.id, e]))

/** 按关键词粗筛相关知识条目(供工具按场景带出)。 */
export function findKnowledge(query: string, limit = 6): KnowledgeEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const score = new Map<string, number>()
  // 1. 关键词索引:query 子串命中关键词 → 相关条目加权
  for (const [key, ids] of Object.entries(KNOWLEDGE_KEYWORDS)) {
    if (q.includes(key)) for (const id of ids) score.set(id, (score.get(id) ?? 0) + 3)
  }
  // 2. 分词回退:query 分词命中条目正文
  const tokens = q.split(/[\s,，、。;；:：]+/).filter(Boolean)
  for (const entry of KNOWLEDGE) {
    const hay = `${entry.title} ${entry.points.join(' ')} ${DOMAIN_META[entry.domain].name}`.toLowerCase()
    for (const token of tokens) {
      if (token.length >= 2 && hay.includes(token)) score.set(entry.id, (score.get(entry.id) ?? 0) + 2)
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => KNOWLEDGE_BY_ID.get(id)!)
    .filter(Boolean)
}
