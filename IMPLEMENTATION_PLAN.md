# Zellink Studio platform workflow

## Definition of done

The local application supports a client from organization creation through onboarding, PM-approved brief, submitted request, capacity-checked lane allocation, specialist delivery, client revision or approval, and authorized file handoff. Server checks isolate each organization on every data and file operation. The running interface supports client, PM, specialist, and admin work on desktop and mobile, with keyboard access and reduced motion. Unresolved business rules stay configurable or visibly pending.

## Scope and grounding

This started as a greenfield web app with a shadcn-compatible Tailwind color file and a Next-style layout stub; the Vite/React application, Hono Worker API, D1 schema, and Cloudflare configuration are now implemented. The color tokens remain the incumbent visual asset. The user selected Studio overview and resolved the first release cohort, email-address/password sign-in, member limit, pause behavior, billing/notification model, retention, and Cloudflare stack. Exact approval transitions, deadlines, MFA, one-time-password handoff, access grants, and service eligibility remain open.

The work has seven vertical slices: product and interface contract; app and database foundation; authentication and tenant access; client setup and onboarding; request production and atomic lane allocation; specialist delivery, review, files, and notifications; dashboards, accessibility, deployment docs, and end-to-end verification. Account-specific deployment and external provider setup need Zellink credentials and decisions.

## Data shape

`User` has application roles and email/password credentials. `Organization` owns tenant data. `Membership` joins a user to one organization with client permissions and has no product cap. `PmAssignment` stores the primary PM, temporary backup, and assignment history. `PlanChange` stores the approved plan and manual lane add-ons without claiming a payment occurred. `Onboarding` stores answers and checklist state. `Project` groups milestones and requests. `Request` has one explicit workflow state and an append-only `RequestEvent` history. `BriefVersion` and `Approval` preserve the first-brief and deliverable review records. `SpecialistTask` and `TaskAssignment` track internal production. `Comment` carries an explicit visibility. `FileVersion` stores private object metadata and authorization scope. `Notification` tracks in-app events. `AuditEvent` records sensitive administrative actions. Closed client data is retained permanently; the first release has no export or deletion operation.

The configured workflow must cover Draft → Submitted → PM review → Needs client information → Brief ready → Queued → In progress → Internal review → Client review → Revision requested → Approved → Delivered/closed, plus Waiting on client, On hold, and Cancelled. Each transition declares who may use it and whether it is client-visible/notifiable. Do not assume every state transition is mandatory or invent deadlines, automatic cancellations, revision limits, or payment consequences.

Every tenant-owned record carries an organization key. Server access derives that key from the authenticated user's membership or PM assignment, never from an untrusted request field. Status transitions use one registry. Lane allocation is one atomic database write guarded by the current approved capacity. Pausing blocks new requests and lane allocations, while existing active work can continue and lanes can be released. Demo seed records must be clearly labeled fictional.

## Confirmed operating rules and open decisions

Confirmed by the objective: Foundation includes one lane, Growth two, and Scale three. An extra lane is 25% of the client's current plan monthly equivalent and bills monthly; annual plans are paid upfront at 12 times the current monthly rate, while extra lanes remain monthly add-ons. Clients may submit unlimited requests and revisions, subject to configured plan service eligibility and active capacity. The platform records manual plan/payment information only unless a payment provider and commercial rules are explicitly approved. Do not create charges, refund flows, or payment state that implies a real transaction. Each mutation records actor, time, old/new state, optional reason, and client visibility. The first brief requires client approval; later approval gates and transition ownership stay configurable until approved.

Still awaiting user input: MFA for internal users, the secure handoff channel for one-time passwords, workflow transitions and approval rules, deadlines, safe third-party access grants, and service eligibility. Email sign-in links, email delivery, and self-service email recovery are deferred; product notifications and Slack are not enabled. Admins can issue an audited one-time password reset, which revokes existing sessions and requires a password change. Keep integrations visibly unconfigured until credentials exist. Never request third-party passwords in free text; an approved safe access-grant process is still needed. Security and abuse controls must not turn edge rate limits into a strict account policy.

## Current platform evidence

Cloudflare recommends Workers Static Assets for new SPAs and full-stack apps. D1 databases are single-threaded, and statements in a batch run in one SQL transaction. This can enforce lane capacity without a Durable Object unless later requirements add real-time coordination. Private R2 links are bearer tokens, so the Worker must authorize before signing and use a short expiry. Queues provide at-least-once delivery, so notification consumers need idempotency keys. D1 Time Travel keeps seven days of history on Workers Free and thirty days on Workers Paid. Restoring overwrites the database, so production recovery needs a reviewed runbook and an export path for longer retention.

Sources: [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), and [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

## Architecture selection rubric

Score each candidate from 1–5 on (1) smallest maintainable boundary for this authenticated workflow, (2) tenant and role safety with auditable writes, (3) fit to current Cloudflare services and operating burden, (4) responsive multi-role UI and local verification, and (5) preserving unresolved policies. Select a base with the fresh-context judge, then record any grafts and rejected design in `.audit/architecture/synthesis.md`.

## Worklist

- [x] Read the pstack Principles index in full.
- [x] Inspect the workspace, incumbent tokens, and available local runtimes.
- [x] Read current Cloudflare guidance for Workers assets, D1 limits, R2 access, and Queues delivery.
- [x] Ask the user about launch cohort, client login, billing/notifications, client limits, paused subscriptions, retention, and framework. The launch cohort, email/password sign-in, manual billing, in-app-only notifications, unlimited client members, paused-work rules, permanent retention/no export or deletion, and Cloudflare stack are confirmed.
- [x] Record confirmed product truth and mark open decisions; the user selected Studio overview and the Violet Bloom tokens remain intact.
- [x] Cross-judge Cloudflare architecture sketches, select the smallest fit, and record the synthesis.
- [x] Write the implementation contract for auth scope, lane transactions, file quarantine, and open policies.
- [x] Build the project scaffold, local verification harness, data schema, and server authorization boundary.
- [x] Implement onboarding, request workflow, lane allocation, specialist delivery, files, feedback, and approvals.
- [x] Implement client, PM, specialist, and admin views with useful loading, empty, failure, and capacity states.
- [x] Run database, API, source-level accessibility, responsive-rule, and production-build checks against the requested acceptance cases. See `.audit/accessibility-review.md` for the check scope and remaining manual release review.
- [x] Document setup, local development, migrations, secrets, backup, deployment, rollback, and unresolved external-service costs.
- [x] Review the audit trail and report verified work, open decisions, and deployment requirements.

## Architecture exploration

- [x] Frame the architecture rubric.
- [x] Produce two independent Cloudflare app sketches in separate files.
- [x] Cross-judge the sketches in a fresh context.
- [x] Select a base, graft useful ideas, and record the synthesized design.

## Security and UI choices

- Architecture base: Vite React client plus same-origin Hono Worker API; the browser never reaches D1 or R2 directly.
- Tenant authorization: derive user and role from the verified server-side identity, then check membership, PM assignment, task assignment, or admin capability in the use case and scoped query.
- Lane capacity: reserve through one conditional D1 statement with database constraints and atomic event/audit/outbox triggers. No separate read-count-insert sequence.
- Files: private R2 objects remain quarantined until a configured scanner returns clean. Cloudflare Container ClamAV is the production scanner path; production must fail closed on missing, stale, or failed scanning. Local test doubles cannot report production cleanliness.
- Upload cap: default configurable technical limit is 20 MiB, subject to the Cloudflare Worker plan limit and future approved Zellink needs.
- Visual direction: Studio overview selected by the user; preserve the Violet Bloom tokens from `color.css`.
- Release decisions: first cohort is clients and PMs; users sign in with email address and password. Admins provision accounts and can issue a one-time password reset; the operational secure handoff channel is pending. Email sign-in links and self-service recovery are deferred. Billing is recorded manually; product notifications are in-app only, with no Slack or notification email. Client-member count is unlimited. Pausing blocks new requests and lane allocations; current active work continues and may release its lane. Closed client data is retained permanently, with no export/deletion operation in the first release.
- Stack source: current [shadcn Vite setup](https://ui.shadcn.com/docs/installation/vite), [Cloudflare Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Cloudflare Containers](https://developers.cloudflare.com/containers/), and [ClamAV documentation](https://docs.clamav.net/).

## Decision trail

Append one row per meaningful decision or verified work unit to `.audit/zellink-platform.tsv`. Keep evidence as file paths, command output, or screenshots. Do not log assumed policy as user-approved policy.
