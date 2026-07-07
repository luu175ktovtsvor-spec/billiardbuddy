import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { verifyPlanExecutionTool } from './verifyPlanExecutionTool'

function workspace(): Workspace {
  return new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'verify-plan-'))))
}

test('VerifyPlanExecution rejects pass verdict without concrete evidence', async () => {
  const ctx = {
    workspace: workspace(),
    pendingPlanVerification: {
      plan: '1. 修改 src/a.ts\n2. 跑类型检查',
      verificationStarted: false,
      verificationCompleted: false,
    },
  }
  const output = await verifyPlanExecutionTool.execute({ status: 'pass', summary: '都完成了' }, ctx)

  expect(output).toContain('status="needs_evidence"')
  expect(ctx.pendingPlanVerification.verificationStarted).toBe(true)
  expect(ctx.pendingPlanVerification.verificationCompleted).toBe(false)
})

test('VerifyPlanExecution marks pending plan completed when evidence is concrete', async () => {
  const ctx = {
    workspace: workspace(),
    pendingPlanVerification: {
      plan: '1. 修改 src/a.ts\n2. 跑类型检查',
      verificationStarted: false,
      verificationCompleted: false,
      toolCallsSinceApproval: 4,
    },
  }
  const output = await verifyPlanExecutionTool.execute({
    status: 'pass',
    evidence: [
      { label: 'project_diagnostics typecheck', status: 'pass', output: 'bun run typecheck passed' },
    ],
  }, ctx)

  expect(output).toContain('status="pass"')
  expect(output).toContain('project_diagnostics typecheck')
  expect(ctx.pendingPlanVerification.verificationCompleted).toBe(true)
  expect(ctx.pendingPlanVerification.toolCallsSinceApproval).toBe(0)
})
