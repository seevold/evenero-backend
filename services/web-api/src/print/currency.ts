// Land → valuta-resolving for print (fase 1: NOK/SEK/DKK/EUR).
//
// Prisbok-modell: hvert marked prises nativt i sin valuta (Gelato-lokalkost +
// markup, lagret i print_products.prices_by_currency). INGEN FX-konvertering
// i runtime — vist pris == belastet pris fordi catalog/quote/checkout alle
// leser samme lagrede beløp.
//
// Land utenfor de prisede valutaene faller tilbake til EUR (vi har EUR-priser,
// så det er konsistent uten Adaptive-Pricing-avhengighet). For kort er US/CA
// uansett ekskludert; kun plakater treffer fallback.

/** Valutaer vi faktisk har prisbok for (fase 1). NOK er default/anker. */
export const PRICED_CURRENCIES = ["NOK", "SEK", "DKK", "EUR"] as const;
export type PricedCurrency = (typeof PRICED_CURRENCIES)[number];

/** Fallback for land hvis native valuta ikke er i prisboken. */
const FALLBACK_CURRENCY: PricedCurrency = "EUR";

/** Eksplisitt land → native valuta (kun de vi priser direkte). */
const COUNTRY_TO_CURRENCY: Record<string, PricedCurrency> = {
  NO: "NOK",
  SE: "SEK",
  DK: "DKK",
  // Euro-sonen blant våre støttede land:
  FI: "EUR", DE: "EUR", FR: "EUR", NL: "EUR", BE: "EUR",
  AT: "EUR", IE: "EUR", ES: "EUR", IT: "EUR", PT: "EUR",
};

/**
 * Resolver hvilken valuta et land skal prises i. Land vi ikke har native
 * pris for (IS/CH/PL/GB/US/CA/AU/NZ) → EUR-fallback.
 */
export function currencyForCountry(country: string): PricedCurrency {
  return COUNTRY_TO_CURRENCY[(country || "").toUpperCase()] || FALLBACK_CURRENCY;
}

/** True hvis valutaen er NOK (= les fra qty_variants, ikke prices_by_currency). */
export function isAnchorCurrency(currency: string): boolean {
  return currency.toUpperCase() === "NOK";
}
