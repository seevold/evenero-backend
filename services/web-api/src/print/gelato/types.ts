// TypeScript-typer for Gelato API-respons.
// Bare det vi faktisk bruker — utvider når nye endpoints tas i bruk.

export interface GelatoShipmentMethod {
  shipmentMethodUid: string;
  name: string;
  type: "normal" | "express" | "pick_up";
  price: number;          // i quote-valuta
  currency: string;
  minDeliveryDays: number;
  maxDeliveryDays: number;
  minDeliveryDate?: string;
  maxDeliveryDate?: string;
  totalWeight: number;
  packageCount: number;
  incoTerms: string;      // 'DDP' = Delivered Duty Paid
  isPrivate: boolean;
  isBusiness: boolean;
}

export interface GelatoQuoteProduct {
  itemReferenceId: string;
  productUid: string;
  quantity: number;
  pageCount: number | null;
  price: number;
  currency: string;
}

export interface GelatoQuote {
  id: string;
  itemReferenceIds: string[];
  products: GelatoQuoteProduct[];
  shipmentMethods: GelatoShipmentMethod[];
  fulfillmentCountry: string;
}

export interface GelatoQuoteResponse {
  orderReferenceId: string;
  quotes: GelatoQuote[];
}

export interface GelatoRecipient {
  firstName: string;
  lastName: string;
  companyName?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  postCode: string;
  state?: string;
  country: string;          // ISO-2
  email: string;
  phone?: string;
}

export interface GelatoOrderItem {
  itemReferenceId: string;
  productUid: string;
  pageCount?: number | null;
  quantity: number;
  files: Array<{
    type: "default" | "back" | "envelope";
    url: string;
  }>;
}

export interface GelatoCreateOrderRequest {
  orderType: "order" | "draft";
  orderReferenceId: string;            // vår idempotency-key
  customerReferenceId: string;
  currency: string;
  /**
   * KRITISK: Gelato v4 bruker forskjellige feltnavn for samme adresse-skjema:
   *   - POST /v4/orders         → `shippingAddress` (denne!)
   *   - POST /v4/orders:quote   → `recipient`
   * Type-aliaset GelatoRecipient brukes for begge — innholdet er identisk,
   * kun feltnavnet på request-roten varierer. Hvis du bruker `recipient` på
   * create-order vil Gelato akseptere draft-ordre med null shippingAddress,
   * men avvise ekte ordre med 400 "Shipping address can't be empty."
   */
  shippingAddress: GelatoRecipient;
  items: GelatoOrderItem[];
  shipmentMethodUid?: string;          // hvis utelatt: Gelato velger billigste normal
  metadata?: Array<{ key: string; value: string }>;
}

export interface GelatoCreateOrderResponse {
  id: string;                          // Gelato order ID
  orderReferenceId: string;
  customerReferenceId: string;
  fulfillmentStatus: string;
  financialStatus: string;
  currency: string;
  channel: string;
  country: string;
  createdAt: string;
  items: Array<{
    id: string;
    itemReferenceId: string;
    productUid: string;
    fulfillmentStatus: string;
    quantity: number;
  }>;
  shipment?: {
    shipmentMethodUid: string;
    shipmentMethodName: string;
    minDeliveryDate?: string;
    maxDeliveryDate?: string;
  };
  receipts?: Array<{
    id: string;
    productTotal: number;
    shippingTotal: number;
    taxTotal: number;
    total: number;
    currency: string;
  }>;
}

// Webhook payload — minimal felter vi bryr oss om.
// Gelato sender mange event-typer; vi prosesserer status-endringer + tracking.
export interface GelatoWebhookPayload {
  id: string;
  event: string;               // 'order_status_updated', 'order_item_status_updated', etc.
  orderReferenceId?: string;
  fulfillmentStatus?: string;
  orderItemId?: string;
  itemReferenceId?: string;
  trackingCode?: string;
  trackingUrl?: string;
  carrierName?: string;
  // ... + andre felter — vi lagrer hele payload jsonb uansett
  [key: string]: unknown;
}
