import type { Config } from "tailwindcss";

/**
 * Polaris Key brand tokens. Colors are surfaced as CSS custom properties (HSL channels,
 * `--pk-*`) in `styles.css` so a `.dark` / light toggle can swap the whole palette without
 * re-running Tailwind. Every Tailwind color below reads one of those variables, which keeps
 * the design system the single source of truth and lets shadcn-style `bg-card` /
 * `text-muted-foreground` utilities resolve to the right channel in either theme.
 */
const config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--pk-border))",
        input: "hsl(var(--pk-input))",
        ring: "hsl(var(--pk-ring))",
        background: "hsl(var(--pk-background))",
        foreground: "hsl(var(--pk-foreground))",
        primary: {
          DEFAULT: "hsl(var(--pk-primary))",
          foreground: "hsl(var(--pk-primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--pk-secondary))",
          foreground: "hsl(var(--pk-secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--pk-destructive))",
          foreground: "hsl(var(--pk-destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--pk-success))",
          foreground: "hsl(var(--pk-success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--pk-warning))",
          foreground: "hsl(var(--pk-warning-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--pk-muted))",
          foreground: "hsl(var(--pk-muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--pk-accent))",
          foreground: "hsl(var(--pk-accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--pk-popover))",
          foreground: "hsl(var(--pk-popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--pk-card))",
          foreground: "hsl(var(--pk-card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--pk-sidebar))",
          foreground: "hsl(var(--pk-sidebar-foreground))",
          border: "hsl(var(--pk-sidebar-border))",
          accent: "hsl(var(--pk-sidebar-accent))",
        },
      },
      borderRadius: {
        lg: "var(--pk-radius)",
        md: "calc(var(--pk-radius) - 2px)",
        sm: "calc(var(--pk-radius) - 4px)",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      boxShadow: {
        "pk-sm": "0 1px 2px 0 hsl(var(--pk-shadow) / 0.20)",
        "pk-md": "0 4px 12px -2px hsl(var(--pk-shadow) / 0.30)",
        "pk-lg": "0 12px 32px -8px hsl(var(--pk-shadow) / 0.45)",
        "pk-glow": "0 0 0 1px hsl(var(--pk-primary) / 0.35), 0 8px 24px -6px hsl(var(--pk-primary) / 0.35)",
      },
      keyframes: {
        "pk-in": {
          from: { opacity: "0", transform: "translateY(4px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "pk-overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "pk-spin": { to: { transform: "rotate(360deg)" } },
      },
      animation: {
        "pk-in": "pk-in 140ms cubic-bezier(0.16, 1, 0.3, 1)",
        "pk-overlay-in": "pk-overlay-in 120ms ease-out",
        "pk-spin": "pk-spin 0.7s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;

export default config;
