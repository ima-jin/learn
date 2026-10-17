import { enforceDelegationPolicy, type DelegationMutation, type DelegationRouteEntry } from '@ima-jin/auth/delegation-policy';
import type { AuthenticatedCaller } from '@/lib/auth/authenticate';
/** App-owned inventory; decisions and proposal bodies come only from the SDK. */
export const LEARN_DELEGATION_ROUTES = {
  'learn.course.create': {
    app: 'learn', class: 'irreversible', action: 'create', method: 'POST',
    path: '/api/courses', why: 'Creates a retained course and attribution record; archive is not deletion.',
  },
  'learn.course.update': {
    app: 'learn', class: 'reversible', action: 'update', method: 'PATCH',
    path: '/api/courses/[slug]', why: 'Editable course details; money, attribution and disclosure fields escalate below.',
  },
  'learn.course.delete': {
    app: 'learn', class: 'irreversible', action: 'delete', method: 'DELETE',
    path: '/api/courses/[slug]', why: 'archives a course',
  },
  'learn.module.delete': {
    app: 'learn', class: 'irreversible', action: 'delete', method: 'DELETE',
    path: '/api/courses/[slug]/modules/[moduleId]', why: 'deletes a module and its lessons',
  },
  'learn.module.create': {
    app: 'learn', class: 'reversible', action: 'create', method: 'POST',
    path: '/api/courses/[slug]/modules', why: 'Adds editable module metadata that the owner can remove.',
  },
  'learn.module.update': {
    app: 'learn', class: 'reversible', action: 'update', method: 'PATCH',
    path: '/api/courses/[slug]/modules/[moduleId]', why: 'Edits module title, description or ordering.',
  },
  'learn.module.reorder': {
    app: 'learn', class: 'reversible', action: 'reorder', method: 'PATCH',
    path: '/api/courses/[slug]/modules/reorder', why: 'Changes module ordering, which the owner can restore.',
  },
  'learn.lesson.create': {
    app: 'learn', class: 'irreversible', action: 'create', method: 'POST',
    path: '/api/courses/[slug]/modules/[moduleId]/lessons', why: 'Discloses new lesson content to existing readers; disclosure cannot be undone.',
  },
  'learn.lesson.update': {
    app: 'learn', class: 'irreversible', action: 'update', method: 'PATCH',
    path: '/api/courses/[slug]/modules/[moduleId]/lessons/[lessonId]', why: 'Overwrites unversioned lesson content and can disclose it to existing readers.',
  },
  'learn.lesson.delete': {
    app: 'learn', class: 'irreversible', action: 'delete', method: 'DELETE',
    path: '/api/courses/[slug]/modules/[moduleId]/lessons/[lessonId]', why: 'deletes a lesson',
  },
  'learn.lesson.reorder': {
    app: 'learn', class: 'reversible', action: 'reorder', method: 'PATCH',
    path: '/api/courses/[slug]/modules/[moduleId]/lessons/reorder', why: 'Changes lesson ordering, which the owner can restore.',
  },
  'learn.course.enroll': {
    app: 'learn', class: 'irreversible', action: 'enroll', method: 'POST',
    path: '/api/courses/[slug]/enroll', why: 'Can create a permanent free enrollment and signed learn.enrolled record; no undo route.',
  },
  'learn.lesson.complete': {
    app: 'learn', class: 'irreversible', action: 'complete', method: 'POST',
    path: '/api/courses/[slug]/lessons/[lessonId]/complete', why: 'Records completion and can emit a signed learn.completed attestation; no undo route.',
  },
} as const satisfies Record<string, DelegationRouteEntry>;

/** Separate protocols, not delegated owner authority. Never bypass auth using these entries. */
export const LEARN_DELEGATION_EXCEPTIONS = [
  { method: 'POST', path: '/api/webhook', why: 'Kernel-signed payment callback with audience, timestamp and replay verification.' },
  { method: 'POST', path: '/api/claim', why: 'One-time operator claim-code protocol, not owner-session authority.' },
  { method: 'POST', path: '/api/auth/logout', why: 'SDK logout clears a session; it does not mutate an owner resource.' },
] as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function matchPath(template: string, path: string): Record<string, string> | null {
  const expected = template.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    if (segment.startsWith('[')) {
      if (!actual[index]) return null;
      params[segment.slice(1, -1)] = actual[index];
    } else if (segment !== actual[index]) {
      return null;
    }
  }
  return params;
}

async function courseUpdateMutation(request: Request): Promise<DelegationMutation | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null; // The handler retains its malformed-body 400 response.
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if ('price' in body || 'currency' in body || 'metadata' in body) {
    return { action: 'fair-update', class: 'value-moving' };
  }
  if ('status' in body || 'visibility' in body) {
    return { action: 'publish', class: 'irreversible' };
  }
  return null;
}

/** Common auth gate, before any resource lookup; unknown delegated mutations fail closed. */
export async function enforceOwnerMutationPolicy(
  caller: Pick<AuthenticatedCaller, 'did' | 'actingFor'>,
  request: Request,
): Promise<Response | null> {
  if (SAFE_METHODS.has(request.method)) return null;
  const pathname = new URL(request.url).pathname;
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  const path = base && pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
  // Prefer literal routes (e.g. reorder) over a same-length dynamic segment.
  const entries = Object.entries(LEARN_DELEGATION_ROUTES).sort(
    ([, a], [, b]) => a.path.split('[').length - b.path.split('[').length,
  );
  let mutation: DelegationMutation = { action: 'unclassified-mutation', class: 'irreversible' };
  for (const [key, policy] of entries) {
    if (policy.method !== request.method) continue;
    const params = matchPath(policy.path, path);
    if (!params) continue;
    const sensitive = key === 'learn.course.update' ? await courseUpdateMutation(request) : null;
    mutation = {
      action: sensitive?.action ?? policy.action,
      class: sensitive?.class ?? policy.class,
      resourceId: params.lessonId ?? params.moduleId ?? params.slug,
    };
    break;
  }
  return enforceDelegationPolicy(
    { id: caller.did, actingFor: caller.actingFor },
    mutation,
  );
}
