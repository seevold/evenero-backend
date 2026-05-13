import type { Express } from "express";
import { createServer, type Server } from "http";
import Stripe from "stripe";
import { storage } from "./storage";
import { type InsertPayment, insertSupportRequestSchema } from "@shared/schema";
import { emailService } from "./email-service";
import { trackInitiateCheckout, trackPurchase } from "./meta-conversions";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('Missing required Stripe secret: STRIPE_SECRET_KEY');
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const STRIPE_PRODUCT_ID = process.env.STRIPE_PRODUCT_ID || 'prod_SOyk4pHGl1dzjN';
if (!process.env.STRIPE_PRODUCT_ID) {
  console.warn('[stripe] STRIPE_PRODUCT_ID env-var ikke satt, faller tilbake til live product-ID — feiler i test mode');
}
const PRICE_CACHE_TTL = 5 * 60 * 1000;

interface PriceCacheEntry {
  priceId: string;
  defaultCurrency: string;
  defaultAmount: number;
  currencyOptions: Record<string, number>;
  fetchedAt: number;
}

let priceCache: PriceCacheEntry | null = null;

const COUNTRY_CURRENCY_MAP: Record<string, string> = {
  'NO': 'nok', 'SE': 'sek', 'DK': 'dkk',
  'US': 'usd', 'CA': 'cad', 'AU': 'aud', 'NZ': 'nzd',
  'GB': 'gbp',
  'CH': 'chf', 'LI': 'chf',
  'PL': 'pln', 'CZ': 'czk', 'HU': 'huf', 'RO': 'ron', 'BG': 'bgn',
  'JP': 'jpy', 'CN': 'cny', 'KR': 'krw', 'IN': 'inr',
  'BR': 'brl', 'MX': 'mxn',
  'ZA': 'zar', 'NG': 'ngn',
  'SG': 'sgd', 'HK': 'hkd', 'TW': 'twd', 'TH': 'thb',
  'AE': 'aed', 'SA': 'sar', 'IL': 'ils', 'TR': 'try',
};

const EUR_COUNTRIES = [
  'DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'AT', 'IE', 'FI', 'PT',
  'GR', 'LU', 'SK', 'SI', 'EE', 'LV', 'LT', 'MT', 'CY', 'HR',
];
for (const c of EUR_COUNTRIES) {
  COUNTRY_CURRENCY_MAP[c] = 'eur';
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  'nok': 'kr', 'sek': 'kr', 'dkk': 'kr',
  'usd': '$', 'cad': 'CA$', 'aud': 'A$', 'nzd': 'NZ$',
  'gbp': '£', 'eur': '€', 'chf': 'CHF',
  'pln': 'zł', 'czk': 'Kč', 'huf': 'Ft', 'ron': 'lei', 'bgn': 'лв',
  'jpy': '¥', 'cny': '¥', 'krw': '₩', 'inr': '₹',
  'brl': 'R$', 'mxn': 'MX$',
  'zar': 'R', 'ngn': '₦',
  'sgd': 'S$', 'hkd': 'HK$', 'twd': 'NT$', 'thb': '฿',
  'aed': 'د.إ', 'sar': '﷼', 'ils': '₪', 'try': '₺',
};

async function getStripePriceData(): Promise<PriceCacheEntry> {
  if (priceCache && Date.now() - priceCache.fetchedAt < PRICE_CACHE_TTL) {
    return priceCache;
  }

  console.log('🔄 Fetching price data from Stripe...');
  const product = await stripe.products.retrieve(STRIPE_PRODUCT_ID, {
    expand: ['default_price', 'default_price.currency_options'],
  });

  const defaultPrice = product.default_price as Stripe.Price;
  if (!defaultPrice) {
    throw new Error('Product has no default price set');
  }

  const currencyOptions: Record<string, number> = {};
  currencyOptions[defaultPrice.currency] = defaultPrice.unit_amount || 0;

  if (defaultPrice.currency_options) {
    for (const [currency, option] of Object.entries(defaultPrice.currency_options)) {
      if (option.unit_amount != null) {
        currencyOptions[currency] = option.unit_amount;
      }
    }
  }

  priceCache = {
    priceId: defaultPrice.id,
    defaultCurrency: defaultPrice.currency,
    defaultAmount: defaultPrice.unit_amount || 0,
    currencyOptions,
    fetchedAt: Date.now(),
  };

  console.log(`✅ Stripe price cached: ${defaultPrice.id} (${defaultPrice.currency} ${defaultPrice.unit_amount}), ${Object.keys(currencyOptions).length} currencies available`);
  return priceCache;
}

function getCurrencyForCountry(country: string, availableCurrencies: Record<string, number>): string {
  const mapped = COUNTRY_CURRENCY_MAP[country];
  if (mapped && availableCurrencies[mapped] != null) {
    return mapped;
  }
  if (availableCurrencies['eur'] != null) {
    return 'eur';
  }
  return Object.keys(availableCurrencies)[0] || 'eur';
}

function getSymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] || currency.toUpperCase();
}

// ============================================================================
// Stripe webhook handlers — én funksjon per event-type for lesbarhet
// ============================================================================

interface ProductMeta {
  productType: string;       // 'event_credit' i dag, utvidbart
  creditsGranted: number;    // hvor mange credits dette kjøpet gir
}

/**
 * Les Stripe product-metadata for å avgjøre hva som skal gis.
 * Ny produkter introduseres ved å sette metadata på Stripe Product:
 *   internal_type=event_credit     (eller premium_feature, storage_addon, ...)
 *   credits_granted=1              (eller 5, 10, ...)
 * Fallback hvis metadata mangler: dagens produkt = 1 event credit.
 */
async function readProductMetaFromSession(session: any): Promise<ProductMeta> {
  try {
    // Hent line items med expand for å få product-info
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
      expand: ['data.price.product'],
      limit: 1, // single-product i dag; utvides senere
    });
    const product = lineItems.data[0]?.price?.product as any;
    if (product?.metadata) {
      const productType = product.metadata.internal_type || 'event_credit';
      const creditsGranted = parseInt(product.metadata.credits_granted ?? '1', 10);
      if (!Number.isFinite(creditsGranted) || creditsGranted < 0) {
        console.warn(`[webhook] product ${product.id} har ugyldig credits_granted='${product.metadata.credits_granted}', fallback til 1`);
        return { productType, creditsGranted: 1 };
      }
      return { productType, creditsGranted };
    }
    console.warn(`[webhook] mangler product-metadata for session ${session.id}, faller tilbake til event_credit/1`);
  } catch (err: any) {
    console.warn(`[webhook] kunne ikke lese product-metadata for session ${session.id}: ${err.message} — fallback til event_credit/1`);
  }
  return { productType: 'event_credit', creditsGranted: 1 };
}

async function handleCheckoutSessionCompleted(session: any): Promise<void> {
  console.log(`[webhook] checkout.session.completed: ${session.id} email=${session.customer_details?.email}`);

  if (!session.payment_intent || typeof session.payment_intent !== 'string') {
    console.log(`[webhook] no payment_intent in session ${session.id}, skipping`);
    return;
  }

  // Idempotency-vakt
  const existing = await storage.getPaymentByIntentId(session.payment_intent);
  if (existing) {
    console.log(`[webhook] payment ${session.payment_intent} allerede prosessert (id=${existing.id})`);
    return;
  }

  const paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);

  let receiptUrl: string | null = null;
  let stripeChargeId: string | null = null;
  if (paymentIntent.latest_charge && typeof paymentIntent.latest_charge === 'string') {
    const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
    receiptUrl = charge.receipt_url;
    stripeChargeId = charge.id;
  }

  const email = session.customer_details?.email || 'unknown@email.com';
  const meta = await readProductMetaFromSession(session);

  // 1. Krediter user (atomic upsert)
  let userId: string | null = null;
  if (email !== 'unknown@email.com' && meta.creditsGranted > 0) {
    try {
      const user = await storage.upsertUserAndCreditByEmail(email, meta.creditsGranted);
      userId = user.id;
      console.log(`[webhook] credited ${email} +${meta.creditsGranted} (user.id=${user.id}, new event_credit=${user.event_credit})`);
    } catch (err: any) {
      console.error(`[webhook] failed to credit ${email}:`, err);
      // Fortsetter — lagrer payment likevel for audit. User kan krediteres manuelt.
    }
  }

  // 2. Lagre payment-rad med full sporing
  const paymentData: InsertPayment = {
    paymentIntentId: paymentIntent.id,
    stripeChargeId,
    customerEmail: email,
    amount: paymentIntent.amount,
    currency: paymentIntent.currency,
    status: paymentIntent.status,
    receiptUrl,
    referralId: session.metadata?.promotekit_referral || null,
    couponCode: session.metadata?.coupon_code || null,
    buyerCountry: session.metadata?.buyer_country || null,
    vatAmount: session.metadata?.vat_amount ? parseInt(session.metadata.vat_amount) : 0,
    baseAmount: session.metadata?.base_amount ? parseInt(session.metadata.base_amount) : paymentIntent.amount,
    vatRate: session.metadata?.vat_rate || null,
    metadata: session.metadata || null,
    productType: meta.productType,
    creditsGranted: meta.creditsGranted,
    userId: userId as any,
  };
  await storage.createPayment(paymentData);
  console.log(`[webhook] payment saved: ${paymentIntent.id} type=${meta.productType} credits=${meta.creditsGranted}`);

  // 3. Meta Purchase tracking (uendret)
  const metaEventId = session.metadata?.meta_event_id;
  if (metaEventId) {
    const userData = {
      email,
      clientIpAddress: session.metadata?.client_ip,
      clientUserAgent: session.metadata?.user_agent,
      fbp: session.metadata?.fbp,
      fbc: session.metadata?.fbc
    };
    const eventSourceUrl = session.success_url?.split('?')[0] || 'https://evenero.com/payment-success';
    trackPurchase(userData, eventSourceUrl, paymentIntent.currency, paymentIntent.amount / 100, metaEventId)
      .catch(error => console.error('[webhook] Meta Purchase tracking failed:', error));
  }
}

async function handleCheckoutSessionExpired(session: any): Promise<void> {
  console.log(`[webhook] checkout.session.expired: ${session.id} email=${session.customer_details?.email ?? 'n/a'}`);
  // Ingen DB-handling — Stripe sender denne ved 24t abandoned cart
  // Senere: kan trigge "din checkout ventet på deg"-mail eller analytics
}

async function handlePaymentIntentFailed(paymentIntent: any): Promise<void> {
  console.log(`[webhook] payment_intent.payment_failed: ${paymentIntent.id} code=${paymentIntent.last_payment_error?.code} reason=${paymentIntent.last_payment_error?.message?.slice(0, 100)}`);
  // Ingen DB-handling — Stripe Dashboard er source of truth for feilede betalinger
  // Senere: kan logge til analytics for funnel-konvertering
}

async function handleChargeRefunded(charge: any): Promise<void> {
  console.log(`[webhook] charge.refunded: ${charge.id} amount_refunded=${charge.amount_refunded}/${charge.amount}`);
  // Avventer auto-handling per beslutning. Logger kun. Manuell refund-flyt:
  //   1. Slasse setter users.event_credit -= 1 manuelt
  //   2. Hvis event er opprettet med credit: deaktiverer via admin-UI
  // Senere fix: auto-decrement + deaktiver event via consumed_event_id
  const payment = await storage.getPaymentByChargeId(charge.id);
  if (payment) {
    await storage.markPaymentRefunded(charge.id, charge.amount_refunded);
    console.log(`[webhook] marked payment ${payment.id} as refunded (amount=${charge.amount_refunded}) — manuell credit-justering kreves`);
  } else {
    console.log(`[webhook] no matching payment for charge ${charge.id} — refund av pre-cutover-betaling`);
  }
}

async function handleDisputeCreated(dispute: any): Promise<void> {
  console.log(`[webhook] charge.dispute.created: ${dispute.id} charge=${dispute.charge} amount=${dispute.amount} reason=${dispute.reason} status=${dispute.status}`);
  // Sett disputed_at — manuell håndtering kreves (du har 7 dager på å svare)
  if (typeof dispute.charge === 'string') {
    await storage.markPaymentDisputed(dispute.charge, new Date());
  }
  // TODO: send alert-mail til lasse@styretavla.no
}

async function handleDisputeClosed(dispute: any): Promise<void> {
  console.log(`[webhook] charge.dispute.closed: ${dispute.id} status=${dispute.status}`);
  // Hvis vunnet (status=won): fjern disputed_at
  // Hvis tapt (status=lost): behandle som refund — manuelt foreløpig
  if (dispute.status === 'won' && typeof dispute.charge === 'string') {
    await storage.markPaymentDisputed(dispute.charge, null);
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Stripe webhook endpoint - must be before other middleware that parses body
  app.post('/api/webhooks/stripe', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    
    if (!sig) {
      console.log('Missing Stripe signature');
      return res.status(400).send('Missing Stripe signature');
    }

    let event;
    try {
      // For webhooks, we need the raw body
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        console.log('Missing STRIPE_WEBHOOK_SECRET');
        return res.status(400).send('Webhook secret not configured');
      }
      event = stripe.webhooks.constructEvent(req.body, sig as string, webhookSecret);
    } catch (err: any) {
      console.log(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event.data.object as any);
          break;
        case 'checkout.session.expired':
          await handleCheckoutSessionExpired(event.data.object as any);
          break;
        case 'payment_intent.payment_failed':
          await handlePaymentIntentFailed(event.data.object as any);
          break;
        case 'charge.refunded':
          await handleChargeRefunded(event.data.object as any);
          break;
        case 'charge.dispute.created':
          await handleDisputeCreated(event.data.object as any);
          break;
        case 'charge.dispute.closed':
          await handleDisputeClosed(event.data.object as any);
          break;
        default:
          console.log(`[webhook] unhandled event type: ${event.type}`);
      }
    } catch (error: any) {
      console.error(`[webhook] error processing ${event.type}:`, error);
      // Returner 200 likevel — Stripe vil ellers retry, men feilen er logget for manuell follow-up
    }

    res.json({ received: true });
  });
  // Email service test endpoint (for debugging)
  app.get("/api/email-test", async (req, res) => {
    try {
      const hasApiKey = !!process.env.MAILGUN_API_KEY;
      const apiKeyPrefix = process.env.MAILGUN_API_KEY ? process.env.MAILGUN_API_KEY.substring(0, 8) + '...' : 'NOT SET';
      
      res.json({
        status: 'ok',
        emailService: 'initialized',
        domain: 'www.evenero.com',
        hasApiKey,
        apiKeyPrefix,
        nodeEnv: process.env.NODE_ENV,
        mailgunAvailable: hasApiKey
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Email service test failed', details: error.message });
    }
  });

  // Support form submission
  app.post("/api/support", async (req, res) => {
    try {
      const validatedData = insertSupportRequestSchema.parse(req.body);
      
      // Save to database
      const supportRequest = await storage.createSupportRequest(validatedData);
      
      // Send email notification
      const emailSent = await emailService.sendSupportEmail({
        name: validatedData.name,
        email: validatedData.email,
        category: validatedData.category,
        subject: validatedData.subject,
        message: validatedData.message
      });

      if (!emailSent) {
        console.warn(`Email notification failed for support request ${supportRequest.id}`);
        // Continue without failing the request - the data is still saved
      }
      
      res.status(201).json({ 
        success: true, 
        message: "Support request submitted successfully",
        id: supportRequest.id 
      });
    } catch (error: any) {
      console.error("Error creating support request:", error);
      if (error.name === 'ZodError') {
        return res.status(400).json({ error: "Invalid form data", details: error.errors });
      }
      res.status(500).json({ error: "Error submitting support request" });
    }
  });

  app.post("/api/pricing-info", async (req, res) => {
    try {
      const { couponCode, buyerCountry } = req.body;

      const stripeData = await getStripePriceData();

      // Country-prioritet: 1) request body (override fra frontend),
      // 2) Vercel header (forwarded fra Vercel proxy), 3) NO som fallback.
      // Frontend trenger ikke sende buyerCountry — backend detekterer fra Vercel.
      const headerCountry = (req.headers["x-vercel-ip-country"] as string | undefined)?.toUpperCase();
      const country = (buyerCountry || headerCountry || "NO").toUpperCase();
      const currency = getCurrencyForCountry(country, stripeData.currencyOptions);
      const basePrice = stripeData.currencyOptions[currency] ?? stripeData.defaultAmount;
      const symbol = getSymbol(currency);

      let finalPrice = basePrice;
      let discount = null;
      let appliedCoupon = null;

      if (couponCode) {
        try {
          const promotionCodes = await stripe.promotionCodes.list({ 
            code: couponCode,
            limit: 1 
          });
          
          if (promotionCodes.data.length > 0 && promotionCodes.data[0].active) {
            const coupon = promotionCodes.data[0].coupon;
            if (coupon.percent_off) {
              discount = coupon.percent_off;
              finalPrice = Math.round(basePrice * (1 - discount / 100));
              appliedCoupon = coupon;
            } else if (coupon.amount_off) {
              finalPrice = Math.max(0, basePrice - coupon.amount_off);
              appliedCoupon = coupon;
            }
          } else {
            try {
              const coupon = await stripe.coupons.retrieve(couponCode);
              if (coupon && coupon.valid) {
                if (coupon.percent_off) {
                  discount = coupon.percent_off;
                  finalPrice = Math.round(basePrice * (1 - discount / 100));
                  appliedCoupon = coupon;
                } else if (coupon.amount_off) {
                  finalPrice = Math.max(0, basePrice - coupon.amount_off);
                  appliedCoupon = coupon;
                }
              }
            } catch (error: any) {
              console.log(`Coupon lookup failed for ${couponCode}`);
            }
          }
        } catch (error: any) {
          console.log(`Error checking promotion code ${couponCode}:`, error?.message || 'Unknown error');
        }
      }

      res.json({
        success: true,
        originalPrice: appliedCoupon ? Math.round(basePrice / 100) : null,
        finalPrice: Math.round(finalPrice / 100),
        discount: discount,
        couponApplied: !!appliedCoupon,
        couponCode: appliedCoupon ? couponCode : null,
        currency: currency.toUpperCase(),
        currencySymbol: symbol
      });
    } catch (error: any) {
      console.error("Error fetching pricing info:", error);
      res.status(500).json({ 
        success: false,
        error: "Error fetching pricing information",
        finalPrice: 499,
        currency: "NOK",
        currencySymbol: "kr"
      });
    }
  });

  // Create Stripe Checkout Session for embedded form
  app.post("/api/create-checkout-session", async (req, res) => {
    try {
      const { referralId, buyerCountry, customerEmail, couponCode, endorselyReferral, metaEventId, fbp, fbc } = req.body;

      // Prepare metadata for tracking
      const metadata: any = {};
      if (referralId) {
        metadata.promotekit_referral = referralId;
      }
      if (endorselyReferral) {
        metadata.endorsely_referral = endorselyReferral;
      }
      if (buyerCountry) {
        metadata.buyer_country = buyerCountry;
      }
      if (customerEmail) {
        metadata.customer_email = customerEmail;
      }
      if (couponCode) {
        metadata.coupon_code = couponCode;
      }
      if (metaEventId) {
        metadata.meta_event_id = metaEventId;
      }
      
      // Store tracking data in metadata for later use in webhook
      const clientIp = req.ip || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];
      
      if (clientIp) {
        metadata.client_ip = clientIp;
      }
      if (userAgent) {
        metadata.user_agent = userAgent;
      }
      if (fbp) {
        metadata.fbp = fbp;
      }
      if (fbc) {
        metadata.fbc = fbc;
      }
      
      // Track InitiateCheckout with Meta Conversion API
      if (metaEventId) {
        console.log('🎯 Checkout: Starting Meta InitiateCheckout tracking', {
          event_id: metaEventId,
          has_email: !!customerEmail,
          has_ip: !!clientIp,
          has_user_agent: !!userAgent,
          has_fbp: !!fbp,
          has_fbc: !!fbc
        });
        
        const userData = {
          email: customerEmail,
          clientIpAddress: clientIp,
          clientUserAgent: userAgent,
          fbp,
          fbc
        };
        
        const eventSourceUrl = req.headers.origin ? `${req.headers.origin}/checkout` : 'https://evenero.com/checkout';
        
        trackInitiateCheckout(userData, eventSourceUrl, metaEventId).catch(error => {
          console.error('❌ Failed to track InitiateCheckout with Meta Conversion API:', error);
        });
      } else {
        console.log('⚠️ Checkout: No metaEventId provided, skipping Meta tracking');
      }

      const stripeData = await getStripePriceData();
      const country = (buyerCountry || 'NO').toUpperCase();
      const currency = getCurrencyForCountry(country, stripeData.currencyOptions);
      const unitAmount = stripeData.currencyOptions[currency] ?? stripeData.defaultAmount;

      const sessionData: any = {
        line_items: [
          {
            price_data: {
              currency,
              product: STRIPE_PRODUCT_ID,
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        ui_mode: 'embedded',
        return_url: `${req.headers.origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        metadata,
        payment_intent_data: {
          metadata: {
            ...(couponCode && { coupon_code: couponCode }),
            ...(buyerCountry && { buyer_country: buyerCountry }),
          }
        },
        automatic_tax: {
          enabled: true,
        },
        invoice_creation: {
          enabled: true,
        },
        billing_address_collection: 'auto'
      };

      // If coupon code provided via URL parameter, automatically apply it
      if (couponCode) {
        let appliedDiscount = null;
        
        // First try as promotion code
        try {
          console.log(`Attempting promotion code lookup: ${couponCode}`);
          const promotionCodes = await stripe.promotionCodes.list({ 
            code: couponCode,
            limit: 1 
          });
          
          if (promotionCodes.data.length > 0 && promotionCodes.data[0].active) {
            const promoCode = promotionCodes.data[0];
            appliedDiscount = {
              promotion_code: promoCode.id
            };
            console.log(`Found valid promotion code: ${promoCode.code} (${promoCode.id})`);
          }
        } catch (error: any) {
          console.log(`Promotion code lookup failed for ${couponCode}:`, error.message);
        }
        
        // If no promotion code found, try as coupon
        if (!appliedDiscount) {
          const directVariations = [couponCode, couponCode.toUpperCase(), couponCode.toLowerCase()];
          for (const variation of directVariations) {
            try {
              console.log(`Attempting direct coupon lookup: ${variation}`);
              const coupon = await stripe.coupons.retrieve(variation);
              if (coupon && coupon.valid) {
                appliedDiscount = {
                  coupon: coupon.id
                };
                console.log(`Found valid coupon by ID: ${coupon.id}`);
                break;
              }
            } catch (error: any) {
              console.log(`Direct lookup failed for ${variation}`);
            }
          }
          
          // If direct lookup failed, search by name
          if (!appliedDiscount) {
            try {
              console.log(`Searching coupons by name for: ${couponCode}`);
              const coupons = await stripe.coupons.list({ limit: 100 });
              const matchingCoupon = coupons.data.find(coupon => 
                coupon.name && coupon.name.toLowerCase() === couponCode.toLowerCase() && coupon.valid
              );
              
              if (matchingCoupon) {
                appliedDiscount = {
                  coupon: matchingCoupon.id
                };
                console.log(`Found valid coupon by name: ${matchingCoupon.id} (name: ${matchingCoupon.name})`);
              }
            } catch (searchError: any) {
              console.log(`Name search failed:`, searchError.message);
            }
          }
        }

        if (appliedDiscount) {
          sessionData.discounts = [appliedDiscount];
          console.log(`Applied discount to checkout session:`, appliedDiscount);
        } else {
          console.log(`No valid coupon or promotion code found for ${couponCode}, will allow manual entry`);
          sessionData.allow_promotion_codes = true;
        }
      } else {
        // No automatic coupon, allow manual promotion codes
        sessionData.allow_promotion_codes = true;
      }

      const session = await stripe.checkout.sessions.create(sessionData);
      
      res.json({ clientSecret: session.client_secret });
    } catch (error: any) {
      console.error("Error creating checkout session:", error);
      res
        .status(500)
        .json({ error: "Error creating checkout session: " + error.message });
    }
  });

  // Get checkout session status
  app.get("/api/session-status/:sessionId", async (req, res) => {
    try {
      const { sessionId } = req.params;
      
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['payment_intent', 'payment_intent.charges']
      });
      


      if (session.status === 'complete') {
        let dbPayment = null;
        let paymentIntentId = null;
        
        // Handle paid transactions (with payment_intent)
        if (session.payment_intent) {
          paymentIntentId = typeof session.payment_intent === 'string' 
            ? session.payment_intent 
            : session.payment_intent.id;
          dbPayment = await storage.getPaymentByIntentId(paymentIntentId);
          
          if (!dbPayment) {
            const paymentIntent = session.payment_intent as any;
            let receiptUrl = null;
            let stripeChargeId = null;
            
            // Get receipt URL from charges
            if (paymentIntent.charges && paymentIntent.charges.data && paymentIntent.charges.data.length > 0) {
              const charge = paymentIntent.charges.data[0];
              receiptUrl = charge.receipt_url;
              stripeChargeId = charge.id;
            }

            const paymentData: InsertPayment = {
              paymentIntentId: paymentIntent.id,
              stripeChargeId: stripeChargeId,
              customerEmail: session.customer_details?.email || 'unknown@email.com',
              amount: paymentIntent.amount,
              currency: paymentIntent.currency,
              status: paymentIntent.status,
              receiptUrl: receiptUrl,
              referralId: session.metadata?.promotekit_referral || null,
              couponCode: session.metadata?.coupon_code || null,
              buyerCountry: session.metadata?.buyer_country || null,
              vatAmount: session.metadata?.vat_amount ? parseInt(session.metadata.vat_amount) : 0,
              baseAmount: session.metadata?.base_amount ? parseInt(session.metadata.base_amount) : paymentIntent.amount,
              vatRate: session.metadata?.vat_rate || null,
              metadata: session.metadata || null,
            };

            dbPayment = await storage.createPayment(paymentData);
            console.log("Payment saved to database during session status check:", paymentIntent.id);
          }
        }

        const responseData = {
          status: session.status,
          customer_email: session.customer_details?.email,
          payment_intent: paymentIntentId,
          receipt_url: dbPayment?.receiptUrl || null,
          amount: dbPayment?.amount || 0,
          currency: dbPayment?.currency || session.currency || 'nok',
          metadata: session.metadata,
          // Include Adaptive Pricing presentment details if available
          presentment_details: session.presentment_details || null
        };
        

        res.json(responseData);
      } else {
        res.json({
          status: session.status,
          customer_email: session.customer_details?.email
        });
      }
    } catch (error: any) {
      console.error("Error retrieving session status:", error);
      res.status(500).json({ error: "Error retrieving session status" });
    }
  });

  // Get payment status (legacy support)
  app.get("/api/payment-status/:paymentIntentId", async (req, res) => {
    try {
      const { paymentIntentId } = req.params;
      
      // Get from database
      const dbPayment = await storage.getPaymentByIntentId(paymentIntentId);
      
      if (dbPayment) {
        res.json({
          status: dbPayment.status,
          customerEmail: dbPayment.customerEmail,
          amount: dbPayment.amount,
          currency: dbPayment.currency,
          receipt_url: dbPayment.receiptUrl,
          metadata: dbPayment.metadata
        });
      } else {
        res.status(404).json({ error: "Payment not found" });
      }
    } catch (error: any) {
      console.error("Error fetching payment status:", error);
      res.status(500).json({ error: "Error fetching payment status" });
    }
  });

  // Admin: Get all payments
  app.get("/api/admin/payments", async (req, res) => {
    try {
      const payments = await storage.getAllPayments();
      res.json(payments);
    } catch (error: any) {
      console.error("Error fetching payments:", error);
      res.status(500).json({ error: "Error fetching payments" });
    }
  });

  // Debug: List all Stripe coupons and promotion codes
  app.get("/api/debug/coupons", async (req, res) => {
    try {
      const [coupons, promotionCodes] = await Promise.all([
        stripe.coupons.list({ limit: 100 }),
        stripe.promotionCodes.list({ limit: 100 })
      ]);
      
      res.json({
        coupons: coupons.data.map(coupon => ({
          id: coupon.id,
          name: coupon.name,
          percent_off: coupon.percent_off,
          amount_off: coupon.amount_off,
          currency: coupon.currency,
          valid: coupon.valid,
          created: new Date(coupon.created * 1000).toISOString()
        })),
        promotion_codes: promotionCodes.data.map(promo => ({
          id: promo.id,
          code: promo.code,
          coupon_id: promo.coupon.id,
          coupon_name: promo.coupon.name,
          active: promo.active,
          created: new Date(promo.created * 1000).toISOString()
        }))
      });
    } catch (error: any) {
      console.error("Error fetching Stripe coupons:", error);
      res.status(500).json({ error: "Error fetching coupons" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}