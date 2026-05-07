import { pgTable, text, serial, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
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
  username: true,
  password: true,
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
