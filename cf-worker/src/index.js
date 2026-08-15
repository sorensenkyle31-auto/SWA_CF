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
async function sb(env, method, table, body = null, query = '') {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${query}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': (method === 'POST' || method === 'PATCH') ? 'return=representation' : '',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
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

// ── Email via Mailchannels HTTP API (free on Cloudflare Workers) ───────────────
async function sendEmail(env, to, subject, text, html) {
  if (!to) return;
  const fromAddr = env.EMAIL_FROM || env.EMAIL_FARM;
  if (!fromAddr) { console.warn('  Email skipped: no EMAIL_FROM configured'); return; }
  try {
    const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromAddr, name: 'Stone Wall Angus' },
        subject,
        content: [
          { type: 'text/plain', value: text },
          ...(html ? [{ type: 'text/html', value: html }] : []),
        ],
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

async function sendNewOrderAlert(env, order, items) {
  const itemList = items.map(i => `${i.name} x${i.qty||1}`).join(', ');
  const sms = `New Order: ${order.order_number}\n${order.customer_name} | ${order.customer_phone||order.customer_email}\nItems: ${itemList}\nPickup: ${order.pickup_date||'TBD'}`;
  await sendSMS(env, env.TWILIO_NOTIFY, sms);
  const email =
    `New order received.\n\nORDER: ${order.order_number}\nCustomer: ${order.customer_name}\nEmail: ${order.customer_email}\nPhone: ${order.customer_phone||'N/A'}\nPickup: ${order.pickup_date||'TBD'}\n${order.notes?'Notes: '+order.notes+'\n':''}\nItems:\n${items.map(i=>`  - ${i.name} x${i.qty||1}`).join('\n')}\n\nOpen the admin app to enter weights and send the invoice.`;
  await sendEmail(env, env.EMAIL_FARM||'stonewallangus1@myactv.net', `New Order - ${order.order_number}`, email);
}

// ── PayPal invoice link (STUB — same as server.js, replace when ready) ─────────
function createStubPayPalLink(order, total) {
  const params = new URLSearchParams({ order: order.order_number, amount: total.toFixed(2) });
  return `https://www.paypal.com/invoice/pay/STUB?${params.toString()}`;
}

// ── HTML invoice email body (identical markup to server.js) ────────────────────
function buildInvoiceEmailHtml(order, items, subtotal, total, paypalLink) {
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
<title>Invoice ${order.order_number} — Stone Wall Angus</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F1EA;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <tr><td style="padding:28px 32px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top">
            <div style="font-size:19px;font-weight:800;color:#2D4A1E;">🐄&nbsp; Stone Wall Angus</div>
            <div style="font-size:13px;color:#6B6B6B;margin-top:8px;line-height:1.5;">17719 Spielman Road, Fairplay, MD 21733<br>(240) 818-8317 &middot; stonewallangus1@myactv.net</div>
          </td>
          <td valign="top" align="right">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;">Invoice</div>
            <div style="font-size:20px;font-weight:800;color:#2D4A1E;margin-top:4px;">${order.order_number}</div>
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
          <tr style="background-color:#2D4A1E;">
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
            <tr><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:16px;font-weight:800;color:#1A1A1A;">Total Due</td><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:18px;font-weight:800;color:#2D4A1E;text-align:right;">$${total.toFixed(2)}</td></tr>
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
        <div style="font-size:12px;color:#8A8A8A;text-align:center;line-height:1.6;">Questions about this invoice? Reply to this email or call (240) 818-8317.<br>Stone Wall Angus &middot; Family-owned since 1989 &middot; Fairplay, MD</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendInvoiceNotification(env, order, items) {
  const subtotal  = items.reduce((s,i) => s + parseFloat(i.line_total||0), 0);
  const total     = subtotal;
  const firstName = (order.customer_name||'').split(' ')[0] || 'Customer';
  const paypalLink = createStubPayPalLink(order, total);

  const lineItems = items.map(i =>
    `  ${i.product_name} - ${i.weight_lbs||0} lbs @ $${parseFloat(i.actual_price_lb||i.price_per_unit||0).toFixed(2)}/lb = $${parseFloat(i.line_total||0).toFixed(2)}`
  ).join('\n');
  const emailText =
    `Dear ${firstName},\n\nYour order is weighed and your invoice is ready.\n\nORDER: ${order.order_number}\n\nINVOICE\n${lineItems}\n\n` +
    `Subtotal:  $${subtotal.toFixed(2)}\nShipping:  Free\nTOTAL DUE: $${total.toFixed(2)}\n\n` +
    `Pay online: ${paypalLink}\n\n` +
    `Please arrange payment before pickup: ${order.pickup_date||'TBD'}\nCall (240) 818-8317 or email stonewallangus1@myactv.net\n\nStone Wall Angus`;
  const emailHtml = buildInvoiceEmailHtml(order, items, subtotal, total, paypalLink);

  await sendEmail(env, order.customer_email, `Invoice - Stone Wall Angus ${order.order_number}`, emailText, emailHtml);
  const sms = `Invoice Ready - Stone Wall Angus\nOrder: ${order.order_number}\nTotal: $${total.toFixed(2)}\nCheck your email for details. Questions? (240) 818-8317`;
  await sendSMS(env, fmtPhone(order.customer_phone), sms);
}

// ── HTML "Ready for Pickup" email (identical markup to server.js) ──────────────
function buildReadyPickupEmailHtml(order, items, total) {
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
<title>Order Ready ${order.order_number} — Stone Wall Angus</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F4F1EA;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <tr><td style="padding:28px 32px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
          <td valign="top">
            <div style="font-size:19px;font-weight:800;color:#2D4A1E;">🐄&nbsp; Stone Wall Angus</div>
            <div style="font-size:13px;color:#6B6B6B;margin-top:8px;line-height:1.5;">17719 Spielman Road, Fairplay, MD 21733<br>(240) 818-8317 &middot; stonewallangus1@myactv.net</div>
          </td>
          <td valign="top" align="right">
            <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8A8A8A;text-transform:uppercase;">Order</div>
            <div style="font-size:20px;font-weight:800;color:#2D4A1E;margin-top:4px;">${order.order_number}</div>
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
          <tr style="background-color:#2D4A1E;">
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;">Cut</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:center;">Weight</td>
            <td style="padding:11px 24px;font-size:11px;font-weight:700;letter-spacing:1px;color:#FFFFFF;text-transform:uppercase;text-align:right;">Amount</td>
          </tr>${rows}
        </table>
      </td></tr>
      <tr><td style="padding:16px 32px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td></td><td width="220">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:16px;font-weight:800;color:#1A1A1A;">Total Paid</td><td style="padding:10px 0 0;border-top:1.5px solid #1A1A1A;font-size:18px;font-weight:800;color:#2D4A1E;text-align:right;">$${total.toFixed(2)}</td></tr>
          </table>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:24px 32px 8px;">
        <div style="background-color:#E3F2FD;border:1px solid #90CAF9;border-radius:10px;padding:14px 16px;font-size:13px;color:#1A1A1A;line-height:1.6;">
          <strong style="color:#2471A3;">Pickup Location</strong><br>
          17719 Spielman Road, Fairplay, MD 21733<br>
          Questions? Call (240) 818-8317.
        </div>
      </td></tr>
      <tr><td style="padding:20px 32px 4px;">
        <span style="display:inline-block;padding:6px 16px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;background-color:#E3F2FD;color:#2471A3;border:1px solid #90CAF9;">Ready for Pickup</span>
      </td></tr>${notesRow}
      <tr><td style="padding:20px 32px;background-color:#F9F7F2;border-top:1px solid #EAE6DE;">
        <div style="font-size:12px;color:#8A8A8A;text-align:center;line-height:1.6;">Questions about this order? Reply to this email or call (240) 818-8317.<br>Stone Wall Angus &middot; Family-owned since 1989 &middot; Fairplay, MD</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendReadyForPickup(env, order) {
  const sms = `Your Stone Wall Angus order is ready for pickup!\nOrder: ${order.order_number}\n${order.pickup_date?'Date: '+order.pickup_date+'\n':''}17719 Spielman Rd, Fairplay MD\nQuestions? (240) 818-8317`;
  await sendSMS(env, fmtPhone(order.customer_phone), sms);

  let items = [];
  try { const r = await sb(env, 'GET','order_items',null,`?order_id=eq.${order.id}&order=id.asc`); items = r.data || []; }
  catch(e) { console.warn('  Could not load items for ready email:', e.message); }
  const total = items.reduce((s,i) => s + parseFloat(i.line_total||0), 0) || parseFloat(order.final_total||0);

  const firstName = (order.customer_name||'').split(' ')[0] || 'Customer';
  const emailText =
    `Dear ${firstName},\n\nYour order is ready for pickup!\n\nOrder: ${order.order_number}\n${order.pickup_date?'Pickup Date: '+order.pickup_date+'\n':''}Location: 17719 Spielman Road, Fairplay, MD 21733\n\nSee you soon!\n\nStone Wall Angus\n(240) 818-8317`;
  const emailHtml = buildReadyPickupEmailHtml(order, items, total);
  await sendEmail(env, order.customer_email, `Order Ready for Pickup - Stone Wall Angus ${order.order_number}`, emailText, emailHtml);
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
app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/api/inventory', async (c) => {
  const limit = c.req.query('limit') || 500;
  const { status, data } = await sb(c.env, 'GET','inventory',null,`?order=product_id.asc&limit=${limit}`);
  return c.json(data, status);
});
app.patch('/api/inventory/:id', async (c) => {
  const body = await c.req.json();
  const { status, data } = await sb(c.env, 'PATCH','inventory',{...body,last_updated:new Date().toISOString()},`?product_id=eq.${c.req.param('id')}`);
  return c.json(data, status);
});

app.get('/api/bookings', async (c) => {
  const { status, data } = await sb(c.env, 'GET','bookings',null,'?order=created_at.desc&limit=200');
  return c.json(data, status);
});
app.post('/api/bookings', async (c) => {
  const body = await c.req.json();
  if (!body.first_name || !body.email) return c.json({ error: 'first_name and email required' }, 400);
  const { status, data } = await sb(c.env, 'POST','bookings',body);
  if (status>=200 && status<300) {
    const name = [body.first_name, body.last_name].filter(Boolean).join(' ');
    c.executionCtx.waitUntil(sendSMS(c.env, c.env.TWILIO_NOTIFY, `New Appointment\n${name} | ${body.visit_type||'N/A'}\n${body.visit_date||'TBD'} at ${body.time_slot||'TBD'}\n${body.phone||'no phone'}`));
  }
  return c.json(data, status);
});

app.get('/api/orders', async (c) => {
  const limit = c.req.query('limit') || 100;
  const { status, data } = await sb(c.env, 'GET','orders',null,`?order=created_at.desc&limit=${limit}`);
  return c.json(data, status);
});
app.post('/api/orders', async (c) => {
  const body = await c.req.json();
  const { items } = body;
  if (!items || !items.length) return c.json({ error: 'items required' }, 400);
  const orderRow = { ...body, order_source: body.order_source || 'online' };
  const { status, data } = await sb(c.env, 'POST','orders',orderRow);
  if (status<200 || status>=300) return c.json(data, status);
  const order = data[0];
  if (!order || !order.id) return c.json({ error: 'Order insert did not return a row — check Supabase RLS/return=representation settings' }, 500);
  for (const item of items) {
    const itemRes = await sb(c.env, 'POST','order_items',{
      order_id: order.id, order_number: body.order_number,
      product_id: item.id||null, product_name: item.name,
      qty_ordered: item.qty||1, unit: item.unit||'/lb',
      price_per_unit: parseFloat(item.price_per_unit||0), status:'pending',
    });
    if (itemRes.status<200 || itemRes.status>=300) {
      return c.json({ error: 'Order created, but failed to save item "'+item.name+'": '+(itemRes.data?.message||itemRes.data?.error||JSON.stringify(itemRes.data)) }, 500);
    }
  }
  c.executionCtx.waitUntil(sendNewOrderAlert(c.env, body, items));
  return c.json(data, status);
});

app.post('/api/admin/login', async (c) => {
  const body = await c.req.json().catch(()=>({}));
  const { username, password } = body;
  if (username !== (c.env.ADMIN_USERNAME||'admin') || password !== (c.env.ADMIN_PASSWORD||'SWA2024!'))
    return c.json({ error: 'Invalid credentials' }, 401);
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
  const q = statusFilter ? `?status=eq.${statusFilter}&order=created_at.desc&limit=200` : `?order=created_at.desc&limit=200`;
  const { status, data } = await sb(c.env, 'GET','orders',null,q);
  return c.json(data, status);
});
app.get('/api/admin/orders/:id', requireAdmin, async (c) => {
  const { data } = await sb(c.env, 'GET','orders',null,`?id=eq.${c.req.param('id')}&limit=1`);
  return c.json(data?.[0] || null);
});
app.get('/api/admin/orders/:id/items', requireAdmin, async (c) => {
  const { status, data } = await sb(c.env, 'GET','order_items',null,`?order_id=eq.${c.req.param('id')}&order=id.asc`);
  return c.json(data, status);
});
app.patch('/api/admin/order-items/:itemId', requireAdmin, async (c) => {
  const payload = await c.req.json();
  if (payload.weight_lbs!=null && payload.actual_price_lb!=null) {
    payload.line_total = parseFloat((parseFloat(payload.weight_lbs)*parseFloat(payload.actual_price_lb)).toFixed(2));
    payload.status = 'weighed';
  }
  await sb(c.env, 'PATCH','order_items',payload,`?id=eq.${c.req.param('itemId')}`);
  return c.json({ success: true, line_total: payload.line_total||null, status: payload.status||null });
});
app.post('/api/admin/orders/:id/invoice', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const { data: orders } = await sb(c.env, 'GET','orders',null,`?id=eq.${id}&limit=1`);
  const order = orders?.[0]; if (!order) return c.json({ error: 'Order not found' }, 404);
  const { data: items } = await sb(c.env, 'GET','order_items',null,`?order_id=eq.${id}&order=id.asc`);
  const subtotal = (items||[]).reduce((s,i)=>s+parseFloat(i.line_total||0),0);
  await sendInvoiceNotification(c.env, order, items||[]);
  const orderPatch = await sb(c.env, 'PATCH','orders',{status:'invoiced',invoice_sent_at:new Date().toISOString(),final_subtotal:parseFloat(subtotal.toFixed(2)),final_total:parseFloat(subtotal.toFixed(2))},`?id=eq.${id}`);
  if (orderPatch.status<200 || orderPatch.status>=300) {
    return c.json({ error: 'Invoice email sent, but failed to update order status: '+(orderPatch.data?.message||orderPatch.data?.error||JSON.stringify(orderPatch.data)) }, 500);
  }
  await sb(c.env, 'PATCH','order_items',{status:'invoiced'},`?order_id=eq.${id}`);
  return c.json({ success: true, total: subtotal.toFixed(2) });
});
app.patch('/api/admin/orders/:id/status', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { is_paid, items_prepared, status: newStatus } = body;
  const { data: orders } = await sb(c.env, 'GET','orders',null,`?id=eq.${id}&limit=1`);
  const order = orders?.[0]; if (!order) return c.json({ error: 'Order not found' }, 404);
  const payload = {};
  if (is_paid !== undefined) payload.is_paid = is_paid;
  if (items_prepared !== undefined) payload.items_prepared = items_prepared;
  if (newStatus !== undefined) payload.status = newStatus;
  if (newStatus === 'fulfilled') payload.fulfilled_at = new Date().toISOString();
  const nowPaid = is_paid !== undefined ? is_paid : order.is_paid;
  const nowPrepared = items_prepared !== undefined ? items_prepared : order.items_prepared;
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
  await sb(c.env, 'PATCH','orders',payload,`?id=eq.${id}`);
  if (ready) c.executionCtx.waitUntil(sendReadyForPickup(c.env, {...order, ...payload}));
  return c.json({ success: true, triggered_ready: ready, status: payload.status || order.status });
});

export default app;
