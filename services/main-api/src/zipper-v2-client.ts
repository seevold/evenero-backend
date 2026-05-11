import { GoogleAuth, IdTokenClient } from 'google-auth-library';

const ZIPPER_V2_URL = process.env.ZIPPER_V2_URL || '';
const ZIPPER_V2_AUDIENCE = process.env.ZIPPER_V2_AUDIENCE || ZIPPER_V2_URL;

let cachedClient: IdTokenClient | null = null;

async function getIdTokenClient(): Promise<IdTokenClient> {
  if (cachedClient) return cachedClient;
  if (!ZIPPER_V2_AUDIENCE) {
    throw new Error('ZIPPER_V2_URL/ZIPPER_V2_AUDIENCE not configured');
  }
  const auth = new GoogleAuth();
  cachedClient = await auth.getIdTokenClient(ZIPPER_V2_AUDIENCE);
  return cachedClient;
}

export type ZipperV2Request = {
  mediaIds: string[];
  eventName: string;
  eventId: string;
  userEmail: string;
};

export type ZipperV2Response = {
  success: boolean;
  jobId: string;
  expectedFileName: string;
  estimatedFiles: number;
};

export function isZipperV2Configured(): boolean {
  return !!ZIPPER_V2_URL;
}

export async function startZipJob(req: ZipperV2Request): Promise<ZipperV2Response> {
  if (!ZIPPER_V2_URL) {
    throw new Error('ZIPPER_V2_URL not configured');
  }

  const client = await getIdTokenClient();
  const res = await client.request<ZipperV2Response>({
    url: `${ZIPPER_V2_URL.replace(/\/$/, '')}/zip`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: req,
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Zipper v2 returned ${res.status}: ${JSON.stringify(res.data)}`);
  }

  return res.data;
}
