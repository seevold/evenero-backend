// Minimal QR-template renderer.
//
// Brukes både som "fallback" når kunden bestiller et format de ikke har
// designet selv, og som standardkvalitet for QR-only-bestillinger.
//
// Layout: QR sentrert med valgfri tittel under. CMYK-vennlig, 300 DPI,
// 3mm bleed på alle kanter (Gelato sin standard).

import PDFDocument from "pdfkit";
import QRCode from "qrcode";

export interface QrSimpleInput {
  /** Innholdet i QR-koden (URL) */
  qrUrl: string;
  /** Fysisk størrelse i mm */
  widthMm: number;
  heightMm: number;
  /** Hvor mye bleed (mm) — Gelato standard er 3mm */
  bleedMm?: number;
  /** Valgfri tittel under QR (event-navn, "Skann meg", osv.) */
  title?: string;
  /** Bakgrunnsfarge (hex), default hvit */
  backgroundColor?: string;
  /** QR-farge (hex), default svart */
  qrColor?: string;
  /** Tekstfarge (hex), default svart */
  textColor?: string;
  /** Antall sider PDF skal ha (1 for cl_4-0, 2 for cl_4-4-produkter).
   *  Default 1. Bakside er alltid blank hvit. */
  pages?: 1 | 2;
}

// Konverterings-konstanter
const MM_PER_INCH = 25.4;
const PDF_DPI = 72;          // pdfkit jobber i punkter = 1/72 tomme
const PRINT_DPI = 300;       // Gelato sitt minimum for raster-elementer

function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * PDF_DPI;
}

/**
 * Render QR-template til PDF-buffer.
 * Returnerer en Buffer som kan lastes til GCS direkte.
 */
export async function renderQrSimple(input: QrSimpleInput): Promise<Buffer> {
  const bleed = input.bleedMm ?? 3;
  const fullWidthMm = input.widthMm + bleed * 2;
  const fullHeightMm = input.heightMm + bleed * 2;
  const fullWidthPt = mmToPt(fullWidthMm);
  const fullHeightPt = mmToPt(fullHeightMm);

  const bg = input.backgroundColor ?? "#ffffff";
  const qrCol = input.qrColor ?? "#000000";
  const txtCol = input.textColor ?? "#1a1a1a";

  // Generer QR som PNG-buffer ved 300dpi for valgt fysisk størrelse.
  // QR-størrelse: 60% av minste side, sentrert.
  const minMm = Math.min(input.widthMm, input.heightMm);
  const qrSizeMm = minMm * 0.6;
  const qrSizePx = Math.round((qrSizeMm / MM_PER_INCH) * PRINT_DPI);

  const qrPngBuffer = await QRCode.toBuffer(input.qrUrl, {
    type: "png",
    errorCorrectionLevel: "M",       // M = god balanse; H er overkill for print
    margin: 0,
    width: qrSizePx,
    color: { dark: qrCol, light: bg },
  });

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [fullWidthPt, fullHeightPt],
      margin: 0,
      info: { Title: "Evenero QR Template", Producer: "Evenero" },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Bakgrunn (hele bleed-area)
    doc.rect(0, 0, fullWidthPt, fullHeightPt).fill(bg);

    // Sentrer QR-koden geometrisk
    const qrSizePt = mmToPt(qrSizeMm);
    const qrX = (fullWidthPt - qrSizePt) / 2;
    const qrY = (fullHeightPt - qrSizePt) / 2 - (input.title ? mmToPt(8) : 0);

    doc.image(qrPngBuffer, qrX, qrY, { width: qrSizePt, height: qrSizePt });

    // Valgfri tittel under QR
    if (input.title) {
      const titleFontSize = Math.max(8, Math.min(18, minMm / 6));
      doc.fillColor(txtCol);
      doc.font("Helvetica-Bold").fontSize(titleFontSize);
      doc.text(input.title, 0, qrY + qrSizePt + mmToPt(4), {
        width: fullWidthPt,
        align: "center",
      });
    }

    // For dobbeltsidige produkter: legg på en blank hvit bakside.
    // Gelato validerer page-count mot produkt-spec; vi må matche eksakt.
    if (input.pages === 2) {
      doc.addPage({ size: [fullWidthPt, fullHeightPt], margin: 0 });
      doc.rect(0, 0, fullWidthPt, fullHeightPt).fill(bg);
    }

    doc.end();
  });
}
