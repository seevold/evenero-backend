import { users, payments, supportRequests, type User, type Payment, type InsertPayment, type SupportRequest, type InsertSupportRequest } from "@shared/schema";
import { db } from "./db";
import { eq, sql } from "drizzle-orm";

export interface IStorage {
  // User-lookup for credit-handling (web-api skriver kun users.event_credit, ikke andre kolonner)
  getUserByEmail(email: string): Promise<User | undefined>;
  upsertUserAndCreditByEmail(email: string, creditDelta: number): Promise<User>;

  // Payments — kjernen
  createPayment(payment: InsertPayment): Promise<Payment>;
  getPaymentByIntentId(paymentIntentId: string): Promise<Payment | undefined>;
  getPaymentByChargeId(stripeChargeId: string): Promise<Payment | undefined>;
  getAllPayments(): Promise<Payment[]>;
  updatePaymentByIntentId(paymentIntentId: string, updates: Partial<InsertPayment>): Promise<Payment | undefined>;
  markPaymentRefunded(stripeChargeId: string, refundAmountCents: number): Promise<Payment | undefined>;
  markPaymentDisputed(stripeChargeId: string, disputedAt: Date | null): Promise<Payment | undefined>;

  // Support
  createSupportRequest(request: InsertSupportRequest): Promise<SupportRequest>;
}

export class DatabaseStorage implements IStorage {
  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  /**
   * Atomisk: opprett user hvis hen ikke finnes, ellers oppdater event_credit.
   * creditDelta kan være positiv (kjøp) eller negativ (refund).
   * Returnerer endelig user-rad.
   */
  async upsertUserAndCreditByEmail(email: string, creditDelta: number): Promise<User> {
    // Drizzle har ikke direkte ON CONFLICT med inkrement — bruker raw SQL.
    // users.id er uuid med default gen_random_uuid() via Drizzle defaultRandom (main-api eier).
    // Vi setter EXCLUDED-felter til å bevare eksisterende verdier.
    const result = await db.execute<User>(sql`
      INSERT INTO users (id, email, event_credit, active, created_at)
      VALUES (gen_random_uuid(), ${email}, GREATEST(${creditDelta}, 0), true, now())
      ON CONFLICT (email) DO UPDATE
        SET event_credit = COALESCE(users.event_credit, 0) + ${creditDelta}
      RETURNING id, email, name, event_credit
    `);
    // Drizzle's execute returnerer raden direkte avhengig av driver; håndter begge formene
    const rows = (result as any).rows ?? result;
    return rows[0] as User;
  }

  async createPayment(payment: InsertPayment): Promise<Payment> {
    const [createdPayment] = await db
      .insert(payments)
      .values({
        ...payment,
        updatedAt: new Date()
      })
      .returning();
    return createdPayment;
  }

  async getPaymentByIntentId(paymentIntentId: string): Promise<Payment | undefined> {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.paymentIntentId, paymentIntentId));
    return payment || undefined;
  }

  async getPaymentByChargeId(stripeChargeId: string): Promise<Payment | undefined> {
    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.stripeChargeId, stripeChargeId));
    return payment || undefined;
  }

  async getAllPayments(): Promise<Payment[]> {
    return await db.select().from(payments);
  }

  async updatePaymentByIntentId(paymentIntentId: string, updates: Partial<InsertPayment>): Promise<Payment | undefined> {
    const [updated] = await db
      .update(payments)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(payments.paymentIntentId, paymentIntentId))
      .returning();
    return updated || undefined;
  }

  async markPaymentRefunded(stripeChargeId: string, refundAmountCents: number): Promise<Payment | undefined> {
    const [updated] = await db
      .update(payments)
      .set({
        refundedAt: new Date(),
        refundAmount: refundAmountCents,
        updatedAt: new Date()
      })
      .where(eq(payments.stripeChargeId, stripeChargeId))
      .returning();
    return updated || undefined;
  }

  async markPaymentDisputed(stripeChargeId: string, disputedAt: Date | null): Promise<Payment | undefined> {
    const [updated] = await db
      .update(payments)
      .set({ disputedAt, updatedAt: new Date() })
      .where(eq(payments.stripeChargeId, stripeChargeId))
      .returning();
    return updated || undefined;
  }

  async createSupportRequest(request: InsertSupportRequest): Promise<SupportRequest> {
    const [createdRequest] = await db
      .insert(supportRequests)
      .values({
        ...request,
        status: "open",
        updatedAt: new Date()
      })
      .returning();
    return createdRequest;
  }
}

export const storage = new DatabaseStorage();
