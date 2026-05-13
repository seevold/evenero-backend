// Design tokens shared by all email templates.
// Email clients have wildly inconsistent CSS support — keep these as raw
// values that get inlined per element. No external stylesheets, no @media
// outside hardcoded fallbacks, no CSS variables.
//
// Palett matcher Evenero-appen: purple (#8b5cf6 = primary) + pink
// (#ec4899) som gradient-aksent, mot crisp off-white surfaces og høy-
// kontrast tekst. "Eksklusiv og fresh" oppnås gjennom rikelig whitespace,
// tunge tracking-verdier på eyebrows, og gradient kun på CTA + tynne
// detaljer (divider, logo-glow) — ikke i bulk-områder hvor det ville
// kappet lesbarheten.

export const TOKENS = {
  // ── Surfaces ────────────────────────────────────────────────────────────
  bgPage: '#f6f5f9',        // outer page (kjølig off-white med lett purple-undertone)
  bgCard: '#ffffff',        // card surface
  border: '#ececf3',         // soft cool-gray border
  hairline: '#f0eff5',       // very faint divider lines

  // ── Text ────────────────────────────────────────────────────────────────
  textPrimary: '#0f0f14',   // headings, body emphasis (near-black for crisp contrast)
  textBody: '#2e2e3a',      // standard body copy
  textMuted: '#6c6c79',     // secondary info
  textFaint: '#a4a4b0',     // tertiary, footer

  // ── Brand-aksenter ──────────────────────────────────────────────────────
  // Matcher --evenero-purple / --evenero-pink fra client/src/index.css.
  // Gradient brukes på CTA og tynne dekorelementer.
  accent: '#8b5cf6',         // primary purple — eyebrows, dividers, links
  accentAlt: '#ec4899',      // pink — gradient endpoint, sjeldne høydepunkter
  accentSoft: '#f5f0ff',     // svært subtil lavender-tint, brukes som code-bg
  accentGradient: 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',

  // ── CTA button ──────────────────────────────────────────────────────────
  // Bulletproof-button bruker bgcolor på <td> (fast farge) som fallback for
  // Outlook, og gradient som inline background på samme element for klienter
  // som støtter det. Tekst alltid hvit.
  buttonBg: '#8b5cf6',
  buttonBgGradient: 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
  buttonText: '#ffffff',

  // ── Status colors (used sparingly) ──────────────────────────────────────
  successBg: '#ecfdf3',
  successText: '#0a7d4a',
  warningBg: '#fef3c7',
  warningText: '#92400e',

  // ── Typography ──────────────────────────────────────────────────────────
  // Inter er appens primær-font. Lastes via Google Fonts <link> i email-head.
  // Klienter som blokkerer webfonts (Outlook/Gmail i dark mode etc.) får
  // system-sans som fallback — utseendet forblir clean.
  sans:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  // Mono for PIN-koder og IDs.
  mono: "'SF Mono', Menlo, Consolas, monospace",
  // Serif beholdt for bakoverkompat med eksisterende kall, men ikke brukt
  // i ny layout. Hvis noen i fremtiden vil ha italic-serif heading kan de
  // referere TOKENS.serif direkte.
  serif: "Georgia, 'Times New Roman', serif",
} as const;

// Plain-text and date locale codes per app locale. Used by formatters.
export const LOCALE_DATE_CODES: Record<string, string> = {
  nb: 'nb-NO',
  sv: 'sv-SE',
  es: 'es-ES',
  en: 'en-US',
};
