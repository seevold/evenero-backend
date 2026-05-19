// Gelato API-klient — tynn wrapper rundt fetch.
// Auth: X-API-KEY header (én nøkkel per miljø, fra Secret Manager).
//
// Gelato har separate api-hoster per service:
//   - product.gelatoapis.com   — katalog, priser
//   - order.gelatoapis.com     — ordre + quotes
//   - shipment.gelatoapis.com  — shipment-methods (vi bruker quote i stedet)
//
// VIKTIG: Gelato Cloudflare blokkerer python-urllib og lignende default UAs.
// Vi setter Node-fetch sin default UA som er OK.

import type {
  GelatoCreateOrderRequest,
  GelatoCreateOrderResponse,
  GelatoQuoteResponse,
  GelatoRecipient,
} from "./types";

const PRODUCT_BASE = "https://product.gelatoapis.com";
const ORDER_BASE = "https://order.gelatoapis.com";

export class GelatoError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "GelatoError";
  }
}

export interface GelatoClientOpts {
  apiKey: string;
  timeoutMs?: number;
}

export interface PriceTier {
  quantity: number;
  price: number;
  currency: string;
}

export interface QuoteInput {
  orderReferenceId: string;
  currency: string;
  recipient: Pick<GelatoRecipient,
    "firstName" | "lastName" | "addressLine1" | "city" | "postCode" | "country" | "email">;
  products: Array<{
    itemReferenceId: string;
    productUid: string;
    quantity: number;
  }>;
}

export class GelatoClient {
  private apiKey: string;
  private timeoutMs: number;

  constructor(opts: GelatoClientOpts) {
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<T> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "X-API-KEY": this.apiKey,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        throw new GelatoError(
          `Gelato ${method} ${url} → ${res.status}: ${text.slice(0, 200)}`,
          res.status,
          parsed,
        );
      }
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Catalog / pricing ────────────────────────────────────────────────

  /** Henter pris-tiers for en spesifikk SKU i et land. Returnerer tom liste
   *  hvis SKU-en ikke finnes i landet — caller må håndtere. */
  async getProductPrices(
    productUid: string,
    country: string,
    currency: string,
  ): Promise<PriceTier[]> {
    const url = `${PRODUCT_BASE}/v3/products/${encodeURIComponent(productUid)}/prices`
      + `?country=${country}&currency=${currency}`;
    const raw = await this.request<unknown>("GET", url);
    // Endpoint returnerer enten array eller { data: [...] } avhengig av versjon
    const arr = Array.isArray(raw) ? raw : (raw as { data?: unknown[] })?.data ?? [];
    return (arr as Array<{ quantity: number; price: number; currency: string }>).map((t) => ({
      quantity: t.quantity,
      price: t.price,
      currency: t.currency,
    }));
  }

  // ─── Quote (price + shipping for konkret bestilling) ──────────────────

  async quoteOrder(input: QuoteInput): Promise<GelatoQuoteResponse> {
    const payload = {
      orderReferenceId: input.orderReferenceId,
      customerReferenceId: "evenero",
      currency: input.currency,
      recipient: {
        ...input.recipient,
        lastName: input.recipient.lastName || "Test",
      },
      products: input.products.map((p) => ({
        itemReferenceId: p.itemReferenceId,
        productUid: p.productUid,
        pageCount: null,
        quantity: p.quantity,
      })),
    };
    return this.request<GelatoQuoteResponse>(
      "POST",
      `${ORDER_BASE}/v4/orders:quote`,
      payload,
    );
  }

  // ─── Order creation ───────────────────────────────────────────────────

  async createOrder(req: GelatoCreateOrderRequest): Promise<GelatoCreateOrderResponse> {
    return this.request<GelatoCreateOrderResponse>(
      "POST",
      `${ORDER_BASE}/v4/orders`,
      req,
    );
  }

  async getOrder(gelatoOrderId: string): Promise<GelatoCreateOrderResponse> {
    return this.request<GelatoCreateOrderResponse>(
      "GET",
      `${ORDER_BASE}/v4/orders/${encodeURIComponent(gelatoOrderId)}`,
    );
  }
}

/** Factory som leser API-key fra env. Throw hvis ikke satt — fail-fast
 *  per CLAUDE.md-mønstret. */
export function gelatoFromEnv(): GelatoClient {
  const key = process.env.GELATO_API_KEY;
  if (!key) {
    throw new Error("GELATO_API_KEY env-var er ikke satt");
  }
  return new GelatoClient({ apiKey: key });
}
