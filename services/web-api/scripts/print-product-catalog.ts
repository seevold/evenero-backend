// Produkt-katalog for print-on-demand v1.
// Definerer alle produkter + tier-strukturer. seed-/refresh-script bruker
// dette + Gelato-priser til å regne ut anker-pris i NOK med target margin.
//
// Endre disse for å legge til nye produkter eller justere markup.
// Etter endring: kjør `npm run print:seed -- --apply` i web-api.

export type CategoryDef = {
  slug: string;
  formatFamily: "2x3" | "1x1" | "businesscard";
  presentationMode: "quantity" | "size";
  displayName: Record<string, string>;
  displayOrder: number;
};

export type ProductVariantDef = {
  qty: number;
  gelatoUid?: string;          // overstyrer product.defaultGelatoUid
  recommended?: boolean;
  upgradeLabel?: string;
};

export type ProductAddonDef = {
  slug: string;
  label: Record<string, string>;
  description: Record<string, string>;
  surchargeMinor: number;            // kan være negativ (rabatt)
  gelatoUidOverride?: string;
  conflictsWith?: string[];          // slugs til addons som ikke kan velges sammen
};

export type ProductDef = {
  slug: string;
  categorySlug: string;
  displayName: Record<string, string>;
  widthMm: number;
  heightMm: number;
  defaultGelatoUid: string;
  variants: ProductVariantDef[];
  addons?: ProductAddonDef[];
  expressSurchargeMinor: number;
  markupTargetPct: number;
  allowedCountries?: string[];
  relatedProductSlugs?: string[];
  pdfRenderer?: string;
  /** Multiplier for displaying qty to user. F.eks. postkort sold per
   *  pack-of-10 → packSize=10, så qty=1 vises som "10 kort". */
  packSize?: number;
  /** Tillater custom qty over minste tier. F.eks. visitkort kan bestilles
   *  i custom-antall mellom break-points. */
  allowCustomQty?: boolean;
  /** Detaljert produkt-info vist i UI (matcher Gelato-spec). */
  productInfo?: {
    paper?: Record<string, string>;          // {no, en, ...} — "350gsm coated silk, matt-lamiert"
    sides?: Record<string, string>;          // "Trykk på begge sider"
    finishing?: Record<string, string>;      // "Matt-lamiering"
    deliveryDays?: Record<string, string>;   // "3-5 hverdager"
  };
  metadata?: Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────
// Land-whitelist v1 (21 land — verifisert i tidligere research)
// ─────────────────────────────────────────────────────────────────────────
export const ALL_COUNTRIES_V1 = [
  "NO","SE","DK","FI","IS",
  "DE","FR","NL","BE","AT","IE","ES","IT","PT","PL","CH",
  "GB","US","CA","AU","NZ",
];

// Postkort A6 har ikke normal shipping i US/CA (kun pickup → vi tilbyr ikke).
export const COUNTRIES_NO_POSTCARD = ALL_COUNTRIES_V1.filter(
  (c) => c !== "US" && c !== "CA",
);

// ─────────────────────────────────────────────────────────────────────────
// Kategorier — 5 stk
// ─────────────────────────────────────────────────────────────────────────
export const CATEGORIES: CategoryDef[] = [
  {
    slug: "businesscard",
    formatFamily: "businesscard",
    presentationMode: "quantity",
    displayName: { no: "Visitkort", en: "Business cards", sv: "Visitkort", es: "Tarjetas de visita" },
    displayOrder: 10, // billigst pr stk — vises først
  },
  {
    slug: "postcard",
    formatFamily: "2x3",
    presentationMode: "quantity",
    displayName: { no: "Postkort", en: "Postcards", sv: "Vykort", es: "Postales" },
    displayOrder: 20,
  },
  {
    slug: "card_sq",
    formatFamily: "1x1",
    presentationMode: "quantity",
    displayName: { no: "Square kort", en: "Square cards", sv: "Fyrkantiga kort", es: "Tarjetas cuadradas" },
    displayOrder: 30,
  },
  {
    slug: "poster_2x3",
    formatFamily: "2x3",
    presentationMode: "size",
    displayName: { no: "Plakat 2:3", en: "Poster 2:3", sv: "Affisch 2:3", es: "Póster 2:3" },
    displayOrder: 40,
  },
  {
    slug: "poster_1x1",
    formatFamily: "1x1",
    presentationMode: "size",
    displayName: { no: "Plakat 1:1", en: "Square poster", sv: "Fyrkantig affisch", es: "Póster cuadrado" },
    displayOrder: 50,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Produkter — 10 stk
// ─────────────────────────────────────────────────────────────────────────

// Felles cross-sell-mapping — refereres fra hver produkt-def.
const REL_BUSINESSCARD   = ["postcard_a6", "card_sq_14", "poster_2x3_30x40"];
const REL_POSTCARD       = ["businesscard_bc", "card_sq_14", "poster_2x3_30x40"];
const REL_CARD_SQ        = ["businesscard_bc", "postcard_a6", "poster_1x1_30x30"];
const REL_POSTER_2x3     = ["businesscard_bc", "postcard_a6", "poster_1x1_30x30"];
const REL_POSTER_1x1     = ["businesscard_bc", "card_sq_14", "poster_2x3_30x40"];

export const PRODUCTS: ProductDef[] = [
  // ─── VISITKORT (5.5 × 9 cm BC) ─────────────────────────────────────────
  // Min 50 stk. Standard = 350gsm coated silk matt-protection (Gelato's
  // tykkeste BC-papir). Addon "premium_paper" oppgraderer til dobbelsidig
  // matt-protection (luksuriøst stoff i hånda).
  // Gelato koster SAMME ved 50 stk uansett variant — addon-tillegget er ren
  // margin som dekker fremtidige Gelato-prisøkninger.
  {
    slug: "businesscard_bc",
    categorySlug: "businesscard",
    displayName: { no: "Visitkort", en: "Business cards", sv: "Visitkort", es: "Tarjetas de visita" },
    widthMm: 90, heightMm: 55,
    defaultGelatoUid: "cards_pf_bc_pt_350-gsm-coated-silk_cl_4-4_ct_matt-protection_hor",
    allowCustomQty: true,
    productInfo: {
      paper: { no: "350 g/m² coated silk", en: "350 gsm coated silk", sv: "350 g/m² coated silk", es: "350 g/m² coated silk" },
      sides: { no: "Trykk på begge sider", en: "Double-sided print", sv: "Tryck på båda sidor", es: "Impresión doble cara" },
      finishing: { no: "Matt-beskyttende lakk", en: "Matt protective coating", sv: "Matt skyddande lack", es: "Acabado mate protector" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    variants: [
      { qty: 50,  recommended: true },
      { qty: 100 },
      { qty: 250 },
      { qty: 500 },
    ],
    addons: [
      {
        slug: "single_sided",
        label: {
          no: "Kun trykk på forsiden",
          en: "Front side only",
          sv: "Endast tryck på framsidan",
          es: "Solo impresión frontal",
        },
        description: {
          no: "Bakside forblir blank — sparer 50 kr",
          en: "Back stays blank — saves 50 kr",
          sv: "Baksidan förblir blank — sparar 50 kr",
          es: "Reverso en blanco — ahorra 50 kr",
        },
        surchargeMinor: -5000, // −50 kr
        gelatoUidOverride: "cards_pf_bc_pt_350-gsm-coated-silk_cl_4-0_ct_matt-protection_hor",
        conflictsWith: ["premium_paper"],
      },
      {
        slug: "premium_paper",
        label: {
          no: "Premium dobbelsidig matt",
          en: "Premium double-sided matte",
          sv: "Premium dubbelsidig matt",
          es: "Premium mate doble cara",
        },
        description: {
          no: "Matt-lamiering på begge sider — gir tykkere, luksuriøs følelse",
          en: "Matt lamination on both sides — premium thickness and feel",
          sv: "Matt-laminering på båda sidor — premiumkänsla",
          es: "Laminado mate por ambos lados — sensación premium",
        },
        surchargeMinor: 10000, // +100 kr
        gelatoUidOverride: "cards_pf_bc_pt_350-gsm-coated-silk_cl_4-4_ct_matt-protection_prt_1-1_hor",
        conflictsWith: ["single_sided"],
      },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_BUSINESSCARD,
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 350 },
  },

  // ─── POSTKORT A6 (10.5 × 14.8 cm, pack of 10) ──────────────────────────
  // packSize=10 → frontend viser qty multiplisert (1 pack = "10 kort").
  {
    slug: "postcard_a6",
    categorySlug: "postcard",
    displayName: { no: "Postkort A6", en: "A6 postcards", sv: "A6-vykort", es: "Postales A6" },
    widthMm: 105, heightMm: 148,
    defaultGelatoUid: "pack_of_cards_qt_10_pcs_pf_a6_upt_350-gsm-130lb-coated-silk_cl_4-4_ct_none_prt_none_sft_none_set_none_hor",
    packSize: 10,
    productInfo: {
      paper: { no: "350 g/m² coated silk", en: "350 gsm coated silk", sv: "350 g/m² coated silk", es: "350 g/m² coated silk" },
      sides: { no: "Trykk på begge sider", en: "Double-sided print", sv: "Tryck på båda sidor", es: "Impresión doble cara" },
      finishing: { no: "Silke-glanset finish", en: "Silk-coated finish", sv: "Silke-finish", es: "Acabado satinado" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    variants: [
      { qty: 1,  recommended: true },  // 10 kort
      { qty: 3 },                       // 30 kort
      { qty: 5 },                       // 50 kort
      { qty: 10 },                      // 100 kort
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: COUNTRIES_NO_POSTCARD,
    relatedProductSlugs: REL_POSTCARD,
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 350, packSize: 10 },
  },

  // ─── SQUARE KORT 14.1 × 14.1 cm ────────────────────────────────────────
  // Gelato priser enkel og dobbel-sidet square likt — vi tilbyr enkel som
  // valg uten rabatt (kunden velger basert på design-behov, ikke pris).
  {
    slug: "card_sq_14",
    categorySlug: "card_sq",
    displayName: { no: "Square kort", en: "Square cards", sv: "Fyrkantiga kort", es: "Tarjetas cuadradas" },
    widthMm: 141, heightMm: 141,
    defaultGelatoUid: "cards_pf_sq_pt_350-gsm-uncoated_cl_4-4_hor",
    allowCustomQty: true,
    productInfo: {
      paper: { no: "350 g/m² ubelagt papir", en: "350 gsm uncoated", sv: "350 g/m² obestruket", es: "350 g/m² sin recubrir" },
      sides: { no: "Trykk på begge sider", en: "Double-sided print", sv: "Tryck på båda sidor", es: "Impresión doble cara" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    variants: [
      { qty: 10, recommended: true },
      { qty: 25 },
      { qty: 50 },
      { qty: 100 },
    ],
    addons: [
      {
        slug: "single_sided",
        label: {
          no: "Kun trykk på forsiden",
          en: "Front side only",
          sv: "Endast tryck på framsidan",
          es: "Solo impresión frontal",
        },
        description: {
          no: "Bakside forblir blank — samme pris",
          en: "Back stays blank — same price",
          sv: "Baksidan förblir blank — samma pris",
          es: "Reverso en blanco — mismo precio",
        },
        surchargeMinor: 0,
        gelatoUidOverride: "cards_pf_sq_pt_350-gsm-uncoated_cl_4-0_hor",
      },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_CARD_SQ,
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 350 },
  },

  // ─── PLAKAT 2:3 — 4 størrelser ─────────────────────────────────────────
  {
    slug: "poster_2x3_30x40",
    categorySlug: "poster_2x3",
    displayName: { no: "Plakat 30×40 cm", en: "Poster 30×40 cm", sv: "Affisch 30×40 cm", es: "Póster 30×40 cm" },
    widthMm: 300, heightMm: 400,
    defaultGelatoUid: "flat_product_pf_300x400-mm_pt_200-gsm-coated-silk_cl_4-0_ct_none_prt_none_sft_none_set_none_hor",
    variants: [
      { qty: 1, recommended: true }, { qty: 2 }, { qty: 3 }, { qty: 5 },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER_2x3,
    productInfo: {
      paper: { no: "200 g/m² coated silk", en: "200 gsm coated silk", sv: "200 g/m² coated silk", es: "200 g/m² coated silk" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      finishing: { no: "Silke-glanset finish", en: "Silk-coated finish", sv: "Silke-finish", es: "Acabado satinado" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 200 },
  },
  {
    slug: "poster_2x3_50x70",
    categorySlug: "poster_2x3",
    displayName: { no: "Plakat 50×70 cm", en: "Poster 50×70 cm", sv: "Affisch 50×70 cm", es: "Póster 50×70 cm" },
    widthMm: 500, heightMm: 700,
    defaultGelatoUid: "flat_product_pf_500x700-mm_pt_200-gsm-coated-silk_cl_4-0_ct_none_prt_none_sft_none_set_none_hor",
    variants: [
      { qty: 1, recommended: true }, { qty: 2 }, { qty: 3 },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER_2x3,
    productInfo: {
      paper: { no: "200 g/m² coated silk", en: "200 gsm coated silk", sv: "200 g/m² coated silk", es: "200 g/m² coated silk" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      finishing: { no: "Silke-glanset finish", en: "Silk-coated finish", sv: "Silke-finish", es: "Acabado satinado" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 200 },
  },
  {
    slug: "poster_2x3_60x90",
    categorySlug: "poster_2x3",
    displayName: { no: "Plakat 60×90 cm", en: "Poster 60×90 cm", sv: "Affisch 60×90 cm", es: "Póster 60×90 cm" },
    widthMm: 600, heightMm: 900,
    defaultGelatoUid: "flat_product_pf_600x900-mm_pt_200-gsm-coated-silk_cl_4-0_ct_none_prt_none_sft_none_set_none_hor",
    variants: [
      { qty: 1, recommended: true }, { qty: 2 },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER_2x3,
    productInfo: {
      paper: { no: "200 g/m² coated silk", en: "200 gsm coated silk", sv: "200 g/m² coated silk", es: "200 g/m² coated silk" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      finishing: { no: "Silke-glanset finish", en: "Silk-coated finish", sv: "Silke-finish", es: "Acabado satinado" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 200 },
  },
  // (Plakat 80×120 droppet — eksisterer ikke i Gelato posters-katalog. Kan
  //  legges til senere hvis vi finner tilsvarende SKU eller bruker custom.)

  // ─── PLAKAT 1:1 — 3 størrelser ─────────────────────────────────────────
  {
    slug: "poster_1x1_30x30",
    categorySlug: "poster_1x1",
    displayName: { no: "Plakat 30×30 cm", en: "Poster 30×30 cm", sv: "Affisch 30×30 cm", es: "Póster 30×30 cm" },
    widthMm: 300, heightMm: 300,
    defaultGelatoUid: "flat_product_pf_300x300-mm_pt_200-gsm-coated-silk_cl_4-0_ct_none_prt_none_sft_none_set_none_hor",
    variants: [
      { qty: 1, recommended: true }, { qty: 2 }, { qty: 3 },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER_1x1,
    productInfo: {
      paper: { no: "200 g/m² coated silk", en: "200 gsm coated silk", sv: "200 g/m² coated silk", es: "200 g/m² coated silk" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      finishing: { no: "Silke-glanset finish", en: "Silk-coated finish", sv: "Silke-finish", es: "Acabado satinado" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 200 },
  },
  {
    slug: "poster_1x1_50x50",
    categorySlug: "poster_1x1",
    displayName: { no: "Plakat 50×50 cm", en: "Poster 50×50 cm", sv: "Affisch 50×50 cm", es: "Póster 50×50 cm" },
    widthMm: 500, heightMm: 500,
    defaultGelatoUid: "flat_product_pf_500x500-mm_pt_200-gsm-coated-silk_cl_4-0_ct_none_prt_none_sft_none_set_none_hor",
    variants: [
      { qty: 1, recommended: true }, { qty: 2 },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER_1x1,
    productInfo: {
      paper: { no: "200 g/m² coated silk", en: "200 gsm coated silk", sv: "200 g/m² coated silk", es: "200 g/m² coated silk" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      finishing: { no: "Silke-glanset finish", en: "Silk-coated finish", sv: "Silke-finish", es: "Acabado satinado" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 200 },
  },
  {
    slug: "poster_1x1_70x70",
    categorySlug: "poster_1x1",
    displayName: { no: "Plakat 70×70 cm", en: "Poster 70×70 cm", sv: "Affisch 70×70 cm", es: "Póster 70×70 cm" },
    widthMm: 700, heightMm: 700,
    defaultGelatoUid: "flat_product_pf_700x700-mm_pt_200-gsm-coated-silk_cl_4-0_ct_none_prt_none_sft_none_set_none_hor",
    variants: [
      { qty: 1, recommended: true },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 55,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER_1x1,
    productInfo: {
      paper: { no: "200 g/m² coated silk", en: "200 gsm coated silk", sv: "200 g/m² coated silk", es: "200 g/m² coated silk" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      finishing: { no: "Silke-glanset finish", en: "Silk-coated finish", sv: "Silke-finish", es: "Acabado satinado" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    metadata: { bleedMm: 3, dpi: 300, paperGrammage: 200 },
  },
];
