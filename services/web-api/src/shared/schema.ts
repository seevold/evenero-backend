import { pgTable, text, serial, integer, boolean, timestamp, jsonb, uuid, index, uniqueIndex, numeric } from "drizzle-orm/pg-core";
import { z } from "zod";

// users-tabell — matcher main-api sin definisjon (uuid pk, email, event_credit).
// Web-api leser/oppdaterer kun event_credit + finner user via email.
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  event_credit: integer("event_credit").default(0).notNull(),
});

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  paymentIntentId: text("payment_intent_id").notNull().unique(),
  stripeChargeId: text("stripe_charge_id"),
  customerEmail: text("customer_email").notNull(),
  amount: integer("amount").notNull(), // Amount in cents
  currency: text("currency").notNull(),
  status: text("status").notNull(), // succeeded, failed, etc.
  receiptUrl: text("receipt_url"),
  referralId: text("referral_id"),
  couponCode: text("coupon_code"),
  buyerCountry: text("buyer_country"),
  vatAmount: integer("vat_amount").default(0), // VAT amount in cents
  baseAmount: integer("base_amount").notNull(), // Base amount before VAT in cents
  vatRate: text("vat_rate"), // e.g., "25%"
  metadata: jsonb("metadata"), // Additional Stripe metadata
  // Product- og kreditt-sporing — utvidbart via Stripe product-metadata
  productType: text("product_type").notNull().default("event_credit"),
  creditsGranted: integer("credits_granted").notNull().default(1),
  userId: uuid("user_id"),                       // FK -> users(id), set NULL ved sletting
  consumedEventId: uuid("consumed_event_id"),    // FK -> events(id), settes når event opprettes
  refundedAt: timestamp("refunded_at"),
  refundAmount: integer("refund_amount"),
  disputedAt: timestamp("disputed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const supportRequests = pgTable("support_requests", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  category: text("category").notNull(), // billing, technical, account, photos, events, other
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("open"), // open, in_progress, resolved, closed
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});



// ─────────────────────────────────────────────────────────────────────────
// PRINT-ON-DEMAND (Gelato-integrasjon)
// ─────────────────────────────────────────────────────────────────────────

// Kategorier — visitkort, postkort, plakat-2x3, square-kort, plakat-1x1.
// Brukes til tab-navigasjon og presentasjons-modus i UI.
export const printCategories = pgTable("print_categories", {
  slug: text("slug").primaryKey(),                  // 'businesscard', 'postcard_a6', ...
  formatFamily: text("format_family").notNull(),    // '2x3' | '1x1' | 'businesscard'
  presentationMode: text("presentation_mode").notNull(), // 'quantity' | 'size'
  displayName: jsonb("display_name").notNull(),     // {no, en, sv, es}
  displayOrder: integer("display_order").notNull().default(100),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Produkter — én rad per Gelato-SKU eller logisk produkt-variant.
// qty_variants holder pris-tiers + evt. auto-SKU-swap (visitkort 10/50 → ulik SKU).
// last_price_refresh_at brukes av refresh-prices-script for å vite hva som må
// oppdateres ved schedulert kjøring.
export const printProducts = pgTable("print_products", {
  slug: text("slug").primaryKey(),                  // 'businesscard_bc', 'postcard_a6', ...
  categorySlug: text("category_slug").notNull(),    // FK -> print_categories.slug (logisk)
  productType: text("product_type").notNull().default("qr_template"), // 'qr_template' | 'thank_you_card' | 'photo_book'
  displayName: jsonb("display_name").notNull(),     // {no, en, sv, es}
  // Fysisk størrelse — i mm. Brukes til PDF-renderer + frontend-preview.
  widthMm: integer("width_mm").notNull(),
  heightMm: integer("height_mm").notNull(),
  // Default Gelato SKU. Overstyres per qty_variant hvis swap (eks. visitkort).
  defaultGelatoUid: text("default_gelato_uid").notNull(),
  // qty_variants:
  //   [{ qty: 50, gelato_uid: '...', retail_minor: 59500, recommended?: true, upgrade_label?: 'Matt' }]
  // retail er anker-pris i NOK (minor units = øre). Stripe Adaptive Pricing håndterer FX.
  qtyVariants: jsonb("qty_variants").notNull(),
  // Frakt-tillegg for express — fast NOK-øre, dekkes av margin på basis.
  expressSurchargeMinor: integer("express_surcharge_minor").notNull().default(5000),
  // Markup-mål brukt av refresh-prices-script (% over Gelato wholesale).
  markupTargetPct: numeric("markup_target_pct", { precision: 5, scale: 2 }).notNull().default("60"),
  // Land-whitelist — array av ISO-koder. Hvis null/empty: alle whitelistede.
  allowedCountries: text("allowed_countries").array(),
  // Cross-sell: andre produkt-slugs som vises som relaterte.
  relatedProductSlugs: text("related_product_slugs").array(),
  // PDF-renderer — peker til kode-modul. v1: kun 'qr_simple'.
  pdfRenderer: text("pdf_renderer").notNull().default("qr_simple"),
  // Addons — valgfrie oppgraderinger som overstyrer SKU og/eller legger til kost.
  // [{ slug, label_no, label_en, description_no, surcharge_minor, gelato_uid_override? }]
  addons: jsonb("addons").notNull().default([]),
  // packSize > 1 betyr at qty=1 representerer "1 pakke" = packSize fysiske enheter.
  // Eks: postkort A6 med packSize=10 — qty=3 = 30 kort.
  packSize: integer("pack_size").notNull().default(1),
  // allowCustomQty: tillater UI å vise input-felt for custom-antall mellom break-points.
  allowCustomQty: boolean("allow_custom_qty").notNull().default(false),
  // productInfo: { paper, sides, finishing, deliveryDays } — alle som {no,en,sv,es}
  productInfo: jsonb("product_info"),
  // Generelt metadata: { bleed_mm, dpi, paper_thickness_g, ... }
  metadata: jsonb("metadata"),
  lastPriceRefreshAt: timestamp("last_price_refresh_at"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  categoryIdx: index("idx_print_products_category").on(t.categorySlug),
  activeIdx: index("idx_print_products_active").on(t.active),
}));

// Bestillinger.
export const printOrders = pgTable("print_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Klient-referanse for UI (kort, lesbar). Genereres ved opprettelse.
  orderNumber: text("order_number").notNull().unique(), // 'EV-2026-0042'
  userId: uuid("user_id"),                          // FK -> users(id). null = gjest (ikke v1)
  customerEmail: text("customer_email").notNull(),
  // Status-maskin: pending → paid → submitting → submitted → in_production → shipped → delivered
  //               + failed | refunded | cancelled
  status: text("status").notNull().default("pending"),
  // Stripe
  stripeSessionId: text("stripe_session_id").unique(),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  // Gelato
  gelatoOrderId: text("gelato_order_id"),
  gelatoOrderReferenceId: text("gelato_order_reference_id").unique(), // idempotency-nøkkel
  // Penger — alt i kundens valuta (Stripe Adaptive Pricing setter dette).
  totalMinor: integer("total_minor").notNull(),
  shippingMinor: integer("shipping_minor").notNull().default(0),
  taxMinor: integer("tax_minor").notNull().default(0),
  currency: text("currency").notNull(),             // 'nok', 'usd', ...
  // Levering
  shippingAddress: jsonb("shipping_address").notNull(), // full Stripe-address-object
  shippingMethodUid: text("shipping_method_uid"),   // Gelato-method valgt
  shippingMethodName: text("shipping_method_name"), // 'Helthjem hjemlevering'
  trackingUrl: text("tracking_url"),
  trackingCode: text("tracking_code"),
  carrier: text("carrier"),
  // Tidsstempler
  paidAt: timestamp("paid_at"),
  submittedAt: timestamp("submitted_at"),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),
  // Feilhåndtering
  failureReason: text("failure_reason"),
  lasseNotifiedAt: timestamp("lasse_notified_at"),
  submitAttempts: integer("submit_attempts").notNull().default(0),
  // Audit
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  statusIdx: index("idx_print_orders_status").on(t.status),
  emailIdx: index("idx_print_orders_email").on(t.customerEmail),
  createdIdx: index("idx_print_orders_created").on(t.createdAt),
}));

// Order items — én rad per produkt i en ordre.
export const printOrderItems = pgTable("print_order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull().references(() => printOrders.id, { onDelete: "cascade" }),
  productSlug: text("product_slug").notNull(),      // FK -> print_products.slug (logisk)
  gelatoProductUid: text("gelato_product_uid").notNull(),   // konkret SKU brukt
  gelatoItemReferenceId: text("gelato_item_reference_id").notNull(), // idempotency for item
  quantity: integer("quantity").notNull(),
  unitPriceMinor: integer("unit_price_minor").notNull(),
  lineTotalMinor: integer("line_total_minor").notNull(),
  // Knytter tilbake til Evenero-event hvis brukt fra et bestemt QR-template
  sourceEventId: text("source_event_id"),
  sourceTemplateKey: text("source_template_key"),   // 'minimal' | 'bouquet' | ...
  // PDF-input + fil-URL
  designChoice: text("design_choice").notNull(),    // 'user_design' | 'minimal_template'
  printFileUrl: text("print_file_url"),
  printFileGeneratedAt: timestamp("print_file_generated_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  orderIdx: index("idx_print_order_items_order").on(t.orderId),
}));

// Gelato webhook-events — audit log + idempotency. Lagrer alle innkommende
// webhooks for debugging og re-processing. Signature_valid=false-rader
// flagger potensielle angrep eller misconfig.
export const printGelatoWebhookEvents = pgTable("print_gelato_webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderReferenceId: text("order_reference_id"),     // hvis tilstede, kobler til print_orders
  eventType: text("event_type").notNull(),          // 'order_status_updated', 'item_shipped', etc.
  payload: jsonb("payload").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
  processingError: text("processing_error"),
}, (t) => ({
  orderRefIdx: index("idx_print_webhook_order_ref").on(t.orderReferenceId),
  receivedIdx: index("idx_print_webhook_received").on(t.receivedAt),
}));

// Select- og insert-typer for print-tabellene.
// Bruker Drizzle sin $inferSelect/$inferInsert direkte i stedet for drizzle-zod —
// createInsertSchema feiler med "type 'boolean' not assignable to 'never'" på
// kolonner med .default() (kjent drizzle-zod 0.7.x issue). Insert-validering
// gjøres med hånd-skrevne Zod-schemas i print-modulen der det trengs.
export type PrintCategory = typeof printCategories.$inferSelect;
export type InsertPrintCategory = typeof printCategories.$inferInsert;
export type PrintProduct = typeof printProducts.$inferSelect;
export type InsertPrintProduct = typeof printProducts.$inferInsert;
export type PrintOrder = typeof printOrders.$inferSelect;
export type InsertPrintOrder = typeof printOrders.$inferInsert;
export type PrintOrderItem = typeof printOrderItems.$inferSelect;
export type InsertPrintOrderItem = typeof printOrderItems.$inferInsert;
export type PrintGelatoWebhookEvent = typeof printGelatoWebhookEvents.$inferSelect;
export type InsertPrintGelatoWebhookEvent = typeof printGelatoWebhookEvents.$inferInsert;

// qty_variants type — håndhevet i kode (ikke i DB)
export type PrintQtyVariant = {
  qty: number;
  gelato_uid?: string;          // overstyrer print_products.default_gelato_uid hvis satt
  retail_minor: number;         // NOK-øre
  recommended?: boolean;        // vis ⭐-badge
  upgrade_label?: string;       // 'Matt-lamiert' osv.
};

export type PrintAddon = {
  slug: string;                            // 'premium_paper', 'paper_matt', ...
  label: Record<string, string>;
  description: Record<string, string>;
  surcharge_minor: number;                 // NOK-øre. flat: fast · per_unit: per pakke/stk
  surcharge_mode: "flat" | "per_unit";     // hvordan surcharge_minor brukes
  uid_replace?: { from: string; to: string }; // komponerbar UID-modifikasjon
  gelato_uid_override?: string;            // hvis valgt: bytt hele SKU
  conflictsWith?: string[];                // slugs som ikke kan velges sammen
};

// ─────────────────────────────────────────────────────────────────────────

// drizzle-orm 0.39 har to type-bugs som tvinger oss til å hand-rulle insert-typene:
//  1) createInsertSchema(...).omit/pick kollapser hele typen til `never` på tabeller
//     med .default()-kolonner (drizzle-zod 0.7.x bug — også årsaken til at
//     print-tabellene over bruker $inferSelect/$inferInsert direkte).
//  2) $inferInsert ekskluderer .notNull().default()-kolonner HELT fra typen
//     (i stedet for å gjøre dem optional), så updatedAt/createdAt/status osv. blir
//     "unknown property" ved insert. Hand-rullede typer under kompenserer.
//
// Drizzle's interne .values()-signatur lider av samme bug, så storage.ts caster
// gjennom `as any` ved insert/update-calls. Runtime er OK — kolonnene finnes
// i DB-skjemaet og blir satt korrekt.

export type User = typeof users.$inferSelect;
export type InsertUser = {
  email: string;
  name?: string | null;
  event_credit?: number;
};

export type Payment = typeof payments.$inferSelect;
export type InsertPayment = {
  paymentIntentId: string;
  stripeChargeId?: string | null;
  customerEmail: string;
  amount: number;
  currency: string;
  status: string;
  receiptUrl?: string | null;
  referralId?: string | null;
  couponCode?: string | null;
  buyerCountry?: string | null;
  vatAmount?: number | null;
  baseAmount: number;
  vatRate?: string | null;
  metadata?: unknown;
  productType?: string;
  creditsGranted?: number;
  userId?: string | null;
  consumedEventId?: string | null;
  refundedAt?: Date | null;
  refundAmount?: number | null;
  disputedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export type SupportRequest = typeof supportRequests.$inferSelect;
export type InsertSupportRequest = {
  name: string;
  email: string;
  category: string;
  subject: string;
  message: string;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

// insertSupportRequestSchema brukes via .parse() i routes.ts for å validere
// request body på /api/support.
export const insertSupportRequestSchema = z.object({
  name: z.string(),
  email: z.string(),
  category: z.string(),
  subject: z.string(),
  message: z.string(),
});
