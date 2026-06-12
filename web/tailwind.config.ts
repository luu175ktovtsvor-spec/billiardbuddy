import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 品牌主色:台呢墨绿(球房行业视觉语言),替代原 indigo
        brand: {
          50: "#f2f8f5",
          100: "#e0efe7",
          200: "#c2dfd0",
          300: "#97c7af",
          400: "#65a888",
          500: "#3f8a67",
          600: "#2b7152",
          700: "#235c44",
          800: "#1e4a38",
          900: "#16382b",
          950: "#0c211a",
        },
        sidebar: {
          DEFAULT: "#0c211a",
          hover: "#16382b",
          active: "#1e4a38",
        },
        accent: {
          DEFAULT: "#2b7152",
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