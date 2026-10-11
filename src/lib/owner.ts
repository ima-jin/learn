import { authenticate } from '@/lib/auth/authenticate';
import { type LearnDeleteRouteKey, enforceOwnerMutationPolicy } from '@/lib/auth/delegation';
import { type Course, getCourseBySlug } from '@/lib/course-access';
import { errorResponse } from '@/lib/utils';

/**
 * Shared gate for every creator-only write: authenticate (401), the course
 * exists (404), and the caller is its creator (403) — in that order, matching
 * the in-monorepo handlers.
 *
 * `policy` names a delegation-policy registry key (irreversible mutations such
 * as delete); it is enforced right after authentication, before any lookup, so
 * an agent delegate gets the 403 `AGENT_APPROVAL_REQUIRED` regardless of ownership.
 */
export async function requireCourseOwner(
  request: Request,
  slug: string,
  policy?: { key: LearnDeleteRouteKey; resourceId: string },
): Promise<{ course: Course; did: string } | { response: Response }> {
  const authResult = await authenticate(request);
  if ('error' in authResult) return { response: errorResponse(authResult.error, authResult.status) };

  if (policy) {
    const denied = enforceOwnerMutationPolicy(authResult.auth, policy.key, policy.resourceId);
    if (denied) return { response: denied };
  }

  const course = await getCourseBySlug(slug);
  if (!course) return { response: errorResponse('Course not found', 404) };

  const { did } = authResult.auth;
  if (course.creatorDid !== did) return { response: errorResponse('Not authorized', 403) };

  return { course, did };
}
