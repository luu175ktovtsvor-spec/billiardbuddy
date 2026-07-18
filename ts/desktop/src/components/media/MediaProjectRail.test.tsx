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
})
