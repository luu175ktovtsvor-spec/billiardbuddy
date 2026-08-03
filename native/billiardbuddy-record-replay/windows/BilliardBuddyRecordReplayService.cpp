#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <string_view>
#include <stdexcept>
#include <system_error>
#include <vector>

namespace {

struct Event {
  ULONGLONG offsetMs;
  std::string kind;
  std::string appName;
  LONG x = 0;
  LONG y = 0;
  LONG deltaY = 0;
  bool hasPoint = false;
  bool hasDelta = false;
};

class Recorder {
 public:
  Recorder() : started_(GetTickCount64()) {}

  void click(const POINT& point) { append("pointer_click", point, 0, true, false); }
  void scroll(const POINT& point, LONG delta) { append("scroll", point, delta, true, true); }
  void redactedInput() { append("text_input_redacted", POINT{}, 0, false, false); }
  ULONGLONG duration() const { return GetTickCount64() - started_; }

  void write(const std::filesystem::path& file, const std::string& purpose) {
    std::vector<Event> copy;
    { std::lock_guard lock(mutex_); copy = events_; }
    const auto temporary = file.wstring() + L".tmp";
    std::ofstream output(std::filesystem::path(temporary), std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("cannot open trace file");
    output << "{\"version\":1,\"platform\":\"Windows\",\"purpose\":\"" << escape(purpose)
           << "\",\"durationMs\":" << duration()
           << ",\"privacy\":\"No window titles, typed text, key codes, clipboard content, cookies, passwords, screen video or screenshots were recorded.\",\"events\":[";
    for (size_t index = 0; index < copy.size(); ++index) {
      const auto& event = copy[index];
      if (index) output << ',';
      output << "{\"offsetMs\":" << event.offsetMs << ",\"kind\":\"" << escape(event.kind)
             << "\",\"appName\":\"" << escape(event.appName) << '\"';
      if (event.hasPoint) output << ",\"x\":" << event.x << ",\"y\":" << event.y;
      if (event.hasDelta) output << ",\"deltaY\":" << event.deltaY;
      output << '}';
    }
    output << "]}";
    output.close();
    if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      throw std::runtime_error("cannot finalize trace file");
    }
  }

 private:
  void append(const char* kind, const POINT& point, LONG delta, bool hasPoint, bool hasDelta) {
    std::lock_guard lock(mutex_);
    if (events_.size() >= 5'000) return;
    events_.push_back({ GetTickCount64() - started_, kind, foregroundAppName(), point.x, point.y, delta, hasPoint, hasDelta });
  }

  static std::string foregroundAppName() {
    const HWND window = GetForegroundWindow();
    if (!window) return {};
    DWORD processId = 0;
    GetWindowThreadProcessId(window, &processId);
    if (!processId) return {};
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
    if (!process) return {};
    std::wstring executable(32'768, L'\0');
    DWORD length = static_cast<DWORD>(executable.size());
    const BOOL queried = QueryFullProcessImageNameW(process, 0, executable.data(), &length);
    CloseHandle(process);
    if (!queried || !length) return {};
    executable.resize(length);
    const std::wstring name = std::filesystem::path(executable).filename().wstring();
    if (name.empty()) return {};
    const int bytes = WideCharToMultiByte(CP_UTF8, 0, name.data(), static_cast<int>(name.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<size_t>(bytes), '\0');
    WideCharToMultiByte(CP_UTF8, 0, name.data(), static_cast<int>(name.size()), result.data(), bytes, nullptr, nullptr);
    return result;
  }

  static std::string escape(const std::string& input) {
    std::string output; output.reserve(input.size());
    for (const unsigned char character : input) {
      switch (character) {
        case '"': output += "\\\""; break;
        case '\\': output += "\\\\"; break;
        case '\n': output += "\\n"; break;
        case '\r': output += "\\r"; break;
        case '\t': output += "\\t"; break;
        default: if (character < 0x20) { char buffer[7]; wsprintfA(buffer, "\\u%04x", character); output += buffer; } else output += static_cast<char>(character);
      }
    }
    return output;
  }

  ULONGLONG started_;
  std::mutex mutex_;
  std::vector<Event> events_;
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
    if (event && (message == WM_LBUTTONDOWN || message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN)) gRecorder->click(event->pt);
    if (event && message == WM_MOUSEWHEEL) gRecorder->scroll(event->pt, static_cast<SHORT>(HIWORD(event->mouseData)));
  }
  return CallNextHookEx(nullptr, code, message, data);
}

std::string toUtf8(const wchar_t* input) {
  const int size = WideCharToMultiByte(CP_UTF8, 0, input, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, input, -1, result.data(), size, nullptr, nullptr);
  result.pop_back();
  return result;
}

void fail(const char* message) { cleanupRuntimeState(); std::fputs(message, stderr); std::fputc('\n', stderr); ExitProcess(1); }

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 6 || std::wstring_view(argv[1]) != L"record") fail("usage: BilliardBuddyRecordReplayService record <trace.json> <stop-file> <max-seconds> <purpose>");
  const std::filesystem::path trace(argv[2]);
  const std::filesystem::path stop(argv[3]);
  gRuntimeRoot = trace.parent_path();
  const int maxSeconds = _wtoi(argv[4]);
  if (maxSeconds < 30 || maxSeconds > 1'800) fail("invalid recording duration");
  const std::string purpose = toUtf8(argv[5]);
  if (MessageBoxW(nullptr, L"BilliardBuddy will record clicks, scrolling, foreground app names and redacted input events for this workflow. It never records window titles, typed text, clipboard data, passwords, cookies, screenshots or video.", L"Start recording workflow?", MB_OKCANCEL | MB_ICONWARNING | MB_DEFBUTTON2) != IDOK) fail("BILLIARDBUDDY_RECORDING_USER_DENIED");

  Recorder recorder; gRecorder = &recorder;
  const HHOOK keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardHook, GetModuleHandleW(nullptr), 0);
  const HHOOK mouse = SetWindowsHookExW(WH_MOUSE_LL, mouseHook, GetModuleHandleW(nullptr), 0);
  if (!keyboard || !mouse) { if (keyboard) UnhookWindowsHookEx(keyboard); if (mouse) UnhookWindowsHookEx(mouse); fail("BILLIARDBUDDY_RECORDING_INPUT_HOOK_REQUIRED"); }
  SetTimer(nullptr, 1, 100, nullptr);
  const ULONGLONG deadline = GetTickCount64() + static_cast<ULONGLONG>(maxSeconds) * 1'000;
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    if (message.message == WM_TIMER && (std::filesystem::exists(stop) || GetTickCount64() >= deadline)) { PostQuitMessage(0); continue; }
    TranslateMessage(&message); DispatchMessageW(&message);
  }
  KillTimer(nullptr, 1); UnhookWindowsHookEx(keyboard); UnhookWindowsHookEx(mouse); gRecorder = nullptr;
  try { std::filesystem::create_directories(trace.parent_path()); recorder.write(trace, purpose); } catch (...) { fail("BILLIARDBUDDY_RECORDING_WRITE_FAILED"); }
  cleanupRuntimeState();
  return 0;
}
