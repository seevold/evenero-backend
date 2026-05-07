import { pgTable, uuid, varchar, boolean, timestamp, integer, bigint, text, date, index, uniqueIndex, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Supported locales - keep in sync with shared/i18n/config.ts
export const SUPPORTED_LOCALES = ['en', 'nb', 'sv', 'es'] as const;
export type SupportedLocale = typeof SUPPORTED_LOCALES[number];
export const DEFAULT_LOCALE: SupportedLocale = 'en';

// Users table - matching Google Cloud SQL exactly
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  active: boolean("active").default(true).notNull(),
  name: varchar("name", { length: 100 }),
  email: varchar("email", { length: 255 }).notNull().unique(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  last_login: timestamp("last_login"),
  pin_code: varchar("pin_code", { length: 6 }),
  pin_expiry: timestamp("pin_expiry"),
  role: varchar("role", { length: 10 }).default("user"),
  jwt_session_token: varchar("jwt_session_token", { length: 2048 }),
  event_credit: integer("event_credit").default(0),
  preferred_locale: varchar("preferred_locale", { length: 10 })
}, (table) => ({
  emailIdx: index("idx_email").on(table.email),
}));

// Events table - matching Google Cloud SQL exactly
export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  event_id: varchar("event_id", { length: 255 }).notNull().unique(),
  event_custom_id: varchar("event_custom_id", { length: 100 }).unique(),
  event_name: varchar("event_name", { length: 255 }),
  event_description: text("event_description"),
  event_photo: varchar("event_photo", { length: 255 }),
  cover_position: integer("cover_position").default(0),
  active: boolean("active").default(true),
  upload_requires_auth: boolean("upload_requires_auth").default(false),
  image_moderation: boolean("image_moderation").default(false),
  event_date: date("event_date"),
  event_location: varchar("event_location", { length: 255 }),
  event_type: varchar("event_type", { length: 255 }),
  event_owner: varchar("event_owner", { length: 255 }),
  event_co_host: varchar("event_co_host", { length: 255 }),
  event_access_type: varchar("event_access_type", { length: 10 }),
  event_start_date: date("event_start_date"),
  event_expiry_date: date("event_expiry_date"),
  created_at: timestamp("created_at").defaultNow(),
  event_secret: varchar("event_secret", { length: 255 }),
  // Storage limits in GB (default 150GB each, nullable total overrides individual limits)
  image_storage_limit_gb: integer("image_storage_limit_gb").default(150),
  video_storage_limit_gb: integer("video_storage_limit_gb").default(150),
  total_storage_limit_gb: integer("total_storage_limit_gb"),
  // Upload control - manually disable uploads
  uploads_disabled: boolean("uploads_disabled").default(false),
  // Reminders control - enable/disable reminder feature for event
  reminders_enabled: boolean("reminders_enabled").default(true),
  // Cover photo focus position (0-1, where 0.5 is center)
  cover_focus_x: real("cover_focus_x").default(0.5),
  cover_focus_y: real("cover_focus_y").default(0.5),
  // Curated gallery - when enabled, public visitors only see liked images
  curated_public_enabled: boolean("curated_public_enabled").default(false),
  // QR Code Generator settings - stored as JSON
  // Run this SQL manually in Google Cloud SQL:
  // ALTER TABLE events ADD COLUMN IF NOT EXISTS qr_settings TEXT;
  qr_settings: text("qr_settings")
}, (table) => ({
  eventIdIdx: index("idx_event_id").on(table.event_id),
  eventOwnerIdx: index("idx_event_owner").on(table.event_owner)
}));

// Moderation status enum values
export const MODERATION_STATUS = ['pending', 'approved', 'rejected'] as const;
export type ModerationStatus = typeof MODERATION_STATUS[number];

// Event images table - matching Google Cloud SQL exactly
export const event_images = pgTable("event_images", {
  id: uuid("id").defaultRandom().primaryKey(),
  event_id: varchar("event_id", { length: 255 }),
  batch_id: varchar("batch_id", { length: 255 }),
  image_url: varchar("image_url", { length: 255 }).notNull(),
  share_consent: boolean("share_consent").default(false),
  sequence: integer("sequence"),
  title: varchar("title", { length: 255 }),
  uploaded_at: timestamp("uploaded_at").defaultNow(),
  archived: boolean("archived").default(false),
  archived_at: timestamp("archived_at"),
  uploaded_by: varchar("uploaded_by", { length: 255 }),
  file_size: bigint("file_size", { mode: "number" }),
  file_extension: varchar("file_extension", { length: 10 }),
  // Moderation fields
  moderation_status: varchar("moderation_status", { length: 20 }).default("approved"), // 'pending', 'approved', 'rejected'
  moderated_at: timestamp("moderated_at"),
  moderated_by: varchar("moderated_by", { length: 255 }),
  // Like tracking - denormalized count for fast queries
  like_count: integer("like_count").default(0)
}, (table) => ({
  eventIdIdx: index("idx_event_images_event_id").on(table.event_id),
  moderationIdx: index("idx_event_images_moderation").on(table.moderation_status)
}));

// Event image likes table - tracks who liked which images
export const event_image_likes = pgTable("event_image_likes", {
  id: uuid("id").defaultRandom().primaryKey(),
  event_id: varchar("event_id", { length: 255 }).notNull(),
  image_id: uuid("image_id").notNull(),
  user_email: varchar("user_email", { length: 255 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull()
}, (table) => ({
  uniqueLikeIdx: uniqueIndex("idx_unique_image_like").on(table.image_id, table.user_email),
  eventIdIdx: index("idx_image_likes_event_id").on(table.event_id),
  imageIdIdx: index("idx_image_likes_image_id").on(table.image_id)
}));

// Event reminders table - for post-event notifications
export const event_reminders = pgTable("event_reminders", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  event_id: varchar("event_id", { length: 255 }).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  scheduled_for: timestamp("scheduled_for").notNull(),
  reminder_sent: boolean("reminder_sent").default(false).notNull(),
  reminder_sent_at: timestamp("reminder_sent_at"),
  locale: varchar("locale", { length: 10 }).default("en")
});

// Feature requests / Bug reports table
export const feature_requests = pgTable("feature_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: varchar("type", { length: 20 }).notNull(), // 'feature' or 'bug'
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description").notNull(),
  email: varchar("email", { length: 255 }),
  status: varchar("status", { length: 20 }).default("new").notNull(), // 'new', 'reviewed', 'planned', 'completed', 'declined'
  created_at: timestamp("created_at").defaultNow().notNull()
}, (table) => ({
  statusIdx: index("idx_feature_request_status").on(table.status),
  createdAtIdx: index("idx_feature_request_created").on(table.created_at)
}));

// QR template downloads - tracks downloads of QR card templates
export const qr_template_downloads = pgTable("qr_template_downloads", {
  id: uuid("id").defaultRandom().primaryKey(),
  event_id: varchar("event_id", { length: 255 }).notNull(),
  template_name: varchar("template_name", { length: 50 }).notNull(), // 'elegant', 'modern', 'romantic-wedding', etc.
  downloaded_at: timestamp("downloaded_at").defaultNow().notNull(),
  downloaded_by: varchar("downloaded_by", { length: 255 }) // email if authenticated
}, (table) => ({
  eventIdIdx: index("idx_qr_downloads_event_id").on(table.event_id),
  templateIdx: index("idx_qr_downloads_template").on(table.template_name)
}));

// Event guest participants - tracks users who have participated in events as guests
export const event_guest_participants = pgTable("event_guest_participants", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  event_id: varchar("event_id", { length: 255 }).notNull(),
  first_participated_at: timestamp("first_participated_at").defaultNow().notNull(),
  last_participated_at: timestamp("last_participated_at").defaultNow().notNull(),
  source: varchar("source", { length: 20 }).default("upload").notNull(), // 'upload', 'reminder', 'both'
  upload_count: integer("upload_count").default(0).notNull()
}, (table) => ({
  emailEventIdx: uniqueIndex("idx_guest_email_event").on(table.email, table.event_id),
  emailIdx: index("idx_guest_email").on(table.email)
}));

// Insert schemas
export const insertUserSchema = createInsertSchema(users).omit({ 
  id: true, 
  created_at: true 
});

export const insertEventSchema = createInsertSchema(events).omit({ 
  id: true, 
  created_at: true 
});

export const insertEventImageSchema = createInsertSchema(event_images).omit({ 
  id: true,
  uploaded_at: true 
});

export const insertEventReminderSchema = createInsertSchema(event_reminders).omit({ 
  id: true,
  created_at: true,
  reminder_sent: true,
  reminder_sent_at: true
}).extend({
  scheduled_for: z.date().or(z.string().transform(s => new Date(s)))
});

export const insertEventGuestParticipantSchema = createInsertSchema(event_guest_participants).omit({ 
  id: true,
  first_participated_at: true,
  last_participated_at: true
});

export const insertEventImageLikeSchema = createInsertSchema(event_image_likes).omit({ 
  id: true,
  created_at: true
});

export const insertQrTemplateDownloadSchema = createInsertSchema(qr_template_downloads).omit({ 
  id: true,
  downloaded_at: true
});

export const insertFeatureRequestSchema = createInsertSchema(feature_requests).omit({ 
  id: true,
  created_at: true,
  status: true
}).extend({
  type: z.enum(['feature', 'bug']),
  title: z.string().min(3).max(255),
  description: z.string().min(10).max(2000),
  email: z.string().email().optional().or(z.literal(''))
});

// Select types
export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;

export type Event = typeof events.$inferSelect;
export type InsertEvent = z.infer<typeof insertEventSchema>;

export type EventImage = typeof event_images.$inferSelect;
export type InsertEventImage = z.infer<typeof insertEventImageSchema>;

export type EventReminder = typeof event_reminders.$inferSelect;
export type InsertEventReminder = z.infer<typeof insertEventReminderSchema>;

export type EventGuestParticipant = typeof event_guest_participants.$inferSelect;
export type InsertEventGuestParticipant = z.infer<typeof insertEventGuestParticipantSchema>;

export type EventImageLike = typeof event_image_likes.$inferSelect;
export type InsertEventImageLike = z.infer<typeof insertEventImageLikeSchema>;

export type QrTemplateDownload = typeof qr_template_downloads.$inferSelect;
export type InsertQrTemplateDownload = z.infer<typeof insertQrTemplateDownloadSchema>;

export type FeatureRequest = typeof feature_requests.$inferSelect;
export type InsertFeatureRequest = z.infer<typeof insertFeatureRequestSchema>;

// Legacy compatibility types for frontend (will refactor later)
export type Media = {
  id: string;
  event_id: string;
  batch_id: string | null;
  image_url: string;
  share_consent: boolean | null;
  sequence: number | null;
  title: string | null;
  uploaded_at: string | null;
  archived: boolean | null;
  uploaded_by: string | null;
  like_count?: number | null;
  user_liked?: boolean;
};

// Authentication schemas - keep for compatibility
export const sendPinSchema = z.object({
  email: z.string().email(),
});

export const verifyPinSchema = z.object({
  email: z.string().email(),
  pin_code: z.string().length(6),
});

export const authResponseSchema = z.object({
  token: z.string(),
  email: z.string().email(),
  name: z.string().optional(),
  message: z.string()
});

export type SendPinRequest = z.infer<typeof sendPinSchema>;
export type VerifyPinRequest = z.infer<typeof verifyPinSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;