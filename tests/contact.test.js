import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler, { processContact } from '../api/contact.js';

const env = {
  CONTACT_ENABLED: 'true',
  CONTACT_ALLOWED_ORIGIN: 'https://aizen.example.com,https://www.aizen.example.com',
  TURNSTILE_SITE_KEY: 'public-site-key',
  TURNSTILE_SECRET_KEY: 'private-turnstile-secret',
  RESEND_API_KEY: 're_private_resend_key_12345',
  CONTACT_MAIL_FROM: 'AIZEN <noreply@aizen.example.com>',
};
const origin = 'https://aizen.example.com';
const submission = () => ({
  name: '山田 太郎', company: '株式会社テスト', email: 'taro@example.com', phone: '',
  message: 'セキュリティ対策について相談したいです。\n社内に担当者がいません。',
  privacyConsent: true, website: '', idempotencyKey: '123e4567-e89b-42d3-a456-426614174000', turnstileToken: 'test-token',
});
const request = (changes = {}) => ({
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: submission(),
  ...changes,
});

function mockProviders(options = {}) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = String(input);
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : JSON.parse(String(init.body));
    calls.push({ url, init, body });
    if (url.includes('siteverify')) {
      return Response.json({ success: true, hostname: options.hostname ?? 'aizen.example.com', action: 'contact', challenge_ts: new Date().toISOString(), ...options.verification });
    }
    if (options.failDelivery) throw new Error('connection dropped');
    return Response.json(options.receipt ?? { data: [{ id: 'email_notice_12345' }, { id: 'email_reply_12345' }] }, { status: options.deliveryStatus ?? 200 });
  };
  return { fetch, calls };
}

test('closed by default and when any setting is missing or invalid', async () => {
  const provider = mockProviders();
  assert.equal((await processContact(request(), {}, provider)).status, 503);
  for (const key of Object.keys(env)) assert.equal((await processContact(request(), { ...env, [key]: '' }, provider)).status, 503, key);
  for (const changes of [
    { CONTACT_ENABLED: 'TRUE' }, { CONTACT_ALLOWED_ORIGIN: 'https://aizen.example.com/' },
    { CONTACT_ALLOWED_ORIGIN: 'https://aizen.example.com,http://www.aizen.example.com' },
    { TURNSTILE_SECRET_KEY: 'secret\n' }, { TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
    { RESEND_API_KEY: 'not-a-key' }, { CONTACT_MAIL_FROM: '"AIZEN" <noreply@aizen.example.com>' }, { CONTACT_MAIL_TO: 'nobody' },
  ]) assert.equal((await processContact(request(), { ...env, ...changes }, provider)).status, 503, JSON.stringify(changes));
  assert.equal(provider.calls.length, 0);
});

test('GET reports readiness and a pass/fail per setting, never secrets', async () => {
  const ready = await processContact({ method: 'GET', headers: {} }, env);
  assert.deepEqual(ready.body, {
    ready: true, siteKey: 'public-site-key',
    checks: { CONTACT_ENABLED: true, CONTACT_ALLOWED_ORIGIN: true, TURNSTILE_SITE_KEY: true, TURNSTILE_SECRET_KEY: true, RESEND_API_KEY: true, CONTACT_MAIL_FROM: true, CONTACT_MAIL_TO: true },
  });
  for (const secret of [env.TURNSTILE_SECRET_KEY, env.RESEND_API_KEY]) assert.ok(!JSON.stringify(ready.body).includes(secret));
  const broken = await processContact({ method: 'GET', headers: {} }, { ...env, RESEND_API_KEY: 're_x' });
  assert.equal(broken.body.ready, false);
  assert.equal(broken.body.siteKey, null);
  assert.equal(broken.body.checks.RESEND_API_KEY, false);
});

test('only listed origins may post, and Turnstile must match that origin', async () => {
  for (const bad of [undefined, 'https://evil.example', 'https://aizen.example.com.evil.example']) {
    const provider = mockProviders();
    assert.equal((await processContact(request({ headers: { origin: bad, 'content-type': 'application/json' } }), env, provider)).status, 403);
    assert.equal(provider.calls.length, 0);
  }
  assert.equal((await processContact(request({ headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } }), env)).status, 403);
  const www = mockProviders({ hostname: 'www.aizen.example.com' });
  assert.equal((await processContact(request({ headers: { origin: 'https://www.aizen.example.com', 'content-type': 'application/json' } }), env, www)).status, 202);
  const mismatch = mockProviders({ hostname: 'www.aizen.example.com' });
  assert.equal((await processContact(request(), env, mismatch)).status, 400);
  assert.equal(mismatch.calls.length, 1);
});

test('validates fields, consent and honeypot before calling any provider', async () => {
  for (const changes of [
    { name: '' }, { email: 'not-an-email' }, { message: '' }, { privacyConsent: 'true' }, { idempotencyKey: 'x' },
    { turnstileToken: '' }, { name: 'a\nBcc: x@example.com' }, { company: 'x'.repeat(161) }, { phone: 'abc' }, { website: 'spam' },
  ]) {
    const provider = mockProviders();
    const output = await processContact(request({ body: { ...submission(), ...changes } }), env, provider);
    assert.equal(output.status, 400, JSON.stringify(changes));
    assert.equal(provider.calls.length, 0);
  }
  assert.equal((await processContact(request({ body: '{broken' }), env)).status, 400);
  assert.equal((await processContact(request({ headers: { origin, 'content-type': 'text/plain' } }), env)).status, 415);
});

test('a failed or stale Turnstile check never sends email', async () => {
  for (const verification of [{ success: false }, { action: 'login' }, { challenge_ts: new Date(Date.now() - 300_000).toISOString() }, { 'error-codes': ['timeout-or-duplicate'] }]) {
    const provider = mockProviders({ verification });
    assert.equal((await processContact(request(), env, provider)).status, 400);
    assert.equal(provider.calls.length, 1);
  }
});

test('sends the notification and a fixed-text auto-reply in one idempotent batch', async () => {
  const provider = mockProviders();
  const output = await processContact(request(), env, provider);
  assert.equal(output.status, 202);
  assert.deepEqual(output.body, { ok: true, requestId: 'email_notice_12345' });
  const [verify, delivery] = provider.calls;
  assert.equal(verify.body.secret, env.TURNSTILE_SECRET_KEY);
  assert.equal(delivery.url, 'https://api.resend.com/emails/batch');
  assert.equal(delivery.init.headers.Authorization, `Bearer ${env.RESEND_API_KEY}`);
  assert.equal(delivery.init.headers['Idempotency-Key'], 'aizen-contact/123e4567-e89b-42d3-a456-426614174000');
  const [notice, reply] = delivery.body;
  assert.deepEqual(notice.to, ['info@aizen.ne.jp']);
  assert.equal(notice.reply_to, 'taro@example.com');
  assert.equal(notice.subject, '【AIZEN】Webサイトからのお問い合わせ（株式会社テスト）');
  for (const line of ['会社名：株式会社テスト', '氏名：山田 太郎', '電話番号：（未入力）', '社内に担当者がいません。']) assert.ok(notice.text.includes(line), line);
  assert.deepEqual(reply.to, ['taro@example.com']);
  assert.equal(reply.reply_to, 'info@aizen.ne.jp');
  assert.equal(reply.subject, '【AIZEN】お問い合わせを受け付けました');
  for (const typed of ['山田', '株式会社テスト', 'セキュリティ対策']) assert.ok(!reply.text.includes(typed), typed);
  for (const email of delivery.body) assert.equal(email.html, undefined);
});

test('company is optional and the subject falls back to the name', async () => {
  const provider = mockProviders();
  assert.equal((await processContact(request({ body: { ...submission(), company: '' } }), env, provider)).status, 202);
  assert.equal(provider.calls[1].body[0].subject, '【AIZEN】Webサイトからのお問い合わせ（山田 太郎）');
  assert.ok(provider.calls[1].body[0].text.includes('会社名：（未入力）'));
});

test('Resend failures are reported as unconfirmed and logged without inquiry content', async (context) => {
  const logged = [];
  context.mock.method(console, 'error', (...args) => { logged.push(args.join(' ')); });
  const rejected = await processContact(request(), env, mockProviders({ deliveryStatus: 403, receipt: { name: 'validation_error', message: 'The aizen.ne.jp domain is not verified. Contact owner@example.com' } }));
  assert.equal(rejected.status, 503);
  assert.match(logged[0], /"status":403.*validation_error.*domain is not verified/);
  for (const secret of ['owner@example.com', 'taro@example.com', '山田', env.RESEND_API_KEY]) assert.ok(!logged[0].includes(secret), secret);
  for (const options of [{ failDelivery: true }, { receipt: { data: [{ id: 'email_notice_12345' }] } }, { receipt: { id: 'email_notice_12345' } }]) {
    assert.equal((await processContact(request(), env, mockProviders(options))).status, 503);
  }
  assert.equal((await processContact(request(), env, mockProviders({ deliveryStatus: 409 }))).status, 409);
});

test('an unchanged retry sends the identical request so Resend does not send twice', async () => {
  const first = mockProviders();
  const retry = mockProviders();
  await processContact(request(), env, first);
  await processContact(request({ body: { ...submission(), turnstileToken: 'fresh-token' } }), env, retry);
  assert.equal(first.calls[1].init.headers['Idempotency-Key'], retry.calls[1].init.headers['Idempotency-Key']);
  assert.equal(first.calls[1].init.body, retry.calls[1].init.body);
});

test('the Vercel handler passes the result and headers through', async (context) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    context.mock.method(globalThis, 'fetch', mockProviders().fetch);
    const captured = { headers: {} };
    const response = {
      setHeader(name, value) { captured.headers[name] = value; return response; },
      status(value) { captured.status = value; return response; },
      json(value) { captured.body = value; return response; },
    };
    await handler(request(), response);
    assert.equal(captured.status, 202);
    assert.equal(captured.headers['Cache-Control'], 'no-store, max-age=0');
  } finally {
    for (const key of Object.keys(env)) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});
