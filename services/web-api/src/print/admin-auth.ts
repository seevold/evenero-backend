// Superuser-auth for print-admin-endepunktene.
//
// Gjenbruker samme JWT som main-api utsteder (HS256 signert med JWT_SECRET).
// admin.tsx sender `Authorization: Bearer <evenero_token>` — vi verifiserer
// signaturen, henter e-post fra payload, og sjekker role='superuser' mot den
// delte DB-en (evenero-db-1, samme som main-api).
//
// Hvorfor her og ikke main-api: print-actions (fulfillOrder, syncOrderFromGelato)
// lever i web-api med Gelato-klient + PDF-generering. Å duplisere dem til
// main-api ville vært verre enn å verifisere JWT to steder.

import jwt from "jsonwebtoken";
import type { Request } from "express";
import { pool } from "../db";

function getBearer(req: Request): string | null {
  const h = (req.headers.authorization || (req.headers as Record<string, string>).Authorization) as string | undefined;
  if (!h) return null;
  return h.startsWith("Bearer ") ? h.slice(7) : h;
}

export interface SuperuserCheck {
  ok: boolean;
  /** HTTP-status å returnere når ok=false (401 = ikke autentisert, 403 = ikke superuser, 503 = config) */
  status: number;
  email?: string;
}

/**
 * Verifiserer at requesten kommer fra en innlogget superuser.
 * Returnerer { ok, status, email } — caller sender riktig HTTP-respons.
 */
export async function verifySuperuser(req: Request): Promise<SuperuserCheck> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("[print-admin] JWT_SECRET ikke satt — kan ikke verifisere admin");
    return { ok: false, status: 503 };
  }

  const token = getBearer(req);
  if (!token) return { ok: false, status: 401 };

  let email: string | null = null;
  try {
    const payload = jwt.verify(token, secret) as { email?: string };
    email = payload.email || null;
  } catch {
    return { ok: false, status: 401 };
  }
  if (!email) return { ok: false, status: 401 };

  // Slå opp rolle i delt DB. web-api kobler til evenero-db-1, samme som main-api.
  const r = await pool.query<{ role: string }>(
    `SELECT role FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email],
  );
  if (r.rows[0]?.role !== "superuser") {
    return { ok: false, status: 403, email };
  }
  return { ok: true, status: 200, email };
}

/**
 * Verifiserer JWT-en (samme som main-api utsteder) og returnerer e-posten i
 * payloaden, eller null hvis token mangler/er ugyldig/JWT_SECRET ikke satt.
 *
 * Brukes for kunde-vendte print-endepunkter (ordre-status) der vi ikke krever
 * superuser, men må vite HVEM som er innlogget for å autorisere mot ordren.
 * Selve eierskaps-sjekken gjøres av caller — denne sier bare "gyldig innlogget
 * bruker = X".
 */
export async function getAuthedEmail(req: Request): Promise<string | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error("[print-auth] JWT_SECRET ikke satt — kan ikke verifisere bruker");
    return null;
  }
  const token = getBearer(req);
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret) as { email?: string };
    return payload.email || null;
  } catch {
    return null;
  }
}
