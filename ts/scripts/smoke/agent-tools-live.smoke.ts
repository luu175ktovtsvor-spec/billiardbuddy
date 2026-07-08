import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '../../src/harness/loop'
import { DEFAULT_MODEL_ENV_FILES, loadEnvFiles } from '../../src/model/envLoader'
import { createModelFromProviderConfig } from '../../src/model/modelFactory'
import { providerConfigFromEnv, redactedProviderSummary } from '../../src/model/providerConfig'
import { readXlsxSheet, renderMinimalXlsx } from '../../src/server/services/officeDocuments'
import { buildGeneralRegistry } from '../../src/tools/generalTools'
import { Workspace } from '../../src/workspace/workspace'

const args = process.argv.slice(2)
const envFiles = args.filter(arg => !arg.startsWith('--'))
const keepWorkspace = args.includes('--keep-workspace')
const mergedEnv = {
  ...process.env,
  ...loadEnvFiles(envFiles.length ? envFiles : DEFAULT_MODEL_ENV_FILES),
}

const config = providerConfigFromEnv(mergedEnv)
if (!config) {
  console.error('未找到可用模型配置:需要 ANTHROPIC_* 或 DEEPSEEK/OPENAI/TEXT_MODEL_* 环境变量')
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'agent-tools-smoke-'))
writeFileSync(join(root, 'notes.txt'), '周末活动方案：充500送100，办个比赛聚人气', 'utf8')
writeFileSync(join(root, 'readme.md'), '# 我的台球房\n联系电话 123456', 'utf8')
writeFileSync(join(root, 'report.xlsx'), Buffer.from(renderMinimalXlsx('项目,金额\n营业额,32000')))

console.log('provider', JSON.stringify(redactedProviderSummary(config)))
console.log('workspace', root)

const expectedTools = ['read_file', 'write_file', 'edit_file', 'edit_excel', 'run_command']
const usedTools: string[] = []
let finalText = ''
let failed = false

try {
  for await (const ev of runAgentLoop({
    model: createModelFromProviderConfig(config),
    registry: buildGeneralRegistry(),
    workspace: new Workspace(root),
    systemPrompt: [
      'You are a coding-agent smoke tester.',
      'You must use the requested tools and actually modify files in the workspace.',
      'First read notes.txt, then create plan.txt, edit notes.txt, update report.xlsx B2 to 88000, and run ls to verify the workspace.',
      'Do not skip tool calls.',
    ].join('\n'),
    userMessage: [
      '请完成一次工具链 smoke:',
      '1. 读取 notes.txt。',
      '2. 新建 plan.txt，写入“周六晚八点八球比赛，报名费30”。',
      '3. 把 notes.txt 里的“充500送100”改成“充1000送300”。',
      '4. 把 report.xlsx 的 B2 单元格改成 88000。',
      '5. 用 ls 列出工作区文件，然后总结。',
    ].join('\n'),
    permissionMode: 'full',
    maxTurns: 8,
    contextWindowChars: 200_000,
    conversationId: 'agent-tools-live-smoke',
  })) {
    if (ev.type === 'tool_call') usedTools.push(ev.tool)
    if (ev.type === 'final') finalText = ev.text
  }

  const notes = readFileSync(join(root, 'notes.txt'), 'utf8')
  const planOk = existsSync(join(root, 'plan.txt')) && readFileSync(join(root, 'plan.txt'), 'utf8').includes('八球比赛')
  const sheet = await readXlsxSheet(join(root, 'report.xlsx'))
  const sheetValue = sheet.sheets[0]?.rows[1]?.[1]
  const missing = expectedTools.filter(tool => !usedTools.includes(tool))
  const checks = {
    usedTools,
    missingTools: missing,
    notesEdited: notes.includes('充1000送300') && !notes.includes('充500送100'),
    planOk,
    sheetValue,
    sheetOk: sheetValue === '88000',
    finalPreview: finalText.slice(0, 160),
  }
  console.log(JSON.stringify(checks, null, 2))
  if (missing.length > 0 || !checks.notesEdited || !checks.planOk || !checks.sheetOk) {
    failed = true
    console.error('agent tool smoke failed')
  }
} finally {
  if (!keepWorkspace) rmSync(root, { recursive: true, force: true })
}

if (failed) process.exit(2)
console.log(JSON.stringify({ ok: true, usedTools }))
