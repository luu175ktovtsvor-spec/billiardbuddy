import { afterEach, beforeEach, expect, test } from 'bun:test'
import { api } from '../api/client'
import { previewKindForPath, useFilePreviewStore } from './filePreviewStore'
import { useSettingsStore } from './settingsStore'

const originalGet = api.get

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  useSettingsStore.setState({ workspaceRoot: null })
  useFilePreviewStore.setState({
    panelOpen: true,
    tabs: [],
    activePath: null,
    root: null,
    tree: null,
    git: null,
    treeLoading: false,
    treeError: null,
  })
})

afterEach(() => {
  api.get = originalGet
})

test('workspace tree ignores a slower response from the previously active project', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  const paths: string[] = []
  api.get = ((path: string) => {
    paths.push(path)
    return paths.length === 1 ? first.promise : second.promise
  }) as typeof api.get

  useSettingsStore.setState({ workspaceRoot: '/workspace/first' })
  useFilePreviewStore.getState().loadWorkspace()

  useSettingsStore.setState({ workspaceRoot: '/workspace/second' })
  useFilePreviewStore.setState({ tree: null, root: null })
  useFilePreviewStore.getState().loadWorkspace()

  second.resolve({
    root: '/workspace/second',
    tree: { root: '/workspace/second', entries: [{ name: 'second.txt', path: 'second.txt', type: 'file' }] },
  })
  await second.promise
  await Promise.resolve()

  first.resolve({
    root: '/workspace/first',
    tree: { root: '/workspace/first', entries: [{ name: 'first.txt', path: 'first.txt', type: 'file' }] },
  })
  await first.promise
  await Promise.resolve()

  expect(paths).toEqual([
    '/api/v1/agent/workspace-status?working_dir=%2Fworkspace%2Ffirst',
    '/api/v1/agent/workspace-status?working_dir=%2Fworkspace%2Fsecond',
  ])
  expect(useFilePreviewStore.getState()).toMatchObject({
    root: '/workspace/second',
    treeLoading: false,
    tree: [{ name: 'second.txt', path: 'second.txt', type: 'file' }],
  })
})

test('workspace preview classification keeps binary files out of the text reader', () => {
  expect(previewKindForPath('poster.png')).toBe('image')
  expect(previewKindForPath('clip.MP4')).toBe('video')
  expect(previewKindForPath('manual.pdf')).toBe('pdf')
  expect(previewKindForPath('report.csv')).toBe('spreadsheet')
  expect(previewKindForPath('report.xlsx')).toBe('spreadsheet')
  expect(previewKindForPath('minutes.docx')).toBe('document')
  expect(previewKindForPath('slides.pptx')).toBe('document')
  expect(previewKindForPath('notes.md')).toBe('text')
  expect(previewKindForPath('archive.zip')).toBe('unsupported')
})

test('opening an office file loads and validates its structured preview', async () => {
  let requested = ''
  api.get = (async (path: string) => {
    requested = path
    return {
      kind: 'spreadsheet',
      path: '/workspace/report.csv',
      name: 'report.csv',
      sheet_names: ['Sheet1'],
      sheets: [{ name: 'Sheet1', rows: [['metric', 'value']] }],
      truncated: false,
    }
  }) as typeof api.get
  useSettingsStore.setState({ workspaceRoot: '/workspace' })
  useFilePreviewStore.setState({ tree: [] })

  useFilePreviewStore.getState().openFile('/workspace/report.csv')
  await Promise.resolve()
  await Promise.resolve()

  expect(requested).toBe('/api/v1/agent/fs/preview?path=%2Fworkspace%2Freport.csv&working_dir=%2Fworkspace')
  expect(useFilePreviewStore.getState().tabs[0]).toMatchObject({
    kind: 'spreadsheet',
    loading: false,
    workspaceRoot: '/workspace',
    preview: { kind: 'spreadsheet', name: 'report.csv' },
  })
})

test('malformed preview responses become visible tab errors', async () => {
  api.get = (async () => ({ kind: 'spreadsheet', sheets: 'invalid' })) as typeof api.get
  useFilePreviewStore.setState({ tree: [] })

  useFilePreviewStore.getState().openFile('/workspace/broken.xlsx')
  await Promise.resolve()
  await Promise.resolve()

  expect(useFilePreviewStore.getState().tabs[0]).toMatchObject({ loading: false })
  expect(useFilePreviewStore.getState().tabs[0]?.error).toContain('expected array')
})

test('selecting a workbook sheet loads only the requested sheet', async () => {
  const requests: string[] = []
  api.get = (async (path: string) => {
    requests.push(path)
    const selected = path.includes('sheet=Expenses') ? 'Expenses' : 'Revenue'
    return {
      kind: 'spreadsheet',
      path: '/workspace/report.xlsx',
      name: 'report.xlsx',
      sheet_names: ['Revenue', 'Expenses'],
      sheets: [{ name: selected, rows: [[selected]] }],
      truncated: false,
    }
  }) as typeof api.get
  useSettingsStore.setState({ workspaceRoot: '/workspace' })
  useFilePreviewStore.setState({ tree: [] })

  useFilePreviewStore.getState().openFile('/workspace/report.xlsx')
  await Promise.resolve()
  await Promise.resolve()
  useFilePreviewStore.getState().selectSpreadsheetSheet('/workspace/report.xlsx', 'Expenses')
  await Promise.resolve()
  await Promise.resolve()

  expect(requests[1]?.endsWith('&sheet=Expenses')).toBe(true)
  expect(useFilePreviewStore.getState().tabs[0]?.preview).toMatchObject({ sheets: [{ name: 'Expenses' }] })
})

test('a slower workbook response cannot replace the most recently selected sheet', async () => {
  const firstSheet = {
    kind: 'spreadsheet' as const,
    path: '/workspace/report.xlsx',
    name: 'report.xlsx',
    sheet_names: ['Revenue', 'Expenses', 'Members'],
    sheets: [{ name: 'Revenue', rows: [['Revenue']] }],
    truncated: false,
  }
  const expenses = deferred<unknown>()
  const members = deferred<unknown>()
  let requestCount = 0
  api.get = ((path: string) => {
    requestCount++
    if (requestCount === 1) return Promise.resolve(firstSheet)
    return path.includes('sheet=Expenses') ? expenses.promise : members.promise
  }) as typeof api.get
  useSettingsStore.setState({ workspaceRoot: '/workspace' })
  useFilePreviewStore.setState({ tree: [] })

  useFilePreviewStore.getState().openFile('/workspace/report.xlsx')
  await Promise.resolve()
  await Promise.resolve()
  useFilePreviewStore.getState().selectSpreadsheetSheet('/workspace/report.xlsx', 'Expenses')
  useFilePreviewStore.getState().selectSpreadsheetSheet('/workspace/report.xlsx', 'Members')

  members.resolve({ ...firstSheet, sheets: [{ name: 'Members', rows: [['Members']] }] })
  await members.promise
  await Promise.resolve()
  expenses.resolve({ ...firstSheet, sheets: [{ name: 'Expenses', rows: [['Expenses']] }] })
  await expenses.promise
  await Promise.resolve()

  expect(useFilePreviewStore.getState().tabs[0]?.preview).toMatchObject({ sheets: [{ name: 'Members' }] })
})
