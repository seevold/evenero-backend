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

// Avrund retail til "pene" tall:
//   < 500 NOK: nærmeste 49 (eks 349, 449, 499)
//   500-999:   nærmeste 95 (eks 595, 795, 895)
//   1000+:     nærmeste 90 (eks 1290, 1490, 1990)
function roundRetail(minor: number): number {
  const kr = minor / 100;
  let rounded: number;
  if (kr < 500) rounded = Math.round((kr - 49) / 100) * 100 + 49;
  else if (kr < 1000) rounded = Math.round((kr - 95) / 100) * 100 + 95;
  else rounded = Math.round((kr - 90) / 100) * 100 + 90;
  if (rounded < kr) rounded += 100; // aldri rund NED — vi vil ha margin
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
    const retailMinor = roundRetail(Math.round(landedMinor / (1 - product.markupTargetPct / 100)));
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

async function upsertProduct(product: ProductDef, variants: ComputedVariant[]): Promise<void> {
  if (!APPLY) {
    console.log(`  [dry] produkt ${product.slug}: ${variants.length} varianter`);
    for (const v of variants) {
      console.log(`         qty=${v.qty} retail=${(v.retail_minor/100).toFixed(0)} margin=${v.margin_pct}%`);
    }
    return;
  }
  await pool.query(
    `INSERT INTO print_products
      (slug, category_slug, product_type, display_name, width_mm, height_mm,
       default_gelato_uid, qty_variants, express_surcharge_minor, markup_target_pct,
       allowed_countries, related_product_slugs, pdf_renderer, metadata,
       last_price_refresh_at, active, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6,
             $7, $8::jsonb, $9, $10,
             $11, $12, $13, $14::jsonb,
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
       metadata = EXCLUDED.metadata,
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
      product.metadata ? JSON.stringify(product.metadata) : null,
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
    await upsertProduct(product, variants);
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
