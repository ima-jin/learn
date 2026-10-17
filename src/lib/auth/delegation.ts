import { enforceDelegationPolicy, type DelegationMutation, type DelegationRouteEntry, type MutationClass } from '@ima-jin/auth/delegation-policy';
import type { AuthenticatedCaller } from '@/lib/auth/authenticate';

function route(
  method: DelegationRouteEntry['method'],
  path: string,
  action: string,
  mutationClass: MutationClass,
  why: string,
): DelegationRouteEntry {
  return { app: 'learn', method, path, action, class: mutationClass, why };
}
/** App-owned inventory; decisions and proposal bodies come only from the SDK. */
export const LEARN_DELEGATION_ROUTES = {
  'learn.course.create': route('POST', '/api/courses', 'create', 'irreversible',
    'Creates a retained course and attribution record; archive is not deletion.'),
  'learn.course.update': route('PATCH', '/api/courses/[slug]', 'update', 'reversible',
    'Editable course details; money, attribution and disclosure fields escalate below.'),
  'learn.course.delete': route('DELETE', '/api/courses/[slug]', 'delete', 'irreversible',
    'Archives a course, removing its availability to learners.'),
  'learn.module.delete': route('DELETE', '/api/courses/[slug]/modules/[moduleId]', 'delete', 'irreversible',
    'Deletes a module and its lessons.'),
  'learn.module.create': route('POST', '/api/courses/[slug]/modules', 'create', 'reversible',
    'Adds editable module metadata that the owner can remove.'),
  'learn.module.update': route('PATCH', '/api/courses/[slug]/modules/[moduleId]', 'update', 'reversible',
    'Edits module title, description or ordering.'),
  'learn.module.reorder': route('PATCH', '/api/courses/[slug]/modules/reorder', 'reorder', 'reversible',
    'Changes module ordering, which the owner can restore.'),
  'learn.lesson.create': route('POST', '/api/courses/[slug]/modules/[moduleId]/lessons', 'create', 'irreversible',
    'Discloses new lesson content to existing readers; disclosure cannot be undone.'),
  'learn.lesson.update': route('PATCH', '/api/courses/[slug]/modules/[moduleId]/lessons/[lessonId]', 'update', 'irreversible',
    'Overwrites unversioned lesson content and can disclose it to existing readers.'),
  'learn.lesson.delete': route('DELETE', '/api/courses/[slug]/modules/[moduleId]/lessons/[lessonId]', 'delete', 'irreversible',
    'Deletes a lesson.'),
  'learn.lesson.reorder': route('PATCH', '/api/courses/[slug]/modules/[moduleId]/lessons/reorder', 'reorder', 'reversible',
    'Changes lesson ordering, which the owner can restore.'),
  'learn.course.enroll': route('POST', '/api/courses/[slug]/enroll', 'enroll', 'irreversible',
    'Can create a permanent free enrollment and signed learn.enrolled record; no undo route.'),
  'learn.lesson.complete': route('POST', '/api/courses/[slug]/lessons/[lessonId]/complete', 'complete', 'irreversible',
    'Records completion and can emit a signed learn.completed attestation; no undo route.'),
};

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
