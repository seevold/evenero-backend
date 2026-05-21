// Print-ordre e-post — selvstendig Mailgun-klient + ordrebekreftelse.
//
// Holdt bevisst isolert fra resten av appen: print-funksjonen ligger
// separat i web-api og skal kunne skrus av/på uten å berøre annet.
// Stripe sender sin egen betalingskvittering automatisk; dette er en
// ordrebekreftelse med ordredetaljer + lenke til status-siden.
//
// Env (web-api): MAILGUN_API_KEY (påkrevd for faktisk sending),
// MAILGUN_DOMAIN, MAILGUN_API_BASE, MAILGUN_FROM, MAILGUN_FROM_NAME,
// EMAIL_WHITELIST_TO (staging: ruter all e-post til testadresse).
// Uten MAILGUN_API_KEY logges e-posten i stedet for å sendes.

type Locale = "en" | "nb" | "sv" | "es";

export interface PrintOrderEmailItem {
  name: string;
  quantity: number;
  lineTotalMinor: number;
}

export interface PrintOrderEmailData {
  orderNumber: string;
  customerEmail: string;
  locale: string;
  items: PrintOrderEmailItem[];
  shippingMinor: number;
  totalMinor: number;
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

// ─── Lokaliserte strenger ───────────────────────────────────────────────────

const STR: Record<Locale, {
  subject: string;
  heading: string;
  intro: string;
  orderLabel: string;
  itemsHeading: string;
  shippingHeading: string;
  deliveryLabel: string;
  deliveryFree: string;
  totalLabel: string;
  taxNote: string;
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
    deliveryLabel: "Delivery",
    deliveryFree: "Included",
    totalLabel: "Total",
    taxNote: "Shipping and VAT included.",
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
    deliveryLabel: "Levering",
    deliveryFree: "Inkludert",
    totalLabel: "Totalt",
    taxNote: "Frakt og mva. inkludert.",
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
    deliveryLabel: "Leverans",
    deliveryFree: "Ingår",
    totalLabel: "Totalt",
    taxNote: "Frakt och moms ingår.",
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
    deliveryLabel: "Entrega",
    deliveryFree: "Incluido",
    totalLabel: "Total",
    taxNote: "Envío e IVA incluidos.",
    statusButton: "Seguir tu pedido",
    statusNote: "Puedes seguir el estado del pedido en cualquier momento con el enlace de arriba.",
    footer: "Stripe envía un recibo de pago por separado.",
  },
};

function pickLocale(raw: string): Locale {
  const l = (raw || "").toLowerCase().slice(0, 2);
  if (l === "nb" || l === "no") return "nb";
  if (l === "sv") return "sv";
  if (l === "es") return "es";
  return "en";
}

function kr(minor: number): string {
  return `${Math.round(minor / 100).toLocaleString("nb-NO")} kr`;
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
        ${esc(it.name)} <span style="color:#999;">× ${it.quantity}</span>
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;color:#333;white-space:nowrap;">
        ${kr(it.lineTotalMinor)}
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
            <tr>
              <td style="padding:8px 0;color:#555;">${esc(s.deliveryLabel)}</td>
              <td style="padding:8px 0;text-align:right;color:#555;">${d.shippingMinor > 0 ? kr(d.shippingMinor) : esc(s.deliveryFree)}</td>
            </tr>
            <tr>
              <td style="padding:10px 0 0;font-weight:700;color:#1a1a1a;font-size:16px;">${esc(s.totalLabel)}</td>
              <td style="padding:10px 0 0;text-align:right;font-weight:700;color:#1a1a1a;font-size:16px;">${kr(d.totalMinor)}</td>
            </tr>
          </table>
          <div style="font-size:12px;color:#999;margin-top:6px;">${esc(s.taxNote)}</div>
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
    ...d.items.map((it) => `  ${it.name} × ${it.quantity}  —  ${kr(it.lineTotalMinor)}`),
    `  ${s.deliveryLabel}: ${d.shippingMinor > 0 ? kr(d.shippingMinor) : s.deliveryFree}`,
    `  ${s.totalLabel}: ${kr(d.totalMinor)}`,
    s.taxNote,
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
