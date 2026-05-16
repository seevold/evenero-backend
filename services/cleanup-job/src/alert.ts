// E-post-alert ved halt/anomaly. Bruker Mailgun HTTP API — samme som main-api.
// Stille no-op hvis ALERT_EMAIL eller MAILGUN_API_KEY ikke konfigurert.

import { config } from "./config.js";

export async function sendAlert(subject: string, body: string): Promise<void> {
  if (!config.alertEmail) {
    console.warn("[ALERT] ALERT_EMAIL not set — skipping. Reason:", subject);
    return;
  }
  if (!config.mailgunApiKey) {
    console.warn(`[ALERT] MAILGUN_API_KEY not set — logging instead. Subject: ${subject}\n${body}`);
    return;
  }

  try {
    const form = new URLSearchParams();
    form.append("from", `${config.mailgunFromName} <${config.mailgunFrom}>`);
    form.append("to", config.alertEmail);
    form.append("subject", `[Evenero cleanup-job] ${subject}`);
    form.append("text", body);

    const url = `${config.mailgunApiBase}/${config.mailgunDomain}/messages`;
    const auth = Buffer.from(`api:${config.mailgunApiKey}`).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[ALERT] Mailgun ${response.status}: ${text.substring(0, 300)}`);
      return;
    }
    console.log(`[ALERT] Sent to ${config.alertEmail}: ${subject}`);
  } catch (error: any) {
    console.error("[ALERT] Failed:", error?.message || error);
  }
}
