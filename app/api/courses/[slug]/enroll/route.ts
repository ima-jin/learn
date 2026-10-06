import { NextRequest } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db } from '@/db';
import { enrollments, lessonProgress, lessons, modules } from '@/db/schema';
import { authenticate } from '@/lib/auth/authenticate';
import { getCourseBySlug } from '@/lib/course-access';
import { payServiceUrl } from '@/lib/env';
import { emitLearnEvent } from '@/lib/events';
import { errorResponse, generateId, jsonResponse } from '@/lib/utils';

const log = createLogger('learn');

type RouteParams = { params: Promise<{ slug: string }> };

/**
 * POST /api/courses/[slug]/enroll — Enroll in course (free) or initiate payment (paid)
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { slug } = await params;

  const authResult = await authenticate(request);
  if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

  const { auth } = authResult;
  const did = auth.did;

  const course = await getCourseBySlug(slug);
  if (!course) return errorResponse('Course not found', 404);

  if (course.status !== 'published') return errorResponse('Course is not available for enrollment', 400);

  // Check if already enrolled
  const existing = await db.select().from(enrollments)
    .where(and(
      eq(enrollments.courseId, course.id),
      eq(enrollments.studentDid, did),
    )).limit(1);

  if (existing.length > 0) {
    return jsonResponse({ enrolled: true, enrollment: existing[0] });
  }

  // Free enrollment
  if (!course.price || course.price === 0) {
    const enrollment = {
      id: generateId('enr'),
      courseId: course.id,
      studentDid: did,
      paymentId: null,
    };

    await db.insert(enrollments).values(enrollment);

    // Initialize progress for all lessons
    const courseModules = await db.select().from(modules).where(eq(modules.courseId, course.id));
    for (const mod of courseModules) {
      const moduleLessons = await db.select({ id: lessons.id }).from(lessons).where(eq(lessons.moduleId, mod.id));
      if (moduleLessons.length > 0) {
        await db.insert(lessonProgress).values(
          moduleLessons.map(l => ({
            enrollmentId: enrollment.id,
            lessonId: l.id,
            status: 'not_started',
          }))
        );
      }
    }

    // Best-effort domain event via the kernel's public attestation API.
    emitLearnEvent({
      type: 'learn.enrolled',
      caller: auth,
      courseId: course.id,
      courseTitle: course.title,
      creatorDid: course.creatorDid,
      payload: { enrolled_at: new Date().toISOString() },
    }).catch(() => undefined);

    return jsonResponse({ enrolled: true, enrollment }, 201);
  }

  // Paid enrollment — hand off to the kernel's pay service checkout
  const payUrl = payServiceUrl();
  if (!payUrl) {
    log.error({}, 'Pay service URL is not configured');
    return errorResponse('Payment service unavailable', 503);
  }

  const body = await request.json().catch(() => ({}));
  const origin = request.headers.get('origin') || '';
  const successUrl = body.successUrl || `${origin}/api/courses/${slug}/enroll/callback`;
  const cancelUrl = body.cancelUrl || `${origin}/${slug}`;

  try {
    const checkoutResponse = await fetch(`${payUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sellerDid: course.creatorDid,
        items: [{
          name: course.title,
          description: `Enrollment in "${course.title}"`,
          amount: course.price,
          currency: course.currency || 'CAD',
          quantity: 1,
          metadata: {
            type: 'course_enrollment',
            courseId: course.id,
            studentDid: did,
          },
        }],
        successUrl,
        cancelUrl,
        metadata: {
          source: 'learn',
          courseId: course.id,
          studentDid: did,
        },
      }),
    });

    if (!checkoutResponse.ok) {
      const error = await checkoutResponse.text();
      log.error({ err: error }, 'Pay service error');
      return errorResponse('Payment initiation failed', 502);
    }

    const checkout = await checkoutResponse.json();
    return jsonResponse({ enrolled: false, checkoutUrl: checkout.url });
  } catch (error) {
    log.error({ err: String(error) }, 'Pay service unreachable');
    return errorResponse('Payment service unavailable', 503);
  }
}
