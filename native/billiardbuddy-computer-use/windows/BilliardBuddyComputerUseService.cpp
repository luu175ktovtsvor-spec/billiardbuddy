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
#include <cwctype>
#include <filesystem>
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

void sendMouseClick(long x, long y) {
  if (!SetCursorPos(x, y)) throw ServiceError("Could not move the pointer to the target window");
  INPUT input[2]{};
  input[0].type = INPUT_MOUSE; input[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  input[1].type = INPUT_MOUSE; input[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  if (SendInput(2, input, sizeof(INPUT)) != 2) throw ServiceError("Windows blocked the click because the target has higher privileges or input is unavailable");
}

void sendText(const std::wstring& text) {
  for (const wchar_t character : text) {
    INPUT input[2]{};
    input[0].type = INPUT_KEYBOARD; input[0].ki.wVk = 0; input[0].ki.wScan = character; input[0].ki.dwFlags = KEYEVENTF_UNICODE;
    input[1] = input[0]; input[1].ki.dwFlags |= KEYEVENTF_KEYUP;
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

void sendKey(const std::wstring& key) {
  INPUT input[2]{};
  input[0].type = INPUT_KEYBOARD; input[0].ki.wVk = keyCode(key);
  input[1] = input[0]; input[1].ki.dwFlags = KEYEVENTF_KEYUP;
  if (SendInput(2, input, sizeof(INPUT)) != 2) throw ServiceError("Windows blocked key input because the target has higher privileges or input is unavailable");
}

void sendScroll(double deltaX, double deltaY) {
  INPUT input[2]{};
  input[0].type = INPUT_MOUSE; input[0].mi.dwFlags = MOUSEEVENTF_WHEEL; input[0].mi.mouseData = static_cast<DWORD>(static_cast<LONG>(deltaY * WHEEL_DELTA));
  input[1].type = INPUT_MOUSE; input[1].mi.dwFlags = MOUSEEVENTF_HWHEEL; input[1].mi.mouseData = static_cast<DWORD>(static_cast<LONG>(deltaX * WHEEL_DELTA));
  if (SendInput(2, input, sizeof(INPUT)) != 2) throw ServiceError("Windows blocked scrolling because the target has higher privileges or input is unavailable");
}

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
  if (name) SysFreeString(name);
  element->Release(); automation->Release();
  if (FAILED(hr) || processId <= 0 || static_cast<DWORD>(processId) != expectedProcessId) {
    throw ServiceError("The focused accessibility element is not in the requested app");
  }
  return "{\"controlType\":" + std::to_string(controlType) + ",\"title\":\"" + wideToUtf8(jsonEscape(title)) + "\",\"isPassword\":" + (password ? "true" : "false") + "}";
}

bool focusedElementIsPassword(DWORD expectedProcessId) {
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
  element->Release();
  automation->Release();
  if (FAILED(hr) || processId <= 0 || static_cast<DWORD>(processId) != expectedProcessId) {
    throw ServiceError("Windows UI Automation cannot verify the focused field belongs to the requested app");
  }
  return password != FALSE;
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
  if (command == L"inspect-focused-element") { requireStillForeground(window, appId); std::cout << inspectFocusedElement(window.processId) << std::endl; return; }
  if (command == L"click") {
    const long x = parseLong(argument(arguments, 3, "x"), "x"); const long y = parseLong(argument(arguments, 4, "y"), "y");
    if (x < window.bounds.left || x >= window.bounds.right || y < window.bounds.top || y >= window.bounds.bottom) throw ServiceError("The requested click is outside the current target window");
    requireStillForeground(window, appId); sendMouseClick(x, y); std::cout << "{\"clicked\":true}" << std::endl; return;
  }
  if (command == L"type-text") {
    const auto& text = argument(arguments, 3, "text");
    if (text.size() > 4096) throw ServiceError("text is limited to 4096 characters");
    requireStillForeground(window, appId);
    if (focusedElementIsPassword(window.processId)) throw ServiceError("Computer Use will not type into a secure password field");
    requireStillForeground(window, appId); sendText(text); std::cout << "{\"typed\":true,\"characterCount\":" << text.size() << "}" << std::endl; return;
  }
  if (command == L"press-key") { requireStillForeground(window, appId); sendKey(argument(arguments, 3, "key")); std::cout << "{\"pressed\":true}" << std::endl; return; }
  if (command == L"scroll") { requireStillForeground(window, appId); sendScroll(parseDouble(argument(arguments, 3, "deltaX"), "deltaX"), parseDouble(argument(arguments, 4, "deltaY"), "deltaY")); std::cout << "{\"scrolled\":true}" << std::endl; return; }
  throw ServiceError("Unknown Computer Use command");
}

} // namespace

int wmain(int argc, wchar_t* argv[]) {
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
