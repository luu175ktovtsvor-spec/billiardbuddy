import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import CoreGraphics
import Foundation
import ScreenCaptureKit

private struct AccessConfiguration: Decodable {
    let allowedBundleIds: [String]?
}

private enum ServiceError: LocalizedError {
    case invalidArguments(String)
    case permission(String)
    case denied(String)
    case unavailable(String)
    case operation(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let message), .permission(let message), .denied(let message), .unavailable(let message), .operation(let message):
            return message
        }
    }
}

private func emitJson(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let string = String(data: data, encoding: .utf8) else {
        throw ServiceError.operation("Could not encode the Computer Use result")
    }
    print(string)
}

private func configurationURL() throws -> URL {
    guard let privateHome = ProcessInfo.processInfo.environment["CODEX_HOME"], !privateHome.isEmpty else {
        throw ServiceError.denied("Computer Use is not configured. Enable it in BilliardBuddy before accessing an app.")
    }
    return URL(fileURLWithPath: privateHome, isDirectory: true)
        .appendingPathComponent("computer-use", isDirectory: true)
        .appendingPathComponent("config.json", isDirectory: false)
}

private func allowedBundleIds() throws -> Set<String> {
    let location = try configurationURL()
    guard FileManager.default.fileExists(atPath: location.path) else {
        throw ServiceError.denied("Computer Use has no allowed apps. Choose an app in BilliardBuddy settings before continuing.")
    }
    let data = try Data(contentsOf: location)
    let configuration = try JSONDecoder().decode(AccessConfiguration.self, from: data)
    return Set(configuration.allowedBundleIds ?? [])
}

private func requireAllowed(_ bundleId: String) throws {
    guard try allowedBundleIds().contains(bundleId) else {
        throw ServiceError.denied("\(bundleId) is not allowed for Computer Use")
    }
}

private func runningApplication(bundleId: String) -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
}

private func screenRecordingReady() -> Bool {
    CGPreflightScreenCaptureAccess()
}

private func accessibilityReady() -> Bool {
    AXIsProcessTrusted()
}

private func requireObservationPermissions() throws {
    guard screenRecordingReady() else {
        throw ServiceError.permission("Screen Recording permission is required. Grant it to BilliardBuddy Computer Use in macOS Privacy & Security.")
    }
}

private func requireControlPermissions() throws {
    try requireObservationPermissions()
    guard accessibilityReady() else {
        throw ServiceError.permission("Accessibility permission is required. Grant it to BilliardBuddy Computer Use in macOS Privacy & Security.")
    }
}

private func visibleWindows(for bundleId: String) -> [[String: Any]] {
    let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return raw.compactMap { entry in
        guard let pid = entry[kCGWindowOwnerPID as String] as? NSNumber,
              let application = NSRunningApplication(processIdentifier: pid_t(pid.intValue)),
              application.bundleIdentifier == bundleId,
              let windowId = entry[kCGWindowNumber as String] as? NSNumber,
              let bounds = entry[kCGWindowBounds as String] as? [String: Any]
        else {
            return nil
        }
        let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        guard layer == 0 else { return nil }
        return [
            "windowId": windowId.uint64Value,
            "title": (entry[kCGWindowName as String] as? String) ?? "",
            "x": (bounds["X"] as? NSNumber)?.doubleValue ?? 0,
            "y": (bounds["Y"] as? NSNumber)?.doubleValue ?? 0,
            "width": (bounds["Width"] as? NSNumber)?.doubleValue ?? 0,
            "height": (bounds["Height"] as? NSNumber)?.doubleValue ?? 0,
        ]
    }
}

private func visibleWindow(bundleId: String, windowId: CGWindowID) -> [String: Any]? {
    visibleWindows(for: bundleId).first { ($0["windowId"] as? UInt64) == UInt64(windowId) }
}

private func requireWindow(bundleId: String, windowId: CGWindowID, requireForeground: Bool) throws {
    try requireAllowed(bundleId)
    guard visibleWindow(bundleId: bundleId, windowId: windowId) != nil else {
        throw ServiceError.unavailable("The requested window is no longer visible for \(bundleId)")
    }
    if requireForeground {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId else {
            throw ServiceError.denied("\(bundleId) is not the foreground app. Activate it and observe the window again before acting.")
        }
    }
}

private func requirePointInsideWindow(bundleId: String, windowId: CGWindowID, x: CGFloat, y: CGFloat) throws {
    guard let window = visibleWindow(bundleId: bundleId, windowId: windowId),
          let originX = window["x"] as? Double,
          let originY = window["y"] as? Double,
          let width = window["width"] as? Double,
          let height = window["height"] as? Double,
          x >= CGFloat(originX), y >= CGFloat(originY),
          x < CGFloat(originX + width), y < CGFloat(originY + height)
    else {
        throw ServiceError.denied("The requested click is outside the current target window")
    }
}

private func attributeString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else { return nil }
    return raw as? String
}

private func inspectFocusedElement(bundleId: String, windowId: CGWindowID) throws -> [String: Any] {
    try requireControlPermissions()
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    guard let application = runningApplication(bundleId: bundleId) else {
        throw ServiceError.unavailable("\(bundleId) is not running")
    }
    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    var rawFocused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElement, kAXFocusedUIElementAttribute as CFString, &rawFocused) == .success,
          let rawFocused
    else {
        throw ServiceError.unavailable("No focused accessibility element is available in \(bundleId)")
    }
    let focused = unsafeBitCast(rawFocused, to: AXUIElement.self)
    let role = attributeString(focused, kAXRoleAttribute as CFString) ?? ""
    var result: [String: Any] = [
        "role": role,
        "title": attributeString(focused, kAXTitleAttribute as CFString) ?? "",
        "description": attributeString(focused, kAXDescriptionAttribute as CFString) ?? "",
    ]
    if role != "AXSecureTextField", let value = attributeString(focused, kAXValueAttribute as CFString) {
        result["value"] = value
    }
    return result
}

private func activate(bundleId: String) throws -> [String: Any] {
    try requireControlPermissions()
    try requireAllowed(bundleId)
    if let application = runningApplication(bundleId: bundleId) {
        guard application.activate(options: [.activateAllWindows]) else {
            throw ServiceError.operation("Could not activate \(bundleId)")
        }
    } else {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            throw ServiceError.unavailable("Could not find \(bundleId). Ensure it is installed and allowed.")
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        let finished = DispatchSemaphore(value: 0)
        var launchError: Error?
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
            launchError = error
            finished.signal()
        }
        guard finished.wait(timeout: .now() + 5) == .success else {
            throw ServiceError.operation("Timed out while launching \(bundleId)")
        }
        if let launchError {
            throw ServiceError.operation("Could not launch \(bundleId): \(launchError.localizedDescription)")
        }
    }
    return ["appId": bundleId, "activated": true]
}

private func postMouseClick(x: CGFloat, y: CGFloat) throws {
    let point = CGPoint(x: x, y: y)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else {
        throw ServiceError.operation("Could not create mouse events")
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

private func typeText(_ text: String) throws {
    let utf16 = Array(text.utf16)
    guard !utf16.isEmpty else { return }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    else {
        throw ServiceError.operation("Could not create keyboard events")
    }
    utf16.withUnsafeBufferPointer { buffer in
        guard let pointer = buffer.baseAddress else { return }
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: pointer)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: pointer)
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

private func keyCode(for key: String) -> CGKeyCode? {
    [
        "enter": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ][key.lowercased()].map(CGKeyCode.init)
}

private func pressKey(_ key: String) throws {
    guard let keyCode = keyCode(for: key) else {
        throw ServiceError.invalidArguments("Unsupported key. Use enter, tab, space, delete, escape, left, right, up, or down.")
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    else {
        throw ServiceError.operation("Could not create keyboard events")
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

private func scroll(deltaX: Double, deltaY: Double) throws {
    guard let event = CGEvent(
        scrollWheelEvent2Source: nil,
        units: .pixel,
        wheelCount: 2,
        wheel1: Int32(deltaY.rounded()),
        wheel2: Int32(deltaX.rounded()),
        wheel3: 0
    ) else {
        throw ServiceError.operation("Could not create scroll event")
    }
    event.post(tap: .cghidEventTap)
}

private final class FrameCollector: NSObject, SCStreamOutput {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var frame: CGImage?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              CMSampleBufferIsValid(sampleBuffer),
              let pixelBuffer = sampleBuffer.imageBuffer
        else {
            return
        }
        let image = CIContext().createCGImage(CIImage(cvPixelBuffer: pixelBuffer), from: CIImage(cvPixelBuffer: pixelBuffer).extent)
        guard let image else { return }
        lock.lock()
        defer { lock.unlock() }
        guard frame == nil else { return }
        frame = image
        semaphore.signal()
    }

    func waitForFrame() -> CGImage? {
        guard semaphore.wait(timeout: .now() + 3) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return frame
    }
}

private func captureWindow(bundleId: String, windowId: CGWindowID) async throws -> String {
    try requireObservationPermissions()
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: false)
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
        throw ServiceError.unavailable("Could not capture the requested window")
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int(window.frame.width.rounded()))
    configuration.height = max(1, Int(window.frame.height.rounded()))
    configuration.queueDepth = 1
    configuration.showsCursor = false
    let collector = FrameCollector()
    let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
    try stream.addStreamOutput(collector, type: .screen, sampleHandlerQueue: DispatchQueue.global(qos: .userInitiated))
    try await stream.startCapture()
    defer { stream.stopCapture { _ in } }
    guard let image = collector.waitForFrame() else {
        throw ServiceError.unavailable("Timed out while capturing the requested window")
    }
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let png = bitmap.representation(using: .png, properties: [:]) else {
        throw ServiceError.operation("Could not encode the requested window image")
    }
    return png.base64EncodedString()
}

private func argument(_ arguments: [String], _ index: Int, _ name: String) throws -> String {
    guard arguments.count > index, !arguments[index].isEmpty else {
        throw ServiceError.invalidArguments("Missing \(name)")
    }
    return arguments[index]
}

private func windowId(_ arguments: [String], _ index: Int) throws -> CGWindowID {
    guard let value = UInt32(try argument(arguments, index, "windowId")), value > 0 else {
        throw ServiceError.invalidArguments("windowId must be a positive integer")
    }
    return CGWindowID(value)
}

private func finiteNumber(_ arguments: [String], _ index: Int, _ name: String) throws -> Double {
    guard let value = Double(try argument(arguments, index, name)), value.isFinite, abs(value) <= 100_000 else {
        throw ServiceError.invalidArguments("\(name) must be a safe finite number")
    }
    return value
}

private func run(_ arguments: [String]) async throws {
    let command = try argument(arguments, 0, "command")
    switch command {
    case "status":
        let configurationExists = (try? configurationURL()).map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        let count = (try? allowedBundleIds().count) ?? 0
        try emitJson([String: Any](dictionaryLiteral:
            ("platform", "macOS"),
            ("screenRecording", screenRecordingReady()),
            ("accessibility", accessibilityReady()),
            ("configurationPresent", configurationExists),
            ("allowedAppCount", count)
        ))
    case "list-allowed-apps":
        let entries: [[String: Any]] = try allowedBundleIds().sorted().map { bundleId in
            ["appId": bundleId, "running": runningApplication(bundleId: bundleId) != nil]
        }
        try emitJson(entries)
    case "list-windows":
        try requireObservationPermissions()
        let bundleId = try argument(arguments, 1, "bundleId")
        try requireAllowed(bundleId)
        try emitJson(visibleWindows(for: bundleId))
    case "capture-window":
        let bundleId = try argument(arguments, 1, "bundleId")
        print(try await captureWindow(bundleId: bundleId, windowId: try windowId(arguments, 2)))
    case "inspect-focused-element":
        let bundleId = try argument(arguments, 1, "bundleId")
        try emitJson(try inspectFocusedElement(bundleId: bundleId, windowId: try windowId(arguments, 2)))
    case "activate-app":
        try emitJson(try activate(bundleId: try argument(arguments, 1, "bundleId")))
    case "click":
        let bundleId = try argument(arguments, 1, "bundleId")
        let window = try windowId(arguments, 2)
        let x = CGFloat(try finiteNumber(arguments, 3, "x"))
        let y = CGFloat(try finiteNumber(arguments, 4, "y"))
        try requireControlPermissions()
        try requireWindow(bundleId: bundleId, windowId: window, requireForeground: true)
        try requirePointInsideWindow(bundleId: bundleId, windowId: window, x: x, y: y)
        try postMouseClick(x: x, y: y)
        try emitJson(["clicked": true])
    case "type-text":
        let bundleId = try argument(arguments, 1, "bundleId")
        let text = try argument(arguments, 3, "text")
        guard text.count <= 4096 else { throw ServiceError.invalidArguments("text is limited to 4096 characters") }
        try requireControlPermissions()
        let targetWindow = try windowId(arguments, 2)
        try requireWindow(bundleId: bundleId, windowId: targetWindow, requireForeground: true)
        // Do not rely only on the model-facing Skill for this boundary. A
        // password field must never receive text through injected input.
        let focused = try inspectFocusedElement(bundleId: bundleId, windowId: targetWindow)
        guard focused["role"] as? String != "AXSecureTextField" else {
            throw ServiceError.denied("Computer Use will not type into a secure password field")
        }
        try typeText(text)
        try emitJson([String: Any](dictionaryLiteral: ("typed", true), ("characterCount", text.count)))
    case "press-key":
        let bundleId = try argument(arguments, 1, "bundleId")
        try requireControlPermissions()
        try requireWindow(bundleId: bundleId, windowId: try windowId(arguments, 2), requireForeground: true)
        try pressKey(try argument(arguments, 3, "key"))
        try emitJson(["pressed": true])
    case "scroll":
        let bundleId = try argument(arguments, 1, "bundleId")
        try requireControlPermissions()
        try requireWindow(bundleId: bundleId, windowId: try windowId(arguments, 2), requireForeground: true)
        try scroll(deltaX: try finiteNumber(arguments, 3, "deltaX"), deltaY: try finiteNumber(arguments, 4, "deltaY"))
        try emitJson(["scrolled": true])
    case "wait-for-window":
        try requireObservationPermissions()
        let bundleId = try argument(arguments, 1, "bundleId")
        try requireAllowed(bundleId)
        let timeout = min(max(Double(try argument(arguments, 2, "timeoutMs")) ?? 3_000, 100), 10_000) / 1_000
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let windows = visibleWindows(for: bundleId)
            if !windows.isEmpty {
                try emitJson([String: Any](dictionaryLiteral: ("found", true), ("windows", windows)))
                return
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try emitJson(["found": false])
    default:
        throw ServiceError.invalidArguments("Unknown Computer Use command")
    }
}

Task {
    do {
        try await run(Array(CommandLine.arguments.dropFirst()))
        exit(0)
    } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(64)
    }
}
dispatchMain()
