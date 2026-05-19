import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1280px" },
    },
    extend: {
      fontFamily: {
        // Hero numbers, page H1, big eyebrows — Instrument Serif italic is
        // the signature of the Cleo-caliber visual lift. Falls back to
        // Fraunces (already loaded) for older browsers.
        serif: ['"Instrument Serif"', "Fraunces", "ui-serif", "Georgia", "serif"],
        // Body, UI, tables, numbers — Inter Variable.
        sans: ['"Inter Variable"', "Inter", "Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        // Foundation
        bg: "hsl(var(--bg))",
        "bg-2": "hsl(var(--bg-2))",
        paper: "hsl(var(--bg))",
        surface: {
          DEFAULT: "hsl(var(--surface))",
          hi: "hsl(var(--surface-hi))",
        },
        ink: {
          DEFAULT: "hsl(var(--ink))",
          2: "hsl(var(--ink-2))",
          soft: "hsl(var(--ink-soft))",
          mute: "hsl(var(--ink-mute))",
          faint: "hsl(var(--ink-faint))",
        },
        rule: {
          DEFAULT: "hsl(var(--rule))",
          soft: "hsl(var(--rule-soft))",
          strong: "hsl(var(--rule-strong))",
        },

        // Brand palette — teal CTA (#2ED3C6), gold accent (#D6A84F)
        brand: {
          DEFAULT: "hsl(var(--brand))",
          dark: "hsl(var(--brand-d))",
          light: "hsl(var(--brand-l))",
          tint: "hsl(var(--brand-tint))",
        },
        teal: {
          DEFAULT: "hsl(var(--brand))",
          dark: "hsl(var(--brand-d))",
          light: "hsl(var(--brand-l))",
        },
        accent2: {
          DEFAULT: "hsl(var(--brand-2))",
          dark: "hsl(var(--brand-2-d))",
          light: "hsl(var(--brand-2-l))",
          tint: "hsl(var(--brand-2-tint))",
        },
        silver: "hsl(var(--silver))",
        // Legacy aliases (kept so unmigrated code keeps rendering)
        burgundy: {
          DEFAULT: "hsl(var(--brand))",
          dark: "hsl(var(--brand-d))",
          light: "hsl(var(--brand-l))",
          tint: "hsl(var(--brand-tint))",
        },
        gold: {
          DEFAULT: "hsl(var(--brand-2))",
          tint: "hsl(var(--brand-2-tint))",
        },

        // Semantic state
        success: {
          DEFAULT: "hsl(var(--success))",
          tint: "hsl(var(--success-tint))",
          bg: "hsl(var(--success-tint))",
        },
        caution: {
          DEFAULT: "hsl(var(--caution))",
          tint: "hsl(var(--caution-tint))",
          bg: "hsl(var(--caution-tint))",
        },
        alert: {
          DEFAULT: "hsl(var(--alert))",
          tint: "hsl(var(--alert-tint))",
          bg: "hsl(var(--alert-tint))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          tint: "hsl(var(--info-tint))",
        },
        warning2: {
          DEFAULT: "hsl(var(--warning-2))",
          tint: "hsl(var(--warning-2-tint))",
        },

        // shadcn aliases
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        md: "var(--radius)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        1: "var(--shadow-1)",
        2: "var(--shadow-2)",
        3: "var(--shadow-3)",
        4: "var(--shadow-4)",
        inset: "var(--shadow-inset)",
        focus: "var(--ring-focus)",
        // Legacy aliases (existing code references these)
        card: "var(--shadow-1)",
        glass: "var(--shadow-2)",
      },
      transitionTimingFunction: {
        quint: "cubic-bezier(0.16, 1, 0.3, 1)",
        fluid: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
        "fade-up": { "0%": { opacity: "0", transform: "translateY(8px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        "count-up": { "0%": { opacity: "0", transform: "translateY(6px)" }, "100%": { opacity: "1", transform: "translateY(0)" } },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-up": "fade-up 320ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "fade-in": "fade-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "count-up": "count-up 480ms cubic-bezier(0.16, 1, 0.3, 1) both",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
