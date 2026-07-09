import { expect, test } from 'bun:test'
import { parseArguments, parseArgumentNames, substituteArguments } from './argumentSubstitution'

test('parseArguments:空白切词与引号包裹', () => {
  expect(parseArguments('')).toEqual([])
  expect(parseArguments('   ')).toEqual([])
  expect(parseArguments('foo bar baz')).toEqual(['foo', 'bar', 'baz'])
  expect(parseArguments('foo "hello world" baz')).toEqual(['foo', 'hello world', 'baz'])
  expect(parseArguments("foo 'hello world' baz")).toEqual(['foo', 'hello world', 'baz'])
  expect(parseArguments('a  b   c')).toEqual(['a', 'b', 'c'])
  expect(parseArguments('say "she said \\"hi\\""')).toEqual(['say', 'she said "hi"'])
})

test('parseArgumentNames:接受空格分隔字符串或数组,过滤空名和纯数字名', () => {
  expect(parseArgumentNames(undefined)).toEqual([])
  expect(parseArgumentNames('foo bar baz')).toEqual(['foo', 'bar', 'baz'])
  expect(parseArgumentNames(['foo', 'bar', 'baz'])).toEqual(['foo', 'bar', 'baz'])
  expect(parseArgumentNames('foo  0 bar 12')).toEqual(['foo', 'bar'])
  expect(parseArgumentNames(['foo', '', '  ', 'bar'])).toEqual(['foo', 'bar'])
})

test('substituteArguments:undefined/null 原样返回,不替换', () => {
  expect(substituteArguments('hi $ARGUMENTS', undefined)).toBe('hi $ARGUMENTS')
  expect(substituteArguments('hi $ARGUMENTS', null as unknown as undefined)).toBe('hi $ARGUMENTS')
})

test('substituteArguments:$ARGUMENTS 替换成参数原文', () => {
  expect(substituteArguments('run: $ARGUMENTS', 'foo bar')).toBe('run: foo bar')
  expect(substituteArguments('empty: [$ARGUMENTS]', '')).toBe('empty: []')
})

test('substituteArguments:$ARGUMENTS[n] 与 $n 简写按位置替换,缺参给空串', () => {
  expect(substituteArguments('first=$ARGUMENTS[0] second=$ARGUMENTS[1]', 'a b')).toBe('first=a second=b')
  expect(substituteArguments('first=$0 second=$1 third=$2', 'a b')).toBe('first=a second=b third=')
  expect(substituteArguments('id=$5', 'only-one')).toBe('id=')
})

test('substituteArguments:具名参数按 argumentNames 顺序映射到位置参数', () => {
  const content = 'title=$title body=$body'
  expect(substituteArguments(content, 'Hello "World Wide"', true, ['title', 'body'])).toBe('title=Hello body=World Wide')
  // 缺第二个具名参数时给空串,不残留占位符
  expect(substituteArguments(content, 'OnlyTitle', true, ['title', 'body'])).toBe('title=OnlyTitle body=')
})

test('substituteArguments:具名参数不误伤更长的同前缀变量名', () => {
  // $title 不应匹配到 $titleSuffix 里的 $title 前缀
  expect(substituteArguments('$title $titleSuffix', 'X', true, ['title'])).toBe('X $titleSuffix')
})

test('substituteArguments:正文没有占位符时按 appendIfNoPlaceholder 追加参数原文', () => {
  expect(substituteArguments('plain body', 'foo', true, [], '参数')).toBe('plain body\n\n参数:\nfoo')
  // args 为空字符串时不追加
  expect(substituteArguments('plain body', '', true, [], '参数')).toBe('plain body')
  // appendIfNoPlaceholder=false 时即使 args 非空也不追加
  expect(substituteArguments('plain body', 'foo', false, [], '参数')).toBe('plain body')
})

test('substituteArguments:命中占位符时不再追加参数原文', () => {
  expect(substituteArguments('run $ARGUMENTS', 'foo', true, [], '参数')).toBe('run foo')
})
