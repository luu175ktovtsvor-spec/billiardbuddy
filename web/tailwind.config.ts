import type { Config } from "tailwindcss";

const config: Config = {
  // P1-10 改 class 策略:支持 app 内"亮/暗/跟随系统"手动切(见 lib/theme.ts)。
  // 跟随系统时由 layout 内联脚本 + watchSystemTheme 按 prefers-color-scheme 给 <html> 加/去 .dark。
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 品牌主色:iOS 系统蓝(2026-06-12 用户拍板苹果风,tint 用法:只给可点元素)
        brand: {
          50: "#f0f7ff",
          100: "#e0efff",
          200: "#bdddff",
          300: "#8cc2ff",
          400: "#4da3ff",
          500: "#1a8cff",
          600: "#007aff",
          700: "#0066d6",
          800: "#0055b3",
          900: "#004591",
          950: "#002b5c",
        },
        // iOS 浅色侧边栏(macOS 系统设置同款灰)
        sidebar: {
          DEFAULT: "#f2f2f7",
          hover: "#e8e8ed",
          active: "#dcdce1",
        },
        accent: {
          DEFAULT: "#007aff",
          foreground: "#ffffff",
        },
      },
      borderRadius: {
        lg: "10px",
        md: "6px",
      },
    },
  },
  plugins: [
    require("@tailwindcss/typography"),
  ],
};
export default config;