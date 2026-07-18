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

帮助用户把一句自然语言想法推进到可以检查、修改和继续制作的图片结果。用户只需要说明用途和想法，提示词、模型、像素、画幅和执行方式由 Agent 处理。

1. 先提取用户已经给出的用途、受众、画面、精确文字、已有素材和期望数量。缺失内容会明显改变结果时，把相关问题合并成一轮普通话。
2. 用户只说“朋友圈海报”“招聘图”“活动宣传图”时，根据用途提出一个清楚的默认方向；多个方向差异明显时，最多给两个大白话选项。
3. 标题、价格、日期、地址、联系方式、福利、规则和品牌信息以用户输入或已核实资料为准。先复述“用在哪里、画面大概是什么、必须出现哪些字、准备做几张”，让用户容易检查。
4. 查看当前真实可用的图片生成、编辑、浏览器、脚本、代码和工作台能力，选择最适合本次任务的执行链。已有能力可以直接复用；需要时可以编写小脚本完成排版、批处理、格式转换或结果整理。
5. 先生成或建立一份可预览草稿，再根据用户反馈迭代画面、文字、尺寸和数量。精确文字可以拆成“生成画面 + Agent 排版”的两步，以实际导出文件为完成证据。
6. 需要用户选择素材、登录、确认费用或处理界面时，说明当前窗口、待确认内容和继续方式。执行后读取工具结果或文件，区分草稿、成品、失败和待继续状态。`

const VIDEO_PROMPT = `# 剪视频

帮助用户把自然语言要求推进到可预览、可调整的视频结果。用户只需要说明素材和目标，编码、分辨率、时间线和执行方式由 Agent 处理。

1. 先提取用户已经给出的素材、用途、希望保留的内容、顺序、精确文字和成片长度。缺失内容会明显改变取舍时，把相关问题合并成一轮普通话。
2. 读取真实素材信息后，再提出裁切、排序、画幅、字幕、音乐或节奏建议；观察结论和素材证据保持对应。
3. 查看当前真实可用的媒体工作台、命令、脚本、代码、浏览器和外部工具，选择最适合本次任务的执行链。已有项目或脚本可以复用，需要时可以编写小而清楚的处理程序。
4. 用“保留哪段、删掉哪段、先后顺序、成片用在哪里”向用户解释草稿，技术参数留在内部。先建立可预览版本，再根据反馈调整。
5. 保留原素材和可继续编辑的项目状态。需要用户选择素材、确认导出或处理界面时，说明当前窗口、待确认内容和继续方式。
6. 执行后读取时间线、工具返回值或导出文件，清楚说明预览、成片、失败和待继续状态。`

export function registerMediaWorkbenchesSkill(): void {
  registerBundledSkill({
    name: MEDIA_WORKBENCH_SKILL_METADATA[0].name,
    description: MEDIA_WORKBENCH_SKILL_METADATA[0].description,
    whenToUse: '用户要做海报、活动图、招聘图、朋友圈图片、宣传图、编辑参考图或从零生成图片时使用。',
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
