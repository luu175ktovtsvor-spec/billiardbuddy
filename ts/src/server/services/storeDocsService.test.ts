import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Workspace } from '../../workspace/workspace'
import { DesktopDataStore } from './desktopDataStore'
import { StoreDocsService, createStoreDocsTool } from './storeDocsService'

test('StoreDocsService indexes local store documents and returns sourced hits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-docs-service-'))
  try {
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '价目表.txt'), '黄金档台费 68 元一小时。会员充值满 1000 送 120。')
    writeFileSync(join(docsDir, '排班.csv'), '姓名,班次\n小王,周五晚班\n')

    const data = new DesktopDataStore(root)
    const service = new StoreDocsService(data, root)
    const status = await service.setFolder(docsDir)
    expect(status).toMatchObject({ folder_path: docsDir, status: 'ready', indexed_file_count: 2 })

    const hits = await service.search('黄金档台费', 3)
    expect(hits[0]).toMatchObject({
      source_id: 'S1',
      file_name: '价目表.txt',
      chunk_index: 0,
      confidence: 'high',
    })
    expect(hits[0]!.excerpt).toContain('68')
    expect(hits[0]!.matched_terms.length).toBeGreaterThan(0)
    expect(hits[0]!.why).toContain('命中')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search_store_docs tool exposes sourced excerpts to the agent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-docs-tool-'))
  try {
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '合同.md'), '租期到 2027 年 8 月，门头广告位归本店使用。')

    const data = new DesktopDataStore(root)
    const service = new StoreDocsService(data, root)
    await service.setFolder(docsDir)
    const tool = createStoreDocsTool(service)
    const out = await tool.execute({ query: '门头广告位' }, { workspace: new Workspace(root) })

    expect(out).toContain('合同.md')
    expect(out).toContain('门头广告位')
    expect(out).toContain('<store_doc_sources>')
    expect(out).toContain('<store_doc_sources_json>')
    expect(out).toContain('[S1]')
    expect(out).toContain('可信度:')
    expect(out).toContain('匹配:')
    expect(out).toContain('路径:')
    const json = out.match(/<store_doc_sources_json>\s*([\s\S]*?)\s*<\/store_doc_sources_json>/)?.[1]
    expect(json).toBeTruthy()
    expect(JSON.parse(json || '{}').hits[0]).toMatchObject({
      source_id: 'S1',
      file_name: '合同.md',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('StoreDocsService hybrid ranking prefers focused phrase matches over noisy repeats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-docs-rank-'))
  try {
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '转化SOP.md'), '散客转会员 SOP：先发体验券，再介绍充值卡权益，最后约下次到店。')
    writeFileSync(join(docsDir, '噪声记录.txt'), `${'散客 '.repeat(80)}\n${'会员 '.repeat(80)}`)

    const data = new DesktopDataStore(root)
    const service = new StoreDocsService(data, root)
    await service.setFolder(docsDir)
    const hits = await service.search('散客转会员', 2)

    expect(hits[0]).toMatchObject({ file_name: '转化SOP.md' })
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('StoreDocsService semantic expansion finds local wording variants and explains them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-docs-semantic-'))
  try {
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '前台收费规则.md'), '晚高峰收费 68 元/小时，周末不参与普通折扣。')
    writeFileSync(join(docsDir, '员工排班.md'), '小王周五晚班，小李周六早班。')

    const data = new DesktopDataStore(root)
    const service = new StoreDocsService(data, root)
    await service.setFolder(docsDir)
    const hits = await service.search('黄金档台费多少', 3)

    expect(hits[0]).toMatchObject({ file_name: '前台收费规则.md' })
    expect(hits[0]!.excerpt).toContain('68')
    expect(hits[0]!.matched_terms).toEqual(expect.arrayContaining(['晚高峰', '收费']))
    expect(hits[0]!.why).toContain('语义扩展命中')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('StoreDocsService can restrict search to indexed file names or paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-docs-scope-'))
  try {
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '价目表.txt'), '会员充值满 1000 送 120。')
    writeFileSync(join(docsDir, '排班.txt'), '晚高峰由小王和小李值班。')

    const data = new DesktopDataStore(root)
    const service = new StoreDocsService(data, root)
    await service.setFolder(docsDir)

    expect((await service.search('会员充值', 3))[0]).toMatchObject({ file_name: '价目表.txt' })
    expect(await service.search('会员充值', 3, { paths: ['排班.txt'] })).toEqual([])
    expect((await service.search('晚高峰', 3, { paths: ['排班.txt'] }))[0]).toMatchObject({ file_name: '排班.txt' })
    expect((await service.search('晚高峰', 3, { paths: [join(docsDir, '排班.txt')] }))[0]).toMatchObject({ file_name: '排班.txt' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search_store_docs tool accepts path scope without reading arbitrary files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'store-docs-tool-scope-'))
  try {
    const docsDir = join(root, 'docs')
    mkdirSync(docsDir)
    writeFileSync(join(docsDir, '合同.md'), '租期到 2027 年 8 月。')
    writeFileSync(join(docsDir, '排班.md'), '周五晚高峰由小王值班。')

    const data = new DesktopDataStore(root)
    const service = new StoreDocsService(data, root)
    await service.setFolder(docsDir)
    const tool = createStoreDocsTool(service)

    const scoped = await tool.execute({ query: '租期', path: '排班.md' }, { workspace: new Workspace(root) })
    expect(scoped).toContain('没有在指定店铺文件范围内找到相关内容')
    expect(scoped).toContain('排班.md')

    const hit = await tool.execute({ query: '租期', paths: ['合同.md'] }, { workspace: new Workspace(root) })
    expect(hit).toContain('合同.md')
    expect(hit).toContain('<store_doc_sources_json>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
