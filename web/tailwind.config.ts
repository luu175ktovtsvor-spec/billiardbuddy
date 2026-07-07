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
      // B-Task-2：内置中文字体 MiSans（web/src/app/globals.css 里 @font-face 已注册 400/600 两个字重）。
      // Tailwind Preflight 默认把 html { font-family: theme('fontFamily.sans', ...) } 套到根节点、
      // 全站继承，这里覆盖 sans 键即可全局生效，不用逐组件加 class。
      // Mac：PingFang SC 排在 MiSans 前面先命中，观感和之前一样不变。
      // Windows：没有 PingFang，落到内置的 MiSans，不再是系统微软雅黑（雅黑无中间字重、小字发糊）。
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "MiSans",
          "Microsoft YaHei",
          "Segoe UI",
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        // 桌面 Agent 走法 B:绿只做点缀/焦点,主按钮走中性近黑。
        brand: {
          50: "#effaf6",
          100: "#d7f4ea",
          200: "#b3ead8",
          300: "#83dcc2",
          400: "#4fc9a8",
          500: "#10a37f",
          600: "#0e906f",
          700: "#0b735a",
          800: "#075b48",
          900: "#06483a",
          950: "#032b22",
        },
        // iOS 浅色侧边栏(macOS 系统设置同款灰)
        sidebar: {
          DEFAULT: "#f2f2f7",
          hover: "#e8e8ed",
          active: "#dcdce1",
        },
        accent: {
          DEFAULT: "#10a37f",
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
