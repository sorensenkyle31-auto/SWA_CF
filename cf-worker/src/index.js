// Stone Wall Angus — Cloudflare Workers backend
// Ported from server.js (Node/Express) to run on the Workers runtime.
//
// Key differences from the original Express server, and why:
//  - Admin sessions: an in-memory Map doesn't survive across Worker isolates/requests,
//    so sessions are now stored in a Cloudflare KV namespace (binding: ADMIN_SESSIONS)
//    with a built-in TTL instead of the old setInterval cleanup.
//  - Email: nodemailer/SMTP needs a raw TCP connection, which Workers can't open.
//    Email now goes through Mailchannels' HTTP API (free for Cloudflare Workers).
//    IMPORTANT: Mailchannels requires a DNS "domain lockdown" TXT record on your
//    sending domain, or it will silently reject sends — see README for the exact record.
//  - SMS: the twilio npm SDK doesn't run on Workers, so SMS now calls Twilio's
//    REST API directly via fetch() with HTTP Basic Auth — same underlying API,
//    just without the SDK wrapper.
//  - Static file serving is removed — Cloudflare Pages serves the HTML files;
//    this Worker is the API only.
//  - Session tokens use crypto.getRandomValues() (Web Crypto) instead of Node's
//    crypto.randomBytes().

import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();
app.use('*', cors({ origin: '*' }));
app.onError((err, c) => {
  console.error('Unhandled error:', err.message);
  return c.json({ error: err.message }, 500);
});

// ── Supabase REST helper (unchanged logic from server.js — already fetch-based) ─
async function sb(env, method, table, body = null, query = '', tenantId) {
  // tenantId is required, not optional — a missing/forgotten tenantId throws
  // loudly right here rather than silently skipping tenant isolation, which
  // is the failure mode that actually matters (a missed filter should break
  // immediately and obviously, not quietly leak data once a second tenant exists).
  if (tenantId === undefined) {
    throw new Error(`sb() called without tenantId for table "${table}" — every query must be tenant-scoped.`);
  }
  let finalQuery = query;
  let finalBody = body;
  if (tenantId !== null) { // null is the deliberate escape hatch for the tenants table itself, see below
    if (method === 'GET' || method === 'PATCH' || method === 'DELETE') {
      const sep = finalQuery.includes('?') ? '&' : '?';
      finalQuery = `${finalQuery}${sep}tenant_id=eq.${tenantId}`;
    }
    if (method === 'POST' && finalBody) {
      finalBody = Array.isArray(finalBody)
        ? finalBody.map(row => ({ ...row, tenant_id: tenantId }))
        : { ...finalBody, tenant_id: tenantId };
    }
  }
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${finalQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': (method === 'POST' || method === 'PATCH') ? 'return=representation' : '',
    },
    ...(finalBody ? { body: JSON.stringify(finalBody) } : {}),
  });
  const text = await res.text();
  if (!res.ok) console.error(`  x ${res.status}:`, text);
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch(e) { data = { error: `Non-JSON response from Supabase (status ${res.status})`, raw: text.slice(0,500) }; }
  }
  return { status: res.status, data };
}

// ── Tenant resolution ────────────────────────────────────────────────────────
// Determines which business a request belongs to, based on the domain it
// arrived on. Cached per-domain (same pattern as business config) to avoid a
// DB round-trip on every request. Falls back to tenant 1 (Stone Wall Angus)
// on any lookup failure — safe for now since it's the only tenant that
// exists, and prevents a lookup hiccup from taking the whole site down.
let _tenantCache = new Map(); // domain -> {tenantId, time}
const TENANT_CACHE_TTL_MS = 60000;

async function getTenantId(c) {
  const host = c.req.header('host') || '';
  const now = Date.now();
  const cached = _tenantCache.get(host);
  if (cached && (now - cached.time) < TENANT_CACHE_TTL_MS) {
    console.log(`  Tenant resolved: ${host} -> tenant ${cached.tenantId} (cached)`);
    return cached.tenantId;
  }
  try {
    // tenantId: null here is the deliberate escape hatch mentioned in sb()
    // above — the tenants table itself isn't tenant-scoped (it's what DEFINES
    // the tenants), so it can't filter by the very thing it's resolving.
    const { data } = await sb(c.env, 'GET','tenants',null,`?domain=eq.${encodeURIComponent(host)}&limit=1`, null);
    const tenantId = data?.[0]?.id ?? 1;
    _tenantCache.set(host, { tenantId, time: now });
    console.log(`  Tenant resolved: ${host} -> tenant ${tenantId} (fresh lookup)`);
    return tenantId;
  } catch(e) {
    console.error('  Tenant resolution failed, defaulting to tenant 1:', e.message);
    return 1;
  }
}

// ── Business configuration (multi-tenant foundation) ────────────────────────
// Every business-identity value (name, contact info, hours, categories,
// links) used to be hardcoded throughout this file. It's now pulled from a
// single database record instead — the first real step toward this codebase
// eventually serving more than one business. DEFAULT_CONFIG is a safety net:
// if the business_config table/row doesn't exist yet (e.g. migration hasn't
// run), the site keeps working with Stone Wall Angus's real current values
// rather than breaking outright.
const DEFAULT_CONFIG = {
  business_name: 'Stone Wall Angus',
  phone: '(240) 818-8317',
  phone_raw: '2408188317',
  email: 'stonewallangus1@myactv.net',
  address_street: '17719 Spielman Road',
  address_city: 'Fairplay',
  address_state: 'MD',
  address_zip: '21733',
  logo_url: 'https://kwwacoafkttxwfrgtkmd.supabase.co/storage/v1/object/public/SWA/img/StoneWallAngus_Thumb.png',
  brand_color: '#6B1F1F',
  pickup_days: [3, 6],
  visit_days: [3, 6],
  visit_hour_start: 8,
  visit_hour_end: 10,
  category_order: ['Beef', 'Pork', 'Dairy'],
  google_review_url: 'https://g.page/r/CSmYIWx9gpa4EBM/review',
  facebook_url: 'https://www.facebook.com/stonewallangus',
};

let _configCache = new Map(); // tenantId -> {config, time}
const CONFIG_CACHE_TTL_MS = 60000; // 1 minute — avoids a DB round-trip on every request while still picking up real changes quickly

async function getBusinessConfig(env, tenantId) {
  const now = Date.now();
  const cached = _configCache.get(tenantId);
  if (cached && (now - cached.time) < CONFIG_CACHE_TTL_MS) return cached.config;
  try {
    const { data } = await sb(env, 'GET','business_config',null,'?limit=1', tenantId);
    const config = data?.[0];
    if (!config) {
      console.error(`  business_config row not found for tenant ${tenantId} — using hardcoded defaults`);
      return DEFAULT_CONFIG;
    }
    const merged = { ...DEFAULT_CONFIG, ...config }; // merge so a missing new column never breaks an old row
    _configCache.set(tenantId, { config: merged, time: now });
    return merged;
  } catch(e) {
    console.error('  business_config fetch failed, using hardcoded defaults:', e.message);
    return DEFAULT_CONFIG;
  }
}

// ── SMS via Twilio's REST API directly (no SDK) ─────────────────────────────────
async function sendSMS(env, to, msg) {
  if (!to || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;
  try {
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const body = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: msg });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) console.warn('  SMS failed:', res.status, await res.text());
    else console.log('  SMS sent ->', to);
  } catch(e) { console.warn('  SMS failed:', e.message); }
}

// ── Email via Resend's HTTP API ─────────────────────────────────────────────
// (Mailchannels' free Cloudflare Workers email API was shut down in August
// 2024 — Resend is Cloudflare's current recommended replacement.)
async function sendEmail(env, to, subject, text, html, tenantId) {
  if (!to) return;
  const fromAddr = env.EMAIL_FROM || env.EMAIL_FARM;
  if (!fromAddr) { console.warn('  Email skipped: no EMAIL_FROM configured'); return; }
  if (!env.RESEND_API_KEY) { console.warn('  Email skipped: no RESEND_API_KEY configured'); return; }
  const config = await getBusinessConfig(env, tenantId);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${config.business_name} <${fromAddr}>`,
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
      }),
    });
    if (!res.ok) console.warn('  Email failed:', res.status, await res.text());
    else console.log('  Email sent ->', to);
  } catch(e) { console.warn('  Email failed:', e.message); }
}

function fmtPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '').slice(-10);
  return digits.length === 10 ? '+1' + digits : null;
}

async function sendNewOrderAlert(env, order, items, tenantId) {
  const config = await getBusinessConfig(env, tenantId);
  const itemList = items.map(i => `${i.name} x${i.qty||1}`).join(', ');
  const sms = `New Order: ${order.order_number}\n${order.customer_name} | ${order.customer_phone||order.customer_email}\nItems: ${itemList}\nPickup: ${order.pickup_date||'TBD'}`;
  await sendSMS(env, env.TWILIO_NOTIFY, sms);
  const email =
    `New order received.\n\nORDER: ${order.order_number}\nCustomer: ${order.customer_name}\nEmail: ${order.customer_email}\nPhone: ${order.customer_phone||'N/A'}\nPickup: ${order.pickup_date||'TBD'}\n${order.notes?'Notes: '+order.notes+'\n':''}\nItems:\n${items.map(i=>`  - ${i.name} x${i.qty||1}`).join('\n')}\n\nOpen the admin app to enter weights and send the invoice.`;
  await sendEmail(env, env.EMAIL_FARM||config.email, `New Order - ${order.order_number}`, email, undefined, tenantId);
}

// ── Internal alert: order paid online (staff wouldn't otherwise know a
//    remote/online payment just came in — this doesn't fire for orders staff
//    mark paid themselves in the admin tool, since they already know) ────────
async function sendAdminOrderPaidAlert(env, order, amount, method) {
  const sms = `💰 Payment Received\nOrder: ${order.order_number}\n${order.customer_name} - $${amount.toFixed(2)}\nPaid via ${method||'PayPal online'}.`;
  await sendSMS(env, env.TWILIO_NOTIFY, sms);
}

// ── PayPal invoice link (STUB — same as server.js, replace when ready) ─────────
// ── PayPal Invoicing API (real integration) ─────────────────────────────────────
// Creates a draft invoice, sends it (without PayPal's own customer email — we use
// our own branded email/SMS instead), then fetches the resulting payer-facing
// payment URL. Falls back to a stub link if PayPal isn't configured yet or any
// call fails, so invoice sending never breaks just because PayPal had a hiccup.
async function getPayPalAccessToken(env) {
  const base = env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function createPayPalInvoiceLink(env, order, items, total, tenantId) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    console.warn('  PayPal not configured — using stub link');
    return { url: createStubPayPalLink(order, total), invoiceNumber: null };
  }
  const config = await getBusinessConfig(env, tenantId);
  try {
    // Only include a recipient name if we genuinely have both parts — an empty
    // surname (e.g. a single-word customer name) is accepted by the create-invoice
    // call but appears to leave the invoice in a state PayPal's own payer-view
    // page can't render (confirmed by testing: a minimal request without any
    // name field produces a working link; matching that minimal shape here).
    const nameParts = (order.customer_name||'').trim().split(/\s+/).filter(Boolean);
    const givenName = nameParts[0] || '';
    const surname = nameParts.slice(1).join(' ');
    const recipientName = (givenName && surname) ? { given_name: givenName, surname: surname } : undefined;
    const base = env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const token = await getPayPalAccessToken(env);
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 1. Create a draft invoice from the order's line items
    const invoiceItems = (items.length ? items : [{ product_name: order.order_number, line_total: total }])
      .map(i => ({
        name: i.product_name || 'Order item',
        quantity: '1',
        unit_amount: { currency_code: 'USD', value: parseFloat(i.line_total || total).toFixed(2) },
      }));
    const createRes = await fetch(`${base}/v2/invoicing/invoices`, {
      method: 'POST', headers,
      body: JSON.stringify({
        detail: { currency_code: 'USD', reference: order.order_number, note: `${config.business_name} order ${order.order_number}` },
        invoicer: { business_name: config.business_name },
        primary_recipients: [{ billing_info: { email_address: order.customer_email, ...(recipientName ? { name: recipientName } : {}) } }],
        items: invoiceItems,
      }),
    });
    if (!createRes.ok) throw new Error(`PayPal create invoice failed (${createRes.status}): ${await createRes.text()}`);
    const created = await createRes.json();
    // PayPal's create-invoice response sometimes returns the ID directly as
    // `id`, and sometimes only embedded in an `href` URL — handle both.
    const invoiceId = created.id || (created.href ? created.href.split('/').filter(Boolean).pop() : null);
    if (!invoiceId) console.error('  PayPal create response (no id/href found):', JSON.stringify(created));
    if (!invoiceId) throw new Error('PayPal did not return an invoice id');

    // 2. Send it. We no longer need PayPal's own payer-view page to work at all
    // (customers pay via our own Expanded Checkout /pay page instead), so
    // send_to_recipient is back to false — this stops PayPal from emailing the
    // customer directly with a competing "View and Pay Invoice" link that
    // points at the old hosted page we specifically moved away from.
    const sendRes = await fetch(`${base}/v2/invoicing/invoices/${invoiceId}/send`, {
      method: 'POST', headers,
      body: JSON.stringify({ send_to_recipient: false, send_to_invoicer: false }),
    });
    if (!sendRes.ok) throw new Error(`PayPal send invoice failed (${sendRes.status}): ${await sendRes.text()}`);

    // 3. Fetch the invoice — we keep this record for Kyle's own PayPal-side
    // bookkeeping. invoice_number is PayPal's own human-readable reference
    // (shown on their dashboard/reports), separate from our internal order_number.
    const getRes = await fetch(`${base}/v2/invoicing/invoices/${invoiceId}`, { headers });
    if (!getRes.ok) throw new Error(`PayPal get invoice failed (${getRes.status}): ${await getRes.text()}`);
    const invoice = await getRes.json();
    const payUrl = invoice?.detail?.metadata?.recipient_view_url || null;
    const invoiceNumber = invoice?.detail?.invoice_number || invoiceId;

    console.log('  PayPal invoice created ->', invoiceId, 'invoice_number:', invoiceNumber);
    return { url: payUrl || createStubPayPalLink(order, total), invoiceNumber };
  } catch(e) {
    console.error('  PayPal invoice creation failed, falling back to stub link:', e.message);
    return { url: createStubPayPalLink(order, total), invoiceNumber: null };
  }
}

function createStubPayPalLink(order, total) {
  const params = new URLSearchParams({ order: order.order_number, amount: total.toFixed(2) });
  return `https://www.paypal.com/invoice/pay/STUB?${params.toString()}`;
}

// ── HTML invoice email body (identical markup to server.js) ────────────────────
function buildInvoiceEmailHtml(order, items, subtotal, total, paypalLink, paypalInvoiceNumber, config) {
  const orderDate = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const rows = items.map(i => `
        <tr>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:14px;color:#1A1A1A;font-weight:600;">${i.product_name}</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:13px;color:#6B6B6B;text-align:center;">${i.weight_lbs || 0} lb</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:13px;color:#6B6B6B;text-align:center;">$${parseFloat(i.actual_price_lb || i.price_per_unit || 0).toFixed(2)}/lb</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:14px;color:#1A1A1A;font-weight:700;text-align:right;">$${parseFloat(i.line_total || 0).toFixed(2)}</td>
        </tr>`).join('');
  const notesRow = order.notes ? `
        <tr><td style="padding:8px 32px 24px;"><div style="font-size:12px;color:#8A8A8A;font-style:italic;">Notes: ${order.notes}</div></td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${order.order_number} — ${config.business_name}</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F1EA;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <tr><td style="padding:28px 32px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top">
            <div style="display:flex;align-items:center;gap:8px;font-size:19px;font-weight:800;color:${config.brand_color};"><img src="${config.logo_url}" alt="${config.business_name}" width="36" height="28" style="height:28px;width:36px;display:inline-block;vertical-align:middle;"/> ${config.business_name}</div>
            <div style="font-size:13px;color:#6B6B6B;margin-top:8px;line-height:1.5;">${config.address_street}, ${config.address_city}, ${config.address_state} ${config.address_zip}<br>${config.phone} &middot; ${config.email}</div>
          </td>
          <td valign="top" align="right">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;">Invoice</div>
            <div style="font-size:20px;font-weight:800;color:${config.brand_color};margin-top:4px;">${order.order_number}</div>
            ${paypalInvoiceNumber ? `<div style="font-size:11px;color:#8A8A8A;margin-top:2px;">PayPal Invoice: ${paypalInvoiceNumber}</div>` : ''}
            <div style="font-size:12px;color:#8A8A8A;margin-top:4px;">${orderDate}</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="border-top:1px solid #EAE6DE;"></td></tr>
      <tr><td style="padding:20px 32px 4px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;margin-bottom:8px;">Bill To</div>
        <div style="font-size:15px;font-weight:700;color:#1A1A1A;">${order.customer_name || ''}</div>
        <div style="font-size:13px;color:#6B6B6B;margin-top:2px;">${order.customer_email || ''} &middot; ${order.customer_phone || ''}</div>
        <div style="font-size:13px;color:#6B6B6B;margin-top:2px;">Preferred Pickup: ${order.pickup_date || 'TBD'}</div>
      </td></tr>
      <tr><td style="padding:20px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #EAE6DE;">
          <tr style="background-color:${config.brand_color};">
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;">Cut</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:center;">Weight</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:center;">Rate</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:right;">Amount</td>
          </tr>${rows}
        </table>
      </td></tr>
      <tr><td style="padding:16px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td></td><td width="220">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:6px 0;font-size:13px;color:#6B6B6B;">Subtotal</td><td style="padding:6px 0;font-size:13px;color:#1A1A1A;text-align:right;">$${subtotal.toFixed(2)}</td></tr>
            <tr><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:16px;font-weight:800;color:#1A1A1A;">Total Due</td><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:18px;font-weight:800;color:${config.brand_color};text-align:right;">$${total.toFixed(2)}</td></tr>
          </table>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:28px 32px 8px;" align="center">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background-color:#FFC439;">
          <a href="${paypalLink}" target="_blank" style="display:inline-block;padding:14px 40px;font-size:15px;font-weight:800;color:#1A1A1A;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">Pay with PayPal</a>
        </td></tr></table>
        <div style="font-size:12px;color:#8A8A8A;margin-top:10px;">Secure payment powered by PayPal. No PayPal account required.</div>
      </td></tr>
      <tr><td style="padding:20px 32px 4px;">
        <span style="display:inline-block;padding:6px 16px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;background-color:#EAF4E1;color:#4A7729;border:1px solid #C3DFA8;">Invoiced</span>
      </td></tr>${notesRow}
      <tr><td style="padding:20px 32px;background-color:#F9F7F2;border-top:1px solid #EAE6DE;">
        <div style="font-size:12px;color:#8A8A8A;text-align:center;line-height:1.6;">Questions about this invoice? Reply to this email or call ${config.phone}.<br>${config.business_name} &middot; Family-owned since 1989 &middot; Fairplay, MD</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendInvoiceNotification(env, order, items, tenantId) {
  const config = await getBusinessConfig(env, tenantId);
  const subtotal  = items.reduce((s,i) => s + parseFloat(i.line_total||0), 0);
  const total     = subtotal;
  const firstName = (order.customer_name||'').split(' ')[0] || 'Customer';

  // Still create a real PayPal invoice for Kyle's own PayPal-side record-keeping
  // (shows up in his PayPal dashboard/reports), but customers no longer get sent
  // to PayPal's hosted page at all — they pay on our own branded page instead
  // (see the /pay/:orderNumber route), which sidesteps the whole class of issue
  // we hit with PayPal's hosted invoice links breaking when opened from SMS.
  const { url: paypalLink, invoiceNumber: paypalInvoiceNumber } = await createPayPalInvoiceLink(env, order, items, total, tenantId);
  await sb(env, 'PATCH','orders',{paypal_pay_url:paypalLink,paypal_invoice_number:paypalInvoiceNumber},`?id=eq.${order.id}`, tenantId).catch(e=>console.warn('  Could not save paypal_pay_url:', e.message));

  const payPageUrl = `${env.PUBLIC_API_URL || ''}/pay/${encodeURIComponent(order.order_number)}`;

  const lineItems = items.map(i =>
    `  ${i.product_name} - ${i.weight_lbs||0} lbs @ $${parseFloat(i.actual_price_lb||i.price_per_unit||0).toFixed(2)}/lb = $${parseFloat(i.line_total||0).toFixed(2)}`
  ).join('\n');
  const emailText =
    `Dear ${firstName},\n\nYour order is weighed and your invoice is ready.\n\nORDER: ${order.order_number}${paypalInvoiceNumber?` (PayPal Invoice: ${paypalInvoiceNumber})`:''}\n\nINVOICE\n${lineItems}\n\n` +
    `Subtotal:  $${subtotal.toFixed(2)}\nShipping:  Free\nTOTAL DUE: $${total.toFixed(2)}\n\n` +
    `Pay online: ${payPageUrl}\n\n` +
    `Please arrange payment before pickup: ${order.pickup_date||'TBD'}\nCall ${config.phone} or email ${config.email}\n\n${config.business_name}`;
  const emailHtml = buildInvoiceEmailHtml(order, items, subtotal, total, payPageUrl, paypalInvoiceNumber, config);

  await sendEmail(env, order.customer_email, `Invoice - ${config.business_name} ${order.order_number}`, emailText, emailHtml, tenantId);
  if (order.sms_consent) {
    const sms = `Invoice Ready - ${config.business_name}\nOrder: ${order.order_number}\nTotal: $${total.toFixed(2)}\nPay securely: ${payPageUrl}\nQuestions? ${config.phone}\n(Tip: save this number as "${config.business_name}" for easy reference!)`;
    await sendSMS(env, fmtPhone(order.customer_phone), sms);
  }
}

// ── HTML "Ready for Pickup" email (identical markup to server.js) ──────────────
function buildReadyPickupEmailHtml(order, items, total, config) {
  const orderDate = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const rows = (items||[]).map(i => `
        <tr>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:14px;color:#1A1A1A;font-weight:600;">${i.product_name}</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:13px;color:#6B6B6B;text-align:center;">${i.weight_lbs || 0} lb</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:14px;color:#1A1A1A;font-weight:700;text-align:right;">$${parseFloat(i.line_total || 0).toFixed(2)}</td>
        </tr>`).join('');
  const notesRow = order.notes ? `
        <tr><td style="padding:8px 32px 24px;"><div style="font-size:12px;color:#8A8A8A;font-style:italic;">Notes: ${order.notes}</div></td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Order Ready ${order.order_number} — ${config.business_name}</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F1EA;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <tr><td style="padding:28px 32px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top">
            <div style="display:flex;align-items:center;gap:8px;font-size:19px;font-weight:800;color:${config.brand_color};"><img src="${config.logo_url}" alt="${config.business_name}" width="36" height="28" style="height:28px;width:36px;display:inline-block;vertical-align:middle;"/> ${config.business_name}</div>
            <div style="font-size:13px;color:#6B6B6B;margin-top:8px;line-height:1.5;">${config.address_street}, ${config.address_city}, ${config.address_state} ${config.address_zip}<br>${config.phone} &middot; ${config.email}</div>
          </td>
          <td valign="top" align="right">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;">Order</div>
            <div style="font-size:20px;font-weight:800;color:${config.brand_color};margin-top:4px;">${order.order_number}</div>
            <div style="font-size:12px;color:#8A8A8A;margin-top:4px;">${orderDate}</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="border-top:1px solid #EAE6DE;"></td></tr>
      <tr><td style="padding:20px 32px 4px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;margin-bottom:8px;">Ready For</div>
        <div style="font-size:15px;font-weight:700;color:#1A1A1A;">${order.customer_name || ''}</div>
        <div style="font-size:13px;color:#6B6B6B;margin-top:2px;">${order.customer_email || ''} &middot; ${order.customer_phone || ''}</div>
        <div style="font-size:13px;color:#6B6B6B;margin-top:2px;">Pickup Date: ${order.pickup_date || 'TBD'}</div>
      </td></tr>
      <tr><td style="padding:20px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #EAE6DE;">
          <tr style="background-color:${config.brand_color};">
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;">Cut</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:center;">Weight</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:right;">Amount</td>
          </tr>${rows}
        </table>
      </td></tr>
      <tr><td style="padding:16px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td></td><td width="220">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:16px;font-weight:800;color:#1A1A1A;">Total Paid</td><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:18px;font-weight:800;color:${config.brand_color};text-align:right;">$${total.toFixed(2)}</td></tr>
          </table>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:24px 32px 8px;">
        <div style="background-color:#E3F2FD;border:1px solid #90CAF9;border-radius:10px;padding:14px 16px;font-size:13px;color:#1A1A1A;line-height:1.6;">
          <strong style="color:#2471A3;">Pickup Location</strong><br>
          ${config.address_street}, ${config.address_city}, ${config.address_state} ${config.address_zip}<br>
          Questions? Call ${config.phone}.
        </div>
      </td></tr>
      <tr><td style="padding:20px 32px 4px;">
        <span style="display:inline-block;padding:6px 16px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;background-color:#E3F2FD;color:#2471A3;border:1px solid #90CAF9;">Ready for Pickup</span>
      </td></tr>${notesRow}
      <tr><td style="padding:20px 32px;background-color:#F9F7F2;border-top:1px solid #EAE6DE;">
        <div style="font-size:12px;color:#8A8A8A;text-align:center;line-height:1.6;">Questions about this order? Reply to this email or call ${config.phone}.<br>${config.business_name} &middot; Family-owned since 1989 &middot; Fairplay, MD</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── HTML "Completed Transaction" receipt (walk-in orders only — one combined
//    notification instead of separate invoice + ready-for-pickup emails) ──────
function buildWalkInReceiptEmailHtml(order, items, total, config) {
  const orderDate = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const rows = items.map(i => `
        <tr>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:14px;color:#1A1A1A;font-weight:600;">${i.product_name}</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:13px;color:#6B6B6B;text-align:center;">${i.weight_lbs || 0} lb</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:13px;color:#6B6B6B;text-align:center;">$${parseFloat(i.actual_price_lb || i.price_per_unit || 0).toFixed(2)}/lb</td>
          <td style="padding:14px 24px;border-bottom:1px solid #EAE6DE;font-size:14px;color:#1A1A1A;font-weight:700;text-align:right;">$${parseFloat(i.line_total || 0).toFixed(2)}</td>
        </tr>`).join('');
  const notesRow = order.notes ? `
        <tr><td style="padding:8px 32px 24px;"><div style="font-size:12px;color:#8A8A8A;font-style:italic;">Notes: ${order.notes}</div></td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Receipt ${order.order_number} — ${config.business_name}</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F1EA;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <tr><td style="padding:28px 32px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top">
            <div style="display:flex;align-items:center;gap:8px;font-size:19px;font-weight:800;color:${config.brand_color};"><img src="${config.logo_url}" alt="${config.business_name}" width="36" height="28" style="height:28px;width:36px;display:inline-block;vertical-align:middle;"/> ${config.business_name}</div>
            <div style="font-size:13px;color:#6B6B6B;margin-top:8px;line-height:1.5;">${config.address_street}, ${config.address_city}, ${config.address_state} ${config.address_zip}<br>${config.phone} &middot; ${config.email}</div>
          </td>
          <td valign="top" align="right">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;">Receipt</div>
            <div style="font-size:20px;font-weight:800;color:${config.brand_color};margin-top:4px;">${order.order_number}</div>
            <div style="font-size:12px;color:#8A8A8A;margin-top:4px;">${orderDate}</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="border-top:1px solid #EAE6DE;"></td></tr>
      <tr><td style="padding:20px 32px 4px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;margin-bottom:8px;">Sold To</div>
        <div style="font-size:15px;font-weight:700;color:#1A1A1A;">${order.customer_name || ''}</div>
        <div style="font-size:13px;color:#6B6B6B;margin-top:2px;">${order.customer_email || ''} &middot; ${order.customer_phone || ''}</div>
      </td></tr>
      <tr><td style="padding:20px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:8px;overflow:hidden;border:1px solid #EAE6DE;">
          <tr style="background-color:${config.brand_color};">
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;">Cut</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:center;">Weight</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:center;">Rate</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:right;">Amount</td>
          </tr>${rows}
        </table>
      </td></tr>
      <tr><td style="padding:16px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td></td><td width="220">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:16px;font-weight:800;color:#1A1A1A;">Total Paid</td><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:18px;font-weight:800;color:${config.brand_color};text-align:right;">$${total.toFixed(2)}</td></tr>
          </table>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:20px 32px 4px;">
        <span style="display:inline-block;padding:6px 16px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;background-color:#EAF4E1;color:#4A7729;border:1px solid #C3DFA8;">Paid in Full &middot; Complete</span>
      </td></tr>${notesRow}
      <tr><td style="padding:20px 32px;background-color:#F9F7F2;border-top:1px solid #EAE6DE;">
        <div style="font-size:12px;color:#8A8A8A;text-align:center;line-height:1.6;">Thank you for stopping by! Questions? Reply to this email or call ${config.phone}.<br>${config.business_name} &middot; Family-owned since 1989 &middot; Fairplay, MD</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── Payment received confirmation (fires when a customer pays via the /pay
//    page — distinct from the later "Ready for Pickup" notice, which still
//    only fires once staff mark items as prepared) ─────────────────────────
function buildPaymentReceivedEmailHtml(order, amount, config) {
  const firstName = (order.customer_name||'').split(' ')[0] || 'there';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Payment Received — ${config.business_name}</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F1EA;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <tr><td style="padding:32px 32px 8px;text-align:center;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:19px;font-weight:800;color:${config.brand_color};"><img src="${config.logo_url}" alt="${config.business_name}" width="36" height="28" style="height:28px;width:36px;display:inline-block;vertical-align:middle;"/> ${config.business_name}</div>
      </td></tr>
      <tr><td style="padding:16px 32px 8px;text-align:center;">
        <div style="font-size:34px;margin-bottom:8px;">✅</div>
        <div style="font-size:20px;font-weight:800;color:#1A1A1A;margin-bottom:10px;">Payment Received, ${firstName}!</div>
        <div style="font-size:14px;color:#6B6B6B;line-height:1.6;max-width:440px;margin:0 auto;">We've received your payment of $${amount.toFixed(2)} for order ${order.order_number}. Your beef is paid in full — we'll text/email you again once it's weighed, packed, and ready for pickup.</div>
      </td></tr>
      <tr><td style="padding:20px 32px;background-color:#F9F7F2;border-top:1px solid #EAE6DE;margin-top:20px;">
        <div style="font-size:12px;color:#8A8A8A;text-align:center;line-height:1.6;">Questions? Reply to this email or call ${config.phone}.<br>${config.business_name} &middot; Family-owned since 1989 &middot; Fairplay, MD</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendPaymentReceivedNotification(env, order, amount, tenantId) {
  const config = await getBusinessConfig(env, tenantId);
  const firstName = (order.customer_name||'').split(' ')[0] || 'Customer';
  const emailText = `Hi ${firstName},\n\nWe've received your payment of $${amount.toFixed(2)} for order ${order.order_number}. Paid in full — we'll notify you again once it's ready for pickup.\n\n${config.business_name}\n${config.phone}`;
  const emailHtml = buildPaymentReceivedEmailHtml(order, amount, config);
  await sendEmail(env, order.customer_email, `Payment Received - ${config.business_name} ${order.order_number}`, emailText, emailHtml, tenantId);

  if (order.sms_consent) {
    const sms = `Payment received! Order ${order.order_number} is paid in full ($${amount.toFixed(2)}). We'll text you again once it's ready for pickup.\nQuestions? ${config.phone}`;
    await sendSMS(env, fmtPhone(order.customer_phone), sms);
  }
}

async function sendWalkInReceipt(env, order, tenantId) {
  const config = await getBusinessConfig(env, tenantId);
  let items = [];
  try { const r = await sb(env, 'GET','order_items',null,`?order_id=eq.${order.id}&order=id.asc`, tenantId); items = r.data || []; }
  catch(e) { console.warn('  Could not load items for receipt:', e.message); }
  const total = items.reduce((s,i) => s + parseFloat(i.line_total||0), 0) || parseFloat(order.final_total||0);
  const firstName = (order.customer_name||'').split(' ')[0] || 'Customer';
  const itemList = items.map(i => `${i.product_name} (${i.weight_lbs||0} lbs @ $${parseFloat(i.actual_price_lb||i.price_per_unit||0).toFixed(2)}/lb)`).join(', ');

  const emailText =
    `Thank you, ${firstName}!\n\nHere's your receipt for order ${order.order_number}:\n\n${items.map(i=>`  ${i.product_name} - ${i.weight_lbs||0} lbs = $${parseFloat(i.line_total||0).toFixed(2)}`).join('\n')}\n\nTOTAL PAID: $${total.toFixed(2)}\n\nPaid in full — thanks for stopping by!\n\n${config.business_name}\n${config.phone}`;
  const emailHtml = buildWalkInReceiptEmailHtml(order, items, total, config);
  await sendEmail(env, order.customer_email, `Receipt - ${config.business_name} ${order.order_number}`, emailText, emailHtml, tenantId);

  if (order.sms_consent) {
    const sms = `Thank you! Receipt for order ${order.order_number}\n${itemList?'Items: '+itemList+'\n':''}TOTAL PAID: $${total.toFixed(2)}\nPaid in full. Thanks for stopping by ${config.business_name}!\nQuestions? ${config.phone}\n(Tip: save this number as "${config.business_name}" for easy reference!)`;
    await sendSMS(env, fmtPhone(order.customer_phone), sms);
  }
}

async function sendReadyForPickup(env, order, tenantId) {
  const config = await getBusinessConfig(env, tenantId);
  const fullAddress = `${config.address_street}, ${config.address_city}, ${config.address_state} ${config.address_zip}`;
  const shortAddress = `${config.address_street}, ${config.address_city} ${config.address_state}`;
  if (order.sms_consent) {
    const sms = `Your ${config.business_name} order is ready for pickup!\nOrder: ${order.order_number}\n${order.pickup_date?'Date: '+order.pickup_date+'\n':''}${shortAddress}\nQuestions? ${config.phone}`;
    await sendSMS(env, fmtPhone(order.customer_phone), sms);
  }

  let items = [];
  try { const r = await sb(env, 'GET','order_items',null,`?order_id=eq.${order.id}&order=id.asc`, tenantId); items = r.data || []; }
  catch(e) { console.warn('  Could not load items for ready email:', e.message); }
  const total = items.reduce((s,i) => s + parseFloat(i.line_total||0), 0) || parseFloat(order.final_total||0);

  const firstName = (order.customer_name||'').split(' ')[0] || 'Customer';
  const emailText =
    `Dear ${firstName},\n\nYour order is ready for pickup!\n\nOrder: ${order.order_number}\n${order.pickup_date?'Pickup Date: '+order.pickup_date+'\n':''}Location: ${fullAddress}\n\nSee you soon!\n\n${config.business_name}\n${config.phone}`;
  const emailHtml = buildReadyPickupEmailHtml(order, items, total, config);
  await sendEmail(env, order.customer_email, `Order Ready for Pickup - ${config.business_name} ${order.order_number}`, emailText, emailHtml, tenantId);
}

// ── HTML "Leave us a review" email (sent when an order is marked Fulfilled) ────
function buildReviewRequestEmailHtml(order, googleUrl, facebookUrl, config) {
  const firstName = (order.customer_name||'').split(' ')[0] || 'there';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>How did we do? — ${config.business_name}</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F1EA;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <tr><td style="padding:32px 32px 8px;text-align:center;">
        <div style="display:flex;align-items:center;gap:8px;font-size:19px;font-weight:800;color:${config.brand_color};"><img src="${config.logo_url}" alt="${config.business_name}" width="36" height="28" style="height:28px;width:36px;display:inline-block;vertical-align:middle;"/> ${config.business_name}</div>
      </td></tr>
      <tr><td style="padding:16px 32px 8px;text-align:center;">
        <div style="font-size:34px;margin-bottom:8px;">🙏</div>
        <div style="font-size:20px;font-weight:800;color:#1A1A1A;margin-bottom:10px;">Thanks for your order, ${firstName}!</div>
        <div style="font-size:14px;color:#6B6B6B;line-height:1.6;max-width:440px;margin:0 auto;">We hope you're enjoying your beef from order ${order.order_number}. If you have a minute, a quick review helps our small family farm more than you know.</div>
      </td></tr>
      <tr><td style="padding:24px 32px 8px;" align="center">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background-color:${config.brand_color};">
          <a href="${googleUrl}" target="_blank" style="display:inline-block;padding:14px 40px;font-size:15px;font-weight:800;color:#fff;text-decoration:none;">Leave a Google Review</a>
        </td></tr></table>
      </td></tr>
      ${facebookUrl ? `<tr><td style="padding:6px 32px 24px;" align="center">
        <a href="${facebookUrl}" target="_blank" style="font-size:13px;color:#2471A3;text-decoration:underline;">or leave a review on Facebook</a>
      </td></tr>` : ''}
      <tr><td style="padding:20px 32px;background-color:#F9F7F2;border-top:1px solid #EAE6DE;">
        <div style="font-size:12px;color:#8A8A8A;text-align:center;line-height:1.6;">Questions about your order? Reply to this email or call ${config.phone}.<br>${config.business_name} &middot; Family-owned since 1989 &middot; Fairplay, MD</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendReviewRequest(env, order, tenantId) {
  const config = await getBusinessConfig(env, tenantId);
  const googleUrl = env.GOOGLE_REVIEW_URL || config.google_review_url;
  const facebookUrl = env.FACEBOOK_URL || config.facebook_url;
  const firstName = (order.customer_name||'').split(' ')[0] || 'there';

  const emailText =
    `Hi ${firstName},\n\nThanks for your order (${order.order_number})! If you have a minute, we'd really appreciate a review:\n\nGoogle: ${googleUrl}\nFacebook: ${facebookUrl}\n\nThank you for supporting our family farm!\n\n${config.business_name}\n${config.phone}`;
  const emailHtml = buildReviewRequestEmailHtml(order, googleUrl, facebookUrl, config);
  await sendEmail(env, order.customer_email, `How did we do? - ${config.business_name}`, emailText, emailHtml, tenantId);

  if (order.sms_consent) {
    const sms = `Thanks for your order from ${config.business_name}! If you enjoyed it, we'd love a quick review: ${googleUrl}\nReply STOP to opt out.`;
    await sendSMS(env, fmtPhone(order.customer_phone), sms);
  }
}

// ── Admin sessions via KV (replaces the in-memory Map) ──────────────────────────
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2,'0')).join('');
}
async function requireAdmin(c, next) {
  const token = c.req.header('x-admin-token');
  const raw = token ? await c.env.ADMIN_SESSIONS.get(token) : null;
  if (!raw) return c.json({ error: 'Not authenticated' }, 401);
  c.set('adminUser', JSON.parse(raw).username);
  await next();
}

// ── Routes ───────────────────────────────────────────────────────────────────
// ── Public business configuration endpoint ──────────────────────────────────
// Lets the static frontend pages (which have no server-side templating of
// their own) fetch the same business-identity data the backend now uses,
// rather than having it baked into the HTML at all.
app.get('/api/business-config', async (c) => {
  const tenantId = await getTenantId(c);
  const config = await getBusinessConfig(c.env, tenantId);
  return c.json(config);
});

app.get('/api/health', async (c) => {
  // Live-check Supabase (cheap single-row select) since that's the thing most
  // worth knowing is actually working, not just configured. Twilio isn't
  // live-checked here to avoid hitting their API on every 30s poll from the
  // site — we just report whether credentials are present.
  let supabaseOk = false;
  try {
    const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/inventory?limit=1`, {
      headers: { 'apikey': c.env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${c.env.SUPABASE_ANON_KEY}` },
    });
    supabaseOk = res.ok;
  } catch(e) { /* leave supabaseOk false */ }

  const twilioConfigured = !!(c.env.TWILIO_ACCOUNT_SID && c.env.TWILIO_AUTH_TOKEN);
  const emailConfigured  = !!(c.env.EMAIL_FROM || c.env.EMAIL_FARM);

  return c.json({
    status: supabaseOk ? 'ok' : 'degraded',
    supabase: supabaseOk,
    twilio: twilioConfigured,
    twilioConfigured,
    email: emailConfigured,
    time: new Date().toISOString(),
  });
});

// ── Public payment link redirect (SMS-safe, no hash fragment) ──────────────────
// PayPal's payer-view URLs use a "#" hash fragment, which several SMS apps'
// auto-link-detection truncates at, silently breaking the link. This route
// gives texts a clean URL to send instead, which 302-redirects to the real
// PayPal link. No auth/gate required — a customer's phone has neither.
app.get('/api/pay/:orderNumber', async (c) => {
  try {
    const orderNumber = decodeURIComponent(c.req.param('orderNumber'));
    const tenantId = await getTenantId(c);
    const config = await getBusinessConfig(c.env, tenantId);
    const { data } = await sb(c.env, 'GET','orders',null,`?order_number=eq.${encodeURIComponent(orderNumber)}&limit=1`, tenantId);
    const order = data?.[0];
    if (!order || !order.paypal_pay_url) {
      return c.text(`Payment link not found. Please contact ${config.business_name} at ${config.phone}.`, 404);
    }
    // Deliberately NOT an HTTP 302 here. Safari/WebKit's Intelligent Tracking
    // Prevention applies "bounce tracking" cookie restrictions to server-side
    // redirects through an unfamiliar domain — confirmed by testing that a
    // 302 here breaks PayPal's invoice page even with no-referrer set, while
    // the exact same URL works fine pasted directly or reached via a real
    // page load. A tiny HTML page that redirects via JS after actually
    // loading is treated as a genuine navigation, not a bounce.
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Redirecting to PayPal…</title>
<meta http-equiv="refresh" content="0;url=${order.paypal_pay_url}">
<style>body{font-family:-apple-system,sans-serif;background:#F4F1EA;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;color:#333;}
.box{text-align:center;padding:24px;}
a{color:${config.brand_color};font-weight:700;}</style>
</head><body>
<div class="box">
  <p>Redirecting you to PayPal to complete payment…</p>
  <p>If nothing happens, <a href="${order.paypal_pay_url}">tap here</a>.</p>
</div>
<script>window.location.replace(${JSON.stringify(order.paypal_pay_url)});</script>
</body></html>`);
  } catch(e) {
    console.error('  /api/pay redirect failed:', e.message);
    return c.text(`Something went wrong loading your payment link. Please contact ${DEFAULT_CONFIG.business_name} at ${DEFAULT_CONFIG.phone}.`, 500);
  }
});

// ── Expanded Checkout: branded, on-site card payment ────────────────────────────
// Unlike the PayPal-hosted invoice page (which has caused persistent SMS-link
// issues), this keeps the customer entirely on our own domain — PayPal's
// CardFields component renders styled input fields directly on our page, and
// only the underlying card processing happens via PayPal's API in the
// background. No redirect to paypal.com at all.

async function getOrderTotal(env, orderNumber, tenantId) {
  const { data: orders } = await sb(env, 'GET','orders',null,`?order_number=eq.${encodeURIComponent(orderNumber)}&limit=1`, tenantId);
  const order = orders?.[0];
  if (!order) return null;
  const { data: items } = await sb(env, 'GET','order_items',null,`?order_id=eq.${order.id}&order=id.asc`, tenantId);
  const total = (items||[]).reduce((s,i)=>s+parseFloat(i.line_total||0),0) || parseFloat(order.final_total||0);
  return { order, items: items||[], total };
}

app.get('/pay/:orderNumber', async (c) => {
  const orderNumber = decodeURIComponent(c.req.param('orderNumber'));
  const tenantId = await getTenantId(c);
  const config = await getBusinessConfig(c.env, tenantId);
  const found = await getOrderTotal(c.env, orderNumber, tenantId);
  if (!found || !found.order) {
    return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;"><h2>Order not found</h2><p>Please contact ${config.business_name} at ${config.phone}.</p></body></html>`, 404);
  }
  const { order, items, total } = found;
  if (order.is_paid) {
    return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:${config.brand_color};"><h2>✅ This order is already paid in full</h2><p>Order ${order.order_number} — Total: $${total.toFixed(2)}</p></body></html>`);
  }
  const itemRows = items.map(i => `<tr><td style="padding:8px 0;">${i.product_name}</td><td style="padding:8px 0;text-align:right;color:#666;">${i.weight_lbs||0} lb</td><td style="padding:8px 0;text-align:right;font-weight:700;">$${parseFloat(i.line_total||0).toFixed(2)}</td></tr>`).join('');

  return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pay Invoice ${order.order_number} — ${config.business_name}</title>
<style>
  :root{--green:${config.brand_color};--bg:#F4F1EA;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1A1A1A;}
  .wrap{max-width:480px;margin:0 auto;padding:32px 20px 60px;}
  .brand{font-size:18px;font-weight:800;color:var(--green);text-align:center;margin-bottom:24px;}
  .card{background:#fff;border-radius:14px;padding:28px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  h1{font-size:18px;margin:0 0 4px;color:var(--green);}
  .order-num{color:#888;font-size:13px;margin-bottom:20px;}
  table{width:100%;border-collapse:collapse;font-size:14px;margin-bottom:12px;}
  .total-row td{border-top:2px solid #1A1A1A;padding-top:12px;font-weight:800;font-size:17px;color:var(--green);}
  #paypal-buttons{margin-top:22px;min-height:45px;}
  #status-msg{margin-top:14px;font-size:13px;text-align:center;}
  #status-msg.error{color:#C0392B;}
  #status-msg.success{color:var(--green);}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand" style="display:flex;align-items:center;justify-content:center;gap:8px;"><img src="${config.logo_url}" alt="${config.business_name}" style="height:26px;width:auto;"/> ${config.business_name}</div>
  <div class="card">
    <h1>Pay Your Invoice</h1>
    <div class="order-num">Order ${order.order_number}</div>
    <table>
      ${itemRows}
      <tr class="total-row"><td colspan="2">Total Due</td><td style="text-align:right;">$${total.toFixed(2)}</td></tr>
    </table>

    <div id="paypal-buttons"></div>
    <div id="status-msg"></div>
  </div>
</div>

<script src="https://www.paypal.com/sdk/js?client-id=${c.env.PAYPAL_CLIENT_ID}&currency=USD&components=buttons"></script>
<script>
const orderNumber = ${JSON.stringify(order.order_number)};
const statusEl = document.getElementById('status-msg');

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = type || '';
}

async function createOrder() {
  const res = await fetch('/api/paypal/create-order', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ order_number: orderNumber }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not start payment.');
  return data.id;
}

async function captureOrder(orderId) {
  const res = await fetch('/api/paypal/capture-order/' + orderId, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ order_number: orderNumber }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not complete payment.');
  return data;
}

if (window.paypal && window.paypal.Buttons) {
  paypal.Buttons({
    style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'pay' },
    createOrder,
    onApprove: async (data) => {
      showStatus('Confirming payment…', '');
      try {
        await captureOrder(data.orderID);
        showStatus('✅ Payment successful! Thank you — see you soon.', 'success');
        document.querySelector('.card > table').style.display = 'none';
        document.getElementById('paypal-buttons').style.display = 'none';
      } catch(e) {
        showStatus(e.message, 'error');
      }
    },
    onCancel: () => {
      showStatus('Payment canceled. You can try again whenever you\\'re ready.', '');
    },
    onError: (err) => {
      console.error(err);
      showStatus('Something went wrong. Please try again or call ${config.phone}.', 'error');
    },
  }).render('#paypal-buttons');
} else {
  showStatus('Could not load the payment form. Please refresh the page or call ${config.phone}.', 'error');
}
</script>
</body></html>`);
});

app.post('/api/paypal/create-order', async (c) => {
  try {
    const { order_number } = await c.req.json();
    const tenantId = await getTenantId(c);
    const found = await getOrderTotal(c.env, order_number, tenantId);
    if (!found || !found.order) return c.json({ error: 'Order not found' }, 404);
    const { total } = found;

    const token = await getPayPalAccessToken(c.env);
    const base = c.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const res = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: order_number, amount: { currency_code: 'USD', value: total.toFixed(2) } }],
      }),
    });
    if (!res.ok) {
      console.error('  PayPal create order failed:', res.status, await res.text());
      return c.json({ error: 'Could not start payment. Please try again.' }, 500);
    }
    const data = await res.json();
    return c.json({ id: data.id });
  } catch(e) {
    console.error('  /api/paypal/create-order error:', e.message);
    return c.json({ error: 'Could not start payment. Please try again.' }, 500);
  }
});

app.post('/api/paypal/capture-order/:orderId', async (c) => {
  try {
    const orderId = c.req.param('orderId');
    const { order_number } = await c.req.json();
    const tenantId = await getTenantId(c);
    const token = await getPayPalAccessToken(c.env);
    const base = c.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
    const res = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'COMPLETED') {
      console.error('  PayPal capture failed:', res.status, JSON.stringify(data));
      return c.json({ error: 'Payment could not be completed. Please try a different card or contact us.' }, 500);
    }

    // Mark our order paid
    const { data: orders } = await sb(c.env, 'GET','orders',null,`?order_number=eq.${encodeURIComponent(order_number)}&limit=1`, tenantId);
    const order = orders?.[0];
    if (order) {
      await sb(c.env, 'PATCH','orders',{is_paid:true,paid_at:new Date().toISOString(),status: order.status==='invoiced'?'paid':order.status},`?id=eq.${order.id}`, tenantId);
      // Notification failures must never affect the customer-facing response —
      // the payment and DB update above already succeeded by this point, so a
      // problem sending the confirmation email/SMS shouldn't report as a
      // payment failure. Isolated in its own try/catch for that reason.
      const paidAmount = parseFloat(data?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || order.final_total || 0);
      try {
        c.executionCtx.waitUntil(sendPaymentReceivedNotification(c.env, order, paidAmount, tenantId));
      } catch(notifyErr) {
        console.error('  Payment received notification failed (payment itself succeeded fine):', notifyErr.message);
      }
      try {
        c.executionCtx.waitUntil(sendAdminOrderPaidAlert(c.env, order, paidAmount));
      } catch(notifyErr) {
        console.error('  Admin paid-alert failed (payment itself succeeded fine):', notifyErr.message);
      }
    }
    return c.json({ success: true, status: data.status });
  } catch(e) {
    console.error('  /api/paypal/capture-order error:', e.message);
    return c.json({ error: 'Payment could not be completed. Please contact us.' }, 500);
  }
});

app.get('/api/inventory', async (c) => {
  const limit = c.req.query('limit') || 500;
  const tenantId = await getTenantId(c);
  const { status, data } = await sb(c.env, 'GET','inventory',null,`?order=product_id.asc&limit=${limit}`, tenantId);
  return c.json(data, status);
});
app.patch('/api/inventory/:id', requireAdmin, async (c) => {
  const productId = c.req.param('id');
  const tenantId = await getTenantId(c);
  const body = await c.req.json();
  // Stock is tracked in whole units, not fractional — round here centrally
  // so every caller (manual edits, wholesale receiving, order fulfillment,
  // customer sale scans) gets this enforced regardless of what they compute.
  if (body.stock != null) body.stock = Math.round(parseFloat(body.stock));

  // Fetch current values first, so we can log what actually changed —
  // and so the response can tell the frontend exactly what changed for a
  // descriptive toast message, not just "saved".
  const { data: existing } = await sb(c.env, 'GET','inventory',null,`?product_id=eq.${productId}&limit=1`, tenantId);
  const before = existing?.[0] || {};

  const { status, data } = await sb(c.env, 'PATCH','inventory',{...body,last_updated:new Date().toISOString()},`?product_id=eq.${productId}`, tenantId);

  // Log an audit entry per changed field. Best-effort — a logging failure
  // should never block the actual inventory update from succeeding.
  if (status>=200 && status<300) {
    const changedBy = c.get('adminUser');
    const productName = before.product_name || (data?.[0]?.product_name) || '';
    const auditRows = Object.keys(body)
      .filter(field => field !== 'last_updated')
      .map(field => ({
        product_id: parseInt(productId),
        product_name: productName,
        field_name: field,
        old_value: before[field] != null ? String(before[field]) : null,
        new_value: body[field] != null ? String(body[field]) : null,
        changed_by: changedBy,
      }));
    if (auditRows.length) {
      try { await sb(c.env, 'POST','inventory_audit_log',auditRows, '', tenantId); }
      catch(auditErr) { console.error('  Audit log write failed (inventory update itself still succeeded):', auditErr.message); }
    }
  }

  return c.json({ data, before }, status);
});

app.get('/api/bookings', async (c) => {
  const tenantId = await getTenantId(c);
  const { status, data } = await sb(c.env, 'GET','bookings',null,'?order=created_at.desc&limit=200', tenantId);
  return c.json(data, status);
});
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function formatDayList(dayNumbers) {
  const names = dayNumbers.map(d => DAY_NAMES[d] + 's');
  if (names.length <= 1) return names[0] || '';
  return names.slice(0,-1).join(', ') + ' and ' + names[names.length-1];
}

app.post('/api/bookings', async (c) => {
  const body = await c.req.json();
  if (!body.first_name || !body.email) return c.json({ error: 'first_name and email required' }, 400);
  const tenantId = await getTenantId(c);
  const config = await getBusinessConfig(c.env, tenantId);
  // Visit days/hours are configurable per business — see business_config.
  if (body.visit_date) {
    const [y,m,d] = body.visit_date.split('-').map(Number);
    const day = new Date(y, (m||1)-1, d).getDay();
    if (!config.visit_days.includes(day)) {
      return c.json({ error: `Visits are only available ${formatDayList(config.visit_days)}. Please choose one of those days.` }, 400);
    }
  }
  if (body.time_slot) {
    const [, hourStr, meridiem] = body.time_slot.match(/(\d+):\d+\s*(AM|PM)/i) || [];
    let hour = parseInt(hourStr, 10);
    if (meridiem && meridiem.toUpperCase()==='PM' && hour !== 12) hour += 12;
    if (isNaN(hour) || hour < config.visit_hour_start || hour > config.visit_hour_end) {
      return c.json({ error: `Visits are only available between ${config.visit_hour_start}:00 and ${config.visit_hour_end}:00.` }, 400);
    }
  }
  const { status, data } = await sb(c.env, 'POST','bookings',body, '', tenantId);
  if (status>=200 && status<300) {
    const name = [body.first_name, body.last_name].filter(Boolean).join(' ');
    c.executionCtx.waitUntil(sendSMS(c.env, c.env.TWILIO_NOTIFY, `New Appointment\n${name} | ${body.visit_type||'N/A'}\n${body.visit_date||'TBD'} at ${body.time_slot||'TBD'}\n${body.phone||'no phone'}`));
  }
  return c.json(data, status);
});

app.get('/api/orders', async (c) => {
  const limit = c.req.query('limit') || 100;
  const tenantId = await getTenantId(c);
  const { status, data } = await sb(c.env, 'GET','orders',null,`?order=created_at.desc&limit=${limit}`, tenantId);
  return c.json(data, status);
});
app.post('/api/orders', async (c) => {
  const body = await c.req.json();
  const { items } = body;
  if (!items || !items.length) return c.json({ error: 'items required' }, 400);
  const tenantId = await getTenantId(c);
  const config = await getBusinessConfig(c.env, tenantId);
  // Online orders only — restrict pickup to configured pickup days. Not
  // applied to admin-created manual/walk-in orders, which don't have this constraint.
  if (body.order_source !== 'manual' && body.pickup_date) {
    const [y,m,d] = body.pickup_date.split('-').map(Number);
    const day = new Date(y, (m||1)-1, d).getDay();
    if (!config.pickup_days.includes(day)) {
      return c.json({ error: `Pickup is only available ${formatDayList(config.pickup_days)}. Please choose one of those days.` }, 400);
    }
  }
  const orderRow = { ...body, order_source: body.order_source || 'online' };
  const { status, data } = await sb(c.env, 'POST','orders',orderRow, '', tenantId);
  if (status<200 || status>=300) return c.json(data, status);
  const order = data[0];
  if (!order || !order.id) return c.json({ error: 'Order insert did not return a row — check Supabase RLS/return=representation settings' }, 500);
  for (const item of items) {
    const itemRes = await sb(c.env, 'POST','order_items',{
      order_id: order.id, order_number: body.order_number,
      product_id: item.id||null, product_name: item.name,
      qty_ordered: item.qty||1, unit: item.unit||'/lb',
      price_per_unit: parseFloat(item.price_per_unit||0), status:'pending',
    }, '', tenantId);
    if (itemRes.status<200 || itemRes.status>=300) {
      return c.json({ error: 'Order created, but failed to save item "'+item.name+'": '+(itemRes.data?.message||itemRes.data?.error||JSON.stringify(itemRes.data)) }, 500);
    }
  }
  c.executionCtx.waitUntil(sendNewOrderAlert(c.env, body, items, tenantId));
  return c.json(data, status);
});

// Constant-time string comparison — prevents inferring password characters
// from response-time differences in a plain !== comparison.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ── Scanned customer receipt (offline sale reconciliation) ─────────────────────
// For sales that happen outside the normal digital order flow (farmers market,
// other in-person sales) — staff scan the paper receipt, match items, and this
// creates a completed order record + deducts stock, reusing the same deduction
// logic as a normal order being marked fulfilled.
app.post('/api/admin/scan-customer-sale', requireAdmin, async (c) => {
  try {
    const body = await c.req.json();
    const { customer_name, line_items } = body;
    if (!line_items || !line_items.length) return c.json({ error: 'No line items provided' }, 400);
    const tenantId = await getTenantId(c);

    const orderNumber = 'ORD-' + Date.now().toString().slice(-6);
    const subtotal = line_items.reduce((s,li) => s + (parseFloat(li.line_total)||0), 0);
    const orderRow = {
      order_number: orderNumber,
      customer_name: customer_name || 'Walk-in Customer',
      order_source: 'scanned_receipt',
      status: 'fulfilled',
      is_paid: true,
      paid_at: new Date().toISOString(),
      fulfilled_at: new Date().toISOString(),
      final_subtotal: parseFloat(subtotal.toFixed(2)),
      final_total: parseFloat(subtotal.toFixed(2)),
    };
    const { status, data } = await sb(c.env, 'POST','orders',orderRow, '', tenantId);
    if (status<200 || status>=300) return c.json({ error: 'Could not create order record: '+(data?.message||data?.error||JSON.stringify(data)) }, 500);
    const order = data[0];
    if (!order || !order.id) return c.json({ error: 'Order insert did not return a row' }, 500);

    // Batch-insert all order_items in ONE request rather than looping per
    // item — each item was its own subrequest before, which could exceed
    // Cloudflare's per-invocation subrequest limit on larger receipts.
    const itemRows = line_items.map(li => ({
      order_id: order.id, order_number: orderNumber,
      product_id: li.product_id||null, product_name: li.product_name||'',
      weight_lbs: parseFloat(li.weight_lbs)||0,
      actual_price_lb: parseFloat(li.price_per_lb)||0,
      line_total: parseFloat(li.line_total)||0,
      status: 'fulfilled',
    }));
    const itemsRes = await sb(c.env, 'POST','order_items',itemRows, '', tenantId);
    if (itemsRes.status<200 || itemsRes.status>=300) {
      return c.json({ error: 'Order created, but failed to save items: '+(itemsRes.data?.message||itemsRes.data?.error||JSON.stringify(itemsRes.data)) }, 500);
    }

    try {
      await deductStockForOrderItems(c.env, order.id, tenantId);
    } catch(stockErr) {
      console.error('  Stock deduction for scanned customer sale failed (order record still saved fine):', stockErr.message);
    }

    return c.json({ success: true, order_number: orderNumber, total: subtotal.toFixed(2) });
  } catch(e) {
    return c.json({ error: e.message }, 500);
  }
});

app.post('/api/admin/login', async (c) => {
  const body = await c.req.json().catch(()=>({}));
  const { username, password } = body;
  // Fail closed if credentials aren't configured — never fall back to a
  // hardcoded default, which would be a guessable, publicly-visible-in-source
  // password if the secret were ever accidentally unset.
  if (!c.env.ADMIN_USERNAME || !c.env.ADMIN_PASSWORD) {
    console.error('  ADMIN_USERNAME/ADMIN_PASSWORD not configured — refusing login');
    return c.json({ error: 'Admin login is not configured. Contact the site administrator.' }, 500);
  }
  const validUsername = timingSafeEqual(username||'', c.env.ADMIN_USERNAME);
  const validPassword = timingSafeEqual(password||'', c.env.ADMIN_PASSWORD);
  if (!validUsername || !validPassword) return c.json({ error: 'Invalid credentials' }, 401);
  const token = randomToken();
  await c.env.ADMIN_SESSIONS.put(token, JSON.stringify({ username }), { expirationTtl: 8*3600 });
  return c.json({ token, username });
});
app.post('/api/admin/logout', async (c) => {
  const token = c.req.header('x-admin-token');
  if (token) await c.env.ADMIN_SESSIONS.delete(token);
  return c.json({ success: true });
});

app.get('/api/admin/orders', requireAdmin, async (c) => {
  const statusFilter = c.req.query('status');
  const tenantId = await getTenantId(c);
  const q = statusFilter ? `?status=eq.${statusFilter}&order=created_at.desc&limit=200` : `?order=created_at.desc&limit=200`;
  const { status, data } = await sb(c.env, 'GET','orders',null,q, tenantId);
  return c.json(data, status);
});
app.get('/api/admin/orders/:id', requireAdmin, async (c) => {
  const tenantId = await getTenantId(c);
  const { data } = await sb(c.env, 'GET','orders',null,`?id=eq.${c.req.param('id')}&limit=1`, tenantId);
  return c.json(data?.[0] || null);
});
app.get('/api/admin/orders/:id/items', requireAdmin, async (c) => {
  const tenantId = await getTenantId(c);
  const { status, data } = await sb(c.env, 'GET','order_items',null,`?order_id=eq.${c.req.param('id')}&order=id.asc`, tenantId);
  return c.json(data, status);
});
app.patch('/api/admin/order-items/:itemId', requireAdmin, async (c) => {
  const payload = await c.req.json();
  const tenantId = await getTenantId(c);
  if (payload.weight_lbs!=null && payload.actual_price_lb!=null) {
    payload.line_total = parseFloat((parseFloat(payload.weight_lbs)*parseFloat(payload.actual_price_lb)).toFixed(2));
    payload.status = 'weighed';
  }
  await sb(c.env, 'PATCH','order_items',payload,`?id=eq.${c.req.param('itemId')}`, tenantId);
  return c.json({ success: true, line_total: payload.line_total||null, status: payload.status||null });
});
app.post('/api/admin/orders/:id/invoice', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const tenantId = await getTenantId(c);
  const { data: orders } = await sb(c.env, 'GET','orders',null,`?id=eq.${id}&limit=1`, tenantId);
  const order = orders?.[0]; if (!order) return c.json({ error: 'Order not found' }, 404);
  // Guard against duplicate invoices/emails — once an order has moved past
  // pending_weight, it's already been invoiced (or further along). Re-running
  // this would create a second PayPal invoice and re-send the notification.
  const alreadyInvoiced = ['invoiced','paid','ready','fulfilled'].includes(order.status);
  if (alreadyInvoiced) {
    return c.json({ error: `This order was already invoiced${order.invoice_sent_at?' on '+new Date(order.invoice_sent_at).toLocaleDateString():''}. Duplicate invoices/emails are blocked to avoid confusing the customer or creating extra PayPal records.` }, 409);
  }
  const { data: items } = await sb(c.env, 'GET','order_items',null,`?order_id=eq.${id}&order=id.asc`, tenantId);
  const subtotal = (items||[]).reduce((s,i)=>s+parseFloat(i.line_total||0),0);
  // Walk-in orders get ONE combined notification once the whole transaction is
  // complete (paid + fulfilled), not a separate "invoice ready, please pay"
  // message — that would be misleading since a walk-in typically pays within
  // moments of this step. Online orders still get the standalone invoice email,
  // since for them "invoice ready" and "picked up" are genuinely separate events.
  if (order.order_source !== 'manual') {
    await sendInvoiceNotification(c.env, order, items||[], tenantId);
  }
  const orderPatch = await sb(c.env, 'PATCH','orders',{status:'invoiced',invoice_sent_at:new Date().toISOString(),final_subtotal:parseFloat(subtotal.toFixed(2)),final_total:parseFloat(subtotal.toFixed(2))},`?id=eq.${id}`, tenantId);
  if (orderPatch.status<200 || orderPatch.status>=300) {
    return c.json({ error: 'Invoice email sent, but failed to update order status: '+(orderPatch.data?.message||orderPatch.data?.error||JSON.stringify(orderPatch.data)) }, 500);
  }
  await sb(c.env, 'PATCH','order_items',{status:'invoiced'},`?order_id=eq.${id}`, tenantId);
  return c.json({ success: true, total: subtotal.toFixed(2) });
});
// ── Deducts stock for an order's items — shared by both the normal
//    order-fulfillment flow and the new scanned-customer-receipt flow below.
async function deductStockForOrderItems(env, orderId, tenantId) {
  const { data: orderItems } = await sb(env, 'GET','order_items',null,`?order_id=eq.${orderId}`, tenantId);
  const validItems = (orderItems||[]).filter(item => item.product_id && parseFloat(item.weight_lbs) > 0);
  if (!validItems.length) return;

  // Batch-fetch all needed inventory rows in ONE request (PostgREST's `in.`
  // filter) instead of one GET per item — same subrequest-limit reasoning
  // as the batched order_items insert above.
  const ids = [...new Set(validItems.map(i => i.product_id))];
  const { data: products } = await sb(env, 'GET','inventory',null,`?product_id=in.(${ids.join(',')})`, tenantId);
  const byId = new Map((products||[]).map(p => [String(p.product_id), p]));

  // Each product needs a DIFFERENT new stock value, so these PATCH calls
  // can't be batched the same way — still one subrequest per item here,
  // but the two batching fixes above should keep the total well under
  // typical per-invocation limits for realistic receipt sizes.
  for (const item of validItems) {
    const product = byId.get(String(item.product_id));
    if (!product || product.stock == null) continue; // don't create a stock value out of nowhere for untracked items
    const qty = parseFloat(item.weight_lbs);
    const newStock = Math.round(Math.max(0, parseFloat(product.stock) - qty));
    await sb(env, 'PATCH','inventory',{stock:newStock},`?product_id=eq.${item.product_id}`, tenantId);
  }
}

app.patch('/api/admin/orders/:id/status', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const tenantId = await getTenantId(c);
  const { is_paid, items_prepared, status: newStatus } = body;
  const { data: orders } = await sb(c.env, 'GET','orders',null,`?id=eq.${id}&limit=1`, tenantId);
  const order = orders?.[0]; if (!order) return c.json({ error: 'Order not found' }, 404);
  const payload = {};
  if (is_paid !== undefined) payload.is_paid = is_paid;
  if (items_prepared !== undefined) payload.items_prepared = items_prepared;
  if (newStatus !== undefined) payload.status = newStatus;
  if (newStatus === 'fulfilled') payload.fulfilled_at = new Date().toISOString();
  const nowPaid = is_paid !== undefined ? is_paid : order.is_paid;
  const nowPrepared = items_prepared !== undefined ? items_prepared : order.items_prepared;
  const justMarkedPaid = nowPaid && !order.is_paid; // only fire once, on the actual transition
  let ready = false;

  if (nowPaid && order.status === 'invoiced' && !payload.status) {
    payload.status = 'paid';
    payload.paid_at = new Date().toISOString();
  }
  if (nowPaid && nowPrepared && order.status !== 'ready' && order.status !== 'fulfilled') {
    payload.status = 'ready';
    payload.ready_at = new Date().toISOString();
    ready = true;
  }
  await sb(c.env, 'PATCH','orders',payload,`?id=eq.${id}`, tenantId);
  const merged = {...order, ...payload};

  // Deduct fulfilled items from stock — only on the actual transition into
  // "fulfilled" (guarded against double-deduction from a repeated call), and
  // only for items with a tracked stock value.
  if (payload.status === 'fulfilled' && order.status !== 'fulfilled') {
    try {
      await deductStockForOrderItems(c.env, id, tenantId);
    } catch(stockErr) {
      console.error('  Stock deduction on fulfillment failed (order status update itself still succeeded):', stockErr.message);
    }
  }

  if (justMarkedPaid) {
    const amount = parseFloat(order.final_total || 0);
    try {
      c.executionCtx.waitUntil(sendAdminOrderPaidAlert(c.env, merged, amount, 'manual entry (admin)'));
    } catch(notifyErr) {
      console.error('  Admin paid-alert (manual mark) failed:', notifyErr.message);
    }
  }
  if (ready && order.order_source !== 'manual') c.executionCtx.waitUntil(sendReadyForPickup(c.env, merged, tenantId));
  if (payload.status === 'fulfilled' && order.order_source === 'manual') c.executionCtx.waitUntil(sendWalkInReceipt(c.env, merged, tenantId));
  // Review requests are sent 30-45 min later by the scheduled cron job below,
  // not immediately here — see the `scheduled` export at the bottom of this file.
  return c.json({ success: true, triggered_ready: ready, status: payload.status || order.status });
});

// ── Driver's license scan (AI vision extraction) ────────────────────────────────
// Image is forwarded to Claude for extraction and NEVER stored anywhere — not in
// Supabase, not in KV, not logged. Only the extracted name/address fields return.
app.post('/api/admin/scan-license', requireAdmin, async (c) => {
  try {
    const { image, mediaType } = await c.req.json();
    if (!image) return c.json({ error: 'No image provided' }, 400);
    if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: 'License scanning is not set up yet (missing API key).' }, 500);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': c.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: "Extract these fields from this US driver's license image and return ONLY a JSON object with exactly these keys, no markdown, no explanation, no other text: first_name, last_name, address, city, state, zip. The \"address\" field should be just the street address (no city/state/zip). Use null for any field you cannot read clearly. Do not include a license number, date of birth, or any other field." },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('  License scan API error:', res.status, errText);
      return c.json({ error: 'Could not process the image. Please try again or enter details manually.' }, 500);
    }

    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return c.json({ error: 'No data extracted. Please try again.' }, 500);

    let extracted;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
      extracted = JSON.parse(cleaned);
    } catch(e) {
      return c.json({ error: "Could not read the license clearly. Please try again or enter the customer's details manually." }, 500);
    }

    return c.json({ success: true, data: extracted });
  } catch(e) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Wholesale invoice scanner (AI vision extraction of multiple line items) ────
// Same no-storage pattern as the license scanner — the photo is forwarded to
// Claude for one-shot extraction and never saved anywhere.
app.post('/api/admin/scan-wholesale-invoice', requireAdmin, async (c) => {
  try {
    const { image, mediaType } = await c.req.json();
    if (!image) return c.json({ error: 'No image provided' }, 400);
    if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: 'Invoice scanning is not set up yet (missing API key).' }, 500);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': c.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: "This is a photo of a wholesale meat invoice. Extract every line item and return ONLY a JSON object with this exact shape, no markdown, no explanation, no other text:\n" +
              '{"line_items":[{"pieces":number|null,"description":"string","weight_lbs":number|null,"wholesale_price_per_lb":number|null,"total_amount":number|null}]}\n' +
              'The columns on the invoice are: Pieces, Description, Weight, Price (wholesale, per lb), Total Amount. Extract every row exactly as printed — do not skip any, do not invent values. Use null for any individual field you cannot read clearly, but still include that line item with whatever fields ARE readable. Do not include the invoice header, totals row, or any summary rows as a line item.' },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('  Wholesale invoice scan API error:', res.status, errText);
      return c.json({ error: 'Could not process the image. Please try again or enter items manually.' }, 500);
    }

    const data = await res.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    if (!textBlock) return c.json({ error: 'No data extracted. Please try again.' }, 500);

    let extracted;
    try {
      const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
      extracted = JSON.parse(cleaned);
    } catch(e) {
      return c.json({ error: 'Could not read the invoice clearly. Please try again or enter items manually.' }, 500);
    }

    return c.json({ success: true, line_items: extracted.line_items || [] });
  } catch(e) {
    return c.json({ error: e.message }, 500);
  }
});
// Runs on whatever interval is set in wrangler.toml's [triggers] crons (e.g.
// every 5 minutes). Each run picks up any order that crossed the 30-minute mark
// since its last check and hasn't had a review request sent yet.
// Runs once per tenant, since a scheduled/cron trigger has no incoming
// request to resolve a domain/tenant from the usual way.
async function runReviewRequestSweep(env) {
  const { data: tenants } = await sb(env, 'GET','tenants',null,'?status=eq.active', null);
  for (const tenant of (tenants||[])) {
    await runReviewRequestSweepForTenant(env, tenant.id);
  }
}

async function runReviewRequestSweepForTenant(env, tenantId) {
  const cutoff = new Date(Date.now() - 30*60*1000).toISOString();
  const { status, data } = await sb(env, 'GET','orders',null,
    `?status=eq.fulfilled&review_requested_at=is.null&fulfilled_at=lte.${cutoff}&order=fulfilled_at.asc&limit=25`, tenantId);
  if (status<200 || status>=300 || !Array.isArray(data)) {
    console.warn(`  Review sweep (tenant ${tenantId}): could not fetch eligible orders`, data);
    return;
  }
  console.log(`  Review sweep (tenant ${tenantId}): ${data.length} order(s) eligible`);
  for (const order of data) {
    try {
      await sendReviewRequest(env, order, tenantId);
      await sb(env, 'PATCH','orders',{review_requested_at:new Date().toISOString()},`?id=eq.${order.id}`, tenantId);
      console.log('  Review request sent for', order.order_number);
    } catch(e) {
      console.warn('  Review request failed for', order.order_number, e.message);
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (event, env, ctx) => {
    ctx.waitUntil(runReviewRequestSweep(env));
  },
};