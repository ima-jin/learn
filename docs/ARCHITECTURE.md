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
- **Delegation policy (#26 / imajin-ai#2360).** Every authenticated mutation passes through
  `enforceOwnerMutationPolicy` in `authenticate()` before any course lookup or effect. Published SDK 0.8.18
  already verifies `X-Acting-For` on token and cookie paths; Learn preserves only its verified `actingFor`,
  never the raw header. Value-moving and irreversible mutations return the complete SDK 403
  `AGENT_APPROVAL_REQUIRED` proposal. The owner countersigns by reissuing from their own session; request
  body approval flags confer no authority. Unknown delegated mutations fail closed.
  The registry and three protocol exceptions live in `src/lib/auth/delegation.ts`; AST coverage discovers
  every POST/PUT/PATCH/DELETE export and proves each classified route reaches this common boundary.
  Ordinary course details, module metadata/creation and ordering are reversible. Course PATCH escalates
  price/currency/whole metadata (including .fair removal) to value-moving, and status/visibility to irreversible.
  Course creation (retained attribution record), deletes, lesson content creation/overwriting, enrollment
  and completion are irreversible. Enrollment is conservatively gated for its permanent free-enrollment and
  attestation path even though its paid branch only creates a checkout proposal.
  Webhook (kernel-signed callback), claim (one-time operator code) and logout (SDK session clearing)
  retain their own protocols, not delegated resource authority.
  **DID-resolution audit:** `authenticate()` returns the SDK's original `did` plus `actingFor`, without
  replacing `did` with the owner's DID. `requireCourseOwner` and the course PATCH/DELETE handlers still
  compare `creatorDid` to that original DID; enrollment/completion likewise use the caller DID.
  Thus delegates cannot impersonate an owner's resources here, even for reversible edits. This change
  intentionally does not broaden that authority. Policy and coverage are in place before any future
  owner-DID resolution adoption, and tests prove the ordinary ownership 403 remains.
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
- **Paid enrollment (ima-jin/learn#13).** The paid checkout's `successUrl` used to default to
  `/api/courses/{slug}/enroll/callback`, which never existed in either codebase, and nothing created the enrollment
  after payment. Now the kernel notifies `POST /api/webhook` (kernel-signed, SDK-verified, fail-closed) when
  a checkout is paid on the course creator's own Stripe account, and that creates the enrollment idempotently
  (`src/lib/enrollment.ts`). The success URL lands on the course page (`?paid=1`), which waits briefly for the
  notification instead of showing an Enroll button again. The webhook trusts the kernel-attested `sellerDid`, not
  caller-supplied checkout metadata, and checks the amount against the course price.

## Kernel webhook verification (ima-jin/learn#15)

`src/lib/auth/kernel-webhook.ts` calls the published `@ima-jin/auth/kernel-webhook` helper
`verifyKernelWebhook` before any business logic. It consumes the exact raw body once and verifies Ed25519
headers binding this app's configured `IMAJIN_APP_DID`, timestamp, nonce, method and path/query (including `/learn`
on deployed requests). It discovers active public keys through `AUTH_SERVICE_URL` and persists trust pins in
`.imajin/kernel-webhook-pins/`. No shared webhook credential is provisioned or copied.

Missing, tampered, wrong-key, wrong-recipient, expired/future and consumed-nonce requests return 401 without
reading or writing app records. Authenticated malformed JSON/non-object bodies return 400.
Discovery, trust or storage failures return 503 without business processing so the kernel can retry.
The SDK permits timestamps within ±300 seconds and rejects duplicate nonces; a kernel retry must carry a fresh signature/nonce,
and enrollment remains idempotent on (course, student).

Keep `.imajin/kernel-webhook-pins/` writable, separate per environment, and persistent across deploys; key
discovery requires HTTPS (loopback HTTP is allowed by the SDK for local development) and Linux util-linux
`flock`. The SDK's default nonce store is process-local, matching the single-process pm2 fork deployment.
It does not preserve nonce evidence across restarts or share it across replicas. Enrollment idempotency still
prevents duplicate paid enrollment, but a replicated deployment or restart-persistent replay requirement needs
an atomic shared `KernelWebhookNonceStore` before scaling.

## Open decisions

_<Running list of design decisions still to lock.>_
