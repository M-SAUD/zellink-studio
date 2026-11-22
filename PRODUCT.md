# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Chosen by the user for Cloudflare: React and TypeScript with Vite, Workers Static Assets, a same-origin Hono API Worker, D1, private R2, and Queues for asynchronous delivery. This keeps one Worker-side authorization boundary and avoids SSR work for a private operations app.

## Launch and sign-in

The first release cohort is clients and project managers. Users sign in with their email address as the username and a password. Admins provision accounts; first sign-in and admin password resets issue a one-time password that must be changed. The reset password is handed off through a separately agreed secure channel. Email sign-in links, email delivery, and self-service email recovery are deferred. Product notifications are in-app only; Slack and external notification email are not part of this release. Billing and payment details are recorded manually; the platform does not take payments.

## Users

Client owners and members manage their organization's work. Client organizations have no member cap; client owners and studio admins can provision members. Project managers handle assigned client organizations. Specialists work on assigned tasks. Admins manage clients, staff, plans, capacity, settings, and audit records. Super admins control sensitive system and administrator access.

## Product purpose

Zellink Studio needs one place to manage its client relationships from onboarding through request delivery, revisions, approval, and handoff. Clients should know what is happening without chasing updates. Every client has a named primary project manager. Zellink staff keep briefs, files, feedback, assignments, and decisions with the work.

## Positioning

The platform follows the assigned PM, the client's approved plan capacity, and the recorded work history through the complete client-to-delivery workflow. It is built for Zellink's service model, not as a generic project-management template.

## Operating context

The client flow starts with an organization and PM assignment, invitation, client onboarding, PM review, a first brief, and client approval. A client can then submit unlimited requests and revisions, subject to configured service eligibility and active lane capacity. Work moves through PM review, queue, production, internal review, client review, revisions, approval, and delivery. A request may be split into internal tasks or milestones without silently adding client-facing requests or changing billing.

Clients see their organization's projects, queue, lane use, assigned PM, client-visible conversation, files, and activity. Project managers see only organizations assigned to them. Specialists see assigned work and only the client context needed for it. Internal notes and files remain separate from client-visible content.

The approved plan baselines are Foundation with one included lane, Growth with two, and Scale with three. An extra lane costs 25% of the client's current plan monthly equivalent and bills monthly. Annual subscriptions are paid upfront at 12 times the current monthly rate; extra lanes remain monthly add-ons. Plan prices must be recorded from an approved source. The app must not imply that a manual entry is a verified payment or create real charges, refunds, or subscriptions without an approved provider and commercial rules.

Status changes record the actor, time, previous and new status, optional reason, and client visibility. Admins can adjust lane allocations with a recorded reason. PM and assignment history must remain available. Onboarding and client files need secure storage. Passwords and third-party credentials must never go into ordinary text fields.

## Capabilities and constraints

The product must enforce roles, organization membership, PM assignments, task assignments, and file permissions on the server for every relevant request. A browser-supplied organization ID cannot grant access. Client members can use only permissions their owner grants. Admin and super-admin privileges remain distinct.

The workflow includes Draft, Submitted, PM review, Needs client information, Brief ready, Queued, In progress, Internal review, Client review, Revision requested, Approved, Delivered/closed, Waiting on client, On hold, and Cancelled. Admins can configure permitted transitions. Each transition defines who may move the work and whether the client sees a notification. The first brief requires client approval. Other approval rules, deadlines, and notification details are open until Zellink approves them.

The app must keep in-app conversations and notifications useful when email or Slack is not configured. Admins must see the real integration status. Notifications need deduplication and safe retry. File uploads need type and size validation, private storage, quarantine, a malware scanning strategy, and a fresh authorization check at download.

When a subscription is paused, users cannot submit new requests and PMs cannot allocate new lanes. Existing active work can continue to completion, and its lane can be released. Client records and files are retained permanently after closure. The first release has no client export or deletion action; closing an organization changes its status and preserves its history.

Open decisions: internal-user MFA; the operational handoff channel for one-time passwords; exact approval and transition rules; deadlines; safe third-party access-grant process; and service eligibility details. Until an operational policy is approved, the affected action must remain unset or be blocked. Permanent retention and the absence of export/deletion controls are approved product choices; legal requirements may require a later policy change.

## Brand commitments

The experience should feel calm, human, and creative. Keep Violet Bloom recognizable and use the existing shadcn-compatible color tokens in `color.css`. Do not present the app as a generic SaaS dashboard. Use concise language, purposeful status color, clear primary actions, useful empty and error states, and optional motion that respects reduced-motion preferences.

## Evidence on hand

The workspace began as `color.css` plus a short Next-style `sample-layout.js` stub. It now contains the Vite/React application, Hono Worker API, D1 migrations, synthetic seed data, and Cloudflare configuration. The color file remains the incumbent visual asset, and the user selected the Studio overview composition. There is no real client activity, Zellink website copy, or verified plan-price catalog in this workspace. Demo records must be fictional and labeled as demo data. Do not fabricate client names, activity, metrics, testimonials, or prices.

## Product principles

- Clients can see the next useful action and the person responsible for it.
- Every tenant read, write, and file operation checks server-side scope.
- Keep client-visible communication distinct from internal work.
- Preserve decisions and changes as a durable work history.
- Leave commercial and operational policies unset until Zellink approves them.

## Accessibility & inclusion

The app must work on desktop, tablet, and mobile. Support keyboard navigation and alternatives to drag-and-drop. Use visible focus, accessible labels, sufficient contrast, and reduced-motion settings. Provide complete responsive loading, empty, failure, full-capacity, missing-information, permission, and offline states.
