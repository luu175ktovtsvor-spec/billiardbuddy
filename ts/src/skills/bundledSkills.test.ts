import { expect, test } from 'bun:test'
import { Workspace } from '../workspace/workspace'
import { bundledSkillsRoot, formatSkillIndex, loadSkillsDir, skillRequiresApproval } from './skillLoader'

test('BOSS 招聘 Skill 可被 Harness 发现且不自动扩张工具权限', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot(), { layer: 'bundled' })
  const skill = library.byName.get('boss-recruiting')

  expect(skill).toBeDefined()
  expect(skill?.description).toContain('BOSS 直聘')
  expect(formatSkillIndex(library, { query: 'BOSS 招人' })).toContain('boss-recruiting')
  expect(skill?.skillLayer).toBe('bundled')
  expect(skill?.allowedTools).toBeUndefined()
  expect(skillRequiresApproval(skill!)).toBe(false)
})

test('BOSS 招聘 Skill 保留人工登录、业务确认和发送回执硬边界', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot())
  const skill = library.byName.get('boss-recruiting')
  const prompt = await skill!.getPrompt('', { workspace: new Workspace(process.cwd()) })

  expect(prompt).toContain('等待用户明确说已经登录')
  expect(prompt).toContain('不静默安装、升级')
  expect(prompt).toContain('筛选逻辑必须由当前 Agent 根据本次用户输入生成')
  expect(prompt).toContain('未知不等于不符合')
  expect(prompt).toContain('CLI 和浏览器只返回事实与执行动作')
  expect(prompt).toContain('消息正文')
  expect(prompt).toContain('需要**重新授权**的情形')
  expect(prompt).toContain('CLI 返回“已发送”只能当作动作结果')
  expect(prompt).toContain('标记为 `uncertain`')
  expect(prompt).toContain('禁止自动盲目重试')
  // 形象气质按门店实际用人要求(放开);仅保留法律禁止的就业歧视红线。
  expect(prompt).toContain('岗位确实需要的形象气质')
  expect(prompt).toContain('《就业促进法》明确禁止')
})

test('Playwright 浏览器 Skill 可被自然语言发现且不自动扩权', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot(), { layer: 'bundled' })
  const skill = library.byName.get('playwright-browser')

  expect(skill).toBeDefined()
  expect(formatSkillIndex(library, { query: '用浏览器填网页表单' })).toContain('playwright-browser')
  expect(skill?.allowedTools).toBeUndefined()
  expect(skillRequiresApproval(skill!)).toBe(false)
})

test('Playwright 浏览器 Skill 只追问必要事实并用页面证据关闭副作用', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot())
  const skill = library.byName.get('playwright-browser')
  const prompt = await skill!.getPrompt('', { workspace: new Workspace(process.cwd()) })

  expect(prompt).toContain('只询问会改变页面选择')
  expect(prompt).toContain('让用户自己填写')
  expect(prompt).toContain('不静默安装或升级')
  expect(prompt).toContain('等待用户明确说已完成')
  expect(prompt).toContain('完整输入或消息')
  expect(prompt).toContain('执行后再次读取同一页面')
  expect(prompt).toContain('标记为 `uncertain`')
  expect(prompt).toContain('不允许自动盲目重试')
})

test('视频 Skill 用文字引导编排，不强制数字步骤或预设业务数据', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot())
  const skill = library.byName.get('video-editing')
  const prompt = await skill!.getPrompt('', { workspace: new Workspace(process.cwd()) })

  expect(prompt).toContain('只在缺失信息会明显改变')
  expect(prompt).toContain('让用户自己给出数据')
  expect(prompt).toContain('其他情况省略 `mode`')
  expect(prompt).toContain('`plan_summary` 是复述剪辑方案的事实源')
  expect(prompt).toContain('停下等待明确回答')
  expect(prompt).not.toMatch(/^\d+\.\s/m)
  expect(prompt).not.toContain('15–30 秒最好')
  expect(prompt).not.toContain('9:16 最适合')
})

test('生图 Skill 可被自然语言发现且不自动扩张工具权限', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot(), { layer: 'bundled' })
  const skill = library.byName.get('image-creation')

  expect(skill).toBeDefined()
  expect(skill?.description).toContain('图片')
  expect(formatSkillIndex(library, { query: '门店宣传图' })).toContain('image-creation')
  expect(formatSkillIndex(library, { query: '修图' })).toContain('image-creation')
  expect(skill?.skillLayer).toBe('bundled')
  expect(skill?.allowedTools).toBeUndefined()
  expect(skillRequiresApproval(skill!)).toBe(false)
})

test('生图 Skill 复用媒体链路并守住事实、真人和交付边界', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot())
  const skill = library.byName.get('image-creation')
  const prompt = await skill!.getPrompt('', { workspace: new Workspace(process.cwd()) })

  expect(prompt).toContain('最多三个')
  expect(prompt).toContain('让用户自己给出')
  expect(prompt).toContain('不要把上传图片默认当成 logo')
  expect(prompt).toContain('先实际查看')
  expect(prompt).toContain('generate_image')
  expect(prompt).toContain('edit_image')
  expect(prompt).toContain('upscale_image')
  expect(prompt).toContain('select_image_candidates')
  expect(prompt).toContain('TaskOutput')
  expect(prompt).toContain('图片工作台')
  expect(prompt).toContain('使用权和当事人同意')
  expect(prompt).toContain('换脸、深度伪造、公众人物代言或身份冒充')
  expect(prompt).toContain('不能声称找回了原图中不存在的细节')
  expect(prompt).not.toMatch(/^\d+\.\s/m)
})

test('球房经营 Skills 覆盖 PPT 的高频闭环且不预设门店数据', async () => {
  const library = await loadSkillsDir(bundledSkillsRoot(), { layer: 'bundled' })
  const expectations = [
    ['venue-daily-review', '经营日报复盘', '不预设门店目标'],
    ['customer-follow-up', '客户维护与邀约', '不保存客户数据库'],
    ['venue-campaign-planning', '门店活动策划', '不预设折扣'],
    ['venue-inspection-followup', '巡店整改闭环', '不预设每家门店的检查标准'],
    ['staff-performance-coaching', '员工表现辅导', '不预设薪酬'],
  ] as const

  for (const [name, displayName, boundary] of expectations) {
    const skill = library.byName.get(name)
    expect(skill).toBeDefined()
    expect(skill).toMatchObject({ displayName, skillLayer: 'bundled' })
    expect(skillRequiresApproval(skill!)).toBe(false)
    const prompt = await skill!.getPrompt('', { workspace: new Workspace(process.cwd()) })
    expect(prompt).toContain(boundary)
    expect(prompt).toMatch(/只追问|才追问|只询问/)
    expect(prompt).not.toMatch(/^\d+\.\s/m)
  }
})
