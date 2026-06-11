// Seed + refresh av print-katalogen.
//
// Flyt:
//   1. Last alle PRODUCTS fra print-product-catalog.ts
//   2. For hver (product, qtyVariant) → kall Gelato quote i Norge for å få
//      worst-case landed cost (produkt + cheapest normal shipping).
//      Hvis ingen normal shipping → bruk express (vi suger opp diff).
//   3. Beregn retail med markupTargetPct og round til pene tall.
//   4. Upsert categories + products i staging-DB.
//
// Bruk:
//   npm run print:seed                  # dry-run, viser hva som ville skjedd
//   npm run print:seed -- --apply        # skriver til DB
//   npm run print:seed -- --apply --only=businesscard_bc   # bare ett produkt
//
// Krever env:
//   GELATO_API_KEY               (Gelato API)
//   DATABASE_URL eller PG_*      (staging-DB)
//
// Kjør lokalt med:
//   GELATO_API_KEY=$(gcloud secrets versions access latest --secret=staging-gelato-api-key --project=evenero) \
//   DB_HOST=34.88.151.183 DB_USER=postgres DB_NAME=postgres \
//   DB_PASSWORD=$(gcloud secrets versions access latest --secret=staging-db-password --project=evenero) \
//   npx tsx scripts/seed-print-products.ts --apply

import { Pool } from "pg";
import { GelatoClient } from "../src/print/gelato/client";
import { CATEGORIES, PRODUCTS, type ProductDef, type ProductVariantDef } from "./print-product-catalog";

// ─── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY = args.find((a) => a.startsWith("--only="))?.split("=")[1];
const VERBOSE = args.includes("--verbose");

// ─── Env-validering ──────────────────────────────────────────────────────
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Mangler env-var: ${name}`);
  return v;
}

const gelato = new GelatoClient({ apiKey: required("GELATO_API_KEY") });

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "postgres",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  ssl: process.env.DB_HOST?.startsWith("127.") ? false : { rejectUnauthorized: false },
});

// ─── Prising-helper ──────────────────────────────────────────────────────

// Anker-land for pris-beregning = Norge (worst-case for de fleste produktene
// pluss vårt hjemmarked). Gelato Adaptive Pricing håndterer FX for kunder.
const ANCHOR_COUNTRY = "NO";
const ANCHOR_CURRENCY = "NOK";

interface LandedCost {
  productPrice: number;
  shippingPrice: number;
  shippingMethod: string;
  shippingType: "normal" | "express" | "pick_up";
  landed: number;
}

async function quoteLanded(
  uid: string,
  qty: number,
  country: string,
  currency: string,
): Promise<LandedCost | null> {
  try {
    const res = await gelato.quoteOrder({
      orderReferenceId: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      currency,
      recipient: {
        firstName: "Seed", lastName: "Test",
        addressLine1: "Testveien 1", city: "Oslo",
        postCode: "0150", country, email: "lasse@styretavla.no",
      },
      products: [{ itemReferenceId: "i1", productUid: uid, quantity: qty }],
    });
    const q = res.quotes[0];
    if (!q) return null;
    const product = q.products.reduce((s, p) => s + p.price, 0);

    // Pris-beregning: bruk billigste tilgjengelige shipping (alle typer).
    // For posters til NO returnerer Gelato kun pickup → vi bruker den verdien
    // for å sette retail. Faktisk shipping ved bestilling kan variere — vi
    // beholder buffer via markup_target_pct.
    // Preferer normal > express > pickup for å oppgi shippingType i log.
    const normals = q.shipmentMethods.filter((m) => m.type === "normal");
    const expresses = q.shipmentMethods.filter((m) => m.type === "express");
    const pickups = q.shipmentMethods.filter((m) => m.type === "pick_up");
    const chosen =
      (normals.length && normals.reduce((a, b) => (a.price < b.price ? a : b))) ||
      (expresses.length && expresses.reduce((a, b) => (a.price < b.price ? a : b))) ||
      (pickups.length && pickups.reduce((a, b) => (a.price < b.price ? a : b))) ||
      null;
    if (!chosen) return null;
    return {
      productPrice: product,
      shippingPrice: chosen.price,
      shippingMethod: chosen.name,
      shippingType: chosen.type,
      landed: product + chosen.price,
    };
  } catch (err) {
    console.error(`  ⚠ Quote feilet for ${uid} qty=${qty}/${country}:`, (err as Error).message.slice(0, 120));
    return null;
  }
}

// Avrund retail til "pene" tall. Valuta-aware fordi EUR har en annen
// størrelsesorden (~tier) enn NOK/SEK/DKK (~hundrer).
//   NOK/SEK/DKK < 500: nærmeste 49 (349, 449, 499)
//   NOK/SEK/DKK 500-999: nærmeste 95 (595, 795, 895)
//   NOK/SEK/DKK 1000+: nærmeste 90 (1290, 1490, 1990)
//   EUR (alle): rund OPP til neste X9 i tier (29, 39, 149, 349)
// Aldri rund NED — vi vil ha margin.
function roundRetail(minor: number, currency: string = "NOK"): number {
  const major = minor / 100;
  if (currency.toUpperCase() === "EUR") {
    let r = Math.ceil((major - 9) / 10) * 10 + 9; // 22→29, 31→39, 145→149
    if (r < major) r += 10;
    return Math.round(r) * 100;
  }
  let rounded: number;
  if (major < 500) rounded = Math.round((major - 49) / 100) * 100 + 49;
  else if (major < 1000) rounded = Math.round((major - 95) / 100) * 100 + 95;
  else rounded = Math.round((major - 90) / 100) * 100 + 90;
  if (rounded < major) rounded += 100;
  return Math.round(rounded) * 100;
}

interface ComputedVariant {
  qty: number;
  gelato_uid: string;
  landed_nok: number;
  retail_minor: number;
  margin_pct: number;
  recommended?: boolean;
  upgrade_label?: string;
}

async function computeVariants(product: ProductDef): Promise<ComputedVariant[]> {
  const out: ComputedVariant[] = [];
  for (const v of product.variants) {
    const uid = v.gelatoUid || product.defaultGelatoUid;
    const cost = await quoteLanded(uid, v.qty, ANCHOR_COUNTRY, ANCHOR_CURRENCY);
    if (!cost) {
      console.log(`  ✗ Hopper over ${product.slug} qty=${v.qty} (ingen quote)`);
      continue;
    }
    const landedMinor = Math.round(cost.landed * 100);
    // Manuell override (for å rette pris-kollisjoner) vinner over formelen.
    // Vakt: aldri under landed-kost (ville gitt negativ margin).
    const computedRetail = roundRetail(Math.round(landedMinor / (1 - product.markupTargetPct / 100)));
    const retailMinor = v.retailMinorOverride && v.retailMinorOverride > landedMinor
      ? v.retailMinorOverride
      : computedRetail;
    if (v.retailMinorOverride && v.retailMinorOverride <= landedMinor) {
      console.log(`  ⚠ ${product.slug} qty=${v.qty}: override ${(v.retailMinorOverride/100).toFixed(0)} ≤ landed ${cost.landed.toFixed(0)} — ignorert, bruker formel`);
    }
    const marginPct = ((retailMinor - landedMinor) / retailMinor) * 100;
    const item: ComputedVariant = {
      qty: v.qty,
      gelato_uid: uid,
      landed_nok: cost.landed,
      retail_minor: retailMinor,
      margin_pct: Math.round(marginPct * 10) / 10,
    };
    if (v.recommended) item.recommended = true;
    if (v.upgradeLabel) item.upgrade_label = v.upgradeLabel;
    out.push(item);
    if (VERBOSE) {
      console.log(
        `    qty=${v.qty.toString().padStart(4)} | landed ${cost.landed.toFixed(2)} (prod ${cost.productPrice.toFixed(0)} + ${cost.shippingType} ${cost.shippingPrice.toFixed(0)}) | retail ${(retailMinor/100).toFixed(0)} kr | margin ${marginPct.toFixed(0)}%`,
      );
    }
  }
  return out;
}

// ─── Multi-valuta prisbok ──────────────────────────────────────────────────
// Hver ekstra-valuta prises nativt: quote Gelato i den valutaen + et
// representativt land i sonen, legg på samme markup, rund pent. Lagres i
// prices_by_currency. NOK ligger fortsatt i qty_variants (uendret).

const EXTRA_CURRENCIES = ["SEK", "DKK", "EUR"] as const;
const CURRENCY_QUOTE_COUNTRY: Record<string, string> = {
  SEK: "SE", DKK: "DK", EUR: "DE", // DE = sentralt euro-land for quoting
};

type CurrencyTiers = Record<string, { retail_minor: number; margin_pct: number }>;

async function computePricesByCurrency(
  product: ProductDef,
): Promise<Record<string, CurrencyTiers>> {
  const out: Record<string, CurrencyTiers> = {};
  for (const cur of EXTRA_CURRENCIES) {
    const country = CURRENCY_QUOTE_COUNTRY[cur];
    const tiers: Array<{ qty: number; retail_minor: number; margin_pct: number }> = [];
    for (const v of product.variants) {
      const uid = v.gelatoUid || product.defaultGelatoUid;
      const cost = await quoteLanded(uid, v.qty, country, cur);
      if (!cost) continue;
      const landedMinor = Math.round(cost.landed * 100);
      const retailMinor = roundRetail(
        Math.round(landedMinor / (1 - product.markupTargetPct / 100)), cur,
      );
      tiers.push({ qty: v.qty, retail_minor: retailMinor, margin_pct: 0 });
      // margin beregnes etter kollisjons-justering nedenfor
      (tiers[tiers.length - 1] as any)._landed = landedMinor;
    }
    if (!tiers.length) continue;
    // Auto-kollisjons-resolver: garanter strengt stigende retail per tier
    // (qty sortert). Hindrer at to nabotrinn runder likt i denne valutaen —
    // samme prinsipp som NOK-overstyringen, men automatisk.
    tiers.sort((a, b) => a.qty - b.qty);
    let prev = 0;
    for (const t of tiers) {
      if (t.retail_minor <= prev) t.retail_minor = roundRetail(prev + 100, cur);
      prev = t.retail_minor;
      const landed = (t as any)._landed as number;
      t.margin_pct = Math.round(((t.retail_minor - landed) / t.retail_minor) * 1000) / 10;
      delete (t as any)._landed;
    }
    out[cur] = Object.fromEntries(
      tiers.map((t) => [String(t.qty), { retail_minor: t.retail_minor, margin_pct: t.margin_pct }]),
    );
    if (VERBOSE || !APPLY) {
      console.log(`    [${cur}] ` + tiers.map((t) => `q${t.qty}=${(t.retail_minor/100).toFixed(0)}(${t.margin_pct}%)`).join(" "));
    }
  }
  return out;
}

// ─── Addon-surcharge-beregning ────────────────────────────────────────────

interface ComputedAddon {
  slug: string;
  label: Record<string, string>;
  description: Record<string, string>;
  surcharge_minor: number;        // per_unit: per pakke/stk · flat: fast
  surcharge_mode: "flat" | "per_unit";
  uid_replace?: { from: string; to: string };
  gelato_uid_override?: string;
  conflictsWith?: string[];
}

/** Bygg modifisert UID fra addon-def. */
function applyAddonToUid(baseUid: string, addon: ProductDef["addons"] extends (infer A)[] ? A : never): string {
  if (addon.gelatoUidOverride) return addon.gelatoUidOverride;
  if (addon.uidReplace) return baseUid.replace(addon.uidReplace.from, addon.uidReplace.to);
  return baseUid;
}

async function computeAddons(product: ProductDef): Promise<ComputedAddon[]> {
  if (!product.addons?.length) return [];
  const out: ComputedAddon[] = [];
  for (const addon of product.addons) {
    let surchargeMinor: number;
    if (addon.surchargeMode === "flat") {
      surchargeMinor = addon.flatSurchargeMinor ?? 0;
    } else {
      // per_unit: quote base vs modifisert UID, diff × markup = retail-tillegg per enhet
      const modifiedUid = applyAddonToUid(product.defaultGelatoUid, addon);
      const baseCost = await quoteLanded(product.defaultGelatoUid, 1, ANCHOR_COUNTRY, ANCHOR_CURRENCY);
      const addonCost = await quoteLanded(modifiedUid, 1, ANCHOR_COUNTRY, ANCHOR_CURRENCY);
      if (!baseCost || !addonCost) {
        console.log(`    ⚠ addon '${addon.slug}': kunne ikke quote — hopper over`);
        continue;
      }
      const wholesaleDiff = Math.max(0, addonCost.productPrice - baseCost.productPrice);
      // Marker opp diffen med samme margin-mål
      const retailDiff = wholesaleDiff / (1 - product.markupTargetPct / 100);
      surchargeMinor = Math.round(retailDiff * 100);
      if (VERBOSE) {
        console.log(`    addon '${addon.slug}': wholesale +${wholesaleDiff.toFixed(2)} → retail +${(surchargeMinor/100).toFixed(0)} kr/enhet`);
      }
    }
    out.push({
      slug: addon.slug,
      label: addon.label,
      description: addon.description,
      surcharge_minor: surchargeMinor,
      surcharge_mode: addon.surchargeMode,
      uid_replace: addon.uidReplace,
      gelato_uid_override: addon.gelatoUidOverride,
      conflictsWith: addon.conflictsWith,
    });
  }
  return out;
}

// ─── Upsert ──────────────────────────────────────────────────────────────

async function upsertCategories(): Promise<void> {
  for (const c of CATEGORIES) {
    if (!APPLY) {
      console.log(`  [dry] kategori ${c.slug}`);
      continue;
    }
    await pool.query(
      `INSERT INTO print_categories
        (slug, format_family, presentation_mode, display_name, display_order, active, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, TRUE, NOW())
       ON CONFLICT (slug) DO UPDATE SET
         format_family = EXCLUDED.format_family,
         presentation_mode = EXCLUDED.presentation_mode,
         display_name = EXCLUDED.display_name,
         display_order = EXCLUDED.display_order,
         updated_at = NOW()`,
      [c.slug, c.formatFamily, c.presentationMode, JSON.stringify(c.displayName), c.displayOrder],
    );
    console.log(`  ✓ kategori ${c.slug}`);
  }
}

async function upsertProduct(
  product: ProductDef,
  variants: ComputedVariant[],
  addonsForDb: ComputedAddon[],
  pricesByCurrency: Record<string, CurrencyTiers>,
): Promise<void> {
  if (!APPLY) {
    console.log(`  [dry] produkt ${product.slug}: ${variants.length} varianter, ${addonsForDb.length} addons, ${Object.keys(pricesByCurrency).length} ekstra-valutaer`);
    for (const v of variants) {
      console.log(`         qty=${v.qty} retail=${(v.retail_minor/100).toFixed(0)} margin=${v.margin_pct}%`);
    }
    for (const a of addonsForDb) {
      console.log(`         addon ${a.slug}: +${(a.surcharge_minor/100).toFixed(0)} kr (${a.surcharge_mode})`);
    }
    return;
  }
  await pool.query(
    `INSERT INTO print_products
      (slug, category_slug, product_type, display_name, width_mm, height_mm,
       default_gelato_uid, qty_variants, express_surcharge_minor, markup_target_pct,
       allowed_countries, related_product_slugs, pdf_renderer, addons,
       pack_size, allow_custom_qty, product_info, metadata, prices_by_currency,
       last_price_refresh_at, active, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6,
             $7, $8::jsonb, $9, $10,
             $11, $12, $13, $14::jsonb,
             $15, $16, $17::jsonb, $18::jsonb, $19::jsonb,
             NOW(), TRUE, NOW())
     ON CONFLICT (slug) DO UPDATE SET
       category_slug = EXCLUDED.category_slug,
       display_name = EXCLUDED.display_name,
       width_mm = EXCLUDED.width_mm,
       height_mm = EXCLUDED.height_mm,
       default_gelato_uid = EXCLUDED.default_gelato_uid,
       qty_variants = EXCLUDED.qty_variants,
       express_surcharge_minor = EXCLUDED.express_surcharge_minor,
       markup_target_pct = EXCLUDED.markup_target_pct,
       allowed_countries = EXCLUDED.allowed_countries,
       related_product_slugs = EXCLUDED.related_product_slugs,
       pdf_renderer = EXCLUDED.pdf_renderer,
       addons = EXCLUDED.addons,
       pack_size = EXCLUDED.pack_size,
       allow_custom_qty = EXCLUDED.allow_custom_qty,
       product_info = EXCLUDED.product_info,
       metadata = EXCLUDED.metadata,
       prices_by_currency = EXCLUDED.prices_by_currency,
       last_price_refresh_at = NOW(),
       updated_at = NOW()`,
    [
      product.slug, product.categorySlug, "qr_template",
      JSON.stringify(product.displayName),
      product.widthMm, product.heightMm,
      product.defaultGelatoUid,
      JSON.stringify(variants),
      product.expressSurchargeMinor, product.markupTargetPct,
      product.allowedCountries || null,
      product.relatedProductSlugs || null,
      product.pdfRenderer || "qr_simple",
      JSON.stringify(addonsForDb),
      product.packSize || 1,
      product.allowCustomQty || false,
      product.productInfo ? JSON.stringify(product.productInfo) : null,
      product.metadata ? JSON.stringify(product.metadata) : null,
      JSON.stringify(pricesByCurrency),
    ],
  );
  console.log(`  ✓ produkt ${product.slug} (${variants.length} varianter, retail ${(variants[0].retail_minor/100).toFixed(0)} – ${(variants.at(-1)!.retail_minor/100).toFixed(0)} kr)`);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  console.log(`\n=== print-katalog seed (${mode}) ===\n`);
  console.log(`Anker-land: ${ANCHOR_COUNTRY} (${ANCHOR_CURRENCY})`);
  console.log(`Produkter: ${ONLY ? `bare ${ONLY}` : `alle ${PRODUCTS.length}`}\n`);

  console.log("Kategorier:");
  await upsertCategories();
  console.log("");

  const targets = ONLY ? PRODUCTS.filter((p) => p.slug === ONLY) : PRODUCTS;
  if (!targets.length) {
    console.error(`Ingen produkter matchet --only=${ONLY}`);
    process.exit(1);
  }

  let totalProducts = 0;
  let totalVariants = 0;
  for (const product of targets) {
    console.log(`\n→ ${product.slug} (${product.widthMm}×${product.heightMm}mm, ${product.variants.length} varianter)`);
    const variants = await computeVariants(product);
    if (variants.length === 0) {
      console.log(`  ✗ Hopper over (ingen gyldige varianter)`);
      continue;
    }
    const addons = await computeAddons(product);
    const pricesByCurrency = await computePricesByCurrency(product);
    await upsertProduct(product, variants, addons, pricesByCurrency);
    totalProducts++;
    totalVariants += variants.length;
  }

  console.log(`\n=== Ferdig ===`);
  console.log(`${totalProducts}/${targets.length} produkter, ${totalVariants} varianter totalt.`);
  if (!APPLY) console.log(`(Dry-run — kjør med --apply for å skrive til DB)`);
  await pool.end();
}

main().catch((err) => {
  console.error("FEIL:", err);
  process.exit(1);
});
