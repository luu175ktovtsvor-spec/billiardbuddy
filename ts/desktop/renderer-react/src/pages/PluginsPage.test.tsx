import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PluginListItem } from '../api/extensions'
import { ExtensionTabs, extensionHeaderActionLabel, pluginContributionText, skillPresentation } from './PluginsPage'

test('扩展管理使用 Codex 式单一类型分段，而不是把所有能力铺在一页', () => {
  const html = renderToStaticMarkup(
    <ExtensionTabs
      active="skills"
      counts={{ plugins: 2, skills: 7, mcp: 3 }}
      onChange={() => undefined}
    />,
  )

  expect(html).toContain('role="tablist"')
  expect(html).toContain('aria-label="管理扩展"')
  expect(html.match(/role="tab"/g)).toHaveLength(3)
  expect(html).toContain('插件<span')
  expect(html).toContain('技能<span')
  expect(html).toContain('MCP<span')
  expect(html).toContain('aria-selected="true"')
  expect(html).not.toContain('网页搜索')
  expect(html).not.toContain('本地文件')
  expect(html).not.toContain('运行命令')
})

test('插件行只汇总真实贡献，不把空贡献伪装成已加载能力', () => {
  const plugin: PluginListItem = {
    name: 'demo',
    enabled: true,
    description: '',
    components: { skills: 2, commands: 1, hooks: 0, mcp: 0, 'output-styles': 1 },
  }

  expect(pluginContributionText(plugin)).toBe('技能 2 · 命令 1 · 输出风格 1')
  expect(pluginContributionText({
    ...plugin,
    components: { skills: 0, commands: 0, hooks: 0, mcp: 0, 'output-styles': 0 },
  })).toBe('未发现可加载内容')
})

test('技能行优先展示 agents/openai.yaml 元数据并保留真实调用名', () => {
  expect(skillPresentation({
    name: 'venue-daily-review',
    description: 'Long routing description',
    display_name: '经营日报复盘',
    short_description: '汇总真实数据并形成次日动作',
    source: 'skills',
    layer: 'bundled',
    user_invocable: true,
  })).toEqual({
    title: '经营日报复盘',
    description: '汇总真实数据并形成次日动作',
    invocation: '/venue-daily-review',
    detail: '系统',
  })

  expect(skillPresentation({
    name: 'internal',
    description: 'Agent workflow',
    source: 'skills',
    layer: 'workspace',
    user_invocable: false,
  })).toMatchObject({ invocation: 'internal', detail: '项目 · Agent 自动编排' })
})

test('扩展页只给有真实写入能力的分段显示添加动作', () => {
  expect(extensionHeaderActionLabel('plugins')).toBe('安装插件')
  expect(extensionHeaderActionLabel('mcp')).toBe('添加 MCP')
  expect(extensionHeaderActionLabel('skills')).toBeNull()
})
