// 按会话隔离工作目录的对齐断言(修多窗口串台缺口):
// 会话A选folder1、会话B选folder2,切回A仍是folder1(不被B覆盖)= 前端每个会话记住自己的目录、
// sendMessage/右面板读的都是当前会话的目录。后端本就按每条 run 的 working_dir 隔离,只要前端各发各的就不串台。
import { expect, test, beforeEach } from 'bun:test'
import { useSettingsStore } from './settingsStore'

const F1 = '/Users/swl/Desktop/测试台球运营管家'
const F2 = '/Users/swl/Desktop/测试管家台球运营管家2'
const F3 = '/Users/swl/Desktop/测试管家台球运营管家3'

beforeEach(() => {
  // 复位(无 reset action → 直接清映射与激活态)
  useSettingsStore.setState({
    workspaceByConv: {},
    enabledPacksByConv: {},
    activeConvId: null,
    workspaceRoot: null,
    enabledPacks: [],
  })
})

test('多窗口各选各的:会话A=folder1、会话B=folder2,切回A仍是folder1(不串台)', () => {
  const s = useSettingsStore.getState()

  s.activateConversation('convA')
  s.setWorkspaceRoot(F1)
  expect(useSettingsStore.getState().workspaceRoot).toBe(F1)

  s.activateConversation('convB')
  expect(useSettingsStore.getState().workspaceRoot).toBe(null) // B 新会话,未绑定 → 后端默认
  s.setWorkspaceRoot(F2)
  expect(useSettingsStore.getState().workspaceRoot).toBe(F2)

  // 关键:切回 A,还是 folder1,没被 B 的选择覆盖
  s.activateConversation('convA')
  expect(useSettingsStore.getState().workspaceRoot).toBe(F1)

  // 切回 B,还是 folder2
  s.activateConversation('convB')
  expect(useSettingsStore.getState().workspaceRoot).toBe(F2)

  // 映射两条各自独立
  expect(useSettingsStore.getState().workspaceByConv).toEqual({ convA: F1, convB: F2 })
})

test('改一个会话的目录不影响另一个会话(无漂移串台)', () => {
  const s = useSettingsStore.getState()
  s.activateConversation('convA'); s.setWorkspaceRoot(F1)
  s.activateConversation('convB'); s.setWorkspaceRoot(F2)

  // 回到 A 改成 F3
  s.activateConversation('convA'); s.setWorkspaceRoot(F3)
  expect(useSettingsStore.getState().workspaceByConv.convA).toBe(F3)
  // B 不受影响
  expect(useSettingsStore.getState().workspaceByConv.convB).toBe(F2)
  s.activateConversation('convB')
  expect(useSettingsStore.getState().workspaceRoot).toBe(F2)
})

test('未绑定的新会话默认 null(= 后端默认目录),不继承别的会话的选择', () => {
  const s = useSettingsStore.getState()
  s.activateConversation('convA'); s.setWorkspaceRoot(F1)
  // 全新会话 C:未绑定 → null,不会拿到 A 的 folder1
  s.activateConversation('convC')
  expect(useSettingsStore.getState().workspaceRoot).toBe(null)
})

test('adopt 后端会话工作目录:本地没记时用后端 meta.workspaceRoot 兜底(跨重启记得)', () => {
  const s = useSettingsStore.getState()
  s.activateConversation('convOld')
  expect(useSettingsStore.getState().workspaceRoot).toBe(null) // 本地无记录
  s.adoptConversationWorkspace('convOld', F2) // 后端回传它上次跑在 folder2
  expect(useSettingsStore.getState().workspaceRoot).toBe(F2) // 当前激活的正是它 → 同步生效
  expect(useSettingsStore.getState().workspaceByConv.convOld).toBe(F2)
})

test('adopt 不覆盖本地已有记录(用户刚在本地改过 → 前端为准)', () => {
  const s = useSettingsStore.getState()
  s.activateConversation('convX'); s.setWorkspaceRoot(F1) // 本地已绑 folder1
  s.adoptConversationWorkspace('convX', F2) // 后端还是旧的 folder2
  expect(useSettingsStore.getState().workspaceByConv.convX).toBe(F1) // 不被覆盖
})

test('解绑(setWorkspaceRoot null)回到后端默认', () => {
  const s = useSettingsStore.getState()
  s.activateConversation('convA'); s.setWorkspaceRoot(F1)
  s.setWorkspaceRoot(null)
  expect(useSettingsStore.getState().workspaceRoot).toBe(null)
  expect(useSettingsStore.getState().workspaceByConv.convA).toBeUndefined()
})

test('领域包按会话隔离:会话 A 开启台球不影响会话 B', () => {
  const s = useSettingsStore.getState()
  s.activateConversation('convA')
  s.setEnabledPacks(['billiards'])

  s.activateConversation('convB')
  expect(useSettingsStore.getState().enabledPacks).toEqual([])

  s.activateConversation('convA')
  expect(useSettingsStore.getState().enabledPacks).toEqual(['billiards'])
  expect(useSettingsStore.getState().enabledPacksByConv).toEqual({ convA: ['billiards'] })
})

test('明确关闭领域包会保留空数组标记,旧的后端元数据不得重新开启', () => {
  const s = useSettingsStore.getState()
  s.activateConversation('convA')
  s.setEnabledPacks(['billiards'])
  s.setEnabledPacks([])

  expect(useSettingsStore.getState().enabledPacksByConv).toHaveProperty('convA', [])

  s.adoptConversationPacks('convA', ['billiards'])
  expect(useSettingsStore.getState().enabledPacks).toEqual([])
  expect(useSettingsStore.getState().enabledPacksByConv).toHaveProperty('convA', [])
})
