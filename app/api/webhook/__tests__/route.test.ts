import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { computeKeyKid } from '@ima-jin/auth/key-rotation';
import { canonicalKernelWebhookPayload } from '@ima-jin/auth/kernel-webhook';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { courses, db, enrollments, lessonProgress } from '@/db';
import { CREATOR, OTHER, STUDENT, makeRequest, seedCourse, seedLesson, seedModule } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { POST } from '../route';

// Only isolate durable public pins; the actual published verifier and replay store run in every test.
vi.mock('@ima-jin/auth/kernel-webhook', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ima-jin/auth/kernel-webhook')>();
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'learn-webhook-pins-'));
  return { ...actual, createFileKernelWebhookPinStore: () => actual.createFileKernelWebhookPinStore(directory) };
});

const kernel = installFakeKernel();
const APP_DID = 'did:imajin:learn-test';
const keypair = generateKeyPairSync('ed25519');
const publicKey = keypair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const kid = computeKeyKid(publicKey);

type Body = Record<string, unknown>;

/** What the kernel's `notifyLearnService` sends for a checkout paid on the creator's own Stripe account. */
function paidBody(overrides: Body = {}, metadata: Body = {}): Body {
  return {
    type: 'payment.succeeded',
    sessionId: 'cs_test_1',
    paymentId: 'pi_test_1',
    rail: 'stripe-byo',
    sellerDid: CREATOR,
    metadata: {
      service: 'learn',
      courseId: 'crs_1',
      studentDid: STUDENT,
      amount: 5000,
      currency: 'CAD',
      ...metadata,
    },
    ...overrides,
  };
}

function signedRequest(rawBody: string, options: {
  timestamp?: number;
  audience?: string;
  path?: string;
  privateKey?: typeof keypair.privateKey;
} = {}) {
  const audience = options.audience ?? APP_DID;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const path = options.path ?? '/api/webhook';
  const payload = canonicalKernelWebhookPayload({
    audience, timestamp, nonce, method: 'POST', url: `https://learn.test${path}`, rawBody,
  });
  return makeRequest('POST', path, { rawBody, headers: {
    'x-kernel-audience': audience,
    'x-kernel-timestamp': timestamp,
    'x-kernel-nonce': nonce,
    'x-kernel-kid': kid,
    'x-kernel-signature': sign(null, Buffer.from(payload), options.privateKey ?? keypair.privateKey).toString('hex'),
  } });
}
const call = (body: unknown) => POST(signedRequest(JSON.stringify(body)));

const allEnrollments = () => db.select().from(enrollments);

/** A published $50.00 CAD course with one module and two lessons. */
async function seedPaidCourse() {
  await seedCourse({ price: 5000, currency: 'CAD' });
  await seedModule();
  await seedLesson('mod_1', 'lsn_1', 0);
  await seedLesson('mod_1', 'lsn_2', 1);
}

beforeEach(() => {
  vi.stubEnv('IMAJIN_APP_DID', APP_DID);
  kernel.respond.set('/.well-known/kernel-signing-key', () => Response.json({
    current: kid,
    keys: [{ kid, publicKey, algorithm: 'Ed25519', validFrom: '2020-01-01T00:00:00.000Z' }],
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('POST /api/webhook — authentication', () => {
  beforeEach(async () => {
    await seedPaidCourse();
  });

  async function expectRejected(request: ReturnType<typeof makeRequest>) {
    const select = vi.spyOn(db, 'select');
    const transaction = vi.spyOn(db, 'transaction');
    const res = await POST(request);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(select).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(kernel.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(await allEnrollments()).toHaveLength(0);
    expect(await db.select().from(lessonProgress)).toHaveLength(0);
  }

  it.each(['x-kernel-audience', 'x-kernel-timestamp', 'x-kernel-nonce', 'x-kernel-kid', 'x-kernel-signature'])(
    'rejects a missing %s header before any business effects', async (header) => {
      const request = signedRequest(JSON.stringify(paidBody()));
      request.headers.delete(header);
      await expectRejected(request);
    },
  );

  it('rejects unsigned requests including a legacy bearer', async () => {
    await expectRejected(makeRequest('POST', '/api/webhook', {
      body: paidBody(), headers: { authorization: 'Bearer OBVIOUSLY_FAKE_RETIRED_CREDENTIAL' },
    }));
  });

  it('authenticates before parsing malformed JSON', async () => {
    await expectRejected(makeRequest('POST', '/api/webhook', { rawBody: '{not json' }));
  });

  it('rejects tampered raw bytes (even equivalent JSON)', async () => {
    const raw = JSON.stringify(paidBody());
    const request = signedRequest(raw);
    await expectRejected(makeRequest('POST', '/api/webhook', {
      headers: Object.fromEntries(request.headers), rawBody: `${raw}\n`,
    }));
  });

  it('rejects a well-formed but corrupted signature', async () => {
    const request = signedRequest(JSON.stringify(paidBody()));
    request.headers.set('x-kernel-signature', '00'.repeat(64));
    await expectRejected(request);
  });

  it('rejects a signature made by another key', async () => {
    await expectRejected(signedRequest(JSON.stringify(paidBody()), {
      privateKey: generateKeyPairSync('ed25519').privateKey,
    }));
  });

  it('rejects an unpublished key id', async () => {
    const request = signedRequest(JSON.stringify(paidBody()));
    request.headers.set('x-kernel-kid', 'auth-0000000000000000');
    await expectRejected(request);
  });

  it('rejects a valid signature intended for another app', async () => {
    await expectRejected(signedRequest(JSON.stringify(paidBody()), { audience: 'did:imajin:another-app' }));
  });

  it('rejects a signature forwarded to a different path or query', async () => {
    const request = signedRequest(JSON.stringify(paidBody()), { path: '/other?target=learn' });
    await expectRejected(makeRequest('POST', '/api/webhook', {
      headers: Object.fromEntries(request.headers), body: paidBody(),
    }));
  });

  it.each([-301, 301])('rejects a timestamp %s seconds from now', async (offset) => {
    await expectRejected(signedRequest(JSON.stringify(paidBody()), {
      timestamp: Math.floor(Date.now() / 1000) + offset,
    }));
  });

  it.each(['IMAJIN_APP_DID', 'AUTH_SERVICE_URL'])('fails closed without %s', async (name) => {
    vi.stubEnv(name, '');
    await expectRejected(signedRequest(JSON.stringify(paidBody())));
  });

  it('rejects a consumed nonce with no database access or progress reset', async () => {
    const request = signedRequest(JSON.stringify(paidBody()));
    const replay = request.clone();
    expect((await POST(request)).status).toBe(201);
    await db.update(lessonProgress).set({ status: 'completed' });
    const select = vi.spyOn(db, 'select');
    const transaction = vi.spyOn(db, 'transaction');
    expect((await POST(replay as typeof request)).status).toBe(401);
    expect(select).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(await allEnrollments()).toHaveLength(1);
    expect((await db.select().from(lessonProgress)).map((p) => p.status)).toEqual(['completed', 'completed']);
  });

  it('accepts a signature over the deployed mount path', async () => {
    expect((await POST(signedRequest(JSON.stringify(paidBody()), { path: '/learn/api/webhook' }))).status).toBe(201);
  });
});

describe('POST /api/webhook — paid checkout enrolls', () => {
  beforeEach(async () => {
    await seedPaidCourse();
  });

  it('creates the enrollment, records the payment, and seeds not_started progress for every lesson', async () => {
    const res = await call(paidBody());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ received: true, enrolled: true, created: true });
    expect(json.enrollmentId).toMatch(/^enr_/);

    const rows = await allEnrollments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: json.enrollmentId,
      courseId: 'crs_1',
      studentDid: STUDENT,
      paymentId: 'pi_test_1',
    });

    const progress = await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, json.enrollmentId));
    expect(progress.map((p) => [p.lessonId, p.status]).sort()).toEqual([
      ['lsn_1', 'not_started'],
      ['lsn_2', 'not_started'],
    ]);
  });

  it('falls back to the Stripe session id as the payment id', async () => {
    await call(paidBody({ paymentId: undefined }));
    expect((await allEnrollments())[0]?.paymentId).toBe('cs_test_1');
  });

  it('accepts a payment above the price (tax lines) and a lower-case currency', async () => {
    const res = await call(paidBody({}, { amount: 5650, currency: 'cad' }));
    expect(res.status).toBe(201);
  });

  it.each([
    ['status: paid', { type: undefined, status: 'paid' }],
    ['status: succeeded', { type: undefined, status: 'succeeded' }],
  ])('treats %s as a successful payment', async (_label, overrides) => {
    expect((await call(paidBody(overrides))).status).toBe(201);
  });

  it('enrolls in a course with no lessons yet', async () => {
    await seedCourse({ id: 'crs_empty', slug: 'empty', price: 5000 });
    const res = await call(paidBody({}, { courseId: 'crs_empty' }));
    expect(res.status).toBe(201);
    expect(await db.select().from(lessonProgress).where(eq(lessonProgress.enrollmentId, (await res.json()).enrollmentId))).toHaveLength(0);
  });

  it('enrolls in a course that was archived after the learner paid', async () => {
    await db.update(courses).set({ status: 'archived' });
    expect((await call(paidBody())).status).toBe(201);
  });
});

describe('POST /api/webhook — freshly signed redelivery is idempotent', () => {
  beforeEach(async () => {
    await seedPaidCourse();
  });

  it('a redelivered notification returns the existing enrollment and creates nothing', async () => {
    const first = await (await call(paidBody())).json();
    const replayRes = await call(paidBody());
    expect(replayRes.status).toBe(200);
    const replay = await replayRes.json();

    expect(replay).toMatchObject({ received: true, enrolled: true, created: false, enrollmentId: first.enrollmentId });
    expect(await allEnrollments()).toHaveLength(1);
    expect(await db.select().from(lessonProgress)).toHaveLength(2);
  });

  it('a replay does not reset progress the learner already made', async () => {
    const first = await (await call(paidBody())).json();
    await db
      .update(lessonProgress)
      .set({ status: 'completed' })
      .where(eq(lessonProgress.enrollmentId, first.enrollmentId));

    await call(paidBody());

    const statuses = (await db.select().from(lessonProgress)).map((p) => p.status);
    expect(statuses).toEqual(['completed', 'completed']);
  });

  it('two deliveries racing each other still enroll once', async () => {
    const [a, b] = await Promise.all([call(paidBody()), call(paidBody())]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await allEnrollments()).toHaveLength(1);
    expect(await db.select().from(lessonProgress)).toHaveLength(2);
  });

  it('keeps the original payment id when a different payment replays for the same student', async () => {
    await call(paidBody());
    await call(paidBody({ paymentId: 'pi_second' }));
    expect((await allEnrollments())[0]?.paymentId).toBe('pi_test_1');
  });

  it('enrolls a second student independently', async () => {
    await call(paidBody());
    expect((await call(paidBody({}, { studentDid: OTHER }))).status).toBe(201);
    expect(await allEnrollments()).toHaveLength(2);
  });
});

describe('POST /api/webhook — what must not enroll', () => {
  beforeEach(async () => {
    await seedPaidCourse();
  });

  it('acknowledges but ignores an event that is not a successful payment', async () => {
    const res = await call(paidBody({ type: 'payment.failed' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, enrolled: false });
    expect(await allEnrollments()).toHaveLength(0);
  });

  it.each([
    ['a platform-collected payment (no rail)', { rail: undefined }],
    ['another rail', { rail: 'stripe' }],
  ])('acknowledges but does not enroll for %s', async (_label, overrides) => {
    const res = await call(paidBody(overrides));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, enrolled: false });
    expect(await allEnrollments()).toHaveLength(0);
  });

  it("refuses (403) a payment that was not collected on the course creator's Stripe account", async () => {
    const res = await call(paidBody({ sellerDid: 'did:imajin:attacker' }));
    expect(res.status).toBe(403);
    expect(await allEnrollments()).toHaveLength(0);
  });

  it('refuses (403) when the kernel attested no seller at all', async () => {
    const res = await call(paidBody({ sellerDid: undefined }));
    expect(res.status).toBe(403);
    expect(await allEnrollments()).toHaveLength(0);
  });

  it('does not trust a seller DID the checkout caller put in metadata', async () => {
    const res = await call(paidBody({ sellerDid: 'did:imajin:attacker' }, { sellerDid: CREATOR }));
    expect(res.status).toBe(403);
    expect(await allEnrollments()).toHaveLength(0);
  });

  it.each([
    ['underpaid', { amount: 4999 }],
    ['a different currency', { currency: 'USD' }],
    ['no currency', { currency: undefined }],
    ['no amount', { amount: undefined }],
    ['a string amount', { amount: '5000' }],
  ])('refuses (422) a payment that does not cover the price: %s', async (_label, metadata) => {
    const res = await call(paidBody({}, metadata));
    expect(res.status).toBe(422);
    expect(await allEnrollments()).toHaveLength(0);
  });

  it('404s a course that does not exist', async () => {
    const res = await call(paidBody({}, { courseId: 'crs_missing' }));
    expect(res.status).toBe(404);
    expect(await allEnrollments()).toHaveLength(0);
  });

  it.each([
    ['no courseId', { courseId: undefined }],
    ['no studentDid', { studentDid: undefined }],
    ['an empty courseId', { courseId: '' }],
    ['a non-string studentDid', { studentDid: 42 }],
  ])('400s a payment with %s', async (_label, metadata) => {
    const res = await call(paidBody({}, metadata));
    expect(res.status).toBe(400);
    expect(await allEnrollments()).toHaveLength(0);
  });

  it('400s a payment with no metadata at all', async () => {
    expect((await call(paidBody({ metadata: undefined }))).status).toBe(400);
  });

  it('400s malformed JSON and a non-object body', async () => {
    const malformed = await POST(signedRequest('{not json'));
    expect(malformed.status).toBe(400);
    expect((await call([1, 2, 3])).status).toBe(400);
    expect((await call(null)).status).toBe(400);
    expect((await call('not an object')).status).toBe(400);
  });

  it('answers 500 when enrolling fails, leaving nothing half-written', async () => {
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('connection lost'));
    const res = await call(paidBody());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Webhook processing failed' });
    expect(await allEnrollments()).toHaveLength(0);
  });
});

describe('POST /api/webhook — a free course', () => {
  it('enrolls without needing an amount (nothing to cover)', async () => {
    await seedCourse({ price: 0 });
    const res = await call(paidBody({}, { amount: undefined, currency: undefined }));
    expect(res.status).toBe(201);
  });

  it('treats a course with no currency as CAD', async () => {
    await seedCourse({ price: 5000, currency: null });
    expect((await call(paidBody())).status).toBe(201);
    expect((await call(paidBody({}, { studentDid: OTHER, currency: 'USD' }))).status).toBe(422);
  });
});
