import type { Config } from "tailwindcss";

const config: Config = {
  // 跟随系统深浅色（prefers-color-scheme）：dark: 变体在系统暗色时自动生效。浅色为默认。
  darkMode: "media",
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