import { expect, test } from 'bun:test'
import { getDestructiveCommandWarning } from './destructiveCommandWarning'

test('破坏性命令命中警告', () => {
  expect(getDestructiveCommandWarning('rm -rf /tmp/x')).toContain('递归强制删除')
  expect(getDestructiveCommandWarning('git reset --hard HEAD~1')).toContain('未提交')
  expect(getDestructiveCommandWarning('git push --force origin main')).toContain('远端历史')
  expect(getDestructiveCommandWarning('DROP TABLE users')).toContain('数据库')
  expect(getDestructiveCommandWarning('kubectl delete pod x')).toContain('Kubernetes')
  expect(getDestructiveCommandWarning('terraform destroy')).toContain('Terraform')
})

test('普通命令无警告', () => {
  expect(getDestructiveCommandWarning('ls -la')).toBeNull()
  expect(getDestructiveCommandWarning('echo hi')).toBeNull()
  expect(getDestructiveCommandWarning('git status')).toBeNull()
  expect(getDestructiveCommandWarning('cat file.txt')).toBeNull()
})
