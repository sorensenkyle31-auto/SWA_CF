# SWA_CF — Stone Wall Angus on Cloudflare

Private Cloudflare deployment of the Stone Wall Angus site and admin tool, gated behind Cloudflare Access for local/staging testing before a public launch.

This is a Cloudflare-specific companion to the main [SWA](../SWA) repo — the source of truth for the site and admin tool lives there. This repo exists because the backend had to be rewritten for the Workers runtime (see `cf-worker/` below); everything here should be kept in sync with SWA when the frontend files change.

## Project structure

- **`stonewallangus-modern.html`** — customer-facing site, deployed as a static file via Cloudflare Pages
- **`swa-admin.html`** — admin order-management tool, deployed as a static file via Cloudflare Pages
- **`cf-worker/`** — the backend, rewritten from the original Node/Express `server.js` to run on Cloudflare Workers

## Why the backend was rewritten

Cloudflare Workers don't run a persistent Node/Express server — they run short-lived, stateless request handlers. Three things in the original backend needed adapting:

| Original (Node/Express) | Workers version | Why |
|---|---|---|
| In-memory `Map` for admin sessions | Cloudflare KV (`ADMIN_SESSIONS` binding) | A Map doesn't survive between requests/isolates on Workers |
| `nodemailer` over SMTP | Mailchannels HTTP API | Workers can't open raw TCP connections for SMTP |
| `twilio` npm SDK | Direct `fetch()` calls to Twilio's REST API | The SDK isn't Workers-compatible; the underlying API is unchanged |

Everything else — Supabase REST calls, all order/invoice business logic, the HTML email templates — is functionally identical to `server.js`.

## Deploying

### 1. Backend (Cloudflare Worker)

```bash
cd cf-worker
npm install
npx wrangler login

# Create the KV namespace for admin sessions, then paste the returned id
# into wrangler.toml under [[kv_namespaces]]
npx wrangler kv:namespace create ADMIN_SESSIONS

# Set secrets (prompted interactively — never commit these)
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN

# Edit wrangler.toml [vars] with your real Twilio numbers, then:
npx wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://swa-backend.<your-subdomain>.workers.dev`.

**Required DNS record for email.** Mailchannels silently drops emails unless your sending domain authorizes your Worker. Add this TXT record on the domain used in `EMAIL_FROM`:

```
Host:  _mailchannels
Type:  TXT
Value: v=mc1 cfid=<your-worker-subdomain>.workers.dev
```

### 2. Frontend (Cloudflare Pages)

In both HTML files, update:
```js
const API='http://localhost:3001/api';
```
to your deployed Worker URL:
```js
const API='https://swa-backend.<your-subdomain>.workers.dev/api';
```

Then deploy from the repo root:
```bash
npx wrangler pages deploy . --project-name=swa-site
```

### 3. Lock it down with Cloudflare Access

Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**.

Create **two** Access applications — one for the Pages domain, one for the Worker domain (the Worker's API is otherwise reachable directly, bypassing the site's login). For each, add a policy: **Include → Emails → your email only**.

Now both URLs require an email one-time-code login before anything loads.

### 4. Test end-to-end

Place a test order on the site, confirm it in `/swa-admin.html`, invoice it, and confirm the email arrives before treating this as launch-ready.
