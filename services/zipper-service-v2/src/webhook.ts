// Webhook-utsending fra både Service-mode (/process-zip) og Job-mode (job.ts).
// Holdes som egen modul slik at logikken er identisk uansett hvem som kaller.
//
// Webhook er fire-and-forget mot main-api/api/zip-ready. Der oppdateres
// zip_jobs-raden + e-post sendes til kunden. Hvis webhook feiler logger vi,
// men feiler ikke selve zip-jobben (ZIP-en ligger uansett i bucket og kan
// hentes via DB-polling som fallback).

import { config } from './config.js';

export async function sendWebhook(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!config.webhookUrl) return;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Event-Type': eventType,
  };
  if (config.webhookApiKey) {
    headers['X-API-Key'] = config.webhookApiKey;
  }
  await fetch(config.webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
  });
}
