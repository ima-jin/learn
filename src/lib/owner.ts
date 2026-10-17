import { authenticate, authenticationErrorResponse } from '@/lib/auth/authenticate';
import { type Course, getCourseBySlug } from '@/lib/course-access';
import { errorResponse } from '@/lib/utils';

/**
 * Shared gate for every creator-only write: authenticate (401), the course
 * exists (404), and the caller is its creator (403) — in that order, matching
 * the in-monorepo handlers.
 *
 * Authentication centrally enforces delegation policy before any lookup,
 * regardless of whether a route author remembered a per-route opt-in.
 */
export async function requireCourseOwner(
  request: Request,
  slug: string,
): Promise<{ course: Course; did: string } | { response: Response }> {
  const authResult = await authenticate(request);
  if ('error' in authResult) return { response: authenticationErrorResponse(authResult) };

  const course = await getCourseBySlug(slug);
  if (!course) return { response: errorResponse('Course not found', 404) };

  const { did } = authResult.auth;
  if (course.creatorDid !== did) return { response: errorResponse('Not authorized', 403) };

  return { course, did };
}
