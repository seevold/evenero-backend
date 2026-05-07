import { users, payments, supportRequests, type User, type InsertUser, type Payment, type InsertPayment, type SupportRequest, type InsertSupportRequest } from "@shared/schema";
import { db } from "./db";
import { eq, sql } from "drizzle-orm";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  createPayment(payment: InsertPayment): Promise<Payment>;
  getPaymentByIntentId(paymentIntentId: string): Promise<Payment | undefined>;
  getAllPayments(): Promise<Payment[]>;
  updatePayment(paymentIntentId: string, updates: Partial<InsertPayment>): Promise<Payment | undefined>;
  createSupportRequest(request: InsertSupportRequest): Promise<SupportRequest>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
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

  async getAllPayments(): Promise<Payment[]> {
    const allPayments = await db.select().from(payments);
    return allPayments;
  }

  async updatePayment(paymentIntentId: string, updates: Partial<InsertPayment>): Promise<Payment | undefined> {
    const [updatedPayment] = await db
      .update(payments)
      .set({
        ...updates,
        updatedAt: new Date()
      })
      .where(eq(payments.paymentIntentId, paymentIntentId))
      .returning();
    return updatedPayment || undefined;
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
