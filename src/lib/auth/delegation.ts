import { enforceDelegationPolicy, type DelegationRouteEntry } from '@ima-jin/auth/delegation-policy';
import type { AuthenticatedCaller } from '@/lib/auth/authenticate';

/** Delegation-policy registry keys for this app's owner-mutation routes. */
export type LearnDeleteRouteKey = 'learn.course.delete' | 'learn.module.delete' | 'learn.lesson.delete';
// SDK 0.8.18 no longer includes this standalone app's routes in its inventory.
export const LEARN_DELEGATION_ROUTES: Record<LearnDeleteRouteKey, DelegationRouteEntry> = {
  'learn.course.delete': {
    app: 'learn', class: 'irreversible', action: 'delete', method: 'DELETE',
    path: '/api/courses/[slug]', why: 'archives a course',
  },
  'learn.module.delete': {
    app: 'learn', class: 'irreversible', action: 'delete', method: 'DELETE',
    path: '/api/courses/[slug]/modules/[moduleId]', why: 'deletes a module and its lessons',
  },
  'learn.lesson.delete': {
    app: 'learn', class: 'irreversible', action: 'delete', method: 'DELETE',
    path: '/api/courses/[slug]/modules/[moduleId]/lessons/[lessonId]', why: 'deletes a lesson',
  },
};

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
  const policy = LEARN_DELEGATION_ROUTES[key];
  return enforceDelegationPolicy(
    { id: caller.did, actingFor: caller.actingFor },
    { action: policy.action, class: policy.class, resourceId },
  );
}
