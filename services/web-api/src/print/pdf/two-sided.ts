// 2-page PDF-builder for dobbeltsidige Gelato-produkter.
//
// Gelato's v4 createOrder validerer at antall sider i print-fila matcher
// produkt-spec'en EKSAKT. cl_4-4 (4-farger forside + 4-farger bakside) krever
// 2 sider. cl_4-0 (4-farger forside, blank bakside) krever 1 side.
//
// For et 4-4-produkt får vi typisk en ferdig JPG fra "Tilpass og bestill"-
// flyten — den har bare forsiden. Denne helperen tar JPG'en, embed'er den
// som side 1 i en 2-sides PDF, og legger til en blank hvit bakside.
//
// Bakside: bevisst HELT BLANK for V1. Når vi senere vil ha bakside-design
// (Evenero-logo, mini-QR, "Trykt av Evenero"-tekst), utvider vi denne fila
// med en `backRenderer`-parameter.

import PDFDocument from "pdfkit";

const MM_PER_INCH = 25.4;
const PDF_DPI = 72;

function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * PDF_DPI;
}

export interface BuildTwoSidedInput {
  /** Brukerens design (JPG eller PNG buffer). Skal allerede være beskåret
   *  til produkt-aspektet — vi strekker den til full bleed-area. */
  frontImageBuffer: Buffer;
  /** Trim-størrelse i mm (uten bleed) */
  widthMm: number;
  heightMm: number;
  /** Bleed på alle sider (Gelato standard = 3mm) */
  bleedMm: number;
}

/**
 * Bygger en 2-page PDF med kundens design på side 1 og blank hvit bakside
 * på side 2. Page-størrelsen inkluderer bleed (trim + 2*bleedMm).
 *
 * Bilde-plassering: strekker designet til hele bleed-area (cover). Vår
 * printCapture i frontend produserer allerede en JPG med korrekt
 * produkt-aspekt, så ingen ekstra crop-forvrengning her. Det vil si at
 * design-edge ligger PÅ trim-line — kan gi små hvite striper hvis Gelato
 * kutter litt utenfor. Akseptabelt for V1; for proper bleed bør frontend
 * legge til ekstra 3mm rundt designet før capture (TODO senere).
 */
export async function buildTwoSidedPdfFromImage(input: BuildTwoSidedInput): Promise<Buffer> {
  const fullWmm = input.widthMm + input.bleedMm * 2;
  const fullHmm = input.heightMm + input.bleedMm * 2;
  const fullW = mmToPt(fullWmm);
  const fullH = mmToPt(fullHmm);

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
    // har transparens.
    doc.rect(0, 0, fullW, fullH).fill("#ffffff");
    // Strekker designet til hele bleed-area. pdfkit's image-funksjon med
    // width+height tvinger eksakte dimensjoner uten aspect-ratio-bevaring,
    // men siden vår JPG allerede er beskåret til riktig aspect blir det rent.
    doc.image(input.frontImageBuffer, 0, 0, { width: fullW, height: fullH });

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
