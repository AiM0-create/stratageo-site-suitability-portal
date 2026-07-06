# StrataGeo Portal — Security Review (Phase 3, v1.6.1)

Scope: login, quota/payment enforcement, data access, and abuse resistance
for a paid product (₹50,000 / 5 analyses per contract). Reviewed against the
code as patched through v1.6.1.

## Overall posture

The security model is sound for a sales-led contract product: identity is
Firebase-verified, quota is enforced **server-side where the money is spent**
(the engine, not just the browser), consumption is transactional (parallel
tabs can't double-spend), enforcement fails **closed**, and Firestore rules
independently stop client-side tampering. The items below are what was fixed
in this phase and what remains.

## Fixed in this phase

**F1 — Quota was one global number, not per-customer. (HIGH, fixed)**
The ₹50k tier needs 5 analyses for customer A while a trial account gets a
different number. Added `users/{uid}.maxPrompts`, honored atomically inside
the backend quota transaction, enforced in Firestore rules (a user can
neither create nor modify their own allotment — admin-grant-only), surfaced
in the UI ("N of 5 queries left"), and manageable from the Admin Dashboard
("Set allotment" / "Reset usage"). This IS the payment tie-in: contract
signed → admin grants 5 credits. A future payment-gateway integration would
simply call the same grant.

**F2 — Unmetered chat endpoint could burn OpenAI spend. (MEDIUM, fixed)**
Chat turns correctly don't consume analysis credits, but that meant a
signed-in user (or a script with a valid token) could loop the LLM endpoint
indefinitely at your cost. Added a per-user sliding-window limit (default 60
turns/hour, configurable via `CHAT_TURNS_PER_HOUR`), returning a friendly
429 that explicitly says analysis credits are unaffected.

**F3 — Admin "users at limit" metric used a stale hardcoded threshold
(LOW, fixed)** — now computed against each user's actual allotment.

## Verified as already sound (no action needed)

- **Token verification**: Firebase ID tokens verified server-side with
  firebase-admin; invalid/expired tokens → 401. Admin allowlist is by
  verified token email, never a client-writable field.
- **Fail-closed**: if enforcement is on and verification infrastructure is
  down, requests are rejected (503) rather than silently free.
- **Atomic consumption**: Firestore transaction read-check-increment; no
  race between parallel tabs on the last credit.
- **Firestore rules**: users cannot set `isAdmin`, cannot reset their own
  `promptsUsed`, can only increment by exactly +1, capped at their
  allotment; the prompt log is append-only; default-deny on everything else.
- **Secrets**: no API keys in the frontend bundle; provider keys live in
  Cloud Run env; the evidence trail is secret-safe by design.

## Remaining risks — recommended, not blocking

**R1 — Flip the enforcement flag (HIGH priority action, one-line).**
All server-side enforcement is deployed but OFF by default
(`STRATAGEO_REQUIRE_USER_AUTH=false`) for rollout safety. Until you set it
to `true` on Cloud Run, quota is only client/Firestore-enforced and the
engine endpoints accept anonymous calls. Flip it as soon as the current
frontend (which already sends tokens) is confirmed live:
`gcloud run services update stratageo-engine --set-env-vars STRATAGEO_REQUIRE_USER_AUTH=true,MAX_PROMPTS_PER_USER=5`

**R2 — Shared-analysis links are public-by-URL (MEDIUM, accepted design).**
`analyses/{id}` allows public read: a share link is a capability URL (the
unguessable ID is the secret). Acceptable for share-by-link, but know that
anyone with a link can read that analysis forever. If contracts demand
revocation or expiry, add an `expiresAt` check to the rules later.

**R3 — Email/password accounts have no strength or verification gate
(LOW-MEDIUM).** The admin email/password account should have a long unique
password and, ideally, be migrated to Google sign-in only. Consider enabling
Firebase email enumeration protection in the console.

**R4 — In-memory chat rate limit resets on redeploy (LOW).** Correct for a
`--max-instances 1` service; if you ever scale out, move the window to
Firestore/Redis. Documented in the code.

**R5 — Keep the two admin lists in sync (operational).** The admin allowlist
exists in both `firestore.rules` and the `QUOTA_ADMIN_EMAILS` setting. A
mismatch fails safe (one layer still blocks) but confuses. A deploy-time
check is a nice-to-have.

## Suggested go-live sequence for the paid tier

1. Deploy backend + rules (`firebase deploy --only firestore:rules`).
2. Confirm frontend sends `Authorization: Bearer` (already implemented).
3. Flip `STRATAGEO_REQUIRE_USER_AUTH=true` and set `MAX_PROMPTS_PER_USER=5`
   (or leave 10 as the trial default and grant 5 per contract explicitly).
4. For each signed contract: Admin Dashboard → customer row →
   "Set allotment" → 5.
5. Verify: customer's 6th analysis attempt returns the friendly
   "used all 5 analyses" message, and a direct `curl` to `/api/v2/analyses`
   without a token returns 401.
