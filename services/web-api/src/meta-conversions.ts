import crypto from 'crypto';

const META_PIXEL_ID = '2000365027420110';
const META_API_VERSION = 'v22.0';

interface UserData {
  email?: string;
  phone?: string;
  clientIpAddress?: string;
  clientUserAgent?: string;
  fbp?: string;
  fbc?: string;
}

interface CustomData {
  currency?: string;
  value?: number;
  content_ids?: string[];
  content_type?: string;
  num_items?: number;
}

interface EventData {
  eventName: string;
  eventTime: number;
  eventSourceUrl: string;
  eventId?: string;
  userData: UserData;
  customData?: CustomData;
}

function hashData(data: string | undefined): string | null {
  if (!data) return null;
  
  const normalized = data.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function prepareUserData(userData: UserData) {
  const prepared: any = {};
  
  const hashedEmail = hashData(userData.email);
  if (hashedEmail) {
    prepared.em = [hashedEmail];
  }
  
  const hashedPhone = hashData(userData.phone);
  if (hashedPhone) {
    prepared.ph = [hashedPhone];
  }
  
  if (userData.clientIpAddress) {
    prepared.client_ip_address = userData.clientIpAddress;
  }
  
  if (userData.clientUserAgent) {
    prepared.client_user_agent = userData.clientUserAgent;
  }
  
  if (userData.fbp) {
    prepared.fbp = userData.fbp;
  }
  
  if (userData.fbc) {
    prepared.fbc = userData.fbc;
  }
  
  return prepared;
}

export async function sendMetaEvent(eventData: EventData): Promise<boolean> {
  const accessToken = process.env.META_ACCESS_TOKEN;
  
  if (!accessToken) {
    console.error('❌ META_ACCESS_TOKEN not configured');
    return false;
  }
  
  console.log(`📤 Sending ${eventData.eventName} to Meta Conversion API`, {
    event_id: eventData.eventId,
    event_source_url: eventData.eventSourceUrl,
    has_email: !!eventData.userData.email,
    has_ip: !!eventData.userData.clientIpAddress,
    has_user_agent: !!eventData.userData.clientUserAgent,
    has_fbp: !!eventData.userData.fbp,
    has_fbc: !!eventData.userData.fbc,
    custom_data: eventData.customData
  });
  
  try {
    const payload = {
      data: [
        {
          event_name: eventData.eventName,
          event_time: eventData.eventTime,
          event_source_url: eventData.eventSourceUrl,
          action_source: 'website',
          user_data: prepareUserData(eventData.userData),
          ...(eventData.customData && { custom_data: eventData.customData }),
          ...(eventData.eventId && { event_id: eventData.eventId })
        }
      ]
    };
    
    const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events?access_token=${accessToken}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });
    
    const result = await response.json() as { events_received?: number; messages?: string[] };

    if (!response.ok) {
      console.error('❌ Meta Conversion API error:', {
        status: response.status,
        statusText: response.statusText,
        result
      });
      return false;
    }

    console.log(`✅ Meta Conversion API: ${eventData.eventName} sent successfully`, {
      events_received: result.events_received,
      messages: result.messages,
      event_id: eventData.eventId
    });
    
    return true;
  } catch (error) {
    console.error('❌ Error sending Meta Conversion API event:', error);
    return false;
  }
}

export async function trackInitiateCheckout(
  userData: UserData,
  eventSourceUrl: string,
  eventId?: string,
  currency?: string,
  value?: number
): Promise<boolean> {
  console.log('🛒 Tracking InitiateCheckout event', { event_id: eventId });
  return sendMetaEvent({
    eventName: 'InitiateCheckout',
    eventTime: Math.floor(Date.now() / 1000),
    eventSourceUrl,
    eventId,
    userData,
    customData: currency && value ? { currency, value } : undefined
  });
}

export async function trackPurchase(
  userData: UserData,
  eventSourceUrl: string,
  currency: string,
  value: number,
  eventId?: string
): Promise<boolean> {
  console.log('💰 Tracking Purchase event', { 
    event_id: eventId,
    currency: currency.toUpperCase(),
    value: value
  });
  return sendMetaEvent({
    eventName: 'Purchase',
    eventTime: Math.floor(Date.now() / 1000),
    eventSourceUrl,
    eventId,
    userData,
    customData: {
      currency: currency.toUpperCase(),
      value: value
    }
  });
}

export async function trackPageView(
  userData: UserData,
  eventSourceUrl: string,
  eventId?: string
): Promise<boolean> {
  return sendMetaEvent({
    eventName: 'PageView',
    eventTime: Math.floor(Date.now() / 1000),
    eventSourceUrl,
    eventId,
    userData
  });
}
