import { db } from "./db";
import { pool } from "./db";
import { users, events, event_images, event_reminders, event_guest_participants, feature_requests, event_image_likes, qr_template_downloads } from "@shared/schema";
import { eq, and, or, sql, desc, isNull, lte, inArray } from "drizzle-orm";
import type { User, InsertUser, Event, InsertEvent, EventImage, InsertEventImage, EventReminder, InsertEventReminder, EventGuestParticipant, InsertEventGuestParticipant, FeatureRequest, InsertFeatureRequest, EventImageLike, InsertEventImageLike, QrTemplateDownload, InsertQrTemplateDownload } from "@shared/schema";
import { randomUUID } from "crypto";

// Custom alphabet for short IDs (matching Python backend)
const CUSTOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz123456789";

function generateShortId(length = 6): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CUSTOM_ALPHABET[Math.floor(Math.random() * CUSTOM_ALPHABET.length)];
  }
  return result;
}

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: Partial<InsertUser>): Promise<User>;
  updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined>;
  deleteUser(id: string): Promise<boolean>;
  listUsers(): Promise<User[]>;
  updateUserPinCode(email: string, pinCode: string | null, expiresAt?: Date): Promise<boolean>;
  verifyPinCode(email: string, pinCode: string): Promise<User | undefined>;
  updateUserToken(email: string, token: string): Promise<boolean>;
  updateUserLastLogin(email: string): Promise<boolean>;

  // Event methods  
  getEvent(eventId: string): Promise<Event | undefined>;
  getEventById(id: string): Promise<Event | undefined>;
  getEventsByOwner(ownerEmail: string): Promise<Event[]>;
  createEvent(event: Partial<InsertEvent>): Promise<Event>;
  updateEvent(eventId: string, updates: Partial<InsertEvent>): Promise<Event | undefined>;
  deleteEvent(id: string): Promise<boolean>;
  listEvents(): Promise<Event[]>;
  checkEventExists(eventId: string): Promise<boolean>;

  // Event image methods
  getEventImages(eventId: string, includeArchived?: boolean): Promise<EventImage[]>;
  addEventImages(images: InsertEventImage[]): Promise<EventImage[]>;
  updateShareConsent(imageIds: string[], consent: boolean): Promise<number>;
  getEventImageCount(eventId: string): Promise<number>;
  getEventContributorCount(eventId: string): Promise<number>;
  deleteEventImages(eventId: string, imageIds: string[]): Promise<number>;
  getEventImagesByIds(imageIds: string[]): Promise<EventImage[]>;
  getArchivedImagesByIds(eventId: string, imageIds: string[]): Promise<EventImage[]>;

  // Event reminder methods
  createEventReminder(reminder: InsertEventReminder): Promise<EventReminder>;
  getEventReminder(eventId: string, email: string): Promise<EventReminder | undefined>;
  getEventRemindersByEmail(email: string): Promise<EventReminder[]>;
  getPendingReminders(): Promise<EventReminder[]>;
  markReminderSent(reminderId: string): Promise<void>;

  // Storage usage methods
  getEventStorageUsage(eventId: string): Promise<{
    imageBytes: number;
    videoBytes: number;
    totalBytes: number;
    imageCount: number;
    videoCount: number;
  }>;

  // Guest participation methods
  upsertGuestParticipation(email: string, eventId: string, source: 'upload' | 'reminder'): Promise<EventGuestParticipant>;
  getGuestEventsByEmail(email: string): Promise<(Event & { guestInfo: EventGuestParticipant })[]>;
  getGuestParticipation(email: string, eventId: string): Promise<EventGuestParticipant | undefined>;
  getUserRoleForEvent(email: string, event: Event): Promise<'owner' | 'cohost' | 'guest' | 'none'>;

  // Feature request methods
  createFeatureRequest(request: InsertFeatureRequest): Promise<FeatureRequest>;
  listFeatureRequests(): Promise<FeatureRequest[]>;

  // Moderation methods
  getPendingModerationImages(eventId: string): Promise<EventImage[]>;
  getPendingModerationCount(eventId: string): Promise<number>;
  getArchivedImages(eventId: string): Promise<EventImage[]>;
  approveImages(eventId: string, imageIds: string[], moderatorEmail: string): Promise<number>;
  rejectImages(eventId: string, imageIds: string[], moderatorEmail: string): Promise<number>;
  archiveImages(eventId: string, imageIds: string[]): Promise<number>;
  restoreImages(eventId: string, imageIds: string[]): Promise<number>;
  permanentDeleteImages(eventId: string, imageIds: string[]): Promise<number>;
  getAllEventsWithPendingModeration(): Promise<{ event: Event; pendingCount: number }[]>;

  // Admin methods - paginated queries with search/filter
  adminListUsers(params: {
    page: number;
    pageSize: number;
    query?: string;
    role?: string;
    active?: boolean;
    sortBy?: 'email' | 'created_at' | 'last_login' | 'event_credit';
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ users: (User & { event_count: number })[]; total: number }>;

  adminListEvents(params: {
    page: number;
    pageSize: number;
    query?: string;
    active?: boolean;
    owner?: string;
    accessType?: string;
    requiresAuth?: boolean;
    moderationEnabled?: boolean;
    sortBy?: 'event_name' | 'created_at' | 'event_date' | 'image_count' | 'video_count' | 'media_count';
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ events: (Event & { image_count: number; video_count: number; storage_used_bytes: number })[]; total: number }>;

  adminGetStats(): Promise<{
    totalUsers: number;
    activeUsers: number;
    adminUsers: number;
    totalEvents: number;
    activeEvents: number;
    totalImages: number;
    totalVideos: number;
    archivedImages: number;
    archivedVideos: number;
    pendingImages: number;
    pendingVideos: number;
    totalStorageBytes: number;
    totalReminders: number;
    sentReminders: number;
  }>;

  adminUpdateUserCredits(userId: string, delta: number): Promise<User | undefined>;

  // Image likes methods
  likeImage(eventId: string, imageId: string, userEmail: string): Promise<boolean>;
  unlikeImage(eventId: string, imageId: string, userEmail: string): Promise<boolean>;
  getImageLikes(eventId: string, imageIds: string[], userEmail?: string): Promise<{ imageId: string; likeCount: number; userLiked: boolean }[]>;
  getLikedImages(eventId: string): Promise<EventImage[]>;

  // QR template download tracking methods
  recordQrTemplateDownload(eventId: string, templateName: string, downloadedBy?: string): Promise<void>;
  getQrTemplateDownloadStats(): Promise<{ template_name: string; download_count: number }[]>;
  getQrTemplateDownloadsByEvent(eventId: string): Promise<{ template_name: string; download_count: number }[]>;

  // QR code generator settings (per-event)
  getQrSettings(eventId: string): Promise<QRCodeSettings | null>;
  saveQrSettings(eventId: string, settings: QRCodeSettings): Promise<void>;
}

// QR Code Generator settings type
export interface QRCodeSettings {
  themeId: string;
  useCustomColors: boolean;
  customColors: { dotColor: string; backgroundColor: string };
  transparentBackground: boolean;
  centerDecoration: 'none' | 'logo' | 'initials';
  initials: string;
  customLogoUrl?: string; // URL in object storage instead of base64
}

export class PostgreSQLStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    // Case-insensitive email lookup for consistent behavior
    const [user] = await db.select().from(users).where(
      sql`LOWER(${users.email}) = LOWER(${email})`
    );
    return user;
  }

  async createUser(user: Partial<InsertUser>): Promise<User> {
    // Ensure email is present, as it's required
    if (!user.email) {
      throw new Error("Email is required for creating a user");
    }
    const [newUser] = await db.insert(users).values([user as InsertUser]).returning();
    return newUser;
  }

  async updateUser(id: string, updates: Partial<InsertUser>): Promise<User | undefined> {
    const [updatedUser] = await db.update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    return updatedUser;
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async listUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(users.email);
  }

  async updateUserPinCode(email: string, pinCode: string | null, expiresAt?: Date): Promise<boolean> {
    const result = await db.update(users)
      .set({ 
        pin_code: pinCode,
        pin_expiry: expiresAt || null
      })
      .where(sql`LOWER(${users.email}) = LOWER(${email})`);
    return (result.rowCount ?? 0) > 0;
  }

  async verifyPinCode(email: string, pinCode: string): Promise<User | undefined> {
    const [user] = await db.select().from(users)
      .where(and(
        sql`LOWER(${users.email}) = LOWER(${email})`,
        eq(users.pin_code, pinCode)
      ));
    
    if (!user) {
      return undefined;
    }
    
    // Check if PIN has expired
    if (user.pin_expiry && new Date() > new Date(user.pin_expiry)) {
      // PIN has expired, clear it
      await db.update(users)
        .set({ pin_code: null, pin_expiry: null })
        .where(sql`LOWER(${users.email}) = LOWER(${email})`);
      return undefined;
    }
    
    return user;
  }

  async updateUserToken(email: string, token: string): Promise<boolean> {
    const result = await db.update(users)
      .set({ 
        jwt_session_token: token,
        pin_code: null,
        last_login: new Date()
      })
      .where(sql`LOWER(${users.email}) = LOWER(${email})`);
    return (result.rowCount ?? 0) > 0;
  }

  async updateUserLastLogin(email: string): Promise<boolean> {
    const result = await db.update(users)
      .set({ last_login: new Date() })
      .where(sql`LOWER(${users.email}) = LOWER(${email})`);
    return (result.rowCount ?? 0) > 0;
  }

  // Event methods
  async getEvent(eventId: string): Promise<Event | undefined> {
    const [event] = await db.select().from(events)
      .where(eq(events.event_id, eventId));
    return event;
  }

  async getEventById(id: string): Promise<Event | undefined> {
    const [event] = await db.select().from(events)
      .where(eq(events.id, id));
    return event;
  }

  async getEventsByOwner(ownerEmail: string): Promise<Event[]> {
    const lowerEmail = ownerEmail.toLowerCase();
    return await db.select().from(events)
      .where(or(
        sql`lower(${events.event_owner}) = ${lowerEmail}`,
        sql`lower(${events.event_co_host}) = ${lowerEmail}`,
        sql`lower(${events.event_co_host}) LIKE ${lowerEmail + ',%'}`,
        sql`lower(${events.event_co_host}) LIKE ${'%,' + lowerEmail + ',%'}`,
        sql`lower(${events.event_co_host}) LIKE ${'%,' + lowerEmail}`
      ))
      .orderBy(events.event_date);
  }

  async createEvent(event: Partial<InsertEvent>): Promise<Event> {
    // Generate unique event_id if not provided
    const eventData = {
      ...event,
      event_id: event.event_id || generateShortId()
    };
    
    const [newEvent] = await db.insert(events).values(eventData).returning();
    return newEvent;
  }

  async updateEvent(eventId: string, updates: Partial<InsertEvent>): Promise<Event | undefined> {
    const [updatedEvent] = await db.update(events)
      .set(updates)
      .where(eq(events.event_id, eventId))
      .returning();
    return updatedEvent;
  }

  async deleteEvent(id: string): Promise<boolean> {
    const result = await db.delete(events).where(eq(events.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async listEvents(): Promise<Event[]> {
    return await db.select().from(events)
      .orderBy(desc(events.event_date));
  }

  async checkEventExists(eventId: string): Promise<boolean> {
    const [result] = await db.select({ count: sql`COUNT(*)` })
      .from(events)
      .where(eq(events.event_id, eventId));
    return Number(result?.count) > 0;
  }

  // Event image methods
  async getEventImages(eventId: string, includeArchived = false): Promise<EventImage[]> {
    const conditions = [
      eq(event_images.event_id, eventId),
      eq(event_images.share_consent, true),
      eq(event_images.moderation_status, 'approved')
    ];
    
    if (!includeArchived) {
      conditions.push(eq(event_images.archived, false));
    }
    
    return await db.select().from(event_images)
      .where(and(...conditions))
      .orderBy(desc(event_images.uploaded_at));
  }

  async addEventImages(images: InsertEventImage[]): Promise<EventImage[]> {
    return await db.insert(event_images).values(images).returning();
  }

  async updateShareConsent(imageIds: string[], consent: boolean): Promise<number> {
    const result = await db.update(event_images)
      .set({ share_consent: consent })
      .where(sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`);
    return result.rowCount ?? 0;
  }

  async getEventImageCount(eventId: string): Promise<number> {
    const [result] = await db.select({ count: sql`COUNT(*)` })
      .from(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        eq(event_images.share_consent, true),
        eq(event_images.archived, false)
      ));
    return Number(result?.count) || 0;
  }

  async getEventContributorCount(eventId: string): Promise<number> {
    const [result] = await db.select({ 
      count: sql`COUNT(DISTINCT ${event_images.uploaded_by})` 
    })
      .from(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        eq(event_images.share_consent, true),
        eq(event_images.archived, false)
      ));
    return Number(result?.count) || 0;
  }

  async deleteEventImages(eventId: string, imageIds: string[]): Promise<number> {
    // Soft delete by marking as archived - with event_id verification for security
    if (imageIds.length === 0) return 0;
    const result = await db.update(event_images)
      .set({ 
        archived: true,
        archived_at: new Date()
      })
      .where(and(
        eq(event_images.event_id, eventId),
        sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`
      ));
    return result.rowCount ?? 0;
  }

  async getEventImagesByIds(imageIds: string[]): Promise<EventImage[]> {
    return await db.select()
      .from(event_images)
      .where(sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`);
  }

  async getArchivedImagesByIds(eventId: string, imageIds: string[]): Promise<EventImage[]> {
    if (imageIds.length === 0) return [];
    return await db.select()
      .from(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        eq(event_images.archived, true),
        sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`
      ));
  }

  // Event reminder methods
  async createEventReminder(reminder: InsertEventReminder): Promise<EventReminder> {
    console.log('[STORAGE] createEventReminder called with:', JSON.stringify(reminder));
    try {
      const [newReminder] = await db.insert(event_reminders).values([reminder]).returning();
      console.log('[STORAGE] createEventReminder result:', JSON.stringify(newReminder));
      return newReminder;
    } catch (error: any) {
      console.error('[STORAGE] createEventReminder error:', error?.message);
      console.error('[STORAGE] Full error:', error);
      throw error;
    }
  }

  async getEventReminder(eventId: string, email: string): Promise<EventReminder | undefined> {
    const [reminder] = await db.select().from(event_reminders)
      .where(and(
        eq(event_reminders.event_id, eventId),
        eq(event_reminders.email, email)
      ));
    return reminder;
  }

  async getEventRemindersByEmail(email: string): Promise<EventReminder[]> {
    return await db.select().from(event_reminders)
      .where(eq(event_reminders.email, email))
      .orderBy(desc(event_reminders.created_at));
  }

  async getPendingReminders(): Promise<EventReminder[]> {
    const now = new Date();
    return await db.select().from(event_reminders)
      .where(and(
        eq(event_reminders.reminder_sent, false),
        lte(event_reminders.scheduled_for, now)
      ));
  }

  async markReminderSent(reminderId: string): Promise<void> {
    await db.update(event_reminders)
      .set({ 
        reminder_sent: true, 
        reminder_sent_at: new Date() 
      })
      .where(eq(event_reminders.id, reminderId));
  }

  // Storage usage methods
  async getEventStorageUsage(eventId: string): Promise<{
    imageBytes: number;
    videoBytes: number;
    totalBytes: number;
    imageCount: number;
    videoCount: number;
  }> {
    const videoExtensions = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp'];
    
    const results = await db.select({
      file_size: event_images.file_size,
      file_extension: event_images.file_extension
    })
      .from(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        eq(event_images.archived, false)
      ));

    let imageBytes = 0;
    let videoBytes = 0;
    let imageCount = 0;
    let videoCount = 0;

    for (const row of results) {
      const size = row.file_size || 0;
      const ext = (row.file_extension || '').toLowerCase().replace('.', '');
      
      if (videoExtensions.includes(ext)) {
        videoBytes += size;
        videoCount++;
      } else {
        imageBytes += size;
        imageCount++;
      }
    }

    return {
      imageBytes,
      videoBytes,
      totalBytes: imageBytes + videoBytes,
      imageCount,
      videoCount
    };
  }

  // Guest participation methods
  async upsertGuestParticipation(email: string, eventId: string, source: 'upload' | 'reminder'): Promise<EventGuestParticipant> {
    const normalizedEmail = email.toLowerCase();
    
    // Check if participation already exists
    const existing = await this.getGuestParticipation(normalizedEmail, eventId);
    
    if (existing) {
      // Update existing participation
      const newSource = existing.source === source ? existing.source : 'both';
      const newUploadCount = source === 'upload' ? existing.upload_count + 1 : existing.upload_count;
      
      const [updated] = await db.update(event_guest_participants)
        .set({ 
          last_participated_at: new Date(),
          source: newSource,
          upload_count: newUploadCount
        })
        .where(and(
          sql`LOWER(${event_guest_participants.email}) = LOWER(${normalizedEmail})`,
          eq(event_guest_participants.event_id, eventId)
        ))
        .returning();
      return updated;
    }
    
    // Create new participation
    const [newParticipation] = await db.insert(event_guest_participants).values({
      email: normalizedEmail,
      event_id: eventId,
      source: source,
      upload_count: source === 'upload' ? 1 : 0
    }).returning();
    
    return newParticipation;
  }

  async getGuestEventsByEmail(email: string): Promise<(Event & { guestInfo: EventGuestParticipant })[]> {
    const normalizedEmail = email.toLowerCase();
    
    // Get all guest participations for this email
    const participations = await db.select()
      .from(event_guest_participants)
      .where(sql`LOWER(${event_guest_participants.email}) = LOWER(${normalizedEmail})`);
    
    if (participations.length === 0) {
      return [];
    }
    
    // Get the events for these participations
    const eventIds = participations.map(p => p.event_id);
    const eventResults = await db.select()
      .from(events)
      .where(sql`${events.event_id} IN (${sql.join(eventIds.map(id => sql`${id}`), sql`, `)})`);
    
    // Filter out events where user is owner or co-host (they should see those as owned events)
    const guestEvents = eventResults.filter(event => {
      const isOwner = event.event_owner?.toLowerCase() === normalizedEmail;
      const coHosts = event.event_co_host?.toLowerCase().split(',').map(e => e.trim()) || [];
      const isCoHost = coHosts.includes(normalizedEmail);
      return !isOwner && !isCoHost;
    });
    
    // Combine events with their guest info
    return guestEvents.map(event => {
      const guestInfo = participations.find(p => p.event_id === event.event_id)!;
      return { ...event, guestInfo };
    }).sort((a, b) => {
      // Sort by last participated date, newest first
      return new Date(b.guestInfo.last_participated_at).getTime() - new Date(a.guestInfo.last_participated_at).getTime();
    });
  }

  async getGuestParticipation(email: string, eventId: string): Promise<EventGuestParticipant | undefined> {
    const [participation] = await db.select()
      .from(event_guest_participants)
      .where(and(
        sql`LOWER(${event_guest_participants.email}) = LOWER(${email})`,
        eq(event_guest_participants.event_id, eventId)
      ));
    return participation;
  }

  async getUserRoleForEvent(email: string, event: Event): Promise<'owner' | 'cohost' | 'guest' | 'none'> {
    const normalizedEmail = email.toLowerCase();
    
    // Check if owner
    if (event.event_owner?.toLowerCase() === normalizedEmail) {
      return 'owner';
    }
    
    // Check if co-host (co-hosts are stored as comma-separated list)
    if (event.event_co_host) {
      const coHosts = event.event_co_host.toLowerCase().split(',').map(e => e.trim());
      if (coHosts.includes(normalizedEmail)) {
        return 'cohost';
      }
    }
    
    // Check if guest
    const guestParticipation = await this.getGuestParticipation(normalizedEmail, event.event_id);
    if (guestParticipation) {
      return 'guest';
    }
    
    return 'none';
  }

  // Feature request methods
  async createFeatureRequest(request: InsertFeatureRequest): Promise<FeatureRequest> {
    const [newRequest] = await db.insert(feature_requests).values([{
      type: request.type,
      title: request.title,
      description: request.description,
      email: request.email || null
    }]).returning();
    return newRequest;
  }

  async listFeatureRequests(): Promise<FeatureRequest[]> {
    return await db.select()
      .from(feature_requests)
      .orderBy(desc(feature_requests.created_at));
  }

  // Moderation methods
  async getPendingModerationImages(eventId: string): Promise<EventImage[]> {
    return await db.select()
      .from(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        eq(event_images.moderation_status, 'pending'),
        eq(event_images.archived, false)
      ))
      .orderBy(desc(event_images.uploaded_at));
  }

  async getPendingModerationCount(eventId: string): Promise<number> {
    const [result] = await db.select({ count: sql`COUNT(*)` })
      .from(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        eq(event_images.moderation_status, 'pending'),
        eq(event_images.archived, false)
      ));
    return Number(result?.count) || 0;
  }

  async getArchivedImages(eventId: string): Promise<EventImage[]> {
    return await db.select()
      .from(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        eq(event_images.archived, true)
      ))
      .orderBy(desc(event_images.archived_at));
  }

  async approveImages(eventId: string, imageIds: string[], moderatorEmail: string): Promise<number> {
    if (imageIds.length === 0) return 0;
    const result = await db.update(event_images)
      .set({ 
        moderation_status: 'approved',
        moderated_at: new Date(),
        moderated_by: moderatorEmail
      })
      .where(and(
        eq(event_images.event_id, eventId),
        sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`
      ));
    return result.rowCount ?? 0;
  }

  async rejectImages(eventId: string, imageIds: string[], moderatorEmail: string): Promise<number> {
    if (imageIds.length === 0) return 0;
    const result = await db.update(event_images)
      .set({ 
        moderation_status: 'rejected',
        moderated_at: new Date(),
        moderated_by: moderatorEmail
      })
      .where(and(
        eq(event_images.event_id, eventId),
        sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`
      ));
    return result.rowCount ?? 0;
  }

  async archiveImages(eventId: string, imageIds: string[]): Promise<number> {
    if (imageIds.length === 0) return 0;
    const result = await db.update(event_images)
      .set({ 
        archived: true,
        archived_at: new Date()
      })
      .where(and(
        eq(event_images.event_id, eventId),
        sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`
      ));
    return result.rowCount ?? 0;
  }

  async restoreImages(eventId: string, imageIds: string[]): Promise<number> {
    if (imageIds.length === 0) return 0;
    const result = await db.update(event_images)
      .set({ 
        archived: false,
        archived_at: null
      })
      .where(and(
        eq(event_images.event_id, eventId),
        sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`
      ));
    return result.rowCount ?? 0;
  }

  async permanentDeleteImages(eventId: string, imageIds: string[]): Promise<number> {
    if (imageIds.length === 0) return 0;
    const result = await db.delete(event_images)
      .where(and(
        eq(event_images.event_id, eventId),
        sql`${event_images.id} IN (${sql.join(imageIds.map(id => sql`${id}`), sql`, `)})`
      ));
    return result.rowCount ?? 0;
  }

  async getAllEventsWithPendingModeration(): Promise<{ event: Event; pendingCount: number }[]> {
    // Get counts grouped by event_id
    const pendingCounts = await db.select({
      event_id: event_images.event_id,
      count: sql<number>`COUNT(*)`
    })
      .from(event_images)
      .where(and(
        eq(event_images.moderation_status, 'pending'),
        eq(event_images.archived, false)
      ))
      .groupBy(event_images.event_id);

    if (pendingCounts.length === 0) return [];

    // Get the events for those with pending moderation
    const eventIds = pendingCounts.map(p => p.event_id).filter((id): id is string => id !== null);
    const eventResults = await db.select()
      .from(events)
      .where(and(
        sql`${events.event_id} IN (${sql.join(eventIds.map(id => sql`${id}`), sql`, `)})`,
        eq(events.image_moderation, true)
      ));

    // Combine events with their pending counts
    return eventResults.map(event => {
      const pending = pendingCounts.find(p => p.event_id === event.event_id);
      return {
        event,
        pendingCount: Number(pending?.count) || 0
      };
    }).filter(item => item.pendingCount > 0);
  }

  // ==================== ADMIN METHODS ====================

  async adminListUsers(params: {
    page: number;
    pageSize: number;
    query?: string;
    role?: string;
    active?: boolean;
    sortBy?: 'email' | 'created_at' | 'last_login' | 'event_credit';
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ users: (User & { event_count: number })[]; total: number }> {
    const { page, pageSize, query, role, active, sortBy = 'created_at', sortOrder = 'desc' } = params;
    const offset = (page - 1) * pageSize;

    // Build WHERE conditions
    const conditions: any[] = [];
    if (query) {
      conditions.push(
        or(
          sql`LOWER(${users.email}) LIKE LOWER(${'%' + query + '%'})`,
          sql`LOWER(${users.name}) LIKE LOWER(${'%' + query + '%'})`
        )
      );
    }
    if (role) {
      conditions.push(eq(users.role, role));
    }
    if (active !== undefined) {
      conditions.push(eq(users.active, active));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const [countResult] = await db.select({ count: sql<number>`COUNT(*)` })
      .from(users)
      .where(whereClause);
    const total = Number(countResult?.count) || 0;

    // Build sort clause
    const sortColumn = sortBy === 'email' ? users.email 
      : sortBy === 'last_login' ? users.last_login
      : sortBy === 'event_credit' ? users.event_credit
      : users.created_at;
    const orderBy = sortOrder === 'asc' ? sql`${sortColumn} ASC NULLS LAST` : sql`${sortColumn} DESC NULLS LAST`;

    // Get users with event counts using subquery
    const userList = await db.select({
      id: users.id,
      active: users.active,
      name: users.name,
      email: users.email,
      created_at: users.created_at,
      last_login: users.last_login,
      pin_code: users.pin_code,
      pin_expiry: users.pin_expiry,
      role: users.role,
      jwt_session_token: users.jwt_session_token,
      event_credit: users.event_credit,
      preferred_locale: users.preferred_locale,
      event_count: sql<number>`(SELECT COUNT(*) FROM events WHERE LOWER(events.event_owner) = LOWER(${users.email}))`
    })
      .from(users)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    return { 
      users: userList.map(u => ({ ...u, event_count: Number(u.event_count) || 0 })), 
      total 
    };
  }

  async adminListEvents(params: {
    page: number;
    pageSize: number;
    query?: string;
    active?: boolean;
    owner?: string;
    accessType?: string;
    requiresAuth?: boolean;
    moderationEnabled?: boolean;
    sortBy?: 'event_name' | 'created_at' | 'event_date' | 'image_count' | 'video_count' | 'media_count';
    sortOrder?: 'asc' | 'desc';
  }): Promise<{ events: (Event & { image_count: number; video_count: number; storage_used_bytes: number })[]; total: number }> {
    const { page, pageSize, query, active, owner, accessType, requiresAuth, moderationEnabled, sortBy = 'created_at', sortOrder = 'desc' } = params;
    const offset = (page - 1) * pageSize;

    // Build WHERE conditions
    const conditions: any[] = [];
    if (query) {
      conditions.push(
        or(
          sql`LOWER(${events.event_name}) LIKE LOWER(${'%' + query + '%'})`,
          sql`LOWER(${events.event_id}) LIKE LOWER(${'%' + query + '%'})`,
          sql`LOWER(${events.event_owner}) LIKE LOWER(${'%' + query + '%'})`
        )
      );
    }
    if (active !== undefined) {
      conditions.push(eq(events.active, active));
    }
    if (owner) {
      conditions.push(sql`LOWER(${events.event_owner}) LIKE LOWER(${'%' + owner + '%'})`);
    }
    if (accessType) {
      conditions.push(eq(events.event_access_type, accessType));
    }
    if (requiresAuth !== undefined) {
      conditions.push(eq(events.upload_requires_auth, requiresAuth));
    }
    if (moderationEnabled !== undefined) {
      conditions.push(eq(events.image_moderation, moderationEnabled));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const [countResult] = await db.select({ count: sql<number>`COUNT(*)` })
      .from(events)
      .where(whereClause);
    const total = Number(countResult?.count) || 0;

    // For media count sorting, we need a different approach using raw SQL
    const isMediaSort = ['image_count', 'video_count', 'media_count'].includes(sortBy);
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC';
    
    if (isMediaSort) {
      // Use a CTE to compute media counts and sort by them
      const videoExts = "'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'";
      
      const sortExpr = sortBy === 'image_count' 
        ? 'image_count'
        : sortBy === 'video_count' 
          ? 'video_count'
          : '(image_count + video_count)';
      
      // Build WHERE SQL string
      let whereSQL = '';
      const whereParams: any[] = [];
      if (query) {
        whereSQL += ` AND (LOWER(e.event_name) LIKE LOWER($${whereParams.length + 1}) OR LOWER(e.event_id) LIKE LOWER($${whereParams.length + 1}) OR LOWER(e.event_owner) LIKE LOWER($${whereParams.length + 1}))`;
        whereParams.push('%' + query + '%');
      }
      if (active !== undefined) {
        whereSQL += ` AND e.active = $${whereParams.length + 1}`;
        whereParams.push(active);
      }
      if (owner) {
        whereSQL += ` AND LOWER(e.event_owner) LIKE LOWER($${whereParams.length + 1})`;
        whereParams.push('%' + owner + '%');
      }
      if (accessType) {
        whereSQL += ` AND e.event_access_type = $${whereParams.length + 1}`;
        whereParams.push(accessType);
      }
      if (requiresAuth !== undefined) {
        whereSQL += ` AND e.upload_requires_auth = $${whereParams.length + 1}`;
        whereParams.push(requiresAuth);
      }
      if (moderationEnabled !== undefined) {
        whereSQL += ` AND e.image_moderation = $${whereParams.length + 1}`;
        whereParams.push(moderationEnabled);
      }

      const rawQuery = sql.raw(`
        WITH media_counts AS (
          SELECT 
            event_id,
            COUNT(*) FILTER (WHERE archived = false AND (file_extension IS NULL OR LOWER(file_extension) NOT IN (${videoExts}))) AS image_count,
            COUNT(*) FILTER (WHERE archived = false AND LOWER(file_extension) IN (${videoExts})) AS video_count,
            COALESCE(SUM(CASE WHEN archived = false THEN file_size ELSE 0 END), 0) AS storage_used_bytes
          FROM event_images
          GROUP BY event_id
        )
        SELECT 
          e.*,
          COALESCE(m.image_count, 0) AS image_count,
          COALESCE(m.video_count, 0) AS video_count,
          COALESCE(m.storage_used_bytes, 0) AS storage_used_bytes
        FROM events e
        LEFT JOIN media_counts m ON e.event_id = m.event_id
        WHERE 1=1 ${whereSQL}
        ORDER BY ${sortExpr} ${sortDir} NULLS LAST
        LIMIT ${pageSize} OFFSET ${offset}
      `);
      
      const result = await db.execute(rawQuery);
      const eventList = result.rows as any[];
      
      return {
        events: eventList.map(e => ({
          ...e,
          image_count: Number(e.image_count) || 0,
          video_count: Number(e.video_count) || 0,
          storage_used_bytes: Number(e.storage_used_bytes) || 0
        })),
        total
      };
    }

    // Standard sort by event columns
    const sortColumn = sortBy === 'event_name' ? events.event_name 
      : sortBy === 'event_date' ? events.event_date
      : events.created_at;
    const orderBy = sortOrder === 'asc' ? sql`${sortColumn} ASC NULLS LAST` : sql`${sortColumn} DESC NULLS LAST`;

    const eventList = await db.select()
      .from(events)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    // Get media counts for these events in a single query
    const eventIds = eventList.map(e => e.event_id);
    
    let mediaCounts: Record<string, { image_count: number; video_count: number; storage_used_bytes: number }> = {};
    
    if (eventIds.length > 0) {
      const mediaStats = await db.select({
        event_id: event_images.event_id,
        image_count: sql<number>`COUNT(*) FILTER (WHERE ${event_images.archived} = false AND (${event_images.file_extension} IS NULL OR LOWER(${event_images.file_extension}) NOT IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp')))`,
        video_count: sql<number>`COUNT(*) FILTER (WHERE ${event_images.archived} = false AND LOWER(${event_images.file_extension}) IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'))`,
        storage_used_bytes: sql<number>`COALESCE(SUM(CASE WHEN ${event_images.archived} = false THEN ${event_images.file_size} ELSE 0 END), 0)`
      })
        .from(event_images)
        .where(inArray(event_images.event_id, eventIds))
        .groupBy(event_images.event_id);
      
      for (const row of mediaStats) {
        if (row.event_id) {
          mediaCounts[row.event_id] = {
            image_count: Number(row.image_count) || 0,
            video_count: Number(row.video_count) || 0,
            storage_used_bytes: Number(row.storage_used_bytes) || 0
          };
        }
      }
    }

    return { 
      events: eventList.map(e => ({
        ...e,
        image_count: mediaCounts[e.event_id]?.image_count || 0,
        video_count: mediaCounts[e.event_id]?.video_count || 0,
        storage_used_bytes: mediaCounts[e.event_id]?.storage_used_bytes || 0
      })),
      total 
    };
  }

  async adminGetStats(): Promise<{
    totalUsers: number;
    activeUsers: number;
    adminUsers: number;
    totalEvents: number;
    activeEvents: number;
    totalImages: number;
    totalVideos: number;
    archivedImages: number;
    archivedVideos: number;
    pendingImages: number;
    pendingVideos: number;
    totalStorageBytes: number;
    totalReminders: number;
    sentReminders: number;
  }> {
    // Execute all counts in parallel for efficiency
    const [
      userStats,
      eventStats,
      mediaStats,
      reminderStats
    ] = await Promise.all([
      // User stats
      db.select({
        total: sql<number>`COUNT(*)`,
        active: sql<number>`COUNT(*) FILTER (WHERE ${users.active} = true)`,
        admins: sql<number>`COUNT(*) FILTER (WHERE ${users.role} = 'superuser')`
      }).from(users),
      
      // Event stats
      db.select({
        total: sql<number>`COUNT(*)`,
        active: sql<number>`COUNT(*) FILTER (WHERE ${events.active} = true)`
      }).from(events),
      
      // Media stats - with separate archived/pending counts for images and videos
      db.select({
        totalImages: sql<number>`COUNT(*) FILTER (WHERE ${event_images.archived} = false AND (${event_images.file_extension} IS NULL OR LOWER(${event_images.file_extension}) NOT IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp')))`,
        totalVideos: sql<number>`COUNT(*) FILTER (WHERE ${event_images.archived} = false AND LOWER(${event_images.file_extension}) IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'))`,
        archivedImages: sql<number>`COUNT(*) FILTER (WHERE ${event_images.archived} = true AND (${event_images.file_extension} IS NULL OR LOWER(${event_images.file_extension}) NOT IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp')))`,
        archivedVideos: sql<number>`COUNT(*) FILTER (WHERE ${event_images.archived} = true AND LOWER(${event_images.file_extension}) IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'))`,
        pendingImages: sql<number>`COUNT(*) FILTER (WHERE ${event_images.moderation_status} = 'pending' AND ${event_images.archived} = false AND (${event_images.file_extension} IS NULL OR LOWER(${event_images.file_extension}) NOT IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp')))`,
        pendingVideos: sql<number>`COUNT(*) FILTER (WHERE ${event_images.moderation_status} = 'pending' AND ${event_images.archived} = false AND LOWER(${event_images.file_extension}) IN ('mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp'))`,
        storageBytes: sql<number>`COALESCE(SUM(${event_images.file_size}) FILTER (WHERE ${event_images.archived} = false), 0)`
      }).from(event_images),
      
      // Reminder stats
      db.select({
        total: sql<number>`COUNT(*)`,
        sent: sql<number>`COUNT(*) FILTER (WHERE ${event_reminders.reminder_sent} = true)`
      }).from(event_reminders)
    ]);

    return {
      totalUsers: Number(userStats[0]?.total) || 0,
      activeUsers: Number(userStats[0]?.active) || 0,
      adminUsers: Number(userStats[0]?.admins) || 0,
      totalEvents: Number(eventStats[0]?.total) || 0,
      activeEvents: Number(eventStats[0]?.active) || 0,
      totalImages: Number(mediaStats[0]?.totalImages) || 0,
      totalVideos: Number(mediaStats[0]?.totalVideos) || 0,
      archivedImages: Number(mediaStats[0]?.archivedImages) || 0,
      archivedVideos: Number(mediaStats[0]?.archivedVideos) || 0,
      pendingImages: Number(mediaStats[0]?.pendingImages) || 0,
      pendingVideos: Number(mediaStats[0]?.pendingVideos) || 0,
      totalStorageBytes: Number(mediaStats[0]?.storageBytes) || 0,
      totalReminders: Number(reminderStats[0]?.total) || 0,
      sentReminders: Number(reminderStats[0]?.sent) || 0
    };
  }

  async adminUpdateUserCredits(userId: string, delta: number): Promise<User | undefined> {
    // Use SQL to atomically update credits
    const [updatedUser] = await db.update(users)
      .set({ 
        event_credit: sql`GREATEST(0, COALESCE(${users.event_credit}, 0) + ${delta})`
      })
      .where(eq(users.id, userId))
      .returning();
    return updatedUser;
  }

  // Image likes methods
  async likeImage(eventId: string, imageId: string, userEmail: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      // Check if table exists first
      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'event_image_likes'
      `);
      
      if (tableCheck.rows.length === 0) {
        console.log('[LIKES] event_image_likes table does not exist yet');
        return false;
      }
      
      // Insert like (ignore if already exists due to unique constraint)
      await client.query(`
        INSERT INTO event_image_likes (event_id, image_id, user_email)
        VALUES ($1, $2, $3)
        ON CONFLICT (image_id, user_email) DO NOTHING
      `, [eventId, imageId, userEmail.toLowerCase()]);
      
      // Update like_count on the image (if column exists)
      await client.query(`
        UPDATE event_images 
        SET like_count = (
          SELECT COUNT(*) FROM event_image_likes WHERE image_id = $1
        )
        WHERE id = $1
      `, [imageId]).catch(() => {});
      
      return true;
    } catch (error) {
      console.error('[LIKES] Error liking image:', error);
      return false;
    } finally {
      client.release();
    }
  }

  async unlikeImage(eventId: string, imageId: string, userEmail: string): Promise<boolean> {
    const client = await pool.connect();
    try {
      // Check if table exists first
      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'event_image_likes'
      `);
      
      if (tableCheck.rows.length === 0) {
        console.log('[LIKES] event_image_likes table does not exist yet');
        return false;
      }
      
      // Delete like
      await client.query(`
        DELETE FROM event_image_likes 
        WHERE image_id = $1 AND LOWER(user_email) = LOWER($2)
      `, [imageId, userEmail]);
      
      // Update like_count on the image (if column exists)
      await client.query(`
        UPDATE event_images 
        SET like_count = (
          SELECT COUNT(*) FROM event_image_likes WHERE image_id = $1
        )
        WHERE id = $1
      `, [imageId]).catch(() => {});
      
      return true;
    } catch (error) {
      console.error('[LIKES] Error unliking image:', error);
      return false;
    } finally {
      client.release();
    }
  }

  async getImageLikes(eventId: string, imageIds: string[], userEmail?: string): Promise<{ imageId: string; likeCount: number; userLiked: boolean }[]> {
    const client = await pool.connect();
    try {
      // Check if table exists first
      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'event_image_likes'
      `);
      
      if (tableCheck.rows.length === 0) {
        // Return empty likes if table doesn't exist
        return imageIds.map(id => ({ imageId: id, likeCount: 0, userLiked: false }));
      }
      
      if (imageIds.length === 0) {
        return [];
      }
      
      // Get like counts for all images
      const likeCounts = await client.query(`
        SELECT image_id, COUNT(*) as count
        FROM event_image_likes
        WHERE image_id = ANY($1)
        GROUP BY image_id
      `, [imageIds]);
      
      // Get user's likes if email provided
      let userLikes: string[] = [];
      if (userEmail) {
        const userLikesResult = await client.query(`
          SELECT image_id FROM event_image_likes
          WHERE image_id = ANY($1) AND LOWER(user_email) = LOWER($2)
        `, [imageIds, userEmail]);
        userLikes = userLikesResult.rows.map(r => r.image_id);
      }
      
      // Build result
      const likeCountMap = new Map(likeCounts.rows.map(r => [r.image_id, Number(r.count)]));
      return imageIds.map(id => ({
        imageId: id,
        likeCount: likeCountMap.get(id) || 0,
        userLiked: userLikes.includes(id)
      }));
    } catch (error) {
      console.error('[LIKES] Error getting image likes:', error);
      return imageIds.map(id => ({ imageId: id, likeCount: 0, userLiked: false }));
    } finally {
      client.release();
    }
  }

  async getLikedImages(eventId: string): Promise<EventImage[]> {
    const client = await pool.connect();
    try {
      // Check if table exists first
      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'event_image_likes'
      `);
      
      if (tableCheck.rows.length === 0) {
        return [];
      }
      
      // Get images that have at least one like
      const result = await client.query(`
        SELECT DISTINCT ei.* FROM event_images ei
        INNER JOIN event_image_likes eil ON ei.id = eil.image_id
        WHERE ei.event_id = $1 
        AND ei.archived = false 
        AND ei.moderation_status = 'approved'
        ORDER BY ei.uploaded_at DESC
      `, [eventId]);
      
      return result.rows as EventImage[];
    } catch (error) {
      console.error('[LIKES] Error getting liked images:', error);
      return [];
    } finally {
      client.release();
    }
  }

  // QR Template Download Tracking Methods
  async recordQrTemplateDownload(eventId: string, templateName: string, downloadedBy?: string): Promise<void> {
    const client = await pool.connect();
    try {
      // Check if table exists, create if not
      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'qr_template_downloads'
      `);
      
      if (tableCheck.rows.length === 0) {
        // Create the table
        await client.query(`
          CREATE TABLE IF NOT EXISTS qr_template_downloads (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id VARCHAR(255) NOT NULL,
            template_name VARCHAR(50) NOT NULL,
            downloaded_at TIMESTAMP DEFAULT NOW() NOT NULL,
            downloaded_by VARCHAR(255)
          )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_qr_downloads_event_id ON qr_template_downloads(event_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_qr_downloads_template ON qr_template_downloads(template_name)`);
        console.log('[QR DOWNLOADS] Created qr_template_downloads table');
      }
      
      await client.query(`
        INSERT INTO qr_template_downloads (event_id, template_name, downloaded_by)
        VALUES ($1, $2, $3)
      `, [eventId, templateName, downloadedBy || null]);
      
      console.log(`[QR DOWNLOADS] Recorded download: ${templateName} for event ${eventId}`);
    } catch (error) {
      console.error('[QR DOWNLOADS] Error recording download:', error);
    } finally {
      client.release();
    }
  }

  async getQrTemplateDownloadStats(): Promise<{ template_name: string; download_count: number }[]> {
    const client = await pool.connect();
    try {
      // Check if table exists
      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'qr_template_downloads'
      `);
      
      if (tableCheck.rows.length === 0) {
        return [];
      }
      
      const result = await client.query(`
        SELECT template_name, COUNT(*) as download_count
        FROM qr_template_downloads
        GROUP BY template_name
        ORDER BY download_count DESC
      `);
      
      return result.rows.map(row => ({
        template_name: row.template_name,
        download_count: Number(row.download_count)
      }));
    } catch (error) {
      console.error('[QR DOWNLOADS] Error getting stats:', error);
      return [];
    } finally {
      client.release();
    }
  }

  async getQrTemplateDownloadsByEvent(eventId: string): Promise<{ template_name: string; download_count: number }[]> {
    const client = await pool.connect();
    try {
      // Check if table exists
      const tableCheck = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_name = 'qr_template_downloads'
      `);
      
      if (tableCheck.rows.length === 0) {
        return [];
      }
      
      const result = await client.query(`
        SELECT template_name, COUNT(*) as download_count
        FROM qr_template_downloads
        WHERE event_id = $1
        GROUP BY template_name
        ORDER BY download_count DESC
      `, [eventId]);
      
      return result.rows.map(row => ({
        template_name: row.template_name,
        download_count: Number(row.download_count)
      }));
    } catch (error) {
      console.error('[QR DOWNLOADS] Error getting event stats:', error);
      return [];
    } finally {
      client.release();
    }
  }

  // QR Code Generator Settings Methods
  async getQrSettings(eventId: string): Promise<QRCodeSettings | null> {
    try {
      const result = await db
        .select({ qr_settings: events.qr_settings })
        .from(events)
        .where(eq(events.event_id, eventId))
        .limit(1);
      
      if (result.length === 0 || !result[0].qr_settings) {
        return null;
      }
      
      return JSON.parse(result[0].qr_settings) as QRCodeSettings;
    } catch (error: any) {
      // If column doesn't exist, log helpful message
      if (error.message?.includes('column') && error.message?.includes('does not exist')) {
        console.error('[QR SETTINGS] Column qr_settings does not exist. Run this SQL in Google Cloud SQL:');
        console.error('ALTER TABLE events ADD COLUMN IF NOT EXISTS qr_settings TEXT;');
      } else {
        console.error('[QR SETTINGS] Error getting QR settings:', error);
      }
      return null;
    }
  }

  async saveQrSettings(eventId: string, settings: QRCodeSettings): Promise<void> {
    try {
      await db
        .update(events)
        .set({ qr_settings: JSON.stringify(settings) })
        .where(eq(events.event_id, eventId));
      
      console.log(`[QR SETTINGS] Saved QR settings for event ${eventId}`);
    } catch (error: any) {
      // If column doesn't exist, log helpful message
      if (error.message?.includes('column') && error.message?.includes('does not exist')) {
        console.error('[QR SETTINGS] Column qr_settings does not exist. Run this SQL in Google Cloud SQL:');
        console.error('ALTER TABLE events ADD COLUMN IF NOT EXISTS qr_settings TEXT;');
      }
      console.error('[QR SETTINGS] Error saving QR settings:', error);
      throw error;
    }
  }
}

// Use PostgreSQL storage in production
export const storage = new PostgreSQLStorage();