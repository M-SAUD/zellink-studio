# Zellink Studio

Zellink Studio is an open-source agency operations workspace for client owners and members, project managers, creative specialists, and studio administrators. The first release covers client onboarding, requests, briefs and approvals, lane capacity, specialist assignments, files, in-app notifications, manual plan records, and audit history.

The project is released under the [MIT License](LICENSE).

The selected interface direction is **Studio overview**, using the existing Violet Bloom tokens in `color.css`. Product and operational decisions are recorded in [PRODUCT.md](PRODUCT.md), with the implementation plan in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Confirmed first-release decisions

- Sign in with email address and password. Admins provision accounts; first sign-in requires a personal password. Email sign-in links and email delivery are deferred. Admins can issue a one-time password reset.
- Product notifications stay in the app. No Slack or notification email integration is enabled.
- Billing is a manual record only. The app does not charge cards or claim a payment occurred.
- Client organizations have no member cap; owners and studio admins can add members.
- A paused plan blocks new client work and new lane allocations. Existing active work can finish and release its lane.
- Client records and files are retained permanently. The first release has no client export or deletion action.
- Cloudflare Workers, D1, private R2 and Queues are the production target. File uploads remain off until a malware scanner is enabled.

MFA for internal accounts, workflow and approval policy details, deadlines, safe third-party access grants, and service eligibility still need operating decisions. Password resets require an approved secure handoff channel; email recovery is not configured.

## Local prerequisites

- Node.js 20.19+ or 22.12+ and npm, as required by the installed Vite 8 release ([Vite guide](https://vite.dev/guide/)).
- WSL2 with Docker Engine is needed only if you choose to run the ClamAV Container locally on Windows. The normal local app runs without it; production file uploads stay disabled until scanning is configured.
- Wrangler runs locally through the project scripts. A Cloudflare account is not needed for local development.

## Local setup

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
```

Edit `.dev.vars` and replace the placeholder `BOOTSTRAP_SECRET` with a long random value. This file is ignored by Git. Then apply the local schema and load synthetic demo data:

```powershell
npm run build
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Open the Vite address printed by the dev server, normally `http://127.0.0.1:5173`. Vite proxies `/api` to the local Worker on port `8787`. The demo selector is available only in local development and uses fictional records; it is disabled in production mode. The default Windows config does not start Containers. To test ClamAV locally, run Wrangler under WSL2 with Docker available and set `dev.enable_containers` to `true` in `wrangler.local.jsonc`. Automated tests use a scanner test double and do not require Docker.

To create a local super-admin rather than use the demo selector, start the app and call the one-time bootstrap endpoint while `system_bootstrap.state` is still `pending`:

```powershell
$secret = (Get-Content .dev.vars | Where-Object { $_ -match '^BOOTSTRAP_SECRET=' }) -replace '^BOOTSTRAP_SECRET=', ''
$body = @{ email = 'you@example.com'; displayName = 'Studio Admin'; password = 'a-long-unique-password' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/auth/bootstrap' -Headers @{ 'X-Setup-Secret' = $secret } -ContentType 'application/json' -Body $body
```

Bootstrap can be claimed once per database. Do not use the demo seed or a local bootstrap credential for a production account.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

`npm test` runs the Cloudflare Workers Vitest integration against isolated test bindings. It covers tenant boundaries, the request-to-delivery path, lane capacity, paused plans, quarantined uploads, queue ordering, PM assignment history, account suspension, and password reset behavior.

The interface uses Radix dialog primitives for keyboard focus containment and restoration, visible Violet Bloom focus outlines, explicit control labels, keyboard queue-order controls alongside drag-and-drop, reduced-motion styles, and responsive layout breakpoints. Text on the app’s light surfaces has a 12px minimum and muted foregrounds were checked for contrast. A full screen-reader and browser-based WCAG audit should still be part of release review.

## Configuration and data

- `APP_MODE` enables development-only demo login only when set to `development`. Production config sets it to `production`.
- `MAX_UPLOAD_BYTES` defaults to 20 MiB. This is an implementation limit, not a service plan promise.
- `BOOTSTRAP_SECRET` is required only for one-time initial admin creation. Use a local `.dev.vars` file for Wrangler local development and a Wrangler secret for a production Worker.
- `FILE_UPLOADS_ENABLED` is set to `false` in the production config. Enable it only after the scanner binding and its health checks are ready.
- D1 stores identities, organization data, workflow state, permissions, and audit events. R2 stores private file bytes. Files remain quarantined until the scanner reports clean; download authorization is checked again by the Worker.
- Migrations in `migrations/` are ordered and append-only. Apply them with `npm run db:migrate:local` or, after reviewing the target and migration, `npm run db:migrate:remote`.
- Demo records in `seeds/demo.sql` are fictional and must not be treated as client evidence or plan prices.

Client data has no product-level export or deletion control. Cloudflare D1 Time Travel is an operational recovery feature with a limited rolling history, not a permanent archive. Review current retention and restore behavior for the chosen Cloudflare plan before production use; restore can rewind the whole database. No production backup or restore has been configured or tested in this workspace.

## Cloudflare setup and release

The production configuration is `wrangler.jsonc`. It points to the `app.zellinkstudio.com` custom domain and expects:

- D1 database `zellink-studio` (the committed ID belongs to the Zellink Cloudflare account; replace it with your own database ID when deploying a fork).
- Private R2 bucket `zellink-studio-files`.
- Queues `zellink-studio-file-scans` and `zellink-studio-file-scans-dlq`.
- The `BOOTSTRAP_SECRET` Worker secret for the one-time super-admin bootstrap.

This release does not provision the ClamAV Container. Request and onboarding uploads are rejected by the API and hidden from the UI while `FILE_UPLOADS_ENABLED` is `false`. The scheduled Worker also skips scanner health checks in this mode. Keep the R2 bucket private and never run the local seed against a production database.

For the Zellink Cloudflare account, the D1 database, private R2 bucket, scan queues and all 11 migrations are in place. The Worker is deployed at [app.zellinkstudio.com](https://app.zellinkstudio.com). Cloudflare custom domains create the DNS record and certificate for an active zone; see [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). The first super-admin account still needs to be created through the one-time bootstrap flow before anyone can sign in.

### Create the first production admin

Production starts with no users. From the repository root, run this script in PowerShell. It prompts for the first super-admin's email, display name and password without echoing the password. The password must be at least 12 characters. It reads the one-time `BOOTSTRAP_SECRET` from the ignored `.secrets/production-bootstrap` file and sends it only to the configured HTTPS app endpoint.

```powershell
.\scripts\bootstrap-production.ps1
```

After the script confirms success, sign in at `https://app.zellinkstudio.com`. Then remove the one-time secret from the Worker and delete the local copy:

```powershell
npx wrangler secret delete BOOTSTRAP_SECRET
Remove-Item -LiteralPath .secrets\production-bootstrap
```

Do not paste the initial password or bootstrap secret into chat, source control, or a shared terminal transcript. If bootstrap has already been claimed, the endpoint cannot create another super-admin.

#### Set the bootstrap secret in the Cloudflare dashboard

In Cloudflare, open **Workers & Pages → `zellink-studio` → Settings → Variables and Secrets**. Add or edit `BOOTSTRAP_SECRET` as a **Secret**, then deploy the change. The value must be at least 32 characters. Cloudflare hides a saved secret value; if you replace it, also replace the value in `.secrets/production-bootstrap` before running the local bootstrap script. Keep both values identical. See [Cloudflare's secret configuration guide](https://developers.cloudflare.com/workers/configuration/secrets/).

Changing `BOOTSTRAP_SECRET` only gates the one-time `/api/auth/bootstrap` request; it does not create an account. The endpoint returns `404 setup_unavailable` when the secret is missing, `403 setup_unavailable` when it does not match, `409 bootstrap_already_completed` after the first account is created, and `500 internal_server_error` for an unexpected Worker or database failure. Do not rotate the secret in response to a 500. Check **Workers & Pages → `zellink-studio` → Observability → Logs** and search for the `requestId` returned in the error response. The Worker records the route, exception name and a short redacted error message. For live errors, run `npx wrangler tail zellink-studio --format pretty --status error`. Cloudflare documents [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and the [Observability Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/).

Useful CLI commands after Cloudflare resources exist:

```powershell
npx wrangler login
npx wrangler d1 create zellink-studio
npx wrangler r2 bucket create zellink-studio-files
npx wrangler queues create zellink-studio-file-scans-dlq
npx wrangler queues create zellink-studio-file-scans
npx wrangler secret put BOOTSTRAP_SECRET
npm run db:migrate:remote
npm run deploy
```

Run the resource creation commands only for a new Cloudflare account. The migration command applies any migrations not yet present; review the target database before using it. Update `wrangler.jsonc` with your own D1 ID and confirm your Cloudflare zone contains `zellinkstudio.com` before deployment. `npm run deploy` builds and deploys the Worker and static app. Set `FILE_UPLOADS_ENABLED` to `true` only after configuring and verifying the scanner.

### Rollback and recovery

Workers versions can be rolled back through Wrangler/Cloudflare, but database schema changes need a separate recovery plan. Prefer forward-fix migrations. Before a risky migration, document the expected write compatibility and rehearse a D1 Time Travel restore against a non-production database. A restore overwrites the target database state. R2 file retention and D1 point-in-time recovery are separate; verify both against the permanent-retention policy. This repository does not include an automatic destructive rollback.

## Cloudflare cost notes

Pricing changes over time; confirm the current Cloudflare dashboard and calculators before launch. This deployment does not provision a Container, so it avoids Container usage. Workers, D1, R2 and Queues have plan-specific usage limits and charges. Enabling malware scanning later adds Container and Durable Object costs; measure actual scanner uptime and request volume before forecasting production cost.

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
- [Container limits and instance sizes](https://developers.cloudflare.com/containers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

The Zellink Cloudflare account has the D1, private R2, and queue resources for this app, and its database migrations are applied. The app Worker and `app.zellinkstudio.com` are deployed. The production bootstrap secret is configured; create the first administrator account once, then remove the bootstrap secret.
