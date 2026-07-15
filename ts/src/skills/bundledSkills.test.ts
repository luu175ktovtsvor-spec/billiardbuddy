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
  expect(prompt).toContain('完整消息正文')
  expect(prompt).toContain('必须重新确认')
  expect(prompt).toContain('CLI 返回“已发送”只能当作动作结果')
  expect(prompt).toContain('标记为 `uncertain`')
  expect(prompt).toContain('禁止自动盲目重试')
  expect(prompt).toContain('不要按性别、民族、宗教、婚育、残障、外貌等')
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
