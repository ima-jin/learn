import { submitDelegatedAttestation } from '@ima-jin/auth';
import { createLogger } from '@ima-jin/logger';
import { getSigningIdentity } from '@/lib/signing-identity';
import { authServiceUrl } from '@/lib/env';
import type { AuthenticatedCaller } from '@/lib/auth/authenticate';

const log = createLogger('learn');

export type LearnEventType = 'learn.enrolled' | 'learn.completed';

export interface LearnEventInput {
  type: LearnEventType;
  /** The student the event is about — also the delegator of the attestation. */
  caller: AuthenticatedCaller;
  courseId: string;
  courseTitle: string;
  creatorDid: string;
  payload: Record<string, unknown>;
}

/**
 * Emit a `learn.*` domain event through the kernel's PUBLIC, app-auth-gated
 * attestation API (`POST {kernel}/auth/api/attestations`, #2394) — never an
 * in-process bus (AGENTS.md §2). The attestation is signed with this app's own
 * key and submitted with the caller's scoped app token, delegated by the
 * student (`payload.delegator_did`).
 *
 * Strictly best-effort and never throws, exactly like the kernel version's
 * `publish(...).catch(() => {})`: an event that cannot be emitted (no app
 * token on the cookie path, signing identity not bootstrapped, auth service
 * unset, or the student has not granted `attest:<appId>:<type>` yet) must
 * never fail the enrollment/completion that triggered it.
 */
export async function emitLearnEvent(input: LearnEventInput): Promise<boolean> {
  const authUrl = authServiceUrl();
  if (!input.caller.appToken || !authUrl) return false;

  try {
    const identity = getSigningIdentity();
    const result = await submitDelegatedAttestation({
      authUrl,
      appToken: input.caller.appToken,
      appDid: identity.appDid,
      appPrivateKey: identity.privateKey,
      delegatorDid: input.caller.did,
      subjectDid: input.caller.did,
      type: input.type,
      contextId: input.courseId,
      contextType: 'course',
      payload: {
        ...input.payload,
        scope: 'learn',
        creator_did: input.creatorDid,
        course_title: input.courseTitle,
      },
    });
    if (!result.ok) {
      log.warn({ type: input.type, status: result.status, err: result.error }, 'learn event not emitted');
    }
    return result.ok;
  } catch (error) {
    log.warn({ type: input.type, err: String(error) }, 'learn event not emitted');
    return false;
  }
}
