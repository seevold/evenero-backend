import { pgTable, text, serial, integer, boolean, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
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



export const insertUserSchema = createInsertSchema(users).pick({
  email: true,
  name: true,
});

export const insertPaymentSchema = createInsertSchema(payments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertSupportRequestSchema = createInsertSchema(supportRequests).omit({
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof payments.$inferSelect;
export type InsertSupportRequest = z.infer<typeof insertSupportRequestSchema>;
export type SupportRequest = typeof supportRequests.$inferSelect;
