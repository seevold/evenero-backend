// Print-ordre e-post — selvstendig Mailgun-klient + ordrebekreftelse.
//
// Holdt bevisst isolert fra resten av appen: print-funksjonen ligger
// separat i web-api og skal kunne skrus av/på uten å berøre annet.
//
// Bevisst design: denne mailen viser KUN hva som er bestilt + leveringsadresse.
// Ingen priser, ingen fraktkost, ingen totalsum. Stripe sender sin egen
// detaljerte betalingskvittering — vi dupliserer ikke beløp her.
//
// Env (web-api): MAILGUN_API_KEY (påkrevd for faktisk sending),
// MAILGUN_DOMAIN, MAILGUN_API_BASE, MAILGUN_FROM, MAILGUN_FROM_NAME,
// EMAIL_WHITELIST_TO (staging: ruter all e-post til testadresse).
// Uten MAILGUN_API_KEY logges e-posten i stedet for å sendes.

type Locale = "en" | "nb" | "sv" | "es";

export interface PrintOrderEmailItem {
  /** Ferdig-formattert etikett, f.eks. "Flyer A6 — 30 stk (3 pakker à 10)" */
  label: string;
}

export interface PrintOrderEmailData {
  orderNumber: string;
  customerEmail: string;
  locale: string;
  items: PrintOrderEmailItem[];
  shipping: {
    name: string;
    line1: string;
    line2?: string;
    postalCode: string;
    city: string;
    country: string;
  };
  statusUrl: string;
}

export interface PrintOrderShippedEmailData {
  orderNumber: string;
  customerEmail: string;
  locale: string;
  /** Tracking-URL fra Gelato. Hvis tom → vi viser status-side-knapp i stedet. */
  trackingUrl?: string | null;
  trackingCode?: string | null;
  carrier?: string | null;
  /** Lenke til status-siden i app-en (fallback når tracking ikke finnes). */
  statusUrl: string;
}

// ─── Lokaliserte strenger ───────────────────────────────────────────────────

const STR: Record<Locale, {
  subject: string;
  heading: string;
  intro: string;
  orderLabel: string;
  itemsHeading: string;
  shippingHeading: string;
  statusButton: string;
  statusNote: string;
  footer: string;
}> = {
  en: {
    subject: "Order confirmation",
    heading: "Thank you for your order!",
    intro: "We've received your order and it's on its way to print. You'll get tracking details once it ships.",
    orderLabel: "Order number",
    itemsHeading: "Your order",
    shippingHeading: "Shipping address",
    statusButton: "Track your order",
    statusNote: "You can follow your order status any time with the link above.",
    footer: "A separate payment receipt is sent by Stripe.",
  },
  nb: {
    subject: "Ordrebekreftelse",
    heading: "Takk for bestillingen!",
    intro: "Vi har mottatt bestillingen din, og den er på vei til trykk. Du får sporingsdetaljer så snart den sendes.",
    orderLabel: "Ordrenummer",
    itemsHeading: "Din bestilling",
    shippingHeading: "Leveringsadresse",
    statusButton: "Følg bestillingen din",
    statusNote: "Du kan følge ordrestatusen når som helst med lenken over.",
    footer: "Egen betalingskvittering sendes av Stripe.",
  },
  sv: {
    subject: "Orderbekräftelse",
    heading: "Tack för din beställning!",
    intro: "Vi har tagit emot din beställning och den är på väg till tryck. Du får spårningsinformation så snart den skickas.",
    orderLabel: "Ordernummer",
    itemsHeading: "Din beställning",
    shippingHeading: "Leveransadress",
    statusButton: "Följ din beställning",
    statusNote: "Du kan följa orderstatusen när som helst med länken ovan.",
    footer: "Ett separat betalningskvitto skickas av Stripe.",
  },
  es: {
    subject: "Confirmación de pedido",
    heading: "¡Gracias por tu pedido!",
    intro: "Hemos recibido tu pedido y está en camino a impresión. Recibirás los detalles de seguimiento cuando se envíe.",
    orderLabel: "Número de pedido",
    itemsHeading: "Tu pedido",
    shippingHeading: "Dirección de envío",
    statusButton: "Seguir tu pedido",
    statusNote: "Puedes seguir el estado del pedido en cualquier momento con el enlace de arriba.",
    footer: "Stripe envía un recibo de pago por separado.",
  },
};

// ─── Strenger for shipped-mail (eget sett, separat fra ordrebekreftelse) ───

const SHIPPED_STR: Record<Locale, {
  subject: string;
  heading: string;
  intro: string;
  orderLabel: string;
  trackingHeading: string;
  carrierLabel: string;
  trackingCodeLabel: string;
  trackingButton: string;
  noTrackingNote: string;
  statusButton: string;
  footer: string;
}> = {
  en: {
    subject: "Your order is on its way",
    heading: "Your order has shipped!",
    intro: "Your print order has been sent from the printer and is on its way to the delivery address.",
    orderLabel: "Order number",
    trackingHeading: "Tracking",
    carrierLabel: "Carrier",
    trackingCodeLabel: "Tracking number",
    trackingButton: "Track your shipment",
    noTrackingNote: "Tracking information will appear here once available.",
    statusButton: "See order status",
    footer: "Need help? Reply to this email.",
  },
  nb: {
    subject: "Bestillingen er sendt",
    heading: "Pakken er på vei!",
    intro: "Trykk-bestillingen din har forlatt trykkeriet og er på vei til leveringsadressen.",
    orderLabel: "Ordrenummer",
    trackingHeading: "Sporing",
    carrierLabel: "Transportør",
    trackingCodeLabel: "Sporingsnummer",
    trackingButton: "Spor pakken",
    noTrackingNote: "Sporings­informasjon dukker opp her så snart den er klar.",
    statusButton: "Se ordrestatus",
    footer: "Trenger du hjelp? Svar på denne e-posten.",
  },
  sv: {
    subject: "Din beställning är på väg",
    heading: "Paketet är på väg!",
    intro: "Din tryckbeställning har lämnat tryckeriet och är på väg till leveransadressen.",
    orderLabel: "Ordernummer",
    trackingHeading: "Spårning",
    carrierLabel: "Transportör",
    trackingCodeLabel: "Spårningsnummer",
    trackingButton: "Spåra paketet",
    noTrackingNote: "Spårningsinformation dyker upp här så fort den är tillgänglig.",
    statusButton: "Se orderstatus",
    footer: "Behöver du hjälp? Svara på detta e-postmeddelande.",
  },
  es: {
    subject: "Tu pedido está en camino",
    heading: "¡Tu pedido ha sido enviado!",
    intro: "Tu pedido de impresión ha salido de la imprenta y está en camino a la dirección de entrega.",
    orderLabel: "Número de pedido",
    trackingHeading: "Seguimiento",
    carrierLabel: "Transportista",
    trackingCodeLabel: "Número de seguimiento",
    trackingButton: "Seguir el envío",
    noTrackingNote: "La información de seguimiento aparecerá aquí cuando esté disponible.",
    statusButton: "Ver estado del pedido",
    footer: "¿Necesitas ayuda? Responde a este correo.",
  },
};

function pickLocale(raw: string): Locale {
  const l = (raw || "").toLowerCase().slice(0, 2);
  if (l === "nb" || l === "no") return "nb";
  if (l === "sv") return "sv";
  if (l === "es") return "es";
  return "en";
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}

// ─── Mailgun ────────────────────────────────────────────────────────────────

function mailgunConfig() {
  const apiKey = process.env.MAILGUN_API_KEY || "";
  const domain = process.env.MAILGUN_DOMAIN || "www.evenero.com";
  const baseUrl = process.env.MAILGUN_API_BASE || "https://api.eu.mailgun.net/v3";
  const fromAddress = process.env.MAILGUN_FROM || `noreply@${domain}`;
  const fromName = process.env.MAILGUN_FROM_NAME || "Evenero";
  return { apiKey, domain, baseUrl, from: `${fromName} <${fromAddress}>` };
}

async function sendViaMailgun(to: string, subject: string, text: string, html: string): Promise<boolean> {
  const cfg = mailgunConfig();

  // Staging-sikkerhetsnett: ruter all e-post til testadressen.
  const whitelist = process.env.EMAIL_WHITELIST_TO?.trim();
  const actualTo = whitelist ? whitelist : to;
  const isRerouted = !!whitelist && actualTo !== to;

  if (!cfg.apiKey) {
    console.warn(`[print-email] MAILGUN_API_KEY mangler — logger i stedet. To=${actualTo} Subject="${subject}"`);
    return true;
  }

  try {
    const form = new URLSearchParams();
    form.append("from", cfg.from);
    form.append("to", actualTo);
    form.append("subject", subject);
    form.append("text", text);
    form.append("html", html);
    if (isRerouted) form.append("h:X-Original-To", to);

    const auth = Buffer.from(`api:${cfg.apiKey}`).toString("base64");
    const res = await fetch(`${cfg.baseUrl}/${cfg.domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[print-email] Mailgun ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    console.log(`[print-email] Sendt til ${actualTo}${isRerouted ? ` (omdirigert fra ${to})` : ""}`);
    return true;
  } catch (err) {
    console.error("[print-email] Sending feilet:", (err as Error).message);
    return false;
  }
}

// ─── Ordrebekreftelse ───────────────────────────────────────────────────────

function renderHtml(s: typeof STR[Locale], d: PrintOrderEmailData): string {
  const itemRows = d.items.map((it) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;color:#333;">
        ${esc(it.label)}
      </td>
    </tr>`).join("");

  const addr = d.shipping;
  return `<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:22px;font-weight:700;color:#1a1a1a;">${esc(s.heading)}</div>
          <p style="font-size:14px;line-height:1.6;color:#555;margin:12px 0 0;">${esc(s.intro)}</p>
        </td></tr>
        <tr><td style="padding:16px 32px 0;">
          <div style="font-size:13px;color:#888;">${esc(s.orderLabel)}</div>
          <div style="font-size:16px;font-weight:600;color:#1a1a1a;">${esc(d.orderNumber)}</div>
        </td></tr>
        <tr><td style="padding:20px 32px 0;">
          <div style="font-size:13px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.04em;">${esc(s.itemsHeading)}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;font-size:14px;">
            ${itemRows}
          </table>
        </td></tr>
        <tr><td style="padding:20px 32px 0;">
          <div style="font-size:13px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.04em;">${esc(s.shippingHeading)}</div>
          <div style="font-size:14px;color:#333;line-height:1.6;margin-top:6px;">
            ${esc(addr.name)}<br>
            ${esc(addr.line1)}<br>
            ${addr.line2 ? esc(addr.line2) + "<br>" : ""}
            ${esc(addr.postalCode)} ${esc(addr.city)}<br>
            ${esc(addr.country)}
          </div>
        </td></tr>
        <tr><td style="padding:28px 32px;" align="center">
          <a href="${esc(d.statusUrl)}" style="display:inline-block;background:#e6447f;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">${esc(s.statusButton)}</a>
          <p style="font-size:12px;color:#999;margin:14px 0 0;">${esc(s.statusNote)}</p>
        </td></tr>
        <tr><td style="padding:16px 32px;background:#fafafa;text-align:center;">
          <p style="font-size:12px;color:#aaa;margin:0;">${esc(s.footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderText(s: typeof STR[Locale], d: PrintOrderEmailData): string {
  const lines = [
    s.heading,
    "",
    s.intro,
    "",
    `${s.orderLabel}: ${d.orderNumber}`,
    "",
    s.itemsHeading + ":",
    ...d.items.map((it) => `  ${it.label}`),
    "",
    `${s.shippingHeading}:`,
    `  ${d.shipping.name}`,
    `  ${d.shipping.line1}`,
    ...(d.shipping.line2 ? [`  ${d.shipping.line2}`] : []),
    `  ${d.shipping.postalCode} ${d.shipping.city}`,
    `  ${d.shipping.country}`,
    "",
    `${s.statusButton}: ${d.statusUrl}`,
    s.statusNote,
    "",
    s.footer,
  ];
  return lines.join("\n");
}

/** Sender ordrebekreftelse. Best-effort — kaster aldri (logger ved feil). */
export async function sendPrintOrderConfirmation(data: PrintOrderEmailData): Promise<void> {
  try {
    const s = STR[pickLocale(data.locale)];
    const subject = `${s.subject} — ${data.orderNumber}`;
    const html = renderHtml(s, data);
    const text = renderText(s, data);
    await sendViaMailgun(data.customerEmail, subject, text, html);
  } catch (err) {
    console.error("[print-email] sendPrintOrderConfirmation feilet:", (err as Error).message);
  }
}

// ─── Shipped-mail ───────────────────────────────────────────────────────────

function renderShippedHtml(s: typeof SHIPPED_STR[Locale], d: PrintOrderShippedEmailData): string {
  const hasTracking = !!(d.trackingUrl || d.trackingCode);
  const ctaUrl = d.trackingUrl || d.statusUrl;
  const ctaLabel = d.trackingUrl ? s.trackingButton : s.statusButton;

  const trackingDetails = hasTracking ? `
        <tr><td style="padding:20px 32px 0;">
          <div style="font-size:13px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.04em;">${esc(s.trackingHeading)}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;font-size:14px;">
            ${d.carrier ? `<tr>
              <td style="padding:6px 0;color:#888;width:120px;">${esc(s.carrierLabel)}</td>
              <td style="padding:6px 0;color:#333;font-weight:500;">${esc(d.carrier)}</td>
            </tr>` : ""}
            ${d.trackingCode ? `<tr>
              <td style="padding:6px 0;color:#888;">${esc(s.trackingCodeLabel)}</td>
              <td style="padding:6px 0;color:#333;font-family:monospace;">${esc(d.trackingCode)}</td>
            </tr>` : ""}
          </table>
        </td></tr>` : `
        <tr><td style="padding:20px 32px 0;">
          <div style="font-size:13px;color:#888;font-style:italic;">${esc(s.noTrackingNote)}</div>
        </td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:32px 32px 8px;">
          <div style="font-size:22px;font-weight:700;color:#1a1a1a;">${esc(s.heading)}</div>
          <p style="font-size:14px;line-height:1.6;color:#555;margin:12px 0 0;">${esc(s.intro)}</p>
        </td></tr>
        <tr><td style="padding:16px 32px 0;">
          <div style="font-size:13px;color:#888;">${esc(s.orderLabel)}</div>
          <div style="font-size:16px;font-weight:600;color:#1a1a1a;">${esc(d.orderNumber)}</div>
        </td></tr>
        ${trackingDetails}
        <tr><td style="padding:28px 32px;" align="center">
          <a href="${esc(ctaUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#e6447f;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">${esc(ctaLabel)}</a>
        </td></tr>
        <tr><td style="padding:16px 32px;background:#fafafa;text-align:center;">
          <p style="font-size:12px;color:#aaa;margin:0;">${esc(s.footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderShippedText(s: typeof SHIPPED_STR[Locale], d: PrintOrderShippedEmailData): string {
  const lines = [
    s.heading,
    "",
    s.intro,
    "",
    `${s.orderLabel}: ${d.orderNumber}`,
    "",
  ];
  if (d.trackingUrl || d.trackingCode) {
    lines.push(s.trackingHeading + ":");
    if (d.carrier) lines.push(`  ${s.carrierLabel}: ${d.carrier}`);
    if (d.trackingCode) lines.push(`  ${s.trackingCodeLabel}: ${d.trackingCode}`);
    if (d.trackingUrl) lines.push(`  ${s.trackingButton}: ${d.trackingUrl}`);
  } else {
    lines.push(s.noTrackingNote);
    lines.push(`${s.statusButton}: ${d.statusUrl}`);
  }
  lines.push("", s.footer);
  return lines.join("\n");
}

/**
 * Sender "sendt fra trykkeri"-mail med tracking-info. Best-effort —
 * kaster aldri. Idempotency er caller-ansvar (vi sender én gang per
 * shipped-webhook fra Gelato; den webhook-håndteringen sjekker shipped_at).
 */
export async function sendPrintOrderShipped(data: PrintOrderShippedEmailData): Promise<void> {
  try {
    const s = SHIPPED_STR[pickLocale(data.locale)];
    const subject = `${s.subject} — ${data.orderNumber}`;
    const html = renderShippedHtml(s, data);
    const text = renderShippedText(s, data);
    await sendViaMailgun(data.customerEmail, subject, text, html);
  } catch (err) {
    console.error("[print-email] sendPrintOrderShipped feilet:", (err as Error).message);
  }
}

// ─── Failure-alert til ops (Lasse) ──────────────────────────────────────────

export interface FulfillmentFailureAlertData {
  orderNumber: string;
  customerEmail: string;
  /** Hva som gikk galt. Trunkert ved sending hvis veldig lang. */
  failureReason: string;
  /** Permanent (Gelato 4xx, fil ugyldig osv) eller transient (timeout, 5xx)? */
  isPermanent: boolean;
  /** Antall submit-forsøk så langt. Hvis ≥ MAX_ATTEMPTS er ordren stuck. */
  submitAttempts: number;
  /** Lenke til status-siden så Lasse kan se hva som er bestilt. */
  statusUrl: string;
}

/**
 * Sender alert-mail til ops-adressen (Lasse) når en fulfillment feiler.
 * To trigger-scenarier:
 *   1. Permanent feil — Gelato avviser ordren med 4xx, eller print-fil
 *      er ugyldig. Krever manuelt inngrep (rette opp, refundere, etc.).
 *   2. Transient feil ved siste forsøk — submit_attempts ≥ MAX og ordren
 *      sitter fast i 'paid'. Krever retry eller manuelt inngrep.
 *
 * Best-effort. Kaster aldri. OPS_ALERT_EMAIL må være satt — ellers
 * bare loggføres alarmen.
 */
export async function sendFulfillmentFailureAlert(
  data: FulfillmentFailureAlertData,
): Promise<void> {
  try {
    const opsEmail = process.env.OPS_ALERT_EMAIL?.trim();
    if (!opsEmail) {
      console.warn(`[ops-alert] OPS_ALERT_EMAIL ikke satt — fulfillment-feil for ${data.orderNumber} loggføres kun`);
      return;
    }

    const severity = data.isPermanent ? "PERMANENT" : `TRANSIENT (${data.submitAttempts} forsøk)`;
    const subject = `🚨 Print fulfillment ${severity} — ${data.orderNumber}`;

    const text = [
      `Ordre ${data.orderNumber} har feilet i fulfillment.`,
      "",
      `Kunde: ${data.customerEmail}`,
      `Type: ${severity}`,
      `Submit-forsøk: ${data.submitAttempts}`,
      "",
      "Årsak:",
      data.failureReason.slice(0, 800),
      "",
      `Status-side: ${data.statusUrl}`,
      "",
      data.isPermanent
        ? "Krever manuelt inngrep: rette opp data eller refundere kunde."
        : "Kan re-trigge fulfillment manuelt (admin-retry) eller la auto-retry løse det.",
    ].join("\n");

    const html = `<!doctype html>
<html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#fff;padding:24px;border-radius:8px;">
    <h2 style="margin:0 0 8px;color:#dc2626;">Print fulfillment ${esc(severity)}</h2>
    <p style="margin:0 0 16px;color:#444;">Ordre <strong>${esc(data.orderNumber)}</strong> har feilet.</p>
    <table cellpadding="6" style="width:100%;border-collapse:collapse;font-size:14px;color:#333;">
      <tr><td style="color:#888;width:140px;">Kunde:</td><td>${esc(data.customerEmail)}</td></tr>
      <tr><td style="color:#888;">Type:</td><td><strong>${esc(severity)}</strong></td></tr>
      <tr><td style="color:#888;">Submit-forsøk:</td><td>${data.submitAttempts}</td></tr>
    </table>
    <h3 style="margin:20px 0 6px;color:#1a1a1a;">Årsak</h3>
    <pre style="background:#f4f4f5;padding:12px;border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-word;color:#444;">${esc(data.failureReason.slice(0, 1200))}</pre>
    <p style="margin:20px 0 0;color:#555;font-size:14px;">
      ${data.isPermanent
        ? "Krever manuelt inngrep: rette opp data eller refundere kunde."
        : "Kan re-trigge fulfillment manuelt eller la auto-retry løse det."}
    </p>
    <p style="margin:16px 0 0;">
      <a href="${esc(data.statusUrl)}" style="color:#e6447f;text-decoration:none;">→ Åpne status-side</a>
    </p>
  </div>
</body></html>`;

    // Send DIREKTE til ops — ikke gjennom EMAIL_WHITELIST (det er for kunde-
    // mails i staging). Vi bygger en lokal mailgun-call for å bypasse whitelist-
    // logikken i sendViaMailgun (som ville rerouted opsmailen i staging også).
    const cfg = mailgunConfig();
    if (!cfg.apiKey) {
      console.warn(`[ops-alert] MAILGUN_API_KEY mangler — alert for ${data.orderNumber} loggføres kun`);
      return;
    }
    const form = new URLSearchParams();
    form.append("from", cfg.from);
    form.append("to", opsEmail);
    form.append("subject", subject);
    form.append("text", text);
    form.append("html", html);
    const auth = Buffer.from(`api:${cfg.apiKey}`).toString("base64");
    const res = await fetch(`${cfg.baseUrl}/${cfg.domain}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[ops-alert] Mailgun ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return;
    }
    console.log(`[ops-alert] Alert sendt til ${opsEmail} for ${data.orderNumber}`);
  } catch (err) {
    console.error("[ops-alert] sendFulfillmentFailureAlert feilet:", (err as Error).message);
  }
}
