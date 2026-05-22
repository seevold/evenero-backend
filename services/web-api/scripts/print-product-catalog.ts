// Produkt-katalog for print-on-demand v2.
//
// 4 kategorier: Postkort, Square kort, Visitkort, Større plakat.
// Hver kategori har 1+ produkter (= størrelser). Hvert produkt har qty-tiers
// + valgfrie addons (papir, hjørner) som modifiserer Gelato-UID via string-
// replace — så størrelse × papir × hjørner komponerer fritt.
//
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
  gelatoUid?: string;
  recommended?: boolean;
  upgradeLabel?: string;
};

export type ProductAddonDef = {
  slug: string;
  label: Record<string, string>;
  description: Record<string, string>;
  /** Hvis satt: bytt en del av Gelato-UID-en (komponerbar med andre addons). */
  uidReplace?: { from: string; to: string };
  /** Hvis satt: bytt hele UID-en (kan ikke komponere — bruk conflictsWith). */
  gelatoUidOverride?: string;
  /** 'flat' = fast retail-tillegg (krever flatSurchargeMinor).
   *  'per_unit' = tillegg × qty — seed beregner fra Gelato-prisdiff. */
  surchargeMode: "flat" | "per_unit";
  /** Kun for surchargeMode='flat': fast retail-tillegg i NOK-øre. */
  flatSurchargeMinor?: number;
  conflictsWith?: string[];
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
  /** Multiplier for visning. Postkort packSize=10 → qty=1 = "10 kort". */
  packSize?: number;
  productInfo?: {
    paper?: Record<string, string>;
    sides?: Record<string, string>;
    finishing?: Record<string, string>;
    deliveryDays?: Record<string, string>;
  };
  metadata?: Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────
// Land-whitelist v1 (21 land)
// ─────────────────────────────────────────────────────────────────────────
export const ALL_COUNTRIES_V1 = [
  "NO","SE","DK","FI","IS",
  "DE","FR","NL","BE","AT","IE","ES","IT","PT","PL","CH",
  "GB","US","CA","AU","NZ",
];
// Postkort/kort (pack_of_cards) selges i EU + RoW. US/CA har egen katalog —
// utelat til vi mapper US-spesifikke SKU-er.
export const COUNTRIES_CARDS = ALL_COUNTRIES_V1.filter((c) => c !== "US" && c !== "CA");

// ─────────────────────────────────────────────────────────────────────────
// Kategorier — 4 stk
// ─────────────────────────────────────────────────────────────────────────
export const CATEGORIES: CategoryDef[] = [
  {
    slug: "postcard",
    formatFamily: "2x3",
    presentationMode: "quantity",
    displayName: { no: "Flyer", en: "Flyers", sv: "Flygblad", es: "Folletos" },
    displayOrder: 10,
  },
  {
    slug: "card_sq",
    formatFamily: "1x1",
    presentationMode: "quantity",
    displayName: { no: "Square kort", en: "Square cards", sv: "Fyrkantiga kort", es: "Tarjetas cuadradas" },
    displayOrder: 20,
  },
  {
    slug: "businesscard",
    formatFamily: "businesscard",
    presentationMode: "quantity",
    displayName: { no: "Visitkort", en: "Business cards", sv: "Visitkort", es: "Tarjetas de visita" },
    displayOrder: 30,
  },
  {
    slug: "poster",
    formatFamily: "2x3",
    presentationMode: "size",
    displayName: { no: "Større plakat", en: "Larger poster", sv: "Större affisch", es: "Póster grande" },
    displayOrder: 40,
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Felles addon-definisjoner for pack_of_cards-produkter (postkort + square)
// ─────────────────────────────────────────────────────────────────────────
const CARD_ADDONS: ProductAddonDef[] = [
  {
    slug: "paper_matt",
    label: { no: "Matt papir", en: "Matte paper", sv: "Matt papper", es: "Papel mate" },
    description: {
      no: "Ubelagt 350 g — matt, naturlig følelse (standard er glanset silke)",
      en: "Uncoated 350 gsm — matte, natural feel (default is silk-coated)",
      sv: "Obestruket 350 g — matt, naturlig känsla (standard är silke)",
      es: "Sin recubrir 350 g — mate, natural (por defecto es satinado)",
    },
    uidReplace: { from: "350-gsm-130lb-coated-silk", to: "350-gsm-130lb-uncoated" },
    surchargeMode: "per_unit",
    // Gelato har ikke avrundede hjørner på ubelagt papir — gjensidig utelukkende
    conflictsWith: ["rounded_corners"],
  },
  {
    slug: "rounded_corners",
    label: { no: "Avrundede hjørner", en: "Rounded corners", sv: "Rundade hörn", es: "Esquinas redondeadas" },
    description: {
      no: "8 mm avrunding på alle fire hjørner (kun på silke-papir)",
      en: "8 mm rounding on all four corners (silk paper only)",
      sv: "8 mm rundning på alla fyra hörn (endast silkepapper)",
      es: "Redondeo de 8 mm en las cuatro esquinas (solo papel satinado)",
    },
    uidReplace: { from: "set_none", to: "set_round-8mm" },
    surchargeMode: "per_unit",
    conflictsWith: ["paper_matt"],
  },
];

// Square-kort: kun avrundede hjørner. Gelato støtter ikke matt/ubelagt
// papir for kvadratisk pack_of_cards (ugyldig SKU-kombinasjon).
const SQUARE_ADDONS: ProductAddonDef[] = [
  {
    slug: "rounded_corners",
    label: { no: "Avrundede hjørner", en: "Rounded corners", sv: "Rundade hörn", es: "Esquinas redondeadas" },
    description: {
      no: "8 mm avrunding på alle fire hjørner",
      en: "8 mm rounding on all four corners",
      sv: "8 mm rundning på alla fyra hörn",
      es: "Redondeo de 8 mm en las cuatro esquinas",
    },
    uidReplace: { from: "set_none", to: "set_round-8mm" },
    surchargeMode: "per_unit",
  },
];

const CARD_PRODUCT_INFO = {
  paper: { no: "350 g/m² silke-belagt (standard)", en: "350 gsm silk-coated (default)", sv: "350 g/m² silke (standard)", es: "350 g/m² satinado (predet.)" },
  sides: { no: "Trykk på begge sider", en: "Double-sided print", sv: "Tryck på båda sidor", es: "Impresión doble cara" },
  deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
};

// Cross-sell-mapping
const REL_POSTCARD     = ["businesscard_bc", "poster_a3", "card_sq_14"];
const REL_CARD_SQ      = ["businesscard_bc", "postcard_a6", "poster_a3"];
const REL_BUSINESSCARD = ["postcard_a6", "poster_a3", "card_sq_14"];
const REL_POSTER       = ["postcard_a6", "businesscard_bc", "card_sq_14"];

// ─────────────────────────────────────────────────────────────────────────
// Produkter — 6 stk
// ─────────────────────────────────────────────────────────────────────────
export const PRODUCTS: ProductDef[] = [
  // ─── POSTKORT — A6 + A5 (pack_of_cards, 2:3) ───────────────────────────
  {
    slug: "postcard_a6",
    categorySlug: "postcard",
    displayName: { no: "Flyer A6", en: "A6 flyer", sv: "A6-flygblad", es: "Folleto A6" },
    widthMm: 105, heightMm: 148,
    defaultGelatoUid: "pack_of_cards_qt_10_pcs_pf_a6_upt_350-gsm-130lb-coated-silk_cl_4-4_ct_none_prt_none_sft_none_set_none_ver",
    packSize: 10,
    productInfo: CARD_PRODUCT_INFO,
    variants: [
      { qty: 1, recommended: true },  // 10 kort
      { qty: 3 },                      // 30 kort
      { qty: 5 },                      // 50 kort
      { qty: 10 },                     // 100 kort
      { qty: 20 },                     // 200 kort
    ],
    addons: CARD_ADDONS,
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: COUNTRIES_CARDS,
    relatedProductSlugs: REL_POSTCARD,
    metadata: { bleedMm: 3, dpi: 300 },
  },
  {
    slug: "postcard_a5",
    categorySlug: "postcard",
    displayName: { no: "Flyer A5", en: "A5 flyer", sv: "A5-flygblad", es: "Folleto A5" },
    widthMm: 148, heightMm: 210,
    defaultGelatoUid: "pack_of_cards_qt_10_pcs_pf_a5_upt_350-gsm-130lb-coated-silk_cl_4-4_ct_none_prt_none_sft_none_set_none_ver",
    packSize: 10,
    productInfo: CARD_PRODUCT_INFO,
    variants: [
      { qty: 1, recommended: true },
      { qty: 3 },
      { qty: 5 },
      { qty: 10 },
      { qty: 20 },
    ],
    addons: CARD_ADDONS,
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: COUNTRIES_CARDS,
    relatedProductSlugs: REL_POSTCARD,
    metadata: { bleedMm: 3, dpi: 300 },
  },

  // ─── SQUARE KORT — 14,1×14,1 cm (pack_of_cards, 1:1) ───────────────────
  {
    slug: "card_sq_14",
    categorySlug: "card_sq",
    displayName: { no: "Square kort", en: "Square cards", sv: "Fyrkantiga kort", es: "Tarjetas cuadradas" },
    widthMm: 141, heightMm: 141,
    defaultGelatoUid: "pack_of_cards_qt_10_pcs_pf_sq_upt_350-gsm-130lb-coated-silk_cl_4-4_ct_none_prt_none_sft_none_set_none_ver",
    packSize: 10,
    productInfo: CARD_PRODUCT_INFO,
    variants: [
      { qty: 1, recommended: true },
      { qty: 3 },
      { qty: 5 },
      { qty: 10 },
      { qty: 20 },
    ],
    addons: SQUARE_ADDONS,
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: COUNTRIES_CARDS,
    relatedProductSlugs: REL_CARD_SQ,
    metadata: { bleedMm: 3, dpi: 300 },
  },

  // ─── VISITKORT — BC 9×5,5 cm ───────────────────────────────────────────
  {
    slug: "businesscard_bc",
    categorySlug: "businesscard",
    displayName: { no: "Visitkort", en: "Business cards", sv: "Visitkort", es: "Tarjetas de visita" },
    widthMm: 90, heightMm: 55,
    defaultGelatoUid: "cards_pf_bc_pt_350-gsm-coated-silk_cl_4-4_ct_matt-protection_hor",
    productInfo: {
      paper: { no: "350 g/m² silke-belagt", en: "350 gsm silk-coated", sv: "350 g/m² silke", es: "350 g/m² satinado" },
      sides: { no: "Trykk på begge sider", en: "Double-sided print", sv: "Tryck på båda sidor", es: "Impresión doble cara" },
      finishing: { no: "Matt-beskyttende lakk", en: "Matt protective coating", sv: "Matt skyddslack", es: "Acabado mate protector" },
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
        slug: "premium_paper",
        label: { no: "Premium dobbeltsidig matt", en: "Premium double-sided matte", sv: "Premium dubbelsidig matt", es: "Premium mate doble cara" },
        description: {
          no: "Matt-lamiering på begge sider — tykkere, luksuriøs følelse",
          en: "Matt lamination on both sides — premium thickness and feel",
          sv: "Matt-laminering på båda sidor — premiumkänsla",
          es: "Laminado mate por ambos lados — sensación premium",
        },
        gelatoUidOverride: "cards_pf_bc_pt_350-gsm-coated-silk_cl_4-4_ct_matt-protection_prt_1-1_hor",
        surchargeMode: "flat",
        flatSurchargeMinor: 10000,  // +100 kr — Gelato koster samme, ren margin
      },
    ],
    expressSurchargeMinor: 5000,
    markupTargetPct: 60,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_BUSINESSCARD,
    metadata: { bleedMm: 3, dpi: 300 },
  },

  // ─── STØRRE PLAKAT — A3 + A2 (posters_pf, 2:3-ish portrett) ────────────
  {
    slug: "poster_a3",
    categorySlug: "poster",
    displayName: { no: "Plakat A3", en: "A3 poster", sv: "A3-affisch", es: "Póster A3" },
    widthMm: 297, heightMm: 420,
    defaultGelatoUid: "posters_pf_a3_pt_170-gsm-uncoated_cl_4-0_ver",
    productInfo: {
      paper: { no: "170 g/m² ubelagt", en: "170 gsm uncoated", sv: "170 g/m² obestruket", es: "170 g/m² sin recubrir" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    variants: Array.from({ length: 15 }, (_, i) => ({
      qty: i + 1,
      ...(i === 0 ? { recommended: true } : {}),
    })),
    expressSurchargeMinor: 5000,
    markupTargetPct: 50,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER,
    metadata: { bleedMm: 3, dpi: 300 },
  },
  {
    slug: "poster_a2",
    categorySlug: "poster",
    displayName: { no: "Plakat A2", en: "A2 poster", sv: "A2-affisch", es: "Póster A2" },
    widthMm: 420, heightMm: 594,
    defaultGelatoUid: "flat_product_pf_a2_pt_170-gsm-uncoated_cl_4-0_ct_none_prt_none_sft_none_set_none_ver",
    productInfo: {
      paper: { no: "170 g/m² ubelagt", en: "170 gsm uncoated", sv: "170 g/m² obestruket", es: "170 g/m² sin recubrir" },
      sides: { no: "Trykk på én side", en: "Single-sided print", sv: "Tryck på en sida", es: "Impresión de una cara" },
      deliveryDays: { no: "3-5 hverdager", en: "3-5 business days", sv: "3-5 vardagar", es: "3-5 días hábiles" },
    },
    variants: Array.from({ length: 15 }, (_, i) => ({
      qty: i + 1,
      ...(i === 0 ? { recommended: true } : {}),
    })),
    expressSurchargeMinor: 5000,
    markupTargetPct: 50,
    allowedCountries: ALL_COUNTRIES_V1,
    relatedProductSlugs: REL_POSTER,
    metadata: { bleedMm: 3, dpi: 300 },
  },
];
