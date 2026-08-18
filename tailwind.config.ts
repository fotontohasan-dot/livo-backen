import type { Config } from "tailwindcss";

// NOTE: Tailwind v4 is CSS-first — the actual token source of truth is the
// `@theme inline` block in src/app/globals.css, which maps every semantic
// token (background, surface, text-primary, accent, …) onto CSS custom
// properties that flip with [data-theme="dark"|"light"] on <html>. This file
// is kept in sync for editor tooling / documentation only.
const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        "background-secondary": "var(--background-secondary)",
        surface: "var(--surface)",
        "surface-elevated": "var(--surface-elevated)",
        border: "var(--border)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-soft": "var(--accent-soft)",
        "on-accent": "var(--on-accent)",
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",
        "icon-primary": "var(--icon-primary)",
        "icon-secondary": "var(--icon-secondary)",
      },
      backgroundImage: {
        "gold-gradient": "linear-gradient(135deg, var(--accent), var(--accent-hover))",
        "card-gradient": "linear-gradient(145deg, var(--surface), var(--surface-elevated))",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
      },
    },
  },
  plugins: [],
};
export default config;
