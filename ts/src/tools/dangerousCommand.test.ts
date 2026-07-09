import { expect, test } from 'bun:test'
import { classifyCommandRisk, isDangerousCommand } from './dangerousCommand'

// ─────────────────────────────────────────────────────────────────────────────
// cmd.exe 原生毁灭命令红线(唯一发版平台是 Windows,run_command 默认 spawn `cmd /c`,
// 且 Windows 无 OS 写围栏,红线是本机文件唯一主防线)。灾难级 → isDangerousCommand 直接拒;
// 有破坏面但可控 → classifyCommandRisk 判 destructive 交审批闸。锚定方式对齐参考实现
// (PowerShell destructiveCommandWarning 的 `(?:^|[|;&\n({])\s*` 语句起始锚,本仓库扩成
//  WIN_STMT_START:再加前导空白 / `cmd /c "` / `-Command "` 转手)。
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. 灾难级红线:格盘 / 分区 / 擦除 / 删卷影 / 篡改引导 / 清 USN ──
test('红线:格式化磁盘卷(盘符在前/在后、开关任意序、带引号、大小写不敏感)', () => {
  expect(isDangerousCommand('format c:')).toBe(true)
  expect(isDangerousCommand('format C:\\ /q')).toBe(true)
  expect(isDangerousCommand('FORMAT /FS:NTFS /Q D:')).toBe(true)
  expect(isDangerousCommand('Format "e:" /y')).toBe(true)
  expect(isDangerousCommand('format.com c:')).toBe(true)
})

test('红线:磁盘分区 / 擦除空闲空间 / 删卷影 / 篡改引导 / 清 USN 日志', () => {
  expect(isDangerousCommand('diskpart')).toBe(true)
  expect(isDangerousCommand('DiskPart /s script.txt')).toBe(true)
  expect(isDangerousCommand('diskpart.exe')).toBe(true)
  expect(isDangerousCommand('cipher /w:c:\\')).toBe(true)
  expect(isDangerousCommand('cipher.exe /W:C:\\')).toBe(true)
  expect(isDangerousCommand('vssadmin delete shadows /all /quiet')).toBe(true)
  expect(isDangerousCommand('vssadmin Delete Shadows /All')).toBe(true)
  expect(isDangerousCommand('wmic shadowcopy delete')).toBe(true)
  expect(isDangerousCommand('bcdedit /delete {current}')).toBe(true)
  expect(isDangerousCommand('bcdedit /set {default} safeboot minimal')).toBe(true)
  expect(isDangerousCommand('fsutil usn deletejournal /d c:')).toBe(true)
  expect(isDangerousCommand('fsutil file setzerodata offset=0 length=99999 secret.txt')).toBe(true)
})

// ── 2. 删注册表系统蜂巢(砖机)──
test('红线:reg delete 系统蜂巢(HKLM/HKCR/全名)', () => {
  expect(isDangerousCommand('reg delete HKLM\\Software\\Foo /f')).toBe(true)
  expect(isDangerousCommand('reg delete "HKEY_LOCAL_MACHINE\\SYSTEM" /f')).toBe(true)
  expect(isDangerousCommand('reg delete HKCR\\.txt /f')).toBe(true)
  expect(isDangerousCommand('REG DELETE HKEY_CLASSES_ROOT\\x /f')).toBe(true)
})

// ── 3. 删盘符根 / 用户根 env / 通配全删 / 递归绝对路径(rm C:\ | rm * 的 cmd 版)──
test('红线:del/erase/rd/rmdir 打盘符根或系统/用户根环境变量', () => {
  expect(isDangerousCommand('del C:\\')).toBe(true)
  expect(isDangerousCommand('del C:\\*')).toBe(true)
  expect(isDangerousCommand('erase D:\\')).toBe(true)
  expect(isDangerousCommand('rd /s /q C:\\')).toBe(true)
  expect(isDangerousCommand('rmdir /S /Q "C:\\Windows"')).toBe(true)
  expect(isDangerousCommand('del /q %USERPROFILE%')).toBe(true)
  expect(isDangerousCommand('rd /s %SystemRoot%')).toBe(true)
  expect(isDangerousCommand('del %SystemDrive%\\*')).toBe(true)
})

test('红线:del/erase/rd/rmdir 通配全删(del * | del *.* | del /f /q *)', () => {
  expect(isDangerousCommand('del *')).toBe(true)
  expect(isDangerousCommand('del *.*')).toBe(true)
  expect(isDangerousCommand('del /f /q *')).toBe(true)
  expect(isDangerousCommand('erase *.*')).toBe(true)
  expect(isDangerousCommand('del "*"')).toBe(true)
})

test('红线:del /s 递归打到盘符绝对路径(审计点名的原样毁数据例子,开关两种顺序)', () => {
  expect(isDangerousCommand('del /f /s /q C:\\Users\\me\\Documents\\*')).toBe(true)
  expect(isDangerousCommand('del C:\\Users\\me\\Documents\\* /f /s /q')).toBe(true)
  expect(isDangerousCommand('rd /s /q D:\\data')).toBe(true)
  expect(isDangerousCommand('del /f/s/q C:\\*')).toBe(true) // 开关不带空格
  expect(isDangerousCommand('del/f/s/q C:\\*')).toBe(true) // del 后不带空格(cmd 允许 del/x)
})

// ── 4. PowerShell 原生毁灭 cmdlet(即使经 cmd /c 转手)──
test('红线:PowerShell 毁灭 cmdlet(Remove-Item -Recurse -Force 打根 / Format-Volume / Clear-Disk 等)', () => {
  expect(isDangerousCommand('Remove-Item -Recurse -Force C:\\')).toBe(true)
  expect(isDangerousCommand('Remove-Item -Force -Recurse $HOME')).toBe(true)
  expect(isDangerousCommand('Format-Volume -DriveLetter D')).toBe(true)
  expect(isDangerousCommand('Clear-Disk -Number 0 -RemoveData')).toBe(true)
  expect(isDangerousCommand('Clear-RecycleBin -Force')).toBe(true)
  expect(isDangerousCommand('Stop-Computer -Force')).toBe(true)
  expect(isDangerousCommand('Restart-Computer')).toBe(true)
})

// ── 5. cmd fork 炸弹 / 裸盘原始写入 ──
test('红线:cmd fork 炸弹 / 裸物理盘原始写入', () => {
  expect(isDangerousCommand('%0|%0')).toBe(true)
  expect(isDangerousCommand('echo x > \\\\.\\PhysicalDrive0')).toBe(true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 刁钻边界(照 #45 被审出的两类绕过教训 + 本轮补的 %SystemDrive%/短路径/续行/语句分隔)
// ─────────────────────────────────────────────────────────────────────────────

test('刁钻:引号手递转手(cmd /c "…" / powershell -Command "…")不降级', () => {
  expect(isDangerousCommand('cmd /c "del C:\\*"')).toBe(true)
  expect(isDangerousCommand('cmd /c "del /s /q C:\\"')).toBe(true)
  expect(isDangerousCommand('cmd /c "format c:"')).toBe(true)
  expect(isDangerousCommand('cmd /c "rd /s /q C:\\"')).toBe(true)
  expect(isDangerousCommand('cmd /c "diskpart"')).toBe(true)
  expect(isDangerousCommand('cmd /c format c:')).toBe(true)
  expect(isDangerousCommand('powershell -Command "Remove-Item -Recurse -Force C:\\"')).toBe(true)
  expect(isDangerousCommand('powershell -c "Remove-Item -Recurse -Force C:\\"')).toBe(true)
  expect(isDangerousCommand('cmd /c powershell -c "Clear-Disk -Number 0"')).toBe(true)
})

test('刁钻:前导空白降级(空格 / 制表符)', () => {
  expect(isDangerousCommand('  format c:')).toBe(true)
  expect(isDangerousCommand('\tformat c:')).toBe(true)
  expect(isDangerousCommand('  DEL /F /S /Q C:\\*')).toBe(true)
  expect(isDangerousCommand('  rd /s /q C:\\')).toBe(true)
  expect(isDangerousCommand('   diskpart')).toBe(true)
})

test('刁钻:大小写混合(DEL / Del / FoRmAt)', () => {
  expect(isDangerousCommand('DEL /F /S /Q C:\\*')).toBe(true)
  expect(isDangerousCommand('Del C:\\*')).toBe(true)
  expect(isDangerousCommand('FoRmAt C:')).toBe(true)
  expect(isDangerousCommand('RmDir /S /Q C:\\Windows')).toBe(true)
})

test('刁钻:路径变量 %SystemDrive% / %SystemRoot%(展开即盘符根)', () => {
  expect(isDangerousCommand('format %SystemDrive%')).toBe(true)
  expect(isDangerousCommand('format %SystemRoot%')).toBe(true)
  expect(isDangerousCommand('format "%SystemDrive%"')).toBe(true)
  expect(isDangerousCommand('del /s /q %SystemDrive%\\*')).toBe(true)
  expect(isDangerousCommand('rd /s /q %USERPROFILE%')).toBe(true)
})

test('刁钻:短路径(8.3 名)仍带盘符根 → 递归删照拦', () => {
  expect(isDangerousCommand('del /s /q C:\\DOCUME~1\\*')).toBe(true)
  expect(isDangerousCommand('rd /s /q C:\\PROGRA~1')).toBe(true)
})

test('刁钻:cmd 语句分隔(& / && / |)后的危险命令仍锚住', () => {
  expect(isDangerousCommand('echo hi && format c:')).toBe(true)
  expect(isDangerousCommand('echo hi & del /s /q C:\\*')).toBe(true)
  expect(isDangerousCommand('type x | format c:')).toBe(true)
  expect(isDangerousCommand('cd /d C:\\ & rd /s /q C:\\Windows')).toBe(true)
})

test('刁钻:^ 行尾续行把危险词与盘符拆到两行 → 归一后仍拦', () => {
  expect(isDangerousCommand('format ^\nc:')).toBe(true)
  expect(isDangerousCommand('format ^\n%SystemDrive%')).toBe(true)
  expect(isDangerousCommand('del /s /q ^\nC:\\*')).toBe(true)
})

// ─────────────────────────────────────────────────────────────────────────────
// 审批闸档:有破坏面但可控(达不到「直接拒」灾难级)→ classifyCommandRisk = destructive。
// 交用户逐条确认,而不是硬拒(口径对齐 POSIX:递归删具体目录 = destructive,同 `rm -rf 目录`)。
// ─────────────────────────────────────────────────────────────────────────────

test('审批档:递归删具体(相对)目录 = destructive(非红线)', () => {
  expect(isDangerousCommand('rd /s /q build')).toBe(false)
  expect(classifyCommandRisk('rd /s /q build')).toBe('destructive')
  expect(classifyCommandRisk('del /s *.tmp')).toBe('destructive')
  expect(classifyCommandRisk('rmdir /s node_modules')).toBe('destructive')
})

test('审批档:结进程 / 删写注册表(非根)/ 服务控制 / 账户组 / 夺权改 ACL = destructive', () => {
  expect(classifyCommandRisk('taskkill /f /im notepad.exe')).toBe('destructive')
  expect(classifyCommandRisk('taskkill /im notepad.exe')).toBe('destructive')
  expect(classifyCommandRisk('reg delete HKCU\\Software\\MyApp /f')).toBe('destructive')
  expect(classifyCommandRisk('reg add HKCU\\Software\\X /v Y /d 1 /f')).toBe('destructive')
  expect(classifyCommandRisk('sc delete MyService')).toBe('destructive')
  expect(classifyCommandRisk('sc stop Spooler')).toBe('destructive')
  expect(classifyCommandRisk('net stop Spooler')).toBe('destructive')
  expect(classifyCommandRisk('net user attacker /delete')).toBe('destructive')
  // takeown / icacls / cacls —— 夺所有权、批量改 ACL(有破坏面但不直接毁数据 → 审批档)
  expect(classifyCommandRisk('takeown /f C:\\foo /r')).toBe('destructive')
  expect(classifyCommandRisk('icacls C:\\foo /grant User:F /t')).toBe('destructive')
  expect(classifyCommandRisk('cacls C:\\foo /g User:F')).toBe('destructive')
})

test('审批档:红线级命令的 classifyCommandRisk 也落 destructive(会被 execute 直接拒)', () => {
  expect(classifyCommandRisk('format c:')).toBe('destructive')
  expect(classifyCommandRisk('del /f /s /q C:\\Users\\me\\Documents\\*')).toBe('destructive')
  expect(classifyCommandRisk('diskpart /s x.txt')).toBe('destructive')
  expect(classifyCommandRisk('format %SystemDrive%')).toBe('destructive')
  // 转手 / 前导空白版也必须落 destructive(不是 file)
  expect(classifyCommandRisk('cmd /c "del C:\\*"')).toBe('destructive')
  expect(classifyCommandRisk('powershell -Command "Remove-Item -Recurse -Force C:\\"')).toBe('destructive')
  expect(classifyCommandRisk('  format c:')).toBe('destructive')
  // 审批档动词经 cmd /c / -Command 转手也不降级成 file
  expect(classifyCommandRisk('cmd /c "rd /s /q build"')).toBe('destructive')
  expect(classifyCommandRisk('powershell -Command "reg delete HKCU\\Software\\X /f"')).toBe('destructive')
})

// ─────────────────────────────────────────────────────────────────────────────
// 不做过度拦截:正常命令 / 相近词 / 引号里只是提到危险词 → 不误杀(参照参考实现的语句起始锚)。
// ─────────────────────────────────────────────────────────────────────────────

test('不误杀:正常 cmd 命令与相近词', () => {
  expect(isDangerousCommand('dir')).toBe(false)
  expect(isDangerousCommand('dir /s')).toBe(false)
  expect(isDangerousCommand('type file.txt')).toBe(false)
  expect(isDangerousCommand('echo hello')).toBe(false)
  expect(isDangerousCommand('copy a.txt b.txt')).toBe(false)
  expect(isDangerousCommand('del report.txt')).toBe(false)
  expect(isDangerousCommand('del C:\\Users\\me\\report.txt')).toBe(false) // 删具体文件(非根/非通配)
  expect(isDangerousCommand('rd /s /q build')).toBe(false) // 相对目录递归 → 审批档而非红线
  // 相近词/子命令不能误当红线
  expect(isDangerousCommand('dotnet format')).toBe(false)
  expect(isDangerousCommand('git format-patch -1 HEAD')).toBe(false)
  expect(isDangerousCommand('msgfmt format.po')).toBe(false)
  expect(isDangerousCommand('format')).toBe(false) // 无盘符/fs 目标
  expect(isDangerousCommand('reg query HKLM\\Software\\Microsoft')).toBe(false)
  expect(isDangerousCommand('reg delete HKCU\\Software\\MyApp /f')).toBe(false) // 非系统蜂巢 → 审批档
  expect(isDangerousCommand('taskkill /f /im notepad.exe')).toBe(false) // 审批档非红线
  expect(isDangerousCommand('sc query Spooler')).toBe(false)
  expect(isDangerousCommand('vssadmin list shadows')).toBe(false) // 只列不删
})

test('不误杀:引号里只是提到危险词(echo 一句话,并非 /c|-c 转手)', () => {
  expect(isDangerousCommand('echo "del C:\\ is dangerous"')).toBe(false)
  expect(isDangerousCommand('echo "run diskpart to wipe"')).toBe(false)
  expect(isDangerousCommand('echo format c: please')).toBe(false)
  expect(isDangerousCommand('echo "vssadmin delete shadows"')).toBe(false)
})

test('不误杀:正常命令的 classifyCommandRisk 落在 read/file 档', () => {
  expect(classifyCommandRisk('dir')).toBe('read')
  expect(classifyCommandRisk('dir /s /b')).toBe('read')
  expect(classifyCommandRisk('type package.json')).toBe('read')
  expect(classifyCommandRisk('reg query HKLM\\Software\\Microsoft')).toBe('read')
  expect(classifyCommandRisk('sc query Spooler')).toBe('read')
  expect(classifyCommandRisk('tasklist')).toBe('read')
  expect(classifyCommandRisk('where node')).toBe('read')
  expect(classifyCommandRisk('del report.txt')).toBe('file')
  expect(classifyCommandRisk('copy a.txt b.txt')).toBe('file')
  expect(classifyCommandRisk('move a.txt b.txt')).toBe('file')
})

// POSIX 红线不因新增 Windows 分支而回归(同族刁钻边界)
test('回归:POSIX 灾难级红线仍拦(rm -rf / | ~ | 盘符根 / sudo / mkfs / dd)', () => {
  expect(isDangerousCommand('rm -rf /')).toBe(true)
  expect(isDangerousCommand('rm -rf ~')).toBe(true)
  expect(isDangerousCommand('rm -fr $HOME')).toBe(true)
  expect(isDangerousCommand('sudo reboot')).toBe(true)
  expect(isDangerousCommand('mkfs.ext4 /dev/sda1')).toBe(true)
  expect(isDangerousCommand('dd if=/dev/zero of=/dev/sda')).toBe(true)
  expect(isDangerousCommand('rm -rf *')).toBe(true)
  expect(isDangerousCommand('ls -la')).toBe(false)
  expect(isDangerousCommand('rm file.txt')).toBe(false)
})
