import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { courses, db } from '@/db';
import { CREATOR, OTHER, makeRequest, seedCourse, seedLesson, seedModule } from '@test/helpers';
import { AUTH_URL, installFakeKernel } from '@test/kernel';
import { GET, POST } from '../route';

const kernel = installFakeKernel();

describe('POST /api/courses', () => {
  it('rejects anonymous callers with 401', async () => {
    const res = await POST(makeRequest('POST', '/api/courses', { body: { title: 'X' } }));
    expect(res.status).toBe(401);
  });

  it('rejects a token that fails verification (and has no cookie) with 401', async () => {
    const res = await POST(makeRequest('POST', '/api/courses', { headers: { authorization: 'Bearer nope' }, body: { title: 'X' } }));
    expect(res.status).toBe(401);
  });

  it('verifies the token against this app\'s own host as audience', async () => {
    await POST(makeRequest('POST', '/api/courses', { did: CREATOR, body: { title: 'X' } }));
    const verify = kernel.calls.find((c) => c.url === `${AUTH_URL}/api/tokens/app/verify`);
    expect(verify?.body).toMatchObject({ aud: 'learn' });
  });

  it('requires a title', async () => {
    const res = await POST(makeRequest('POST', '/api/courses', { did: CREATOR, body: { title: '   ' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Title is required' });
  });

  it('answers 400 on malformed JSON instead of crashing', async () => {
    const res = await POST(makeRequest('POST', '/api/courses', { did: CREATOR, rawBody: '{nope' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
  });

  it('rejects a body that is not a JSON object', async () => {
    const res = await POST(makeRequest('POST', '/api/courses', { did: CREATOR, rawBody: '[1]' }));
    expect(res.status).toBe(400);
  });

  it('creates a draft course owned by the caller, slugified, with a .fair manifest', async () => {
    const res = await POST(makeRequest('POST', '/api/courses', {
      did: CREATOR,
      body: { title: '  Intro to AI!  ', description: ' hello ', tags: ['ai'], metadata: { a: 1 } },
    }));
    expect(res.status).toBe(201);
    const course = await res.json();
    expect(course).toMatchObject({
      creatorDid: CREATOR,
      title: 'Intro to AI!',
      description: 'hello',
      slug: 'intro-to-ai',
      price: 0,
      currency: 'CAD',
      visibility: 'public',
      status: 'draft',
      tags: ['ai'],
    });
    expect(course.id).toMatch(/^crs_/);
    expect(course.metadata.a).toBe(1);
    expect(course.metadata.fair).toBeTruthy();
    expect(JSON.stringify(course.metadata.fair)).toContain(CREATOR);

    const [row] = await db.select().from(courses).where(eq(courses.id, course.id));
    expect(row.creatorDid).toBe(CREATOR);
  });

  it('still creates the course when the registry node/self lookup fails', async () => {
    kernel.nodeSelf = null;
    const res = await POST(makeRequest('POST', '/api/courses', { did: CREATOR, body: { title: 'No Node' } }));
    expect(res.status).toBe(201);
  });

  it('honours an explicit slug, price, currency and visibility', async () => {
    const res = await POST(makeRequest('POST', '/api/courses', {
      did: CREATOR,
      body: { title: 'T', slug: ' custom ', price: 5000, currency: 'USD', visibility: 'private', imageUrl: 'u', imageAssetId: 'a' },
    }));
    expect(await res.json()).toMatchObject({
      slug: 'custom', price: 5000, currency: 'USD', visibility: 'private', imageUrl: 'u', imageAssetId: 'a',
    });
  });

  it('answers 409 when the slug is taken', async () => {
    await seedCourse();
    const res = await POST(makeRequest('POST', '/api/courses', { did: CREATOR, body: { title: 'Intro' } }));
    expect(res.status).toBe(409);
  });
});

describe('GET /api/courses', () => {
  it('lists only published public courses by default, with counts, newest first', async () => {
    await seedCourse({ id: 'crs_a', slug: 'a', createdAt: new Date('2026-01-01') });
    await seedCourse({ id: 'crs_b', slug: 'b', createdAt: new Date('2026-02-01') });
    await seedCourse({ id: 'crs_draft', slug: 'draft', status: 'draft' });
    await seedCourse({ id: 'crs_priv', slug: 'priv', visibility: 'private' });
    await seedModule('crs_a', 'mod_a');
    await seedLesson('mod_a', 'lsn_a1', 0);
    await seedLesson('mod_a', 'lsn_a2', 1);

    const res = await GET(makeRequest('GET', '/api/courses'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
    expect(body.courses.map((c: { id: string }) => c.id)).toEqual(['crs_b', 'crs_a']);
    const a = body.courses.find((c: { id: string }) => c.id === 'crs_a');
    expect(a).toMatchObject({ moduleCount: 1, lessonCount: 2 });
  });

  it('shows every visibility for one creator, and can filter by status', async () => {
    await seedCourse({ id: 'crs_a', slug: 'a' });
    await seedCourse({ id: 'crs_priv', slug: 'priv', visibility: 'private' });
    await seedCourse({ id: 'crs_o', slug: 'o', creatorDid: OTHER });
    await seedCourse({ id: 'crs_d', slug: 'd', status: 'draft' });

    const mine = await (await GET(makeRequest('GET', `/api/courses?creator_did=${CREATOR}`))).json();
    expect(mine.courses.map((c: { id: string }) => c.id).sort()).toEqual(['crs_a', 'crs_priv']);

    const drafts = await (await GET(makeRequest('GET', '/api/courses?status=draft'))).json();
    expect(drafts.courses.map((c: { id: string }) => c.id)).toEqual(['crs_d']);
  });

  it('paginates and clamps limit/offset, tolerating garbage', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedCourse({ id: `crs_${i}`, slug: `s${i}`, createdAt: new Date(2026, 0, i + 1) });
    }
    const page = await (await GET(makeRequest('GET', '/api/courses?limit=1&offset=1'))).json();
    expect(page).toMatchObject({ limit: 1, offset: 1 });
    expect(page.courses.map((c: { id: string }) => c.id)).toEqual(['crs_1']);

    const clamped = await (await GET(makeRequest('GET', '/api/courses?limit=9999&offset=-4'))).json();
    expect(clamped).toMatchObject({ limit: 100, offset: 0 });

    const garbage = await (await GET(makeRequest('GET', '/api/courses?limit=abc&offset=xyz'))).json();
    expect(garbage).toMatchObject({ limit: 20, offset: 0 });
  });
});
