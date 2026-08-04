import AppKit
import ApplicationServices
import CoreImage
import CoreMedia
import CoreGraphics
import CryptoKit
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
    let windows = visibleWindows(for: bundleId)
    guard windows.contains(where: { ($0["windowId"] as? UInt64) == UInt64(windowId) }) else {
        throw ServiceError.unavailable("The requested window is no longer visible for \(bundleId)")
    }
    if requireForeground {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId else {
            throw ServiceError.denied("\(bundleId) is not the foreground app. Activate it and observe the window again before acting.")
        }
        guard let frontWindowId = windows.first?["windowId"] as? UInt64,
              frontWindowId == UInt64(windowId)
        else {
            throw ServiceError.denied("The requested window is not the foreground window. Activate and observe it again before acting.")
        }
    }
}

private func requireForegroundWindowWithoutControlPolicy(bundleId: String, windowId: CGWindowID) throws {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId,
          let currentWindowId = visibleWindows(for: bundleId).first?["windowId"] as? UInt64,
          currentWindowId == UInt64(windowId)
    else {
        throw ServiceError.unavailable("The foreground window changed while capturing Appshot")
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

private func attributeBool(_ element: AXUIElement, _ attribute: CFString) -> Bool? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success,
          let number = raw as? NSNumber
    else { return nil }
    return number.boolValue
}

private func attributeNumber(_ element: AXUIElement, _ attribute: CFString) -> Int? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success,
          let number = raw as? NSNumber
    else { return nil }
    return number.intValue
}

private func attributeRect(_ element: AXUIElement) -> CGRect? {
    var positionRaw: CFTypeRef?
    var sizeRaw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRaw) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRaw) == .success,
          let positionRaw,
          let sizeRaw,
          CFGetTypeID(positionRaw) == AXValueGetTypeID(),
          CFGetTypeID(sizeRaw) == AXValueGetTypeID()
    else { return nil }
    let positionValue = unsafeBitCast(positionRaw, to: AXValue.self)
    let sizeValue = unsafeBitCast(sizeRaw, to: AXValue.self)
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position),
          AXValueGetValue(sizeValue, .cgSize, &size),
          position.x.isFinite, position.y.isFinite,
          size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0
    else { return nil }
    return CGRect(origin: position, size: size)
}

private func children(of element: AXUIElement) -> [AXUIElement] {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
          let values = raw as? [Any]
    else { return [] }
    return values.compactMap { value in
        guard CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
}

private func actionNames(of element: AXUIElement) -> [String] {
    var raw: CFArray?
    guard AXUIElementCopyActionNames(element, &raw) == .success,
          let values = raw as? [String]
    else { return [] }
    return values.sorted()
}

private func elementFingerprint(_ element: AXUIElement) -> String {
    let bounds = attributeRect(element).map {
        String(format: "%.3f,%.3f,%.3f,%.3f", locale: Locale(identifier: "en_US_POSIX"), $0.origin.x, $0.origin.y, $0.width, $0.height)
    } ?? ""
    let identity = [
        attributeString(element, kAXRoleAttribute as CFString) ?? "",
        attributeString(element, kAXSubroleAttribute as CFString) ?? "",
        attributeString(element, "AXIdentifier" as CFString) ?? "",
        attributeString(element, kAXTitleAttribute as CFString) ?? "",
        attributeString(element, kAXDescriptionAttribute as CFString) ?? "",
        String(attributeBool(element, kAXEnabledAttribute as CFString) ?? true),
        String(isSensitiveElement(element)),
        bounds,
        actionNames(of: element).joined(separator: ","),
    ].joined(separator: "\u{001f}")
    return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
}

private func isSecureTextField(_ element: AXUIElement) -> Bool {
    attributeString(element, kAXRoleAttribute as CFString) == "AXSecureTextField"
}

private func isSensitiveElement(_ element: AXUIElement) -> Bool {
    if isSecureTextField(element) { return true }
    let hints = [
        attributeString(element, kAXTitleAttribute as CFString) ?? "",
        attributeString(element, kAXDescriptionAttribute as CFString) ?? "",
        attributeString(element, "AXIdentifier" as CFString) ?? "",
    ].joined(separator: " ").lowercased()
    return ["password", "passcode", "verification", "one-time", "otp", "token", "secret", "credit card", "card number", "cvv", "security code"].contains { hints.contains($0) }
}

private func applicationElement(bundleId: String) throws -> AXUIElement {
    guard let application = runningApplication(bundleId: bundleId) else {
        throw ServiceError.unavailable("\(bundleId) is not running")
    }
    return AXUIElementCreateApplication(application.processIdentifier)
}

private func accessibilityWindowMatchesVisibleWindow(_ element: AXUIElement, bundleId: String, windowId: CGWindowID) -> Bool {
    guard let window = visibleWindow(bundleId: bundleId, windowId: windowId),
          let originX = window["x"] as? Double,
          let originY = window["y"] as? Double,
          let width = window["width"] as? Double,
          let height = window["height"] as? Double,
          width > 0,
          height > 0,
          let accessibilityBounds = attributeRect(element),
          accessibilityBounds.width > 0,
          accessibilityBounds.height > 0
    else { return false }
    let visibleBounds = CGRect(x: CGFloat(originX), y: CGFloat(originY), width: CGFloat(width), height: CGFloat(height))
    // AXWindowNumber is unavailable for some apps. In that narrow fallback,
    // geometry must still establish that the AX root is the observed CG window
    // rather than a focused sheet, panel, or another window in the same app.
    let tolerance = max(CGFloat(8), max(visibleBounds.width, visibleBounds.height) * 0.02)
    return abs(accessibilityBounds.origin.x - visibleBounds.origin.x) <= tolerance
        && abs(accessibilityBounds.origin.y - visibleBounds.origin.y) <= tolerance
        && abs(accessibilityBounds.width - visibleBounds.width) <= tolerance
        && abs(accessibilityBounds.height - visibleBounds.height) <= tolerance
}

private func accessibilityWindow(bundleId: String, windowId: CGWindowID) throws -> AXUIElement {
    let appElement = try applicationElement(bundleId: bundleId)
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &raw) == .success,
          let values = raw as? [Any]
    else {
        throw ServiceError.unavailable("No accessibility windows are available in \(bundleId)")
    }
    for value in values {
        guard CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else { continue }
        let candidate = unsafeBitCast(value, to: AXUIElement.self)
        if let number = attributeNumber(candidate, "AXWindowNumber" as CFString), number == Int(windowId) {
            return candidate
        }
    }
    // Some older or cross-process apps omit AXWindowNumber. Do not accept an
    // arbitrary focused AX window: it must still prove it matches the observed
    // target window before its tree can be read or acted on.
    var focusedRaw: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success,
       let focusedRaw,
       CFGetTypeID(focusedRaw) == AXUIElementGetTypeID() {
        let focused = unsafeBitCast(focusedRaw, to: AXUIElement.self)
        guard accessibilityWindowMatchesVisibleWindow(focused, bundleId: bundleId, windowId: windowId) else {
            throw ServiceError.unavailable("The focused accessibility window cannot be verified as the requested visible window")
        }
        return focused
    }
    throw ServiceError.unavailable("The requested window has no accessible tree")
}

private func currentAccessibilityElements(bundleId: String, windowId: CGWindowID, maxNodes: Int) throws -> [AXUIElement] {
    let root = try accessibilityWindow(bundleId: bundleId, windowId: windowId)
    var result: [AXUIElement] = []
    var pending: [AXUIElement] = [root]
    while let next = pending.popLast(), result.count < maxNodes {
        result.append(next)
        // Reverse keeps the exposed index order stable left-to-right for a
        // given fresh snapshot without retaining any element across requests.
        pending.append(contentsOf: children(of: next).reversed())
    }
    return result
}

private func accessibilityElements(bundleId: String, windowId: CGWindowID, maxNodes: Int) throws -> [AXUIElement] {
    try requireControlPermissions()
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    return try currentAccessibilityElements(bundleId: bundleId, windowId: windowId, maxNodes: maxNodes)
}

private func accessibilityTreePayload(bundleId: String, windowId: CGWindowID, elements: [AXUIElement], maxNodes: Int) -> [String: Any] {
    let nodes: [[String: Any]] = elements.enumerated().map { index, element in
        let secure = isSecureTextField(element)
        let sensitive = isSensitiveElement(element)
        var node: [String: Any] = [
            "elementIndex": index,
            "elementFingerprint": elementFingerprint(element),
            "role": attributeString(element, kAXRoleAttribute as CFString) ?? "",
            "subrole": attributeString(element, kAXSubroleAttribute as CFString) ?? "",
            "title": attributeString(element, kAXTitleAttribute as CFString) ?? "",
            "description": attributeString(element, kAXDescriptionAttribute as CFString) ?? "",
            "enabled": attributeBool(element, kAXEnabledAttribute as CFString) ?? true,
            "focused": attributeBool(element, kAXFocusedAttribute as CFString) ?? false,
            "secure": secure,
            "sensitive": sensitive,
            "actions": actionNames(of: element),
        ]
        if let bounds = attributeRect(element) {
            node["bounds"] = ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height]
        }
        if !sensitive, let value = attributeString(element, kAXValueAttribute as CFString) {
            node["value"] = String(value.prefix(4096))
        }
        return node
    }
    return [
        "appId": bundleId,
        "windowId": UInt64(windowId),
        "fresh": true,
        "truncated": elements.count >= maxNodes,
        "nodes": nodes,
    ]
}

private func describeAccessibilityTree(bundleId: String, windowId: CGWindowID, maxNodes: Int) throws -> [String: Any] {
    let elements = try accessibilityElements(bundleId: bundleId, windowId: windowId, maxNodes: maxNodes)
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    return accessibilityTreePayload(bundleId: bundleId, windowId: windowId, elements: elements, maxNodes: maxNodes)
}

private func accessibilityElement(bundleId: String, windowId: CGWindowID, index: Int, requestedFingerprint: String) throws -> AXUIElement {
    guard index >= 0, index < 500 else {
        throw ServiceError.invalidArguments("elementIndex must refer to a fresh accessibility snapshot")
    }
    guard requestedFingerprint.count == 64,
          requestedFingerprint.unicodeScalars.allSatisfy({ (48...57).contains($0.value) || (97...102).contains($0.value) })
    else { throw ServiceError.invalidArguments("elementFingerprint must come from a fresh accessibility snapshot") }
    let elements = try accessibilityElements(bundleId: bundleId, windowId: windowId, maxNodes: 500)
    guard elements.indices.contains(index) else {
        throw ServiceError.unavailable("The requested element is no longer in the current accessibility snapshot. Inspect the window again.")
    }
    let element = elements[index]
    guard elementFingerprint(element) == requestedFingerprint else {
        throw ServiceError.unavailable("The requested accessibility element changed after inspection. Inspect the window again.")
    }
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    return element
}

private func requireEditableNonSecure(_ element: AXUIElement) throws {
    guard !isSensitiveElement(element) else {
        throw ServiceError.denied("Computer Use will not read or change a password, credential, or payment field")
    }
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
          settable.boolValue
    else {
        throw ServiceError.unavailable("The selected accessibility element does not accept a text value")
    }
}

private func clickAccessibilityElement(bundleId: String, windowId: CGWindowID, index: Int, fingerprint: String) throws -> [String: Any] {
    let element = try accessibilityElement(bundleId: bundleId, windowId: windowId, index: index, requestedFingerprint: fingerprint)
    let actions = actionNames(of: element)
    if actions.contains(kAXPressAction as String) {
        try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
        if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
            return ["clicked": true, "elementIndex": index, "mode": "accessibility"]
        }
    }
    guard let bounds = attributeRect(element) else {
        throw ServiceError.unavailable("The selected element has no press action or usable bounds")
    }
    let point = CGPoint(x: bounds.midX, y: bounds.midY)
    try requirePointInsideWindow(bundleId: bundleId, windowId: windowId, x: point.x, y: point.y)
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    try postMouseClick(x: point.x, y: point.y)
    return ["clicked": true, "elementIndex": index, "mode": "coordinateFallback"]
}

private func setAccessibilityValue(bundleId: String, windowId: CGWindowID, index: Int, fingerprint: String, value: String) throws -> [String: Any] {
    let element = try accessibilityElement(bundleId: bundleId, windowId: windowId, index: index, requestedFingerprint: fingerprint)
    try requireEditableNonSecure(element)
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success else {
        throw ServiceError.operation("The selected element rejected the requested value")
    }
    return ["valueSet": true, "elementIndex": index, "characterCount": value.count]
}

private func selectAccessibilityText(bundleId: String, windowId: CGWindowID, index: Int, fingerprint: String, text: String, prefix: String, suffix: String, selectionType: String) throws -> [String: Any] {
    let element = try accessibilityElement(bundleId: bundleId, windowId: windowId, index: index, requestedFingerprint: fingerprint)
    try requireEditableNonSecure(element)
    guard let value = attributeString(element, kAXValueAttribute as CFString) else {
        throw ServiceError.unavailable("The selected element has no readable text value")
    }
    let searchStart: String.Index
    if prefix.isEmpty { searchStart = value.startIndex }
    else if let prefixRange = value.range(of: prefix) { searchStart = prefixRange.upperBound }
    else { throw ServiceError.unavailable("The requested text prefix is not present in the current element") }
    guard let range = value.range(of: text, range: searchStart..<value.endIndex) else {
        throw ServiceError.unavailable("The requested text is not present in the current element")
    }
    if !suffix.isEmpty, value[range.upperBound...].range(of: suffix) == nil {
        throw ServiceError.unavailable("The requested text suffix is not present after the selected text")
    }
    // AXSelectedTextRange uses UTF-16 code-unit offsets, not Swift grapheme
    // cluster counts. This keeps emoji and composed characters aligned with AX.
    let start = value[..<range.lowerBound].utf16.count
    let length = value[range].utf16.count
    let selectedRange: CFRange
    switch selectionType {
    case "text": selectedRange = CFRange(location: start, length: length)
    case "cursor_before": selectedRange = CFRange(location: start, length: 0)
    case "cursor_after": selectedRange = CFRange(location: start + length, length: 0)
    default: throw ServiceError.invalidArguments("selectionType must be text, cursor_before, or cursor_after")
    }
    var selected = selectedRange
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    guard let rangeValue = AXValueCreate(.cfRange, &selected),
          AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue) == .success
    else { throw ServiceError.unavailable("The selected element does not support text selection") }
    return ["selected": true, "elementIndex": index, "selectionType": selectionType]
}

private func performSecondaryAccessibilityAction(bundleId: String, windowId: CGWindowID, index: Int, fingerprint: String, action: String) throws -> [String: Any] {
    let element = try accessibilityElement(bundleId: bundleId, windowId: windowId, index: index, requestedFingerprint: fingerprint)
    guard action.count <= 256, !action.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }),
          actionNames(of: element).contains(action)
    else { throw ServiceError.denied("The requested action is not exposed by the current accessibility element") }
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    guard AXUIElementPerformAction(element, action as CFString) == .success else {
        throw ServiceError.operation("The selected accessibility action failed")
    }
    return ["performed": true, "elementIndex": index, "action": action]
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
    return [
        "role": role,
        "title": attributeString(focused, kAXTitleAttribute as CFString) ?? "",
        "description": attributeString(focused, kAXDescriptionAttribute as CFString) ?? "",
        "sensitive": isSensitiveElement(focused),
    ]
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

private func postMouseDrag(from: CGPoint, to: CGPoint) throws {
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left),
          let dragged = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: to, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)
    else { throw ServiceError.operation("Could not create mouse drag events") }
    down.post(tap: .cghidEventTap)
    dragged.post(tap: .cghidEventTap)
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

private func visibleWindowCenter(bundleId: String, windowId: CGWindowID) throws -> CGPoint {
    guard let window = visibleWindow(bundleId: bundleId, windowId: windowId),
          let originX = window["x"] as? Double,
          let originY = window["y"] as? Double,
          let width = window["width"] as? Double,
          let height = window["height"] as? Double,
          width > 0,
          height > 0
    else {
        throw ServiceError.unavailable("The requested window has no usable bounds")
    }
    return CGPoint(x: originX + width / 2, y: originY + height / 2)
}

private func scrollAtPoint(bundleId: String, windowId: CGWindowID, point: CGPoint, deltaX: Double, deltaY: Double) throws {
    try requirePointInsideWindow(bundleId: bundleId, windowId: windowId, x: point.x, y: point.y)
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    guard CGWarpMouseCursorPosition(point) == .success else {
        throw ServiceError.operation("Could not move the pointer to the target window")
    }
    // A scroll wheel event is global. Revalidate after moving the pointer so a
    // foreground switch cannot redirect it into another application.
    try requirePointInsideWindow(bundleId: bundleId, windowId: windowId, x: point.x, y: point.y)
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    try scroll(deltaX: deltaX, deltaY: deltaY)
}

private func scrollAccessibilityElement(bundleId: String, windowId: CGWindowID, index: Int, fingerprint: String, direction: String, pages: Int) throws -> [String: Any] {
    let element = try accessibilityElement(bundleId: bundleId, windowId: windowId, index: index, requestedFingerprint: fingerprint)
    let actions = actionNames(of: element)
    let increment = direction == "up" || direction == "left"
    let semanticAction = increment ? kAXIncrementAction as String : kAXDecrementAction as String
    if actions.contains(semanticAction) {
        for _ in 0..<pages {
            try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
            guard AXUIElementPerformAction(element, semanticAction as CFString) == .success else {
                throw ServiceError.operation("The selected accessibility scroll action failed")
            }
        }
        return ["scrolled": true, "elementIndex": index, "mode": "accessibility"]
    }
    guard let bounds = attributeRect(element) else {
        throw ServiceError.unavailable("The selected element has no scroll action or usable bounds")
    }
    let point = CGPoint(x: bounds.midX, y: bounds.midY)
    let distance = Double(pages * 600)
    let delta: (x: Double, y: Double)
    switch direction {
    case "up": delta = (x: 0, y: distance)
    case "down": delta = (x: 0, y: -distance)
    case "left": delta = (x: distance, y: 0)
    case "right": delta = (x: -distance, y: 0)
    default: throw ServiceError.invalidArguments("direction must be up, down, left, or right")
    }
    try scrollAtPoint(bundleId: bundleId, windowId: windowId, point: point, deltaX: delta.x, deltaY: delta.y)
    return ["scrolled": true, "elementIndex": index, "mode": "coordinateFallback"]
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

private func captureWindowImage(bundleId: String, windowId: CGWindowID) async throws -> String {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: {
        $0.windowID == windowId && $0.owningApplication?.bundleIdentifier == bundleId
    }) else {
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

private func captureWindow(bundleId: String, windowId: CGWindowID) async throws -> String {
    try requireObservationPermissions()
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    let image = try await captureWindowImage(bundleId: bundleId, windowId: windowId)
    try requireWindow(bundleId: bundleId, windowId: windowId, requireForeground: true)
    return image
}

// This is intentionally not a Computer Use MCP tool. Electron Main invokes it
// only after an explicit user shortcut, with a per-call capability delivered
// out-of-band through the child process environment. It permits observing the
// current foreground app once; it never grants that app ongoing MCP control.
private func captureAppshot() async throws -> [String: Any] {
    let capability = ProcessInfo.processInfo.environment["BILLIARDBUDDY_APPSHOT_CAPABILITY"] ?? ""
    guard capability.count == 43,
          capability.unicodeScalars.allSatisfy({
              CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-"
          })
    else {
        throw ServiceError.denied("This Appshot request was not authorized by BilliardBuddy")
    }
    let parentPid = getppid()
    guard parentPid > 1,
          NSRunningApplication(processIdentifier: parentPid)?.bundleIdentifier == "com.billiardbuddy.desktop"
    else {
        throw ServiceError.denied("Appshot can only be started by BilliardBuddy")
    }
    guard let app = NSWorkspace.shared.frontmostApplication,
          let bundleId = app.bundleIdentifier,
          let rawWindowId = visibleWindows(for: bundleId).first?["windowId"] as? UInt64
    else { throw ServiceError.unavailable("No foreground app window is available for Appshot") }
    let windowId = CGWindowID(rawWindowId)
    try requireObservationPermissions()
    guard accessibilityReady() else {
        throw ServiceError.permission("Accessibility permission is required to include Appshot accessibility text")
    }
    let image = try await captureWindowImage(bundleId: bundleId, windowId: windowId)
    try requireForegroundWindowWithoutControlPolicy(bundleId: bundleId, windowId: windowId)
    let elements = try currentAccessibilityElements(bundleId: bundleId, windowId: windowId, maxNodes: 250)
    try requireForegroundWindowWithoutControlPolicy(bundleId: bundleId, windowId: windowId)
    let tree = accessibilityTreePayload(bundleId: bundleId, windowId: windowId, elements: elements, maxNodes: 250)
    return ["appId": bundleId, "windowId": rawWindowId, "image": image, "accessibility": tree]
}

private func argument(_ arguments: [String], _ index: Int, _ name: String) throws -> String {
    guard arguments.count > index, !arguments[index].isEmpty else {
        throw ServiceError.invalidArguments("Missing \(name)")
    }
    return arguments[index]
}

private func optionalArgument(_ arguments: [String], _ index: Int) -> String {
    arguments.indices.contains(index) ? arguments[index] : ""
}

private func elementIndex(_ arguments: [String], _ index: Int) throws -> Int {
    guard let value = Int(try argument(arguments, index, "elementIndex")), value >= 0, value < 500 else {
        throw ServiceError.invalidArguments("elementIndex must be a fresh accessibility snapshot index")
    }
    return value
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
    case "appshot":
        guard arguments.count == 1 else {
            throw ServiceError.invalidArguments("Appshot does not accept command-line data")
        }
        try emitJson(try await captureAppshot())
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
    case "accessibility-tree":
        let bundleId = try argument(arguments, 1, "bundleId")
        let maxNodes = min(max(Int(try argument(arguments, 3, "maxNodes")) ?? 250, 1), 500)
        try emitJson(try describeAccessibilityTree(bundleId: bundleId, windowId: try windowId(arguments, 2), maxNodes: maxNodes))
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
        try requireWindow(bundleId: bundleId, windowId: window, requireForeground: true)
        try postMouseClick(x: x, y: y)
        try emitJson(["clicked": true])
    case "click-element":
        let bundleId = try argument(arguments, 1, "bundleId")
        let targetWindow = try windowId(arguments, 2)
        try emitJson(try clickAccessibilityElement(bundleId: bundleId, windowId: targetWindow, index: try elementIndex(arguments, 3), fingerprint: try argument(arguments, 4, "elementFingerprint")))
    case "drag":
        let bundleId = try argument(arguments, 1, "bundleId")
        let targetWindow = try windowId(arguments, 2)
        let from = CGPoint(x: try finiteNumber(arguments, 3, "fromX"), y: try finiteNumber(arguments, 4, "fromY"))
        let to = CGPoint(x: try finiteNumber(arguments, 5, "toX"), y: try finiteNumber(arguments, 6, "toY"))
        try requireControlPermissions()
        try requireWindow(bundleId: bundleId, windowId: targetWindow, requireForeground: true)
        try requirePointInsideWindow(bundleId: bundleId, windowId: targetWindow, x: from.x, y: from.y)
        try requirePointInsideWindow(bundleId: bundleId, windowId: targetWindow, x: to.x, y: to.y)
        try requireWindow(bundleId: bundleId, windowId: targetWindow, requireForeground: true)
        try postMouseDrag(from: from, to: to)
        try emitJson(["dragged": true])
    case "set-value":
        let bundleId = try argument(arguments, 1, "bundleId")
        let value = try argument(arguments, 5, "value")
        guard value.count <= 4096 else { throw ServiceError.invalidArguments("value is limited to 4096 characters") }
        try emitJson(try setAccessibilityValue(bundleId: bundleId, windowId: try windowId(arguments, 2), index: try elementIndex(arguments, 3), fingerprint: try argument(arguments, 4, "elementFingerprint"), value: value))
    case "select-text":
        let bundleId = try argument(arguments, 1, "bundleId")
        let text = try argument(arguments, 5, "text")
        guard text.count <= 4096 else { throw ServiceError.invalidArguments("text is limited to 4096 characters") }
        let prefix = optionalArgument(arguments, 6)
        let suffix = optionalArgument(arguments, 7)
        let selectionType = optionalArgument(arguments, 8).isEmpty ? "text" : optionalArgument(arguments, 8)
        try emitJson(try selectAccessibilityText(bundleId: bundleId, windowId: try windowId(arguments, 2), index: try elementIndex(arguments, 3), fingerprint: try argument(arguments, 4, "elementFingerprint"), text: text, prefix: prefix, suffix: suffix, selectionType: selectionType))
    case "secondary-action":
        let bundleId = try argument(arguments, 1, "bundleId")
        try emitJson(try performSecondaryAccessibilityAction(bundleId: bundleId, windowId: try windowId(arguments, 2), index: try elementIndex(arguments, 3), fingerprint: try argument(arguments, 4, "elementFingerprint"), action: try argument(arguments, 5, "action")))
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
        guard focused["sensitive"] as? Bool != true else {
            throw ServiceError.denied("Computer Use will not type into a password, credential, or payment field")
        }
        try requireWindow(bundleId: bundleId, windowId: targetWindow, requireForeground: true)
        try typeText(text)
        try emitJson([String: Any](dictionaryLiteral: ("typed", true), ("characterCount", text.count)))
    case "press-key":
        let bundleId = try argument(arguments, 1, "bundleId")
        let targetWindow = try windowId(arguments, 2)
        try requireControlPermissions()
        try requireWindow(bundleId: bundleId, windowId: targetWindow, requireForeground: true)
        try pressKey(try argument(arguments, 3, "key"))
        try emitJson(["pressed": true])
    case "scroll":
        let bundleId = try argument(arguments, 1, "bundleId")
        let targetWindow = try windowId(arguments, 2)
        try requireControlPermissions()
        try requireWindow(bundleId: bundleId, windowId: targetWindow, requireForeground: true)
        let point = try visibleWindowCenter(bundleId: bundleId, windowId: targetWindow)
        try scrollAtPoint(bundleId: bundleId, windowId: targetWindow, point: point, deltaX: try finiteNumber(arguments, 3, "deltaX"), deltaY: try finiteNumber(arguments, 4, "deltaY"))
        try emitJson(["scrolled": true])
    case "scroll-element":
        let bundleId = try argument(arguments, 1, "bundleId")
        let pages = min(max(Int(try argument(arguments, 6, "pages")) ?? 1, 1), 10)
        try emitJson(try scrollAccessibilityElement(bundleId: bundleId, windowId: try windowId(arguments, 2), index: try elementIndex(arguments, 3), fingerprint: try argument(arguments, 4, "elementFingerprint"), direction: try argument(arguments, 5, "direction"), pages: pages))
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
