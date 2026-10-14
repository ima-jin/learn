import { createFileKernelWebhookPinStore, KernelWebhookError, verifyKernelWebhook } from '@ima-jin/auth/kernel-webhook';
import { join } from 'node:path';
import { errorResponse, type JsonBody } from '@/lib/utils';

// Public trust pins persist alongside (but separately from) the app's bootstrap keystore.
const pinStore = createFileKernelWebhookPinStore(join(process.cwd(), '.imajin', 'kernel-webhook-pins'));

/** The SDK consumes the raw body once: never parse or reserialize it before verification. */
export async function authenticateKernelWebhook(request: Request): Promise<{ body: JsonBody } | { response: Response }> {
  let body: unknown;
  try {
    body = await verifyKernelWebhook(request, {
      audience: process.env.IMAJIN_APP_DID ?? '',
      authServiceUrl: process.env.AUTH_SERVICE_URL ?? '',
      pinStore,
    });
  } catch (error) {
    if (!(error instanceof KernelWebhookError) || ['STORE', 'DISCOVERY', 'TRUST'].includes(error.code)) {
      return { response: errorResponse('Webhook verification unavailable', 503) };
    }
    if (error.code === 'INVALID_BODY') {
      return { response: errorResponse('Invalid JSON body') };
    }
    return { response: errorResponse('Unauthorized', 401) };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { response: errorResponse('Request body must be a JSON object') };
  }
  return { body };
}
