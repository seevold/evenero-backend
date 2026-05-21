// Print HTTP routes — registreres fra src/routes.ts.
//
// Endpoints (alle prefixed /api/print):
//   GET  /catalog                 — full produkt + kategori-liste (cached)
//   POST /quote                   — beregn pris + frakt for kurv-konfig
//   POST /checkout                — opprett Stripe Session, returner URL
//   GET  /orders/:orderNumber     — status-side data

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import Stripe from "stripe";
import { pool } from "../db";
import { gelatoFromEnv, GelatoError } from "./gelato/client";
import { priceItem, lowestUnitPriceMinor, lowestLineTotalMinor, PricingError } from "./pricing";
import { generateOrderNumber } from "./order-number";
import { fulfillOrder } from "./fulfillment";
import { uploadPreorderDesign, validateDesignDataUrl } from "./storage";
import type { PrintProduct, PrintCategory, PrintAddon, PrintQtyVariant } from "@shared/schema";

const ALLOWED_COUNTRIES_V1 = [
  "NO","SE","DK","FI","IS",
  "DE","FR","NL","BE","AT","IE","ES","IT","PT","PL","CH",
  "GB","US","CA","AU","NZ",
];

// ─────────────────────────────────────────────────────────────────────────
// DB-helpers
// ─────────────────────────────────────────────────────────────────────────

// Cache produkt + kategori i minne (TTL 5 min).
// Produkt-data endres sjelden (kun ved seed-script), så cache er trygt.
interface CatalogCache {
  fetchedAt: number;
  categories: PrintCategory[];
  products: PrintProduct[];
}
let catalogCache: CatalogCache | null = null;
const CATALOG_TTL_MS = 5 * 60 * 1000;

async function loadCatalog(): Promise<CatalogCache> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }
  const cats = await pool.query(
    `SELECT slug, format_family AS "formatFamily", presentation_mode AS "presentationMode",
            display_name AS "displayName", display_order AS "displayOrder",
            active, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM print_categories WHERE active ORDER BY display_order`,
  );
  const prods = await pool.query(
    `SELECT slug, category_slug AS "categorySlug", product_type AS "productType",
            display_name AS "displayName", width_mm AS "widthMm", height_mm AS "heightMm",
            default_gelato_uid AS "defaultGelatoUid", qty_variants AS "qtyVariants",
            express_surcharge_minor AS "expressSurchargeMinor",
            markup_target_pct AS "markupTargetPct",
            allowed_countries AS "allowedCountries",
            related_product_slugs AS "relatedProductSlugs",
            pdf_renderer AS "pdfRenderer", addons,
            pack_size AS "packSize", allow_custom_qty AS "allowCustomQty",
            product_info AS "productInfo", metadata,
            last_price_refresh_at AS "lastPriceRefreshAt",
            active, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM print_products WHERE active`,
  );
  catalogCache = {
    fetchedAt: Date.now(),
    categories: cats.rows as PrintCategory[],
    products: prods.rows as PrintProduct[],
  };
  return catalogCache;
}

function clearCatalogCache() {
  catalogCache = null;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /catalog — frontend-data for å rendere kategori-tabs + produkter
// ─────────────────────────────────────────────────────────────────────────

interface CatalogResponseCategory {
  slug: string;
  formatFamily: string;
  presentationMode: string;
  displayName: Record<string, string>;
  displayOrder: number;
  /** "fra X kr/stk" eller "fra X kr" — frontend viser uten suffix selv */
  fromPriceMinor: number;
  fromPriceMode: "per_unit" | "total";  // per_unit for qty-mode, total for size-mode
  productCount: number;
  minQty: number;
}

interface CatalogResponseProduct {
  slug: string;
  categorySlug: string;
  displayName: Record<string, string>;
  widthMm: number;
  heightMm: number;
  qtyVariants: Array<{
    qty: number;
    retailMinor: number;
    pricePerUnitMinor: number;
    recommended?: boolean;
    upgradeLabel?: string;
  }>;
  addons: Array<{
    slug: string;
    label: Record<string, string>;
    description: Record<string, string>;
    surchargeMinor: number;
    surchargeMode: "flat" | "per_unit";
    conflictsWith?: string[];
  }>;
  expressSurchargeMinor: number;
  allowedCountries: string[];
  relatedProductSlugs: string[];
  packSize: number;
  allowCustomQty: boolean;
  productInfo: {
    paper?: Record<string, string>;
    sides?: Record<string, string>;
    finishing?: Record<string, string>;
    deliveryDays?: Record<string, string>;
  } | null;
  metadata: Record<string, unknown> | null;
}

function buildCatalogResponse(catalog: CatalogCache, country?: string) {
  const validCountry = country && ALLOWED_COUNTRIES_V1.includes(country) ? country : "NO";

  const products = catalog.products
    .filter((p) => !p.allowedCountries || p.allowedCountries.includes(validCountry))
    .map<CatalogResponseProduct>((p) => {
      const variants = p.qtyVariants as unknown as PrintQtyVariant[];
      return {
        slug: p.slug,
        categorySlug: p.categorySlug,
        displayName: p.displayName as Record<string, string>,
        widthMm: p.widthMm,
        heightMm: p.heightMm,
        qtyVariants: variants.map((v) => ({
          qty: v.qty,
          retailMinor: v.retail_minor,
          pricePerUnitMinor: Math.round(v.retail_minor / v.qty),
          recommended: v.recommended,
          upgradeLabel: v.upgrade_label,
        })),
        addons: (p.addons as PrintAddon[] || []).map((a) => ({
          slug: a.slug,
          label: a.label,
          description: a.description,
          surchargeMinor: a.surcharge_minor,
          surchargeMode: a.surcharge_mode || "flat",
          conflictsWith: a.conflictsWith,
        })),
        expressSurchargeMinor: p.expressSurchargeMinor,
        allowedCountries: p.allowedCountries || [],
        relatedProductSlugs: p.relatedProductSlugs || [],
        packSize: (p as unknown as { packSize: number }).packSize || 1,
        allowCustomQty: (p as unknown as { allowCustomQty: boolean }).allowCustomQty || false,
        productInfo: (p as unknown as { productInfo: CatalogResponseProduct["productInfo"] }).productInfo || null,
        metadata: (p.metadata as Record<string, unknown>) || null,
      };
    });

  const productsByCategory = new Map<string, CatalogResponseProduct[]>();
  for (const p of products) {
    if (!productsByCategory.has(p.categorySlug)) productsByCategory.set(p.categorySlug, []);
    productsByCategory.get(p.categorySlug)!.push(p);
  }

  const categories: CatalogResponseCategory[] = catalog.categories.map((c) => {
    const inCategory = productsByCategory.get(c.slug) || [];
    const flatProducts = inCategory.flatMap((p) =>
      catalog.products.filter((cp) => cp.slug === p.slug),
    );
    const minQty = flatProducts.length
      ? Math.min(...flatProducts.map((p) => (p.qtyVariants as unknown as PrintQtyVariant[])[0]?.qty || 1))
      : 1;
    const fromPriceMode = c.presentationMode === "quantity" ? "per_unit" : "total";
    const fromPriceMinor = flatProducts.length === 0
      ? 0
      : Math.min(...flatProducts.map((p) =>
          fromPriceMode === "per_unit" ? lowestUnitPriceMinor(p) : lowestLineTotalMinor(p),
        ));
    return {
      slug: c.slug,
      formatFamily: c.formatFamily,
      presentationMode: c.presentationMode,
      displayName: c.displayName as Record<string, string>,
      displayOrder: c.displayOrder,
      fromPriceMinor,
      fromPriceMode,
      productCount: inCategory.length,
      minQty,
    };
  });

  return { categories, products, allowedCountries: ALLOWED_COUNTRIES_V1 };
}

// ─────────────────────────────────────────────────────────────────────────
// POST /quote — beregn faktisk pris + frakt for kurv
// ─────────────────────────────────────────────────────────────────────────

const QuoteRequestSchema = z.object({
  country: z.string().length(2),
  items: z.array(z.object({
    productSlug: z.string(),
    qty: z.number().int().positive(),
    addonSlugs: z.array(z.string()).optional(),
  })).min(1),
  // Valgfri: faktisk leveringsadresse → presis frakt-/leverings-quote.
  // Uten disse brukes en placeholder-mottaker i landets hovedstad.
  postalCode: z.string().min(1).max(20).optional(),
  city: z.string().min(1).max(120).optional(),
});

interface QuoteShippingOption {
  uid: string;                 // shipmentMethodUid — unik id kunden velger
  type: "normal" | "express" | "pickup";
  cost: number;                // kundens kostnad i øre (0 = inkludert/gratis)
  gelatoCostMinor: number;     // faktisk Gelato-fraktkost (transparens)
  label: string;
  estimatedDays: { min: number; max: number };
  carrierName: string;
  isFree: boolean;             // cost === 0 (Evenero dekker frakten)
  isFallbackPickup?: boolean;  // true hvis ingen ekte hjemlevering finnes
}

// Frakt-policy: Evenero dekker frakt under terskelen; over den betaler
// kunden den faktiske Gelato-fraktkosten selv. Holdes server-side så
// kunden ikke kan manipulere den.
const FREE_SHIPPING_THRESHOLD_MINOR = 10000;  // 100 kr

async function handleQuote(req: Request, res: Response) {
  const parsed = QuoteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.format() });
  }
  const { country, items, postalCode, city } = parsed.data;

  if (!ALLOWED_COUNTRIES_V1.includes(country)) {
    return res.status(400).json({ error: "COUNTRY_NOT_SUPPORTED", country });
  }

  const catalog = await loadCatalog();
  const productMap = new Map(catalog.products.map((p) => [p.slug, p]));

  // Prising per item
  const pricedItems = [];
  let subtotalMinor = 0;
  const gelatoProducts = [];

  for (const it of items) {
    const product = productMap.get(it.productSlug);
    if (!product) {
      return res.status(400).json({ error: "PRODUCT_NOT_FOUND", slug: it.productSlug });
    }
    if (product.allowedCountries && !product.allowedCountries.includes(country)) {
      return res.status(400).json({
        error: "PRODUCT_NOT_AVAILABLE_IN_COUNTRY",
        slug: it.productSlug, country,
      });
    }
    try {
      const priced = priceItem({ product, qty: it.qty, addonSlugs: it.addonSlugs });
      subtotalMinor += priced.lineTotalMinor;
      pricedItems.push({
        ...priced,
        productDisplayName: product.displayName,
        widthMm: product.widthMm,
        heightMm: product.heightMm,
      });
      gelatoProducts.push({
        itemReferenceId: `${it.productSlug}-${gelatoProducts.length}`,
        productUid: priced.gelatoUid,
        quantity: priced.qty,
      });
    } catch (err) {
      if (err instanceof PricingError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  // Hent frakt fra Gelato
  let shippingOptions: QuoteShippingOption[] = [];
  let estDelivery: { min: string; max: string } | undefined;
  let needsBundleSuggestion = false;

  try {
    const gelato = gelatoFromEnv();
    // Hvis kunden har fylt inn adresse, quote mot DEN — ellers placeholder
    // i landets hovedstad. Frakt/leveringsdager kan variere per postnummer.
    const quote = await gelato.quoteOrder({
      orderReferenceId: `quote-${Date.now()}`,
      currency: "NOK",
      recipient: {
        firstName: "Quote", lastName: "Estimat",
        addressLine1: "Test 1",
        city: city || cityForCountry(country),
        postCode: postalCode || postCodeForCountry(country),
        country,
        email: "quote@evenero.no",
      },
      products: gelatoProducts,
    });

    const q = quote.quotes[0];
    if (q) {
      const methods = q.shipmentMethods;
      const hasRealDelivery = methods.some((m) => m.type === "normal" || m.type === "express");

      // Dedup på shipmentMethodUid (behold billigste ved duplikat)
      const byUid = new Map<string, typeof methods[number]>();
      for (const m of methods) {
        const prev = byUid.get(m.shipmentMethodUid);
        if (!prev || m.price < prev.price) byUid.set(m.shipmentMethodUid, m);
      }
      const sorted = [...byUid.values()].sort((a, b) => a.price - b.price);

      // Hver metode er valgbar. Frakt under terskelen er gratis (Evenero
      // dekker); over terskelen betaler kunden faktisk Gelato-fraktkost.
      for (const m of sorted) {
        const gelatoCostMinor = Math.max(0, Math.round(m.price * 100));
        const cost = gelatoCostMinor < FREE_SHIPPING_THRESHOLD_MINOR ? 0 : gelatoCostMinor;
        const isPickup = m.type === "pick_up";
        shippingOptions.push({
          uid: m.shipmentMethodUid,
          type: isPickup ? "pickup" : m.type,
          cost,
          gelatoCostMinor,
          label: isPickup ? "Henting på utleveringssted"
               : m.type === "express" ? "Ekspress" : "Hjemlevering",
          estimatedDays: { min: m.minDeliveryDays, max: m.maxDeliveryDays },
          carrierName: m.name,
          isFree: cost === 0,
          isFallbackPickup: isPickup && !hasRealDelivery,
        });
      }

      // Leveringsestimat fra den billigste metoden
      const primary = sorted[0];
      if (primary?.minDeliveryDate && primary?.maxDeliveryDate) {
        estDelivery = { min: primary.minDeliveryDate, max: primary.maxDeliveryDate };
      }

      // Kun pickup tilgjengelig (typisk plakat alene til NO) → hint
      // frontend om å legge til et kort-produkt for ekte hjemlevering.
      if (!hasRealDelivery && methods.some((m) => m.type === "pick_up")) {
        const onlyPosters = items.every((it) => {
          const p = productMap.get(it.productSlug);
          return p?.categorySlug === "poster";
        });
        if (onlyPosters) needsBundleSuggestion = true;
      }
    }
  } catch (err) {
    if (err instanceof GelatoError) {
      return res.status(502).json({
        error: "GELATO_QUOTE_FAILED",
        message: err.message,
        gelatoStatus: err.status,
      });
    }
    throw err;
  }

  if (!shippingOptions.length) {
    return res.status(400).json({
      error: "NO_SHIPPING_AVAILABLE",
      message: "Gelato fant ingen leveringsmuligheter for kombinasjonen",
    });
  }

  return res.json({
    items: pricedItems,
    subtotalMinor,
    bundleDiscountMinor: bundleDiscountMinor(pricedItems.length),
    currency: "nok",                          // Stripe Adaptive Pricing håndterer FX
    shippingOptions,
    estimatedDelivery: estDelivery,
    needsBundleSuggestion,
  });
}

/**
 * Pakkerabatt: når kunden bestiller 2+ produkter sendes alt i én forsendelse
 * — vi sparer frakt og gir besparelsen tilbake. Flat 50 kr ved 2+ produkter.
 */
function bundleDiscountMinor(itemCount: number): number {
  return itemCount >= 2 ? 5000 : 0;
}

function cheapest<T extends { price: number }>(arr: T[]): T {
  return arr.reduce((a, b) => (a.price < b.price ? a : b));
}

// Hovedstad/postnr per land — for placeholder-quote.
// Frakt-priser varierer minimalt mellom byer; godt nok for estimat-fasen.
function cityForCountry(c: string): string {
  return ({ NO:"Oslo", SE:"Stockholm", DK:"Copenhagen", FI:"Helsinki", IS:"Reykjavik",
           DE:"Berlin", FR:"Paris", NL:"Amsterdam", BE:"Brussels", AT:"Vienna",
           IE:"Dublin", ES:"Madrid", IT:"Rome", PT:"Lisbon", PL:"Warsaw", CH:"Zurich",
           GB:"London", US:"New York", CA:"Toronto", AU:"Sydney", NZ:"Auckland" } as Record<string,string>)[c] || "City";
}
function postCodeForCountry(c: string): string {
  return ({ NO:"0150", SE:"11122", DK:"1050", FI:"00100", IS:"101",
           DE:"10115", FR:"75001", NL:"1011", BE:"1000", AT:"1010",
           IE:"D01", ES:"28001", IT:"00100", PT:"1000-001", PL:"00-001", CH:"8001",
           GB:"SW1A 1AA", US:"10001", CA:"M5H 2N2", AU:"2000", NZ:"1010" } as Record<string,string>)[c] || "00000";
}

// ─────────────────────────────────────────────────────────────────────────
// POST /checkout — opprett print_order + Stripe Checkout Session
// ─────────────────────────────────────────────────────────────────────────

const CheckoutRequestSchema = z.object({
  country: z.string().length(2),
  customerEmail: z.string().email(),
  items: z.array(z.object({
    productSlug: z.string(),
    qty: z.number().int().positive(),
    addonSlugs: z.array(z.string()).optional(),
    sourceEventId: z.string().optional(),
    sourceTemplateKey: z.string().optional(),
    designChoice: z.enum(["user_design", "minimal_template"]).default("minimal_template"),
    /** URL til ferdig opplastet design (fra /design-upload). Brukes som print-fil. */
    designUrl: z.string().url().optional(),
  })).min(1),
  shipping: z.object({
    name: z.string(),
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    postalCode: z.string(),
    country: z.string().length(2),
    phone: z.string().optional(),
  }),
  /** Valgt frakt-metode (shipmentMethodUid fra /quote). Utelatt → billigste. */
  shipmentMethodUid: z.string().optional(),
  /** Returnerer-URL etter Stripe checkout — frontend setter denne basert
   *  på sin egen routing. */
  returnBaseUrl: z.string().url(),
});

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY mangler");
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

async function handleCheckout(req: Request, res: Response) {
  const parsed = CheckoutRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.format() });
  }
  const body = parsed.data;
  if (!ALLOWED_COUNTRIES_V1.includes(body.country)) {
    return res.status(400).json({ error: "COUNTRY_NOT_SUPPORTED" });
  }

  const catalog = await loadCatalog();
  const productMap = new Map(catalog.products.map((p) => [p.slug, p]));

  // Re-pris alt server-side (kunden kan ha endret priser i devtools)
  const pricedItems = [];
  let subtotalMinor = 0;
  for (const it of body.items) {
    const product = productMap.get(it.productSlug);
    if (!product) {
      return res.status(400).json({ error: "PRODUCT_NOT_FOUND", slug: it.productSlug });
    }
    try {
      const priced = priceItem({ product, qty: it.qty, addonSlugs: it.addonSlugs });
      subtotalMinor += priced.lineTotalMinor;
      pricedItems.push({ priced, source: it, product });
    } catch (err) {
      if (err instanceof PricingError) {
        return res.status(400).json({ error: err.code, message: err.message });
      }
      throw err;
    }
  }

  // Hent shipping live fra Gelato
  let shippingMinor = 0;
  let shippingMethodUid: string | undefined;
  let shippingMethodName: string | undefined;
  try {
    const gelato = gelatoFromEnv();
    const quote = await gelato.quoteOrder({
      orderReferenceId: `checkout-${Date.now()}`,
      currency: "NOK",
      recipient: {
        firstName: body.shipping.name.split(" ")[0] || "Customer",
        lastName: body.shipping.name.split(" ").slice(1).join(" ") || "X",
        addressLine1: body.shipping.line1,
        city: body.shipping.city, postCode: body.shipping.postalCode,
        country: body.shipping.country, email: body.customerEmail,
      },
      products: pricedItems.map((p, i) => ({
        itemReferenceId: `${p.source.productSlug}-${i}`,
        productUid: p.priced.gelatoUid, quantity: p.priced.qty,
      })),
    });
    const q = quote.quotes[0];
    if (!q) {
      return res.status(400).json({ error: "NO_SHIPPING_AVAILABLE" });
    }
    const methods = q.shipmentMethods;
    if (!methods.length) {
      return res.status(400).json({ error: "NO_SHIPPING_AVAILABLE" });
    }
    // Velg metoden kunden valgte; faller tilbake til billigste hvis uid
    // mangler eller ikke finnes i dette (re-quotede) settet.
    const chosen = (body.shipmentMethodUid
      && methods.find((m) => m.shipmentMethodUid === body.shipmentMethodUid))
      || cheapest(methods);
    // Samme frakt-policy som /quote — re-validert server-side.
    const gelatoCostMinor = Math.max(0, Math.round(chosen.price * 100));
    shippingMinor = gelatoCostMinor < FREE_SHIPPING_THRESHOLD_MINOR ? 0 : gelatoCostMinor;
    shippingMethodUid = chosen.shipmentMethodUid;
    shippingMethodName = chosen.name;
  } catch (err) {
    if (err instanceof GelatoError) {
      return res.status(502).json({ error: "GELATO_QUOTE_FAILED", message: err.message });
    }
    throw err;
  }

  const discountMinor = bundleDiscountMinor(pricedItems.length);
  const totalMinor = subtotalMinor + shippingMinor - discountMinor;

  // Opprett print_order-rad. Vi setter gelato_order_reference_id allerede
  // her som idempotency-nøkkel — webhook-trigget fulfillment bruker den.
  const orderNumber = await generateOrderNumber();
  const orderId = randomUUID();
  const gelatoRef = `evenero-${orderNumber}`;
  // Map pricedItem → generert item-ID, brukt for design-upload etter commit
  const itemIds = new Map<typeof pricedItems[number], string>();

  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO print_orders
        (id, order_number, customer_email, status,
         gelato_order_reference_id, total_minor, shipping_minor, currency,
         shipping_address, shipping_method_uid, shipping_method_name)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,'nok',$7::jsonb,$8,$9)`,
      [
        orderId, orderNumber, body.customerEmail, gelatoRef,
        totalMinor, shippingMinor,
        JSON.stringify({
          name: body.shipping.name,
          firstName: body.shipping.name.split(" ")[0],
          lastName: body.shipping.name.split(" ").slice(1).join(" "),
          line1: body.shipping.line1, line2: body.shipping.line2,
          city: body.shipping.city, postCode: body.shipping.postalCode,
          country: body.shipping.country, phone: body.shipping.phone,
        }),
        shippingMethodUid, shippingMethodName,
      ],
    );
    for (const p of pricedItems) {
      const itemId = randomUUID();
      itemIds.set(p, itemId);
      await pool.query(
        `INSERT INTO print_order_items
          (id, order_id, product_slug, gelato_product_uid, gelato_item_reference_id,
           quantity, unit_price_minor, line_total_minor,
           source_event_id, source_template_key, design_choice)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          itemId, orderId, p.priced.productSlug, p.priced.gelatoUid,
          `${p.priced.productSlug}-${itemId.slice(0, 8)}`,
          p.priced.qty, p.priced.unitPriceMinor, p.priced.lineTotalMinor,
          p.source.sourceEventId, p.source.sourceTemplateKey, p.source.designChoice,
        ],
      );
    }
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }

  // Knytt kundens ferdig-opplastede design (fra /design-upload) til hvert
  // user_design-item som print-fil. Designet er allerede validert + lagret
  // ved "Tilpass og bestill" — vi setter bare print_file_url her.
  for (const p of pricedItems) {
    const designUrl = p.source.designUrl;
    if (!designUrl || p.source.designChoice !== "user_design") continue;
    const itemId = itemIds.get(p);
    if (!itemId) continue;
    await pool.query(
      `UPDATE print_order_items SET print_file_url=$1, print_file_generated_at=NOW() WHERE id=$2`,
      [designUrl, itemId],
    );
  }

  // Stripe Checkout Session.
  // Vi setter NOK som currency — Adaptive Pricing (account-level) gjør at
  // kunden ser sin lokale valuta i checkout, men vi får oppgjør i NOK.
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = pricedItems.map((p) => ({
    quantity: 1,  // line_total er allerede for hele qty
    price_data: {
      currency: "nok",
      unit_amount: p.priced.lineTotalMinor,
      product_data: {
        name: `${(p.product.displayName as Record<string,string>)?.no || p.priced.productSlug} (${p.priced.qty} stk)`,
        metadata: { print_product_slug: p.priced.productSlug, qty: String(p.priced.qty) },
      },
    },
  }));
  if (shippingMinor > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "nok",
        unit_amount: shippingMinor,
        product_data: { name: "Express-levering" },
      },
    });
  }
  // Pakkerabatt: Stripe line_items kan ikke være negative, så vi trekker
  // rabatten fra den dyreste linjen (alltid > 50 kr, holder seg positiv).
  if (discountMinor > 0 && lineItems.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < lineItems.length; i++) {
      const cur = lineItems[i].price_data!.unit_amount || 0;
      if (cur > (lineItems[maxIdx].price_data!.unit_amount || 0)) maxIdx = i;
    }
    const pd = lineItems[maxIdx].price_data!;
    pd.unit_amount = Math.max(100, (pd.unit_amount || 0) - discountMinor);
    pd.product_data!.name += " (inkl. pakkerabatt)";
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: lineItems,
    customer_email: body.customerEmail,
    metadata: {
      print_order_id: orderId,
      print_order_number: orderNumber,
      kind: "print_order",
    },
    success_url: `${body.returnBaseUrl}/print/order/${orderNumber}?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${body.returnBaseUrl}/print/checkout?canceled=1`,
  });

  // Lagre stripe_session_id på ordren for senere lookup
  await pool.query(
    `UPDATE print_orders SET stripe_session_id=$1, updated_at=NOW() WHERE id=$2`,
    [session.id, orderId],
  );

  return res.json({
    orderId, orderNumber,
    checkoutUrl: session.url,
    totalMinor,
    currency: "nok",
  });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /design-upload — last opp print-fil ved "Tilpass og bestill"
// ─────────────────────────────────────────────────────────────────────────

const DesignUploadSchema = z.object({
  dataUrl: z.string(),
  format: z.enum(["portrait", "square", "card"]),
  eventId: z.string().optional(),
});

async function handleDesignUpload(req: Request, res: Response) {
  const parsed = DesignUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_REQUEST" });
  }
  const { dataUrl } = parsed.data;

  // Valider FØR opplasting — tomme/ugyldige filer avvises her
  const v = validateDesignDataUrl(dataUrl);
  if (!v.ok) {
    return res.status(400).json({ error: "INVALID_DESIGN", message: v.reason });
  }

  const designToken = randomUUID();
  try {
    const uploaded = await uploadPreorderDesign(designToken, dataUrl);
    return res.json({
      designToken,
      designUrl: uploaded.url,
      bytes: v.widthBytes,
    });
  } catch (err) {
    return res.status(500).json({
      error: "UPLOAD_FAILED",
      message: (err as Error).message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /orders/:orderNumber — status-side data
// ─────────────────────────────────────────────────────────────────────────

async function handleGetOrder(req: Request, res: Response) {
  const orderNumber = req.params.orderNumber;
  const order = await pool.query(
    `SELECT id, order_number, customer_email, status,
            total_minor, shipping_minor, currency,
            shipping_address, shipping_method_name,
            tracking_url, tracking_code, carrier,
            paid_at, submitted_at, shipped_at, delivered_at,
            failure_reason, created_at
     FROM print_orders WHERE order_number=$1`,
    [orderNumber],
  );
  if (!order.rows[0]) return res.status(404).json({ error: "NOT_FOUND" });
  const items = await pool.query(
    `SELECT product_slug, quantity, unit_price_minor, line_total_minor
     FROM print_order_items WHERE order_id=$1
     ORDER BY created_at`,
    [order.rows[0].id],
  );
  return res.json({ ...order.rows[0], items: items.rows });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /webhooks/gelato — status-oppdateringer fra Gelato
// ─────────────────────────────────────────────────────────────────────────

async function handleGelatoWebhook(req: Request, res: Response) {
  // Gelato sender signed payload — vi verifiserer hvis secret er konfigurert.
  // Bevisst designvalg: vi lagrer ALLE events i audit-tabellen, også de
  // som ikke kan parses, så vi har full forensikk hvis noe går galt.
  const sig = req.headers["gelato-signature"] as string | undefined;
  const secret = process.env.GELATO_WEBHOOK_SECRET;
  let signatureValid = true;
  if (secret && sig) {
    // Gelato bruker HMAC-SHA256 av raw body med secret. Implementer ved
    // behov — for nå loggfører vi forsøket. Webhook-verifisering kreves
    // før prod-cutover (TODO i README).
    signatureValid = true;  // placeholder
  } else if (secret && !sig) {
    signatureValid = false;
  }

  const payload = req.body as Record<string, unknown>;
  const eventType = String(payload.event || "unknown");
  const orderRef = payload.orderReferenceId as string | undefined;

  // Lagre event i audit-tabell
  await pool.query(
    `INSERT INTO print_gelato_webhook_events
      (order_reference_id, event_type, payload, signature_valid)
     VALUES ($1,$2,$3::jsonb,$4)`,
    [orderRef || null, eventType, JSON.stringify(payload), signatureValid],
  );

  if (!signatureValid) {
    return res.status(401).json({ error: "INVALID_SIGNATURE" });
  }

  // Mapp event til status-overgang
  // Gelato sender events: order_status_updated, order_item_status_updated, etc.
  // fulfillmentStatus-verdier: 'created', 'printed', 'shipped', 'delivered', 'canceled'
  if (orderRef && payload.fulfillmentStatus) {
    const status = String(payload.fulfillmentStatus);
    const trackingUrl = payload.trackingUrl as string | undefined;
    const trackingCode = payload.trackingCode as string | undefined;
    const carrier = payload.carrierName as string | undefined;

    if (status === "printed" || status === "in_production") {
      await pool.query(
        `UPDATE print_orders SET status='in_production', updated_at=NOW()
         WHERE gelato_order_reference_id=$1 AND status NOT IN ('shipped','delivered')`,
        [orderRef],
      );
    } else if (status === "shipped") {
      await pool.query(
        `UPDATE print_orders
         SET status='shipped', shipped_at=COALESCE(shipped_at, NOW()),
             tracking_url=COALESCE($2, tracking_url),
             tracking_code=COALESCE($3, tracking_code),
             carrier=COALESCE($4, carrier),
             updated_at=NOW()
         WHERE gelato_order_reference_id=$1`,
        [orderRef, trackingUrl, trackingCode, carrier],
      );
      // TODO: trigger "shipped" e-post til kunden
    } else if (status === "delivered") {
      await pool.query(
        `UPDATE print_orders SET status='delivered', delivered_at=NOW(), updated_at=NOW()
         WHERE gelato_order_reference_id=$1`,
        [orderRef],
      );
    } else if (status === "canceled") {
      await pool.query(
        `UPDATE print_orders SET status='cancelled', updated_at=NOW(), failure_reason='Gelato cancelled order'
         WHERE gelato_order_reference_id=$1`,
        [orderRef],
      );
    }
  }

  await pool.query(
    `UPDATE print_gelato_webhook_events SET processed_at=NOW()
     WHERE order_reference_id=$1 AND event_type=$2 AND processed_at IS NULL`,
    [orderRef || null, eventType],
  );

  return res.json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────
// Stripe webhook-hook for print-ordre (kalles fra hoved-routes.ts)
// ─────────────────────────────────────────────────────────────────────────

export async function handlePrintCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const printOrderId = session.metadata?.print_order_id;
  if (!printOrderId) return;

  const orderRes = await pool.query<{ status: string }>(
    `SELECT status FROM print_orders WHERE id=$1`,
    [printOrderId],
  );
  const current = orderRes.rows[0];
  if (!current) {
    console.warn(`[stripe→print] print_order ${printOrderId} ikke funnet`);
    return;
  }
  if (current.status !== "pending") {
    console.log(`[stripe→print] ${printOrderId} status=${current.status}, ignore duplicate webhook`);
    return;
  }

  await pool.query(
    `UPDATE print_orders
     SET status='paid', paid_at=NOW(), stripe_payment_intent_id=$1, updated_at=NOW()
     WHERE id=$2 AND status='pending'`,
    [session.payment_intent as string, printOrderId],
  );

  // Trigger fulfillment async — vi vil ikke blokkere webhook-svaret.
  fulfillOrder(printOrderId).catch((err) => {
    console.error(`[stripe→print] fulfillment feilet for ${printOrderId}:`, err);
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Registrering
// ─────────────────────────────────────────────────────────────────────────

export function registerPrintRoutes(app: Express) {
  app.get("/api/print/catalog", async (req, res, next) => {
    try {
      const country = (req.query.country as string)?.toUpperCase();
      const catalog = await loadCatalog();
      res.json(buildCatalogResponse(catalog, country));
    } catch (e) { next(e); }
  });

  app.post("/api/print/quote", async (req, res, next) => {
    try { await handleQuote(req, res); } catch (e) { next(e); }
  });

  app.post("/api/print/design-upload", async (req, res, next) => {
    try { await handleDesignUpload(req, res); } catch (e) { next(e); }
  });

  app.post("/api/print/checkout", async (req, res, next) => {
    try { await handleCheckout(req, res); } catch (e) { next(e); }
  });

  app.get("/api/print/orders/:orderNumber", async (req, res, next) => {
    try { await handleGetOrder(req, res); } catch (e) { next(e); }
  });

  app.post("/api/webhooks/gelato", async (req, res, next) => {
    try { await handleGelatoWebhook(req, res); } catch (e) { next(e); }
  });

  // Internal: clear cache (kalles fra seed-script via SIGHUP eller restart).
  // Dev-bekvemmelighet — produksjon bruker bare 5min TTL.
  app.post("/api/print/_clear-cache", (_req, res) => {
    clearCatalogCache();
    res.json({ ok: true });
  });
}
