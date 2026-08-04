import AppKit
import ApplicationServices
import CryptoKit
import Foundation

private let maximumEvents = 2_000

private struct SemanticTarget: Codable, Equatable {
  let appId: String?
  let windowId: UInt64?
  let windowRole: String?
  let controlRole: String?
  let controlSubrole: String?
  let controlIdentifierDigest: String?
  let enabled: Bool?
  let focused: Bool?
  let secure: Bool?
  let actionable: Bool?
}

private struct AccessibilityDelta: Codable {
  let changed: [String]
  let target: SemanticTarget
}

private struct RecordedAction: Codable {
  let kind: String
  let outcome: String
  let button: String?
}

private struct TraceEvent: Codable {
  let sequence: Int
  let offsetMs: Int
  let kind: String
  let action: RecordedAction
  let target: SemanticTarget
  let accessibilityDelta: AccessibilityDelta?
}

private struct PendingEvent {
  let offsetMs: Int
  let kind: String
  let action: RecordedAction
  let point: CGPoint?
  let preferFocused: Bool
  let targetPid: pid_t?
  let windowId: UInt64?
}

private struct Session: Codable {
  let version: Int
  let platform: String
  let durationMs: Int
  let endReason: String
  let eventCount: Int
  let privacy: String
}

private var activeTap: CFMachPort?
private var runtimeRootURL: URL?

private func cleanupRuntimeState() {
  guard let root = runtimeRootURL else { return }
  for name in ["state.json", "pid", "stop"] {
    try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
  }
}

private func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else { return nil }
  return raw as? String
}

private func boolAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else { return nil }
  return (raw as? NSNumber)?.boolValue
}

private func numberAttribute(_ element: AXUIElement, _ attribute: CFString) -> Int? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else { return nil }
  return (raw as? NSNumber)?.intValue
}

private func elementAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
  var raw: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success, let raw else { return nil }
  guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(raw, to: AXUIElement.self)
}

private func identifierDigest(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  let digest = SHA256.hash(data: Data(value.utf8))
  return digest.prefix(12).map { String(format: "%02x", $0) }.joined()
}

private func actionNames(_ element: AXUIElement) -> [String] {
  var actions: CFArray?
  guard AXUIElementCopyActionNames(element, &actions) == .success else { return [] }
  return (actions as? [String]) ?? []
}

private func pidAttribute(_ element: AXUIElement) -> pid_t? {
  var pid: pid_t = 0
  return AXUIElementGetPid(element, &pid) == .success && pid > 0 ? pid : nil
}

private func frontWindowId(pid: pid_t, point: CGPoint?) -> UInt64? {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let candidates = windows.filter {
    (($0[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == Int(pid)) &&
    (($0[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0) == 0
  }
  let selected = point.flatMap { point in
    candidates.first { entry in
      guard let bounds = entry[kCGWindowBounds as String] as? [String: NSNumber] else { return false }
      let rect = CGRect(x: bounds["X"]?.doubleValue ?? 0, y: bounds["Y"]?.doubleValue ?? 0,
                        width: bounds["Width"]?.doubleValue ?? 0, height: bounds["Height"]?.doubleValue ?? 0)
      return rect.contains(point)
    }
  } ?? candidates.first
  return (selected?[kCGWindowNumber as String] as? NSNumber)?.uint64Value
}

private func enclosingAccessibilityWindow(_ element: AXUIElement) -> AXUIElement? {
  var current = element
  for _ in 0..<64 {
    if stringAttribute(current, kAXRoleAttribute as CFString) == "AXWindow" { return current }
    guard let parent = elementAttribute(current, kAXParentAttribute as CFString) else { return nil }
    current = parent
  }
  return nil
}

/**
 * Event taps resolve AX state asynchronously. Only retain control semantics
 * when the later element still proves it belongs to the event-time CG window.
 */
private func elementBelongsToRecordedWindow(_ element: AXUIElement, pid: pid_t, windowId: UInt64?) -> Bool {
  guard let windowId,
        pidAttribute(element) == pid,
        let window = enclosingAccessibilityWindow(element),
        pidAttribute(window) == pid,
        let accessibilityWindowId = numberAttribute(window, "AXWindowNumber" as CFString),
        accessibilityWindowId >= 0
  else { return false }
  return UInt64(accessibilityWindowId) == windowId
}

private func semanticTarget(at point: CGPoint?, preferFocused: Bool, targetPid: pid_t?, windowId: UInt64?) -> SemanticTarget {
  let app = targetPid.flatMap(NSRunningApplication.init(processIdentifier:))
  guard let app else {
    return SemanticTarget(appId: nil, windowId: nil, windowRole: nil, controlRole: nil, controlSubrole: nil, controlIdentifierDigest: nil, enabled: nil, focused: nil, secure: nil, actionable: nil)
  }
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  var element: AXUIElement?
  if preferFocused {
    element = elementAttribute(appElement, kAXFocusedUIElementAttribute as CFString)
  } else if let point {
    let system = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
       let hit, pidAttribute(hit) == app.processIdentifier {
      element = hit
    }
  }
  element = element ?? elementAttribute(appElement, kAXFocusedUIElementAttribute as CFString)
  let verifiedElement = element.flatMap {
    elementBelongsToRecordedWindow($0, pid: app.processIdentifier, windowId: windowId) ? $0 : nil
  }
  let verifiedWindow = verifiedElement.flatMap(enclosingAccessibilityWindow)
  let role = verifiedElement.flatMap { stringAttribute($0, kAXRoleAttribute as CFString) }
  let subrole = verifiedElement.flatMap { stringAttribute($0, kAXSubroleAttribute as CFString) }
  let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
  return SemanticTarget(
    appId: app.bundleIdentifier,
    windowId: windowId,
    windowRole: verifiedWindow.flatMap { stringAttribute($0, kAXRoleAttribute as CFString) },
    controlRole: role,
    controlSubrole: subrole,
    controlIdentifierDigest: verifiedElement.flatMap { identifierDigest(stringAttribute($0, kAXIdentifierAttribute as CFString)) },
    enabled: verifiedElement.flatMap { boolAttribute($0, kAXEnabledAttribute as CFString) },
    focused: verifiedElement.flatMap { boolAttribute($0, kAXFocusedAttribute as CFString) },
    secure: secure ? true : nil,
    actionable: verifiedElement.map { !actionNames($0).isEmpty }
  )
}

private func changedFields(from previous: SemanticTarget?, to current: SemanticTarget) -> [String] {
  guard let previous else { return ["app", "window", "control", "state"] }
  var changed: [String] = []
  if previous.appId != current.appId { changed.append("app") }
  if previous.windowId != current.windowId || previous.windowRole != current.windowRole { changed.append("window") }
  if previous.controlRole != current.controlRole || previous.controlSubrole != current.controlSubrole || previous.controlIdentifierDigest != current.controlIdentifierDigest { changed.append("control") }
  if previous.enabled != current.enabled || previous.focused != current.focused || previous.secure != current.secure || previous.actionable != current.actionable { changed.append("state") }
  return changed
}

/** Listen-only tap. It cannot block, modify, or replay user input. */
private final class Recorder {
  private let started = Date()
  private let lock = NSLock()
  private var events: [TraceEvent] = []
  private var pending: [PendingEvent] = []
  private var lastTarget: SemanticTarget?
  private var lastRedactedInputOffsetMs: Int?

  // Event taps must return quickly. The callback pins only the event-time
  // process/window identity plus a short-lived coordinate in memory;
  // accessibility inspection happens from the run loop and no coordinate is
  // written to the event stream.
  func enqueue(_ type: CGEventType, _ event: CGEvent) {
    lock.lock()
    defer { lock.unlock() }
    guard events.count + pending.count < maximumEvents else { return }
    let action: RecordedAction
    let point: CGPoint?
    let preferFocused: Bool
    switch type {
    case .leftMouseDown:
      action = RecordedAction(kind: "pointer_click", outcome: "observed", button: "primary"); point = event.location; preferFocused = false
    case .rightMouseDown:
      action = RecordedAction(kind: "pointer_click", outcome: "observed", button: "secondary"); point = event.location; preferFocused = false
    case .otherMouseDown:
      action = RecordedAction(kind: "pointer_click", outcome: "observed", button: "other"); point = event.location; preferFocused = false
    case .scrollWheel:
      action = RecordedAction(kind: "scroll", outcome: "observed", button: nil); point = event.location; preferFocused = false
    case .keyDown:
      action = RecordedAction(kind: "text_input_redacted", outcome: "redacted", button: nil); point = nil; preferFocused = true
    default: return
    }
    let offsetMs = Int(Date().timeIntervalSince(started) * 1_000)
    if action.kind == "text_input_redacted", let previous = lastRedactedInputOffsetMs, offsetMs - previous < 500 { return }
    if action.kind == "text_input_redacted" { lastRedactedInputOffsetMs = offsetMs }
    let rawPid = event.getIntegerValueField(.eventTargetUnixProcessID)
    let targetPid = rawPid > 0 && rawPid <= Int64(Int32.max)
      ? pid_t(rawPid)
      : NSWorkspace.shared.frontmostApplication?.processIdentifier
    let rawWindowId = point == nil ? 0 : event.getIntegerValueField(.mouseEventWindowUnderMousePointer)
    let windowId = rawWindowId > 0
      ? UInt64(rawWindowId)
      : targetPid.flatMap { frontWindowId(pid: $0, point: point) }
    pending.append(PendingEvent(
      offsetMs: offsetMs,
      kind: action.kind,
      action: action,
      point: point,
      preferFocused: preferFocused,
      targetPid: targetPid,
      windowId: windowId
    ))
  }

  func drain() {
    lock.lock()
    let collected = pending
    pending.removeAll(keepingCapacity: true)
    lock.unlock()
    for event in collected {
      let target = semanticTarget(
        at: event.point,
        preferFocused: event.preferFocused,
        targetPid: event.targetPid,
        windowId: event.windowId
      )
      lock.lock()
      guard events.count < maximumEvents else { lock.unlock(); break }
      let changed = changedFields(from: lastTarget, to: target)
      lastTarget = target
      events.append(TraceEvent(sequence: events.count + 1, offsetMs: event.offsetMs, kind: event.kind, action: event.action, target: target, accessibilityDelta: changed.isEmpty ? nil : AccessibilityDelta(changed: changed, target: target)))
      lock.unlock()
    }
  }

  func write(events eventsURL: URL, session sessionURL: URL, endReason: String) throws {
    drain()
    lock.lock()
    let capturedEvents = events
    lock.unlock()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let contents = try capturedEvents.map { event in String(decoding: try encoder.encode(event), as: UTF8.self) }.joined(separator: "\n") + (capturedEvents.isEmpty ? "" : "\n")
    try contents.data(using: .utf8)!.write(to: eventsURL, options: .atomic)
    let session = Session(
      version: 2,
      platform: "macOS",
      durationMs: Int(Date().timeIntervalSince(started) * 1_000),
      endReason: endReason,
      eventCount: capturedEvents.count,
      privacy: "No typed text, key codes, clipboard content, cookies, passwords, window titles, screen video, screenshots, or raw coordinates were recorded. Control identifiers are one-way digests."
    )
    try encoder.encode(session).write(to: sessionURL, options: .atomic)
  }
}

private func callback(_ proxy: CGEventTapProxy, _ type: CGEventType, _ event: CGEvent, _ info: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    if let activeTap { CGEvent.tapEnable(tap: activeTap, enable: true) }
  } else if let info {
    Unmanaged<Recorder>.fromOpaque(info).takeUnretainedValue().enqueue(type, event)
  }
  return Unmanaged.passUnretained(event)
}

private func fail(_ message: String) -> Never {
  cleanupRuntimeState()
  FileHandle.standardError.write(Data("\(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 6, CommandLine.arguments[1] == "record" else {
  fail("usage: BilliardBuddyRecordReplayService record <events.jsonl> <session.json> <stop-file> <max-seconds>")
}

let eventsURL = URL(fileURLWithPath: CommandLine.arguments[2])
let sessionURL = URL(fileURLWithPath: CommandLine.arguments[3])
let stopURL = URL(fileURLWithPath: CommandLine.arguments[4])
runtimeRootURL = eventsURL.deletingLastPathComponent()
guard let maximum = TimeInterval(CommandLine.arguments[5]), maximum >= 30, maximum <= 1_800 else { fail("invalid recording duration") }
NSApplication.shared.setActivationPolicy(.accessory)
let confirmation = NSAlert()
confirmation.messageText = "开始录制此工作流？"
confirmation.informativeText = "BilliardBuddy 将在最多 \(Int(maximum)) 秒内记录操作顺序、应用/窗口/控件的脱敏语义身份和可访问性状态变化。不会记录输入文字、按键码、窗口标题、原始坐标、剪贴板、密码、Cookie、截图或视频。"
confirmation.addButton(withTitle: "开始录制")
confirmation.addButton(withTitle: "取消")
guard confirmation.runModal() == .alertFirstButtonReturn else { fail("BILLIARDBUDDY_RECORDING_USER_DENIED") }
guard AXIsProcessTrusted() else { fail("BILLIARDBUDDY_RECORDING_ACCESSIBILITY_REQUIRED") }

private let recorder = Recorder()
private let types: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel, .keyDown]
private let mask = types.reduce(CGEventMask(0)) { value, type in value | (CGEventMask(1) << CGEventMask(type.rawValue)) }
private let retained = Unmanaged.passRetained(recorder)
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: callback, userInfo: retained.toOpaque()) else {
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
  recorder.drain()
}
CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
activeTap = nil
retained.release()

do {
  try FileManager.default.createDirectory(at: eventsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
  try recorder.write(events: eventsURL, session: sessionURL, endReason: FileManager.default.fileExists(atPath: stopURL.path) ? "user_stopped" : "duration_expired")
  cleanupRuntimeState()
} catch {
  fail("BILLIARDBUDDY_RECORDING_WRITE_FAILED: \(error.localizedDescription)")
}
