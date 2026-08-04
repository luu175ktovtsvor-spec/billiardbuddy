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
#include <shellapi.h>
#include <uiautomation.h>
#include <wincodec.h>
#include <wincrypt.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cwctype>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "Crypt32.lib")
#pragma comment(lib, "Gdi32.lib")
#pragma comment(lib, "Ole32.lib")
#pragma comment(lib, "OleAut32.lib")
#pragma comment(lib, "Shell32.lib")
#pragma comment(lib, "UIAutomationCore.lib")
#pragma comment(lib, "User32.lib")
#pragma comment(lib, "Windowscodecs.lib")

namespace {

struct ServiceError : std::runtime_error { using std::runtime_error::runtime_error; };

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return L"";
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (!size) throw ServiceError("Invalid UTF-8 configuration data");
  std::wstring output(size, L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), size)) {
    throw ServiceError("Invalid UTF-8 configuration data");
  }
  return output;
}

std::string wideToUtf8(const std::wstring& value) {
  if (value.empty()) return "";
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (!size) throw ServiceError("Could not encode service output");
  std::string output(size, '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), size, nullptr, nullptr)) {
    throw ServiceError("Could not encode service output");
  }
  return output;
}

std::string sha256Hex(const std::string& value) {
  BYTE digest[32]{};
  DWORD digestLength = sizeof(digest);
  if (!CryptHashCertificate(
        0,
        CALG_SHA_256,
        0,
        reinterpret_cast<const BYTE*>(value.data()),
        static_cast<DWORD>(value.size()),
        digest,
        &digestLength) || digestLength != sizeof(digest)) {
    throw ServiceError("Windows could not fingerprint the accessibility element");
  }
  std::ostringstream output;
  for (BYTE byte : digest) output << std::hex << std::setw(2) << std::setfill('0') << static_cast<unsigned int>(byte);
  return output.str();
}

std::wstring jsonEscape(const std::wstring& value) {
  std::wostringstream output;
  for (const wchar_t character : value) {
    switch (character) {
      case L'\\': output << L"\\\\"; break;
      case L'\"': output << L"\\\""; break;
      case L'\n': output << L"\\n"; break;
      case L'\r': output << L"\\r"; break;
      case L'\t': output << L"\\t"; break;
      default:
        if (character < 0x20) {
          output << L"\\u" << std::hex << std::uppercase << static_cast<unsigned int>(character) << std::dec;
        } else {
          output << character;
        }
    }
  }
  return output.str();
}

std::wstring readFile(const std::filesystem::path& path) {
  FILE* file = _wfopen(path.c_str(), L"rb");
  if (!file) throw ServiceError("Computer Use has no allowed apps. Choose an app in BilliardBuddy settings before continuing.");
  std::string bytes;
  char buffer[4096];
  while (const size_t count = fread(buffer, 1, sizeof(buffer), file)) bytes.append(buffer, count);
  fclose(file);
  return utf8ToWide(bytes);
}

std::wstring parseJsonString(const std::wstring& value, size_t& index) {
  if (index >= value.size() || value[index++] != L'\"') throw ServiceError("Invalid Computer Use configuration");
  std::wstring output;
  while (index < value.size()) {
    const wchar_t character = value[index++];
    if (character == L'\"') return output;
    if (character != L'\\') { output.push_back(character); continue; }
    if (index >= value.size()) throw ServiceError("Invalid Computer Use configuration");
    const wchar_t escaped = value[index++];
    switch (escaped) {
      case L'\"': output.push_back(L'\"'); break;
      case L'\\': output.push_back(L'\\'); break;
      case L'/': output.push_back(L'/'); break;
      case L'b': output.push_back(L'\b'); break;
      case L'f': output.push_back(L'\f'); break;
      case L'n': output.push_back(L'\n'); break;
      case L'r': output.push_back(L'\r'); break;
      case L't': output.push_back(L'\t'); break;
      case L'u': {
        if (index + 4 > value.size()) throw ServiceError("Invalid Computer Use configuration");
        unsigned int codepoint = 0;
        for (size_t offset = 0; offset < 4; ++offset) {
          const wchar_t hex = value[index++];
          codepoint *= 16;
          if (hex >= L'0' && hex <= L'9') codepoint += hex - L'0';
          else if (hex >= L'a' && hex <= L'f') codepoint += hex - L'a' + 10;
          else if (hex >= L'A' && hex <= L'F') codepoint += hex - L'A' + 10;
          else throw ServiceError("Invalid Computer Use configuration");
        }
        output.push_back(static_cast<wchar_t>(codepoint));
        break;
      }
      default: throw ServiceError("Invalid Computer Use configuration");
    }
  }
  throw ServiceError("Invalid Computer Use configuration");
}

std::vector<std::wstring> jsonStringArray(const std::wstring& json, const std::wstring& key) {
  const size_t name = json.find(L"\"" + key + L"\"");
  if (name == std::wstring::npos) return {};
  size_t index = json.find(L'[', name + key.size() + 2);
  if (index == std::wstring::npos) throw ServiceError("Invalid Computer Use configuration");
  ++index;
  std::vector<std::wstring> values;
  while (index < json.size()) {
    while (index < json.size() && iswspace(json[index])) ++index;
    if (index < json.size() && json[index] == L']') return values;
    values.push_back(parseJsonString(json, index));
    while (index < json.size() && iswspace(json[index])) ++index;
    if (index < json.size() && json[index] == L',') { ++index; continue; }
    if (index < json.size() && json[index] == L']') return values;
    throw ServiceError("Invalid Computer Use configuration");
  }
  throw ServiceError("Invalid Computer Use configuration");
}

std::filesystem::path configPath() {
  const wchar_t* home = _wgetenv(L"CODEX_HOME");
  if (!home || !*home) throw ServiceError("Computer Use is not configured. Enable it in BilliardBuddy before accessing an app.");
  return std::filesystem::path(home) / L"computer-use" / L"config.json";
}

std::wstring normalizePath(const std::wstring& value) {
  if (value.empty() || value.size() > 32767) throw ServiceError("Invalid Windows application identifier");
  DWORD required = GetFullPathNameW(value.c_str(), 0, nullptr, nullptr);
  if (!required) throw ServiceError("Invalid Windows application identifier");
  std::wstring output(required, L'\0');
  const DWORD written = GetFullPathNameW(value.c_str(), required, output.data(), nullptr);
  if (!written || written >= required) throw ServiceError("Invalid Windows application identifier");
  output.resize(written);
  std::transform(output.begin(), output.end(), output.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(towlower(character));
  });
  return output;
}

std::vector<std::wstring> allowedApps() {
  const auto values = jsonStringArray(readFile(configPath()), L"allowedExecutablePaths");
  std::vector<std::wstring> normalized;
  for (const auto& value : values) normalized.push_back(normalizePath(value));
  return normalized;
}

bool isAllowed(const std::wstring& appId) {
  const auto normalized = normalizePath(appId);
  const auto allowed = allowedApps();
  return std::find(allowed.begin(), allowed.end(), normalized) != allowed.end();
}

void requireAllowed(const std::wstring& appId) {
  if (!isAllowed(appId)) throw ServiceError(wideToUtf8(appId) + " is not allowed for Computer Use");
}

bool activeDesktop() {
  HDESK desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop) return false;
  CloseDesktop(desktop);
  return GetForegroundWindow() != nullptr;
}

void requireActiveDesktop() {
  if (!activeDesktop()) throw ServiceError("Computer Use requires the active Windows desktop. Unlock the device and keep the target app visible.");
}

std::optional<std::wstring> processPath(DWORD processId) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (!process) return std::nullopt;
  std::wstring value(32768, L'\0');
  DWORD length = static_cast<DWORD>(value.size());
  const bool ok = QueryFullProcessImageNameW(process, 0, value.data(), &length) != FALSE;
  CloseHandle(process);
  if (!ok || !length) return std::nullopt;
  value.resize(length);
  return normalizePath(value);
}

bool windowBelongsTo(HWND window, const std::wstring& appId) {
  DWORD processId = 0;
  GetWindowThreadProcessId(window, &processId);
  const auto path = processPath(processId);
  return path && *path == normalizePath(appId);
}

struct WindowInfo {
  HWND handle;
  RECT bounds;
  std::wstring title;
  DWORD processId;
};

std::vector<WindowInfo> visibleWindows(const std::wstring& appId) {
  std::vector<WindowInfo> windows;
  struct Context { const std::wstring& appId; std::vector<WindowInfo>& windows; } context{appId, windows};
  EnumWindows([](HWND window, LPARAM parameter) -> BOOL {
    auto& context = *reinterpret_cast<Context*>(parameter);
    if (!IsWindowVisible(window) || IsIconic(window) || !windowBelongsTo(window, context.appId)) return TRUE;
    RECT bounds{};
    if (!GetWindowRect(window, &bounds) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return TRUE;
    const int length = GetWindowTextLengthW(window);
    std::wstring title(static_cast<size_t>(std::max(0, length)) + 1, L'\0');
    const int copied = GetWindowTextW(window, title.data(), static_cast<int>(title.size()));
    title.resize(std::max(0, copied));
    DWORD processId = 0;
    GetWindowThreadProcessId(window, &processId);
    context.windows.push_back({window, bounds, title, processId});
    return TRUE;
  }, reinterpret_cast<LPARAM>(&context));
  return windows;
}

void requireStillForeground(const WindowInfo& window, const std::wstring& appId) {
  requireActiveDesktop();
  if (GetForegroundWindow() != window.handle || !windowBelongsTo(window.handle, appId)) {
    throw ServiceError("The requested window lost foreground focus before Computer Use could act");
  }
}

WindowInfo requireWindow(const std::wstring& appId, const std::wstring& rawWindowId, bool foreground) {
  requireAllowed(appId);
  requireActiveDesktop();
  unsigned long long numeric = 0;
  try { numeric = std::stoull(rawWindowId); } catch (...) { throw ServiceError("windowId must be a positive integer"); }
  HWND target = reinterpret_cast<HWND>(static_cast<uintptr_t>(numeric));
  for (const auto& window : visibleWindows(appId)) {
    if (window.handle != target) continue;
    if (foreground && GetForegroundWindow() != target) {
      throw ServiceError("The requested window is no longer foreground. Activate and observe it again before acting.");
    }
    return window;
  }
  throw ServiceError("The requested window is no longer visible for the allowed app");
}

std::string windowsJson(const std::vector<WindowInfo>& windows) {
  std::ostringstream output;
  output << "[";
  for (size_t index = 0; index < windows.size(); ++index) {
    const auto& item = windows[index];
    if (index) output << ",";
    output << "{\"windowId\":" << reinterpret_cast<uintptr_t>(item.handle)
           << ",\"title\":\"" << wideToUtf8(jsonEscape(item.title)) << "\""
           << ",\"x\":" << item.bounds.left << ",\"y\":" << item.bounds.top
           << ",\"width\":" << item.bounds.right - item.bounds.left
           << ",\"height\":" << item.bounds.bottom - item.bounds.top << "}";
  }
  output << "]";
  return output.str();
}

std::string base64(const std::vector<BYTE>& bytes) {
  DWORD required = 0;
  if (!CryptBinaryToStringW(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &required)) {
    throw ServiceError("Could not encode the captured window");
  }
  std::wstring output(required, L'\0');
  if (!CryptBinaryToStringW(bytes.data(), static_cast<DWORD>(bytes.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, output.data(), &required)) {
    throw ServiceError("Could not encode the captured window");
  }
  output.resize(required ? required - 1 : 0);
  return wideToUtf8(output);
}

std::string captureWindow(const WindowInfo& window) {
  const int width = window.bounds.right - window.bounds.left;
  const int height = window.bounds.bottom - window.bounds.top;
  HDC screen = GetDC(nullptr);
  HDC memory = screen ? CreateCompatibleDC(screen) : nullptr;
  HBITMAP bitmap = memory ? CreateCompatibleBitmap(screen, width, height) : nullptr;
  if (!screen || !memory || !bitmap) {
    if (bitmap) DeleteObject(bitmap);
    if (memory) DeleteDC(memory);
    if (screen) ReleaseDC(nullptr, screen);
    throw ServiceError("Could not allocate capture surfaces");
  }
  HGDIOBJ previous = SelectObject(memory, bitmap);
  const bool copied = BitBlt(memory, 0, 0, width, height, screen, window.bounds.left, window.bounds.top, SRCCOPY | CAPTUREBLT) != FALSE;
  SelectObject(memory, previous);
  ReleaseDC(nullptr, screen);
  if (!copied) { DeleteObject(bitmap); DeleteDC(memory); throw ServiceError("Could not capture the requested window"); }

  IWICImagingFactory* factory = nullptr;
  IWICBitmap* wicBitmap = nullptr;
  IWICStream* stream = nullptr;
  IWICBitmapEncoder* encoder = nullptr;
  IWICBitmapFrameEncode* frame = nullptr;
  IPropertyBag2* bag = nullptr;
  IStream* memoryStream = nullptr;
  std::vector<BYTE> bytes;
  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory));
  if (SUCCEEDED(hr)) hr = factory->CreateBitmapFromHBITMAP(bitmap, nullptr, WICBitmapUsePremultipliedAlpha, &wicBitmap);
  if (SUCCEEDED(hr)) hr = CreateStreamOnHGlobal(nullptr, TRUE, &memoryStream);
  if (SUCCEEDED(hr)) hr = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
  if (SUCCEEDED(hr)) hr = encoder->Initialize(memoryStream, WICBitmapEncoderNoCache);
  if (SUCCEEDED(hr)) hr = encoder->CreateNewFrame(&frame, &bag);
  if (SUCCEEDED(hr)) hr = frame->Initialize(bag);
  if (SUCCEEDED(hr)) hr = frame->WriteSource(wicBitmap, nullptr);
  if (SUCCEEDED(hr)) hr = frame->Commit();
  if (SUCCEEDED(hr)) hr = encoder->Commit();
  HGLOBAL global = nullptr;
  if (SUCCEEDED(hr)) hr = GetHGlobalFromStream(memoryStream, &global);
  if (SUCCEEDED(hr)) {
    const SIZE_T size = GlobalSize(global);
    void* data = GlobalLock(global);
    if (!data || !size) hr = E_FAIL;
    else { bytes.assign(static_cast<BYTE*>(data), static_cast<BYTE*>(data) + size); GlobalUnlock(global); }
  }
  if (bag) bag->Release();
  if (frame) frame->Release();
  if (encoder) encoder->Release();
  if (memoryStream) memoryStream->Release();
  if (wicBitmap) wicBitmap->Release();
  if (factory) factory->Release();
  DeleteObject(bitmap);
  DeleteDC(memory);
  if (FAILED(hr)) throw ServiceError("Could not encode the captured window");
  return base64(bytes);
}

void movePointerIntoWindow(const WindowInfo& window, const std::wstring& appId, long x, long y) {
  requireStillForeground(window, appId);
  if (!SetCursorPos(x, y)) throw ServiceError("Could not move the pointer to the target window");
  requireStillForeground(window, appId);
}

void sendMouseClick(const WindowInfo& window, const std::wstring& appId, long x, long y) {
  movePointerIntoWindow(window, appId, x, y);
  INPUT input[2]{};
  input[0].type = INPUT_MOUSE; input[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  input[1].type = INPUT_MOUSE; input[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  requireStillForeground(window, appId);
  if (SendInput(2, input, sizeof(INPUT)) != 2) throw ServiceError("Windows blocked the click because the target has higher privileges or input is unavailable");
}

void sendText(const WindowInfo& window, const std::wstring& appId, const std::wstring& text) {
  for (const wchar_t character : text) {
    INPUT input[2]{};
    input[0].type = INPUT_KEYBOARD; input[0].ki.wVk = 0; input[0].ki.wScan = character; input[0].ki.dwFlags = KEYEVENTF_UNICODE;
    input[1] = input[0]; input[1].ki.dwFlags |= KEYEVENTF_KEYUP;
    requireStillForeground(window, appId);
    if (SendInput(2, input, sizeof(INPUT)) != 2) throw ServiceError("Windows blocked text input because the target has higher privileges or input is unavailable");
  }
}

WORD keyCode(const std::wstring& key) {
  if (key == L"enter") return VK_RETURN;
  if (key == L"tab") return VK_TAB;
  if (key == L"space") return VK_SPACE;
  if (key == L"delete") return VK_BACK;
  if (key == L"escape") return VK_ESCAPE;
  if (key == L"left") return VK_LEFT;
  if (key == L"right") return VK_RIGHT;
  if (key == L"up") return VK_UP;
  if (key == L"down") return VK_DOWN;
  throw ServiceError("Unsupported key. Use enter, tab, space, delete, escape, left, right, up, or down.");
}

void sendKey(const WindowInfo& window, const std::wstring& appId, const std::wstring& key) {
  INPUT input[2]{};
  input[0].type = INPUT_KEYBOARD; input[0].ki.wVk = keyCode(key);
  input[1] = input[0]; input[1].ki.dwFlags = KEYEVENTF_KEYUP;
  requireStillForeground(window, appId);
  if (SendInput(2, input, sizeof(INPUT)) != 2) throw ServiceError("Windows blocked key input because the target has higher privileges or input is unavailable");
}

void sendScroll(const WindowInfo& window, const std::wstring& appId, double deltaX, double deltaY) {
  const long x = window.bounds.left + (window.bounds.right - window.bounds.left) / 2;
  const long y = window.bounds.top + (window.bounds.bottom - window.bounds.top) / 2;
  movePointerIntoWindow(window, appId, x, y);
  INPUT input[2]{};
  input[0].type = INPUT_MOUSE; input[0].mi.dwFlags = MOUSEEVENTF_WHEEL; input[0].mi.mouseData = static_cast<DWORD>(static_cast<LONG>(deltaY * WHEEL_DELTA));
  input[1].type = INPUT_MOUSE; input[1].mi.dwFlags = MOUSEEVENTF_HWHEEL; input[1].mi.mouseData = static_cast<DWORD>(static_cast<LONG>(deltaX * WHEEL_DELTA));
  requireStillForeground(window, appId);
  if (SendInput(2, input, sizeof(INPUT)) != 2) throw ServiceError("Windows blocked scrolling because the target has higher privileges or input is unavailable");
}

bool isSensitiveAutomationElement(IUIAutomationElement* element);

std::string inspectFocusedElement(DWORD expectedProcessId) {
  IUIAutomation* automation = nullptr;
  IUIAutomationElement* element = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
  if (SUCCEEDED(hr)) hr = automation->GetFocusedElement(&element);
  if (FAILED(hr) || !element) { if (automation) automation->Release(); throw ServiceError("Windows UI Automation cannot inspect the focused element"); }
  BSTR name = nullptr;
  CONTROLTYPEID controlType = 0;
  int processId = 0;
  BOOL password = FALSE;
  element->get_CurrentName(&name);
  element->get_CurrentControlType(&controlType);
  hr = element->get_CurrentProcessId(&processId);
  element->get_CurrentIsPassword(&password);
  std::wstring title = name ? std::wstring(name, SysStringLen(name)) : L"";
  const bool sensitive = isSensitiveAutomationElement(element);
  if (name) SysFreeString(name);
  element->Release(); automation->Release();
  if (FAILED(hr) || processId <= 0 || static_cast<DWORD>(processId) != expectedProcessId) {
    throw ServiceError("The focused accessibility element is not in the requested app");
  }
  return "{\"controlType\":" + std::to_string(controlType) + ",\"title\":\"" + wideToUtf8(jsonEscape(sensitive ? L"" : title)) + "\",\"isPassword\":" + (password ? "true" : "false") + ",\"sensitive\":" + (sensitive ? "true" : "false") + "}";
}

bool focusedElementIsSensitive(DWORD expectedProcessId) {
  IUIAutomation* automation = nullptr;
  IUIAutomationElement* element = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
  if (SUCCEEDED(hr)) hr = automation->GetFocusedElement(&element);
  if (FAILED(hr) || !element) {
    if (automation) automation->Release();
    throw ServiceError("Windows UI Automation cannot inspect the focused element before typing");
  }
  int processId = 0;
  BOOL password = FALSE;
  hr = element->get_CurrentProcessId(&processId);
  if (SUCCEEDED(hr)) hr = element->get_CurrentIsPassword(&password);
  const bool sensitive = SUCCEEDED(hr) && isSensitiveAutomationElement(element);
  element->Release();
  automation->Release();
  if (FAILED(hr) || processId <= 0 || static_cast<DWORD>(processId) != expectedProcessId) {
    throw ServiceError("Windows UI Automation cannot verify the focused field belongs to the requested app");
  }
  return sensitive || password != FALSE;
}

IUIAutomation* createAutomation() {
  IUIAutomation* automation = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation))) || !automation) {
    throw ServiceError("Windows UI Automation is unavailable");
  }
  return automation;
}

IUIAutomationElement* windowAutomationElement(IUIAutomation* automation, const WindowInfo& window) {
  IUIAutomationElement* element = nullptr;
  if (FAILED(automation->ElementFromHandle(window.handle, &element)) || !element) {
    throw ServiceError("Windows UI Automation cannot inspect the requested window");
  }
  return element;
}

std::wstring bstrValue(BSTR value) {
  return value ? std::wstring(value, SysStringLen(value)) : L"";
}

bool containsSensitiveHint(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) { return static_cast<wchar_t>(towlower(character)); });
  for (const wchar_t* marker : {L"password", L"passcode", L"verification", L"one-time", L"otp", L"token", L"secret", L"credit card", L"card number", L"cvv", L"security code"}) {
    if (value.find(marker) != std::wstring::npos) return true;
  }
  return false;
}

bool isSensitiveAutomationElement(IUIAutomationElement* element) {
  BOOL password = FALSE; element->get_CurrentIsPassword(&password);
  if (password) return true;
  BSTR name = nullptr, automationId = nullptr, className = nullptr;
  element->get_CurrentName(&name); element->get_CurrentAutomationId(&automationId); element->get_CurrentClassName(&className);
  const auto hints = bstrValue(name) + L" " + bstrValue(automationId) + L" " + bstrValue(className);
  if (name) SysFreeString(name); if (automationId) SysFreeString(automationId); if (className) SysFreeString(className);
  return containsSensitiveHint(hints);
}

bool supportsPattern(IUIAutomationElement* element, PATTERNID pattern) {
  IUnknown* unknown = nullptr;
  const HRESULT hr = element->GetCurrentPattern(pattern, &unknown);
  if (unknown) unknown->Release();
  return SUCCEEDED(hr);
}

std::optional<std::wstring> readableElementValue(IUIAutomationElement* element, bool password) {
  if (password) return std::nullopt;
  IUIAutomationValuePattern* pattern = nullptr;
  if (FAILED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&pattern))) || !pattern) return std::nullopt;
  BSTR value = nullptr;
  const HRESULT hr = pattern->get_CurrentValue(&value);
  pattern->Release();
  if (FAILED(hr) || !value) return std::nullopt;
  auto output = bstrValue(value);
  SysFreeString(value);
  if (output.size() > 4096) output.resize(4096);
  return output;
}

std::string availableActions(IUIAutomationElement* element) {
  std::vector<std::string> actions;
  if (supportsPattern(element, UIA_InvokePatternId)) actions.push_back("Invoke");
  if (supportsPattern(element, UIA_ExpandCollapsePatternId)) { actions.push_back("Expand"); actions.push_back("Collapse"); }
  if (supportsPattern(element, UIA_TogglePatternId)) actions.push_back("Toggle");
  if (supportsPattern(element, UIA_SelectionItemPatternId)) actions.push_back("Select");
  if (supportsPattern(element, UIA_ScrollPatternId)) actions.push_back("Scroll");
  if (supportsPattern(element, UIA_ScrollItemPatternId)) actions.push_back("ScrollIntoView");
  std::ostringstream output; output << "[";
  for (size_t index = 0; index < actions.size(); ++index) { if (index) output << ","; output << "\"" << actions[index] << "\""; }
  output << "]"; return output.str();
}

std::string elementFingerprint(IUIAutomationElement* element) {
  BSTR name = nullptr, automationId = nullptr, className = nullptr;
  CONTROLTYPEID controlType = 0;
  BOOL enabled = FALSE, offscreen = FALSE, password = FALSE;
  RECT rect{};
  element->get_CurrentName(&name);
  element->get_CurrentAutomationId(&automationId);
  element->get_CurrentClassName(&className);
  element->get_CurrentControlType(&controlType);
  element->get_CurrentIsEnabled(&enabled);
  element->get_CurrentIsOffscreen(&offscreen);
  element->get_CurrentIsPassword(&password);
  element->get_CurrentBoundingRectangle(&rect);
  std::ostringstream identity;
  identity << wideToUtf8(bstrValue(name)) << '\x1f'
           << wideToUtf8(bstrValue(automationId)) << '\x1f'
           << wideToUtf8(bstrValue(className)) << '\x1f'
           << controlType << '\x1f' << enabled << '\x1f' << offscreen << '\x1f' << password << '\x1f'
           << rect.left << ',' << rect.top << ',' << rect.right << ',' << rect.bottom << '\x1f'
           << availableActions(element);
  if (name) SysFreeString(name);
  if (automationId) SysFreeString(automationId);
  if (className) SysFreeString(className);
  return sha256Hex(identity.str());
}

std::string describeAutomationElement(IUIAutomationElement* element, int index) {
  BSTR name = nullptr, automationId = nullptr, className = nullptr;
  CONTROLTYPEID controlType = 0; BOOL enabled = FALSE, offscreen = FALSE, focused = FALSE, password = FALSE;
  RECT rect{};
  element->get_CurrentName(&name);
  element->get_CurrentAutomationId(&automationId);
  element->get_CurrentClassName(&className);
  element->get_CurrentControlType(&controlType);
  element->get_CurrentIsEnabled(&enabled);
  element->get_CurrentIsOffscreen(&offscreen);
  element->get_CurrentHasKeyboardFocus(&focused);
  element->get_CurrentIsPassword(&password);
  element->get_CurrentBoundingRectangle(&rect);
  const auto nameText = bstrValue(name), idText = bstrValue(automationId), classText = bstrValue(className);
  const bool sensitive = password != FALSE || containsSensitiveHint(nameText + L" " + idText + L" " + classText);
  if (name) SysFreeString(name); if (automationId) SysFreeString(automationId); if (className) SysFreeString(className);
  std::ostringstream output;
  output << "{\"elementIndex\":" << index
         << ",\"elementFingerprint\":\"" << elementFingerprint(element) << "\""
         << ",\"controlType\":" << controlType
         << ",\"name\":\"" << wideToUtf8(jsonEscape(nameText)) << "\""
         << ",\"automationId\":\"" << wideToUtf8(jsonEscape(idText)) << "\""
         << ",\"className\":\"" << wideToUtf8(jsonEscape(classText)) << "\""
         << ",\"enabled\":" << (enabled ? "true" : "false")
         << ",\"offscreen\":" << (offscreen ? "true" : "false")
         << ",\"focused\":" << (focused ? "true" : "false")
         << ",\"secure\":" << (password ? "true" : "false")
         << ",\"sensitive\":" << (sensitive ? "true" : "false")
         << ",\"bounds\":{\"x\":" << rect.left << ",\"y\":" << rect.top
         << ",\"width\":" << std::max(0L, rect.right - rect.left) << ",\"height\":" << std::max(0L, rect.bottom - rect.top) << "}"
         << ",\"actions\":" << availableActions(element);
  if (const auto value = readableElementValue(element, sensitive)) {
    output << ",\"value\":\"" << wideToUtf8(jsonEscape(*value)) << "\"";
  }
  output << "}";
  return output.str();
}

std::vector<IUIAutomationElement*> snapshotElements(IUIAutomation* automation, IUIAutomationElement* root, int maxNodes) {
  IUIAutomationCondition* condition = nullptr;
  IUIAutomationElementArray* array = nullptr;
  HRESULT hr = automation->CreateTrueCondition(&condition);
  if (SUCCEEDED(hr)) hr = root->FindAll(TreeScope_Subtree, condition, &array);
  if (condition) condition->Release();
  if (FAILED(hr) || !array) throw ServiceError("Windows UI Automation cannot enumerate the requested window");
  int length = 0; array->get_Length(&length);
  std::vector<IUIAutomationElement*> elements;
  elements.reserve(static_cast<size_t>(std::min(length, maxNodes)));
  for (int index = 0; index < length && index < maxNodes; ++index) {
    IUIAutomationElement* element = nullptr;
    if (SUCCEEDED(array->GetElement(index, &element)) && element) elements.push_back(element);
  }
  array->Release();
  return elements;
}

void releaseElements(std::vector<IUIAutomationElement*>& elements) {
  for (auto* element : elements) if (element) element->Release();
  elements.clear();
}

std::string accessibilityTree(const WindowInfo& window, const std::wstring& appId, int maxNodes) {
  IUIAutomation* automation = createAutomation();
  IUIAutomationElement* root = nullptr;
  std::vector<IUIAutomationElement*> elements;
  try {
    root = windowAutomationElement(automation, window);
    elements = snapshotElements(automation, root, maxNodes);
    std::ostringstream output;
    output << "{\"appId\":\"" << wideToUtf8(jsonEscape(appId)) << "\",\"windowId\":" << reinterpret_cast<uintptr_t>(window.handle)
           << ",\"fresh\":true,\"truncated\":" << (elements.size() >= static_cast<size_t>(maxNodes) ? "true" : "false") << ",\"nodes\":[";
    for (size_t index = 0; index < elements.size(); ++index) { if (index) output << ","; output << describeAutomationElement(elements[index], static_cast<int>(index)); }
    output << "]}";
    releaseElements(elements); root->Release(); automation->Release(); return output.str();
  } catch (...) { releaseElements(elements); if (root) root->Release(); automation->Release(); throw; }
}

IUIAutomationElement* currentElementAt(IUIAutomation* automation, const WindowInfo& window, int index, const std::wstring& requestedFingerprint) {
  if (index < 0 || index >= 500) throw ServiceError("elementIndex must refer to a fresh accessibility snapshot");
  if (requestedFingerprint.size() != 64 || !std::all_of(requestedFingerprint.begin(), requestedFingerprint.end(), [](wchar_t character) {
        return (character >= L'0' && character <= L'9') || (character >= L'a' && character <= L'f');
      })) throw ServiceError("elementFingerprint must come from a fresh accessibility snapshot");
  IUIAutomationElement* root = windowAutomationElement(automation, window);
  std::vector<IUIAutomationElement*> elements;
  try {
    elements = snapshotElements(automation, root, 500);
    root->Release(); root = nullptr;
    if (static_cast<size_t>(index) >= elements.size()) { releaseElements(elements); throw ServiceError("The requested element is no longer in the current accessibility snapshot. Inspect the window again."); }
    IUIAutomationElement* selected = elements[static_cast<size_t>(index)];
    if (elementFingerprint(selected) != wideToUtf8(requestedFingerprint)) {
      releaseElements(elements);
      throw ServiceError("The requested accessibility element changed after inspection. Inspect the window again.");
    }
    selected->AddRef(); releaseElements(elements); return selected;
  } catch (...) { releaseElements(elements); if (root) root->Release(); throw; }
}

void mouseDrag(const WindowInfo& window, const std::wstring& appId, long fromX, long fromY, long toX, long toY) {
  movePointerIntoWindow(window, appId, fromX, fromY);
  const long virtualLeft = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const long virtualTop = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const long virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const long virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (virtualWidth <= 1 || virtualHeight <= 1) throw ServiceError("Windows virtual desktop geometry is unavailable");
  INPUT input[3]{};
  input[0].type = INPUT_MOUSE; input[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  input[1].type = INPUT_MOUSE;
  input[1].mi.dx = static_cast<LONG>((toX - virtualLeft) * 65535LL / (virtualWidth - 1));
  input[1].mi.dy = static_cast<LONG>((toY - virtualTop) * 65535LL / (virtualHeight - 1));
  input[1].mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  input[2].type = INPUT_MOUSE; input[2].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  requireStillForeground(window, appId);
  if (SendInput(3, input, sizeof(INPUT)) != 3) throw ServiceError("Windows blocked dragging because the target has higher privileges or input is unavailable");
}

void invokeElement(IUIAutomationElement* element, const WindowInfo& window, const std::wstring& appId) {
  IUIAutomationInvokePattern* invoke = nullptr;
  if (SUCCEEDED(element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&invoke))) && invoke) {
    const HRESULT hr = invoke->Invoke(); invoke->Release(); if (SUCCEEDED(hr)) return;
  }
  RECT rect{}; element->get_CurrentBoundingRectangle(&rect);
  const long x = rect.left + (rect.right - rect.left) / 2, y = rect.top + (rect.bottom - rect.top) / 2;
  if (x < window.bounds.left || x >= window.bounds.right || y < window.bounds.top || y >= window.bounds.bottom) throw ServiceError("The selected element has no press action or usable bounds");
  sendMouseClick(window, appId, x, y);
}

void setElementValue(IUIAutomationElement* element, const std::wstring& value) {
  if (isSensitiveAutomationElement(element)) throw ServiceError("Computer Use will not read or change a password, credential, or payment field");
  IUIAutomationValuePattern* pattern = nullptr;
  if (FAILED(element->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&pattern))) || !pattern) throw ServiceError("The selected element does not accept a text value");
  const HRESULT hr = pattern->SetValue(value.c_str()); pattern->Release();
  if (FAILED(hr)) throw ServiceError("The selected element rejected the requested value");
}

void selectElementText(
    IUIAutomationElement* element,
    const std::wstring& text,
    const std::wstring& prefix,
    const std::wstring& suffix,
    const std::wstring& selectionType) {
  if (isSensitiveAutomationElement(element)) throw ServiceError("Computer Use will not read or change a password, credential, or payment field");
  if (selectionType != L"text" && selectionType != L"cursor_before" && selectionType != L"cursor_after") {
    throw ServiceError("selectionType must be text, cursor_before, or cursor_after");
  }
  IUIAutomationTextPattern* pattern = nullptr;
  IUIAutomationTextRange* document = nullptr;
  IUIAutomationTextRange* search = nullptr;
  IUIAutomationTextRange* prefixRange = nullptr;
  IUIAutomationTextRange* found = nullptr;
  IUIAutomationTextRange* suffixSearch = nullptr;
  IUIAutomationTextRange* suffixRange = nullptr;
  BSTR needle = SysAllocStringLen(text.data(), static_cast<UINT>(text.size()));
  BSTR prefixNeedle = prefix.empty() ? nullptr : SysAllocStringLen(prefix.data(), static_cast<UINT>(prefix.size()));
  BSTR suffixNeedle = suffix.empty() ? nullptr : SysAllocStringLen(suffix.data(), static_cast<UINT>(suffix.size()));
  if (!needle || (!prefix.empty() && !prefixNeedle) || (!suffix.empty() && !suffixNeedle)) {
    if (needle) SysFreeString(needle);
    if (prefixNeedle) SysFreeString(prefixNeedle);
    if (suffixNeedle) SysFreeString(suffixNeedle);
    throw ServiceError("Could not allocate the requested selection text");
  }
  HRESULT hr = element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern));
  if (SUCCEEDED(hr)) hr = pattern->get_DocumentRange(&document);
  if (SUCCEEDED(hr)) hr = document->Clone(&search);
  if (SUCCEEDED(hr) && prefixNeedle) hr = search->FindText(prefixNeedle, FALSE, FALSE, &prefixRange);
  if (SUCCEEDED(hr) && prefixNeedle && !prefixRange) hr = UIA_E_ELEMENTNOTAVAILABLE;
  if (SUCCEEDED(hr) && prefixRange) hr = search->MoveEndpointByRange(TextPatternRangeEndpoint_Start, prefixRange, TextPatternRangeEndpoint_End);
  if (SUCCEEDED(hr)) hr = search->FindText(needle, FALSE, FALSE, &found);
  if (SUCCEEDED(hr) && !found) hr = UIA_E_ELEMENTNOTAVAILABLE;
  if (SUCCEEDED(hr) && suffixNeedle) hr = document->Clone(&suffixSearch);
  if (SUCCEEDED(hr) && suffixSearch) hr = suffixSearch->MoveEndpointByRange(TextPatternRangeEndpoint_Start, found, TextPatternRangeEndpoint_End);
  if (SUCCEEDED(hr) && suffixSearch) hr = suffixSearch->FindText(suffixNeedle, FALSE, FALSE, &suffixRange);
  if (SUCCEEDED(hr) && suffixNeedle && !suffixRange) hr = UIA_E_ELEMENTNOTAVAILABLE;
  if (SUCCEEDED(hr) && selectionType == L"cursor_before") {
    hr = found->MoveEndpointByRange(TextPatternRangeEndpoint_End, found, TextPatternRangeEndpoint_Start);
  } else if (SUCCEEDED(hr) && selectionType == L"cursor_after") {
    hr = found->MoveEndpointByRange(TextPatternRangeEndpoint_Start, found, TextPatternRangeEndpoint_End);
  }
  if (SUCCEEDED(hr) && found) hr = found->Select();
  SysFreeString(needle);
  if (prefixNeedle) SysFreeString(prefixNeedle);
  if (suffixNeedle) SysFreeString(suffixNeedle);
  if (suffixRange) suffixRange->Release();
  if (suffixSearch) suffixSearch->Release();
  if (found) found->Release();
  if (prefixRange) prefixRange->Release();
  if (search) search->Release();
  if (document) document->Release();
  if (pattern) pattern->Release();
  if (FAILED(hr)) throw ServiceError("The requested text is not present or cannot be selected in the current element");
}

void secondaryElementAction(IUIAutomationElement* element, const std::wstring& action) {
  HRESULT hr = E_NOTIMPL;
  if (action == L"Invoke") { IUIAutomationInvokePattern* p = nullptr; if (SUCCEEDED(element->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&p))) && p) { hr = p->Invoke(); p->Release(); } }
  else if (action == L"Toggle") { IUIAutomationTogglePattern* p = nullptr; if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TogglePatternId, IID_PPV_ARGS(&p))) && p) { hr = p->Toggle(); p->Release(); } }
  else if (action == L"Select") { IUIAutomationSelectionItemPattern* p = nullptr; if (SUCCEEDED(element->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(&p))) && p) { hr = p->Select(); p->Release(); } }
  else if (action == L"Expand" || action == L"Collapse") { IUIAutomationExpandCollapsePattern* p = nullptr; if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ExpandCollapsePatternId, IID_PPV_ARGS(&p))) && p) { hr = action == L"Expand" ? p->Expand() : p->Collapse(); p->Release(); } }
  else if (action == L"ScrollIntoView") { IUIAutomationScrollItemPattern* p = nullptr; if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ScrollItemPatternId, IID_PPV_ARGS(&p))) && p) { hr = p->ScrollIntoView(); p->Release(); } }
  else throw ServiceError("The requested action is not exposed by the current accessibility element");
  if (FAILED(hr)) throw ServiceError("The selected accessibility action failed");
}

void scrollElement(IUIAutomationElement* element, const std::wstring& direction, int pages) {
  IUIAutomationScrollPattern* pattern = nullptr;
  if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ScrollPatternId, IID_PPV_ARGS(&pattern))) && pattern) {
    const ScrollAmount amount = pages > 1 ? ScrollAmount_LargeIncrement : ScrollAmount_SmallIncrement;
    ScrollAmount horizontal = ScrollAmount_NoAmount, vertical = ScrollAmount_NoAmount;
    if (direction == L"up") vertical = pages > 1 ? ScrollAmount_LargeDecrement : ScrollAmount_SmallDecrement;
    else if (direction == L"down") vertical = amount;
    else if (direction == L"left") horizontal = pages > 1 ? ScrollAmount_LargeDecrement : ScrollAmount_SmallDecrement;
    else if (direction == L"right") horizontal = amount;
    else { pattern->Release(); throw ServiceError("direction must be up, down, left, or right"); }
    const HRESULT hr = pattern->Scroll(horizontal, vertical); pattern->Release(); if (SUCCEEDED(hr)) return;
  }
  throw ServiceError("The selected element does not expose a native scroll action");
}

long parseLong(const std::wstring& value, const char* name) {
  try { return std::stol(value); } catch (...) { throw ServiceError(std::string(name) + " must be a number"); }
}

double parseDouble(const std::wstring& value, const char* name) {
  try {
    const double number = std::stod(value);
    if (!std::isfinite(number) || std::abs(number) > 100000) throw ServiceError(std::string(name) + " must be a safe finite number");
    return number;
  } catch (const ServiceError&) { throw; } catch (...) { throw ServiceError(std::string(name) + " must be a number"); }
}

int parseElementIndex(const std::wstring& value) {
  const long index = parseLong(value, "elementIndex");
  if (index < 0 || index >= 500) throw ServiceError("elementIndex must refer to a fresh accessibility snapshot index");
  return static_cast<int>(index);
}

const std::wstring& argument(const std::vector<std::wstring>& arguments, size_t index, const char* name) {
  if (arguments.size() <= index || arguments[index].empty()) throw ServiceError(std::string("Missing ") + name);
  return arguments[index];
}

void run(const std::vector<std::wstring>& arguments) {
  const auto& command = argument(arguments, 0, "command");
  if (command == L"status") {
    bool uiAutomation = false;
    IUIAutomation* automation = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)))) { uiAutomation = true; automation->Release(); }
    size_t allowed = 0; bool config = false;
    try { config = std::filesystem::exists(configPath()); allowed = allowedApps().size(); } catch (...) {}
    std::cout << "{\"platform\":\"Windows\",\"activeDesktop\":" << (activeDesktop() ? "true" : "false")
              << ",\"uiAutomation\":" << (uiAutomation ? "true" : "false")
              << ",\"configurationPresent\":" << (config ? "true" : "false")
              << ",\"allowedAppCount\":" << allowed << "}" << std::endl;
    return;
  }
  if (command == L"list-allowed-apps") {
    std::cout << "["; const auto apps = allowedApps();
    for (size_t i = 0; i < apps.size(); ++i) {
      if (i) std::cout << ",";
      std::cout << "{\"appId\":\"" << wideToUtf8(jsonEscape(apps[i])) << "\",\"running\":" << (!visibleWindows(apps[i]).empty() ? "true" : "false") << "}";
    }
    std::cout << "]" << std::endl; return;
  }
  const auto& appId = argument(arguments, 1, "appId");
  if (command == L"list-windows") { requireAllowed(appId); requireActiveDesktop(); std::cout << windowsJson(visibleWindows(appId)) << std::endl; return; }
  if (command == L"activate-app") {
    requireAllowed(appId); requireActiveDesktop();
    if (reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", appId.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32) throw ServiceError("Could not launch the allowed app");
    std::cout << "{\"appId\":\"" << wideToUtf8(jsonEscape(normalizePath(appId))) << "\",\"activated\":true}" << std::endl; return;
  }
  if (command == L"wait-for-window") {
    requireAllowed(appId); requireActiveDesktop();
    const long timeout = std::clamp(parseLong(argument(arguments, 2, "timeoutMs"), "timeoutMs"), 100L, 10000L);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout);
    while (std::chrono::steady_clock::now() < deadline) {
      const auto windows = visibleWindows(appId);
      if (!windows.empty()) { std::cout << "{\"found\":true,\"windows\":" << windowsJson(windows) << "}" << std::endl; return; }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    std::cout << "{\"found\":false}" << std::endl; return;
  }
  // GDI captures the active desktop surface rather than a private off-screen
  // app buffer. Requiring foreground avoids returning another app's overlay.
  const auto window = requireWindow(appId, argument(arguments, 2, "windowId"), true);
  if (command == L"capture-window") {
    requireStillForeground(window, appId);
    const auto image = captureWindow(window);
    requireStillForeground(window, appId);
    std::cout << image << std::endl;
    return;
  }
  if (command == L"accessibility-tree") {
    const long requested = std::clamp(parseLong(argument(arguments, 3, "maxNodes"), "maxNodes"), 1L, 500L);
    requireStillForeground(window, appId);
    const auto tree = accessibilityTree(window, appId, static_cast<int>(requested));
    requireStillForeground(window, appId);
    std::cout << tree << std::endl;
    return;
  }
  if (command == L"inspect-focused-element") { requireStillForeground(window, appId); std::cout << inspectFocusedElement(window.processId) << std::endl; return; }
  if (command == L"click-element") {
    const int index = parseElementIndex(argument(arguments, 3, "elementIndex"));
    const auto& fingerprint = argument(arguments, 4, "elementFingerprint");
    requireStillForeground(window, appId); IUIAutomation* automation = createAutomation(); IUIAutomationElement* element = nullptr;
    try { element = currentElementAt(automation, window, index, fingerprint); requireStillForeground(window, appId); invokeElement(element, window, appId); element->Release(); automation->Release(); }
    catch (...) { if (element) element->Release(); automation->Release(); throw; }
    std::cout << "{\"clicked\":true,\"elementIndex\":" << index << ",\"mode\":\"accessibility\"}" << std::endl; return;
  }
  if (command == L"click") {
    const long x = parseLong(argument(arguments, 3, "x"), "x"); const long y = parseLong(argument(arguments, 4, "y"), "y");
    if (x < window.bounds.left || x >= window.bounds.right || y < window.bounds.top || y >= window.bounds.bottom) throw ServiceError("The requested click is outside the current target window");
    requireStillForeground(window, appId); sendMouseClick(window, appId, x, y); std::cout << "{\"clicked\":true}" << std::endl; return;
  }
  if (command == L"drag") {
    const long fromX = parseLong(argument(arguments, 3, "fromX"), "fromX"), fromY = parseLong(argument(arguments, 4, "fromY"), "fromY");
    const long toX = parseLong(argument(arguments, 5, "toX"), "toX"), toY = parseLong(argument(arguments, 6, "toY"), "toY");
    if (fromX < window.bounds.left || fromX >= window.bounds.right || fromY < window.bounds.top || fromY >= window.bounds.bottom || toX < window.bounds.left || toX >= window.bounds.right || toY < window.bounds.top || toY >= window.bounds.bottom) throw ServiceError("The requested drag is outside the current target window");
    requireStillForeground(window, appId); mouseDrag(window, appId, fromX, fromY, toX, toY); std::cout << "{\"dragged\":true}" << std::endl; return;
  }
  if (command == L"set-value") {
    const int index = parseElementIndex(argument(arguments, 3, "elementIndex")); const auto& fingerprint = argument(arguments, 4, "elementFingerprint"); const auto& value = argument(arguments, 5, "value");
    if (value.size() > 4096) throw ServiceError("value is limited to 4096 characters");
    requireStillForeground(window, appId); IUIAutomation* automation = createAutomation(); IUIAutomationElement* element = nullptr;
    try { element = currentElementAt(automation, window, index, fingerprint); requireStillForeground(window, appId); setElementValue(element, value); element->Release(); automation->Release(); }
    catch (...) { if (element) element->Release(); automation->Release(); throw; }
    std::cout << "{\"valueSet\":true,\"elementIndex\":" << index << ",\"characterCount\":" << value.size() << "}" << std::endl; return;
  }
  if (command == L"select-text") {
    const int index = parseElementIndex(argument(arguments, 3, "elementIndex")); const auto& fingerprint = argument(arguments, 4, "elementFingerprint"); const auto& text = argument(arguments, 5, "text");
    const std::wstring prefix = arguments.size() > 6 ? arguments[6] : L"";
    const std::wstring suffix = arguments.size() > 7 ? arguments[7] : L"";
    const std::wstring selectionType = arguments.size() > 8 && !arguments[8].empty() ? arguments[8] : L"text";
    if (text.size() > 4096 || prefix.size() > 4096 || suffix.size() > 4096) throw ServiceError("selection text and context are limited to 4096 characters");
    requireStillForeground(window, appId); IUIAutomation* automation = createAutomation(); IUIAutomationElement* element = nullptr;
    try { element = currentElementAt(automation, window, index, fingerprint); requireStillForeground(window, appId); selectElementText(element, text, prefix, suffix, selectionType); element->Release(); automation->Release(); }
    catch (...) { if (element) element->Release(); automation->Release(); throw; }
    std::cout << "{\"selected\":true,\"elementIndex\":" << index << ",\"selectionType\":\"" << wideToUtf8(jsonEscape(selectionType)) << "\"}" << std::endl; return;
  }
  if (command == L"secondary-action") {
    const int index = parseElementIndex(argument(arguments, 3, "elementIndex")); const auto& fingerprint = argument(arguments, 4, "elementFingerprint"); const auto& action = argument(arguments, 5, "action");
    if (action.size() > 256) throw ServiceError("action is limited to 256 characters");
    requireStillForeground(window, appId); IUIAutomation* automation = createAutomation(); IUIAutomationElement* element = nullptr;
    try { element = currentElementAt(automation, window, index, fingerprint); requireStillForeground(window, appId); secondaryElementAction(element, action); element->Release(); automation->Release(); }
    catch (...) { if (element) element->Release(); automation->Release(); throw; }
    std::cout << "{\"performed\":true,\"elementIndex\":" << index << ",\"action\":\"" << wideToUtf8(jsonEscape(action)) << "\"}" << std::endl; return;
  }
  if (command == L"type-text") {
    const auto& text = argument(arguments, 3, "text");
    if (text.size() > 4096) throw ServiceError("text is limited to 4096 characters");
    requireStillForeground(window, appId);
    if (focusedElementIsSensitive(window.processId)) throw ServiceError("Computer Use will not type into a password, credential, or payment field");
    requireStillForeground(window, appId); sendText(window, appId, text); std::cout << "{\"typed\":true,\"characterCount\":" << text.size() << "}" << std::endl; return;
  }
  if (command == L"press-key") { requireStillForeground(window, appId); sendKey(window, appId, argument(arguments, 3, "key")); std::cout << "{\"pressed\":true}" << std::endl; return; }
  if (command == L"scroll") { requireStillForeground(window, appId); sendScroll(window, appId, parseDouble(argument(arguments, 3, "deltaX"), "deltaX"), parseDouble(argument(arguments, 4, "deltaY"), "deltaY")); std::cout << "{\"scrolled\":true}" << std::endl; return; }
  if (command == L"scroll-element") {
    const int index = parseElementIndex(argument(arguments, 3, "elementIndex")); const auto& fingerprint = argument(arguments, 4, "elementFingerprint"); const auto& direction = argument(arguments, 5, "direction");
    const int pages = static_cast<int>(std::clamp(parseLong(argument(arguments, 6, "pages"), "pages"), 1L, 10L));
    requireStillForeground(window, appId); IUIAutomation* automation = createAutomation(); IUIAutomationElement* element = nullptr;
    try { element = currentElementAt(automation, window, index, fingerprint); requireStillForeground(window, appId); scrollElement(element, direction, pages); element->Release(); automation->Release(); }
    catch (...) { if (element) element->Release(); automation->Release(); throw; }
    std::cout << "{\"scrolled\":true,\"elementIndex\":" << index << ",\"mode\":\"accessibility\"}" << std::endl; return;
  }
  throw ServiceError("Unknown Computer Use command");
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
  // UIA bounds and injected pointer coordinates must share physical pixels on
  // mixed-DPI multi-monitor desktops. Access denied only means the packaged
  // host already established an equivalent process DPI context.
  if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) && GetLastError() != ERROR_ACCESS_DENIED) {
    std::cerr << "Could not enable per-monitor DPI awareness" << std::endl;
    return 64;
  }
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) { std::cerr << "Could not initialize Windows Computer Use" << std::endl; return 64; }
  try {
    std::vector<std::wstring> arguments;
    for (int index = 1; index < argc; ++index) arguments.emplace_back(argv[index]);
    run(arguments);
    if (SUCCEEDED(initialized)) CoUninitialize();
    return 0;
  } catch (const std::exception& error) {
    if (SUCCEEDED(initialized)) CoUninitialize();
    std::cerr << error.what() << std::endl;
    return 64;
  }
}
