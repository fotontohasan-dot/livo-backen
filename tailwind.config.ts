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
        background: "#0A0F1C",
        card: {
          DEFAULT: "#1A2338",
        },
        primary: {
          DEFAULT: "#FBBF24", // Gold
          dark: "#D97706",
        },
        secondary: "#10B981", // Emerald
        text: {
          main: "#F1F5F9",
          muted: "#94A3B8",
        },
        accent: "#EF4444", // Hot Badge Red
      },
      backgroundImage: {
        "gold-gradient": "linear-gradient(135deg, #FBBF24, #D97706)",
        "card-gradient": "linear-gradient(145deg, #1A2338, #111827)",
      },
    },
  },
  plugins: [],
};
export default config;
