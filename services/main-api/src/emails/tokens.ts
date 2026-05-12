// Design tokens shared by all email templates.
// Email clients have wildly inconsistent CSS support — keep these as raw
// values that get inlined per element. No external stylesheets, no @media
// outside hardcoded fallbacks, no CSS variables.

export const TOKENS = {
  // ── Surfaces ────────────────────────────────────────────────────────────
  bgPage: '#f7f4ed',        // outer page (warm off-white linen)
  bgCard: '#ffffff',        // card surface
  border: '#e8e0d0',        // soft cream border around cards
  hairline: '#ebe5d6',      // very faint divider lines

  // ── Text ────────────────────────────────────────────────────────────────
  textPrimary: '#1a1a1a',   // headings, body emphasis
  textBody: '#3d3328',      // standard body copy
  textMuted: '#7a6e5b',     // secondary info
  textFaint: '#a89878',     // tertiary, footer

  // ── Accents ─────────────────────────────────────────────────────────────
  accent: '#c9a961',        // warm gold for thin separators + eyebrows
  accentSoft: '#f3ebd3',    // subtle gold tint for backgrounds

  // ── CTA button ──────────────────────────────────────────────────────────
  buttonBg: '#1a1a1a',
  buttonText: '#ffffff',

  // ── Status colors (used sparingly) ──────────────────────────────────────
  successBg: '#f0f7ed',
  successText: '#2d5a27',
  warningBg: '#fdf4e3',
  warningText: '#8a6500',

  // ── Typography ──────────────────────────────────────────────────────────
  // Serif chosen for the wordmark + headings. Email clients can't load
  // custom webfonts reliably so we stay with system serif (Georgia is the
  // safest baseline across Gmail/Outlook/Apple Mail).
  serif: "Georgia, 'Times New Roman', 'Playfair Display', serif",
  // System sans for body copy.
  sans:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  // Tabular monospace for codes (PIN, IDs).
  mono: "'SF Mono', Menlo, Consolas, monospace",
} as const;

// Plain-text and date locale codes per app locale. Used by formatters.
export const LOCALE_DATE_CODES: Record<string, string> = {
  nb: 'nb-NO',
  sv: 'sv-SE',
  es: 'es-ES',
  en: 'en-US',
};
