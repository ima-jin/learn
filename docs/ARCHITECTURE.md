# Architecture — Learn

> This app is a **lens** over the user's signed records. It owns no authoritative state. See `AGENTS.md` §1–§3.

## The three-tier projection model

| Tier | What | Owns truth? |
|------|------|-------------|
| **User's signed records** | signed markdown/attestations on the user's per-DID path (hosted now, user-held vault later) | ✅ source of truth |
| **Kernel domain core** | domain events / stage tables / settlement primitive | ❌ derived projection |
| **Connectors** | user-selected services (QuickBooks, …) feeding the user's records | ❌ user's instruments |
| **This app** | render + gesture UX + connector-select | ❌ a lens |

## Integration contract

External client only — app-auth headers (`X-App-DID` + `X-App-Authorization`) → kernel returns
`{ appDid, userDid, scopes }`. No `workspace:*` deps, no monorepo internals, no DB, no in-process bus. Published
`@ima-jin/*` SDK packages (npmjs.org, no auth needed) are fine — see `AGENTS.md` §2. Domain events are emitted by calling the
kernel's app-auth-gated domain API.

## Deploy convention

Each fork deploys as its own pm2 ecosystem entry behind a Caddy route (`Host` header → this app's port), the same
shape as every other app on the platform. Neither pm2 config nor the Caddy route is copied from the monorepo — the
monorepo's `deploy-dev.yml`/`deploy-prod.yml` assume shared infra (self-hosted runners, its own secrets) that doesn't
transfer to a standalone fork. Wire your own deploy workflow against your fork's runner/secrets when you're ready to
ship; this convention only fixes the shape (one pm2 entry, one Caddy route) so it stays consistent across apps.

## The loop this app instruments

A creator publishes a course (modules → lessons). A student enrolls — free, or paid through the kernel's pay service
(`POST {pay}/api/checkout`, the seller being the course creator) — and completes lessons one by one. Completing the last
lesson completes the course. Enrollment and completion are the record: each is emitted as a signed attestation
(`learn.enrolled`, `learn.completed`) through the kernel's public attestation API, delegated by the student.

## Auth: the registered-app contract, end to end

- **Server routes** call `authenticate()` / `authenticateOptional()` (`src/lib/auth/authenticate.ts`) — one wrapper around
  `requireSessionOrAppToken`. A scoped app token (`Authorization: Bearer`) is verified by the kernel for **this app's host
  as `aud`**; a token minted for another app is rejected. The kernel session cookie is accepted only as the migration
  fallback and carries no scopes. A caller is a single DID.
- **Browser pages** call the API through `learnFetch()` (`src/lib/api-client.ts`), which mints a short-lived app token
  from the visitor's kernel session and sends it as a bearer (anonymous when there is no session).
- **Domain events** go out through `submitDelegatedAttestation` with the caller's token and this app's own signing key
  (`loadAppSigningKey()` at boot). No in-process bus, no kernel secret.

## Parity with the in-monorepo `apps/learn`

Every route (`/api/courses/**`, `/api/my/*`, health, spec) and page (`/`, `/[handle]`, `/course/**`, `/dashboard/**`)
is ported with the same URLs, request/response shapes and status codes. Differences, all forced by the app-token
contract or fixes to defects in the original:

- **No act-as / tier.** The app-token contract carries only a DID, so `X-Acting-As` group identity (and the .fair
  scope-fee lookup that depended on it) and the soft-vs-hard-DID gate on writes are gone — callers always act as
  themselves. Tracked kernel-side: ima-jin/imajin-ai#2639 (act-as), #2640 (tier).
- **Delegation policy.** `DELETE` on a course, module and lesson (`learn.course.delete`, `learn.module.delete`,
  `learn.lesson.delete`) runs the published `@ima-jin/auth/delegation-policy` helper (`src/lib/auth/delegation.ts`,
  imajin-ai#2360): an agent acting under `X-Acting-For` gets 403 `AGENT_APPROVAL_REQUIRED` — it may propose, the
  owner countersigns. The app-token result does not surface `actingFor` yet (SDK gap), so the hook is wired but only
  fires once `authenticate()` populates `AuthenticatedCaller.actingFor`.
- **Token audience is the slug.** Scoped app tokens are minted and verified with `aud = 'learn'` (imajin-ai#2706),
  required by `@ima-jin/auth` >= 0.8.15.
- **Student emails are not released.** The roster resolves handle/display name through the kernel profile service
  *without* a service-scope credential, so `email` is always `null` (learn holds no kernel secret).
- **Events** are emitted as delegated, app-signed attestations (issuer = this app, delegator/subject = the student, the
  creator in the payload) instead of an in-process `publish()`. They only fire for token-authenticated callers who have
  granted the app the `attest:<appId>:<type>` delegation. Related: ima-jin/imajin-ai#2641.
- **`<OnboardGate>` → "Sign in with Imajin".** `@ima-jin/onboard` is not on npm (ima-jin/imajin-ai#2646).
- **No `middleware.ts`.** The kernel's `/dashboard` → hub-tab redirect and CORS pass-through are kernel-hosting
  concerns; this app serves its own dashboard.
- **Hardening** (each covered by a test): lesson/module reads, edits, deletes and reorders are scoped to the course in the
  URL (the original let a creator of *any* course edit/reorder another's lessons, and read a paid course's lesson
  content through a free course's URL); private courses' modules/lessons are hidden from non-creators like the course
  itself; paid-course lesson listings are locked like the single-lesson route; malformed JSON is a 400, not a 500;
  `limit`/`offset` tolerate garbage; PATCHing `imageUrl` / `imageAssetId` / `eventSlug` / `courseType` now actually
  persists (the original wrote snake_case keys drizzle silently ignores); the unimplemented `tag` filter is no longer
  advertised in the spec.
- **Known gap carried over, not introduced here:** a paid checkout's `successUrl` defaults to
  `/api/courses/{slug}/enroll/callback`, which has never existed in either codebase, and nothing creates the enrollment
  after payment. Out of scope for a parity port.

## Open decisions

_<Running list of design decisions still to lock.>_
