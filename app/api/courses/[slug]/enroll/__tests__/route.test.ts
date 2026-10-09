import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, enrollments, lessonProgress } from '@/db';
import {
  CREATOR, STUDENT, makeRequest, params, seedCourse, seedEnrollment, seedLesson, seedModule, seedTree,
} from '@test/helpers';
import { AUTH_URL, PAY_URL, installFakeKernel } from '@test/kernel';
import { POST } from '../route';

vi.mock('@/lib/signing-identity', async () => {
  // A throwaway key generated per run — no key material is committed.
  const { generatePrivateKey } = await import('@ima-jin/auth');
  const privateKey = generatePrivateKey();
  return { getSigningIdentity: () => ({ appDid: 'did:imajin:app', privateKey, publicKey: null }) };
});

const kernel = installFakeKernel();
const ctx = params({ slug: 'intro' });
const enroll = (opts: Parameters<typeof makeRequest>[2] = {}) =>
  POST(makeRequest('POST', '/api/courses/intro/enroll', opts), ctx);
const attestations = () => kernel.calls.filter((c) => c.url === `${AUTH_URL}/api/attestations`);

describe('POST /api/courses/[slug]/enroll', () => {
  it('requires authentication', async () => {
    await seedTree();
    expect((await enroll()).status).toBe(401);
  });

  it('404s an unknown course and 400s one that is not published', async () => {
    expect((await enroll({ did: STUDENT })).status).toBe(404);
    await seedCourse({ status: 'draft' });
    const res = await enroll({ did: STUDENT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Course is not available for enrollment' });
  });

  it('is idempotent for an already-enrolled student', async () => {
    await seedTree();
    await seedEnrollment();
    const res = await enroll({ did: STUDENT });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enrolled: true, enrollment: { id: 'enr_1' } });
    expect(await db.select().from(enrollments)).toHaveLength(1);
  });

  describe('free course', () => {
    it('enrolls the caller and initialises not_started progress for every lesson in every module', async () => {
      await seedTree();
      await seedModule('crs_1', 'mod_2', 1);
      await seedLesson('mod_2', 'lsn_3', 0);

      const res = await enroll({ did: STUDENT });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.enrolled).toBe(true);
      expect(body.enrollment).toMatchObject({ courseId: 'crs_1', studentDid: STUDENT, paymentId: null });
      expect(body.enrollment.id).toMatch(/^enr_/);

      const progress = await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, body.enrollment.id));
      expect(progress.map((p) => p.lessonId).sort()).toEqual(['lsn_1', 'lsn_2', 'lsn_3']);
      expect(progress.every((p) => p.status === 'not_started')).toBe(true);
    });

    it('enrolls into a course that has no lessons yet', async () => {
      await seedCourse();
      expect((await enroll({ did: STUDENT })).status).toBe(201);
      expect(await db.select().from(lessonProgress)).toHaveLength(0);
    });

    it('emits learn.enrolled as an app-signed attestation delegated by the student', async () => {
      await seedTree();
      await enroll({ did: STUDENT });
      await vi.waitFor(() => expect(attestations()).toHaveLength(1));

      const call = attestations()[0];
      expect(call.headers.authorization).toBe(`Bearer tok:${STUDENT}`);
      expect(call.body).toMatchObject({
        issuer_did: 'did:imajin:app',
        subject_did: STUDENT,
        type: 'learn.enrolled',
        context_id: 'crs_1',
        context_type: 'course',
        payload: { delegator_did: STUDENT, scope: 'learn', creator_did: CREATOR, course_title: 'Intro' },
      });
      expect(typeof (call.body as { signature: string }).signature).toBe('string');
    });

    it('does not emit an event on the cookie fallback (no app token to act with) but still enrolls', async () => {
      await seedTree();
      const res = await enroll({ cookieDid: STUDENT });
      expect(res.status).toBe(201);
      await Promise.resolve();
      expect(attestations()).toHaveLength(0);
    });

    it('never fails the enrollment when the kernel rejects the event', async () => {
      await seedTree();
      kernel.respond.set('/api/attestations', () => Response.json({ error: 'no grant' }, { status: 403 }));
      const res = await enroll({ did: STUDENT });
      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(attestations()).toHaveLength(1));
    });
  });

  describe('paid course', () => {
    beforeEach(async () => {
      await seedCourse({ price: 5000, currency: 'USD', title: 'Pro "Course"' });
    });

    it('opens a pay-service checkout for the seller and returns its URL, without enrolling yet', async () => {
      const res = await enroll({ did: STUDENT, headers: { origin: 'https://learn.test' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enrolled: false, checkoutUrl: 'https://pay.test/checkout/cs_test' });
      expect(await db.select().from(enrollments)).toHaveLength(0);

      const checkout = kernel.calls.find((c) => c.url === `${PAY_URL}/api/checkout`);
      expect(checkout?.method).toBe('POST');
      expect(checkout?.body).toMatchObject({
        sellerDid: CREATOR,
        items: [{
          name: 'Pro "Course"',
          description: 'Enrollment in "Pro "Course""',
          amount: 5000,
          currency: 'USD',
          quantity: 1,
          metadata: { type: 'course_enrollment', courseId: 'crs_1', studentDid: STUDENT },
        }],
        successUrl: 'https://learn.test/api/courses/intro/enroll/callback',
        cancelUrl: 'https://learn.test/intro',
        metadata: { source: 'learn', courseId: 'crs_1', studentDid: STUDENT },
      });
    });

    it('lets the caller choose success/cancel URLs', async () => {
      await enroll({ did: STUDENT, body: { successUrl: 'https://x/ok', cancelUrl: 'https://x/no' } });
      const checkout = kernel.calls.find((c) => c.url === `${PAY_URL}/api/checkout`);
      expect(checkout?.body).toMatchObject({ successUrl: 'https://x/ok', cancelUrl: 'https://x/no' });
    });

    it('502s when the pay service refuses', async () => {
      kernel.respond.set('/api/checkout', () => new Response('boom', { status: 500 }));
      const res = await enroll({ did: STUDENT });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'Payment initiation failed' });
    });

    describe('card rail refusals (#2773)', () => {
      const refuse = (body: unknown, status: number) =>
        kernel.respond.set('/api/checkout', () => Response.json(body, { status }));

      it('answers a creator with no card rail with a plain 400 and the code, never "Payment initiation failed", and enrolls nobody', async () => {
        refuse({ error: "This seller hasn't set up card payments", code: 'SELLER_NO_CARD_RAIL' }, 400);

        const res = await enroll({ did: STUDENT });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "Card payments aren't set up for this course yet. Please contact the course creator about another way to pay.",
          code: 'SELLER_NO_CARD_RAIL',
        });
        expect(await db.select().from(enrollments)).toHaveLength(0);
      });

      it.each(['CARD_RAIL_KEY_MISSING', 'CARD_RAIL_KEY_REJECTED', 'CARD_RAIL_UNAVAILABLE', 'CARD_RAIL_REQUEST_REJECTED'])(
        'answers %s with a plain 502 that names the creator\'s Stripe account',
        async (code) => {
          refuse({ error: 'x', code }, 502);

          const res = await enroll({ did: STUDENT });

          expect(res.status).toBe(502);
          expect(await res.json()).toEqual({
            error: "Card payment couldn't be started on the course creator's Stripe account. Please try again later or contact the course creator.",
            code,
          });
        },
      );

      it('keeps "Payment initiation failed" for an unrelated pay error code', async () => {
        refuse({ error: 'boom', code: 'SOMETHING_ELSE' }, 500);

        const res = await enroll({ did: STUDENT });

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: 'Payment initiation failed' });
      });
    });

    it('503s when the pay service is unreachable', async () => {
      kernel.respond.set('/api/checkout', () => {
        throw new Error('ECONNREFUSED');
      });
      const res = await enroll({ did: STUDENT });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Payment service unavailable' });
    });

    it('503s when no pay service is configured, and falls back to the kernel URL when only that is set', async () => {
      vi.stubEnv('PAY_SERVICE_URL', '');
      expect((await enroll({ did: STUDENT })).status).toBe(503);

      vi.stubEnv('IMAJIN_KERNEL_URL', 'https://kernel.test');
      const res = await enroll({ did: STUDENT });
      expect(res.status).toBe(200);
      vi.unstubAllEnvs();
    });
  });
});
