import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectEntry } from './ProjectEntry'

test('新建入口只要求素材和自然语言目标', () => {
  const html = renderToStaticMarkup(<ProjectEntry
    goalText=""
    ratio="9:16"
    durationSec={30}
    exactCopyText=""
    paths={[]}
    projects={[]}
    busy={false}
    onGoalChange={() => {}}
    onRatioChange={() => {}}
    onDurationChange={() => {}}
    onExactCopyChange={() => {}}
    onPickVideos={() => {}}
    onRemovePath={() => {}}
    onCreateProject={() => {}}
    onOpenProject={() => {}}
  />)

  expect(html).toContain('说说想剪成什么样')
  expect(html).toContain('添加视频')
  expect(html).not.toContain('有人讲解')
  expect(html).not.toContain('画面为主')
  expect(html).not.toContain('aria-label="内容类型"')
})
