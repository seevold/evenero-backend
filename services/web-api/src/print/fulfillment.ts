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
import { buildTwoSidedPdfFromImage, pageCountForGelatoUid, GELATO_DEFAULT_BLEED_MM } from "./pdf/two-sided";
import { uploadPrintPdf, verifyDesignUrlReachable } from "./storage";
import { sendFulfillmentFailureAlert, sendPrintOrderShipped, type PrintShipmentInfo } from "./email";
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

/**
 * Én pakke (shipment) fra Gelato. Vi lagrer en array av disse på
 * print_orders.shipments — én rad pr fysisk pakke kunden får.
 */
export interface PrintShipment {
  /** Gelato's package-ID (unik, brukes for idempotency på shipped-mail) */
  packageId: string;
  trackingCode: string;
  trackingUrl: string;
  carrier: string;
  /** itemReferenceId-er som er i denne pakken (eks. ["poster_a3-...", "poster_a2-..."]) */
  itemRefs: string[];
  /** Vekt i gram (informativt, fra Gelato) */
  weightGrams?: number;
}

/**
 * Henter aktuelle pakker fra Gelato sin order-API og lagrer dem på
 * print_orders.shipments. Trygt å kjøre flere ganger (idempotent).
 *
 * Returnerer hvilke pakker som er NYE siden forrige kjøring — caller kan
 * bruke det til å sende shipped-mail kun ved første gangs deteksjon.
 */
export async function refreshShipmentsFromGelato(
  orderId: string,
): Promise<{ shipments: PrintShipment[]; newPackageIds: string[] }> {
  const r = await pool.query<{ gelato_order_id: string | null; shipments: PrintShipment[] }>(
    `SELECT gelato_order_id, shipments FROM print_orders WHERE id=$1`,
    [orderId],
  );
  const row = r.rows[0];
  if (!row?.gelato_order_id) {
    return { shipments: [], newPackageIds: [] };
  }
  const previousIds = new Set((row.shipments || []).map((s) => s.packageId));

  const gelato = gelatoFromEnv();
  const order = await gelato.getOrder(row.gelato_order_id);
  // Gelato's responstype er løs — vi caster til en lokal struktur for
  // shipment.packages siden den ikke ligger i den genererte type-mapping.
  const shipmentRaw = (order as unknown as {
    shipment?: {
      shipmentMethodName?: string;
      packages?: Array<{
        id: string;
        trackingCode?: string;
        trackingUrl?: string;
        orderItemIds?: string[];
        weight?: number;
      }>;
    };
  }).shipment;
  const carrier = shipmentRaw?.shipmentMethodName || "";

  // Bygg map: Gelato item-ID → vår itemReferenceId så pakker kan beskrives med
  // produkt-slug-prefiks i stedet for opake UUIDs.
  const idToRef = new Map<string, string>();
  for (const it of (order as unknown as { items: Array<{ id: string; itemReferenceId: string }> }).items || []) {
    idToRef.set(it.id, it.itemReferenceId);
  }

  const shipments: PrintShipment[] = (shipmentRaw?.packages || [])
    .filter((p) => p.trackingCode && p.trackingUrl)
    .map((p) => ({
      packageId: p.id,
      trackingCode: p.trackingCode!,
      trackingUrl: p.trackingUrl!,
      carrier,
      itemRefs: (p.orderItemIds || []).map((id) => idToRef.get(id) || id),
      weightGrams: p.weight,
    }));

  const newPackageIds = shipments
    .map((s) => s.packageId)
    .filter((id) => !previousIds.has(id));

  // Lagre. Speil første pakke til de gamle tracking_*-feltene for
  // bakoverkompatibilitet (eldre kode-stier som leser dem direkte).
  const first = shipments[0];
  await pool.query(
    `UPDATE print_orders
     SET shipments = $2::jsonb,
         tracking_url = COALESCE($3, tracking_url),
         tracking_code = COALESCE($4, tracking_code),
         carrier = COALESCE($5, carrier),
         updated_at = NOW()
     WHERE id = $1`,
    [
      orderId,
      JSON.stringify(shipments),
      first?.trackingUrl ?? null,
      first?.trackingCode ?? null,
      first ? first.carrier : null,
    ],
  );

  return { shipments, newPackageIds };
}

/**
 * Synker hele ordre-staten fra Gelato — status-overgang + shipments-array.
 * Single source of truth som BÅDE webhook-handler og polling-job kaller.
 *
 * Garantier:
 *   - Idempotent: trygt å kalle flere ganger med samme Gelato-state
 *   - Self-healing: hvis status er bak Gelato (eks. webhook missed), tar
 *     denne oss til riktig state ved neste kall
 *   - Triggrer shipped-mail KUN første gang vi krysser shipped-grensen
 *     (atomisk via UPDATE ... WHERE shipped_at IS NULL ... RETURNING)
 *
 * Returnerer hva som faktisk endret seg så caller (eks. polling-job) kan
 * loggføre antall faktiske oppdateringer.
 */
export interface SyncResult {
  statusChanged: boolean;
  newStatus: string;
  shipmentsCount: number;
  newPackageIds: string[];
  shippedMailSent: boolean;
}

export async function syncOrderFromGelato(orderId: string): Promise<SyncResult> {
  const r = await pool.query<{
    gelato_order_id: string | null;
    order_number: string;
    customer_email: string;
    locale: string;
    app_base_url: string;
    status: string;
    shipped_at: Date | null;
  }>(
    `SELECT gelato_order_id, order_number, customer_email, locale,
            app_base_url, status, shipped_at
     FROM print_orders WHERE id=$1`,
    [orderId],
  );
  const row = r.rows[0];
  if (!row?.gelato_order_id) {
    return { statusChanged: false, newStatus: row?.status || "unknown", shipmentsCount: 0, newPackageIds: [], shippedMailSent: false };
  }

  const gelato = gelatoFromEnv();
  const order = await gelato.getOrder(row.gelato_order_id);
  const gelatoStatus = (order as unknown as { fulfillmentStatus?: string }).fulfillmentStatus || "";

  // Mapp Gelato-status → vår status. Gelato har: draft, uploading, passed,
  // pending_approval, in_production, printed, shipped, delivered, canceled, failed.
  // Vi kollapser noen av dem til den samme interne statusen.
  let targetStatus: string | null = null;
  if (gelatoStatus === "shipped") targetStatus = "shipped";
  else if (gelatoStatus === "delivered") targetStatus = "delivered";
  else if (gelatoStatus === "canceled") targetStatus = "cancelled";
  else if (["printed", "in_production", "passed", "uploading"].includes(gelatoStatus)) {
    targetStatus = "in_production";
  }
  // Hvis Gelato-status er noe vi ikke håndterer (draft, pending_approval, failed),
  // lar vi vår status være som den er — webhook eller manuelt inngrep tar over.

  let statusChanged = false;
  let shippedMailSent = false;
  let shouldSendShippedMail = false;

  if (targetStatus && targetStatus !== row.status) {
    // shipped-overgang er spesiell: vi vil trigge mail KUN ved første gang.
    if (targetStatus === "shipped") {
      // Sett status + shipped_at atomisk, returnerer was_unshipped-flagget.
      const upd = await pool.query<{ was_unshipped: boolean }>(
        `WITH prev AS (
           SELECT id, shipped_at IS NULL AS was_unshipped FROM print_orders WHERE id=$1
         )
         UPDATE print_orders po
         SET status='shipped', shipped_at=COALESCE(shipped_at, NOW()), updated_at=NOW()
         FROM prev WHERE po.id = prev.id
         RETURNING prev.was_unshipped`,
        [orderId],
      );
      statusChanged = true;
      shouldSendShippedMail = !!upd.rows[0]?.was_unshipped;
    } else if (targetStatus === "delivered") {
      await pool.query(
        `UPDATE print_orders SET status='delivered',
           delivered_at=COALESCE(delivered_at, NOW()),
           shipped_at=COALESCE(shipped_at, NOW()),
           updated_at=NOW()
         WHERE id=$1`,
        [orderId],
      );
      statusChanged = true;
    } else if (targetStatus === "cancelled") {
      await pool.query(
        `UPDATE print_orders SET status='cancelled',
           failure_reason=COALESCE(failure_reason, 'Bestillingen ble kansellert hos trykkeriet'),
           updated_at=NOW() WHERE id=$1`,
        [orderId],
      );
      statusChanged = true;
    } else if (targetStatus === "in_production") {
      await pool.query(
        `UPDATE print_orders SET status='in_production', updated_at=NOW()
         WHERE id=$1 AND status NOT IN ('shipped','delivered','cancelled')`,
        [orderId],
      );
      statusChanged = true;
    }
  }

  // Refresh shipments uansett status — pakker kan komme før status flippes.
  const { shipments, newPackageIds } = await refreshShipmentsFromGelato(orderId);

  // Send shipped-mail hvis (a) vi nettopp krysset shipped-grensen OG
  // (b) vi har minst én pakke med tracking. Hvis ingen pakker enda, lar vi
  // neste polling-iterasjon (eller webhook) trigge mailen når data finnes.
  if (shouldSendShippedMail && shipments.length > 0) {
    const appBase = (row.app_base_url || "").replace(/\/$/, "");
    const statusUrl = appBase ? `${appBase}/print/order/${row.order_number}` : "";
    const shipmentInfos: PrintShipmentInfo[] = shipments.map((s) => ({
      trackingCode: s.trackingCode,
      trackingUrl: s.trackingUrl,
      carrier: s.carrier,
    }));
    try {
      await sendPrintOrderShipped({
        orderNumber: row.order_number,
        customerEmail: row.customer_email,
        locale: row.locale || "en",
        shipments: shipmentInfos,
        statusUrl,
      });
      shippedMailSent = true;
    } catch (err) {
      console.error(`[sync] shipped-mail feilet for ${row.order_number}:`, err);
    }
  }

  return {
    statusChanged,
    newStatus: targetStatus || row.status,
    shipmentsCount: shipments.length,
    newPackageIds,
    shippedMailSent,
  };
}

/** Last ned en URL til Buffer, eller kast hvis fail/tom. Brukes når vi må
 *  prosessere en allerede-opplastet design (JPG → 2-page PDF wrap). */
async function downloadBufferOrThrow(url: string, itemId: string): Promise<Buffer> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) {
      throw new GelatoError(
        `Kunne ikke laste ned design for item ${itemId}: HTTP ${res.status}`,
        422,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5_000) {
      throw new GelatoError(
        `Design for item ${itemId} er mistenkelig liten (${buf.length} bytes)`,
        422,
      );
    }
    return buf;
  } finally {
    clearTimeout(t);
  }
}

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
      const metadata = it.metadata || {};
      // Gelato's standard for vår katalog er 4mm bleed (verifisert mot
      // deres avvisnings-mail). Per-produkt override via metadata.bleedMm
      // hvis en produkt-variant senere har annet krav.
      const bleedMm = (metadata.bleedMm as number) ?? GELATO_DEFAULT_BLEED_MM;
      // Antall sider Gelato krever — fra cl_X-Y i productUid. Sender vi
      // feil antall får vi "Product requires exactly N pages" og ordren
      // går aldri til print.
      const requiredPages = pageCountForGelatoUid(it.gelato_product_uid);

      if (!pdfUrl) {
        // Bygg payload til renderer. v1: QR-URL bygges fra event-ID hvis
        // sourceEventId finnes, ellers fra Evenero forside (fallback).
        const qrUrl = it.source_event_id
          ? `https://event.evenero.com/${it.source_event_id}`
          : `https://evenero.com`;
        const pdfBuffer = await renderToPdf(it.pdf_renderer, {
          widthMm: it.width_mm,
          heightMm: it.height_mm,
          bleedMm,
          pages: requiredPages,
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
      } else if (requiredPages === 2) {
        // Brukerens design ligger som JPG (eller PNG) fra "Tilpass og bestill".
        // Dobbeltsidige produkter trenger en 2-page PDF — last ned bildet,
        // wrap det som side 1 og legg en blank bakside som side 2.
        // Idempotent: detekteres på at filen ender på .pdf (allerede wrapped).
        const isAlreadyPdf = pdfUrl.split("?")[0].toLowerCase().endsWith(".pdf");
        if (!isAlreadyPdf) {
          const imgBuf = await downloadBufferOrThrow(pdfUrl, it.id);
          const pdfBuffer = await buildTwoSidedPdfFromImage({
            frontImageBuffer: imgBuf,
            widthMm: it.width_mm,
            heightMm: it.height_mm,
            bleedMm,
          });
          const uploaded = await uploadPrintPdf(orderId, `${it.id}-2sided`, pdfBuffer);
          pdfUrl = uploaded.url;
          await pool.query(
            `UPDATE print_order_items
             SET print_file_url=$1, print_file_generated_at=NOW()
             WHERE id=$2`,
            [pdfUrl, it.id],
          );
        }
      }

      // Pre-Gelato-vakt: verifiser at print-fila faktisk er hentbar + et
      // gyldig dokument FØR vi sender til trykk. Hindrer at en død URL eller
      // tom fil ender opp som en trykket tom plakat.
      const reachable = await verifyDesignUrlReachable(pdfUrl);
      if (!reachable) {
        throw new GelatoError(
          `Print-fil for item ${it.id} er ikke hentbar/gyldig (${pdfUrl.slice(0, 80)})`,
          422,  // behandles som permanent feil → ordren markeres failed
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
    // Draft-mode: staging-miljø bruker dette for å unngå faktisk print/fakturering
    // under test. Settes via GELATO_DRAFT_MODE env-var.
    const orderType = process.env.GELATO_DRAFT_MODE === "true" ? "draft" : "order";
    if (orderType === "draft") {
      console.log(`[fulfill] DRAFT MODE — Gelato vil ikke faktisk printe/sende`);
    }
    const resp = await gelato.createOrder({
      orderType,
      orderReferenceId: order.gelato_order_reference_id,
      customerReferenceId: order.order_number,
      currency: order.currency.toUpperCase(),
      // Gelato v4 createOrder vil ha `shippingAddress`, IKKE `recipient`
      // (recipient er bare for quote-endpointet). Se kommentar på
      // GelatoCreateOrderRequest-typen for full forklaring.
      shippingAddress: {
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

    // Inkrementert allerede ved start av forsøket (over).
    const attemptNow = order.submit_attempts + 1;
    const isFinalTransient = !isPermanent && attemptNow >= MAX_ATTEMPTS;

    // Atomic: sett failure-status OG marker som alarmert SAMTIDIG. Returnerer
    // hva som faktisk endret seg — så vi sender alert KUN første gang vi
    // krysser fra "ikke-alarmert" til "alarmert" (idempotency, ingen spam).
    const updateRes = await pool.query<{ should_alert: boolean }>(
      `UPDATE print_orders
       SET status=$1, failure_reason=$2, updated_at=NOW(),
           lasse_notified_at = CASE
             WHEN ($4::bool AND lasse_notified_at IS NULL) THEN NOW()
             ELSE lasse_notified_at
           END
       WHERE id=$3
       RETURNING (lasse_notified_at = (SELECT NOW())) AS should_alert`,
      [
        isPermanent ? "failed" : "paid",
        reason.slice(0, 1000),
        orderId,
        isPermanent || isFinalTransient,
      ],
    );
    console.error(`[fulfill] ✗ ${order.order_number}: ${reason}`);

    // Fire alert i bakgrunnen — blokkerer ikke returnverdi.
    if (updateRes.rows[0]?.should_alert) {
      const appBase = (order.shipping_address as Record<string, string>)?.app_base_url
        || ""; // app_base_url ligger i order-tabellen, ikke shipping_address — refresh nedenfor
      // Bruk en kjapp re-query for app_base_url (samme transaksjon ikke nødvendig her)
      const r = await pool.query<{ app_base_url: string }>(
        `SELECT app_base_url FROM print_orders WHERE id=$1`, [orderId],
      );
      const base = (r.rows[0]?.app_base_url || appBase).replace(/\/$/, "");
      sendFulfillmentFailureAlert({
        orderNumber: order.order_number,
        customerEmail: order.customer_email,
        failureReason: reason,
        isPermanent,
        submitAttempts: attemptNow,
        statusUrl: base ? `${base}/print/order/${order.order_number}` : "",
      }).catch((e) => console.error(`[fulfill] alert-send feilet for ${order.order_number}:`, e));
    }

    return { ok: false, reason };
  }
}
