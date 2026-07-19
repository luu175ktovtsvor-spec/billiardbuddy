import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { NewTaskModal } from './NewTaskModal'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTaskStore } from '../../stores/taskStore'
import { PRODUCT_TASK_TAB_PREFIX, useTabStore } from '../../stores/tabStore'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from '../../product/stores/productTaskStore'

afterEach(() => {
  cleanup()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
  useTaskStore.setState(useTaskStore.getInitialState(), true)
  useTabStore.setState({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
  useProductTaskStore.setState({ index: EMPTY_PRODUCT_TASK_INDEX })
})

describe('NewTaskModal', () => {
  it('creates scheduled tasks in unattended safe mode', async () => {
    const createTask = vi.fn(async () => {})
    useTaskStore.setState({ createTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
      lastActiveProductTaskId: 'task-1',
      tabs: [{
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        title: '运营任务',
        type: 'product-task',
        taskId: 'task-1',
      }],
    })
    useProductTaskStore.setState({
      index: {
        ...EMPTY_PRODUCT_TASK_INDEX,
        tasks: [{
          id: 'task-1',
          projectId: 'project-1',
          workDir: '/workspace/product-task',
          title: '运营任务',
          lifecycle: 'active',
          kind: 'main',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
          worktreeState: 'not_requested',
          actions: ['rename'],
        }],
        total: 1,
      },
    })

    render(<NewTaskModal open onClose={vi.fn()} />)

    expect(screen.getByText('Unattended safe mode')).toBeInTheDocument()
    expect(
      screen.getByText(/Actions that need approval are rejected/i),
    ).toBeInTheDocument()
    expect(screen.queryByText('Full permissions')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^Name/), {
      target: { value: 'provider cron' },
    })
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: 'exercise provider selection' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Look at the commits/i), {
      target: { value: 'Say hello from the scheduled task.' },
    })

    expect(screen.queryByText(/provider-main/i)).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1))
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'dontAsk',
      enabled: true,
      recurring: true,
      folderPath: '/workspace/product-task',
    }))
  })

  it('keeps edited scheduled tasks in unattended safe mode', async () => {
    const updateTask = vi.fn(async () => {})
    useTaskStore.setState({ updateTask } as Partial<ReturnType<typeof useTaskStore.getState>>)
    useSettingsStore.setState({ locale: 'en' })

    render(<NewTaskModal open onClose={vi.fn()} editTask={{
      id: 'scheduled-1',
      name: 'daily review',
      description: 'Review the daily operations',
      cron: '0 9 * * *',
      prompt: 'Review today’s operation log.',
      enabled: true,
      createdAt: 0,
    }} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      await Promise.resolve()
    })

    await waitFor(() => expect(updateTask).toHaveBeenCalledWith(
      'scheduled-1',
      expect.objectContaining({ permissionMode: 'dontAsk' }),
    ))
  })
})
