import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import type { User, Event, EventImage } from "@shared/schema";
import { insertFeatureRequestSchema } from "@shared/schema";
import { getUploadStatus } from "@shared/eventUtils";
import { OAuth2Client } from 'google-auth-library';

// JWT secret - REQUIRED environment variable (no fallback for security)
if (!process.env.JWT_SECRET) {
  throw new Error('SECURITY ERROR: JWT_SECRET environment variable is required.');
}
const JWT_SECRET: string = process.env.JWT_SECRET;

// Rate limiting configuration for brute-force protection
interface RateLimitEntry {
  count: number;
  firstAttempt: number;
  blockedUntil?: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PIN_REQUESTS_PER_WINDOW = 5; // Max PIN code requests per email per window
const MAX_PIN_VERIFY_ATTEMPTS = 5; // Max verification attempts before lockout
const LOCKOUT_DURATION_MS = 30 * 60 * 1000; // 30 minute lockout after too many failed attempts

function getRateLimitKey(type: 'send' | 'verify', identifier: string): string {
  return `${type}:${identifier.toLowerCase()}`;
}

function isRateLimited(key: string, maxAttempts: number): { limited: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  
  if (!entry) {
    return { limited: false };
  }
  
  // Check if currently locked out
  if (entry.blockedUntil && now < entry.blockedUntil) {
    return { limited: true, retryAfter: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  
  // Reset if window has passed
  if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.delete(key);
    return { limited: false };
  }
  
  // Check if limit exceeded
  if (entry.count >= maxAttempts) {
    // Apply lockout
    entry.blockedUntil = now + LOCKOUT_DURATION_MS;
    return { limited: true, retryAfter: Math.ceil(LOCKOUT_DURATION_MS / 1000) };
  }
  
  return { limited: false };
}

function recordAttempt(key: string): void {
  const now = Date.now();
  const entry = rateLimitStore.get(key);
  
  if (!entry || now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(key, { count: 1, firstAttempt: now });
  } else {
    entry.count++;
  }
}

function clearRateLimit(key: string): void {
  rateLimitStore.delete(key);
}

// Clean up old rate limit entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS && (!entry.blockedUntil || now > entry.blockedUntil)) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Custom alphabet for short IDs (matching Python backend)
const CUSTOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz123456789";

function generateShortId(length = 6): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CUSTOM_ALPHABET[Math.floor(Math.random() * CUSTOM_ALPHABET.length)];
  }
  return result;
}

function generateBatchId(): string {
  return generateShortId(5).toUpperCase();
}

function generatePinCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getBaseUrl(req: any): string {
  const protocol = req.protocol || 'https';
  const host = req.get('host') || req.headers.host || 'evenero.com';
  return `${protocol}://${host}`;
}

function generateToken(email: string): string {
  const payload = {
    email,
    exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
  };
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' });
}

async function verifyToken(token: string): Promise<string | null> {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    return payload.email || null;
  } catch {
    return null;
  }
}

// Extract token from Authorization header (Bearer token)
function getTokenFromHeader(req: any): string | null {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader) {
    return null;
  }

  // Support "Bearer <token>" format
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Also support direct token without "Bearer " prefix
  return authHeader;
}

// Verify user is admin (superuser role)
async function verifyAdmin(token: string): Promise<User | null> {
  const email = await verifyToken(token);
  if (!email) {
    return null;
  }

  const user = await storage.getUserByEmail(email);
  if (!user || user.role !== 'superuser') {
    return null;
  }

  return user;
}

// Check if user has access to an event (owner, co-host, or public event)
async function hasEventAccess(userEmail: string | null, event: Event): Promise<boolean> {
  // Public events are accessible to everyone
  if (event.event_access_type === 'public') {
    return true;
  }

  // If no user email, can only access public events
  if (!userEmail) {
    return false;
  }

  // Check if user is the owner
  if (event.event_owner?.toLowerCase() === userEmail.toLowerCase()) {
    return true;
  }

  // Check if user is a co-host
  if (event.event_co_host) {
    const coHosts = event.event_co_host.split(',').map(email => email.trim().toLowerCase());
    if (coHosts.includes(userEmail.toLowerCase())) {
      return true;
    }
  }

  return false;
}

// Check if user is owner or co-host (for management operations)
async function isEventOwnerOrCoHost(userEmail: string, event: Event): Promise<boolean> {
  // Check if user is the owner
  if (event.event_owner?.toLowerCase() === userEmail.toLowerCase()) {
    return true;
  }

  // Check if user is a co-host
  if (event.event_co_host) {
    const coHosts = event.event_co_host.split(',').map(email => email.trim().toLowerCase());
    if (coHosts.includes(userEmail.toLowerCase())) {
      return true;
    }
  }

  return false;
}

// Validation schemas
const sendPinSchema = z.object({
  email: z.string().email()
});

const verifyPinSchema = z.object({
  email: z.string().email(),
  pin_code: z.string().length(6)
});

const createEventSchema = z.object({
  event_custom_id: z.string().optional(),
  event_name: z.string().optional(),
  event_description: z.string().optional(),
  event_photo: z.string().optional(),
  active: z.boolean().optional(),
  upload_requires_auth: z.boolean().optional(),
  image_moderation: z.boolean().optional(),
  event_date: z.string().optional(),
  event_location: z.string().optional(),
  event_type: z.string().optional(),
  event_owner: z.string().email().optional(),
  event_co_host: z.string().optional(),
  event_access_type: z.enum(['public', 'private', 'premium', 'light']).optional(),
  event_start_date: z.string().optional(),
  event_expiry_date: z.string().optional(),
  event_secret: z.string().optional(),
  uploads_disabled: z.boolean().optional()
});

export async function registerRoutes(app: Express): Promise<Server> {
  // ==================== API PROXY ROUTES (for frontend compatibility) ====================
  // The frontend uses /api/proxy/* routes, so we need to handle them directly
  // Since we can't use middleware to rewrite URLs with Vite, we'll register both paths
  
  // Helper function to register route on all paths (frontend uses /api/events, /api/proxy/events, and /events)
  const registerBothPaths = (method: string, path: string, handler: any) => {
    (app as any)[method](path, handler);
    (app as any)[method](`/api/proxy${path}`, handler);
    (app as any)[method](`/api${path}`, handler);
  };

  // ==================== HEALTH & VERSION ====================
  registerBothPaths("get", "/health", (_, res) => {
    res.json({ status: "ok" });
  });

  registerBothPaths("get", "/version", (_, res) => {
    res.send("0.2.0");
  });

  // Don't define "/" route - let Vite handle it to serve the frontend

  // ==================== AUTHENTICATION ====================
  registerBothPaths("post", "/auth", async (req, res) => {
    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    const email = await verifyToken(token);
    if (!email) {
      return res.status(401).json({ detail: "Unauthorized" });
    }

    const user = await storage.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ detail: "Unauthorized" });
    }

    res.json({
      id: user.id,
      email: user.email,
      active: user.active,
      created_at: user.created_at,
      last_login: user.last_login,
      name: user.name,
      role: user.role,
      event_credit: user.event_credit,
      preferred_locale: user.preferred_locale
    });
  });

  registerBothPaths("post", "/send-pin-code", async (req, res) => {
    try {
      const { email } = sendPinSchema.parse(req.body);
      
      // Rate limiting check - prevent spam/abuse
      const rateLimitKey = getRateLimitKey('send', email);
      const rateLimit = isRateLimited(rateLimitKey, MAX_PIN_REQUESTS_PER_WINDOW);
      if (rateLimit.limited) {
        console.warn(`Rate limit exceeded for PIN request: ${email}`);
        return res.status(429).json({ 
          detail: "Too many PIN code requests. Please try again later.",
          retryAfter: rateLimit.retryAfter
        });
      }
      
      // Record this attempt
      recordAttempt(rateLimitKey);
      
      // Check if user exists, if not create
      let user = await storage.getUserByEmail(email);
      if (!user) {
        user = await storage.createUser({ email });
      }

      // Generate and save PIN code with expiry (10 minutes)
      const pinCode = generatePinCode();
      const pinExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
      await storage.updateUserPinCode(email, pinCode, pinExpiry);

      // Send email with PIN code (use user's preferred locale)
      try {
        const { sendPinCodeEmail } = await import('./email');
        const userLocale = user?.preferred_locale || 'en';
        
        // Construct login URL with pre-filled email and PIN
        const protocol = req.protocol;
        const host = req.get('host');
        const loginUrl = `${protocol}://${host}/login/${encodeURIComponent(email)}?pin=${pinCode}`;
        
        await sendPinCodeEmail(email, pinCode, userLocale as 'en' | 'nb', loginUrl);
      } catch (emailError) {
        console.error('Error sending email:', emailError);
        // Don't fail the request if email sending fails
      }

      res.json({ message: "PIN code sent successfully" });
    } catch (error) {
      console.error('Error in send-pin-code:', error);
      if (error instanceof z.ZodError) {
        return res.status(400).json({ detail: "Invalid email format" });
      }
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("post", "/verify-pin-code", async (req, res) => {
    try {
      const { email, pin_code } = verifyPinSchema.parse(req.body);
      
      // Rate limiting check for verification attempts - prevent brute force
      const rateLimitKey = getRateLimitKey('verify', email);
      const rateLimit = isRateLimited(rateLimitKey, MAX_PIN_VERIFY_ATTEMPTS);
      if (rateLimit.limited) {
        console.warn(`Rate limit exceeded for PIN verification: ${email}`);
        return res.status(429).json({ 
          detail: "Too many verification attempts. Account temporarily locked.",
          retryAfter: rateLimit.retryAfter
        });
      }

      const user = await storage.verifyPinCode(email, pin_code);
      if (!user) {
        // Record failed attempt
        recordAttempt(rateLimitKey);
        console.warn(`Failed PIN verification attempt for: ${email}`);
        return res.status(401).json({ detail: "Invalid email or pin code" });
      }
      
      // Clear rate limit on successful verification
      clearRateLimit(rateLimitKey);
      clearRateLimit(getRateLimitKey('send', email));

      // Generate JWT token and update user
      const token = generateToken(email);
      await storage.updateUserToken(email, token);

      res.json({
        message: "User authenticated successfully",
        email: email,
        token: token,
        name: user.name
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ detail: "Invalid pin code" });
      }
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("post", "/set-display-name", async (req, res) => {
    const { name } = req.body;

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    const email = await verifyToken(token);
    if (!email) {
      return res.status(401).json({ detail: "Unauthorized" });
    }

    const user = await storage.getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ detail: "User not found" });
    }

    const updatedUser = await storage.updateUser(user.id, { name });
    res.json(updatedUser);
  });

  registerBothPaths("post", "/set-preferred-locale", async (req, res) => {
    const { locale } = req.body;

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    const email = await verifyToken(token);
    if (!email) {
      return res.status(401).json({ detail: "Unauthorized" });
    }

    const user = await storage.getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ detail: "User not found" });
    }

    // Validate locale
    const validLocales = ['en', 'nb'];
    if (!validLocales.includes(locale)) {
      return res.status(400).json({ detail: "Invalid locale" });
    }

    const updatedUser = await storage.updateUser(user.id, { preferred_locale: locale });
    res.json(updatedUser);
  });

  registerBothPaths("post", "/google-auth", async (req, res) => {
    const { jwt_token } = req.body;

    if (!jwt_token) {
      return res.status(401).json({ detail: "Unauthorized" });
    }

    try {
      // Verify Google JWT signature with Google's OAuth2 client
      const client = new OAuth2Client();
      
      // Verify the token (this checks the signature against Google's public keys)
      const ticket = await client.verifyIdToken({
        idToken: jwt_token,
        // We don't specify audience since this could come from multiple Google OAuth apps
      });
      
      const payload = ticket.getPayload();
      
      if (!payload?.email) {
        console.warn('Google JWT verified but no email in payload');
        return res.status(401).json({ detail: "Unauthorized - no email in token" });
      }

      // Additional security: verify email is verified by Google
      if (!payload.email_verified) {
        console.warn(`Google OAuth attempt with unverified email: ${payload.email}`);
        return res.status(401).json({ detail: "Email not verified by Google" });
      }

      const { email, name, given_name } = payload;

      // Check if user exists, if not create
      let user = await storage.getUserByEmail(email);
      if (!user) {
        const displayName = given_name || name || undefined;
        user = await storage.createUser({ 
          email, 
          name: displayName 
        });
      }

      // Update last login
      await storage.updateUserLastLogin(email);

      // Generate our own JWT
      const token = generateToken(email);
      await storage.updateUserToken(email, token);

      res.json({
        token,
        email,
        name: user.name
      });
    } catch (error) {
      console.error('Google JWT verification failed:', error);
      return res.status(401).json({ detail: "Invalid Google token" });
    }
  });

  // ==================== USER ENDPOINTS ====================
  // Admin only: Create new user
  registerBothPaths("post", "/users", async (req, res) => {
    const { name, email } = req.body;

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    // Verify admin access
    const admin = await verifyAdmin(token);
    if (!admin) {
      return res.status(403).json({ detail: "Forbidden: Admin access required" });
    }

    if (!email) {
      return res.status(400).send("Error: Email is required");
    }

    try {
      const user = await storage.createUser({ name, email });
      res.send(`User ${user.name || user.email} created successfully.`);
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Admin only: List all users
  registerBothPaths("get", "/users", async (req, res) => {
    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    // Verify admin access
    const admin = await verifyAdmin(token);
    if (!admin) {
      return res.status(403).json({ detail: "Forbidden: Admin access required" });
    }

    try {
      const users = await storage.listUsers();
      
      // Add event count for each user (like in Python backend)
      const usersWithEventCount = await Promise.all(users.map(async (user) => {
        const events = await storage.getEventsByOwner(user.email);
        return {
          ...user,
          event_count: events.length
        };
      }));

      res.json(usersWithEventCount);
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Admin only: Get user by ID
  registerBothPaths("get", "/users/:user_uuid", async (req, res) => {
    const { user_uuid } = req.params;

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    // Verify admin access
    const admin = await verifyAdmin(token);
    if (!admin) {
      return res.status(403).json({ detail: "Forbidden: Admin access required" });
    }

    if (!user_uuid) {
      return res.status(400).send("Error: User ID is required");
    }

    try {
      const user = await storage.getUser(user_uuid);
      if (!user) {
        return res.status(404).json({ detail: "User not found" });
      }

      res.json({
        id: user.id,
        email: user.email,
        active: user.active,
        created_at: user.created_at,
        last_login: user.last_login,
        name: user.name,
        role: user.role,
        event_credit: user.event_credit
      });
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Admin only: Update user
  registerBothPaths("put", "/users/:user_uuid", async (req, res) => {
    const { user_uuid } = req.params;
    const { name, email, role, active, event_credit } = req.body;

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    // Verify admin access
    const admin = await verifyAdmin(token);
    if (!admin) {
      return res.status(403).json({ detail: "Forbidden: Admin access required" });
    }

    if (!user_uuid) {
      return res.status(400).send("Error: User ID is required");
    }

    try {
      const updatedUser = await storage.updateUser(user_uuid, {
        name,
        email,
        role,
        active,
        event_credit
      });

      if (!updatedUser) {
        return res.status(404).json({ detail: "User not found" });
      }

      res.json(updatedUser);
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Admin only: Delete user
  registerBothPaths("delete", "/users/:user_uuid", async (req, res) => {
    const { user_uuid } = req.params;

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    // Verify admin access
    const admin = await verifyAdmin(token);
    if (!admin) {
      return res.status(403).json({ detail: "Forbidden: Admin access required" });
    }

    if (!user_uuid) {
      return res.status(400).send("Error: User ID is required");
    }

    try {
      const deleted = await storage.deleteUser(user_uuid);
      if (!deleted) {
        return res.status(404).send("User not found");
      }
      res.send(`User ${user_uuid} deleted successfully.`);
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // ==================== EVENT ENDPOINTS ====================
  // Create event - requires authentication
  registerBothPaths("post", "/events", async (req, res) => {
    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      // Verify token and get user email
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const eventData = createEventSchema.parse(req.body);
      
      // Generate unique event_id
      const event_id = generateShortId();

      // Bind event_owner to authenticated user (prevent spoofing)
      const event = await storage.createEvent({
        ...eventData,
        event_id,
        event_owner: email // Override with authenticated email
      });

      res.json(event);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ detail: "Invalid event data", errors: error.errors });
      }
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Admin only: List all events
  registerBothPaths("get", "/events", async (req, res) => {
    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    // Verify admin access
    const admin = await verifyAdmin(token);
    if (!admin) {
      return res.status(403).json({ detail: "Forbidden: Admin access required" });
    }

    try {
      const events = await storage.listEvents();
      
      // Add image count for each event
      const eventsWithImageCount = await Promise.all(events.map(async (event) => {
        const imageCount = await storage.getEventImageCount(event.event_id);
        return {
          ...event,
          image_count: imageCount
        };
      }));

      res.json(eventsWithImageCount);
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  registerBothPaths("get", "/events/:event_id", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).send("Error: Event ID is required");
    }

    try {
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      res.json(event);
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Owner/Co-host only: Update event
  registerBothPaths("patch", "/events/:event_id", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).send("Error: Event ID is required");
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      // Verify token and get user email
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get existing event
      const existingEvent = await storage.getEvent(event_id);
      if (!existingEvent) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Check if user is owner or co-host
      const isAuthorized = await isEventOwnerOrCoHost(email, existingEvent);
      if (!isAuthorized) {
        console.warn(`Access denied: ${email} attempted to update event ${event_id}`);
        return res.status(403).json({ 
          detail: "Forbidden: Only event owner or co-hosts can update this event" 
        });
      }

      // NB: Vi sletter IKKE gammelt cover-photo fra GCS når det erstattes.
      // Gamle covers blir orphan-filer i bucket — trygt og ikke-blokkerende.
      // Cleanup av orphans gjøres i separat admin-prosess med karantene
      // (se EVENERO-CLEANUP-PLAN.md). Dette beskytter aktiv kunde-data.

      // Update event
      const event = await storage.updateEvent(event_id, req.body);

      res.json(event);
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Owner/Co-host or Admin: Delete event
  registerBothPaths("delete", "/events/:event_id", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).send("Error: Event ID is required");
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      // Verify token and get user
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ detail: "User not found" });
      }

      // Try to get event by short event_id first, then by UUID
      let event = await storage.getEvent(event_id);
      if (!event) {
        // Fallback: try as UUID
        event = await storage.getEventById(event_id);
      }
      
      if (!event) {
        return res.status(404).send("Event not found");
      }

      // Check if user is admin OR owner/co-host
      const isAdmin = user.role === 'superuser';
      const isAuthorized = isAdmin || await isEventOwnerOrCoHost(email, event);

      if (!isAuthorized) {
        console.warn(`Access denied: ${email} attempted to delete event ${event_id}`);
        return res.status(403).json({ 
          detail: "Forbidden: Only event owner, co-hosts, or admins can delete this event" 
        });
      }

      // Delete using UUID (the actual database primary key)
      const deleted = await storage.deleteEvent(event.id);
      if (!deleted) {
        return res.status(404).send("Event not found");
      }

      res.json({
        status: "success",
        message: `Event ${event_id} deleted successfully`
      });
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // Owner/Co-host only: Activate event (uses event credits)
  registerBothPaths("post", "/events/:event_id/activate", async (req, res) => {
    const { event_id } = req.params;

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      const email = payload.email;

      if (!email) {
        return res.status(401).json({ detail: "Unauthorized" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Check if user is owner or co-host
      const isAuthorized = await isEventOwnerOrCoHost(email, event);
      if (!isAuthorized) {
        console.warn(`Access denied: ${email} attempted to activate event ${event_id}`);
        return res.status(403).json({ 
          detail: "Forbidden: Only event owner or co-hosts can activate this event" 
        });
      }

      if (event.active) {
        return res.status(400).json({ detail: "Event is already active" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ detail: "Could not find user" });
      }

      const eventCredit = user.event_credit ?? 0;
      if (eventCredit < 1) {
        return res.status(400).json({ detail: "Insufficient event credit" });
      }

      await storage.updateEvent(event_id, { active: true });
      await storage.updateUser(user.id, { event_credit: eventCredit - 1 });

      res.json({
        status: "success",
        message: "Event activated successfully"
      });
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        return res.status(401).json({ detail: "Invalid token" });
      }
      if (error instanceof jwt.TokenExpiredError) {
        return res.status(401).json({ detail: "Token has expired" });
      }
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("post", "/events/media-metadata", async (req, res) => {
    const mediaList = req.body;

    if (!Array.isArray(mediaList) || mediaList.length === 0) {
      return res.status(400).send("Error: Request body must be a non-empty array");
    }

    const batch_id = mediaList[0]?.batch_id;
    const event_id = mediaList[0]?.event_id;

    if (!batch_id || !event_id) {
      return res.status(400).send("Error: Could not get Batch ID or Event ID");
    }

    try {
      // Check if moderation is enabled for this event
      const event = await storage.getEvent(event_id);
      const moderationEnabled = event?.image_moderation ?? false;

      const images = mediaList.map(item => ({
        // Hvis klienten sender media_id (fra v2 signed URL-respons), bruk det
        // som primary key. Da matcher event_images.id mediaId i GCS-pathen
        // (originals/{eventId}/{mediaId}.{ext}), og gallery-frontend kan
        // bygge derived-paths direkte fra item.id.
        // Hvis media_id mangler (eldre klient), faller vi tilbake til
        // Postgres defaultRandom() ved å la id være undefined.
        ...(item.media_id ? { id: item.media_id } : {}),
        event_id,
        batch_id,
        image_url: item.url,
        sequence: item.sequence,
        title: item.title,
        uploaded_by: item.uploaded_by,
        uploaded_at: item.uploaded_at ? new Date(item.uploaded_at) : new Date(),
        share_consent: false,
        file_size: item.file_size || null,
        file_extension: item.file_extension || null,
        moderation_status: moderationEnabled ? 'pending' : 'approved'
      }));

      const savedImages = await storage.addEventImages(images);
      
      // Track guest participation if uploader email is provided
      const uploaderEmail = mediaList[0]?.uploaded_by;
      if (uploaderEmail && uploaderEmail.includes('@')) {
        try {
          await storage.upsertGuestParticipation(uploaderEmail, event_id, 'upload');
        } catch (guestError) {
          console.error('[UPLOAD] Error tracking guest participation:', guestError);
          // Don't fail the upload if tracking fails
        }
      }
      
      res.json(savedImages.map(img => ({
        id: img.id,
        url: img.image_url,
        sequence: img.sequence,
        title: img.title,
        uploaded_by: img.uploaded_by,
        uploaded_at: img.uploaded_at
      })));
    } catch (error) {
      res.status(500).send(`Error: ${(error as Error).message}`);
    }
  });

  // ==================== EVENT HELPER ENDPOINTS ====================
  registerBothPaths("get", "/event-exists/:event_id", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    try {
      const exists = await storage.checkEventExists(event_id);
      res.json({ exists });
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Owner or Admin only: Get events by owner email
  registerBothPaths("get", "/events-by-owner/:owner_email", async (req, res) => {
    const { owner_email } = req.params;

    if (!owner_email) {
      return res.status(400).json({ detail: "Owner email is required" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      // Verify token and get user
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ detail: "User not found" });
      }

      // Check if user is admin OR the owner themselves
      const isAdmin = user.role === 'superuser';
      const isOwner = email.toLowerCase() === owner_email.toLowerCase();

      if (!isAdmin && !isOwner) {
        console.warn(`Access denied: ${email} attempted to list events for ${owner_email}`);
        return res.status(403).json({ 
          detail: "Forbidden: You can only view your own events" 
        });
      }

      const events = await storage.getEventsByOwner(owner_email);
      
      // Add image count for each event
      const eventsWithImageCount = await Promise.all(events.map(async (event) => {
        const imageCount = await storage.getEventImageCount(event.event_id);
        return {
          ...event,
          image_count: imageCount
        };
      }));
      
      res.json(eventsWithImageCount);
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get events where user is a guest (participated via upload or reminder)
  registerBothPaths("get", "/guest/events", async (req, res) => {
    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      // Verify token and get user
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get events where user is a guest
      const guestEvents = await storage.getGuestEventsByEmail(email);
      
      // Add image count for each event
      const eventsWithDetails = await Promise.all(guestEvents.map(async (event) => {
        const imageCount = await storage.getEventImageCount(event.event_id);
        return {
          ...event,
          image_count: imageCount,
          user_role: 'guest' as const
        };
      }));
      
      res.json(eventsWithDetails);
    } catch (error) {
      console.error('[GUEST EVENTS] Error:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get user's role for a specific event
  registerBothPaths("get", "/events/:event_id/user-role", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    // Get token from Authorization header (optional for this endpoint)
    const token = getTokenFromHeader(req);
    
    try {
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // If no token, user is not logged in - return none
      if (!token) {
        return res.json({ role: 'none', event_id });
      }

      // Verify token and get user email
      const email = await verifyToken(token);
      if (!email) {
        return res.json({ role: 'none', event_id });
      }

      // Get user's role for this event
      const role = await storage.getUserRoleForEvent(email, event);
      res.json({ role, event_id, email });
    } catch (error) {
      console.error('[USER ROLE] Error:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("get", "/events/:event_id/images", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    try {
      const images = await storage.getEventImages(event_id);
      res.json(images);
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("get", "/events/:event_id/images-count", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    try {
      const count = await storage.getEventImageCount(event_id);
      res.json(count);
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("get", "/events/:event_id/contributors-count", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    try {
      const count = await storage.getEventContributorCount(event_id);
      res.json(count);
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Owner/Co-host only: Storage usage endpoint
  registerBothPaths("get", "/events/:event_id/storage-usage", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      // Verify token
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Check if user is owner or co-host
      const isAuthorized = await isEventOwnerOrCoHost(email, event);
      if (!isAuthorized) {
        console.warn(`Access denied: ${email} attempted to view storage usage for event ${event_id}`);
        return res.status(403).json({ 
          detail: "Forbidden: Only event owner or co-hosts can view storage usage" 
        });
      }

      const usage = await storage.getEventStorageUsage(event_id);
      
      // Convert limits from GB to bytes (default 150GB if not set)
      const GB = 1024 * 1024 * 1024;
      const imageLimitBytes = (event.image_storage_limit_gb ?? 150) * GB;
      const videoLimitBytes = (event.video_storage_limit_gb ?? 150) * GB;
      const totalLimitBytes = event.total_storage_limit_gb ? event.total_storage_limit_gb * GB : null;

      res.json({
        usage: {
          imageBytes: usage.imageBytes,
          videoBytes: usage.videoBytes,
          totalBytes: usage.totalBytes,
          imageCount: usage.imageCount,
          videoCount: usage.videoCount
        },
        limits: {
          imageLimitBytes,
          videoLimitBytes,
          totalLimitBytes,
          imageLimitGb: event.image_storage_limit_gb ?? 150,
          videoLimitGb: event.video_storage_limit_gb ?? 150,
          totalLimitGb: event.total_storage_limit_gb
        },
        remaining: {
          imageBytes: Math.max(0, imageLimitBytes - usage.imageBytes),
          videoBytes: Math.max(0, videoLimitBytes - usage.videoBytes),
          totalBytes: totalLimitBytes ? Math.max(0, totalLimitBytes - usage.totalBytes) : null
        }
      });
    } catch (error) {
      console.error("Storage usage error:", error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Check storage limit before upload
  registerBothPaths("post", "/events/:event_id/check-storage", async (req, res) => {
    const { event_id } = req.params;
    const { files } = req.body; // Array of { size: number, extension: string }

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ detail: "Files array is required" });
    }

    try {
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      const usage = await storage.getEventStorageUsage(event_id);
      
      // Calculate new upload sizes
      const videoExtensions = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp'];
      let newImageBytes = 0;
      let newVideoBytes = 0;
      
      for (const file of files) {
        const ext = (file.extension || '').toLowerCase().replace('.', '');
        if (videoExtensions.includes(ext)) {
          newVideoBytes += file.size || 0;
        } else {
          newImageBytes += file.size || 0;
        }
      }

      // Convert limits from GB to bytes (default 150GB if not set)
      const GB = 1024 * 1024 * 1024;
      const imageLimitBytes = (event.image_storage_limit_gb ?? 150) * GB;
      const videoLimitBytes = (event.video_storage_limit_gb ?? 150) * GB;
      const totalLimitBytes = event.total_storage_limit_gb ? event.total_storage_limit_gb * GB : null;

      // Check limits
      const wouldExceedImageLimit = (usage.imageBytes + newImageBytes) > imageLimitBytes;
      const wouldExceedVideoLimit = (usage.videoBytes + newVideoBytes) > videoLimitBytes;
      const wouldExceedTotalLimit = totalLimitBytes && ((usage.totalBytes + newImageBytes + newVideoBytes) > totalLimitBytes);

      const allowed = !wouldExceedImageLimit && !wouldExceedVideoLimit && !wouldExceedTotalLimit;

      res.json({
        allowed,
        wouldExceed: {
          image: wouldExceedImageLimit,
          video: wouldExceedVideoLimit,
          total: wouldExceedTotalLimit || false
        },
        current: {
          imageBytes: usage.imageBytes,
          videoBytes: usage.videoBytes,
          totalBytes: usage.totalBytes
        },
        requested: {
          imageBytes: newImageBytes,
          videoBytes: newVideoBytes,
          totalBytes: newImageBytes + newVideoBytes
        },
        limits: {
          imageLimitBytes,
          videoLimitBytes,
          totalLimitBytes,
          imageLimitGb: event.image_storage_limit_gb ?? 150,
          videoLimitGb: event.video_storage_limit_gb ?? 150,
          totalLimitGb: event.total_storage_limit_gb
        }
      });
    } catch (error) {
      console.error("Check storage error:", error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("get", "/events/:event_id/co-hosts", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    try {
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }
      
      // Return co-hosts as an array - API client will wrap with success/data
      const coHosts = event.event_co_host ? event.event_co_host.split(',').map(h => h.trim()) : [];
      res.json({ co_hosts: coHosts });
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Invite co-host - Owner only
  registerBothPaths("post", "/events/:event_id/invite-co-host", async (req, res) => {
    const { event_id } = req.params;
    const { email } = req.body;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ detail: "Valid email is required" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      // Verify token and get user
      const userEmail = await verifyToken(token);
      if (!userEmail) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get event
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Only owner can invite co-hosts
      if (event.event_owner?.toLowerCase() !== userEmail.toLowerCase()) {
        return res.status(403).json({ detail: "Only the event owner can invite co-hosts" });
      }

      // Get current co-hosts
      const currentCoHosts = event.event_co_host ? event.event_co_host.split(',').map(h => h.trim().toLowerCase()) : [];
      
      // Check if email is already a co-host
      if (currentCoHosts.includes(email.toLowerCase())) {
        return res.status(400).json({ detail: "This email is already a co-host" });
      }

      // Check if email is the owner
      if (event.event_owner?.toLowerCase() === email.toLowerCase()) {
        return res.status(400).json({ detail: "Owner cannot be added as co-host" });
      }

      // Add new co-host
      const newCoHosts = [...currentCoHosts, email.toLowerCase()].join(',');
      await storage.updateEvent(event_id, { event_co_host: newCoHosts });

      // Get inviter's name
      const inviter = await storage.getUserByEmail(userEmail);
      const inviterName = inviter?.name || userEmail;

      // Send invitation email
      const eventUrl = `${getBaseUrl(req)}/gallery/${event_id}`;
      const { sendCoHostInvitationEmail } = await import('./email');
      await sendCoHostInvitationEmail(email, event.event_name || 'Event', inviterName, eventUrl, 'en');

      res.json({ success: true, message: "Co-host invited successfully" });
    } catch (error) {
      console.error('Error inviting co-host:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Remove co-host - Owner only
  registerBothPaths("delete", "/events/:event_id/co-hosts/:cohost_email", async (req, res) => {
    const { event_id, cohost_email } = req.params;

    if (!event_id || !cohost_email) {
      return res.status(400).json({ detail: "Event ID and co-host email are required" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      // Verify token and get user
      const userEmail = await verifyToken(token);
      if (!userEmail) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get event
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Only owner can remove co-hosts
      if (event.event_owner?.toLowerCase() !== userEmail.toLowerCase()) {
        return res.status(403).json({ detail: "Only the event owner can remove co-hosts" });
      }

      // Get current co-hosts
      const currentCoHosts = event.event_co_host ? event.event_co_host.split(',').map(h => h.trim().toLowerCase()) : [];
      
      // Remove the co-host
      const newCoHosts = currentCoHosts.filter(h => h !== cohost_email.toLowerCase()).join(',');
      await storage.updateEvent(event_id, { event_co_host: newCoHosts || null });

      res.json({ success: true, message: "Co-host removed successfully" });
    } catch (error) {
      console.error('Error removing co-host:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // ==================== IMAGE LIKES ENDPOINTS ====================
  
  // Like an image - Owner/Co-host only
  registerBothPaths("post", "/events/:event_id/images/:image_id/like", async (req, res) => {
    const { event_id, image_id } = req.params;

    if (!event_id || !image_id) {
      return res.status(400).json({ detail: "Event ID and image ID are required" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      // Verify token and get user
      const userEmail = await verifyToken(token);
      if (!userEmail) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get event
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Check if user is owner or co-host
      const role = await storage.getUserRoleForEvent(userEmail, event);
      if (role !== 'owner' && role !== 'cohost') {
        return res.status(403).json({ detail: "Only owners and co-hosts can like images" });
      }

      // Like the image
      const success = await storage.likeImage(event_id, image_id, userEmail);
      
      if (success) {
        res.json({ success: true, message: "Image liked" });
      } else {
        res.status(500).json({ detail: "Failed to like image" });
      }
    } catch (error) {
      console.error('Error liking image:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Unlike an image - Owner/Co-host only
  registerBothPaths("delete", "/events/:event_id/images/:image_id/like", async (req, res) => {
    const { event_id, image_id } = req.params;

    if (!event_id || !image_id) {
      return res.status(400).json({ detail: "Event ID and image ID are required" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      // Verify token and get user
      const userEmail = await verifyToken(token);
      if (!userEmail) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get event
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Check if user is owner or co-host
      const role = await storage.getUserRoleForEvent(userEmail, event);
      if (role !== 'owner' && role !== 'cohost') {
        return res.status(403).json({ detail: "Only owners and co-hosts can unlike images" });
      }

      // Unlike the image
      const success = await storage.unlikeImage(event_id, image_id, userEmail);
      
      if (success) {
        res.json({ success: true, message: "Image unliked" });
      } else {
        res.status(500).json({ detail: "Failed to unlike image" });
      }
    } catch (error) {
      console.error('Error unliking image:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get likes for multiple images
  registerBothPaths("post", "/events/:event_id/images/likes", async (req, res) => {
    const { event_id } = req.params;
    const { image_ids } = req.body;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    if (!Array.isArray(image_ids)) {
      return res.status(400).json({ detail: "image_ids must be an array" });
    }

    try {
      // Optional: Get user email for checking if user liked
      let userEmail: string | undefined;
      const token = getTokenFromHeader(req);
      if (token) {
        userEmail = await verifyToken(token) || undefined;
      }

      const likes = await storage.getImageLikes(event_id, image_ids, userEmail);
      res.json({ likes });
    } catch (error) {
      console.error('Error getting image likes:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get liked images for an event (for curated view)
  registerBothPaths("get", "/events/:event_id/liked-images", async (req, res) => {
    const { event_id } = req.params;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    try {
      const likedImages = await storage.getLikedImages(event_id);
      res.json({ images: likedImages });
    } catch (error) {
      console.error('Error getting liked images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Toggle curated public gallery - Owner/Co-host only
  registerBothPaths("post", "/events/:event_id/curated-public", async (req, res) => {
    const { event_id } = req.params;
    const { enabled } = req.body;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ detail: "enabled must be a boolean" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      // Verify token and get user
      const userEmail = await verifyToken(token);
      if (!userEmail) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get event
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Check if user is owner or co-host
      const role = await storage.getUserRoleForEvent(userEmail, event);
      if (role !== 'owner' && role !== 'cohost') {
        return res.status(403).json({ detail: "Only owners and co-hosts can toggle curated gallery" });
      }

      // Update event
      await storage.updateEvent(event_id, { curated_public_enabled: enabled } as any);
      
      res.json({ success: true, curated_public_enabled: enabled });
    } catch (error) {
      console.error('Error toggling curated gallery:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // ==================== EVENT REMINDER ENDPOINTS ====================
  registerBothPaths("post", "/events/:event_id/reminder", async (req, res) => {
    const { event_id } = req.params;
    const { email, hours = 24 } = req.body;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ detail: "Valid email is required" });
    }

    // Validate hours (1-168, i.e. up to 1 week)
    const hoursNum = Math.min(Math.max(parseInt(hours) || 24, 1), 168);

    try {
      // Check if reminder already exists for this email + event
      console.log('[REMINDER] Checking for existing reminder:', event_id, email.toLowerCase());
      const existingReminder = await storage.getEventReminder(event_id, email.toLowerCase());
      console.log('[REMINDER] Existing reminder result:', existingReminder);
      
      if (existingReminder) {
        console.log('[REMINDER] Reminder already exists, returning existing');
        return res.json({ 
          success: true, 
          message: "Reminder already registered",
          reminder: existingReminder 
        });
      }

      // Calculate scheduled time (X hours from now)
      const scheduledFor = new Date(Date.now() + hoursNum * 60 * 60 * 1000);
      console.log('[REMINDER] Creating new reminder with scheduled_for:', scheduledFor.toISOString());

      // Determine locale from browser language for confirmation email
      const acceptLang = req.headers['accept-language'] || '';
      let locale: 'en' | 'nb' | 'sv' | 'es' = 'en';
      if (acceptLang.startsWith('nb') || acceptLang.startsWith('no')) {
        locale = 'nb';
      } else if (acceptLang.startsWith('sv')) {
        locale = 'sv';
      } else if (acceptLang.startsWith('es')) {
        locale = 'es';
      }
      console.log('[REMINDER] Detected locale from browser:', locale);

      // Create new reminder with detected locale
      const reminder = await storage.createEventReminder({
        email: email.toLowerCase(),
        event_id,
        scheduled_for: scheduledFor,
        locale
      });
      console.log('[REMINDER] Created reminder:', JSON.stringify(reminder));

      // Track guest participation
      try {
        await storage.upsertGuestParticipation(email.toLowerCase(), event_id, 'reminder');
      } catch (guestError) {
        console.error('[REMINDER] Error tracking guest participation:', guestError);
        // Don't fail the reminder if tracking fails
      }

      // Send confirmation email
      try {
        const event = await storage.getEvent(event_id);
        if (event) {
          const { sendReminderConfirmationEmail } = await import('./email');
          const galleryUrl = `${getBaseUrl(req)}/gallery/${event_id}`;
          await sendReminderConfirmationEmail(
            email.toLowerCase(),
            event.event_name || 'Event',
            galleryUrl,
            scheduledFor,
            locale
          );
          console.log('[REMINDER] Confirmation email sent to:', email);
        }
      } catch (emailError) {
        console.error('[REMINDER] Failed to send confirmation email:', emailError);
        // Don't fail the request if email fails
      }

      res.json({ 
        success: true, 
        message: "Reminder registered successfully",
        reminder 
      });
    } catch (error: any) {
      console.error('[REMINDER] Error creating reminder:', error);
      console.error('[REMINDER] Error message:', error?.message);
      console.error('[REMINDER] Error stack:', error?.stack);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("get", "/events/:event_id/reminder/:email", async (req, res) => {
    const { event_id, email } = req.params;

    if (!event_id || !email) {
      return res.status(400).json({ detail: "Event ID and email are required" });
    }

    try {
      const reminder = await storage.getEventReminder(event_id, email.toLowerCase());
      res.json({ 
        exists: !!reminder,
        reminder 
      });
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Process pending reminders - can be called by a cron job
  registerBothPaths("post", "/process-reminders", async (req, res) => {
    console.log('[REMINDER] Processing pending reminders...');
    
    try {
      const pendingReminders = await storage.getPendingReminders();
      console.log(`[REMINDER] Found ${pendingReminders.length} pending reminders`);
      
      let sent = 0;
      let failed = 0;
      
      // PUBLIC_APP_URL settes per miljø: staging=evenero-app-staging.vercel.app, prod=app.evenero.com
      const baseUrl = process.env.PUBLIC_APP_URL || "https://app.evenero.com";
      
      for (const reminder of pendingReminders) {
        try {
          const event = await storage.getEvent(reminder.event_id);
          if (!event) {
            console.log(`[REMINDER] Event ${reminder.event_id} not found, marking as sent`);
            await storage.markReminderSent(reminder.id);
            continue;
          }
          
          const { sendEventReminderEmail } = await import('./email');
          const galleryUrl = `${baseUrl}/gallery/${reminder.event_id}`;
          
          // Determine locale: stored reminder locale > user preference > 'en'
          const user = await storage.getUserByEmail(reminder.email);
          let locale: 'en' | 'nb' | 'sv' | 'es' = 'en';
          const reminderLocale = (reminder as any).locale;
          if (reminderLocale === 'nb' || reminderLocale === 'sv' || reminderLocale === 'en' || reminderLocale === 'es') {
            locale = reminderLocale;
          } else if (user?.preferred_locale === 'nb' || user?.preferred_locale === 'sv' || user?.preferred_locale === 'en' || user?.preferred_locale === 'es') {
            locale = user.preferred_locale as 'en' | 'nb' | 'sv' | 'es';
          }
          
          console.log(`[REMINDER] Sending to ${reminder.email} with locale: ${locale}`);
          
          const success = await sendEventReminderEmail(
            reminder.email,
            event.event_name || 'Event',
            galleryUrl,
            locale
          );
          
          if (success) {
            await storage.markReminderSent(reminder.id);
            sent++;
            console.log(`[REMINDER] Sent reminder to ${reminder.email} for event ${reminder.event_id}`);
          } else {
            failed++;
            console.error(`[REMINDER] Failed to send reminder to ${reminder.email}`);
          }
        } catch (reminderError) {
          failed++;
          console.error(`[REMINDER] Error processing reminder ${reminder.id}:`, reminderError);
        }
      }
      
      res.json({ 
        success: true, 
        processed: pendingReminders.length,
        sent,
        failed 
      });
    } catch (error) {
      console.error('[REMINDER] Error processing reminders:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("post", "/share-consent", async (req, res) => {
    const { image_ids } = req.body;

    if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "No image IDs provided" });
    }

    try {
      const updatedCount = await storage.updateShareConsent(image_ids, true);
      res.json({ message: "Share consent updated successfully", count: updatedCount });
    } catch (error) {
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // ==================== UPLOAD ENDPOINTS ====================
  // Support both GET (for manage-event cover uploads) and POST (for regular uploads)
  registerBothPaths("get", "/generate-signed-url", async (req, res) => {
    const fileName = req.query.file_name as string;
    const clientContentType = req.query.content_type as string | undefined;
    const clientEventId = req.query.event_id as string | undefined;

    if (!fileName) {
      return res.status(400).json({ detail: "Missing file_name parameter" });
    }

    try {
      const { generateUploadUrl } = await import('./gcs');
      // event_id fra query foretrekkes — gir korrekt v2-path
      // originals/{eventId}/{mediaId}.{ext}. Hvis ikke sendt: fall tilbake
      // til hardkodet 'covers'/'uploads' (legacy bakoverkompatibilitet).
      const eventId = clientEventId || (fileName.startsWith('cover-') ? 'covers' : 'uploads');

      // Content-Type-håndtering:
      // 1. Hvis client sender content_type-query (anbefalt) — bruk den. Da matcher
      //    signed URL-en eksakt det nettleseren sender på PUT.
      // 2. Hvis ikke (bakoverkompatibilitet med eldre klient): gjett fra extension.
      //
      // Bug-historikk: tidligere mappet både .mp4 og .mov til 'video/mp4', men
      // nettlesere sender 'video/quicktime' for .mov → signaturen avvises av GCS
      // med 403 Forbidden. Tabellen under er korrigert. Hovedfix er likevel at
      // klienten nå sender content_type eksplisitt.
      const extensionMime: Record<string, string> = {
        // Video
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        m4v: 'video/x-m4v',
        avi: 'video/x-msvideo',
        wmv: 'video/x-ms-wmv',
        webm: 'video/webm',
        '3gp': 'video/3gpp',
        mkv: 'video/x-matroska',
        // Image
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        heic: 'image/heic',
        heif: 'image/heif',
        avif: 'image/avif',
      };

      const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
      const contentType = clientContentType || extensionMime[extension] || 'image/jpeg';
      
      const result = await generateUploadUrl(
        eventId, 
        'single', 
        1, 
        fileName, 
        contentType
      );
      
      if (!result) {
        return res.status(500).json({ detail: "Failed to generate upload URL" });
      }

      res.json({
        url: result.url,
        public_url: result.publicUrl,
        media_id: result.mediaId,
      });
    } catch (error) {
      console.error('Error generating signed URL (GET):', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("post", "/generate-signed-url", async (req, res) => {
    const { event_id, batch_id, sequence, filename, content_type } = req.body;

    if (!event_id || !batch_id || sequence === undefined || !filename || !content_type) {
      return res.status(400).json({ detail: "Missing required fields" });
    }

    try {
      // Check if uploads are allowed for this event
      const event = await storage.getEvent(event_id);
      if (event) {
        const uploadStatus = getUploadStatus(event.created_at, event.uploads_disabled ?? false);
        if (!uploadStatus.canUpload) {
          return res.status(403).json({ 
            detail: "Uploads are closed for this event",
            reason: uploadStatus.isExpired ? 'expired' : 'disabled',
            message: uploadStatus.statusText
          });
        }
      }

      const { generateUploadUrl } = await import('./gcs');
      const result = await generateUploadUrl(event_id, batch_id, sequence, filename, content_type);
      
      if (!result) {
        return res.status(500).json({ detail: "Failed to generate upload URL" });
      }

      res.json({
        upload_url: result.url,
        public_url: result.publicUrl,
        media_id: result.mediaId,
      });
    } catch (error) {
      console.error('Error generating signed URL:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  registerBothPaths("post", "/archive-images", async (req, res) => {
    const { event_id, image_ids } = req.body;

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID is required" });
    }

    if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "No image IDs provided" });
    }

    try {
      // Archive (soft delete) images by marking them as archived - with event_id verification
      const deletedCount = await storage.deleteEventImages(event_id, image_ids);
      res.json({ 
        message: "Images archived successfully", 
        count: deletedCount 
      });
    } catch (error) {
      console.error('Error archiving images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Webhook endpoint - receives callback from Cloud Run when zip is ready
  // Register on /api/zip-ready directly (Cloud Run calls this path)
  app.post("/api/zip-ready", async (req, res) => {
    console.error('=== WEBHOOK RECEIVED ===');
    console.error('Headers:', JSON.stringify(req.headers, null, 2));
    console.error('Body:', JSON.stringify(req.body, null, 2));
    
    // Validate API key
    const apiKey = req.headers['x-api-key'] as string;
    const expectedKey = process.env.WEBHOOK_API_KEY;
    
    if (!expectedKey) {
      console.error('WARNING: WEBHOOK_API_KEY not configured in environment');
      return res.status(500).json({ error: "Server configuration error" });
    }
    
    if (!apiKey || apiKey !== expectedKey) {
      console.error('Invalid API key received');
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    try {
      const { status, zipUrl, fileCount, sizeMB, userEmail, eventName, error } = req.body;
      
      console.error('Extracted data:', { status, hasZipUrl: !!zipUrl, userEmail, eventName });
      
      // Process webhook if authentication successful
      if (status === 'completed' && zipUrl && userEmail) {
        console.error('Calling sendZipDownloadEmail...');
        
        // Get user's preferred locale for email (normalize email case for lookup)
        const normalizedEmail = userEmail.toLowerCase().trim();
        const user = await storage.getUserByEmail(normalizedEmail);
        const userLocale = (user?.preferred_locale || 'en') as 'en' | 'nb';
        
        const { sendZipDownloadEmail } = await import('./email');
        const result = await sendZipDownloadEmail(
          userEmail,
          eventName || 'your event',
          zipUrl,
          fileCount || 0,
          sizeMB || 0,
          userLocale
        );
        console.error('Email send result:', result);
        console.error('Email sent to:', userEmail);
      } else if (status === 'failed' || error) {
        console.error('Zip generation failed:', error);
        // Could optionally send an error email to user here
      } else {
        console.error('Missing required data - not sending email');
        console.error('Status:', status, 'ZipUrl:', zipUrl ? 'present' : 'missing', 'UserEmail:', userEmail);
      }
      
      res.json({ message: "OK" });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).json({ error: String(err) });
    }
  });

  registerBothPaths("post", "/download-images", async (req, res) => {
    const { image_ids, event_id } = req.body;

    if (!image_ids || !Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "No image IDs provided" });
    }

    if (!event_id) {
      return res.status(400).json({ detail: "Event ID required" });
    }

    // Get token from Authorization header
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required. Include token in Authorization header." });
    }

    try {
      // Verify token and get authenticated user email
      const authenticatedEmail = await verifyToken(token);
      if (!authenticatedEmail) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get event details
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Check if authenticated user has access to the event
      const hasAccess = await hasEventAccess(authenticatedEmail, event);
      if (!hasAccess) {
        console.warn(`Access denied: ${authenticatedEmail} attempted to download from event ${event_id}`);
        return res.status(403).json({ 
          detail: "Access denied. You don't have permission to download images from this event." 
        });
      }

      const eventName = event.event_name || 'your event';
      const user_email = authenticatedEmail; // Use authenticated email for notification

      // Get media objects to extract filenames from image_url
      const mediaObjects = await storage.getEventImagesByIds(image_ids);
      
      // Extract filenames from image_url (everything after /images/)
      const mediaFilenames = mediaObjects.map(media => {
        const url = media.image_url;
        const match = url.match(/\/images\/(.+)$/);
        return match ? match[1] : null;
      }).filter(Boolean); // Remove any nulls
      
      if (mediaFilenames.length === 0) {
        return res.status(400).json({ detail: "Could not extract filenames from image URLs" });
      }
      
      console.log(`Converting ${image_ids.length} UUIDs to ${mediaFilenames.length} filenames`);
      console.log('Sample filename:', mediaFilenames[0]);

      // Call new Cloud Run zipper service with API key
      const cloudRunUrl = process.env.CLOUD_RUN_ZIP_URL || 'https://zipper-service-467452422363.europe-west1.run.app/zip';
      const apiKey = process.env.WEBHOOK_API_KEY;
      
      if (!apiKey) {
        console.error('WARNING: WEBHOOK_API_KEY not configured');
        return res.status(500).json({ detail: "Server configuration error - missing API key" });
      }
      
      console.log(`Calling Cloud Run zipper service for ${mediaFilenames.length} images...`);

      const response = await fetch(cloudRunUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey
        },
        body: JSON.stringify({
          mediaIds: mediaFilenames,
          userEmail: user_email,
          eventName: eventName,
          eventId: event_id
        })
      });

      if (!response.ok) {
        throw new Error(`Cloud Run error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { estimatedTime?: string };

      // Return immediate response - user will get email when zip is ready
      res.json({
        message: "Zip generation started. You will receive an email when ready.",
        estimatedTime: data.estimatedTime || "5-30 minutes"
      });
    } catch (error) {
      console.error('Error calling Cloud Run:', error);
      res.status(500).json({ detail: "Failed to start zip generation" });
    }
  });

  // Feature request / Bug report submission (public endpoint with rate limiting)
  const feedbackRateLimitStore = new Map<string, { count: number; firstRequest: number }>();
  const FEEDBACK_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  const MAX_FEEDBACK_PER_HOUR = 5; // Max 5 feedback submissions per IP per hour
  
  registerBothPaths("post", "/feature-requests", async (req, res) => {
    try {
      // Get client IP for rate limiting
      const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || 'unknown';
      const rateLimitKey = `feedback:${clientIp}`;
      const now = Date.now();
      
      // Check rate limit
      const entry = feedbackRateLimitStore.get(rateLimitKey);
      if (entry) {
        // Reset if window passed
        if (now - entry.firstRequest > FEEDBACK_RATE_LIMIT_WINDOW_MS) {
          feedbackRateLimitStore.delete(rateLimitKey);
        } else if (entry.count >= MAX_FEEDBACK_PER_HOUR) {
          const retryAfter = Math.ceil((entry.firstRequest + FEEDBACK_RATE_LIMIT_WINDOW_MS - now) / 1000);
          return res.status(429).json({
            success: false,
            error: "Too many submissions. Please try again later.",
            retryAfter
          });
        }
      }
      
      const validatedData = insertFeatureRequestSchema.parse(req.body);
      
      const featureRequest = await storage.createFeatureRequest({
        type: validatedData.type,
        title: validatedData.title,
        description: validatedData.description,
        email: validatedData.email || undefined
      });
      
      // Record submission
      const currentEntry = feedbackRateLimitStore.get(rateLimitKey);
      if (currentEntry && now - currentEntry.firstRequest <= FEEDBACK_RATE_LIMIT_WINDOW_MS) {
        currentEntry.count++;
      } else {
        feedbackRateLimitStore.set(rateLimitKey, { count: 1, firstRequest: now });
      }
      
      res.status(201).json({
        success: true,
        data: { id: featureRequest.id }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: error.errors
        });
      }
      console.error('Error creating feature request:', error);
      res.status(500).json({
        success: false,
        error: "Failed to submit feedback"
      });
    }
  });

  // ============= QR TEMPLATE DOWNLOAD TRACKING =============

  // Record a QR template download (public endpoint, no auth required)
  registerBothPaths("post", "/qr-template-download", async (req, res) => {
    try {
      const { event_id, template_name } = req.body;
      
      if (!event_id || !template_name) {
        return res.status(400).json({ 
          success: false, 
          error: "event_id and template_name are required" 
        });
      }
      
      // Get user email if authenticated (optional)
      let downloadedBy: string | undefined;
      const token = getTokenFromHeader(req);
      if (token) {
        try {
          const email = await verifyToken(token);
          if (email) {
            downloadedBy = email;
          }
        } catch {
          // Ignore token errors, just record without user
        }
      }
      
      await storage.recordQrTemplateDownload(event_id, template_name, downloadedBy);
      
      res.json({ success: true });
    } catch (error) {
      console.error('Error recording QR template download:', error);
      res.status(500).json({ 
        success: false, 
        error: "Failed to record download" 
      });
    }
  });

  // Get global QR template download stats (admin only)
  registerBothPaths("get", "/admin/qr-template-stats", async (req, res) => {
    try {
      const token = getTokenFromHeader(req);
      if (!token) {
        return res.status(401).json({ detail: "Authentication required" });
      }

      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const isAdmin = await verifyAdmin(email);
      if (!isAdmin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const stats = await storage.getQrTemplateDownloadStats();
      res.json({ success: true, data: stats });
    } catch (error) {
      console.error('Error getting QR template stats:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get QR template download stats for a specific event
  registerBothPaths("get", "/events/:event_id/qr-template-stats", async (req, res) => {
    const { event_id } = req.params;

    try {
      const token = getTokenFromHeader(req);
      if (!token) {
        return res.status(401).json({ detail: "Authentication required" });
      }

      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Access denied" });
      }

      const stats = await storage.getQrTemplateDownloadsByEvent(event_id);
      res.json({ success: true, data: stats });
    } catch (error) {
      console.error('Error getting event QR template stats:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // ============= QR CODE GENERATOR SETTINGS =============

  // Get QR settings for an event
  registerBothPaths("get", "/events/:event_id/qr-settings", async (req, res) => {
    const { event_id } = req.params;

    try {
      const token = getTokenFromHeader(req);
      if (!token) {
        return res.status(401).json({ detail: "Authentication required" });
      }

      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Access denied" });
      }

      const settings = await storage.getQrSettings(event_id);
      res.json({ success: true, data: settings });
    } catch (error) {
      console.error('Error getting QR settings:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Save QR settings for an event
  registerBothPaths("post", "/events/:event_id/qr-settings", async (req, res) => {
    const { event_id } = req.params;

    try {
      const token = getTokenFromHeader(req);
      if (!token) {
        return res.status(401).json({ detail: "Authentication required" });
      }

      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Access denied" });
      }

      const settings = req.body;
      await storage.saveQrSettings(event_id, settings);
      
      res.json({ success: true });
    } catch (error) {
      console.error('Error saving QR settings:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // ============= MODERATION ENDPOINTS =============

  // Get pending moderation images for an event
  registerBothPaths("get", "/events/:event_id/moderation/pending", async (req, res) => {
    const { event_id } = req.params;

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Only event owners or co-hosts can moderate images" });
      }

      const pendingImages = await storage.getPendingModerationImages(event_id);
      res.json(pendingImages);
    } catch (error) {
      console.error('Error getting pending moderation images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get pending moderation count for an event
  registerBothPaths("get", "/events/:event_id/moderation/count", async (req, res) => {
    const { event_id } = req.params;

    try {
      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      const count = await storage.getPendingModerationCount(event_id);
      res.json({ count, moderation_enabled: event.image_moderation });
    } catch (error) {
      console.error('Error getting pending moderation count:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Approve images (bulk)
  registerBothPaths("post", "/events/:event_id/moderation/approve", async (req, res) => {
    const { event_id } = req.params;
    const { image_ids } = req.body;

    if (!Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "image_ids array is required" });
    }

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Only event owners or co-hosts can approve images" });
      }

      const approvedCount = await storage.approveImages(event_id, image_ids, email);
      res.json({ success: true, approved: approvedCount });
    } catch (error) {
      console.error('Error approving images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Reject images (bulk) - moves to rejected status
  registerBothPaths("post", "/events/:event_id/moderation/reject", async (req, res) => {
    const { event_id } = req.params;
    const { image_ids } = req.body;

    if (!Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "image_ids array is required" });
    }

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Only event owners or co-hosts can reject images" });
      }

      const rejectedCount = await storage.rejectImages(event_id, image_ids, email);
      res.json({ success: true, rejected: rejectedCount });
    } catch (error) {
      console.error('Error rejecting images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Archive images (bulk) - soft delete
  registerBothPaths("post", "/events/:event_id/moderation/archive", async (req, res) => {
    const { event_id } = req.params;
    const { image_ids } = req.body;

    if (!Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "image_ids array is required" });
    }

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Only event owners or co-hosts can archive images" });
      }

      const archivedCount = await storage.archiveImages(event_id, image_ids);
      res.json({ success: true, archived: archivedCount });
    } catch (error) {
      console.error('Error archiving images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get archived images for an event
  registerBothPaths("get", "/events/:event_id/moderation/archived", async (req, res) => {
    const { event_id } = req.params;

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Only event owners or co-hosts can view archived images" });
      }

      const archivedImages = await storage.getArchivedImages(event_id);
      res.json(archivedImages);
    } catch (error) {
      console.error('Error getting archived images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Restore archived images (bulk)
  registerBothPaths("post", "/events/:event_id/moderation/restore", async (req, res) => {
    const { event_id } = req.params;
    const { image_ids } = req.body;

    if (!Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "image_ids array is required" });
    }

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Only event owners or co-hosts can restore images" });
      }

      // Check if moderation is enabled - if so, restored images go to pending
      if (event.image_moderation) {
        // Set moderation_status to pending for restored images
        await storage.restoreImages(event_id, image_ids);
        // Images remain with their previous moderation_status, which may need resetting
        // For now, we just restore archived status
      } else {
        await storage.restoreImages(event_id, image_ids);
      }

      res.json({ success: true, restored: image_ids.length });
    } catch (error) {
      console.error('Error restoring images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Permanently delete archived images (bulk) - deletes from both GCS and database
  registerBothPaths("post", "/events/:event_id/moderation/permanent-delete", async (req, res) => {
    const { event_id } = req.params;
    const { image_ids } = req.body;

    if (!Array.isArray(image_ids) || image_ids.length === 0) {
      return res.status(400).json({ detail: "image_ids array is required" });
    }

    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      const event = await storage.getEvent(event_id);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      if (!await isEventOwnerOrCoHost(email, event)) {
        return res.status(403).json({ detail: "Only event owners or co-hosts can permanently delete images" });
      }

      // SECURITY: Get only archived images that belong to this specific event
      const archivedImages = await storage.getArchivedImagesByIds(event_id, image_ids);

      if (archivedImages.length === 0) {
        return res.status(400).json({ detail: "Only archived images from this event can be permanently deleted" });
      }

      // Delete files from Google Cloud Storage first - only delete DB rows for successfully deleted GCS files
      // Must delete both original and derivative versions:
      // - Images: original + _small thumbnail
      // - Videos: original + _compressed version
      const { deleteFile } = await import('./gcs');
      const successfullyDeletedIds: string[] = [];
      const failedImages: { id: string; url: string; reason: string }[] = [];
      
      // Video extensions to check
      const videoExtensions = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp'];

      for (const image of archivedImages) {
        try {
          // Extract filename from URL (e.g., "https://storage.googleapis.com/evenero-cloud/images/abc123.jpg" -> "images/abc123.jpg")
          const url = image.image_url;
          const match = url.match(/\/images\/(.+?)(?:\?|$)/);
          if (match) {
            const filename = match[1];
            const gcsPath = `images/${filename}`;
            const lastDotIndex = filename.lastIndexOf('.');
            const ext = lastDotIndex > 0 ? filename.slice(lastDotIndex + 1).toLowerCase() : '';
            
            // Check if this is a video based on file extension
            const isVideo = videoExtensions.includes(ext) || 
                           (image.file_extension && videoExtensions.includes(image.file_extension.toLowerCase().replace('.', '')));
            
            // Generate derivative path based on media type
            // Videos: _compressed suffix (e.g., "video.mp4" -> "video_compressed.mp4")
            // Images: _small suffix (e.g., "image.jpg" -> "image_small.jpg")
            const derivativeSuffix = isVideo ? '_compressed' : '_small';
            const derivativeFilename = lastDotIndex > 0 
              ? filename.slice(0, lastDotIndex) + derivativeSuffix + filename.slice(lastDotIndex)
              : filename + derivativeSuffix;
            const derivativePath = `images/${derivativeFilename}`;
            
            // Delete original file (required)
            const originalDeleted = await deleteFile(gcsPath);
            
            // Delete derivative (best effort - may not exist for all media)
            const derivativeDeleted = await deleteFile(derivativePath);
            
            if (originalDeleted) {
              successfullyDeletedIds.push(image.id);
              const derivativeType = isVideo ? 'compressed' : 'thumbnail';
              console.log(`[GCS] Deleted original: ${gcsPath}${derivativeDeleted ? `, ${derivativeType}: ${derivativePath}` : ` (no ${derivativeType})`}`);
            } else {
              failedImages.push({ id: image.id, url: gcsPath, reason: 'GCS delete returned false for original' });
              console.warn(`[GCS] Failed to delete original file: ${gcsPath}`);
            }
          } else {
            failedImages.push({ id: image.id, url: image.image_url, reason: 'Could not extract GCS path from URL' });
            console.warn(`[GCS] Could not extract path from URL: ${image.image_url}`);
          }
        } catch (gcsError) {
          failedImages.push({ id: image.id, url: image.image_url, reason: String(gcsError) });
          console.error(`[GCS] Error deleting file for image ${image.id}:`, gcsError);
        }
      }

      // Only delete from database the images that were successfully deleted from GCS
      let deletedCount = 0;
      if (successfullyDeletedIds.length > 0) {
        deletedCount = await storage.permanentDeleteImages(event_id, successfullyDeletedIds);
      }

      console.log(`[PERMANENT DELETE] Event ${event_id}: Deleted ${deletedCount} from DB, ${successfullyDeletedIds.length} from GCS (${failedImages.length} failures)`);

      // Return partial success/failure info
      if (failedImages.length > 0 && successfullyDeletedIds.length === 0) {
        return res.status(500).json({ 
          success: false, 
          detail: "Failed to delete files from storage",
          deleted: 0,
          failed: failedImages.length
        });
      }

      res.json({ 
        success: true, 
        deleted: deletedCount,
        gcs_deleted: successfullyDeletedIds.length,
        gcs_failed: failedImages.length
      });
    } catch (error) {
      console.error('Error permanently deleting images:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Get all events with pending moderation (for dashboard notification)
  registerBothPaths("get", "/moderation/pending-events", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const email = await verifyToken(token);
      if (!email) {
        return res.status(401).json({ detail: "Invalid or expired token" });
      }

      // Get user's events that have pending moderation
      const allPending = await storage.getAllEventsWithPendingModeration();
      
      // Filter to only show events where user is owner or co-host
      const userPending = await Promise.all(
        allPending.map(async ({ event, pendingCount }) => {
          if (await isEventOwnerOrCoHost(email, event)) {
            return { event, pendingCount };
          }
          return null;
        })
      );

      res.json(userPending.filter(Boolean));
    } catch (error) {
      console.error('Error getting pending moderation events:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // ==================== ADMIN ENDPOINTS ====================

  // Admin: Get platform statistics
  registerBothPaths("get", "/admin/stats", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const admin = await verifyAdmin(token);
      if (!admin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const stats = await storage.adminGetStats();
      res.json(stats);
    } catch (error) {
      console.error('Error getting admin stats:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Admin: List users with pagination, search, and filters
  registerBothPaths("get", "/admin/users", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const admin = await verifyAdmin(token);
      if (!admin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
      const query = req.query.query as string | undefined;
      const role = req.query.role as string | undefined;
      const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined;
      const sortBy = (req.query.sortBy as 'email' | 'created_at' | 'last_login' | 'event_credit') || 'created_at';
      const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';

      const result = await storage.adminListUsers({ page, pageSize, query, role, active, sortBy, sortOrder });
      res.json(result);
    } catch (error) {
      console.error('Error listing admin users:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Admin: Update user
  const adminUpdateUserSchema = z.object({
    name: z.string().max(100).optional(),
    role: z.enum(['user', 'superuser']).optional(),
    active: z.boolean().optional(),
    event_credit: z.number().int().min(0).optional()
  });

  registerBothPaths("patch", "/admin/users/:userId", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const admin = await verifyAdmin(token);
      if (!admin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const { userId } = req.params;
      
      // Validate request body
      const parseResult = adminUpdateUserSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ detail: "Invalid request data", errors: parseResult.error.errors });
      }

      const { name, role, active, event_credit } = parseResult.data;

      // Build updates object
      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (role !== undefined) updates.role = role;
      if (active !== undefined) updates.active = active;
      if (event_credit !== undefined) updates.event_credit = event_credit;

      const updatedUser = await storage.updateUser(userId, updates);
      if (!updatedUser) {
        return res.status(404).json({ detail: "User not found" });
      }

      res.json({ success: true, user: updatedUser });
    } catch (error) {
      console.error('Error updating admin user:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Admin: Adjust user credits (add/subtract)
  const adminCreditsSchema = z.object({
    delta: z.number().int()
  });

  registerBothPaths("post", "/admin/users/:userId/credits", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const admin = await verifyAdmin(token);
      if (!admin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const { userId } = req.params;
      
      // Validate request body
      const parseResult = adminCreditsSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ detail: "Delta must be an integer", errors: parseResult.error.errors });
      }

      const { delta } = parseResult.data;

      const updatedUser = await storage.adminUpdateUserCredits(userId, delta);
      if (!updatedUser) {
        return res.status(404).json({ detail: "User not found" });
      }

      res.json({ success: true, user: updatedUser, newCredits: updatedUser.event_credit });
    } catch (error) {
      console.error('Error updating user credits:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Admin: List events with pagination, search, and filters
  registerBothPaths("get", "/admin/events", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const admin = await verifyAdmin(token);
      if (!admin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
      const query = req.query.query as string | undefined;
      const owner = req.query.owner as string | undefined;
      const accessType = req.query.accessType as string | undefined;
      const active = req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined;
      const requiresAuth = req.query.requiresAuth === 'true' ? true : req.query.requiresAuth === 'false' ? false : undefined;
      const moderationEnabled = req.query.moderationEnabled === 'true' ? true : req.query.moderationEnabled === 'false' ? false : undefined;
      const sortBy = (req.query.sortBy as 'event_name' | 'created_at' | 'event_date') || 'created_at';
      const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';

      const result = await storage.adminListEvents({ 
        page, pageSize, query, active, owner, accessType, requiresAuth, moderationEnabled, sortBy, sortOrder 
      });
      res.json(result);
    } catch (error) {
      console.error('Error listing admin events:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Admin: Update event
  const adminUpdateEventSchema = z.object({
    event_name: z.string().max(255).optional(),
    event_description: z.string().optional(),
    event_date: z.string().nullable().optional(),
    event_location: z.string().max(255).optional(),
    event_type: z.string().max(255).optional(),
    event_owner: z.string().email().optional(),
    event_co_host: z.string().optional(),
    event_access_type: z.string().max(10).optional(),
    active: z.boolean().optional(),
    upload_requires_auth: z.boolean().optional(),
    image_moderation: z.boolean().optional(),
    uploads_disabled: z.boolean().optional(),
    reminders_enabled: z.boolean().optional(),
    image_storage_limit_gb: z.number().int().min(0).max(10000).optional(),
    video_storage_limit_gb: z.number().int().min(0).max(10000).optional(),
    total_storage_limit_gb: z.number().int().min(0).max(10000).nullable().optional(),
    event_start_date: z.string().nullable().optional(),
    event_expiry_date: z.string().nullable().optional()
  });

  registerBothPaths("patch", "/admin/events/:eventId", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const admin = await verifyAdmin(token);
      if (!admin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const { eventId } = req.params;
      
      // Validate request body
      const parseResult = adminUpdateEventSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ detail: "Invalid request data", errors: parseResult.error.errors });
      }

      const updates = parseResult.data;

      const updatedEvent = await storage.updateEvent(eventId, updates);
      if (!updatedEvent) {
        return res.status(404).json({ detail: "Event not found" });
      }

      res.json({ success: true, event: updatedEvent });
    } catch (error) {
      console.error('Error updating admin event:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  // Admin: Get single event details (for edit panel)
  registerBothPaths("get", "/admin/events/:eventId", async (req, res) => {
    const token = getTokenFromHeader(req);
    if (!token) {
      return res.status(401).json({ detail: "Authentication required" });
    }

    try {
      const admin = await verifyAdmin(token);
      if (!admin) {
        return res.status(403).json({ detail: "Admin access required" });
      }

      const { eventId } = req.params;
      const event = await storage.getEvent(eventId);
      if (!event) {
        return res.status(404).json({ detail: "Event not found" });
      }

      // Get storage usage
      const storageUsage = await storage.getEventStorageUsage(eventId);
      const pendingCount = await storage.getPendingModerationCount(eventId);

      res.json({ 
        event, 
        storageUsage,
        pendingModeration: pendingCount
      });
    } catch (error) {
      console.error('Error getting admin event:', error);
      res.status(500).json({ detail: "Internal server error" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}