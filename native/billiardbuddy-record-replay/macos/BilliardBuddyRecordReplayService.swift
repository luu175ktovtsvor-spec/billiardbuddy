import AppKit
import ApplicationServices
import Foundation

private struct TraceEvent: Codable {
  let offsetMs: Int
  let kind: String
  let appId: String?
  let appName: String?
  let x: Double?
  let y: Double?
  let deltaY: Int?
}

private struct Trace: Codable {
  let version: Int
  let platform: String
  let purpose: String
  let durationMs: Int
  let privacy: String
  let events: [TraceEvent]
}

private var activeTap: CFMachPort?

/** A listen-only event tap: it never changes, consumes or replays user input. */
private final class Recorder {
  private let started = Date()
  private var events: [TraceEvent] = []

  func record(_ type: CGEventType, _ event: CGEvent) {
    guard events.count < 5_000 else { return }
    let app = NSWorkspace.shared.frontmostApplication
    let offset = Int(Date().timeIntervalSince(started) * 1_000)
    switch type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      let point = event.location
      events.append(TraceEvent(offsetMs: offset, kind: "pointer_click", appId: app?.bundleIdentifier, appName: app?.localizedName, x: point.x, y: point.y, deltaY: nil))
    case .scrollWheel:
      let point = event.location
      events.append(TraceEvent(offsetMs: offset, kind: "scroll", appId: app?.bundleIdentifier, appName: app?.localizedName, x: point.x, y: point.y, deltaY: Int(event.getIntegerValueField(.scrollWheelEventDeltaAxis1))))
    case .keyDown:
      // Do not retain key code, Unicode text, IME composition, clipboard or modifier details.
      events.append(TraceEvent(offsetMs: offset, kind: "text_input_redacted", appId: app?.bundleIdentifier, appName: app?.localizedName, x: nil, y: nil, deltaY: nil))
    default:
      break
    }
  }

  func trace(purpose: String) -> Trace {
    Trace(
      version: 1,
      platform: "macOS",
      purpose: purpose,
      durationMs: Int(Date().timeIntervalSince(started) * 1_000),
      privacy: "No typed text, key codes, clipboard content, cookies, passwords, screen video or screenshots were recorded.",
      events: events
    )
  }
}

private func callback(
  _ proxy: CGEventTapProxy,
  _ type: CGEventType,
  _ event: CGEvent,
  _ info: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let activeTap { CGEvent.tapEnable(tap: activeTap, enable: true) }
    return Unmanaged.passUnretained(event)
  }
  if let info { Unmanaged<Recorder>.fromOpaque(info).takeUnretainedValue().record(type, event) }
  return Unmanaged.passUnretained(event)
}

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 6, CommandLine.arguments[1] == "record" else {
  fail("usage: BilliardBuddyRecordReplayService record <trace.json> <stop-file> <max-seconds> <purpose>")
}

let traceURL = URL(fileURLWithPath: CommandLine.arguments[2])
let stopURL = URL(fileURLWithPath: CommandLine.arguments[3])
guard let maximum = TimeInterval(CommandLine.arguments[4]), maximum >= 30, maximum <= 1_800 else { fail("invalid recording duration") }
let purpose = CommandLine.arguments[5]
NSApplication.shared.setActivationPolicy(.accessory)
let confirmation = NSAlert()
confirmation.messageText = "开始录制此工作流？"
confirmation.informativeText = "BilliardBuddy 将在最多 \(Int(maximum)) 秒内记录点击、滚动、前台应用名称和已脱敏的输入事件。不会记录输入文字、剪贴板、密码、Cookie、截图或视频。"
confirmation.addButton(withTitle: "开始录制")
confirmation.addButton(withTitle: "取消")
guard confirmation.runModal() == .alertFirstButtonReturn else { fail("BILLIARDBUDDY_RECORDING_USER_DENIED") }
guard AXIsProcessTrusted() else { fail("BILLIARDBUDDY_RECORDING_ACCESSIBILITY_REQUIRED") }

private let recorder = Recorder()
private let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown]
private let mask = types.reduce(CGEventMask(0)) { value, type in value | (CGEventMask(1) << CGEventMask(type.rawValue)) }
private let retained = Unmanaged.passRetained(recorder)
guard let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: mask,
  callback: callback,
  userInfo: retained.toOpaque()
) else {
  retained.release()
  fail("BILLIARDBUDDY_RECORDING_ACCESSIBILITY_REQUIRED")
}
activeTap = tap

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
CGEvent.tapEnable(tap: tap, enable: true)
let deadline = Date().addingTimeInterval(maximum)
while Date() < deadline && !FileManager.default.fileExists(atPath: stopURL.path) {
  RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
activeTap = nil
retained.release()

do {
  try FileManager.default.createDirectory(at: traceURL.deletingLastPathComponent(), withIntermediateDirectories: true)
  let data = try JSONEncoder().encode(recorder.trace(purpose: purpose))
  try data.write(to: traceURL, options: .atomic)
} catch {
  fail("BILLIARDBUDDY_RECORDING_WRITE_FAILED: \(error.localizedDescription)")
}
