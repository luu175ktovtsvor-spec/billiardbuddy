import { registerBundledSkill } from '../bundledSkills.js'

export const MEDIA_WORKBENCH_SKILL_METADATA = [
  {
    name: 'image-workbench',
    displayName: '做海报和图片',
    description: '把活动、招聘、朋友圈等自然语言需求整理成可确认的图片草稿。',
  },
  {
    name: 'video-workbench',
    displayName: '剪视频',
    description: '读取本地素材并准备可预览、可调整的视频时间线。',
  },
] as const

const IMAGE_PROMPT = `# 做海报和图片

把用户说的用途和想法整理成图片工作台里的可确认草稿。用户不需要懂提示词、模型名称、像素或画幅术语。

1. 先使用用户已经给出的信息。只有缺失内容会改变画面、费用、精确文字或素材授权时才追问；把问题合并成一轮普通话，不发固定问卷。
2. 用户只说“朋友圈海报”“招聘图”“活动宣传图”时，根据用途选择合适的常见版式并用大白话说明；不要强迫用户先决定 1:1、9:16 等技术参数。只有多个版式都合理且差异明显时，给出不超过两个易懂选项。
3. 必须逐字出现的标题、价格、日期、地址、联系方式、福利、规则和品牌信息只能来自用户输入或已核实资料。不得编造 Logo、二维码、人物、门店承诺或活动事实。
4. 先用“图片用在哪里、画面大概是什么、必须出现哪些字、准备做几张”复述草稿，再调用 MediaWorkbench 创建图片草稿。内部提示词由 Agent 整理，不把写提示词的工作推给用户。
5. 用户必须能在图片工作台检查并修改文字、画面要求、尺寸和数量。付费生成只由用户在工作台明确确认；本 Skill 不提交付费任务，也不把草稿或占位图说成成品。
6. 真人、第三方图片、Logo 和二维码的使用权不明确时先确认。参考图编辑由用户在图片工作台添加素材；不要让 Agent 或 MediaWorkbench 读取或传递参考图 base64。
7. 任务结果未知、失败或中断时如实说明，不自动重试可能重复扣费的任务。`

const VIDEO_PROMPT = `# 剪视频

把用户的自然语言要求整理成视频工作台里的可预览时间线。用户不需要懂 FFmpeg、编码、分辨率或时间线术语。

1. 先使用用户已经给出的素材和目标。只有缺失内容会明显改变取舍、顺序、精确文字或素材授权时才追问；把问题合并成一轮普通话。
2. 先读取真实素材信息，再提出裁切、排序和画幅建议。没有工具证据时，不声称素材里出现了某个画面、人物、对白、音乐或已经导出文件。
3. 调用 MediaWorkbench 创建项目、加入用户指定的素材并更新可预览的裁切范围和顺序。用“保留哪段、删掉哪段、先后顺序、成片用在哪里”向用户解释，不要求用户填写技术参数。
4. 保留原文件。字幕、语音理解、音乐、转场和智能选镜不是当前基础剪辑的默认能力；用户没要求或系统没有真实能力时不要承诺。音乐和第三方素材的使用权不明确时先确认。
5. 最终导出只由用户在视频工作台明确确认。本 Skill 只准备可编辑草稿，不在对话里运行临时 FFmpeg 命令，也不把预览或计划说成成片。`

export function registerMediaWorkbenchesSkill(): void {
  registerBundledSkill({
    name: MEDIA_WORKBENCH_SKILL_METADATA[0].name,
    description: MEDIA_WORKBENCH_SKILL_METADATA[0].description,
    whenToUse: '用户要做海报、活动图、招聘图、朋友圈图片、宣传图或从零生成图片时使用。参考图编辑由用户在工作台手动添加素材。',
    allowedTools: ['MediaWorkbench'],
    userInvocable: true,
    isEnabled: () => Boolean(process.env.BB_DESKTOP_SERVER_URL?.trim()),
    desktopDiscovery: {
      displayName: MEDIA_WORKBENCH_SKILL_METADATA[0].displayName,
      content: IMAGE_PROMPT,
      isEnabled: () => true,
    },
    async getPromptForCommand() {
      return [{ type: 'text', text: IMAGE_PROMPT }]
    },
  })
  registerBundledSkill({
    name: MEDIA_WORKBENCH_SKILL_METADATA[1].name,
    description: MEDIA_WORKBENCH_SKILL_METADATA[1].description,
    whenToUse: '用户要剪本地视频、裁切片段、调整顺序、拼接素材、做门店短片或导出基础成片时使用。',
    allowedTools: ['MediaWorkbench'],
    userInvocable: true,
    isEnabled: () => Boolean(process.env.BB_DESKTOP_SERVER_URL?.trim()),
    desktopDiscovery: {
      displayName: MEDIA_WORKBENCH_SKILL_METADATA[1].displayName,
      content: VIDEO_PROMPT,
      isEnabled: () => true,
    },
    async getPromptForCommand() {
      return [{ type: 'text', text: VIDEO_PROMPT }]
    },
  })
}
