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

test('Windows/cmd 毁灭命令命中警告', () => {
  expect(getDestructiveCommandWarning('format c:')).toContain('格式化')
  expect(getDestructiveCommandWarning('FORMAT /FS:NTFS D:')).toContain('格式化')
  expect(getDestructiveCommandWarning('diskpart /s x.txt')).toContain('分区')
  expect(getDestructiveCommandWarning('cipher /w:c:\\')).toContain('擦除')
  expect(getDestructiveCommandWarning('vssadmin delete shadows /all')).toContain('卷影')
  expect(getDestructiveCommandWarning('bcdedit /delete {current}')).toContain('引导')
  expect(getDestructiveCommandWarning('del /f /s /q C:\\tmp\\*')).toContain('递归')
  expect(getDestructiveCommandWarning('rd /s /q build')).toContain('递归')
  expect(getDestructiveCommandWarning('reg delete HKCU\\Software\\X /f')).toContain('注册表')
  expect(getDestructiveCommandWarning('sc delete MyService')).toContain('服务')
  expect(getDestructiveCommandWarning('taskkill /f /im notepad.exe')).toContain('强制结束')
  expect(getDestructiveCommandWarning('takeown /f C:\\foo /r')).toContain('所有权')
  expect(getDestructiveCommandWarning('Remove-Item -Recurse -Force .\\tmp')).toContain('递归强制删除')
  expect(getDestructiveCommandWarning('Format-Volume -DriveLetter D')).toContain('格式化')
  expect(getDestructiveCommandWarning('Clear-RecycleBin')).toContain('回收站')
  expect(getDestructiveCommandWarning('Stop-Computer')).toContain('计算机')
})

test('Windows 警告堵引号/-Command/前导空白转手(卡片不漏弹)', () => {
  expect(getDestructiveCommandWarning('cmd /c "format c:"')).toContain('格式化')
  expect(getDestructiveCommandWarning('cmd /c "del C:\\* /s /q"')).toContain('递归')
  expect(getDestructiveCommandWarning('cmd /c "diskpart"')).toContain('分区')
  expect(getDestructiveCommandWarning('powershell -Command "Remove-Item -Recurse -Force C:\\"')).toContain('递归强制删除')
  expect(getDestructiveCommandWarning('  format c:')).toContain('格式化')
  expect(getDestructiveCommandWarning('\tdiskpart')).toContain('分区')
  expect(getDestructiveCommandWarning('taskkill /im notepad.exe')).toContain('强制结束')
})

test('普通命令无警告', () => {
  expect(getDestructiveCommandWarning('ls -la')).toBeNull()
  expect(getDestructiveCommandWarning('echo hi')).toBeNull()
  expect(getDestructiveCommandWarning('git status')).toBeNull()
  expect(getDestructiveCommandWarning('cat file.txt')).toBeNull()
  expect(getDestructiveCommandWarning('dir /s')).toBeNull()
  expect(getDestructiveCommandWarning('dotnet format')).toBeNull()
  expect(getDestructiveCommandWarning('reg query HKLM\\Software')).toBeNull()
  expect(getDestructiveCommandWarning('del report.txt')).toBeNull()
})
