import { requestAppServiceToken } from '@ima-jin/auth-client';
import { getSigningIdentity } from '@/lib/signing-identity';

let cachedToken: { token: string; refreshAt: number } | null = null;
let inflightMint: Promise<string> | null = null;

async function mintToken(): Promise<string> {
  const kernelUrl = process.env.IMAJIN_KERNEL_URL;
  if (!kernelUrl) throw new Error('App-service token unavailable');

  const { appDid, privateKey } = getSigningIdentity();
  const minted = await requestAppServiceToken({
    kernelUrl,
    appDid,
    privateKey,
    fetchOptions: { signal: AbortSignal.timeout(5000) },
  });
  if (!minted.token || !Number.isFinite(minted.expiresIn) || minted.expiresIn <= 0) {
    throw new Error('App-service token unavailable');
  }
  cachedToken = { token: minted.token, refreshAt: Date.now() + minted.expiresIn * 0.8 * 1000 };
  return minted.token;
}

/** Uses only the bootstrapped app identity; coalesces mints and refreshes at 80% of the TTL. */
export async function getAppServiceToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.refreshAt) return cachedToken.token;
  inflightMint ??= mintToken()
    .catch(() => {
      // Never propagate an SDK/provider error that might contain credential material.
      throw new Error('App-service token unavailable');
    })
    .finally(() => {
      // A failed mint must not poison subsequent retries.
      inflightMint = null;
    });
  return inflightMint;
}
