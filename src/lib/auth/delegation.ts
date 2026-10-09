import { enforceRoutePolicy } from '@ima-jin/auth/delegation-policy';
import type { AuthenticatedCaller } from '@/lib/auth/authenticate';

/** Delegation-policy registry keys for this app's owner-mutation routes. */
export type LearnDeleteRouteKey = 'learn.course.delete' | 'learn.module.delete' | 'learn.lesson.delete';

/**
 * Blanket delegation policy for owner-mutation routes (ima-jin/imajin-ai#2360).
 * `learn.*.delete` are irreversible, so an agent acting under `X-Acting-For`
 * may propose but never execute them: returns the 403 `AGENT_APPROVAL_REQUIRED`
 * response for a delegate, otherwise `null`. Group act-as and app-token scopes
 * are separate authority models and are not governed here.
 */
export function enforceOwnerMutationPolicy(
  caller: Pick<AuthenticatedCaller, 'did' | 'actingFor'>,
  key: LearnDeleteRouteKey,
  resourceId: string,
): Response | null {
  return enforceRoutePolicy({ id: caller.did, actingFor: caller.actingFor }, key, { resourceId });
}
