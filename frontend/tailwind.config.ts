import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: v("canvas"),
        surface: v("surface"),
        subtle: v("subtle"),
        muted: v("muted"),
        line: v("line"),
        "line-strong": v("line-strong"),
        ink: v("ink"),
        "ink-2": v("ink-2"),
        "ink-3": v("ink-3"),
        accent: { DEFAULT: v("accent"), soft: v("accent-soft"), ink: v("accent-ink") },
        positive: { DEFAULT: v("positive"), soft: v("positive-soft") },
        caution: { DEFAULT: v("caution"), soft: v("caution-soft") },
        negative: { DEFAULT: v("negative"), soft: v("negative-soft") },
        info: { DEFAULT: v("info"), soft: v("info-soft") },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["11px", "16px"],
        xs: ["12px", "16px"],
        sm: ["13px", "20px"],
        base: ["14px", "22px"],
      },
      boxShadow: {
        card: "0 1px 2px rgb(16 24 40 / 0.04)",
        pop: "0 8px 24px -6px rgb(16 24 40 / 0.16), 0 2px 6px -2px rgb(16 24 40 / 0.08)",
        sheet: "-12px 0 32px -12px rgb(16 24 40 / 0.18)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "pop-in": { from: { opacity: "0", transform: "translateY(-2px) scale(0.98)" }, to: { opacity: "1", transform: "none" } },
        "slide-in": { from: { transform: "translateX(24px)", opacity: "0" }, to: { transform: "none", opacity: "1" } },
        "slide-up": { from: { transform: "translate(-50%, 12px)", opacity: "0" }, to: { transform: "translate(-50%, 0)", opacity: "1" } },
        progress: { "0%": { transform: "translateX(-100%)" }, "100%": { transform: "translateX(250%)" } },
      },
      animation: {
        "fade-in": "fade-in 120ms ease-out",
        "pop-in": "pop-in 120ms ease-out",
        "slide-in": "slide-in 180ms cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-up": "slide-up 180ms cubic-bezier(0.16, 1, 0.3, 1)",
        progress: "progress 1.1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
