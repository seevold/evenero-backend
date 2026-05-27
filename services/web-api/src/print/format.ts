// Felles formatering av ordrelinje-etiketter — brukes i Stripe checkout
// line items, ordrebekreftelse-e-post og status-API.
//
// Mål: vise TOTALT antall stk (qty × packSize) i stedet for det tvetydige
// pakke-antallet. "Flyer A6 × 3" kan bety både 3 stk og 3 pakker — vi gjør
// det entydig: "Flyer A6 — 30 stk (3 pakker à 10)" eller "Plakat A3 — 2 stk".
//
// Lokale strenger holdes her (ikke i en JSON-fil) fordi backend ikke har
// i18next; klient-siden gjenbruker samme regler i print-order-status.tsx.

export type SupportedLocale = "en" | "nb" | "no" | "sv" | "es";

interface LocaleStrings {
  /** "stk", "pcs", "st", "uds" */
  unit: string;
  /** "pakker", "packs", "paket", "paquetes" */
  packs: string;
  /** "à", "of", "à", "de" — skiller pakke-antall fra pakke-størrelse */
  packsOf: string;
}

const STRINGS: Record<string, LocaleStrings> = {
  no: { unit: "stk", packs: "pakker", packsOf: "à" },
  nb: { unit: "stk", packs: "pakker", packsOf: "à" },
  en: { unit: "pcs", packs: "packs", packsOf: "of" },
  sv: { unit: "st", packs: "paket", packsOf: "à" },
  es: { unit: "uds", packs: "paquetes", packsOf: "de" },
};

/** Henter lokal-strenger med fallback til engelsk. */
function pickStrings(locale: string | undefined | null): LocaleStrings {
  const key = (locale || "").toLowerCase().slice(0, 2);
  return STRINGS[key === "nb" ? "no" : key] || STRINGS.en;
}

/** Velger riktig navne-variant fra display_name-record, med fallback. */
function pickName(
  dn: Record<string, string> | null | undefined,
  locale: string,
  fallback: string,
): string {
  if (!dn) return fallback;
  const key = locale.toLowerCase().slice(0, 2);
  const k = key === "nb" ? "no" : key;
  return dn[k] || dn.no || dn.en || Object.values(dn)[0] || fallback;
}

export interface FormatLineLabelInput {
  /** display_name JSONB-felt (en/no/sv/es-record) */
  displayName: Record<string, string> | null | undefined;
  /** pack_size fra print_products — antall stk per pakke */
  packSize: number;
  /** quantity fra print_order_items — antall pakker kunden bestilte */
  qty: number;
  /** Locale for navne-pick OG unit/packs-strenger (en/nb/no/sv/es) */
  locale: string;
  /** Brukes hvis displayName ikke finnes — typisk product_slug */
  fallback?: string;
}

/**
 * Formaterer en ordrelinje:
 *   - packSize > 1 → "Flyer A6 — 30 stk (3 pakker à 10)"
 *   - packSize === 1 → "Plakat A3 — 2 stk"
 *
 * Total antall stk = qty × packSize. Kundens kjøps-enhet (qty) er antall
 * pakker; vi viser totalen først så det matcher det de faktisk får levert.
 */
export function formatOrderLineLabel(input: FormatLineLabelInput): string {
  const { displayName, packSize, qty, locale, fallback = "" } = input;
  const ps = Math.max(1, packSize || 1);
  const total = qty * ps;
  const name = pickName(displayName, locale, fallback);
  const s = pickStrings(locale);
  if (ps > 1) {
    return `${name} — ${total} ${s.unit} (${qty} ${s.packs} ${s.packsOf} ${ps})`;
  }
  return `${name} — ${total} ${s.unit}`;
}
