// Runtime-konfig for print-tjenesten — lest fra print_settings (én rad).
//
// Caches i minne med kort TTL (30s) så vi ikke treffer DB på hver
// catalog/quote/checkout. Admin-PUT tømmer cachen umiddelbart.

import { pool } from "../db";

export interface PrintSettings {
  serviceEnabled: boolean;
  enabledCountries: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

const TTL_MS = 30_000;
let cache: { at: number; value: PrintSettings } | null = null;

/** Default hvis raden mangler (skal ikke skje etter migration 007, men
 *  fail-safe: tjeneste AV så vi aldri selger utilsiktet uten konfig). */
const FALLBACK: PrintSettings = {
  serviceEnabled: false,
  enabledCountries: [],
  updatedAt: null,
  updatedBy: null,
};

export async function getPrintSettings(): Promise<PrintSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const r = await pool.query<{
    service_enabled: boolean;
    enabled_countries: string[];
    updated_at: Date | null;
    updated_by: string | null;
  }>(`SELECT service_enabled, enabled_countries, updated_at, updated_by
      FROM print_settings WHERE id = 1`);
  const row = r.rows[0];
  const value: PrintSettings = row
    ? {
        serviceEnabled: row.service_enabled,
        enabledCountries: row.enabled_countries || [],
        updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
        updatedBy: row.updated_by,
      }
    : FALLBACK;
  cache = { at: Date.now(), value };
  return value;
}

export function clearPrintSettingsCache(): void {
  cache = null;
}

export async function updatePrintSettings(
  patch: { serviceEnabled?: boolean; enabledCountries?: string[] },
  updatedBy: string,
): Promise<PrintSettings> {
  // Bygg dynamisk SET-liste — bare felter som faktisk sendes.
  const sets: string[] = ["updated_at = NOW()", "updated_by = $1"];
  const params: unknown[] = [updatedBy];
  if (typeof patch.serviceEnabled === "boolean") {
    params.push(patch.serviceEnabled);
    sets.push(`service_enabled = $${params.length}`);
  }
  if (Array.isArray(patch.enabledCountries)) {
    // Normaliser: uppercase, unike, kun 2-bokstavs-koder.
    const clean = Array.from(new Set(
      patch.enabledCountries
        .map((c) => String(c).trim().toUpperCase())
        .filter((c) => /^[A-Z]{2}$/.test(c)),
    ));
    params.push(clean);
    sets.push(`enabled_countries = $${params.length}`);
  }
  await pool.query(`UPDATE print_settings SET ${sets.join(", ")} WHERE id = 1`, params);
  clearPrintSettingsCache();
  return getPrintSettings();
}
