import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'
import { MediaProjectRail } from './MediaProjectRail'

describe('MediaProjectRail', () => {
  it('keeps selection and deletion as separate actions', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const project = {
      id: 'img_project01',
      title: '会员日海报',
      state: 'draft',
      updated_at: '2026-07-18T00:00:00.000Z',
    }
    render(
      <MediaProjectRail
        kind="image"
        projects={[project]}
        activeId={project.id}
        onSelect={onSelect}
        onDelete={onDelete}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: project.title }))
    expect(onSelect).toHaveBeenCalledWith(project.id)
    fireEvent.click(screen.getByRole('button', { name: `删除 ${project.title}` }))
    expect(onDelete).toHaveBeenCalledWith(project)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('shows recoverable projects for the current workbench and restores them separately', () => {
    const onRestore = vi.fn()
    render(
      <MediaProjectRail
        kind="image"
        projects={[]}
        activeId={null}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRestore={onRestore}
        deletions={[
          {
            deletion_id: 'del_image001',
            project_id: 'img_deleted01',
            project_kind: 'image',
            project_title: '误删海报',
            status: 'deleted',
            deleted_at: '2026-07-27T01:00:00.000Z',
            purge_after: '2026-08-26T01:00:00.000Z',
            task_ids: [],
            managed_asset_count: 2,
            managed_asset_bytes: 1024,
          },
          {
            deletion_id: 'del_video001',
            project_id: 'vid_deleted01',
            project_kind: 'video',
            project_title: '误删视频',
            status: 'deleted',
            deleted_at: '2026-07-27T01:00:00.000Z',
            purge_after: '2026-08-26T01:00:00.000Z',
            task_ids: [],
            managed_asset_count: 1,
            managed_asset_bytes: 512,
          },
        ]}
      />,
    )

    expect(screen.getByText('最近删除 · 1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('最近删除 · 1'))
    expect(screen.getByText('误删海报')).toBeInTheDocument()
    expect(screen.queryByText('误删视频')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '恢复 误删海报' }))
    expect(onRestore).toHaveBeenCalledWith('img_deleted01')
  })
})
