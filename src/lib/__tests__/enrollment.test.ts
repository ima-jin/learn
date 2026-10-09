import { describe, expect, it } from 'vitest';
import { db, enrollments, lessonProgress } from '@/db';
import { STUDENT, OTHER, seedCourse, seedLesson, seedModule, seedTree } from '@test/helpers';
import { installFakeKernel } from '@test/kernel';
import { enrollStudent } from '../enrollment';

installFakeKernel();

describe('enrollStudent', () => {
  it('creates the enrollment and a not_started progress row for every lesson', async () => {
    await seedTree();
    await seedModule('crs_1', 'mod_2', 1);
    await seedLesson('mod_2', 'lsn_3', 0);

    const { enrollment, created } = await enrollStudent({ courseId: 'crs_1', studentDid: STUDENT, paymentId: 'pi_1' });

    expect(created).toBe(true);
    expect(enrollment).toMatchObject({ courseId: 'crs_1', studentDid: STUDENT, paymentId: 'pi_1' });
    expect(enrollment.id).toMatch(/^enr_/);
    const progress = await db.select().from(lessonProgress);
    expect(progress.map((p) => p.lessonId).sort()).toEqual(['lsn_1', 'lsn_2', 'lsn_3']);
    expect(progress.every((p) => p.status === 'not_started')).toBe(true);
  });

  it('stores a null payment id for a free enrollment and tolerates a course with no lessons', async () => {
    await seedCourse();
    const { enrollment } = await enrollStudent({ courseId: 'crs_1', studentDid: STUDENT, paymentId: null });
    expect(enrollment.paymentId).toBeNull();
    expect(await db.select().from(lessonProgress)).toHaveLength(0);
  });

  it('is idempotent: a second call returns the existing enrollment and writes nothing', async () => {
    await seedTree();
    const first = await enrollStudent({ courseId: 'crs_1', studentDid: STUDENT, paymentId: 'pi_1' });
    const second = await enrollStudent({ courseId: 'crs_1', studentDid: STUDENT, paymentId: 'pi_2' });

    expect(second.created).toBe(false);
    expect(second.enrollment.id).toBe(first.enrollment.id);
    expect(second.enrollment.paymentId).toBe('pi_1');
    expect(await db.select().from(enrollments)).toHaveLength(1);
    expect(await db.select().from(lessonProgress)).toHaveLength(2);
  });

  it('enrolls concurrent callers once', async () => {
    await seedTree();
    const results = await Promise.all([
      enrollStudent({ courseId: 'crs_1', studentDid: STUDENT, paymentId: null }),
      enrollStudent({ courseId: 'crs_1', studentDid: STUDENT, paymentId: null }),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.select().from(enrollments)).toHaveLength(1);
  });

  it('keeps students apart', async () => {
    await seedTree();
    await enrollStudent({ courseId: 'crs_1', studentDid: STUDENT, paymentId: null });
    const other = await enrollStudent({ courseId: 'crs_1', studentDid: OTHER, paymentId: null });
    expect(other.created).toBe(true);
    expect(await db.select().from(enrollments)).toHaveLength(2);
  });
});
