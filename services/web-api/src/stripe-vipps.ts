import Stripe from "stripe";

// Vipps via Stripe er i preview (per 2026-06): krever preview-API-versjon med
// vipps_preview-flagg, eksplisitt payment_method_types og NOK som presentment-
// valuta. https://docs.stripe.com/payments/vipps
//
// Preview-gaten er per konto/modus: live-kontoen har Vipps aktivert i
// dashboardet, men TEST mode (staging) mangler gaten og avviser headeren med
// "You do not have permission to pass this beta header: vipps_preview"
// (verifisert mot test-API 2026-06-12). Derfor er Vipps-forsøket alltid
// best-effort med fallback til nøyaktig dagens session-oppsett.
export const VIPPS_PREVIEW_API_VERSION = "2026-05-27.preview; vipps_preview=v1";

export interface VippsSessionOptions {
  // Eksplisitt liste brukt i Vipps-forsøket. NB: eksplisitt liste skrur av
  // dashboard-styrte dynamiske betalingsmetoder for sessionen — metoder som
  // skal beholdes (f.eks. 'link') må stå her. Wallets (Apple/Google Pay)
  // følger 'card' og trenger ikke listes.
  paymentMethodTypes: string[];
  // Lås presentment-valuta i Vipps-forsøket. Trengs når line_items bruker en
  // multi-valuta Price (credits-checkout) — Vipps krever NOK, og uten lås kan
  // Stripe geo-localisere til annen valuta ved render.
  forceCurrency?: string;
}

// Oppretter Checkout Session med Vipps; faller tilbake til `params` urørt
// (dagens oppførsel) hvis Stripe avviser preview-forsøket. Checkout skal
// aldri knekke fordi Vipps-gaten mangler eller previewen endres/avvikles.
export async function createSessionWithVippsFallback(
  stripe: Stripe,
  params: Stripe.Checkout.SessionCreateParams,
  opts: VippsSessionOptions,
): Promise<Stripe.Checkout.Session> {
  const previewParams: Record<string, unknown> = {
    ...params,
    payment_method_types: opts.paymentMethodTypes,
  };
  if (opts.forceCurrency) {
    previewParams.currency = opts.forceCurrency;
  }
  // Preview-versjonen omdøper ui_mode 'embedded' → 'embedded_page' (verifisert
  // mot test-API 2026-06-12). client_secret-flyten mot frontend er uendret.
  if (previewParams.ui_mode === "embedded") {
    previewParams.ui_mode = "embedded_page";
  }

  try {
    const session = await stripe.checkout.sessions.create(
      previewParams as unknown as Stripe.Checkout.SessionCreateParams,
      { apiVersion: VIPPS_PREVIEW_API_VERSION } as Stripe.RequestOptions,
    );
    console.log(`[vipps] Checkout-session ${session.id} opprettet med Vipps (${opts.paymentMethodTypes.join(",")})`);
    return session;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vipps] Stripe avviste Vipps-session (${msg.slice(0, 200)}) — oppretter uten Vipps`);
    return stripe.checkout.sessions.create(params);
  }
}
