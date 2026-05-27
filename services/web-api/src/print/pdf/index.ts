// PDF-renderer registry.
//
// Hver produkt-rad har `pdf_renderer`-felt som peker hit. Når en bestilling
// fulfilles, kaller fulfillment-logikken renderToPdf({ rendererSlug, ... })
// som dispatcher til riktig renderer.
//
// Legge til ny renderer: opprett ny fil i denne mappen, registrer i RENDERERS.

import { renderQrSimple, type QrSimpleInput } from "./qr-simple";

export interface RenderInput {
  /** Produkt-størrelse i mm — alle renderere tar dette */
  widthMm: number;
  heightMm: number;
  bleedMm?: number;
  /** Antall sider PDF skal ha. Setter Gelato side-validering;
   *  ensidige produkter (cl_4-0) = 1, dobbeltsidige (cl_4-4) = 2. */
  pages?: 1 | 2;
  /** Renderer-spesifikk input */
  payload: Record<string, unknown>;
}

export type RenderFn = (input: RenderInput) => Promise<Buffer>;

// QR-simple — bruker payload.qrUrl + valgfritt title/colors.
const qrSimpleAdapter: RenderFn = async (input) => {
  const qrInput: QrSimpleInput = {
    qrUrl: String(input.payload.qrUrl ?? ""),
    widthMm: input.widthMm,
    heightMm: input.heightMm,
    bleedMm: input.bleedMm,
    title: input.payload.title ? String(input.payload.title) : undefined,
    backgroundColor: input.payload.backgroundColor
      ? String(input.payload.backgroundColor) : undefined,
    qrColor: input.payload.qrColor ? String(input.payload.qrColor) : undefined,
    textColor: input.payload.textColor ? String(input.payload.textColor) : undefined,
    pages: input.pages,
  };
  if (!qrInput.qrUrl) throw new Error("qr-simple: payload.qrUrl mangler");
  return renderQrSimple(qrInput);
};

export const RENDERERS: Record<string, RenderFn> = {
  qr_simple: qrSimpleAdapter,
  // thank_you: ... (legges til når takkekort-produkt opprettes)
  // photo_book: ... (legges til senere)
};

/** Dispatcher — kaster hvis renderer ikke finnes. */
export async function renderToPdf(
  rendererSlug: string,
  input: RenderInput,
): Promise<Buffer> {
  const renderer = RENDERERS[rendererSlug];
  if (!renderer) {
    throw new Error(`PDF-renderer '${rendererSlug}' er ikke registrert`);
  }
  return renderer(input);
}
