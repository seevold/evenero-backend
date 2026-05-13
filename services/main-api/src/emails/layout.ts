// Composable layout for transactional emails.
// Templates declare a list of typed `Block`s; renderEmail() turns them into
// HTML (one consistent design system) and a plain-text fallback.
//
// All design decisions live here. Editing a token in tokens.ts or a renderer
// here updates every email in lockstep — no copy-pasted CSS per template.
//
// Email-client compatibility notes:
//   - Buttons use the "bulletproof" table-wrapped pattern so Outlook on
//     Windows (Word rendering engine) renders padding correctly. Fast farge
//     på <td bgcolor> som fallback, gradient som inline background for
//     klienter som støtter det (Apple Mail, Gmail web, iOS).
//   - Lists use a real <table> per row instead of CSS `position` because
//     Outlook ignores absolute positioning.
//   - A hidden preheader is injected right after <body> so the inbox
//     preview shows useful context next to the subject line.
//   - Inter lastes via Google Fonts <link> + @import; @font-face er ikke
//     pålitelig i Outlook/Gmail dark mode, så system-sans fallback fra
//     TOKENS.sans tar over der.

import { TOKENS } from './tokens.js';

export type Block =
  | { type: 'eyebrow'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'subheading'; text: string }
  | { type: 'paragraph'; text: string; align?: 'left' | 'center' }
  | { type: 'code'; value: string }
  | { type: 'button'; label: string; href: string }
  | { type: 'linkText'; label: string; href: string }
  | { type: 'small'; text: string }
  | { type: 'note'; text: string; tone?: 'neutral' | 'success' | 'warning' }
  | { type: 'stats'; items: Array<{ value: string; label: string }> }
  | { type: 'divider' }
  | { type: 'list'; items: string[] }
  | { type: 'spacer'; size?: 'sm' | 'md' | 'lg' };

export interface RenderedEmail {
  html: string;
  text: string;
}

// Minimal HTML escape for user-supplied strings.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Henter PUBLIC_APP_URL for å bygge stabile asset-URLer i emails (favicon).
// Defaulter til prod-domenet etter cutover, eller .vercel.app før cutover.
function getAssetBaseUrl(): string {
  const env = process.env.PUBLIC_APP_URL;
  if (env) return env.replace(/\/$/, '');
  // Fallback (skal ikke ramme ved riktig deploy-config)
  return 'https://evenero-app.vercel.app';
}

function renderBlockHtml(b: Block): string {
  switch (b.type) {
    case 'eyebrow':
      // Tracking-tight uppercase i purple — premium, men ikke skrikende.
      return `<div style="text-align:center;font-family:${TOKENS.sans};font-size:11px;letter-spacing:0.28em;color:${TOKENS.accent};text-transform:uppercase;font-weight:600;margin:0 0 22px 0;">${esc(b.text)}</div>`;

    case 'heading':
      // Inter bold, tett line-height for "fresh + crisp". Mørk-tekst gir
      // høy lesbarhet over hvit card-bakgrunn.
      return `<h1 style="margin:0 0 18px 0;font-family:${TOKENS.sans};font-weight:700;font-size:28px;line-height:1.25;letter-spacing:-0.01em;color:${TOKENS.textPrimary};text-align:center;">${esc(b.text)}</h1>`;

    case 'subheading':
      return `<h2 style="margin:0 0 14px 0;font-family:${TOKENS.sans};font-weight:600;font-size:20px;line-height:1.3;color:${TOKENS.textPrimary};text-align:center;">${esc(b.text)}</h2>`;

    case 'paragraph': {
      const align = b.align ?? 'center';
      return `<p style="margin:0 0 18px 0;font-family:${TOKENS.sans};font-size:15px;line-height:1.65;color:${TOKENS.textBody};text-align:${align};">${esc(b.text)}</p>`;
    }

    case 'code':
      // PIN-kode: subtil purple-tint bakgrunn, fett tracking for at de 6
      // sifferene er lette å lese og kopiere uten å forveksles.
      return `<div style="margin:24px auto;padding:22px 24px;background:${TOKENS.accentSoft};border:1px solid ${TOKENS.border};text-align:center;font-family:${TOKENS.mono};font-size:30px;font-weight:700;letter-spacing:10px;color:${TOKENS.textPrimary};border-radius:10px;">${esc(b.value)}</div>`;

    case 'button': {
      // Bulletproof button med gradient-fallback:
      // - <td bgcolor> = solid purple-fallback for Outlook (Word-engine)
      // - inline background med gradient = upgrade for moderne klienter
      // - rounded-full (border-radius: 999px) matcher appens knapper
      // - Inter weight 600 + lett tracking for premium feel
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto;border-collapse:separate;">
<tr>
  <td align="center" bgcolor="${TOKENS.buttonBg}" style="background:${TOKENS.buttonBg};background:${TOKENS.buttonBgGradient};border-radius:999px;">
    <a href="${esc(b.href)}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 38px;color:${TOKENS.buttonText};text-decoration:none;font-family:${TOKENS.sans};font-size:15px;font-weight:600;letter-spacing:0.01em;border-radius:999px;mso-padding-alt:0;">${esc(b.label)}</a>
  </td>
</tr>
</table>`;
    }

    case 'linkText':
      return `<p style="margin:0 0 16px 0;font-family:${TOKENS.sans};font-size:13px;color:${TOKENS.textMuted};text-align:center;word-break:break-word;"><a href="${esc(b.href)}" target="_blank" rel="noopener" style="color:${TOKENS.accent};text-decoration:underline;font-weight:500;">${esc(b.label)}</a></p>`;

    case 'small':
      return `<p style="margin:18px 0 0 0;font-family:${TOKENS.sans};font-size:12px;line-height:1.55;color:${TOKENS.textMuted};text-align:center;">${esc(b.text)}</p>`;

    case 'note': {
      const tone = b.tone ?? 'neutral';
      const bg = tone === 'success' ? TOKENS.successBg : tone === 'warning' ? TOKENS.warningBg : TOKENS.accentSoft;
      const color = tone === 'success' ? TOKENS.successText : tone === 'warning' ? TOKENS.warningText : TOKENS.textBody;
      return `<div style="margin:22px 0;padding:14px 18px;background:${bg};border-radius:8px;font-family:${TOKENS.sans};font-size:13px;line-height:1.55;color:${color};text-align:center;">${esc(b.text)}</div>`;
    }

    case 'stats': {
      // Side-by-side stat cells med samme soft-purple bg som code-blokken.
      const cells = b.items.map(item => `
<td align="center" style="padding:14px 16px;font-family:${TOKENS.sans};">
  <div style="font-size:24px;font-weight:700;color:${TOKENS.textPrimary};line-height:1.1;letter-spacing:-0.01em;">${esc(item.value)}</div>
  <div style="font-size:11px;letter-spacing:0.16em;color:${TOKENS.textMuted};text-transform:uppercase;margin-top:6px;font-weight:500;">${esc(item.label)}</div>
</td>`).join('');
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;border-collapse:separate;background:${TOKENS.accentSoft};border:1px solid ${TOKENS.border};border-radius:10px;"><tr>${cells}</tr></table>`;
    }

    case 'divider':
      // Tynn gradient-strek midt på siden — eneste sted gradient brukes
      // utenfor CTA. Holder identiteten gjennomgående uten å overdøve.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:28px auto;"><tr><td style="width:60px;height:2px;background:${TOKENS.accent};background:${TOKENS.accentGradient};font-size:0;line-height:0;border-radius:2px;">&nbsp;</td></tr></table>`;

    case 'list': {
      // Each row is its own <table> so Outlook picks up the bullet column.
      // Purple bullet markør gir liten farge-aksent uten å distrahere.
      const rows = b.items.map(item => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;margin:0;">
  <tr>
    <td valign="top" style="width:18px;padding:6px 8px 6px 0;font-family:${TOKENS.sans};font-size:18px;line-height:1.4;color:${TOKENS.accent};font-weight:700;">·</td>
    <td valign="top" style="padding:6px 0;font-family:${TOKENS.sans};font-size:14px;line-height:1.6;color:${TOKENS.textBody};">${esc(item)}</td>
  </tr>
</table>`).join('');
      return `<div style="margin:16px 0;">${rows}</div>`;
    }

    case 'spacer': {
      const h = b.size === 'sm' ? 8 : b.size === 'lg' ? 32 : 18;
      return `<div style="height:${h}px;line-height:${h}px;font-size:1px;">&nbsp;</div>`;
    }
  }
}

function renderBlockText(b: Block): string {
  switch (b.type) {
    case 'eyebrow': return b.text.toUpperCase() + '\n';
    case 'heading': return b.text + '\n' + '─'.repeat(Math.min(b.text.length, 40)) + '\n';
    case 'subheading': return b.text + '\n';
    case 'paragraph': return b.text + '\n';
    case 'code': return '\n    ' + b.value + '\n';
    case 'button': return `${b.label}: ${b.href}\n`;
    case 'linkText': return `${b.label}: ${b.href}\n`;
    case 'small': return b.text + '\n';
    case 'note': return b.text + '\n';
    case 'stats': return b.items.map(i => `  ${i.value} ${i.label}`).join('\n') + '\n';
    case 'divider': return '\n— — —\n';
    case 'list': return b.items.map(i => `  · ${i}`).join('\n') + '\n';
    case 'spacer': return '\n';
  }
}

export interface LayoutOptions {
  /** Used for <html lang="">. Pass the user's locale code ('nb', 'en', etc.). */
  lang: string;
  /**
   * Short text shown beside the subject line in the inbox preview pane
   * (Gmail, Apple Mail, Outlook). Should add context the subject line
   * doesn't carry — e.g. event name, recipient action. Keep under ~90
   * chars; clients truncate beyond that.
   */
  preheader: string;
  /** Long-form footer line, typically the localized "Best regards, the Evenero team". */
  footer: string;
  blocks: Block[];
}

export function renderEmail(opts: LayoutOptions): RenderedEmail {
  const year = new Date().getFullYear();
  const blocksHtml = opts.blocks.map(renderBlockHtml).join('');
  const blocksText = opts.blocks.map(renderBlockText).join('\n');
  const assetBase = getAssetBaseUrl();
  const faviconUrl = `${assetBase}/favicon.png`;

  // Outer table is the email-client way to constrain max-width and center.
  // Card div sits inside the table cell.
  //
  // Header: favicon-ikon (40px) sentrert, "evenero"-wordmark under i Inter
  // weight 700. Liten gradient-strek under wordmark som visuell signatur.
  // Mso-conditional bgcolor på <td> sikrer Outlook-rendering.
  const html = `<!doctype html>
<html lang="${esc(opts.lang)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Evenero</title>
<!-- Inter for klienter som tillater web fonts. Fallback til system-sans i TOKENS.sans. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
</style>
</head>
<body style="margin:0;padding:0;background:${TOKENS.bgPage};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">

<!-- Preheader: hidden text shown in inbox preview alongside the subject. -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:transparent;opacity:0;">
${esc(opts.preheader)}
${'&zwnj;&nbsp;'.repeat(60)}
</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${TOKENS.bgPage};">
<tr><td align="center" style="padding:36px 16px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
<tr><td>

<!-- Brand-header: favicon + wordmark + tynn gradient-strek -->
<div style="text-align:center;padding:8px 0 32px 0;">
  <img src="${esc(faviconUrl)}" width="44" height="44" alt="Evenero" style="display:inline-block;width:44px;height:44px;border:0;border-radius:10px;">
  <div style="margin-top:10px;font-family:${TOKENS.sans};font-weight:700;font-size:22px;letter-spacing:-0.02em;color:${TOKENS.textPrimary};">evenero</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:12px auto 0 auto;"><tr><td style="width:36px;height:2px;background:${TOKENS.accent};background:${TOKENS.accentGradient};font-size:0;line-height:0;border-radius:2px;">&nbsp;</td></tr></table>
</div>

<!-- Card -->
<div style="background:${TOKENS.bgCard};border:1px solid ${TOKENS.border};padding:44px 36px;border-radius:14px;">
${blocksHtml}
</div>

<!-- Footer -->
<div style="text-align:center;padding:28px 16px 8px 16px;">
  <p style="margin:0 0 6px 0;font-family:${TOKENS.sans};font-size:13px;line-height:1.55;color:${TOKENS.textMuted};white-space:pre-line;">${esc(opts.footer)}</p>
  <p style="margin:10px 0 0 0;font-family:${TOKENS.sans};font-size:12px;color:${TOKENS.textFaint};">© ${year} Evenero · <a href="https://evenero.com" target="_blank" rel="noopener" style="color:${TOKENS.textMuted};text-decoration:underline;">evenero.com</a></p>
</div>

</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = blocksText.trim() + '\n\n' + opts.footer + '\n\n— evenero.com';

  return { html, text };
}
