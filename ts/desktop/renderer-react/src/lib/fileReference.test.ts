// 文件引用识别的行为边界(正文文件名 chip):路径形状即认、单文件名要工作树背书、代码点缀不误伤。
import { describe, expect, test } from 'bun:test'
import { fileRefFromCode } from './fileReference'
import type { TreeEntry } from '../stores/filePreviewStore'

const tree: TreeEntry[] = [
  { name: 'package.json', path: 'package.json', type: 'file' },
  {
    name: 'docs',
    path: 'docs',
    type: 'directory',
    children: [{ name: 'README.md', path: 'docs/README.md', type: 'file' }],
  },
]

describe('含 / 的路径:形状即认', () => {
  test('相对路径(中文名也认)', () => {
    expect(fileRefFromCode('docs/施工方案.md', null)).toEqual({ path: 'docs/施工方案.md', name: '施工方案.md', sheet: false })
  })
  test('绝对路径 + 表格类标记', () => {
    expect(fileRefFromCode('/tmp/out/报表.xlsx', null)).toEqual({ path: '/tmp/out/报表.xlsx', name: '报表.xlsx', sheet: true })
  })
  test('URL 不认(含冒号)', () => {
    expect(fileRefFromCode('https://a.com/x.md', null)).toBeNull()
  })
  test('目录路径(无扩展名)不认', () => {
    expect(fileRefFromCode('docs/plans', null)).toBeNull()
  })
})

describe('单文件名:要工作树背书', () => {
  test('树没加载 → need-tree(等树到位再判)', () => {
    expect(fileRefFromCode('package.json', null)).toBe('need-tree')
  })
  test('树里真有 → 认,并解析出树里的相对路径', () => {
    expect(fileRefFromCode('README.md', tree)).toEqual({ path: 'docs/README.md', name: 'README.md', sheet: false })
  })
  test('res.json 这类代码点缀树里没有 → 不认', () => {
    expect(fileRefFromCode('res.json', tree)).toBeNull()
  })
  test('console.log 树里没有 → 不认', () => {
    expect(fileRefFromCode('console.log', tree)).toBeNull()
  })
})

describe('代码/杂讯不误伤', () => {
  test.each([
    'console.log()', // 函数调用(括号)
    'a=b.c', // 赋值(等号)
    'v1.2', // 版本号(扩展名没字母)
    'x.ts:12', // 带行号引用(冒号)
    'C:\\Users\\x.txt', // Windows 盘符(反斜杠,mac 优先不认)
    '{a}.json', // 花括号
    'hello world.md', // 单文件名带空格的散文
  ])('%s → null', (s) => {
    expect(fileRefFromCode(s, tree)).toBeNull()
  })
})
