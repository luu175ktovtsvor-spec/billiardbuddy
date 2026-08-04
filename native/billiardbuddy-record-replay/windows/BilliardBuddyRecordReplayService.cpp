#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincrypt.h>
#include <uiautomation.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

constexpr size_t kMaximumEvents = 2'000;

struct SemanticTarget {
  std::string appId;
  std::string windowId;
  int controlType = 0;
  std::string automationIdDigest;
  bool hasEnabled = false;
  bool enabled = false;
  bool hasFocused = false;
  bool focused = false;
  bool hasPassword = false;
  bool password = false;
  bool hasActionable = false;
  bool actionable = false;

  bool operator==(const SemanticTarget& other) const {
    return appId == other.appId && windowId == other.windowId && controlType == other.controlType &&
      automationIdDigest == other.automationIdDigest && hasEnabled == other.hasEnabled && enabled == other.enabled &&
      hasFocused == other.hasFocused && focused == other.focused && hasPassword == other.hasPassword && password == other.password &&
      hasActionable == other.hasActionable && actionable == other.actionable;
  }
};

struct Event {
  ULONGLONG offsetMs;
  size_t sequence;
  std::string kind;
  std::string button;
  SemanticTarget target;
  std::vector<std::string> changed;
};

struct PendingEvent {
  ULONGLONG offsetMs;
  std::string kind;
  std::string button;
  POINT point{};
  bool hasPoint = false;
  bool preferFocused = false;
  HWND targetWindow = nullptr;
  DWORD targetProcessId = 0;
};

std::string wideToUtf8(const std::wstring& input) {
  if (input.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<size_t>(std::max(length, 0)), '\0');
  if (length > 0) WideCharToMultiByte(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), result.data(), length, nullptr, nullptr);
  return result;
}

std::string escape(const std::string& input) {
  std::string output; output.reserve(input.size());
  for (const unsigned char character : input) {
    switch (character) {
      case '"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (character < 0x20) { char buffer[7]; std::snprintf(buffer, sizeof(buffer), "\\u%04x", character); output += buffer; }
        else output += static_cast<char>(character);
    }
  }
  return output;
}

// The recorder must be able to correlate an accessibility control without
// placing raw UI labels, values, automation IDs, or window titles in a trace.
std::string identifierDigest(const std::wstring& identifier) {
  if (identifier.empty()) return {};
  HCRYPTPROV provider = 0;
  HCRYPTHASH hash = 0;
  if (!CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
      !CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) ||
      !CryptHashData(hash, reinterpret_cast<const BYTE*>(identifier.data()), static_cast<DWORD>(identifier.size() * sizeof(wchar_t)), 0)) {
    if (hash) CryptDestroyHash(hash);
    if (provider) CryptReleaseContext(provider, 0);
    return {};
  }
  BYTE bytes[32]{}; DWORD length = sizeof(bytes);
  const bool complete = CryptGetHashParam(hash, HP_HASHVAL, bytes, &length, 0) == TRUE;
  CryptDestroyHash(hash); CryptReleaseContext(provider, 0);
  if (!complete || length < 12) return {};
  std::ostringstream stream;
  for (size_t index = 0; index < 12; ++index) stream << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(bytes[index]);
  return stream.str();
}

std::string appIdForWindow(HWND window) {
  DWORD processId = 0; GetWindowThreadProcessId(window, &processId);
  if (!processId) return {};
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (!process) return {};
  std::wstring executable(32'768, L'\0'); DWORD length = static_cast<DWORD>(executable.size());
  const BOOL queried = QueryFullProcessImageNameW(process, 0, executable.data(), &length); CloseHandle(process);
  if (!queried || !length) return {};
  executable.resize(length);
  return wideToUtf8(std::filesystem::path(executable).filename().wstring());
}

std::string windowIdFor(HWND window) {
  if (!window) return {};
  std::ostringstream stream; stream << "0x" << std::hex << reinterpret_cast<uintptr_t>(window);
  return stream.str();
}

bool variantBool(const VARIANT& value, bool* result) {
  if (value.vt == VT_BOOL) { *result = value.boolVal == VARIANT_TRUE; return true; }
  return false;
}

bool propertyBool(IUIAutomationElement* element, PROPERTYID property, bool* result) {
  VARIANT value; VariantInit(&value);
  const HRESULT hr = element->GetCurrentPropertyValue(property, &value);
  const bool valid = SUCCEEDED(hr) && variantBool(value, result);
  VariantClear(&value);
  return valid;
}

// ElementFromPoint and GetFocusedElement run after the low-level event. A
// process match alone is insufficient when one app owns multiple windows.
bool elementBelongsToRecordedWindow(IUIAutomation* automation, IUIAutomationElement* element, HWND eventWindow) {
  const HWND expected = eventWindow && IsWindow(eventWindow) ? GetAncestor(eventWindow, GA_ROOT) : nullptr;
  if (!automation || !element || !expected) return false;
  IUIAutomationTreeWalker* walker = nullptr;
  if (FAILED(automation->get_RawViewWalker(&walker)) || !walker) return false;
  IUIAutomationElement* current = element;
  current->AddRef();
  bool matches = false;
  for (size_t depth = 0; current && depth < 64; ++depth) {
    int nativeHandle = 0;
    if (SUCCEEDED(current->get_CurrentNativeWindowHandle(&nativeHandle)) && nativeHandle) {
      const HWND candidate = GetAncestor(reinterpret_cast<HWND>(static_cast<LONG_PTR>(nativeHandle)), GA_ROOT);
      if (candidate) {
        matches = candidate == expected;
        break;
      }
    }
    IUIAutomationElement* parent = nullptr;
    const HRESULT parentResult = walker->GetParentElement(current, &parent);
    current->Release();
    current = SUCCEEDED(parentResult) ? parent : nullptr;
  }
  if (current) current->Release();
  walker->Release();
  return matches;
}

SemanticTarget semanticTarget(const POINT* point, bool preferFocused, HWND eventWindow, DWORD eventProcessId) {
  SemanticTarget target;
  const HWND window = eventWindow && IsWindow(eventWindow) ? GetAncestor(eventWindow, GA_ROOT) : nullptr;
  if (!window) return target;
  DWORD currentProcessId = 0;
  GetWindowThreadProcessId(window, &currentProcessId);
  if (!eventProcessId || currentProcessId != eventProcessId) return target;
  target.appId = appIdForWindow(window);
  target.windowId = windowIdFor(window);
  IUIAutomation* automation = nullptr;
  IUIAutomationElement* element = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)))) return target;
  HRESULT hr = E_FAIL;
  if (preferFocused) hr = automation->GetFocusedElement(&element);
  else if (point) hr = automation->ElementFromPoint(*point, &element);
  if (FAILED(hr) || !element) { automation->Release(); return target; }
  int actualProcess = 0; element->get_CurrentProcessId(&actualProcess);
  if (static_cast<DWORD>(actualProcess) != eventProcessId || !elementBelongsToRecordedWindow(automation, element, window)) {
    element->Release(); automation->Release(); return target;
  }
  element->get_CurrentControlType(&target.controlType);
  BSTR automationId = nullptr; element->get_CurrentAutomationId(&automationId);
  if (automationId) { target.automationIdDigest = identifierDigest(std::wstring(automationId, SysStringLen(automationId))); SysFreeString(automationId); }
  target.hasEnabled = propertyBool(element, UIA_IsEnabledPropertyId, &target.enabled);
  target.hasFocused = propertyBool(element, UIA_HasKeyboardFocusPropertyId, &target.focused);
  target.hasPassword = propertyBool(element, UIA_IsPasswordPropertyId, &target.password);
  bool invoke = false, selection = false, value = false, expand = false;
  const bool hasInvoke = propertyBool(element, UIA_IsInvokePatternAvailablePropertyId, &invoke) && invoke;
  const bool hasSelection = propertyBool(element, UIA_IsSelectionItemPatternAvailablePropertyId, &selection) && selection;
  const bool hasValue = propertyBool(element, UIA_IsValuePatternAvailablePropertyId, &value) && value;
  const bool hasExpand = propertyBool(element, UIA_IsExpandCollapsePatternAvailablePropertyId, &expand) && expand;
  target.hasActionable = true; target.actionable = hasInvoke || hasSelection || hasValue || hasExpand;
  element->Release(); automation->Release();
  return target;
}

std::vector<std::string> changedFields(const SemanticTarget* previous, const SemanticTarget& current) {
  if (!previous) return {"app", "window", "control", "state"};
  std::vector<std::string> result;
  if (previous->appId != current.appId) result.emplace_back("app");
  if (previous->windowId != current.windowId) result.emplace_back("window");
  if (previous->controlType != current.controlType || previous->automationIdDigest != current.automationIdDigest) result.emplace_back("control");
  if (previous->hasEnabled != current.hasEnabled || previous->enabled != current.enabled || previous->hasFocused != current.hasFocused || previous->focused != current.focused || previous->hasPassword != current.hasPassword || previous->password != current.password || previous->hasActionable != current.hasActionable || previous->actionable != current.actionable) result.emplace_back("state");
  return result;
}

void writeTarget(std::ostream& output, const SemanticTarget& target) {
  output << "{\"appId\":\"" << escape(target.appId) << "\",\"windowId\":\"" << escape(target.windowId) << "\",\"controlType\":" << target.controlType;
  if (!target.automationIdDigest.empty()) output << ",\"controlIdentifierDigest\":\"" << target.automationIdDigest << "\"";
  if (target.hasEnabled) output << ",\"enabled\":" << (target.enabled ? "true" : "false");
  if (target.hasFocused) output << ",\"focused\":" << (target.focused ? "true" : "false");
  if (target.hasPassword) output << ",\"secure\":" << (target.password ? "true" : "false");
  if (target.hasActionable) output << ",\"actionable\":" << (target.actionable ? "true" : "false");
  output << "}";
}

class Recorder {
 public:
  Recorder() : started_(GetTickCount64()) {}

  // Low-level hooks must not synchronously call UI Automation. They pin the
  // event-time root HWND and keep a short-lived point in memory; the main loop
  // resolves accessibility state later and the point never enters events.jsonl.
  void enqueue(const char* kind, const POINT* point, bool preferFocused, const char* button = nullptr) {
    std::lock_guard lock(mutex_);
    if (events_.size() + pending_.size() >= kMaximumEvents) return;
    const ULONGLONG offsetMs = GetTickCount64() - started_;
    if (std::string_view(kind) == "text_input_redacted" && lastRedactedInputOffsetMs_.has_value() && offsetMs - *lastRedactedInputOffsetMs_ < 500) return;
    if (std::string_view(kind) == "text_input_redacted") lastRedactedInputOffsetMs_ = offsetMs;
    PendingEvent event{offsetMs, kind, button ? button : "", {}, point != nullptr, preferFocused, nullptr, 0};
    if (point) event.point = *point;
    const HWND hit = point ? WindowFromPoint(*point) : GetForegroundWindow();
    event.targetWindow = hit ? GetAncestor(hit, GA_ROOT) : nullptr;
    if (event.targetWindow) GetWindowThreadProcessId(event.targetWindow, &event.targetProcessId);
    pending_.push_back(std::move(event));
  }
  void click(const POINT& point, const char* button) { enqueue("pointer_click", &point, false, button); }
  void scroll(const POINT& point) { enqueue("scroll", &point, false); }
  void redactedInput() { enqueue("text_input_redacted", nullptr, true); }
  ULONGLONG duration() const { return GetTickCount64() - started_; }

  void drain() {
    std::vector<PendingEvent> pending;
    {
      std::lock_guard lock(mutex_);
      pending.swap(pending_);
    }
    for (const auto& event : pending) {
      const SemanticTarget target = semanticTarget(event.hasPoint ? &event.point : nullptr, event.preferFocused, event.targetWindow, event.targetProcessId);
      std::lock_guard lock(mutex_);
      const auto changed = changedFields(lastTarget_ ? &*lastTarget_ : nullptr, target);
      lastTarget_ = target;
      events_.push_back({event.offsetMs, events_.size() + 1, event.kind, event.button, target, changed});
    }
  }

  void write(const std::filesystem::path& eventsPath, const std::filesystem::path& sessionPath, const char* endReason) {
    drain();
    std::vector<Event> copy; { std::lock_guard lock(mutex_); copy = events_; }
    const auto eventsTemp = eventsPath.wstring() + L".tmp";
    std::ofstream events(std::filesystem::path(eventsTemp), std::ios::binary | std::ios::trunc);
    if (!events) throw std::runtime_error("cannot open events file");
    for (const auto& event : copy) {
      events << "{\"sequence\":" << event.sequence << ",\"offsetMs\":" << event.offsetMs << ",\"kind\":\"" << event.kind << "\",\"action\":{\"kind\":\"" << event.kind << "\",\"outcome\":\"" << (event.kind == "text_input_redacted" ? "redacted" : "observed") << "\"";
      if (!event.button.empty()) events << ",\"button\":\"" << event.button << "\"";
      events << "},\"target\":"; writeTarget(events, event.target);
      if (!event.changed.empty()) {
        events << ",\"accessibilityDelta\":{\"changed\":[";
        for (size_t i = 0; i < event.changed.size(); ++i) { if (i) events << ','; events << "\"" << event.changed[i] << "\""; }
        events << "],\"target\":"; writeTarget(events, event.target); events << "}";
      }
      events << "}\n";
    }
    events.close();
    if (!MoveFileExW(eventsTemp.c_str(), eventsPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("cannot finalize events file");
    const auto sessionTemp = sessionPath.wstring() + L".tmp";
    std::ofstream session(std::filesystem::path(sessionTemp), std::ios::binary | std::ios::trunc);
    if (!session) throw std::runtime_error("cannot open session file");
    session << "{\"version\":2,\"platform\":\"Windows\",\"durationMs\":" << duration() << ",\"endReason\":\"" << endReason << "\",\"eventCount\":" << copy.size() << ",\"privacy\":\"No typed text, key codes, clipboard content, cookies, passwords, window titles, screen video, screenshots, or raw coordinates were recorded. Control identifiers are one-way digests.\"}";
    session.close();
    if (!MoveFileExW(sessionTemp.c_str(), sessionPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("cannot finalize session file");
  }

 private:
  ULONGLONG started_;
  mutable std::mutex mutex_;
  std::vector<Event> events_;
  std::vector<PendingEvent> pending_;
  std::optional<SemanticTarget> lastTarget_;
  std::optional<ULONGLONG> lastRedactedInputOffsetMs_;
};

Recorder* gRecorder = nullptr;
std::filesystem::path gRuntimeRoot;
void cleanupRuntimeState() {
  if (gRuntimeRoot.empty()) return;
  std::error_code ignored;
  std::filesystem::remove(gRuntimeRoot / L"state.json", ignored);
  std::filesystem::remove(gRuntimeRoot / L"pid", ignored);
  std::filesystem::remove(gRuntimeRoot / L"stop", ignored);
}
LRESULT CALLBACK keyboardHook(int code, WPARAM message, LPARAM data) {
  if (code >= 0 && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) && gRecorder) gRecorder->redactedInput();
  return CallNextHookEx(nullptr, code, message, data);
}
LRESULT CALLBACK mouseHook(int code, WPARAM message, LPARAM data) {
  if (code >= 0 && gRecorder) {
    const auto* event = reinterpret_cast<const MSLLHOOKSTRUCT*>(data);
    if (event && message == WM_LBUTTONDOWN) gRecorder->click(event->pt, "primary");
    if (event && message == WM_RBUTTONDOWN) gRecorder->click(event->pt, "secondary");
    if (event && message == WM_MBUTTONDOWN) gRecorder->click(event->pt, "other");
    if (event && message == WM_MOUSEWHEEL) gRecorder->scroll(event->pt);
  }
  return CallNextHookEx(nullptr, code, message, data);
}
void fail(const char* message) { cleanupRuntimeState(); std::fputs(message, stderr); std::fputc('\n', stderr); ExitProcess(1); }
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 6 || std::wstring_view(argv[1]) != L"record") fail("usage: BilliardBuddyRecordReplayService record <events.jsonl> <session.json> <stop-file> <max-seconds>");
  const std::filesystem::path eventsPath(argv[2]); const std::filesystem::path sessionPath(argv[3]); const std::filesystem::path stop(argv[4]);
  gRuntimeRoot = eventsPath.parent_path(); const int maxSeconds = _wtoi(argv[5]);
  if (maxSeconds < 30 || maxSeconds > 1'800) fail("invalid recording duration");
  if (MessageBoxW(nullptr, L"BilliardBuddy will record action order plus redacted app, window, control and accessibility-state changes. It never records typed text, key codes, window titles, raw coordinates, clipboard data, passwords, cookies, screenshots or video.", L"Start recording workflow?", MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2) != IDOK) fail("BILLIARDBUDDY_RECORDING_USER_DENIED");
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) fail("BILLIARDBUDDY_RECORDING_UI_AUTOMATION_REQUIRED");
  Recorder recorder; gRecorder = &recorder;
  const HHOOK keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardHook, GetModuleHandleW(nullptr), 0);
  const HHOOK mouse = SetWindowsHookExW(WH_MOUSE_LL, mouseHook, GetModuleHandleW(nullptr), 0);
  if (!keyboard || !mouse) { if (keyboard) UnhookWindowsHookEx(keyboard); if (mouse) UnhookWindowsHookEx(mouse); gRecorder = nullptr; if (SUCCEEDED(initialized)) CoUninitialize(); fail("BILLIARDBUDDY_RECORDING_INPUT_HOOK_REQUIRED"); }
  SetTimer(nullptr, 1, 100, nullptr);
  const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(maxSeconds) * 1'000;
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_TIMER) {
      recorder.drain();
      if (std::filesystem::exists(stop) || GetTickCount64() >= deadline) { PostQuitMessage(0); continue; }
    }
    TranslateMessage(&message); DispatchMessageW(&message);
  }
  KillTimer(nullptr, 1); UnhookWindowsHookEx(keyboard); UnhookWindowsHookEx(mouse); gRecorder = nullptr;
  const bool userStopped = std::filesystem::exists(stop);
  try { std::filesystem::create_directories(eventsPath.parent_path()); recorder.write(eventsPath, sessionPath, userStopped ? "user_stopped" : "duration_expired"); }
  catch (...) { if (SUCCEEDED(initialized)) CoUninitialize(); fail("BILLIARDBUDDY_RECORDING_WRITE_FAILED"); }
  if (SUCCEEDED(initialized)) CoUninitialize(); cleanupRuntimeState(); return 0;
}
