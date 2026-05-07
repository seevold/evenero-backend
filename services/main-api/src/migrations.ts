import { pool } from './db';

export async function runMigrations() {
  const client = await pool.connect();
  
  try {
    console.log('[MIGRATIONS] Checking database schema...');
    
    // Check if moderation columns exist
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'event_images' AND column_name IN ('moderation_status', 'moderated_at', 'moderated_by', 'archived_at', 'like_count')
    `);
    
    const existingColumns = result.rows.map(r => r.column_name);
    const requiredColumns = ['moderation_status', 'moderated_at', 'moderated_by', 'archived_at', 'like_count'];
    const missingColumns = requiredColumns.filter(c => !existingColumns.includes(c));
    
    if (missingColumns.length > 0) {
      console.log('[MIGRATIONS] Missing columns in event_images:', missingColumns.join(', '));
      console.log('[MIGRATIONS] Please run the following SQL as database owner in Google Cloud SQL:');
      console.log(`
-- Add moderation columns to event_images table
ALTER TABLE event_images ADD COLUMN IF NOT EXISTS moderation_status VARCHAR(20) DEFAULT 'approved';
ALTER TABLE event_images ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMP;
ALTER TABLE event_images ADD COLUMN IF NOT EXISTS moderated_by VARCHAR(255);
ALTER TABLE event_images ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
ALTER TABLE event_images ADD COLUMN IF NOT EXISTS like_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_event_images_moderation ON event_images(moderation_status);
      `);
    } else {
      console.log('[MIGRATIONS] All required event_images columns exist');
    }
    
    // Check for events table columns
    const eventsResult = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'events' AND column_name = 'curated_public_enabled'
    `);
    
    if (eventsResult.rows.length === 0) {
      console.log('[MIGRATIONS] Missing curated_public_enabled column in events');
      console.log('[MIGRATIONS] Please run the following SQL as database owner:');
      console.log(`
ALTER TABLE events ADD COLUMN IF NOT EXISTS curated_public_enabled BOOLEAN DEFAULT false;
      `);
    } else {
      console.log('[MIGRATIONS] Events curated_public_enabled column exists');
    }
    
    // Check for event_image_likes table
    const likesTableResult = await client.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_name = 'event_image_likes'
    `);
    
    if (likesTableResult.rows.length === 0) {
      console.log('[MIGRATIONS] Missing event_image_likes table');
      console.log('[MIGRATIONS] Please run the following SQL as database owner:');
      console.log(`
CREATE TABLE IF NOT EXISTS event_image_likes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(255) NOT NULL,
  image_id UUID NOT NULL,
  user_email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_image_like ON event_image_likes(image_id, user_email);
CREATE INDEX IF NOT EXISTS idx_image_likes_event_id ON event_image_likes(event_id);
CREATE INDEX IF NOT EXISTS idx_image_likes_image_id ON event_image_likes(image_id);
      `);
    } else {
      console.log('[MIGRATIONS] event_image_likes table exists');
    }
    
    // Check for locale column in event_reminders
    const remindersLocaleResult = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'event_reminders' AND column_name = 'locale'
    `);
    
    if (remindersLocaleResult.rows.length === 0) {
      console.log('[MIGRATIONS] Missing locale column in event_reminders, adding...');
      try {
        await client.query(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS locale VARCHAR(10) DEFAULT 'en'`);
        console.log('[MIGRATIONS] Added locale column to event_reminders');
      } catch (alterError) {
        console.log('[MIGRATIONS] ⚠️  Could not add locale column automatically. Please run this SQL as database owner in Google Cloud SQL:');
        console.log(`ALTER TABLE event_reminders ADD COLUMN IF NOT EXISTS locale VARCHAR(10) DEFAULT 'en';`);
        console.log('[MIGRATIONS] ⚠️  Until this column is added, reminder emails will use user preference or English as fallback.');
      }
    } else {
      console.log('[MIGRATIONS] event_reminders locale column exists');
    }

    console.log('[MIGRATIONS] Schema check completed');
  } catch (error) {
    console.error('[MIGRATIONS] Error checking schema:', error);
  } finally {
    client.release();
  }
}
