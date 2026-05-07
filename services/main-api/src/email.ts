import { createTransport } from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { translateEmail as te } from './i18n';
import type { SupportedLocale } from './i18n';

// SMTP configuration - all values from environment variables (no hard-coded defaults for security)
function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const fromEmail = process.env.SMTP_FROM;
  
  if (!host || !user || !pass || !fromEmail) {
    console.warn('SMTP configuration incomplete. Required: SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM');
  }
  
  const emailAddress = fromEmail || 'noreply@evenero.com';
  const fromWithName = `Evenero <${emailAddress}>`;
  
  return {
    host: host || '',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: user || '',
      pass: pass || ''
    },
    from: fromWithName
  };
}

const smtpConfig = getSmtpConfig();

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.auth.user,
        pass: smtpConfig.auth.pass
      }
    });
  }
  return transporter as Transporter;
}

const BIRD_NAMES = [
  'Eagle', 'Sparrow', 'Robin', 'Cardinal', 'Bluejay', 'Owl', 'Hawk', 'Falcon',
  'Penguin', 'Flamingo', 'Peacock', 'Parrot', 'Crow', 'Raven', 'Dove', 'Pigeon',
  'Swan', 'Goose', 'Duck', 'Heron', 'Crane', 'Stork', 'Pelican', 'Albatross',
  'Seagull', 'Puffin', 'Woodpecker', 'Hummingbird', 'Kingfisher', 'Finch'
];

export function getRandomBirdName(): string {
  return BIRD_NAMES[Math.floor(Math.random() * BIRD_NAMES.length)];
}

// Staging-whitelist: hvis EMAIL_WHITELIST_TO er satt, blir ALL utgående mail
// rerouted til den adressen, og originalmottaker logges i en X-Original-To header.
// Forhindrer at staging spammer ekte kunder under testing.
function applyStagingWhitelist(to: string): { actualTo: string; isRerouted: boolean } {
  const whitelist = process.env.EMAIL_WHITELIST_TO;
  if (whitelist && whitelist.trim() !== "") {
    return { actualTo: whitelist.trim(), isRerouted: true };
  }
  return { actualTo: to, isRerouted: false };
}

export async function sendEmail(
  to: string,
  subject: string,
  text?: string,
  html?: string,
): Promise<boolean> {
  const { actualTo, isRerouted } = applyStagingWhitelist(to);

  if (!smtpConfig.auth.pass) {
    console.warn("[EMAIL] SMTP password not configured — printing to log instead");
    console.log(`[EMAIL] To: ${actualTo}${isRerouted ? ` (rerouted from ${to})` : ""}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    if (text) console.log(`[EMAIL] Text: ${text.substring(0, 200)}…`);
    return true;
  }

  try {
    const mailTransporter = getTransporter();
    const info = await mailTransporter.sendMail({
      from: smtpConfig.from,
      to: actualTo,
      subject: isRerouted ? `[STAGING→${to}] ${subject}` : subject,
      text,
      html,
      headers: isRerouted ? { "X-Original-To": to } : undefined,
    });
    console.log(
      `[EMAIL] Sent ${info.messageId} to ${actualTo}${isRerouted ? ` (rerouted from ${to})` : ""}`,
    );
    return true;
  } catch (error) {
    console.error("[EMAIL] Failed to send via SMTP:", error);
    console.log(`[EMAIL] Failed: to=${actualTo} subject="${subject}"`);
    return false;
  }
}

export async function sendPinCodeEmail(
  email: string,
  pinCode: string,
  locale: SupportedLocale = 'en',
  loginUrl?: string
): Promise<boolean> {
  const subject = te(locale, 'pinCode.subject');
  const title = te(locale, 'pinCode.title');
  const body = te(locale, 'pinCode.body');
  const expiry = te(locale, 'pinCode.expiry');
  const ignore = te(locale, 'pinCode.ignore');
  const footer = te(locale, 'common.footer');
  const loginButton = locale === 'nb' ? 'Logg inn med ett klikk' : locale === 'sv' ? 'Logga in med ett klick' : locale === 'es' ? 'Iniciar sesión con un clic' : 'Sign in with one click';
  const orEnterManually = locale === 'nb' ? 'eller skriv inn koden manuelt' : locale === 'sv' ? 'eller ange koden manuellt' : locale === 'es' ? 'o ingresa el código manualmente' : 'or enter code manually';
  
  const text = `
${body}

${loginUrl ? `${loginButton}: ${loginUrl}\n\n${orEnterManually}:\n` : ''}
${pinCode}

${expiry}

${ignore}

${footer}
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; 
      line-height: 1.6; 
      color: #333; 
      margin: 0;
      padding: 0;
      background-color: #f4f4f4;
    }
    .wrapper {
      background-color: #f4f4f4;
      padding: 20px 0;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
    .header { 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      color: white; 
      padding: 32px 20px; 
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 700;
    }
    .header p {
      margin: 8px 0 0 0;
      opacity: 0.9;
      font-size: 16px;
    }
    .content { 
      padding: 40px 30px; 
      text-align: center;
    }
    .greeting {
      font-size: 18px;
      color: #555;
      margin-bottom: 20px;
    }
    .pin-code { 
      font-size: 42px; 
      font-weight: 700; 
      color: #667eea; 
      letter-spacing: 8px; 
      text-align: center; 
      padding: 25px 30px; 
      background: linear-gradient(135deg, #f8f9ff 0%, #f0f1ff 100%); 
      border-radius: 12px; 
      margin: 25px 0;
      border: 2px dashed #667eea;
    }
    .expiry {
      font-size: 14px;
      color: #888;
      margin: 20px 0;
      padding: 12px 20px;
      background: #fff9e6;
      border-radius: 8px;
      display: inline-block;
    }
    .login-button {
      display: inline-block;
      margin: 25px 0;
      padding: 16px 40px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white !important;
      text-decoration: none !important;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }
    .divider {
      margin: 30px 0;
      text-align: center;
      position: relative;
    }
    .divider::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      height: 1px;
      background: #e0e0e0;
    }
    .divider span {
      background: white;
      padding: 0 15px;
      position: relative;
      color: #999;
      font-size: 13px;
    }
    .ignore-text {
      font-size: 13px;
      color: #999;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
    .footer { 
      text-align: center; 
      color: #999; 
      font-size: 12px; 
      padding: 20px;
      background: #fafafa;
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>Evenero</h1>
        <p>${title}</p>
      </div>
      <div class="content">
        <p class="greeting">${body}</p>
        
        ${loginUrl ? `
        <a href="${loginUrl}" class="login-button">
          🔐 ${loginButton}
        </a>
        
        <div class="divider">
          <span>${locale === 'nb' ? 'eller skriv inn koden manuelt' : locale === 'sv' ? 'eller ange koden manuellt' : locale === 'es' ? 'o ingresa el código manualmente' : 'or enter code manually'}</span>
        </div>
        ` : ''}
        
        <div class="pin-code">${pinCode}</div>
        
        <p class="expiry">⏱️ ${expiry}</p>
        
        <p class="ignore-text">${ignore}</p>
      </div>
      <div class="footer">
        <p style="margin: 0; white-space: pre-line;">${footer}</p>
        <p style="margin: 10px 0 0 0;">© ${new Date().getFullYear()} Evenero</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();

  return await sendEmail(email, subject, text, html);
}

export async function sendCoHostInvitationEmail(
  email: string,
  eventName: string,
  inviterName: string,
  eventUrl: string,
  locale: SupportedLocale = 'en'
): Promise<boolean> {
  const subject = te(locale, 'coHostInvite.subject', { eventName });
  const title = te(locale, 'coHostInvite.title');
  const body = te(locale, 'coHostInvite.body', { inviterName, eventName });
  const whatIsEvenero = te(locale, 'coHostInvite.whatIsEvenero');
  const description = te(locale, 'coHostInvite.description');
  const permissions = te(locale, 'coHostInvite.permissions');
  const permissionsList = te(locale, 'coHostInvite.permissionsList');
  const acceptButton = te(locale, 'coHostInvite.acceptButton');
  const dashboardNote = te(locale, 'coHostInvite.dashboardNote');
  const ignore = te(locale, 'coHostInvite.ignore');
  const footer = te(locale, 'common.footer');
  
  const text = `
${title}

${body}

${whatIsEvenero}

${description}

${permissions}
${permissionsList}

${eventUrl}

${dashboardNote}

${ignore}

${footer}
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; 
      line-height: 1.6; 
      color: #333; 
      margin: 0;
      padding: 0;
      background-color: #f0f2f5;
    }
    .wrapper {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f0f2f5 50%);
      padding: 40px 20px;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      background: white;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 40px rgba(102, 126, 234, 0.25);
    }
    .header { 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      color: white; 
      padding: 40px 30px; 
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 32px;
      font-weight: 800;
      letter-spacing: -0.5px;
    }
    .header .tagline {
      margin: 8px 0 0 0;
      opacity: 0.9;
      font-size: 14px;
    }
    .content { 
      padding: 40px 30px; 
    }
    .title-badge {
      text-align: center;
      margin-bottom: 25px;
    }
    .title-badge span {
      display: inline-block;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      padding: 12px 28px;
      border-radius: 30px;
      font-size: 18px;
      font-weight: 700;
      box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);
    }
    .body-text {
      font-size: 17px;
      color: #444;
      text-align: center;
      margin: 20px 0;
      line-height: 1.7;
    }
    .event-name {
      text-align: center;
      font-size: 26px;
      font-weight: 800;
      color: #667eea;
      margin: 25px 0;
      padding: 25px;
      background: linear-gradient(135deg, #f8f9ff 0%, #eef1ff 100%);
      border-radius: 16px;
      border: 2px solid #e0e5ff;
    }
    .what-is-evenero {
      font-size: 14px;
      color: #666;
      background: linear-gradient(135deg, #fafbfc 0%, #f5f7f9 100%);
      padding: 20px;
      border-radius: 12px;
      margin: 25px 0;
      text-align: center;
      border: 1px solid #e8ebf0;
    }
    .what-is-evenero strong {
      color: #667eea;
      font-weight: 600;
    }
    .permissions-box {
      background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%);
      border: 1px solid #bbf7d0;
      border-radius: 12px;
      padding: 20px;
      margin: 25px 0;
    }
    .permissions-box h3 {
      margin: 0 0 12px 0;
      font-size: 15px;
      color: #166534;
      font-weight: 600;
    }
    .permissions-box ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .permissions-box li {
      padding: 6px 0;
      color: #166534;
      font-size: 14px;
    }
    .permissions-box li::before {
      content: "✓ ";
      color: #22c55e;
      font-weight: bold;
    }
    .description {
      font-size: 15px;
      color: #555;
      text-align: center;
      margin: 20px 0;
      line-height: 1.6;
    }
    .button-container {
      text-align: center;
      margin: 35px 0 25px 0;
    }
    .button { 
      display: inline-block; 
      padding: 18px 50px; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white !important; 
      text-decoration: none !important; 
      border-radius: 12px; 
      font-weight: 700;
      font-size: 16px;
      box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
      transition: transform 0.2s;
    }
    .dashboard-note {
      font-size: 13px;
      color: #666;
      text-align: center;
      background: #f8f9fa;
      padding: 12px 20px;
      border-radius: 8px;
      margin: 20px 0 0 0;
    }
    .ignore-text {
      font-size: 12px;
      color: #999;
      text-align: center;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
    .footer { 
      text-align: center; 
      color: #888; 
      font-size: 12px; 
      padding: 25px;
      background: linear-gradient(135deg, #fafafa 0%, #f5f5f5 100%);
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>Evenero</h1>
        <p class="tagline">Photo & Video Sharing for Events</p>
      </div>
      <div class="content">
        <div class="title-badge">
          <span>🎉 ${title}</span>
        </div>
        
        <p class="body-text">${body}</p>
        
        <div class="event-name">📸 ${eventName}</div>
        
        <div class="what-is-evenero">
          ${whatIsEvenero}
        </div>
        
        <div class="permissions-box">
          <h3>${permissions}</h3>
          <ul>
            <li>View and download all photos & videos</li>
            <li>Approve or remove uploads</li>
            <li>Access event settings</li>
            <li>See the live slideshow</li>
          </ul>
        </div>
        
        <p class="description">${description}</p>
        
        <div class="button-container">
          <a href="${eventUrl}" class="button">${acceptButton}</a>
        </div>
        
        <p class="dashboard-note">💡 ${dashboardNote}</p>
        
        <p class="ignore-text">${ignore}</p>
      </div>
      <div class="footer">
        <p style="margin: 0; white-space: pre-line;">${footer}</p>
        <p style="margin: 10px 0 0 0;">© ${new Date().getFullYear()} Evenero</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();

  return await sendEmail(email, subject, text, html);
}

export async function sendReminderConfirmationEmail(
  email: string,
  eventName: string,
  galleryUrl: string,
  scheduledDate: Date,
  locale: SupportedLocale = 'en'
): Promise<boolean> {
  const cleanEventName = eventName.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
  const subject = te(locale, 'reminderConfirmation.subject', { eventName: cleanEventName });
  const title = te(locale, 'reminderConfirmation.title');
  const body = te(locale, 'reminderConfirmation.body', { eventName });
  const scheduledFor = te(locale, 'reminderConfirmation.scheduledFor', { 
    date: scheduledDate.toLocaleDateString(locale === 'nb' ? 'nb-NO' : locale === 'sv' ? 'sv-SE' : locale === 'es' ? 'es-ES' : 'en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) 
  });
  const galleryLink = te(locale, 'reminderConfirmation.galleryLink');
  const viewGalleryButton = te(locale, 'reminderConfirmation.viewGalleryButton');
  const changeReminder = te(locale, 'reminderConfirmation.changeReminder');
  const footer = te(locale, 'common.footer');
  
  const text = `
${title}

${body}

${scheduledFor}

${galleryLink}
${galleryUrl}

${changeReminder}

${footer}
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; 
      line-height: 1.6; 
      color: #333; 
      margin: 0;
      padding: 0;
      background-color: #f4f4f4;
    }
    .wrapper {
      background-color: #f4f4f4;
      padding: 20px 0;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
    .header { 
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); 
      color: white; 
      padding: 32px 20px; 
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 700;
    }
    .header p {
      margin: 8px 0 0 0;
      opacity: 0.9;
      font-size: 16px;
    }
    .content { 
      padding: 40px 30px; 
      text-align: center;
    }
    .success-badge {
      text-align: center;
      margin-bottom: 25px;
    }
    .success-badge span {
      display: inline-block;
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: white;
      padding: 10px 24px;
      border-radius: 25px;
      font-size: 16px;
      font-weight: 600;
    }
    .body-text {
      font-size: 16px;
      color: #555;
      text-align: center;
      margin-bottom: 20px;
    }
    .scheduled-box {
      background: linear-gradient(135deg, #fff9e6 0%, #fff5d6 100%);
      border: 2px solid #f59e0b;
      border-radius: 12px;
      padding: 20px;
      margin: 25px 0;
    }
    .scheduled-text {
      color: #92400e;
      font-weight: 600;
      font-size: 15px;
    }
    .gallery-section {
      margin: 25px 0;
      padding: 20px;
      background: #f8f9fa;
      border-radius: 10px;
    }
    .gallery-link-text {
      font-size: 14px;
      color: #666;
      margin-bottom: 15px;
    }
    .button { 
      display: inline-block; 
      padding: 14px 35px; 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white !important; 
      text-decoration: none !important; 
      border-radius: 8px; 
      font-weight: 600;
      font-size: 15px;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }
    .change-reminder {
      font-size: 13px;
      color: #888;
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #eee;
    }
    .footer { 
      text-align: center; 
      color: #999; 
      font-size: 12px; 
      padding: 20px;
      background: #fafafa;
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>Evenero</h1>
        <p>🔔 ${title}</p>
      </div>
      <div class="content">
        <div class="success-badge">
          <span>✅ ${title}</span>
        </div>
        
        <p class="body-text">${body}</p>
        
        <div class="scheduled-box">
          <p class="scheduled-text">📅 ${scheduledFor}</p>
        </div>
        
        <div class="gallery-section">
          <p class="gallery-link-text">${galleryLink}</p>
          <a href="${galleryUrl}" class="button">${viewGalleryButton}</a>
        </div>
        
        <p class="change-reminder">${changeReminder}</p>
      </div>
      <div class="footer">
        <p style="margin: 0; white-space: pre-line;">${footer}</p>
        <p style="margin: 10px 0 0 0;">© ${new Date().getFullYear()} Evenero</p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();

  return await sendEmail(email, subject, text, html);
}

export async function sendEventReminderEmail(
  email: string,
  eventName: string,
  galleryUrl: string,
  locale: SupportedLocale = 'en'
): Promise<boolean> {
  const cleanEventName = eventName.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
  const subject = te(locale, 'eventReminder.subject', { eventName: cleanEventName });
  const title = te(locale, 'eventReminder.title');
  const body = te(locale, 'eventReminder.body', { eventName });
  const uploadPrompt = te(locale, 'eventReminder.uploadPrompt');
  const viewOthers = te(locale, 'eventReminder.viewOthers');
  const viewGallery = te(locale, 'eventReminder.viewGallery');
  const galleryLink = te(locale, 'eventReminder.galleryLink');
  const downloadHint = te(locale, 'eventReminder.downloadHint');
  const footer = te(locale, 'common.footer');
  
  const text = `
${title}

${body}

${uploadPrompt}

${viewOthers}

${galleryLink} ${galleryUrl}

${downloadHint}

${footer}
  `.trim()

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 20px; background-color: #ffffff;">
  <div style="max-width: 600px; margin: 0 auto;">
    <div style="text-align: center; margin-bottom: 30px;">
      <h1 style="font-size: 24px; font-weight: 700; margin: 0 0 5px 0; color: #333;">Evenero</h1>
      <p style="font-size: 14px; color: #666; margin: 0;">${title}</p>
    </div>
    
    <div style="margin-bottom: 25px;">
      <h2 style="font-size: 20px; font-weight: 600; color: #333; margin: 0 0 10px 0; text-align: center;">${eventName}</h2>
    </div>
    
    <p style="font-size: 16px; color: #333; margin: 0 0 20px 0;">${body}</p>
    
    <p style="font-size: 15px; color: #555; margin: 0 0 15px 0;">${uploadPrompt}</p>
    
    <p style="font-size: 15px; color: #555; margin: 0 0 25px 0;">${viewOthers}</p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${galleryUrl}" style="display: inline-block; padding: 14px 40px; background-color: #5046e5; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">${viewGallery}</a>
    </div>
    
    <p style="font-size: 14px; color: #666; text-align: center; margin: 25px 0 10px 0;">${galleryLink}</p>
    <p style="font-size: 14px; text-align: center; margin: 0 0 25px 0;">
      <a href="${galleryUrl}" style="color: #5046e5; text-decoration: none; word-break: break-all;">${galleryUrl}</a>
    </p>
    
    <p style="font-size: 14px; color: #666; margin: 20px 0;">${downloadHint}</p>
    
    <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
    
    <p style="font-size: 12px; color: #999; text-align: center; margin: 0; white-space: pre-line;">${footer}</p>
    <p style="font-size: 12px; color: #999; text-align: center; margin: 10px 0 0 0;">
      <a href="https://www.evenero.com" style="color: #5046e5; text-decoration: none;">www.evenero.com</a>
    </p>
  </div>
</body>
</html>
  `.trim();

  return await sendEmail(email, subject, text, html);
}

export async function sendZipDownloadEmail(
  email: string,
  eventName: string,
  zipUrl: string,
  fileCount: number,
  zipSizeMB: number,
  locale: SupportedLocale = 'en'
): Promise<boolean> {
  const cleanEventName = eventName.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').trim();
  const subject = te(locale, 'zipReady.subject', { eventName: cleanEventName });
  const title = te(locale, 'zipReady.title');
  const body = te(locale, 'zipReady.body', { eventName });
  const downloadButton = te(locale, 'zipReady.downloadButton');
  const expiry = te(locale, 'zipReady.expiry');
  const size = te(locale, 'zipReady.size', { size: `${zipSizeMB} MB` });
  const footer = te(locale, 'common.footer');
  
  const fileCountText = locale === 'nb' ? `${fileCount} bilder/videoer` : locale === 'sv' ? `${fileCount} bilder/videor` : locale === 'es' ? `${fileCount} fotos/videos` : `${fileCount} photos/videos`;
  
  const text = `
${title}

${body}

${fileCountText}
${size}

${zipUrl}

${expiry}

${footer}
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; 
      line-height: 1.6; 
      color: #333; 
      margin: 0;
      padding: 0;
      background-color: #f4f4f4;
    }
    .wrapper {
      background-color: #f4f4f4;
      padding: 20px 0;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
    }
    .header { 
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
      color: white; 
      padding: 32px 20px; 
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 28px;
      font-weight: 700;
    }
    .header p {
      margin: 8px 0 0 0;
      opacity: 0.9;
      font-size: 16px;
    }
    .content { 
      padding: 40px 30px; 
    }
    .success-badge {
      text-align: center;
      margin-bottom: 25px;
    }
    .success-badge span {
      display: inline-block;
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
      padding: 10px 24px;
      border-radius: 25px;
      font-size: 16px;
      font-weight: 600;
    }
    .body-text {
      font-size: 16px;
      color: #555;
      text-align: center;
      margin-bottom: 20px;
    }
    .event-name {
      color: #667eea;
      font-weight: 700;
    }
    .stats { 
      background: linear-gradient(135deg, #f8f9ff 0%, #f0f1ff 100%);
      padding: 24px; 
      border-radius: 12px; 
      margin: 25px 0;
      border: 1px solid #e0e4ff;
    }
    .stats-title {
      font-size: 14px;
      font-weight: 600;
      color: #667eea;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 15px;
    }
    .stats-grid {
      display: flex;
      justify-content: space-around;
      text-align: center;
    }
    .stat-item {
      padding: 0 15px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #333;
    }
    .stat-label {
      font-size: 12px;
      color: #888;
      margin-top: 4px;
    }
    .button-container {
      text-align: center;
      margin: 30px 0;
      padding: 25px;
      background: linear-gradient(180deg, #fff 0%, #f8f9fa 100%);
      border-radius: 12px;
    }
    .big-button { 
      display: inline-block; 
      padding: 18px 50px; 
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white !important; 
      text-decoration: none !important; 
      border-radius: 10px; 
      font-weight: 700; 
      font-size: 18px;
      box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4);
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .warning {
      background: linear-gradient(135deg, #fff9e6 0%, #fff5d6 100%);
      border: 2px solid #ffc107;
      border-radius: 10px;
      padding: 18px;
      margin: 25px 0;
      text-align: center;
    }
    .warning-text {
      color: #856404;
      font-weight: 600;
      font-size: 14px;
    }
    .link-fallback {
      margin-top: 25px;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 8px;
      word-break: break-all;
      font-family: monospace;
      font-size: 11px;
      color: #666;
      text-align: center;
    }
    .link-fallback-label {
      font-size: 12px;
      color: #888;
      margin-bottom: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    }
    .footer { 
      text-align: center; 
      color: #999; 
      font-size: 12px; 
      padding: 20px;
      background: #fafafa;
      border-top: 1px solid #eee;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <h1>Evenero</h1>
        <p>📸 ${title}</p>
      </div>
      <div class="content">
        <div class="success-badge">
          <span>✅ ${title}</span>
        </div>
        
        <p class="body-text">${body}</p>
        
        <div class="stats">
          <div class="stats-title">📦 Your download contains</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="center" style="padding: 10px;">
                <div class="stat-value">${fileCount}</div>
                <div class="stat-label">${locale === 'nb' ? 'bilder/videoer' : locale === 'sv' ? 'bilder/videor' : locale === 'es' ? 'fotos/videos' : 'photos/videos'}</div>
              </td>
              <td align="center" style="padding: 10px;">
                <div class="stat-value">${zipSizeMB} MB</div>
                <div class="stat-label">${locale === 'nb' ? 'total størrelse' : locale === 'sv' ? 'total storlek' : locale === 'es' ? 'tamaño total' : 'total size'}</div>
              </td>
            </tr>
          </table>
        </div>

        <div class="button-container">
          <a href="${zipUrl}" class="big-button">
            ⬇️ ${downloadButton}
          </a>
        </div>
        
        <div class="warning">
          <p class="warning-text">⏰ ${expiry}</p>
        </div>
        
        <div class="link-fallback">
          <div class="link-fallback-label">${locale === 'nb' ? 'Direkte lenke:' : locale === 'sv' ? 'Direktlänk:' : locale === 'es' ? 'Enlace directo:' : 'Direct link:'}</div>
          ${zipUrl}
        </div>
      </div>
      <div class="footer">
        <p style="margin: 0; white-space: pre-line;">${footer}</p>
        <p style="margin: 10px 0 0 0;">© ${new Date().getFullYear()} Evenero</p>
        <p style="margin: 5px 0 0 0;">
          <a href="https://www.evenero.com" style="color: #667eea; text-decoration: none;">www.evenero.com</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();

  return await sendEmail(email, subject, text, html);
}
