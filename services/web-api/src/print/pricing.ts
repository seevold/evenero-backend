// Pricing-modul — single source of truth for retail-beregning.
//
// Input: produkt-rad fra DB + valg (qty, addons).
// Output: { unitPriceMinor, totalMinor, gelatoUid }.
//
// Brukes både i /quote-endpoint (vis pris til kunde) og i /checkout
// (faktisk linje-pris til Stripe Session). Disse MÅ være identiske ellers
// får vi mismatch mellom det kunden ser og det de betaler.

import type { PrintProduct, PrintQtyVariant, PrintAddon } from "@shared/schema";

export interface PriceQueryItem {
  product: PrintProduct;
  qty: number;
  addonSlugs?: string[];          // valgte addons
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
 * Validér addon-valg + finn SKU-override og samlet tillegg.
 * Hvis to addons har conflictsWith som inkluderer hverandre → kast feil.
 */
function applyAddons(
  product: PrintProduct,
  addonSlugs: string[],
): { gelatoUidOverride?: string; totalSurchargeMinor: number; applied: PricedItem["addonsApplied"] } {
  const addons = ((product.addons as PrintAddon[]) || []);
  const chosen = addons.filter((a) => addonSlugs.includes(a.slug));

  if (chosen.length !== addonSlugs.length) {
    const unknown = addonSlugs.filter((s) => !addons.some((a) => a.slug === s));
    throw new PricingError(
      `Ukjente addons: ${unknown.join(", ")}`,
      "UNKNOWN_ADDON",
    );
  }

  // Sjekk conflicts
  for (const a of chosen) {
    const conflicts = (a as PrintAddon).conflictsWith || [];
    for (const other of chosen) {
      if (other.slug !== a.slug && conflicts.includes(other.slug)) {
        throw new PricingError(
          `Addons '${a.slug}' og '${other.slug}' kan ikke kombineres`,
          "ADDON_CONFLICT",
        );
      }
    }
  }

  // Maks én SKU-override (sjekkes via conflict ovenfor)
  const uidOverrides = chosen.filter((a) => a.gelato_uid_override).map((a) => a.gelato_uid_override!);
  if (uidOverrides.length > 1) {
    throw new PricingError(
      "Flere addons prøver å overstyre SKU samtidig",
      "ADDON_CONFLICT",
    );
  }

  return {
    gelatoUidOverride: uidOverrides[0],
    totalSurchargeMinor: chosen.reduce((s, a) => s + a.surcharge_minor, 0),
    applied: chosen.map((a) => ({
      slug: a.slug,
      label: a.label.no || a.label.en || a.slug,
      surchargeMinor: a.surcharge_minor,
    })),
  };
}

export function priceItem(query: PriceQueryItem, locale: string = "no"): PricedItem {
  const variants = query.product.qtyVariants as unknown as PrintQtyVariant[];
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new PricingError(`Produkt '${query.product.slug}' har ingen qty_variants`, "NO_VARIANTS");
  }

  const variant = resolveVariant(query.qty, variants);
  const addonResult = applyAddons(query.product, query.addonSlugs || []);

  const gelatoUid = addonResult.gelatoUidOverride
    || variant.gelato_uid
    || query.product.defaultGelatoUid;

  const baseRetailMinor = variant.retail_minor;
  const lineTotalMinor = baseRetailMinor + addonResult.totalSurchargeMinor;
  const unitPriceMinor = Math.round(lineTotalMinor / variant.qty);

  return {
    productSlug: query.product.slug,
    gelatoUid,
    qty: variant.qty,                // korrigert hvis bruker spurte om feil tier
    unitPriceMinor,
    lineTotalMinor,
    addonsApplied: addonResult.applied.map((a) => ({
      ...a,
      label: addonResult.applied.find((x) => x.slug === a.slug)?.label || a.slug,
    })),
    variantQty: variant.qty,
    recommended: variant.recommended || false,
    upgradeLabel: variant.upgrade_label,
  };
}

/**
 * Returnerer den laveste enheten i produkt-katalogen — brukes for "fra X kr"-
 * visningen i kategori-tabs.
 */
export function lowestUnitPriceMinor(product: PrintProduct): number {
  const variants = product.qtyVariants as unknown as PrintQtyVariant[];
  if (!variants?.length) return 0;
  return Math.min(...variants.map((v) => Math.round(v.retail_minor / v.qty)));
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
