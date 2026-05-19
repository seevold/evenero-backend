// Fulfillment-orkestrering: når en print_order er betalt, generer PDF-er,
// last til GCS, og send ordren til Gelato.
//
// Idempotent: hvis gelato_order_id allerede er satt på ordren, skip
// (webhook kan fyres flere ganger).
//
// Robust mot delvis feil: hvis Gelato avviser ordren (4xx), marker som
// `failed` og noter feil. Hvis Gelato API er nede (5xx eller timeout),
// inkrementer submit_attempts og la retry-løkke ta over (planlagt
// senere som Cloud Run Job — for nå skjer dette inline i webhook).

import { pool } from "../db";
import { gelatoFromEnv, GelatoError } from "./gelato/client";
import { renderToPdf } from "./pdf";
import { uploadPrintPdf } from "./storage";
import type { GelatoOrderItem } from "./gelato/types";

export interface FulfillResult {
  ok: boolean;
  gelatoOrderId?: string;
  reason?: string;
}

interface OrderRow {
  id: string;
  order_number: string;
  customer_email: string;
  status: string;
  gelato_order_id: string | null;
  gelato_order_reference_id: string;
  shipping_address: Record<string, unknown>;
  shipping_method_uid: string | null;
  currency: string;
  submit_attempts: number;
}

interface ItemRow {
  id: string;
  product_slug: string;
  gelato_product_uid: string;
  gelato_item_reference_id: string;
  quantity: number;
  source_event_id: string | null;
  source_template_key: string | null;
  design_choice: string;
  print_file_url: string | null;
}

interface ProductDimsRow {
  width_mm: number;
  height_mm: number;
  pdf_renderer: string;
  metadata: Record<string, unknown> | null;
}

const MAX_ATTEMPTS = 5;

export async function fulfillOrder(orderId: string): Promise<FulfillResult> {
  const orderRes = await pool.query<OrderRow>(
    `SELECT id, order_number, customer_email, status,
            gelato_order_id, gelato_order_reference_id, shipping_address,
            shipping_method_uid, currency, submit_attempts
     FROM print_orders WHERE id = $1`,
    [orderId],
  );
  const order = orderRes.rows[0];
  if (!order) {
    return { ok: false, reason: `Order ${orderId} ikke funnet` };
  }
  if (order.gelato_order_id) {
    console.log(`[fulfill] ${order.order_number} allerede submitted (gelato_id=${order.gelato_order_id})`);
    return { ok: true, gelatoOrderId: order.gelato_order_id };
  }
  if (order.submit_attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: `Max retries (${MAX_ATTEMPTS}) overskredet` };
  }

  // Inkrementer attempt-counter umiddelbart, så vi ikke spinner ved feil.
  await pool.query(
    `UPDATE print_orders SET submit_attempts = submit_attempts + 1, status='submitting', updated_at=NOW() WHERE id=$1`,
    [orderId],
  );

  try {
    const items = await pool.query<ItemRow & ProductDimsRow>(
      `SELECT i.id, i.product_slug, i.gelato_product_uid, i.gelato_item_reference_id,
              i.quantity, i.source_event_id, i.source_template_key, i.design_choice,
              i.print_file_url,
              p.width_mm, p.height_mm, p.pdf_renderer, p.metadata
       FROM print_order_items i
       JOIN print_products p ON p.slug = i.product_slug
       WHERE i.order_id = $1
       ORDER BY i.created_at`,
      [orderId],
    );

    // 1. Generer + last opp PDF-er for items som mangler print_file_url
    const gelatoItems: GelatoOrderItem[] = [];
    for (const it of items.rows) {
      let pdfUrl = it.print_file_url;
      if (!pdfUrl) {
        // Bygg payload til renderer. v1: QR-URL bygges fra event-ID hvis
        // sourceEventId finnes, ellers fra Evenero forside (fallback).
        const qrUrl = it.source_event_id
          ? `https://event.evenero.com/${it.source_event_id}`
          : `https://evenero.com`;
        const metadata = it.metadata || {};
        const pdfBuffer = await renderToPdf(it.pdf_renderer, {
          widthMm: it.width_mm,
          heightMm: it.height_mm,
          bleedMm: (metadata.bleedMm as number) ?? 3,
          payload: {
            qrUrl,
            // Tittel utelates på minimal-template — kan utvides når kunden
            // gir mer design-input (gjelder fallback-bruk).
          },
        });
        const uploaded = await uploadPrintPdf(orderId, it.id, pdfBuffer);
        pdfUrl = uploaded.url;
        await pool.query(
          `UPDATE print_order_items
           SET print_file_url=$1, print_file_generated_at=NOW()
           WHERE id=$2`,
          [pdfUrl, it.id],
        );
      }
      gelatoItems.push({
        itemReferenceId: it.gelato_item_reference_id,
        productUid: it.gelato_product_uid,
        quantity: it.quantity,
        files: [{ type: "default", url: pdfUrl }],
      });
    }

    // 2. Submit til Gelato med vår orderReferenceId som idempotency
    const addr = order.shipping_address as Record<string, string>;
    const gelato = gelatoFromEnv();
    const resp = await gelato.createOrder({
      orderType: "order",
      orderReferenceId: order.gelato_order_reference_id,
      customerReferenceId: order.order_number,
      currency: order.currency.toUpperCase(),
      recipient: {
        firstName: addr.firstName || addr.name?.split(" ")[0] || "Customer",
        lastName: addr.lastName || addr.name?.split(" ").slice(1).join(" ") || "X",
        addressLine1: addr.line1 || addr.addressLine1 || "",
        addressLine2: addr.line2 || addr.addressLine2 || undefined,
        city: addr.city || "",
        postCode: addr.postal_code || addr.postCode || "",
        state: addr.state || undefined,
        country: addr.country || "NO",
        email: order.customer_email,
        phone: addr.phone || undefined,
      },
      items: gelatoItems,
      shipmentMethodUid: order.shipping_method_uid || undefined,
      metadata: [
        { key: "evenero_order", value: order.order_number },
      ],
    });

    await pool.query(
      `UPDATE print_orders
       SET status='submitted', gelato_order_id=$1, submitted_at=NOW(), updated_at=NOW(),
           failure_reason=NULL
       WHERE id=$2`,
      [resp.id, orderId],
    );

    console.log(`[fulfill] ✓ ${order.order_number} → Gelato ${resp.id} (${gelatoItems.length} items)`);
    return { ok: true, gelatoOrderId: resp.id };
  } catch (err) {
    const isGelato = err instanceof GelatoError;
    const isPermanent = isGelato && err.status >= 400 && err.status < 500;
    const reason = (err as Error).message;
    await pool.query(
      `UPDATE print_orders
       SET status=$1, failure_reason=$2, updated_at=NOW()
       WHERE id=$3`,
      [isPermanent ? "failed" : "paid", reason.slice(0, 1000), orderId],
    );
    console.error(`[fulfill] ✗ ${order.order_number}: ${reason}`);
    return { ok: false, reason };
  }
}
