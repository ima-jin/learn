/**
 * POST /api/webhook
 *
 * Called by the kernel's pay service when a learn course-enrollment checkout is paid
 * (ima-jin/learn#13, the kernel's `notifyLearnService`). Creates the student's enrollment.
 *
 * Authentication is `Authorization: Bearer <WEBHOOK_SECRET>`, compared in constant time, and fails
 * closed: with no secret configured nothing is authorized.
 *
 * Only a payment the kernel settled on the course creator's OWN Stripe account (`rail: "stripe-byo"`)
 * enrolls. The notification's `metadata` is whatever the checkout caller supplied, so before enrolling:
 *   - the kernel-attested top-level `sellerDid` (the owner whose Stripe account took the money) must be
 *     the course's creator — otherwise a payment to anyone else's account could buy this course;
 *   - the amount collected must cover the course price, in the course's currency.
 *
 * Idempotent: the kernel may redeliver, and a replay returns the existing enrollment.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { createLogger } from '@ima-jin/logger';
import { db } from '@/db';
import { courses, type Course } from '@/db/schema';
import { STRIPE_BYO_RAIL } from '@/lib/card-rail';
import { enrollStudent } from '@/lib/enrollment';
import { webhookSecret } from '@/lib/env';
import { errorResponse, jsonResponse, readJson, type JsonBody } from '@/lib/utils';

const log = createLogger('learn');

const BEARER_PREFIX = 'Bearer ';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time: both sides are hashed first, so neither content nor length of the secret leaks. */
function secretsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(sha256(provided), sha256(expected));
}

/** Bearer secret only — and fail closed: with no secret configured, nothing is authorized. */
function isWebhookAuthorized(request: NextRequest): boolean {
  const expected = webhookSecret();
  if (!expected) {
    log.error({}, 'WEBHOOK_SECRET is not set — rejecting every webhook; paid enrollments will not be created');
    return false;
  }
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith(BEARER_PREFIX)) return false;
  return secretsMatch(authorization.slice(BEARER_PREFIX.length), expected);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isPaymentSuccess(body: JsonBody): boolean {
  return body.type === 'payment.succeeded' || body.status === 'paid' || body.status === 'succeeded';
}

/** Does what the kernel collected cover the course price, in the course's currency? */
function coversPrice(course: Course, amount: unknown, currency: unknown): boolean {
  const price = course.price ?? 0;
  if (price <= 0) return true;
  if (typeof amount !== 'number' || amount < price) return false;
  const expectedCurrency = (course.currency || 'CAD').toUpperCase();
  return typeof currency === 'string' && currency.toUpperCase() === expectedCurrency;
}

/**
 * The course this payment buys, or the response to send when it must not enroll anyone.
 * Every refusal is logged: the money has already moved, so an operator has to be able to see why a
 * paid learner was not enrolled.
 */
async function resolvePaidCourse(body: JsonBody, courseId: string): Promise<Course | Response> {
  const [course] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1);
  if (!course) {
    log.error({ courseId, sessionId: body.sessionId }, 'Paid enrollment names a course that does not exist');
    return errorResponse('Course not found', 404);
  }

  if (stringField(body.sellerDid) !== course.creatorDid) {
    log.error(
      { courseId, sessionId: body.sessionId },
      "Paid enrollment refused — the payment was not collected on the course creator's own Stripe account",
    );
    return errorResponse('Payment was not made to the course creator', 403);
  }

  if (!coversPrice(course, body.metadata?.amount, body.metadata?.currency)) {
    log.error(
      { courseId, sessionId: body.sessionId, price: course.price },
      'Paid enrollment refused — the amount collected does not cover the course price',
    );
    return errorResponse('Payment does not cover the course price', 422);
  }

  return course;
}

async function enrollPaidStudent(body: JsonBody): Promise<Response> {
  const courseId = stringField(body.metadata?.courseId);
  const studentDid = stringField(body.metadata?.studentDid);
  if (!courseId || !studentDid) {
    log.error({ sessionId: body.sessionId }, 'Paid enrollment carries no courseId / studentDid');
    return errorResponse('metadata.courseId and metadata.studentDid are required', 400);
  }

  const course = await resolvePaidCourse(body, courseId);
  if (course instanceof Response) return course;

  const { enrollment, created } = await enrollStudent({
    courseId: course.id,
    studentDid,
    paymentId: stringField(body.paymentId) ?? stringField(body.sessionId) ?? null,
  });

  log.info({ courseId, enrollmentId: enrollment.id, created }, created ? 'Paid enrollment created' : 'Paid enrollment replay — already enrolled');
  return jsonResponse({ received: true, enrolled: true, created, enrollmentId: enrollment.id }, created ? 201 : 200);
}

export async function POST(request: NextRequest) {
  if (!isWebhookAuthorized(request)) return errorResponse('Unauthorized', 401);

  const parsed = await readJson(request);
  if ('response' in parsed) return parsed.response;
  const { body } = parsed;

  if (!isPaymentSuccess(body)) return jsonResponse({ received: true, enrolled: false });

  // Without the kernel's own settlement marker there is nothing to trust the seller on: Stripe Connect
  // is gone, so a payment on any other rail is not one this app can attribute to the course's creator.
  if (body.rail !== STRIPE_BYO_RAIL) {
    log.warn({ sessionId: body.sessionId, rail: body.rail }, 'Payment notification is not on the stripe-byo rail — no enrollment created');
    return jsonResponse({ received: true, enrolled: false });
  }

  try {
    return await enrollPaidStudent(body);
  } catch (error) {
    log.error({ err: String(error), sessionId: body.sessionId }, 'Paid enrollment failed');
    return errorResponse('Webhook processing failed', 500);
  }
}
