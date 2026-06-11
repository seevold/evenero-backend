// Pricing-modul — single source of truth for retail-beregning.
//
// Input: produkt-rad fra DB + valg (qty, addons).
// Output: { unitPriceMinor, totalMinor, gelatoUid }.
//
// Brukes både i /quote-endpoint (vis pris til kunde) og i /checkout
// (faktisk linje-pris til Stripe Session). Disse MÅ være identiske ellers
// får vi mismatch mellom det kunden ser og det de betaler.

import type { PrintProduct, PrintQtyVariant, PrintAddon, PrintPricesByCurrency } from "@shared/schema";

export interface PriceQueryItem {
  product: PrintProduct;
  qty: number;
  addonSlugs?: string[];          // valgte addons
  /** Valuta å prise i. NOK (default) leser qty_variants; andre valutaer leser
   *  prices_by_currency (uten addons — addons er NOK-only i fase 1). */
  currency?: string;
}

export interface PricedItem {
  productSlug: string;
  gelatoUid: string;
  qty: number;
  unitPriceMinor: number;          // (retail / qty), avrundet
  lineTotalMinor: number;          // total inkl. addon-tillegg
  addonsApplied: Array<{
    slug: string;
    label: string;
    surchargeMinor: number;
  }>;
  /** Variant-info vist i UI */
  variantQty: number;              // qty-tier som ble matchet
  recommended: boolean;
  upgradeLabel?: string;
}

export class PricingError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "PricingError";
  }
}

/**
 * Finn nærmeste qty-variant ved eller under angitt qty.
 * Hvis qty < minste tier → kast feil (kunden må velge gyldig qty).
 */
function resolveVariant(qty: number, variants: PrintQtyVariant[]): PrintQtyVariant {
  const sorted = [...variants].sort((a, b) => a.qty - b.qty);
  if (qty < sorted[0].qty) {
    throw new PricingError(
      `qty=${qty} er under minimum (${sorted[0].qty})`,
      "QTY_TOO_LOW",
    );
  }
  // Eksakt match foretrekkes
  const exact = sorted.find((v) => v.qty === qty);
  if (exact) return exact;
  // Ellers: høyeste tier ≤ qty
  let match = sorted[0];
  for (const v of sorted) {
    if (v.qty <= qty) match = v;
    else break;
  }
  return match;
}

/**
 * Validér addon-valg + komponér Gelato-UID + beregn samlet tillegg.
 *
 * UID-bygging:
 *  - gelato_uid_override: bytter HELE UID-en (maks én — sjekket via conflict)
 *  - uid_replace: komponerbar string-replace (flere kan stables)
 * Surcharge:
 *  - flat: surcharge_minor brukes som-er
 *  - per_unit: surcharge_minor × qty
 */
function applyAddons(
  product: PrintProduct,
  addonSlugs: string[],
  qty: number,
  baseUid: string,
): { resolvedUid: string; totalSurchargeMinor: number; applied: PricedItem["addonsApplied"] } {
  const addons = ((product.addons as PrintAddon[]) || []);
  const chosen = addons.filter((a) => addonSlugs.includes(a.slug));

  if (chosen.length !== addonSlugs.length) {
    const unknown = addonSlugs.filter((s) => !addons.some((a) => a.slug === s));
    throw new PricingError(`Ukjente addons: ${unknown.join(", ")}`, "UNKNOWN_ADDON");
  }

  // Conflict-sjekk
  for (const a of chosen) {
    for (const other of chosen) {
      if (other.slug !== a.slug && (a.conflictsWith || []).includes(other.slug)) {
        throw new PricingError(
          `Addons '${a.slug}' og '${other.slug}' kan ikke kombineres`,
          "ADDON_CONFLICT",
        );
      }
    }
  }

  // UID-komposisjon
  const overrides = chosen.filter((a) => a.gelato_uid_override);
  if (overrides.length > 1) {
    throw new PricingError("Flere addons overstyrer SKU samtidig", "ADDON_CONFLICT");
  }
  let resolvedUid = overrides[0]?.gelato_uid_override || baseUid;
  for (const a of chosen) {
    if (a.uid_replace) {
      if (!resolvedUid.includes(a.uid_replace.from)) {
        throw new PricingError(
          `Addon '${a.slug}': UID-del '${a.uid_replace.from}' finnes ikke i ${resolvedUid}`,
          "ADDON_UID_MISMATCH",
        );
      }
      resolvedUid = resolvedUid.replace(a.uid_replace.from, a.uid_replace.to);
    }
  }

  // Surcharge
  let totalSurchargeMinor = 0;
  const applied: PricedItem["addonsApplied"] = [];
  for (const a of chosen) {
    const sc = a.surcharge_mode === "per_unit"
      ? a.surcharge_minor * qty
      : a.surcharge_minor;
    totalSurchargeMinor += sc;
    applied.push({
      slug: a.slug,
      label: a.label.no || a.label.en || a.slug,
      surchargeMinor: sc,
    });
  }

  return { resolvedUid, totalSurchargeMinor, applied };
}

export function priceItem(query: PriceQueryItem, locale: string = "no"): PricedItem {
  const variants = query.product.qtyVariants as unknown as PrintQtyVariant[];
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new PricingError(`Produkt '${query.product.slug}' har ingen qty_variants`, "NO_VARIANTS");
  }

  const variant = resolveVariant(query.qty, variants);
  const baseUid = variant.gelato_uid || query.product.defaultGelatoUid;
  const currency = (query.currency || "NOK").toUpperCase();

  // ── Multi-valuta (ikke NOK): les prisbok, ingen addons (NOK-only i fase 1) ──
  if (currency !== "NOK") {
    const pbc = (query.product.pricesByCurrency as unknown as PrintPricesByCurrency) || {};
    const tier = pbc[currency]?.[String(variant.qty)];
    // Fallback til NOK hvis valutaen ikke er seedet for dette produktet ennå —
    // graceful, hindrer at en kunde får ingen pris. (Skal ikke skje etter seed.)
    if (tier?.retail_minor != null) {
      return {
        productSlug: query.product.slug,
        gelatoUid: baseUid,                 // ingen addon-UID-modifikasjon (addons av)
        qty: variant.qty,
        unitPriceMinor: Math.round(tier.retail_minor / variant.qty),
        lineTotalMinor: tier.retail_minor,
        addonsApplied: [],
        variantQty: variant.qty,
        recommended: variant.recommended || false,
        upgradeLabel: variant.upgrade_label,
      };
    }
    // (faller gjennom til NOK-prising under hvis tier mangler)
  }

  // ── NOK (anker) — uendret oppførsel, inkl. addons ──
  const addonResult = applyAddons(query.product, query.addonSlugs || [], variant.qty, baseUid);
  const lineTotalMinor = variant.retail_minor + addonResult.totalSurchargeMinor;
  const unitPriceMinor = Math.round(lineTotalMinor / variant.qty);

  return {
    productSlug: query.product.slug,
    gelatoUid: addonResult.resolvedUid,
    qty: variant.qty,
    unitPriceMinor,
    lineTotalMinor,
    addonsApplied: addonResult.applied,
    variantQty: variant.qty,
    recommended: variant.recommended || false,
    upgradeLabel: variant.upgrade_label,
  };
}

/**
 * Returnerer den laveste pris-per-fysiske-enhet i produkt-katalogen — brukes
 * for "fra X kr/stk"-visningen i kategori-tabs.
 *
 * VIKTIG: deler på (qty × packSize). For postkort med packSize=10 betyr
 * qty=10 → 100 fysiske kort. Uten packSize-multiplikasjon ville "fra"-prisen
 * bli 10× for høy (postkort viste 90 kr/stk istedenfor 9 kr/stk).
 */
export function lowestUnitPriceMinor(product: PrintProduct): number {
  const variants = product.qtyVariants as unknown as PrintQtyVariant[];
  if (!variants?.length) return 0;
  const packSize = (product as unknown as { packSize?: number }).packSize || 1;
  return Math.min(...variants.map((v) => Math.round(v.retail_minor / (v.qty * packSize))));
}

/**
 * Returnerer den laveste totalprisen (line_total ved lavest variant) — brukes
 * for "fra X kr" på poster-/single-item-kategorier.
 */
export function lowestLineTotalMinor(product: PrintProduct): number {
  const variants = product.qtyVariants as unknown as PrintQtyVariant[];
  if (!variants?.length) return 0;
  return Math.min(...variants.map((v) => v.retail_minor));
}
