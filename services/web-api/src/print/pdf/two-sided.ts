// 2-page PDF-builder for dobbeltsidige Gelato-produkter.
//
// Gelato's v4 createOrder validerer at PDF-en har:
//   1. Riktig antall sider (cl_4-Y i productUid: Y>0 → 2 sider)
//   2. Riktig side-størrelse (trim + 4mm bleed på alle sider)
//   3. Content som strekker seg ut i bleed-området (ingen hvite striper)
//
// Bekreftet via Gelato sin avvisnings-mail (EV-2026-0006):
//   postcard_a6 (105×148 trim) → 113×156 page
//   postcard_a5 (148×210 trim) → 156×218 page
//   card_sq_14  (141×141 trim) → 149×149 page
//   businesscard_bc (90×55 trim) → 98×63 page
// Dvs. 4mm bleed pr side, alle sider, for ALLE 4-4-produkter i vår katalog.
//
// Vår captureDesignForPrint produserer en JPG i TRIM-aspekt (uten bleed).
// For å oppfylle Gelato's spec uten å designe om hele capture-flyten:
//   - PDF-side bygges på bleed-extended-størrelse
//   - JPG-en plasseres med pdfkit's `cover`-option, som bevarer aspect og
//     fyller bleed-arealet ved å scale opp + cropp marginalt på sidene
//   - Crop-mengden er ~5% av JPG-bredden (eller -høyden) — fyll-aksen
//     bestemmes av aspect-diff. Våre templates har 130px padding inni
//     (~6.6mm), så crop på 2.5mm hver kant ligger trygt utenfor content.

import PDFDocument from "pdfkit";

const MM_PER_INCH = 25.4;
const PDF_DPI = 72;

function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * PDF_DPI;
}

/** Gelato standard for kort/postcards/visitkort i vår katalog (verifisert
 *  mot deres avvisnings-mail). Per-produkt-override mulig via metadata. */
export const GELATO_DEFAULT_BLEED_MM = 4;

export interface BuildTwoSidedInput {
  /** Brukerens design (JPG eller PNG buffer). Skal allerede være beskåret
   *  til produkt-aspektet — vi cover-fitter den til bleed-arealet. */
  frontImageBuffer: Buffer;
  /** Trim-størrelse i mm (uten bleed) */
  widthMm: number;
  heightMm: number;
  /** Bleed på alle sider. Standard = GELATO_DEFAULT_BLEED_MM. */
  bleedMm: number;
}

/**
 * Bygger en 2-page PDF med kundens design på side 1 og blank hvit bakside
 * på side 2.
 *
 * Side-størrelse = (widthMm + 2*bleedMm) × (heightMm + 2*bleedMm).
 * Bilde-plassering: cover-fit (preserve aspect, crop kanter) — sentert.
 * Hvit bakgrunn under bildet i tilfelle JPG ikke når helt ut til kantene.
 */
export async function buildTwoSidedPdfFromImage(input: BuildTwoSidedInput): Promise<Buffer> {
  const fullW = mmToPt(input.widthMm + input.bleedMm * 2);
  const fullH = mmToPt(input.heightMm + input.bleedMm * 2);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [fullW, fullH],
      margin: 0,
      info: { Title: "Evenero double-sided print", Producer: "Evenero" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Side 1: forside (design) ──────────────────────────────────────────
    // Hvit bakgrunn først så vi har noe å falle tilbake på hvis bildet
    // ikke når kantene (skal ikke skje med våre templates, men sikkerhetsnett).
    doc.rect(0, 0, fullW, fullH).fill("#ffffff");
    // cover-fit: bevarer aspect, skalerer slik at bildet FYLLER hele
    // bleed-arealet, kropper marginalt der aspect-diff krever det.
    doc.image(input.frontImageBuffer, 0, 0, {
      cover: [fullW, fullH],
      align: "center",
      valign: "center",
    });

    // ── Side 2: bakside (blank) ──────────────────────────────────────────
    doc.addPage({ size: [fullW, fullH], margin: 0 });
    doc.rect(0, 0, fullW, fullH).fill("#ffffff");

    doc.end();
  });
}

/**
 * Detekterer om et Gelato productUid representerer et dobbeltsidig produkt.
 *
 * Konvensjon i Gelato: ..._cl_X-Y_... der X=forside-farger, Y=bakside-farger.
 *   - cl_4-4 → 2 sider (4-farger trykk på begge)
 *   - cl_4-1 → 2 sider (sort/hvit bakside)
 *   - cl_4-0 → 1 side (kun forside)
 *   - mangler cl_ → anta 1 side (sikker default)
 *
 * Eksempler fra vår katalog:
 *   pack_of_cards_qt_10_pcs_pf_a6_..._cl_4-4_...    → 2 sider
 *   cards_pf_bc_pt_350-gsm-coated-silk_cl_4-4_...   → 2 sider (visitkort)
 *   posters_pf_a3_pt_170-gsm-uncoated_cl_4-0_ver    → 1 side
 *   flat_product_pf_a2_..._cl_4-0_...               → 1 side
 */
export function pageCountForGelatoUid(uid: string): 1 | 2 {
  const m = uid.match(/_cl_\d-(\d)/);
  if (m && parseInt(m[1], 10) > 0) return 2;
  return 1;
}
