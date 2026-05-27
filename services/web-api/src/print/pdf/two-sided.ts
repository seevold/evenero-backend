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
 * på side 2.
 *
 * Side-størrelse = trim-størrelse (uten bleed-extension). Vår frontend-
 * capture produserer en JPG med trim-aspekt (90×55, 148×105 etc) uten
 * eget bleed-område. Hvis vi her bygde en bleed-extended page (96×61) og
 * strekte JPG-en til å fylle den, ville aspekt-mismatch (1.636 vs 1.574 for
 * BC) stretche designet ~5% vertikalt og kappe innholdet visuelt. Cleaner
 * å la PDF-en være trim-only — Gelato håndterer bleed via egen prosessering
 * og evt. auto-mirror. Hvis Lasse ser hvite striper på trykket kan vi
 * legge til mirror/blur-bleed-extension senere.
 *
 * bleedMm-parameteren beholdes for fremtidig bruk (bleed-extension med
 * mirror eller blur av kantene) men ignoreres i V1.
 */
export async function buildTwoSidedPdfFromImage(input: BuildTwoSidedInput): Promise<Buffer> {
  const fullW = mmToPt(input.widthMm);
  const fullH = mmToPt(input.heightMm);

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
    // Hvit bakgrunn først så transparente JPGer/PNGer ikke gir tomme felter.
    doc.rect(0, 0, fullW, fullH).fill("#ffffff");
    // JPG-en har samme aspekt som siden (trim-aspekt), så pdfkit's image
    // med eksakt bredde/høyde gir 1:1-render uten distortion.
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
