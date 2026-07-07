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
