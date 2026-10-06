import { NextRequest } from 'next/server';
import { db, courses, enrollments, lessonProgress, lessons, modules } from '@/db';

export const CREATOR = 'did:imajin:creator';
export const STUDENT = 'did:imajin:student';
export const OTHER = 'did:imajin:other';

interface ReqOptions {
  /** Authenticate as this DID via a (fake-kernel-verified) scoped app token. */
  did?: string;
  /** Authenticate via the legacy shared session cookie instead of an app token. */
  cookieDid?: string;
  body?: unknown;
  /** Raw body text, to send malformed JSON. */
  rawBody?: string;
  headers?: Record<string, string>;
}

export function makeRequest(method: string, path: string, options: ReqOptions = {}): NextRequest {
  const headers: Record<string, string> = { ...options.headers };
  if (options.did) headers.authorization = `Bearer tok:${options.did}`;
  if (options.cookieDid) headers.cookie = `imajin_session=good:${options.cookieDid}`;
  let body: string | undefined = options.rawBody;
  if (body === undefined && options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  return new NextRequest(`https://learn.test${path}`, { method, headers, body });
}

export function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

export async function seedCourse(overrides: Partial<typeof courses.$inferInsert> = {}) {
  const course = {
    id: 'crs_1',
    creatorDid: CREATOR,
    title: 'Intro',
    slug: 'intro',
    price: 0,
    visibility: 'public',
    status: 'published',
    ...overrides,
  };
  await db.insert(courses).values(course);
  return course;
}

export async function seedModule(courseId = 'crs_1', id = 'mod_1', sortOrder = 0) {
  await db.insert(modules).values({ id, courseId, title: `Module ${id}`, sortOrder });
  return id;
}

export async function seedLesson(moduleId = 'mod_1', id = 'lsn_1', sortOrder = 0) {
  await db.insert(lessons).values({
    id,
    moduleId,
    title: `Lesson ${id}`,
    content: `# ${id} body`,
    metadata: { secret: true },
    sortOrder,
  });
  return id;
}

export async function seedEnrollment(courseId = 'crs_1', studentDid = STUDENT, id = 'enr_1') {
  await db.insert(enrollments).values({ id, courseId, studentDid });
  return id;
}

export async function seedProgress(enrollmentId: string, lessonId: string, status = 'not_started') {
  await db.insert(lessonProgress).values({ enrollmentId, lessonId, status });
}

/** A published free course with 1 module and 2 lessons. */
export async function seedTree() {
  await seedCourse();
  await seedModule();
  await seedLesson('mod_1', 'lsn_1', 0);
  await seedLesson('mod_1', 'lsn_2', 1);
}
