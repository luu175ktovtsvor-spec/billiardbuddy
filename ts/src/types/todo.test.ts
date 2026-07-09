import { describe, expect, test } from 'bun:test'
import { formatTodoChecklist, normalizeTodos, parseProgressMarkdown, type TodoItem } from './todo'

describe('normalizeTodos', () => {
  test('字符串数组 → 第一项自动作为 in_progress', () => {
    expect(normalizeTodos(['a', 'b'])).toEqual([
      { task: 'a', status: 'in_progress' },
      { task: 'b', status: 'pending' },
    ])
  })
  test('对象数组 + content 别名 + 非法 status 退 pending', () => {
    expect(normalizeTodos([{ task: 'x', status: 'done' }, { content: 'y', status: 'huh' }])).toEqual([
      { task: 'x', status: 'done' },
      { task: 'y', status: 'in_progress' },
    ])
  })
  test('最多保留一个 in_progress,并接受 activeForm/active_form', () => {
    expect(normalizeTodos([
      { task: '实现', status: 'in_progress', activeForm: '正在写代码' },
      { task: '测试', status: 'in_progress', active_form: '正在跑测试' },
      { task: '收尾', status: 'pending' },
    ])).toEqual([
      { task: '实现', status: 'in_progress', activeForm: '正在写代码' },
      { task: '测试', status: 'pending', activeForm: '正在跑测试' },
      { task: '收尾', status: 'pending' },
    ])
  })
  test('非数组/空 task/垃圾项 → 跳过,永不抛', () => {
    expect(normalizeTodos(null)).toEqual([])
    expect(normalizeTodos('nope')).toEqual([])
    expect(normalizeTodos([{ task: '   ' }, 42, null, { foo: 1 }])).toEqual([])
  })
})

// cc-haha/Claude Code 用 'completed' 表示完成,本内核用 'done'。此前 'completed' 不在白名单
// 会被静默退回 pending,导致"任务永远做不完"。以下锁死入参别名归一后的行为对齐。
describe('normalizeTodos · 状态别名归一(修静默降级缺口)', () => {
  test("模型报 'completed' → 变已完成 'done',绝不静默退回 pending", () => {
    expect(normalizeTodos([
      { task: '第一步', status: 'completed' },
      { task: '第二步', status: 'completed' },
    ])).toEqual([
      { task: '第一步', status: 'done' },
      { task: '第二步', status: 'done' },
    ])
  })

  test("'in_progress' 正常保留,不被别名逻辑破坏", () => {
    expect(normalizeTodos([
      { task: '进行中', status: 'in_progress' },
      { task: '待办', status: 'pending' },
    ])).toEqual([
      { task: '进行中', status: 'in_progress' },
      { task: '待办', status: 'pending' },
    ])
  })

  test("cc 风格连字符/驼峰:'in-progress' / 'inProgress' → 'in_progress'", () => {
    expect(normalizeTodos([{ task: 'a', status: 'in-progress' }, { task: 'b', status: 'done' }])[0])
      .toEqual({ task: 'a', status: 'in_progress' })
    expect(normalizeTodos([{ task: 'a', status: 'inProgress' }, { task: 'b', status: 'done' }])[0])
      .toEqual({ task: 'a', status: 'in_progress' })
  })

  test("大小写/空格不敏感:' Completed ' → 'done'", () => {
    expect(normalizeTodos([{ task: 'a', status: ' Completed ' }, { task: 'b', status: 'done' }])[0])
      .toEqual({ task: 'a', status: 'done' })
  })

  test('非法 status → 退回 pending(首个 pending 随后被 enforce 提升)', () => {
    expect(normalizeTodos([
      { task: 'a', status: 'garbage' },
      { task: 'b', status: 42 },
    ])).toEqual([
      { task: 'a', status: 'in_progress' },
      { task: 'b', status: 'pending' },
    ])
  })

  test('数组字符串项按纯文本解析为 pending(不当状态别名),别名逻辑不误伤', () => {
    // 文本恰好是 'completed'/'done' 也只当任务名,状态一律 pending;首项经 enforce 提升
    expect(normalizeTodos(['completed', 'done', 'pending'])).toEqual([
      { task: 'completed', status: 'in_progress' },
      { task: 'done', status: 'pending' },
      { task: 'pending', status: 'pending' },
    ])
  })

  test('enforceSingleInProgress 在别名归一后仍生效:第二个 in_progress 被降回 pending', () => {
    expect(normalizeTodos([
      { task: 'a', status: 'completed' },
      { task: 'b', status: 'in_progress' },
      { task: 'c', status: 'in-progress' },
      { task: 'd', status: 'pending' },
    ])).toEqual([
      { task: 'a', status: 'done' },
      { task: 'b', status: 'in_progress' },
      { task: 'c', status: 'pending' },
      { task: 'd', status: 'pending' },
    ])
  })
})

describe('parseProgressMarkdown', () => {
  test('勾选清单 → done/in_progress', () => {
    expect(parseProgressMarkdown('- [ ] 写代码\n- [x] 跑测试\n无关行')).toEqual([
      { task: '写代码', status: 'in_progress' },
      { task: '跑测试', status: 'done' },
    ])
  })
  test('空/非清单 → []', () => {
    expect(parseProgressMarkdown('随便一段话')).toEqual([])
  })
})

describe('formatTodoChecklist', () => {
  test('标记 + 计数', () => {
    const todos: TodoItem[] = [
      { task: 'a', status: 'done' },
      { task: 'b', status: 'in_progress' },
      { task: 'c', status: 'pending' },
    ]
    const out = formatTodoChecklist(todos)
    expect(out).toContain('共 3 步,已完成 1 步')
    expect(out).toContain('☑ a')
    expect(out).toContain('◐ b')
    expect(out).toContain('☐ c')
  })
  test('进行中展示 activeForm', () => {
    const out = formatTodoChecklist([{ task: '跑测试', activeForm: '正在跑类型检查', status: 'in_progress' }])
    expect(out).toContain('◐ 正在跑类型检查')
    expect(out).not.toContain('◐ 跑测试')
  })
})
