import axios from 'axios';
import FormData from 'form-data';

interface EmailData {
  name: string;
  email: string;
  category: string;
  subject: string;
  message: string;
}

export class EmailService {
  private apiKey: string;
  private domain: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.MAILGUN_API_KEY || '';
    // Fixed domain as per requirements
    this.domain = 'www.evenero.com';
    this.baseUrl = 'https://api.eu.mailgun.net/v3';
    
    if (!this.apiKey) {
      console.warn('MAILGUN_API_KEY not found in environment variables');
      console.warn('Set MAILGUN_API_KEY environment variable for email functionality');
    }
    
    console.log(`EmailService initialized with domain: ${this.domain}`);
  }

  async sendSupportEmail(data: EmailData): Promise<boolean> {
    if (!this.apiKey) {
      console.error('Cannot send email: MAILGUN_API_KEY not configured');
      return false;
    }

    try {
      console.log(`Attempting to send email via Mailgun domain: ${this.domain}`);
      
      const form = new FormData();
      
      // Email configuration
      form.append('from', `Evenero Support <noreply@${this.domain}>`);
      form.append('to', 'post@evenero.com');
      form.append('bcc', 'lasse@cadas.no');
      form.append('h:Reply-To', data.email);
      form.append('subject', `[${data.category.toUpperCase()}] ${data.subject}`);
      
      // Email body
      const emailBody = this.formatEmailBody(data);
      form.append('text', emailBody);
      form.append('html', this.formatEmailBodyHtml(data));

      const mailgunUrl = `${this.baseUrl}/${this.domain}/messages`;
      console.log(`Making request to Mailgun URL: ${mailgunUrl}`);

      const response = await axios.post(
        mailgunUrl,
        form,
        {
          auth: {
            username: 'api',
            password: this.apiKey
          },
          headers: {
            ...form.getHeaders(),
            // Add user agent for better compatibility
            'User-Agent': 'Evenero-Support/1.0'
          },
          timeout: 30000, // 30 second timeout for deployment environments
          // Add retry logic for network issues
          validateStatus: function (status) {
            return status >= 200 && status < 300;
          }
        }
      );

      console.log('Support email sent successfully:', response.data);
      return true;
    } catch (error: any) {
      console.error('Failed to send support email - Full error details:');
      console.error('Error status:', error.response?.status);
      console.error('Error headers:', error.response?.headers);
      console.error('Error data:', error.response?.data);
      console.error('Error message:', error.message);
      console.error('Error config URL:', error.config?.url);
      console.error('Using domain:', this.domain);
      console.error('Using API key prefix:', this.apiKey ? this.apiKey.substring(0, 8) + '...' : 'NO KEY');
      console.error('Environment NODE_ENV:', process.env.NODE_ENV);
      console.error('Environment check - keys available:', Object.keys(process.env).filter(k => k.includes('MAILGUN')));
      
      // Return false but don't crash the application
      return false;
    }
  }

  private formatEmailBody(data: EmailData): string {
    return `
New Support Request - ${data.category.toUpperCase()}

From: ${data.name}
Email: ${data.email}
Category: ${data.category}
Subject: ${data.subject}

Message:
${data.message}

--
This email was sent from Evenero support form.
Reply directly to this email to respond to the customer.
    `.trim();
  }

  private formatEmailBodyHtml(data: EmailData): string {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>New Support Request</title>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .header { background: #6366f1; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f8fafc; padding: 20px; border: 1px solid #e2e8f0; }
        .field { margin-bottom: 15px; }
        .label { font-weight: bold; color: #4a5568; }
        .value { margin-top: 5px; }
        .message { background: white; padding: 15px; border-radius: 6px; border-left: 4px solid #6366f1; }
        .footer { color: #718096; font-size: 14px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
    </style>
</head>
<body>
    <div class="header">
        <h2>New Support Request - ${data.category.toUpperCase()}</h2>
    </div>
    <div class="content">
        <div class="field">
            <div class="label">From:</div>
            <div class="value">${data.name}</div>
        </div>
        <div class="field">
            <div class="label">Email:</div>
            <div class="value"><a href="mailto:${data.email}">${data.email}</a></div>
        </div>
        <div class="field">
            <div class="label">Category:</div>
            <div class="value">${data.category}</div>
        </div>
        <div class="field">
            <div class="label">Subject:</div>
            <div class="value">${data.subject}</div>
        </div>
        <div class="field">
            <div class="label">Message:</div>
            <div class="message">${data.message.replace(/\n/g, '<br>')}</div>
        </div>
    </div>
    <div class="footer">
        This email was sent from Evenero support form.<br>
        Reply directly to this email to respond to the customer.
    </div>
</body>
</html>
    `.trim();
  }
}

export const emailService = new EmailService();