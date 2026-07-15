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
