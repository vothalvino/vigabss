# WhatsApp Customer Support — Design Spec (DRAFT for review)

Status: **proposed, pre-implementation.** This documents the identity/security
foundation and the phased build. Nothing here is built yet.

## 1. Principle: the WhatsApp number *identifies*, it does not *authenticate*

Meta guarantees the sender controls that phone number. It does **not** prove the
sender is the account holder (SIM swap, recycled number, a family member's phone,
a stale/shared `clients.phone`). Therefore:

- A number match to `clients.phone` is **only** a server-side hint used to decide
  *where to send a verification code*. It never grants access and is never echoed
  back ("yes, you're a customer") — that would be a customer-enumeration oracle.
- Access to anything account-specific requires a **binding step** that proves
  account ownership through a channel the system already trusts.
- After binding, high-impact actions still require a per-action **step-up**
  confirmation; the most dangerous actions are not available in chat at all.

Downstream of a resolved `clientId` everything already exists (balance, tickets,
AI chat, contract data) — see `docs`/the inventory. The net-new work is purely
*getting to a trustworthy `clientId` from a phone number*.

## 2. Identity model

### 2.1 Binding (one-time, links a phone ↔ client)

Two paths; an org can enable either or both.

**A. Portal linking code (strongest).** In the existing subscriber portal
(`portalAuthService`, email+password, already lockout-protected) the client opens
"Connect WhatsApp", which mints a short-lived numeric code + a `wa.me` deep link.
The client sends the code to the bot once. Proof rides on the real portal auth.

**B. Email OTP (broader coverage).** Portal access is admin-enabled, so many
clients have no portal password. Fallback: the client states their **account
email**; the bot sends a 6-digit code **to that email** (a *different* channel
from the WhatsApp thread — that is what makes it a second factor), valid ~10 min;
on success the number is bound.

Both converge on: insert a `whatsapp_links` row binding `phone_e164 → client_id`.

**Never** used for binding: SMS OTP to the same number (same-channel, no second
factor), or a bare `clients.phone` match (weak identifier).

### 2.2 What a bound number can do without re-proving

A bound number gets a lightweight session (recent-activity window). Tier-1
read-only actions need only the binding. Tier-2 actions need a **step-up**: a
fresh, single-purpose confirmation (e.g. "Reply CONFIRM to change the Wi-Fi
password") — bounded in time, one action per confirmation.

### 2.3 Unbinding / revocation

- Client: "unlink" command, or the portal's WhatsApp screen → the link is
  revoked (`status = 'revoked'`).
- Staff: the client's Communication tab lists the bound numbers and unlinks
  one (`DELETE /clients/:id/whatsapp-links/:linkId`, `clients.update`,
  audited as `whatsapp_link_revoked`).
- Automatic: a change to `clients.phone` or `clients.email`, a portal password
  reset, archiving the client or making it `inactive` revokes all of its links
  (re-bind required). A link whose client is archived or inactive, or that
  has been unused for `WHATSAPP_LINK_IDLE_DAYS` (default 180, 0 = never), is
  revoked the next time the number writes in.
- Binding a number emails the account owner, so a binding made by someone
  else is noticed.

## 3. Schema (net-new)

```
-- Normalized, unique phone identity for messaging. One row per (org, e164).
CREATE TABLE whatsapp_links (
  id                BIGINT UNSIGNED PK,
  organization_id   BIGINT UNSIGNED NOT NULL,          -- FK organizations
  client_id         BIGINT UNSIGNED NOT NULL,          -- FK clients
  phone_e164        VARCHAR(20)  NOT NULL,             -- normalized E.164
  bound_via         ENUM('portal','email_otp','staff') NOT NULL,
  bound_at          DATETIME NOT NULL,
  last_seen_at      DATETIME NULL,
  status            ENUM('active','revoked') NOT NULL DEFAULT 'active',
  deleted_at        DATETIME NULL,
  UNIQUE (organization_id, phone_e164, deleted_at)      -- one active bind per number per org
);

-- Short-lived verification codes (linking OTP + step-up challenges).
CREATE TABLE whatsapp_verifications (
  id              BIGINT UNSIGNED PK,
  organization_id BIGINT UNSIGNED NOT NULL,
  phone_e164      VARCHAR(20) NOT NULL,
  purpose         ENUM('link_portal','link_email','stepup') NOT NULL,
  client_id       BIGINT UNSIGNED NULL,                 -- target once known
  code_hash       CHAR(64) NOT NULL,                    -- sha256(code+pepper), NEVER plaintext
  channel         ENUM('email','portal') NOT NULL,      -- where the code was sent
  expires_at      DATETIME NOT NULL,
  consumed_at     DATETIME NULL,
  attempts        INT NOT NULL DEFAULT 0,               -- wrong-code tries
  created_at      DATETIME NOT NULL
);

-- Inbound message log (audit + idempotency, mirrors webhook_events discipline).
CREATE TABLE whatsapp_inbound_messages (
  id                  BIGINT UNSIGNED PK,
  organization_id     BIGINT UNSIGNED NULL,             -- resolved once bound
  provider_message_id VARCHAR(255) NOT NULL,            -- Meta/Twilio id
  phone_e164          VARCHAR(20) NOT NULL,
  body                TEXT,
  received_at         DATETIME NOT NULL,
  UNIQUE (provider_message_id)                          -- dedup redeliveries
);
```

- `phone_e164` normalized to E.164 on ingest; `clients.phone` stays free-form but
  a normalized lookup (or a generated/normalized column) maps it for the
  "where to send a code" hint.
- `code_hash` only — codes are never stored or logged in plaintext (same
  discipline as `portal_reset_token_hash`).

## 4. Inbound webhook (net-new — no messaging inbound exists today)

`POST /api/v1/whatsapp/webhook` — **public**, authenticated by the provider's
signature (Meta `X-Hub-Signature-256` HMAC, or Twilio `X-Twilio-Signature`).
**Fail closed**, mirroring the payment-webhook hardening (#509):

- No/invalid signature → **401**, never processed.
- Signing secret not configured → **503** (not silently trusted).
- Malformed / non-message payload → **400** before any processing.
- Dedup on `provider_message_id` (redeliveries are routine).
- Meta's `GET` verification challenge handled separately.

## 5. Abuse / rate limits

- Per-`phone_e164` verification budget (fixed-window, mirror
  `checkBulkEmailDailyBudget` / portal lockout): N code requests/hour, lock after
  K wrong step-up/OTP attempts (copy the `portal_login_attempts` DB-lockout).
- Per-IP webhook limiter (reuse `makeLimiter` / `webhookLimiter`).
- No enumeration: identical bot response whether or not a number/email is on file.

## 6. Capabilities by tier

| Tier | Requires | Actions |
|---|---|---|
| 0 | nothing | plans/pricing, coverage by address, how to pay, hours, FAQ, **area-outage report**, "talk to a human" (ticket/callback) |
| 1 | bound number | **balance & due date** (`clientBalanceService`), last/next invoice status, current plan/speed, contract status. Invoice/**CFDI copies emailed**, not in chat |
| 2 | bound + step-up | **report a problem on a chosen contract** (`diagnosticEngineService` + `aiReplyService`/`supportConversationService`, already `whatsapp`-aware → ticket), **change Wi-Fi password**, **pay now** (secure link), technician visit/reschedule, proof-of-payment upload, CFDI request |

**Out of WhatsApp entirely** (portal or human only): change account email/phone,
change fiscal data (RFC/CSD), cancel service, reveal any current password or card
data.

### 6.1 Multi-contract

One client → many contracts (`contracts.client_id` non-unique, identified by
numeric `id`, no `contract_number`). Any contract-specific action (report a
problem, change Wi-Fi password) **must present a contract picker** when the
client has >1 active contract — the portal's "first active contract" shortcut is
not safe to inherit for writes.

### 6.2 Wi-Fi password (the sharp edge)

- Two secrets: **PPPoE** (`radius.password`) vs the home **Wi-Fi PSK**
  (`onu_omci_configs.wifi_password_encrypted`). Customers mean the PSK.
- **Set a new one; never reveal the current one** in chat.
- Requires step-up **and** an email notification that it changed (so a hijacker
  can't change it silently).
- Neither existing change path sends a CoA/reconnect; expect a brief drop and
  say so. Reuse `portalServiceRequestService` (approval) or auto-apply post-step-up.

## 7. Phased build

- **Phase 0 — foundation (this spec):** schema, phone normalization, inbound
  webhook (fail-closed + dedup), rate/lockout primitives. No customer-visible
  capability yet; testable with a signed sandbox payload.
- **Phase 1 — identify + read-only:** binding (portal + email OTP), Tier-0 +
  Tier-1 (balance, plan/status, report-a-problem → ticket). Reuses the AI stack.
- **Phase 2 — write actions:** pay-now link, Wi-Fi password change (step-up +
  notify), technician scheduling, proof-of-payment, CFDI request. Multi-contract
  picker.

Each phase = its own PR with the full local gate + adversarial review on the
identity/webhook/billing pieces.

## 8. Threat model (what each control defends)

| Threat | Control |
|---|---|
| Attacker texts from a random number | Binding required; no data to unbound numbers |
| Attacker knows victim's number (spoof/SIM-swap) | Binding needs portal login OR email OTP (second channel), not number match |
| Enumeration ("is X a customer?") | Uniform responses; number match never surfaced |
| Hijacked WhatsApp thread | Step-up per sensitive action; email notify on Wi-Fi change; dangerous actions excluded |
| Webhook forgery / replay | Signature verify (fail-closed) + `provider_message_id` dedup |
| Code brute-force | Hashed codes, short expiry, attempt lockout, per-phone budget |
| Cross-tenant leak | Everything org-scoped (`organization_id` on every new table + query) |
| Secret leakage into chat history | Never reveal passwords/cards; set-don't-show for Wi-Fi; copies via email |

## 9. Implementation notes (as built — PR 1: foundation + binding)

Deltas from the design above, decided during implementation + adversarial review:

- **Binding uniqueness is install-wide, not per-org.** The inbound webhook is a
  single endpoint with no org context, so a sender number must resolve to
  exactly one client. `whatsapp_links.active_phone` (VIRTUAL) is UNIQUE globally;
  `organization_id` is retained as data. Per-org WhatsApp business numbers (route
  by the receiving number) is a later enhancement — `to_number` is already stored.
- **Portal codes are matched phone-agnostically by hash; on a code collision
  across two clients we refuse to bind** (`ambiguous`) rather than guess — no
  wrong binding is ever created (both codes self-heal on expiry). Portal-code
  brute force is bounded by the per-phone inbound throttle (all guesses arrive as
  provider-signed webhooks) + short TTL + 8-digit space.
- **Codes are redacted before the inbound body is persisted** (`redactSecrets`
  masks 4+ digit runs) — honors §3's "never store codes in plaintext".
- **Webhook acks 200 immediately, then processes async.** The bot + a live
  outbound reply can take up to 15s; blocking the provider's delivery window
  risks a redelivery storm. Dedup on `(provider, provider_message_id)` makes any
  redelivery a no-op.
- **DND is authoritative after client attribution.** Every reply to a bound
  client is checked against the live WhatsApp/all-channel DND veto immediately
  before provider I/O. The uniform welcome, cooldown, and linking instructions
  sent directly in response to an unbound number are anonymous onboarding
  responses, not client-directed messages: matching an unbound number to a
  client merely to apply preferences would create the enumeration and
  cross-tenant ambiguity prohibited above. They contain no account data and
  stop once the number is bound, at which point DND applies fail-closed.
- **Two OTP budgets:** per-sender-phone (anti-flood) AND per-target-client
  (anti-inbox-bomb by a number-cycling attacker). Portal link-code minting is
  capped per client.
- **Twilio behind a proxy:** signature URL reconstruction trusts
  `X-Forwarded-Host/Proto` unless `WHATSAPP_WEBHOOK_PUBLIC_URL` is set — this is
  availability only (never a signature bypass), but set it in production.
- **Meta config coherence:** inbound is detected from `WHATSAPP_APP_SECRET`;
  outbound needs `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_ACCESS_TOKEN`. A startup
  warning fires if only the inbound half is configured.
- **Known limitation:** a client whose email is shared across orgs (or duplicated)
  can't link via email OTP (we send only on a unique match) — they use the portal
  linking code instead.
- **Bot copy is English** (in a `MESSAGES` map for easy localization later);
  Spanish/i18n is a follow-up.

## 10. Implementation notes (as built — PR 2: read-only capabilities)

- A bound client now gets a **numbered menu** (1 balance · 2 plan/service · 3 invoices ·
  4 report a problem · 5 talk to a human) instead of the PR-1 placeholder. Intent is
  parsed by number **or** keyword, EN + ES (`saldo`/`plan`/`factura`/`problema`/`agente`).
- **`whatsapp_conversation_state`** (migration 419, one row per phone, ~15-min TTL) backs the
  multi-turn **report-a-problem** flow: pick which service (only when the client has >1 active
  contract — the multi-contract picker the design called for) → describe it → a **client-level
  technical ticket** is opened (same shape as the portal). `MENU`/`cancel` escapes any flow.
- Read answers reuse the portal's exact data sources: `computeClientBalance` (+ next due date),
  the active-contract/plan query, and recent invoices. **Copies are never dumped in chat** — this
  phase only summarizes; full invoice/CFDI delivery to email is a later add.
- "Talk to a human" opens a general ticket flagged as a WhatsApp handoff (staff pick it up).
- Still **read + report only** — no balance-changing or credential actions (those are PR 3, gated
  behind step-up). Tier-0 public info (plans/hours for an *unbound* sender) is deferred: it needs
  an org-resolution story (which ISP?), which the single-business-number model doesn't yet provide.
- **Review hardening:** conversation state is validated against the current binding's `client_id`
  (and cleared on rebind/revoke) so a recycled/re-linked number can never carry a prior client's
  contract into a new client's ticket; the bound path has its own per-phone throttle + a per-client
  WhatsApp-ticket cap (anti ticket-flood); the chosen contract is written to `tickets.contract_id`;
  a batch's messages are processed sequentially so a same-sender burst can't race the ticket cap.
  Accepted residual: the ticket cap is check-then-act (not a DB lock), so a cross-*request*
  concurrent burst could still overshoot 5 slightly — but total creation stays bounded by the
  40 msg/hr/phone throttle, so it's never unbounded. A DB-atomic cap is a later hardening if needed.
- **Note:** a problem *description* the customer types is stored verbatim in `tickets.description`
  (support staff need their actual words) — same as the portal ticket path. Only linking **codes**
  are redacted (in the inbound audit log), never a free-text ticket body.

## 11. Implementation notes (as built — PR 3: write actions)

The menu grows to: 1 balance · 2 plan · 3 invoices · 4 report a problem · **5 reset Wi-Fi
password** · **6 schedule a technician visit** · 7 talk to a human. No new schema — the multi-turn
flows reuse `whatsapp_conversation_state` (PR 2).

- **Reset Wi-Fi password** — the sharp edge, done per the design's §6.2: **step-up** (`CONFIRM`),
  the new password is **generated server-side and emailed** to the address on file (a second
  channel) — **never typed or shown in chat**. On installs with a TR-069 CPE it is applied
  immediately (reuses the extracted `queueWifiPasswordCpeTask`, shared with the admin approve path);
  without a managed CPE it files a `wifi_password_change` request for staff. **Refuses if no email
  is on file** (else the client would be locked out of their own Wi-Fi with no way to get the new
  password). The email doubles as a security alert ("if you didn't request this…"). Per-client
  cap of 3 resets/hr on top of the bound-path throttle.
- **Schedule a technician visit** — multi-turn (date → time slot) → a `visit_schedule` request;
  same 3/hr cap.
- **Step-up model:** `CONFIRM` gates intent-confirmation and stops *accidents*; a hijacked bound
  session is bounded instead by the throttle + per-action cap + the email notification (the design's
  accepted trust model — binding alone is Tier-1; Tier-2 writes add step-up + notify, not stronger auth).
- **Deferred (documented, not built):** **pay-now** (blocked on the unbuilt Stripe checkout front
  door — see the stripe-checkout-gap note), **CFDI request on demand**, and **proof-of-payment
  upload** (needs provider media handling). These round out the plan but each has an external
  dependency.
- **Review hardening (2 opus finders + opus verify workflow, 6 confirmed findings all fixed):**
  the Wi-Fi reset now **delivers the new password by email FIRST (awaited, per-org SMTP routed) and
  only applies the CPE change on confirmed delivery** — an email failure changes nothing and the bot
  says so honestly (never a false "emailed"); the cached contract is **re-validated against the
  client at apply time** (TOCTOU on contract reassignment) for both Wi-Fi and visit; the visit flow
  got the **multi-contract picker** it was missing; and `parseVisitDate` rejects overflow (Feb 30)
  and past dates. The binding-OTP email is likewise org-routed now.

## Natural conversation and tappable replies

With the organization's AI assistant enabled for the WhatsApp channel (and an
active provider, within budget), a bound client can write in their own words.
`src/services/whatsappUnderstanding.js` asks the organization's model one
narrow question per message and validates the answer:

| Where | The model returns | Checked against |
|---|---|---|
| Outside a flow | an intent | a fixed list (balance, plan, invoices, report, wifi, visit, human, greeting, thanks, question, unclear) |
| Choosing a service | an option number | the options that were offered |
| Visit day / time | a date and a slot | date format, not in the past, the three slots |
| Confirming a Wi-Fi reset | yes / no / unclear | only an explicit yes resets |

It never writes facts. Balance, plan and invoice answers are still produced by
`whatsappCapabilityService`; the model may reword them, and a rewrite that
contains a number or a link not present in that text is discarded. A described
problem or a real question ("question") goes to `supportConversationService`,
which checks the account and connection and escalates by its own rules.

Any failure (assistant off, no provider, over budget, provider error, an
unexpected answer) returns null and the numbered menu bot handles the message
as before. Two messages in a row that cannot be understood show the menu.

Replies may carry an `interactive` form next to their text: a list (menu,
choice of service) or up to three buttons (confirm/cancel, tomorrow/the day
after, the three time slots). `whatsappOutbound` sends it through Meta's
interactive message types and falls back to the text if Meta refuses it; Twilio
always gets the text. Option ids are words a customer could type ("1",
"confirm", "morning", an ISO date), so `parseMeta` turns a tap into that text
and no flow has a separate path for taps.

## Voice notes

A Meta `audio` message from a bound client is transcribed and then handled
exactly like typed text (`src/services/whatsappVoice.js`):

1. `parseMeta` keeps the media id; the message has no body.
2. The bot checks the per-phone message cap, then asks `whatsappVoice` for the
   text. That requires the organization's AI assistant to be on for WhatsApp
   and an enabled OpenAI or OpenRouter provider
   (`llmProviderService.transcriptionProvider`).
3. The file is fetched from Meta in two steps (media object, then its
   short-lived URL). The access token is only ever sent to Meta's hosts, and
   a file over 3 MB is refused before it is downloaded.
4. `llmProviderService.transcribe` checks the AI budget, sends the audio and
   records the usage. OpenAI: the transcription endpoint. OpenRouter (which
   has no such endpoint): a chat model that accepts audio, instructed to
   output the words spoken and nothing else.
5. The transcript (cut at 1,500 characters) is the message. It is stored on
   the inbound row as `[voice] …`; the audio is not stored anywhere.

Every failure returns null and the customer is asked to type instead. Unbound
numbers and Twilio are not transcribed.

The model is the one set on that provider ("Voice note model", stored as
`extra_config.transcription_model`), else `AI_TRANSCRIPTION_MODEL` /
`AI_TRANSCRIPTION_OPENROUTER_MODEL`, else the built-in default.

## Failing replies

`whatsappOutbound` tells `whatsappSettingsService` about every reply Meta
refuses (`noteSendFailure`) and every reply that goes out (`noteSendSuccess`).
A run of failures is one record (message, Meta's code, first and last time,
count) in the install-wide `settings` row `whatsapp_last_send_failure`,
written at most once a minute and cleared by the next delivered reply or when
the token or number is replaced. `GET /whatsapp-settings` returns it as
`send_failure`, with `auth: true` when the token or its permissions were
rejected, and the settings screen shows it as a warning.

## Choosing the voice-note provider and model

`llmProviderService.transcriptionProvider(orgId)` returns the provider the
organization chose (`ai_policies.voice_provider_id`, set from the Providers
table's "Voice notes" column and validated to be its own enabled OpenAI or
OpenRouter provider), else the first such provider by priority. The model is
`extra_config.transcription_model` on that provider; on OpenRouter the form
offers the catalog's models flagged `audio_input` (OpenRouter's
`architecture.input_modalities` contains `audio`).

`whatsappVoice.status(orgId)` (`GET /ai/voice-notes/status`) reports whether
voice notes are transcribed right now and, if not, the first thing that stops
them. The settings screens show it.
