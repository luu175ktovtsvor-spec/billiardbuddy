// 台球运营领域包 · 术语白名单 + 真底线禁词 + 口语转译
//
// 定位:行业真实表达指南 + 防编造/防越界守卫的词库。结构参考老
//   `server/prompts/knowledge/term_whitelist.yaml`,内容按 PPT 底本重校准。
// 三块:
//   A 类 allowedTerms  —— 内行词照用,不强制"消毒"。带 PPT 出处的标 ppt;
//                        无 PPT 字面但行业通用的标 kind:'industry'(仅供守卫不误杀,不作知识内容)。
//   platformTerms      —— PPT 真实出现的平台/获客渠道/器材通用名,进白名单不脱敏、不当第三方专名误杀。
//   bannedTerms        —— 真底线禁词(性交易/虚假承诺/免费助教/门店坐庄抽成/假号刷评)。
//   translations       —— 用户口语 → 系统理解 → 推荐输出(贴行业真实,落点守底线)。
//
// ⚠️ PPT-only:knowledge 内容必须 PPT 有据;本白名单的 A 类可含"行业通用词"(kind:'industry')以防守卫误杀,
//   但这类词不进 knowledge 知识条目。凡带 ppt 的为 PPT 字面有据。

export interface WhitelistTerm {
  term: string
  usage: string
  /** ppt 有据 = PPT 字面出现;industry = 行业通用词(PPT 无字面,仅供守卫不误杀)。 */
  kind: 'ppt' | 'industry'
  ppt?: { line: string; page?: string }
}

export interface PlatformTerm {
  term: string
  category: '本地生活平台' | '内容平台' | '获客/交友渠道' | '招聘渠道' | '器材品牌' | '调研工具'
  ppt: { line: string }
  aliases?: string[]
}

export interface BannedTerm {
  /** 展示用标签。 */
  label: string
  /** 命中检测(小写子串;多写法用 patterns)。 */
  patterns: string[]
  category: '实际性交易/越界' | '虚假承诺/广告法' | '免费助教定位' | '门店坐庄博弈' | '假号刷评'
  reason: string
  /** 建议改写方向。 */
  redirect: string
}

export interface TranslationExample {
  colloquial: string
  understanding: string
  recommended: string
}

// ── A 类:内行词白名单(照用,不消毒) ──────────────────────────────
export const ALLOWED_TERMS: WhitelistTerm[] = [
  // 客户/定位(PPT 有据)
  { term: '散客', usage: '四大类客户之一;消费弱、频次低,别以貌取人不维护', kind: 'ppt', ppt: { line: '498、523', page: '75/76' } },
  { term: '竞技客户', usage: '四大类客户之一;要技术交流', kind: 'ppt', ppt: { line: '499、525', page: '75/76' } },
  { term: '助教客户', usage: '四大类客户之一;要异性情绪价值', kind: 'ppt', ppt: { line: '500、527', page: '75/76' } },
  { term: '追分客户', usage: '四大类客户之一;动机=赢钱', kind: 'ppt', ppt: { line: '501、529', page: '75/76' } },
  { term: '社区球房', usage: '球房定位类型', kind: 'ppt', ppt: { line: '186', page: '23' } },
  { term: '竞技球房', usage: '球房定位类型', kind: 'ppt', ppt: { line: '186', page: '23' } },
  { term: '商业球房', usage: '球房定位类型', kind: 'ppt', ppt: { line: '186', page: '23' } },
  { term: '竞技商业球房', usage: '球房定位类型', kind: 'ppt', ppt: { line: '186', page: '23' } },
  { term: '异性情绪价值', usage: '男性客群偏好=竞技性+异性情绪价值;助教客户核心需求', kind: 'ppt', ppt: { line: '82、528', page: '76' } },
  // 助教服务(PPT 有据)
  { term: '上钟', usage: '助教陪打服务上场', kind: 'ppt', ppt: { line: '1369、1399', page: '176' } },
  { term: '陪打', usage: '助教台球陪打陪练服务,门店盈利点', kind: 'ppt', ppt: { line: '852、1967、2150', page: '277' } },
  { term: '抢局', usage: '上钟技巧之一(含抢大局/赌注)', kind: 'ppt', ppt: { line: '1400、1401', page: '176' } },
  { term: '人情世故', usage: '两大卖点之一 + 上钟技巧 + 疑难问题应对原则', kind: 'ppt', ppt: { line: '454、1407、1542', page: '67/176/194' } },
  { term: '精致美女人设', usage: '助教人设打造(性感/可爱/飒爽/潮酷)', kind: 'ppt', ppt: { line: '1483', page: '186' } },
  { term: '美女展示', usage: '页面/场景营销手段', kind: 'ppt', ppt: { line: '902', page: '114' } },
  { term: '空挂', usage: '助教管理手段(挂钟)', kind: 'ppt', ppt: { line: '1520、1571', page: '199' } },
  { term: '免费体验', usage: '助教免费体验=拉新促销手段(首单养消费习惯),不是把助教写成免费', kind: 'ppt', ppt: { line: '440、1012、1426', page: '65' } },
  { term: '红包', usage: '助教红包文化:买单/生日/交易红包、发私包', kind: 'ppt', ppt: { line: '1547-1550', page: '195' } },
  { term: '控制赌博金额', usage: '门店控场底线=只控金额,不亲自坐庄', kind: 'ppt', ppt: { line: '1022', page: '124' } },
  { term: '擦边', usage: '内容两型之流量型走擦边引流(PPT 正经分类)', kind: 'ppt', ppt: { line: '550', page: '79' } },
  { term: '追分', usage: '竞技客之间约球较量、赢钱氛围', kind: 'ppt', ppt: { line: '501、974、1011', page: '75/121/124' } },
  { term: '点助教', usage: '预约助教服务(口语)', kind: 'ppt', ppt: { line: '29、851', page: '6/109' } },
  { term: '抢一大战', usage: '让条件增加偶然性的趣味比赛', kind: 'ppt', ppt: { line: '1761', page: '226' } },
  // 行业通用词(PPT 无字面,仅供守卫不误杀,不作知识内容)
  { term: '美女助教', usage: '行业通用叫法,可用于到店通知/推广', kind: 'industry' },
  { term: '颜值', usage: '形象吸引力,真实营销点,可直接写', kind: 'industry' },
  { term: '暧昧感', usage: '轻松有好感的氛围,可写但落点仍是台球陪打', kind: 'industry' },
  { term: '情绪价值', usage: '陪伴/聊得来带来的体验', kind: 'industry' },
  { term: '大哥客户', usage: '大客户/老客户/熟客的行业称呼', kind: 'industry' },
  { term: '台费局', usage: '打球输者付台费', kind: 'industry' },
  { term: '小赌怡情', usage: '熟人间小彩头助兴(门店不亲自坐庄)', kind: 'industry' },
  { term: '搭子局', usage: '撮合水平相近客户一起打球', kind: 'industry' },
]

// ── PPT 真实出现的平台/渠道/器材通用名(白名单,不脱敏、不当第三方专名误杀) ──
export const PLATFORM_TERMS: PlatformTerm[] = [
  { term: '美团', category: '本地生活平台', ppt: { line: '28、535、909' } },
  { term: '大众点评', category: '本地生活平台', ppt: { line: '535、912' } },
  { term: '抖音', category: '本地生活平台', ppt: { line: '28、535、549', }, aliases: ['抖音本地推', '抖音矩阵', '抖音达人'] },
  { term: '快手', category: '内容平台', ppt: { line: '537、1264' } },
  { term: '小红书', category: '内容平台', ppt: { line: '537、1265' } },
  { term: '视频号', category: '内容平台', ppt: { line: '537、1492' } },
  { term: '交友软件', category: '获客/交友渠道', ppt: { line: '537、878、1262' } },
  { term: '探探', category: '获客/交友渠道', ppt: { line: '1479' } },
  { term: '陌陌', category: '获客/交友渠道', ppt: { line: '1477' } },
  { term: 'Soul', category: '获客/交友渠道', ppt: { line: '1478' }, aliases: ['soul'] },
  { term: '积目', category: '获客/交友渠道', ppt: { line: '1476' } },
  { term: 'BOSS直聘', category: '招聘渠道', ppt: { line: '1261、1297' }, aliases: ['boss直聘', 'boss'] },
  { term: '乔氏', category: '器材品牌', ppt: { line: '210、240、396' } },
]

// ── 真底线禁词(保护助教/老板、避刑事与广告法线) ──────────────────
export const BANNED_TERMS: BannedTerm[] = [
  {
    label: '实际性交易/越界服务',
    patterns: ['性服务', '特殊服务', '包夜', '出台', '上门过夜', '过夜服务', '陪睡', '约炮', '性交易', '援交'],
    category: '实际性交易/越界',
    reason: '把台球陪打写成性交易,害助教也害门店(刑事线)',
    redirect: '落点回到台球陪打陪练服务;客人越界则保护助教、把话拉回打球',
  },
  {
    label: '露骨色情',
    patterns: ['露骨', '色情描写'],
    category: '实际性交易/越界',
    reason: '做真实营销内容,不是色情内容',
    redirect: '用颜值/气质/聊得来/暧昧感等真实营销氛围表达,不露骨',
  },
  {
    label: '虚假承诺/绝对化',
    patterns: ['包赢', '包教包会', '保证提升', '全城最低', '全网最低', '100%满意', '百分百满意'],
    category: '虚假承诺/广告法',
    reason: '虚假承诺 / 违反广告法绝对化用语',
    redirect: '帮你提升胜率、少走弯路 / 价格透明、欢迎来试两杆比较',
  },
  {
    label: '免费助教定位',
    patterns: ['免费助教', '免费陪练', '免费陪打', '助教当赠品', '送助教课'],
    category: '免费助教定位',
    reason: '破坏助教付费定位(助教费是门店盈利点)。注意:PPT 的"助教免费体验"是拉新促销手段,不在此列',
    redirect: '助教是付费增值服务,按门店实际规则执行;首单可用"助教免费体验"促销',
  },
  {
    label: '门店坐庄/抽成博弈',
    patterns: ['当庄', '坐庄', '定盘口', '设赌盘', '抽水', '抽头', '开设赌场', '门店放贷', '庄家抽成'],
    category: '门店坐庄博弈',
    reason: '门店亲自当庄=开设赌场罪。注意:追分/约局/台费局氛围照写,禁的只是门店本身当庄',
    redirect: '写"客人之间约局/追分"的真实氛围;门店只提供场地、只按 PPT 控制赌博金额',
  },
  {
    label: '假号刷评/买好评',
    patterns: ['买好评', '假好评', '机刷', '刷单机', '水军', '虚假评价', '找人假评', '批量假号'],
    category: '假号刷评',
    reason: '平台违规的批量假号机刷。注意:PPT 的"刷团购/养评"= 引导真实到店客户按平台规则评价,不在此列',
    redirect: '引导真实客户按平台规则评价(3图+15字+关WiFi关定位+隔天,见硬数字 #10/#11)',
  },
]

// ── 口语 → 推荐输出转译示例(贴行业真实,落点守底线) ──────────────
export const TRANSLATIONS: TranslationExample[] = [
  { colloquial: '美女助教到了', understanding: '助教到店通知/预约转化', recommended: '今天美女助教到店,想约的朋友提前说一声,帮你看时间' },
  { colloquial: '点助教', understanding: '预约助教服务', recommended: '想点助教提前告诉我,我帮你安排时间' },
  { colloquial: '大哥客户好久没来了', understanding: '大客户流失预警', recommended: '大哥好久没来打球了,最近忙啥呢?有空回来打两把' },
  { colloquial: '帮我写助教短视频,走颜值路线', understanding: '助教短视频获客', recommended: '输出颜值/形象/陪打氛围的真实营销配文,落点是台球陪打,不写露骨色情' },
  { colloquial: '客户想约助教但嫌贵', understanding: '价格敏感型转化', recommended: '助教是按课时收费的陪打服务,具体价到店了解;不少客户体验后觉得挺值' },
  { colloquial: '月底了助教业绩不够,推一下', understanding: '助教业绩冲刺', recommended: '月底冲刺,美女助教可约,想练球、想约的朋友抓紧预约' },
  { colloquial: '下雨天没人,推一下助教', understanding: '空台促活+助教推广', recommended: '下雨天窝家不如来打两局,美女助教可约,一个人来也热闹' },
  { colloquial: '帮我招助教,要有吸引力', understanding: '助教招聘', recommended: '输出吸引人的岗位文案(形象气质/沟通好/服务意识);不编造身高年龄等真实信息,未知用占位符' },
]

// 供守卫/工具复用的扁平集合
export const ALLOWED_TERM_SET = new Set(ALLOWED_TERMS.map(t => t.term.toLowerCase()))
export const PLATFORM_TERM_SET = new Set(
  PLATFORM_TERMS.flatMap(p => [p.term.toLowerCase(), ...(p.aliases ?? []).map(a => a.toLowerCase())]),
)
