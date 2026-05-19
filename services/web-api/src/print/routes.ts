// Print HTTP routes — registreres fra src/routes.ts.
//
// Endpoints (alle prefixed /api/print):
//   GET  /catalog                 — full produkt + kategori-liste (cached)
//   POST /quote                   — beregn pris + frakt for kurv-konfig
//   POST /checkout                — opprett Stripe Session, returner URL
//   GET  /orders/:orderNumber     — status-side data

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { pool } from "../db";
import { gelatoFromEnv, GelatoError } from "./gelato/client";
import { priceItem, lowestUnitPriceMinor, lowestLineTotalMinor, PricingError } from "./pricing";
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
            pdf_renderer AS "pdfRenderer", addons, metadata,
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
    conflictsWith?: string[];
  }>;
  expressSurchargeMinor: number;
  allowedCountries: string[];
  relatedProductSlugs: string[];
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
          conflictsWith: a.conflictsWith,
        })),
        expressSurchargeMinor: p.expressSurchargeMinor,
        allowedCountries: p.allowedCountries || [],
        relatedProductSlugs: p.relatedProductSlugs || [],
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
});

interface QuoteShippingOption {
  type: "normal" | "express";
  cost: number;                // i NOK-øre over basis (0 = inkludert)
  label: string;
  estimatedDays: { min: number; max: number };
  carrierName: string;
  isFallbackPickup?: boolean;  // true hvis vi måtte falle tilbake på pickup
}

async function handleQuote(req: Request, res: Response) {
  const parsed = QuoteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.format() });
  }
  const { country, items } = parsed.data;

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
    // Bruk en placeholder-mottaker i hovedstad for landet — vi kun bryr oss
    // om shipping-priser/-leveringsdatoer, ikke faktisk levering enda.
    const quote = await gelato.quoteOrder({
      orderReferenceId: `quote-${Date.now()}`,
      currency: "NOK",
      recipient: {
        firstName: "Quote", lastName: "Estimat",
        addressLine1: "Test 1", city: cityForCountry(country),
        postCode: postCodeForCountry(country), country,
        email: "quote@evenero.no",
      },
      products: gelatoProducts,
    });

    const q = quote.quotes[0];
    if (q) {
      const normals = q.shipmentMethods.filter((m) => m.type === "normal");
      const expresses = q.shipmentMethods.filter((m) => m.type === "express");
      const pickups = q.shipmentMethods.filter((m) => m.type === "pick_up");

      if (normals.length || expresses.length) {
        // Vanlig flyt — minst én delivery-metode finnes
        const normal = normals.length ? cheapest(normals) : null;
        const express = expresses.length ? cheapest(expresses) : null;

        if (normal) {
          shippingOptions.push({
            type: "normal",
            cost: 0,                           // basis = gratis
            label: "Hjemlevering",
            estimatedDays: { min: normal.minDeliveryDays, max: normal.maxDeliveryDays },
            carrierName: normal.name,
          });
          if (normal.minDeliveryDate && normal.maxDeliveryDate) {
            estDelivery = { min: normal.minDeliveryDate, max: normal.maxDeliveryDate };
          }
        }
        if (express) {
          const surcharge = normal
            ? Math.max(0, Math.round((express.price - normal.price) * 100))
            : 5000;
          shippingOptions.push({
            type: "express",
            cost: surcharge,
            label: "Express",
            estimatedDays: { min: express.minDeliveryDays, max: express.maxDeliveryDays },
            carrierName: express.name,
          });
          if (!estDelivery && express.minDeliveryDate && express.maxDeliveryDate) {
            estDelivery = { min: express.minDeliveryDate, max: express.maxDeliveryDate };
          }
        }
      } else if (pickups.length) {
        // Kun pickup tilgjengelig (typisk: poster alene til NO)
        // Vi tilbyr pickup som "Hjemlevering"-substitutt og flagger
        // bundle-suggestion til frontend.
        const pickup = cheapest(pickups);
        shippingOptions.push({
          type: "normal",                      // marker som "standard"
          cost: 0,
          label: "Henting på utleveringssted",
          estimatedDays: { min: pickup.minDeliveryDays, max: pickup.maxDeliveryDays },
          carrierName: pickup.name,
          isFallbackPickup: true,
        });
        if (pickup.minDeliveryDate && pickup.maxDeliveryDate) {
          estDelivery = { min: pickup.minDeliveryDate, max: pickup.maxDeliveryDate };
        }
        // Hint til frontend: hvis kurven bare har plakat, foreslå å legge til
        // et kort-produkt for å få ekte hjemlevering.
        const onlyPosters = items.every((it) => {
          const p = productMap.get(it.productSlug);
          return p?.categorySlug.startsWith("poster_");
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
    currency: "nok",                          // Stripe Adaptive Pricing håndterer FX
    shippingOptions,
    estimatedDelivery: estDelivery,
    needsBundleSuggestion,
  });
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

  // Internal: clear cache (kalles fra seed-script via SIGHUP eller restart).
  // Dev-bekvemmelighet — produksjon bruker bare 5min TTL.
  app.post("/api/print/_clear-cache", (_req, res) => {
    clearCatalogCache();
    res.json({ ok: true });
  });
}
