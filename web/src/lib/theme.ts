// P1-10 深浅色:亮/暗/跟随系统。class 策略(tailwind darkMode:"class")——
// 手动切=给 <html> 加/去 .dark;跟随系统=不存偏好、按 prefers-color-scheme 实时跟。
// 首屏防闪烁的同步脚本在 app/layout.tsx 里内联(早于 paint);这里管运行时切换 + 系统变化监听。
export type ThemeMode = "light" | "dark" | "system";
const KEY = "theme";

export function getTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const t = localStorage.getItem(KEY);
  return t === "light" || t === "dark" ? t : "system";
}

function systemDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  if (mode === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  const dark = mode === "dark" || (mode === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
}

// 跟随系统时,系统深浅色变了要实时跟上。返回清理函数(给 useEffect 用)。
export function watchSystemTheme(): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getTheme() === "system") document.documentElement.classList.toggle("dark", mq.matches);
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
