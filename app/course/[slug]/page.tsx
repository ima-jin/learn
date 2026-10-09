/* eslint-disable @next/next/no-img-element -- creator-supplied image URLs are arbitrary remote origins, which next/image cannot optimise without a per-origin allow-list */
'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { SignInToEnroll } from '@/components/SignInToEnroll';
import { useToast } from '@ima-jin/ui';
import { buildPublicUrl } from '@ima-jin/config';
import { learnFetch } from '@/lib/api-client';
import { CREATOR_NO_CARD_RAIL_MESSAGE, NO_CARD_RAIL_MESSAGE, SELLER_NO_CARD_RAIL } from '@/lib/card-rail';

interface Lesson {
  id: string;
  title: string;
  contentType: string;
  durationMinutes: number | null;
  sortOrder: number;
}

interface Module {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  lessons: Lesson[];
}

interface Course {
  id: string;
  title: string;
  description: string | null;
  slug: string;
  price: number;
  currency: string;
  creatorDid: string;
  imageUrl: string | null;
  tags: string[];
  status: string;
  eventSlug: string | null;
  courseType: string | null;
  modules: Module[];
  enrollment: {
    id: string;
    enrolledAt: string;
    progress: { total: number; completed: number };
  } | null;
  isCreator: boolean;
  isAuthenticated: boolean;
}

interface UpcomingEvent {
  id: string;
  title: string;
  startsAt: string;
}

/**
 * After paying, the learner lands back here (`?paid=1`) while the kernel's notification is still creating
 * the enrollment. Poll for it briefly so they see "Start Learning" instead of an Enroll button — and so
 * they don't pay twice.
 */
const PAID_POLL_INTERVAL_MS = 2000;
const PAID_POLL_ATTEMPTS = 15;

type PaidState = 'idle' | 'waiting' | 'delayed';

/** The course as the caller currently sees it, or null when it cannot be read right now. */
async function fetchCourse(slug: string): Promise<Course | null> {
  try {
    const res = await learnFetch(`/api/courses/${slug}`, { credentials: 'include' });
    return res.ok ? ((await res.json()) as Course) : null;
  } catch {
    return null;
  }
}

const contentTypeIcons: Record<string, string> = {
  markdown: '📝',
  exercise: '🛠️',
  slide: '📊',
  video: '🎬',
};

/**
 * Can the course creator take a card payment? Pay's public card-rail check (#2757, replacing the
 * removed `/api/connect/check`): true when the creator has connected their own Stripe key.
 */
async function resolveCourseSellerConnected(price: number, creatorDid: string | null | undefined): Promise<boolean> {
  if (!(price > 0 && creatorDid)) return true;
  try {
    const payUrl = buildPublicUrl('pay');
    const railRes = await fetch(
      `${payUrl}/api/card-rail/check?did=${encodeURIComponent(creatorDid)}`
    );
    if (!railRes.ok) return false;
    const railData = await railRes.json();
    return railData.cardEnabled ?? false;
  } catch {
    // Default to connected on error
    return true;
  }
}

async function fetchUpcomingCourseEvent(slug: string): Promise<UpcomingEvent | null> {
  try {
    const eventsUrl = buildPublicUrl('events');
    const evRes = await fetch(`${eventsUrl}/api/events?courseSlug=${encodeURIComponent(slug)}&upcoming=true&limit=1`);
    if (!evRes.ok) return null;
    const evData = await evRes.json();
    return evData.events?.[0] ?? null;
  } catch {
    // silently ignore — banner is non-critical
    return null;
  }
}

export default function CourseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { toast } = useToast();
  const slug = params.slug as string;

  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [upcomingEvent, setUpcomingEvent] = useState<UpcomingEvent | null>(null);
  const [sellerConnected, setSellerConnected] = useState(true);
  const [paidState, setPaidState] = useState<PaidState>('idle');

  useEffect(() => {
    async function load() {
      try {
        const res = await learnFetch(`/api/courses/${slug}`, { credentials: 'include' });
        if (!res.ok) return;

        const data = await res.json();
        setCourse(data);

        // Check if the course creator has a card rail (their own connected Stripe key)
        setSellerConnected(await resolveCourseSellerConnected(data.price, data.creatorDid));

        // Fetch next upcoming event for this course
        setUpcomingEvent(await fetchUpcomingCourseEvent(data.slug));
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [slug]);

  // Back from a successful payment: wait for the kernel's notification to create the enrollment.
  const courseLoaded = course !== null;
  const alreadyEnrolled = Boolean(course?.enrollment);
  useEffect(() => {
    const paid = new URLSearchParams(globalThis.location.search).get('paid') === '1';
    if (!paid || !courseLoaded || alreadyEnrolled) {
      setPaidState('idle');
      return;
    }

    setPaidState('waiting');
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      void fetchCourse(slug).then((fresh) => {
        if (fresh) setCourse(fresh);
      });
      if (attempts >= PAID_POLL_ATTEMPTS) {
        clearInterval(timer);
        setPaidState('delayed');
      }
    }, PAID_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [slug, courseLoaded, alreadyEnrolled]);

  // Auto-enroll after onboard email verification redirect
  useEffect(() => {
    if (!course || course.enrollment || enrolling) return;
    const params = new URLSearchParams(globalThis.location.search);
    if (params.get('enroll') === '1') {
      globalThis.history.replaceState({}, '', `/course/${slug}`);
      void handleEnroll();
    }
  // Runs once the course has loaded (keyed on `course` only) — re-running on every
  // `enrolling` change would fire the auto-enroll twice.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course]);

  // Auto-redirect to presentation mode for decks
  const isDeck = course?.courseType === 'deck';
  useEffect(() => {
    if (!course || !isDeck) return;
    if (course.enrollment && !course.isCreator) {
      router.replace(`/course/${slug}/present`);
    }
  }, [course, isDeck, router, slug]);

  async function handleEnroll() {
    if (!course) return;
    setEnrolling(true);
    try {
      const res = await learnFetch(`/api/courses/${slug}/enroll`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // No successUrl / cancelUrl: the server sends the learner back to this page (base path included).
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        const err = await res.json();
        if (err.code === SELLER_NO_CARD_RAIL) {
          // The creator has no card rail: hide the enroll button; the plain message takes its place.
          setSellerConnected(false);
          return;
        }
        toast.error(err.error || 'Enrollment failed');
        return;
      }

      const data = await res.json();
      if (data.checkoutUrl) {
        globalThis.location.href = data.checkoutUrl;
      } else if (isDeck) {
        // Free deck enrollment — go straight to presentation
        router.push(`/course/${slug}/present`);
      } else {
        // Free enrollment — reload
        globalThis.location.reload();
      }
    } catch (e) {
      console.error('Enrollment failed:', e);
      toast.error('Enrollment failed');
    } finally {
      setEnrolling(false);
    }
  }

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Loading...</div>;
  if (!course) return <div className="container mx-auto px-4 py-16 text-center text-gray-500">Course not found</div>;

  const totalDuration = course.modules.reduce(
    (sum, m) => sum + m.lessons.reduce((s, l) => s + (l.durationMinutes || 0), 0), 0
  );
  const totalLessons = course.modules.reduce((sum, m) => sum + m.lessons.length, 0);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          {course.imageUrl && (
            <div className="aspect-video rounded-xl overflow-hidden mb-6 bg-gray-100 dark:bg-gray-800">
              <img src={course.imageUrl} alt={course.title} className="w-full h-full object-cover" />
            </div>
          )}

          <h1 className="text-3xl font-bold mb-3">{course.title}</h1>
          {course.description && (
            <p className="text-lg text-gray-600 dark:text-gray-400 mb-4">{course.description}</p>
          )}

          <div className="flex flex-wrap gap-4 text-sm text-gray-500 mb-6">
            <span>{course.modules.length} modules</span>
            <span>·</span>
            <span>{totalLessons} lessons</span>
            {totalDuration > 0 && (
              <>
                <span>·</span>
                <span>{totalDuration} min total</span>
              </>
            )}
          </div>

          {course.tags?.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-6">
              {course.tags.map((tag: string) => (
                <span key={tag} className="px-3 py-1 text-sm rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3">
            {/* Present button — only shown if course has slide lessons */}
            {course.modules.some((m: Module) => m.lessons.some((l: Lesson) => l.contentType === 'slide')) && (
              course.isCreator || course.enrollment
            ) && (
              <Link
                href={`/course/${course.slug}/present`}
                className="px-6 py-3 bg-gray-800 text-white rounded-lg hover:bg-gray-700 font-medium border border-gray-700"
              >
                ▶ Present
              </Link>
            )}
            {course.isCreator && course.price > 0 && !sellerConnected && (
              <p className="w-full text-sm text-yellow-600 dark:text-yellow-400">
                {CREATOR_NO_CARD_RAIL_MESSAGE}
              </p>
            )}
            {(() => {
              const enrollButtonText = (() => {
                if (enrolling) return 'Loading...';
                if (course.price === 0) return isDeck ? '▶ View Presentation' : 'Start Learning — Free';
                return `Enroll — $${(course.price / 100).toFixed(2)}`;
              })();
              if (course.isCreator) return (
              <Link
                href={`/dashboard/${course.slug}`}
                className="px-6 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium"
              >
                Edit Course
              </Link>
              );
              if (course.enrollment) return (
              <Link
                href={isDeck ? `/course/${course.slug}/present` : `/course/${course.slug}/${course.modules[0]?.lessons[0]?.id || ''}`}
                className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium"
              >
                {isDeck ? '▶ View Presentation' : (
                  <>
                    {course.enrollment.progress.completed > 0 ? 'Continue Learning' : 'Start Learning'}
                    {course.enrollment.progress.total > 0 && (
                      <span className="ml-2 text-sm opacity-80">
                        ({Math.round((course.enrollment.progress.completed / course.enrollment.progress.total) * 100)}%)
                      </span>
                    )}
                  </>
                )}
              </Link>
              );
              if (paidState !== 'idle') return (
              <p className="text-sm text-gray-600 dark:text-gray-300 px-1" role="status">
                {paidState === 'waiting'
                  ? 'Payment received — setting up your enrollment…'
                  : 'Your payment went through, but your enrollment is taking longer than usual. Refresh in a minute, or contact the course creator if it does not appear.'}
              </p>
              );
              if (course.price > 0 && !sellerConnected) return (
              <p className="text-sm text-gray-500 italic px-1">
                {NO_CARD_RAIL_MESSAGE}
              </p>
              );
              if (course.isAuthenticated) return (
              <button type="button"
                onClick={handleEnroll}
                disabled={enrolling}
                className="px-6 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium disabled:opacity-50"
              >
                {enrollButtonText}
              </button>
              );
              return (
              <SignInToEnroll className="inline-block px-6 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium">
                {enrollButtonText}
              </SignInToEnroll>
              );
            })()}
          </div>
        </div>

        {/* Upcoming event banner — dynamically fetched from events service */}
        {upcomingEvent && (
          <div className="mb-8 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-5 flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-amber-900 dark:text-amber-200">🎓 Next session: {upcomingEvent.title}</p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                {new Date(upcomingEvent.startsAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
            <a
              href={`${buildPublicUrl('events')}/${upcomingEvent.id}`}
              className="shrink-0 px-5 py-2.5 bg-amber-500 text-white rounded-lg hover:bg-amber-600 font-medium text-sm no-underline"
            >
              Get tickets →
            </a>
          </div>
        )}

        {/* Course outline */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Course Outline</h2>
          {course.modules.map((mod, i) => (
            <div key={mod.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
                <h3 className="font-medium">
                  <span className="text-gray-400 mr-2">Module {i + 1}</span>
                  {mod.title}
                </h3>
                {mod.description && <p className="text-sm text-gray-500 mt-1">{mod.description}</p>}
              </div>
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {mod.lessons.map((lesson) => (
                  <li key={lesson.id} className="px-5 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span>{contentTypeIcons[lesson.contentType] || '📄'}</span>
                      {course.enrollment ? (
                        <Link
                          href={`/course/${course.slug}/${lesson.id}`}
                          className="hover:text-amber-500"
                        >
                          {lesson.title}
                        </Link>
                      ) : (
                        <span>{lesson.title}</span>
                      )}
                    </div>
                    {lesson.durationMinutes && (
                      <span className="text-xs text-gray-400">{lesson.durationMinutes} min</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
