// Print HTTP routes — registreres fra src/routes.ts.
//
// Endpoints (alle prefixed /api/print):
//   GET  /catalog                 — full produkt + kategori-liste (cached)
//   POST /quote                   — beregn pris + frakt for kurv-konfig
//   POST /checkout                — opprett Stripe Session, returner URL
//   GET  /orders/:orderNumber     — status-side data

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import Stripe from "stripe";
import { pool } from "../db";
import { gelatoFromEnv, GelatoError } from "./gelato/client";
import { priceItem, lowestUnitPriceMinor, PricingError } from "./pricing";
import { generateOrderNumber } from "./order-number";
import { fulfillOrder, refreshShipmentsFromGelato, syncOrderFromGelato } from "./fulfillment";
import { sendPrintOrderConfirmation, sendPrintOrderShipped } from "./email";
import { formatOrderLineLabel } from "./format";
import { verifySuperuser, getAuthedEmail } from "./admin-auth";
import { getPrintSettings, updatePrintSettings } from "./settings";
import { currencyForCountry, isAnchorCurrency } from "./currency";
import { uploadPreorderDesign, validateDesignDataUrl } from "./storage";
import { createSessionWithVippsFallback } from "../stripe-vipps";
import type { PrintProduct, PrintCategory, PrintAddon, PrintQtyVariant, PrintPricesByCurrency } from "@shared/schema";

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
            prices_by_currency AS "pricesByCurrency",
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
  // Resolve valuta fra land. NOK leser qty_variants; andre valutaer leser
  // prices_by_currency (med NOK-fallback hvis ikke seedet for produktet ennå).
  const currency = currencyForCountry(validCountry);
  const retailFor = (p: PrintProduct, v: PrintQtyVariant): number => {
    if (isAnchorCurrency(currency)) return v.retail_minor;
    const pbc = (p as unknown as { pricesByCurrency?: PrintPricesByCurrency }).pricesByCurrency || {};
    return pbc[currency]?.[String(v.qty)]?.retail_minor ?? v.retail_minor;
  };

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
        qtyVariants: variants.map((v) => {
          const retail = retailFor(p, v);
          return {
            qty: v.qty,
            retailMinor: retail,
            pricePerUnitMinor: Math.round(retail / v.qty),
            recommended: v.recommended,
            upgradeLabel: v.upgrade_label,
          };
        }),
        // Addons er NOK-only i fase 1 (surcharges ikke priset per valuta).
        // For andre valutaer skjuler vi dem så kunden ikke kan velge en
        // upgrade vi ikke kan prise riktig.
        addons: isAnchorCurrency(currency)
          ? (p.addons as PrintAddon[] || []).map((a) => ({
              slug: a.slug,
              label: a.label,
              description: a.description,
              surchargeMinor: a.surcharge_minor,
              surchargeMode: a.surcharge_mode || "flat",
              conflictsWith: a.conflictsWith,
            }))
          : [],
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
    // "fra X kr/stk" — alltid laveste pris-per-enhet, så plakat vises
    // konsistent med kort (ikke 1-stk-totalprisen, som er dyrest per enhet).
    const fromPriceMode = "per_unit" as const;
    // Laveste pris-per-enhet i resolved valuta (NOK via lowestUnitPriceMinor,
    // ellers fra prices_by_currency).
    const lowestUnitFor = (p: PrintProduct): number => {
      if (isAnchorCurrency(currency)) return lowestUnitPriceMinor(p);
      const packSize = (p as unknown as { packSize?: number }).packSize || 1;
      const variants = p.qtyVariants as unknown as PrintQtyVariant[];
      return Math.min(...variants.map((v) => Math.round(retailFor(p, v) / (v.qty * packSize))));
    };
    const fromPriceMinor = flatProducts.length === 0
      ? 0
      : Math.min(...flatProducts.map((p) => lowestUnitFor(p)));
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

  return { categories, products, allowedCountries: ALLOWED_COUNTRIES_V1, currency };
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

// Frakt-policy: den billigste leveringsmåten er alltid gratis (Evenero
// dekker den). Vi tilbyr maks to alternativer — billigste (inkludert) +
// evt. én raskere oppgradering der kunden betaler pris-differansen.
async function handleQuote(req: Request, res: Response) {
  const parsed = QuoteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.format() });
  }
  const { country, items, postalCode, city } = parsed.data;

  if (!ALLOWED_COUNTRIES_V1.includes(country)) {
    return res.status(400).json({ error: "COUNTRY_NOT_SUPPORTED", country });
  }

  // Runtime-gate: tjeneste av, eller land ikke aktivert i admin.
  const settings = await getPrintSettings();
  if (!settings.serviceEnabled) {
    return res.status(503).json({ error: "SERVICE_DISABLED" });
  }
  if (!settings.enabledCountries.includes(country)) {
    return res.status(400).json({ error: "COUNTRY_NOT_ENABLED", country });
  }

  const catalog = await loadCatalog();
  const productMap = new Map(catalog.products.map((p) => [p.slug, p]));
  const currency = currencyForCountry(country);

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
      const priced = priceItem({ product, qty: it.qty, addonSlugs: it.addonSlugs, currency });
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
      currency,
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

      const toOption = (m: typeof methods[number], cost: number) => {
        const isPickup = m.type === "pick_up";
        return {
          uid: m.shipmentMethodUid,
          type: (isPickup ? "pickup" : m.type) as "normal" | "express" | "pickup",
          cost,
          gelatoCostMinor: Math.max(0, Math.round(m.price * 100)),
          label: isPickup ? "Henting på utleveringssted"
               : m.type === "express" ? "Ekspress" : "Hjemlevering",
          estimatedDays: { min: m.minDeliveryDays, max: m.maxDeliveryDays },
          carrierName: m.name,
          isFree: cost === 0,
          isFallbackPickup: isPickup && !hasRealDelivery,
        };
      };

      if (sorted.length) {
        // Alternativ 1: billigste metode — alltid gratis (Evenero dekker den).
        const cheapestM = sorted[0];
        shippingOptions.push(toOption(cheapestM, 0));

        // Alternativ 2 (valgfritt): den rimeligste metoden som er reelt
        // raskere enn den billigste. Kunden betaler pris-differansen.
        const upgrade = sorted
          .slice(1)
          .filter((m) => m.maxDeliveryDays < cheapestM.maxDeliveryDays)
          .sort((a, b) => a.price - b.price)[0];
        if (upgrade) {
          const deltaMinor = Math.max(0, Math.round((upgrade.price - cheapestM.price) * 100));
          shippingOptions.push(toOption(upgrade, deltaMinor));
        }

        if (cheapestM.minDeliveryDate && cheapestM.maxDeliveryDate) {
          estDelivery = { min: cheapestM.minDeliveryDate, max: cheapestM.maxDeliveryDate };
        }
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
      message: "Fant ingen leveringsmuligheter for denne kombinasjonen",
    });
  }

  return res.json({
    items: pricedItems,
    subtotalMinor,
    bundleDiscountMinor: bundleDiscountMinor(pricedItems.length, subtotalMinor),
    currency: currency.toLowerCase(),         // resolved valuta (nok/sek/dkk/eur)
    shippingOptions,
    estimatedDelivery: estDelivery,
    needsBundleSuggestion,
  });
}

/**
 * Pakkerabatt: når kunden bestiller 2+ produkter sendes alt i én forsendelse
 * — vi sparer frakt og gir besparelsen tilbake. 10 % avslag ved 2+ produkter.
 */
const BUNDLE_DISCOUNT_RATE = 0.10;
function bundleDiscountMinor(itemCount: number, subtotalMinor: number): number {
  return itemCount >= 2 ? Math.round(subtotalMinor * BUNDLE_DISCOUNT_RATE) : 0;
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
  /** Språk for ordrebekreftelse-e-post (en/nb/sv/es). Utelatt → en. */
  locale: z.string().max(8).optional(),
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

  // Runtime-gate (hard sikkerhet — her opprettes Stripe-session + senere
  // Gelato-ordre). Avvis hvis tjenesten er av eller landet ikke er aktivert.
  const settings = await getPrintSettings();
  if (!settings.serviceEnabled) {
    return res.status(503).json({ error: "SERVICE_DISABLED" });
  }
  if (!settings.enabledCountries.includes(body.country)) {
    return res.status(400).json({ error: "COUNTRY_NOT_ENABLED", country: body.country });
  }

  const catalog = await loadCatalog();
  const productMap = new Map(catalog.products.map((p) => [p.slug, p]));
  // Resolve valuta fra land — samme regel som catalog/quote → vist pris ==
  // belastet pris. Brukes for prising, Gelato-quote og Stripe-linjer.
  const currency = currencyForCountry(body.country);
  const stripeCurrency = currency.toLowerCase();

  // Re-pris alt server-side (kunden kan ha endret priser i devtools)
  const pricedItems = [];
  let subtotalMinor = 0;
  for (const it of body.items) {
    const product = productMap.get(it.productSlug);
    if (!product) {
      return res.status(400).json({ error: "PRODUCT_NOT_FOUND", slug: it.productSlug });
    }
    try {
      const priced = priceItem({ product, qty: it.qty, addonSlugs: it.addonSlugs, currency });
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
      currency,
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
    const cheapestM = cheapest(methods);
    const chosen = (body.shipmentMethodUid
      && methods.find((m) => m.shipmentMethodUid === body.shipmentMethodUid))
      || cheapestM;
    // Frakt-policy (re-validert server-side): den billigste metoden er
    // gratis; en raskere oppgradering koster pris-differansen.
    shippingMinor = chosen.shipmentMethodUid === cheapestM.shipmentMethodUid
      ? 0
      : Math.max(0, Math.round((chosen.price - cheapestM.price) * 100));
    shippingMethodUid = chosen.shipmentMethodUid;
    shippingMethodName = chosen.name;
  } catch (err) {
    if (err instanceof GelatoError) {
      return res.status(502).json({ error: "GELATO_QUOTE_FAILED", message: err.message });
    }
    throw err;
  }

  const discountMinor = bundleDiscountMinor(pricedItems.length, subtotalMinor);
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
         shipping_address, shipping_method_uid, shipping_method_name,
         locale, app_base_url)
       VALUES ($1,$2,$3,'pending',$4,$5,$6,$12,$7::jsonb,$8,$9,$10,$11)`,
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
        body.locale || "en",
        body.returnBaseUrl.replace(/\/$/, ""),
        stripeCurrency,
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
  // Stripe Checkout-line-navnet ER det kunden ser i checkout-skjermen OG på
  // Stripes egen betalingskvittering — så vi formaterer det med totalt antall
  // stk (qty × packSize) for å unngå tvetydigheten "× 3" (pakker eller stk?).
  const checkoutLocale = body.locale || "en";
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = pricedItems.map((p) => ({
    quantity: 1,  // line_total er allerede for hele qty
    price_data: {
      currency: stripeCurrency,
      unit_amount: p.priced.lineTotalMinor,
      product_data: {
        name: formatOrderLineLabel({
          displayName: p.product.displayName as Record<string, string>,
          packSize: (p.product as unknown as { packSize: number }).packSize || 1,
          qty: p.priced.qty,
          locale: checkoutLocale,
          fallback: p.priced.productSlug,
        }),
        metadata: { print_product_slug: p.priced.productSlug, qty: String(p.priced.qty) },
      },
    },
  }));
  if (shippingMinor > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: stripeCurrency,
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

  const cancelEventId = body.items.find((it) => it.sourceEventId)?.sourceEventId;
  const stripe = getStripe();
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: lineItems,
    // Lar kunden taste en rabattkode i Stripe Checkout. Koder forvaltes
    // i Stripe (Coupons + Promotion codes) — en 100 %-kode gir 0 å betale
    // og lar oss kjøre en ekte ordre helt gjennom uten betaling.
    allow_promotion_codes: true,
    customer_email: body.customerEmail,
    metadata: {
      print_order_id: orderId,
      print_order_number: orderNumber,
      kind: "print_order",
      // For ordrebekreftelse-e-posten (sendes fra webhook-handleren).
      locale: body.locale || "en",
      app_base_url: body.returnBaseUrl,
    },
    success_url: `${body.returnBaseUrl}/print/order/${orderNumber}?session={CHECKOUT_SESSION_ID}`,
    // Avbrutt checkout → tilbake til mal-/bestillingssiden for eventet.
    cancel_url: cancelEventId
      ? `${body.returnBaseUrl}/manage/${cancelEventId}/templates`
      : `${body.returnBaseUrl}/`,
  };
  // Vipps for norske kunder (NOK-only hos Stripe, preview med fallback).
  // Line-items er allerede i NOK når landet er NO — ingen valuta-lås trengs.
  const session = stripeCurrency === "nok"
    ? await createSessionWithVippsFallback(stripe, sessionParams, {
        paymentMethodTypes: ["card", "vipps"],
      })
    : await stripe.checkout.sessions.create(sessionParams);

  // Lagre stripe_session_id på ordren for senere lookup
  await pool.query(
    `UPDATE print_orders SET stripe_session_id=$1, updated_at=NOW() WHERE id=$2`,
    [session.id, orderId],
  );

  return res.json({
    orderId, orderNumber,
    checkoutUrl: session.url,
    totalMinor,
    currency: stripeCurrency,
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
// Autorisering for kunde-vendt ordre-status.
//
// Ordrenummeret (EV-ÅÅÅÅ-NNNN) er sekvensielt og gjettbart, så det kan IKKE
// fungere som tilgangsnøkkel. Status-siden er innlogget (ProtectedRoute), så vi
// krever JWT og sjekker at den innloggede brukeren faktisk eier ordren:
//   1) ordren er sendt til brukerens egen (verifiserte) innloggings-e-post, ELLER
//   2) brukeren eier/co-hoster et event som ordrens items stammer fra.
// source_event_id == events.event_id (string-IDen). Vi matcher også events.id
// (uuid) defensivt i tilfelle eldre data lagret uuid-en. deleted_at filtreres
// IKKE bort — eierskap til en ordre opphører ikke om eventet soft-slettes.
async function userCanViewOrder(
  email: string,
  orderId: string,
  customerEmail: string | null,
): Promise<boolean> {
  const lower = email.toLowerCase();
  if (customerEmail && customerEmail.toLowerCase() === lower) return true;

  const ev = await pool.query<{ event_owner: string | null; event_co_host: string | null }>(
    `SELECT DISTINCT e.event_owner, e.event_co_host
       FROM print_order_items oi
       JOIN events e
         ON e.event_id = oi.source_event_id OR e.id::text = oi.source_event_id
      WHERE oi.order_id = $1`,
    [orderId],
  );
  for (const r of ev.rows) {
    if (r.event_owner && r.event_owner.toLowerCase() === lower) return true;
    if (r.event_co_host) {
      const cohosts = r.event_co_host.split(",").map((s) => s.trim().toLowerCase());
      if (cohosts.includes(lower)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// GET /orders/:orderNumber — status-side data (innlogget kunde)
// ─────────────────────────────────────────────────────────────────────────

async function handleGetOrder(req: Request, res: Response) {
  const orderNumber = req.params.orderNumber;
  const email = await getAuthedEmail(req);
  if (!email) return res.status(401).json({ error: "UNAUTHORIZED" });
  const order = await pool.query(
    `SELECT id, order_number, customer_email, status,
            total_minor, shipping_minor, currency,
            shipping_address, shipping_method_name,
            tracking_url, tracking_code, carrier,
            shipments,
            paid_at, submitted_at, shipped_at, delivered_at,
            failure_reason, created_at
     FROM print_orders WHERE order_number=$1`,
    [orderNumber],
  );
  if (!order.rows[0]) return res.status(404).json({ error: "NOT_FOUND" });
  if (!(await userCanViewOrder(email, order.rows[0].id, order.rows[0].customer_email))) {
    // Samme 404 som "finnes ikke" — så et gjettbart ordrenr ikke kan brukes til
    // å bekrefte at en ordre eksisterer (ingen enumererings-orakkel).
    return res.status(404).json({ error: "NOT_FOUND" });
  }
  const items = await pool.query(
    `SELECT oi.product_slug, oi.quantity, oi.unit_price_minor, oi.line_total_minor,
            p.display_name AS "displayName",
            COALESCE(p.pack_size, 1) AS "packSize"
     FROM print_order_items oi
     LEFT JOIN print_products p ON p.slug = oi.product_slug
     WHERE oi.order_id=$1
     ORDER BY oi.created_at`,
    [order.rows[0].id],
  );
  return res.json({ ...order.rows[0], items: items.rows });
}

// ─────────────────────────────────────────────────────────────────────────
// GET /orders/by-event/:eventId — innlogget eier/co-host av eventet.
// Returnerer ikke-sensitive ordre-sammendrag (ingen e-post/adresse). eventId
// er gjettbart (bruker-valgt streng), så vi krever JWT + at brukeren
// eier/co-hoster eventet — ellers kunne hvem som helst liste et events ordrer.
// ─────────────────────────────────────────────────────────────────────────

async function handleGetOrdersByEvent(req: Request, res: Response) {
  const eventId = req.params.eventId;
  if (!eventId) return res.status(400).json({ error: "MISSING_EVENT_ID" });
  const email = await getAuthedEmail(req);
  if (!email) return res.status(401).json({ error: "UNAUTHORIZED" });

  const lower = email.toLowerCase();
  const ev = await pool.query<{ event_owner: string | null; event_co_host: string | null }>(
    `SELECT event_owner, event_co_host FROM events WHERE event_id = $1 OR id::text = $1`,
    [eventId],
  );
  const canAccess = ev.rows.some((r) => {
    if (r.event_owner && r.event_owner.toLowerCase() === lower) return true;
    if (r.event_co_host) {
      return r.event_co_host.split(",").map((s) => s.trim().toLowerCase()).includes(lower);
    }
    return false;
  });
  if (!canAccess) return res.status(403).json({ error: "FORBIDDEN" });

  const rows = await pool.query(
    `SELECT DISTINCT o.order_number, o.status, o.total_minor, o.created_at,
            (SELECT COUNT(*)::int FROM print_order_items WHERE order_id = o.id) AS item_count
     FROM print_orders o
     JOIN print_order_items oi ON oi.order_id = o.id
     WHERE oi.source_event_id = $1
       AND o.status NOT IN ('pending')
     ORDER BY o.created_at DESC
     LIMIT 25`,
    [eventId],
  );
  return res.json({ orders: rows.rows });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /webhooks/gelato — status-oppdateringer fra Gelato
// ─────────────────────────────────────────────────────────────────────────

/** Konstant-tids strengsammenligning (HMAC-er begge → ingen lengde-lekkasje). */
function safeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHmac("sha256", "evenero-webhook-cmp").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

async function handleGelatoWebhook(req: Request, res: Response) {
  // Gelato signerer ikke webhooks med HMAC — endepunktet sikres med et
  // hemmelig token i webhook-URL-en (?token=… eller X-Webhook-Token-header).
  // Token settes i Gelato-dashboardet OG i GELATO_WEBHOOK_SECRET env-var.
  // Bevisst designvalg: vi lagrer ALLE events i audit-tabellen, også avviste,
  // så vi har full forensikk hvis noe går galt.
  const secret = process.env.GELATO_WEBHOOK_SECRET;
  const provided =
    (typeof req.query.token === "string" ? req.query.token : "") ||
    (req.headers["x-webhook-token"] as string | undefined) || "";
  let signatureValid = true;
  if (secret) {
    signatureValid = safeEqual(provided, secret);
  } else {
    console.warn("[gelato-webhook] GELATO_WEBHOOK_SECRET ikke satt — godtar uten verifisering");
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
      // Idempotency: vi sender shipped-mailen KUN første gang shipped_at
      // settes. RETURNING-flagget gir oss det atomisk.
      const shippedRes = await pool.query<{
        id: string;
        order_number: string;
        customer_email: string;
        locale: string;
        app_base_url: string;
        mail_should_send: boolean;
      }>(
        `WITH prev AS (
           SELECT id, shipped_at IS NULL AS was_unshipped
           FROM print_orders WHERE gelato_order_reference_id=$1
         )
         UPDATE print_orders po
         SET status='shipped', shipped_at=COALESCE(shipped_at, NOW()), updated_at=NOW()
         FROM prev
         WHERE po.id = prev.id
         RETURNING po.id, po.order_number, po.customer_email, po.locale,
                   po.app_base_url, prev.was_unshipped AS mail_should_send`,
        [orderRef],
      );
      const row = shippedRes.rows[0];
      if (row?.mail_should_send) {
        // Hent FULLE shipment-data fra Gelato API (webhook-payload har ikke
        // tracking-info — den ligger i shipment.packages[] på order-detail).
        // Lagrer på print_orders.shipments + speiler første pakke til de
        // gamle tracking_*-feltene for bakoverkompatibilitet.
        const appBase = (row.app_base_url || "").replace(/\/$/, "");
        const statusUrl = appBase ? `${appBase}/print/order/${row.order_number}` : "";
        refreshShipmentsFromGelato(row.id).then(({ shipments }) => {
          return sendPrintOrderShipped({
            orderNumber: row.order_number,
            customerEmail: row.customer_email,
            locale: row.locale || "en",
            shipments,
            statusUrl,
          });
        }).catch((err) => {
          console.error(`[gelato-webhook] shipped-mail feilet for ${row.order_number}:`, err);
        });
      }
    } else if (status === "delivered") {
      await pool.query(
        `UPDATE print_orders SET status='delivered', delivered_at=NOW(), updated_at=NOW()
         WHERE gelato_order_reference_id=$1`,
        [orderRef],
      );
    } else if (status === "canceled") {
      await pool.query(
        `UPDATE print_orders SET status='cancelled', updated_at=NOW(), failure_reason='Bestillingen ble kansellert hos trykkeriet'
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

  // Ordrebekreftelse-e-post — best-effort, blokkerer ikke fulfillment.
  // (Stripe sender egen betalingskvittering; dette er ordredetaljene.)
  try {
    await sendPrintOrderConfirmationFor(printOrderId, session);
  } catch (err) {
    console.error(`[stripe→print] ordrebekreftelse feilet for ${printOrderId}:`, err);
  }

  // Trigger fulfillment async — vi vil ikke blokkere webhook-svaret.
  fulfillOrder(printOrderId).catch((err) => {
    console.error(`[stripe→print] fulfillment feilet for ${printOrderId}:`, err);
  });
}

/** Henter ordre + linjer og sender ordrebekreftelse-e-post. */
async function sendPrintOrderConfirmationFor(
  printOrderId: string,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const o = await pool.query(
    `SELECT order_number, customer_email, shipping_address
     FROM print_orders WHERE id=$1`,
    [printOrderId],
  );
  const row = o.rows[0];
  if (!row) return;

  // Ordrelinjer m/ pack_size så vi kan vise totalt antall stk.
  // Priser hentes ikke — bekreftelse-mailen har ingen beløp; Stripe sender
  // egen detaljert kvittering med betalingsinfo.
  const its = await pool.query(
    `SELECT oi.quantity, oi.product_slug,
            p.display_name AS "displayName",
            COALESCE(p.pack_size, 1) AS "packSize"
     FROM print_order_items oi
     LEFT JOIN print_products p ON p.slug = oi.product_slug
     WHERE oi.order_id=$1 ORDER BY oi.created_at`,
    [printOrderId],
  );

  const locale = session.metadata?.locale || "en";
  const appBase = (session.metadata?.app_base_url || "").replace(/\/$/, "");
  const addr = (row.shipping_address || {}) as Record<string, string>;

  await sendPrintOrderConfirmation({
    orderNumber: row.order_number,
    customerEmail: row.customer_email,
    locale,
    items: its.rows.map((r) => ({
      // Ferdig-formattert etikett, ikke bare navnet: "Flyer A6 — 30 stk (3 pakker à 10)"
      label: formatOrderLineLabel({
        displayName: r.displayName,
        packSize: r.packSize,
        qty: r.quantity,
        locale,
        fallback: r.product_slug,
      }),
    })),
    shipping: {
      name: addr.name || "",
      line1: addr.line1 || "",
      line2: addr.line2 || undefined,
      postalCode: addr.postCode || addr.postalCode || "",
      city: addr.city || "",
      country: addr.country || "",
    },
    statusUrl: appBase ? `${appBase}/print/order/${row.order_number}` : "",
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Registrering
// ─────────────────────────────────────────────────────────────────────────

export function registerPrintRoutes(app: Express) {
  app.get("/api/print/catalog", async (req, res, next) => {
    try {
      const country = (req.query.country as string)?.toUpperCase();
      const [catalog, settings] = await Promise.all([loadCatalog(), getPrintSettings()]);
      const base = buildCatalogResponse(catalog, country);
      // Filtrer tilgjengelige land til snittet av systemets støttede liste og
      // de admin har aktivert. Inkluder serviceEnabled så frontend kan vise
      // "midlertidig utilgjengelig" når tjenesten er av.
      const enabled = new Set(settings.enabledCountries);
      res.json({
        ...base,
        allowedCountries: base.allowedCountries.filter((c) => enabled.has(c)),
        serviceEnabled: settings.serviceEnabled,
      });
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

  app.get("/api/print/orders/by-event/:eventId", async (req, res, next) => {
    try { await handleGetOrdersByEvent(req, res); } catch (e) { next(e); }
  });

  app.get("/api/print/orders/:orderNumber", async (req, res, next) => {
    try { await handleGetOrder(req, res); } catch (e) { next(e); }
  });

  app.post("/api/webhooks/gelato", async (req, res, next) => {
    try { await handleGelatoWebhook(req, res); } catch (e) { next(e); }
  });

  // Admin: re-sync ikke-leverte ordrer mot Gelato. Cloud Scheduler kaller
  // dette hver 30 min som self-healing-fallback i tilfelle webhooks dropper.
  // Auth: bearer-token (ADMIN_API_TOKEN). Returnerer JSON med oppsummering.
  app.post("/api/print/admin/refresh-pending", async (req, res, next) => {
    try {
      const expected = process.env.ADMIN_API_TOKEN;
      if (!expected) {
        return res.status(503).json({ error: "ADMIN_API_TOKEN_NOT_CONFIGURED" });
      }
      const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (provided !== expected) {
        return res.status(401).json({ error: "UNAUTHORIZED" });
      }

      // Skann ordrer som kan ha hengt seg fast — paid (ikke submitted enda),
      // submitted (ikke i produksjon enda), in_production (ikke shipped enda).
      // 30-dager-vindu hindrer at vi spammer Gelato med calls på gamle dødsordrer.
      const orders = await pool.query<{ id: string; order_number: string; status: string }>(
        `SELECT id, order_number, status
         FROM print_orders
         WHERE status IN ('paid', 'submitted', 'in_production')
           AND gelato_order_id IS NOT NULL
           AND created_at > NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC
         LIMIT 100`,
      );

      const results: Array<{ orderNumber: string; before: string; after: string; mailSent: boolean }> = [];
      const errors: Array<{ orderNumber: string; error: string }> = [];

      for (const o of orders.rows) {
        try {
          const r = await syncOrderFromGelato(o.id);
          if (r.statusChanged || r.newPackageIds.length > 0 || r.shippedMailSent) {
            results.push({
              orderNumber: o.order_number,
              before: o.status,
              after: r.newStatus,
              mailSent: r.shippedMailSent,
            });
          }
        } catch (err) {
          errors.push({ orderNumber: o.order_number, error: (err as Error).message });
        }
      }

      console.log(`[admin/refresh-pending] scanned=${orders.rows.length} changed=${results.length} errors=${errors.length}`);
      res.json({
        scanned: orders.rows.length,
        changed: results.length,
        results,
        errors,
      });
    } catch (e) { next(e); }
  });

  // ─── Admin (superuser) — drift av print-ordrer ────────────────────────
  // JWT-verifisert mot delt users-tabell. admin.tsx kaller disse fra
  // Print-fanen med Bearer <evenero_token>.

  // Liste over ordrer med filter. Returnerer ikke-sensitivt sammendrag.
  app.get("/api/print/admin/orders", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });

      const status = typeof req.query.status === "string" ? req.query.status : "";
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));

      const where: string[] = [];
      const params: unknown[] = [];
      if (status && status !== "all") {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      if (search) {
        params.push(`%${search}%`);
        where.push(`(order_number ILIKE $${params.length} OR customer_email ILIKE $${params.length})`);
      }
      params.push(limit);
      const rows = await pool.query(
        `SELECT id, order_number, customer_email, status,
                total_minor, currency, gelato_order_id,
                jsonb_array_length(shipments) AS package_count,
                failure_reason, submit_attempts,
                created_at, paid_at, submitted_at, shipped_at, delivered_at
         FROM print_orders
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY created_at DESC
         LIMIT $${params.length}`,
        params,
      );

      // Status-bøtter for filter-tellere (alltid hele tabellen, ikke filtrert).
      const counts = await pool.query<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM print_orders GROUP BY status`,
      );
      res.json({
        orders: rows.rows,
        counts: Object.fromEntries(counts.rows.map((c) => [c.status, parseInt(c.n, 10)])),
      });
    } catch (e) { next(e); }
  });

  // Full detalj for én ordre — items, adresse, pakker, webhook-historikk.
  app.get("/api/print/admin/orders/:orderNumber", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });

      const ord = await pool.query(
        `SELECT * FROM print_orders WHERE order_number = $1`,
        [req.params.orderNumber],
      );
      const order = ord.rows[0];
      if (!order) return res.status(404).json({ error: "NOT_FOUND" });

      const items = await pool.query(
        `SELECT oi.product_slug, oi.gelato_product_uid, oi.quantity,
                oi.unit_price_minor, oi.line_total_minor, oi.design_choice,
                oi.print_file_url, p.display_name AS "displayName",
                COALESCE(p.pack_size, 1) AS "packSize"
         FROM print_order_items oi
         LEFT JOIN print_products p ON p.slug = oi.product_slug
         WHERE oi.order_id = $1 ORDER BY oi.created_at`,
        [order.id],
      );
      const events = await pool.query(
        `SELECT event_type, signature_valid, received_at, processed_at,
                payload->>'fulfillmentStatus' AS fulfillment_status
         FROM print_gelato_webhook_events
         WHERE order_reference_id = $1
         ORDER BY received_at DESC LIMIT 30`,
        [order.gelato_order_reference_id],
      );
      res.json({ order, items: items.rows, webhookEvents: events.rows });
    } catch (e) { next(e); }
  });

  // Retry fulfillment — kjør fulfillOrder på nytt (idempotent på gelato_order_id).
  // For ordrer som henger i 'paid' eller 'failed'.
  app.post("/api/print/admin/orders/:orderNumber/retry", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });

      const r = await pool.query<{ id: string; status: string; submit_attempts: number }>(
        `SELECT id, status, submit_attempts FROM print_orders WHERE order_number = $1`,
        [req.params.orderNumber],
      );
      const row = r.rows[0];
      if (!row) return res.status(404).json({ error: "NOT_FOUND" });
      if (!["paid", "failed", "submitting"].includes(row.status)) {
        return res.status(409).json({ error: "NOT_RETRYABLE", status: row.status });
      }
      // Nullstill attempt-teller ved manuell retry så MAX_ATTEMPTS-taket
      // ikke blokkerer — admin overstyrer bevisst.
      await pool.query(
        `UPDATE print_orders SET submit_attempts = 0, failure_reason = NULL,
           status = 'paid', updated_at = NOW()
         WHERE id = $1 AND status != 'submitted'`,
        [row.id],
      );
      console.log(`[print-admin] ${auth.email} retry fulfillment for ${req.params.orderNumber}`);
      const result = await fulfillOrder(row.id);
      res.json({ ok: result.ok, gelatoOrderId: result.gelatoOrderId, reason: result.reason });
    } catch (e) { next(e); }
  });

  // Re-sync status + tracking fra Gelato (uten å lage ny ordre).
  app.post("/api/print/admin/orders/:orderNumber/resync", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });

      const r = await pool.query<{ id: string }>(
        `SELECT id FROM print_orders WHERE order_number = $1`,
        [req.params.orderNumber],
      );
      if (!r.rows[0]) return res.status(404).json({ error: "NOT_FOUND" });
      console.log(`[print-admin] ${auth.email} resync ${req.params.orderNumber}`);
      const result = await syncOrderFromGelato(r.rows[0].id);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Settings: les gjeldende konfig + systemets fulle land-liste (så admin-UI
  // kan vise alle togglbare land, ikke bare de aktiverte).
  app.get("/api/print/admin/settings", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });
      const settings = await getPrintSettings();
      res.json({ ...settings, supportedCountries: ALLOWED_COUNTRIES_V1 });
    } catch (e) { next(e); }
  });

  // Settings: oppdater service av/på og/eller aktiverte land.
  app.put("/api/print/admin/settings", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });
      const body = (req.body || {}) as { serviceEnabled?: boolean; enabledCountries?: string[] };
      // Valider at land er innenfor systemets støttede liste — kan ikke
      // aktivere et land vi ikke har SKU-mapping for.
      if (Array.isArray(body.enabledCountries)) {
        const invalid = body.enabledCountries
          .map((c) => String(c).toUpperCase())
          .filter((c) => !ALLOWED_COUNTRIES_V1.includes(c));
        if (invalid.length) {
          return res.status(400).json({ error: "UNSUPPORTED_COUNTRIES", invalid });
        }
      }
      const updated = await updatePrintSettings(
        { serviceEnabled: body.serviceEnabled, enabledCountries: body.enabledCountries },
        auth.email || "unknown",
      );
      console.log(`[print-admin] ${auth.email} oppdaterte settings: enabled=${updated.serviceEnabled} land=${updated.enabledCountries.length}`);
      res.json({ ...updated, supportedCountries: ALLOWED_COUNTRIES_V1 });
    } catch (e) { next(e); }
  });

  // Pris-oversikt: produkter + qty-varianter med retail + margin (read-only).
  app.get("/api/print/admin/products", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });
      const rows = await pool.query(
        `SELECT slug, category_slug AS "categorySlug",
                display_name AS "displayName",
                width_mm AS "widthMm", height_mm AS "heightMm",
                markup_target_pct AS "markupTargetPct",
                COALESCE(pack_size, 1) AS "packSize",
                qty_variants AS "qtyVariants",
                allowed_countries AS "allowedCountries",
                active, last_price_refresh_at AS "lastPriceRefreshAt"
         FROM print_products ORDER BY category_slug, width_mm * height_mm`,
      );
      res.json({ products: rows.rows });
    } catch (e) { next(e); }
  });

  // Stats: aggregert innsikt fra eksisterende ordre-data (read-only).
  // Alt utledet fra print_orders + print_order_items — ingen ny sporing.
  app.get("/api/print/admin/stats", async (req, res, next) => {
    try {
      const auth = await verifySuperuser(req);
      if (!auth.ok) return res.status(auth.status).json({ error: "FORBIDDEN" });

      // "Betalt+"-statuser = ordrer som faktisk konverterte (ekskluder
      // pending/cancelled fra produkt-/omsetnings-stats).
      const PAID = `('paid','submitting','submitted','in_production','shipped','delivered')`;

      const [funnel, abandon, revenue, products, qtyDist, design, countries] = await Promise.all([
        // Status-trakt
        pool.query(`SELECT status, COUNT(*)::int AS n FROM print_orders GROUP BY status`),
        // Frafall: pending (nådde betaling, fullførte ikke) vs konvertert.
        // pending >24t = Stripe-session utløpt = sikkert forlatt.
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status='pending')::int AS pending,
            COUNT(*) FILTER (WHERE status='pending' AND created_at < NOW() - INTERVAL '24 hours')::int AS abandoned,
            COUNT(*) FILTER (WHERE status NOT IN ('pending','cancelled'))::int AS converted
          FROM print_orders`),
        // Omsetning (betalt+)
        pool.query(`SELECT COALESCE(SUM(total_minor),0)::int AS revenue_minor, COUNT(*)::int AS n
                    FROM print_orders WHERE status IN ${PAID}`),
        // Produkt-popularitet
        pool.query(`
          SELECT oi.product_slug,
                 COUNT(*)::int AS line_count,
                 SUM(oi.quantity)::int AS total_qty,
                 SUM(oi.line_total_minor)::int AS revenue_minor
          FROM print_order_items oi JOIN print_orders o ON o.id = oi.order_id
          WHERE o.status IN ${PAID}
          GROUP BY oi.product_slug ORDER BY line_count DESC`),
        // Antall-tier-fordeling per produkt
        pool.query(`
          SELECT oi.product_slug, oi.quantity, COUNT(*)::int AS n
          FROM print_order_items oi JOIN print_orders o ON o.id = oi.order_id
          WHERE o.status IN ${PAID}
          GROUP BY oi.product_slug, oi.quantity ORDER BY oi.product_slug, oi.quantity`),
        // Egen design vs mal
        pool.query(`
          SELECT oi.design_choice, COUNT(*)::int AS n
          FROM print_order_items oi JOIN print_orders o ON o.id = oi.order_id
          WHERE o.status IN ${PAID}
          GROUP BY oi.design_choice`),
        // Land-fordeling
        pool.query(`
          SELECT shipping_address->>'country' AS country, COUNT(*)::int AS n
          FROM print_orders WHERE status IN ${PAID}
          GROUP BY 1 ORDER BY n DESC`),
      ]);

      res.json({
        funnel: Object.fromEntries(funnel.rows.map((r) => [r.status, r.n])),
        abandonment: abandon.rows[0],
        revenue: revenue.rows[0],
        products: products.rows,
        qtyDistribution: qtyDist.rows,
        designChoice: Object.fromEntries(design.rows.map((r) => [r.design_choice, r.n])),
        countries: countries.rows,
      });
    } catch (e) { next(e); }
  });

  // Internal: clear cache (kalles fra seed-script via SIGHUP eller restart).
  // Dev-bekvemmelighet — produksjon bruker bare 5min TTL.
  app.post("/api/print/_clear-cache", (_req, res) => {
    clearCatalogCache();
    res.json({ ok: true });
  });
}
