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
        sidebar: {
          DEFAULT: "#0f172a",
          hover: "#1e293b",
          active: "#334155",
        },
        accent: {
          DEFAULT: "#6366f1",
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