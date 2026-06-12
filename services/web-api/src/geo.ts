import type { Request } from "express";
import geoip from "geoip-country";

// Land fra klient-IP (geoip-country: IPv4+IPv6, landsdata bundlet i pakken,
// oppdateres via npm-oppgradering). Brukes til valuta-presentasjon — feil
// svar er ufarlig (Stripe validerer valutaen ved session-create uansett).
//
// Klient-IP på Cloud Run: Google Front End appender den ekte klient-IP-en
// SIST i X-Forwarded-For. Klient-sendte XFF-verdier ligger først og kan være
// spoofet — bruk derfor alltid siste element. (Settes en LB foran Cloud Run
// senere, blir siste element LB-hoppet — da må kjente LB-ranger skippes her.)
export function clientIpFromRequest(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  const last = raw?.split(",").pop()?.trim();
  const ip = (last || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  return ip || null;
}

export function countryFromRequest(req: Request): string | null {
  const ip = clientIpFromRequest(req);
  if (!ip) return null;
  const country = geoip.lookup(ip)?.country;
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}
