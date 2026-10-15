import { randomUUID } from 'node:crypto';

/**
 * AIZEN website contact form. A verified inquiry is emailed to AIZEN through Resend together
 * with a fixed-text auto-reply to the visitor. Nothing is stored by this function.
 */
export const MAX_BODY_BYTES = 24_576;
export const TURNSTILE_ACTION = 'contact';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_BATCH = 'https://api.resend.com/emails/batch';
const DEFAULT_RECIPIENT = 'info@aizen.ne.jp';
const MAX_TOKEN_LENGTH = 2048;
const EMAIL = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function header(headers, key) {
  const entry = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === key);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function result(status, body, extra = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...extra,
    },
    body,
  };
}

function error(status, code, message, extra = {}) {
  return result(status, { ok: false, code, message, ...extra });
}

/** Comma-separated exact HTTPS origins, e.g. "https://aizen.ne.jp,https://www.aizen.ne.jp". */
function allowedOrigins(value) {
  const entries = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const origins = entries.flatMap((entry) => {
    try {
      const url = new URL(entry);
      return url.protocol === 'https:' && entry === url.origin ? [url.origin] : [];
    } catch {
      return [];
    }
  });
  return entries.length > 0 && origins.length === entries.length ? origins : [];
}

function providerKey(value) {
  // Reject empty/whitespace-padded values and Cloudflare's published universal dummy keys.
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(value) && !/^[123]x0{20,}[A-Z]{2}$/.test(value);
}

/** A bare address or "Name <address>". */
function sender(value) {
  if (!value || value.length > 200) return false;
  const match = /^(?:[^<>"\p{Cc}]{1,80} <([^<>\s]+)>|([^<>\s]+))$/u.exec(value);
  return Boolean(match && EMAIL.test(match[1] ?? match[2]));
}

function configuration(env) {
  const origins = allowedOrigins(env.CONTACT_ALLOWED_ORIGIN);
  const recipient = env.CONTACT_MAIL_TO || DEFAULT_RECIPIENT;
  // Pass/fail per setting, so an operator can see which variable is wrong. Never values.
  const checks = {
    CONTACT_ENABLED: env.CONTACT_ENABLED === 'true',
    CONTACT_ALLOWED_ORIGIN: origins.length > 0,
    TURNSTILE_SITE_KEY: providerKey(env.TURNSTILE_SITE_KEY),
    TURNSTILE_SECRET_KEY: providerKey(env.TURNSTILE_SECRET_KEY),
    RESEND_API_KEY: /^re_[a-zA-Z0-9_-]{8,200}$/.test(env.RESEND_API_KEY ?? ''),
    CONTACT_MAIL_FROM: sender(env.CONTACT_MAIL_FROM),
    CONTACT_MAIL_TO: EMAIL.test(recipient),
  };
  return { origins, recipient, checks, ready: Object.values(checks).every(Boolean) };
}

function hasControls(value, multiline) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && !(multiline && [9, 10, 13].includes(code)));
  });
}

function validate(body) {
  const fieldErrors = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { fieldErrors: { form: '入力内容を確認してください。' } };
  const text = (key, max, required = true, multiline = false) => {
    const raw = body[key];
    if (!required && (raw === undefined || raw === '')) return '';
    if (typeof raw !== 'string') { fieldErrors[key] = '入力内容を確認してください。'; return ''; }
    const value = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim();
    if ((required && !value) || value.length > max || hasControls(value, multiline)) fieldErrors[key] = `入力内容を確認してください（${max}文字以内）。`;
    return value;
  };
  const name = text('name', 100);
  const company = text('company', 160, false);
  const email = text('email', 254);
  const phone = text('phone', 40, false);
  const message = text('message', 4000, true, true);
  if (!EMAIL.test(email)) fieldErrors.email = '有効なメールアドレスを入力してください。';
  if (phone && !/^[+0-9()\- .]{5,40}$/.test(phone)) fieldErrors.phone = '電話番号を確認してください。';
  if (body.privacyConsent !== true) fieldErrors.privacyConsent = '個人情報の取り扱いへの同意が必要です。';
  if (typeof body.idempotencyKey !== 'string' || !UUID_V4.test(body.idempotencyKey)) fieldErrors.form = 'ページを再読み込みしてお試しください。';
  if (typeof body.turnstileToken !== 'string' || !body.turnstileToken.trim() || body.turnstileToken.length > MAX_TOKEN_LENGTH || hasControls(body.turnstileToken, false)) {
    fieldErrors.turnstileToken = '確認を完了してから送信してください。';
  }
  // A filled honeypot fails openly; it must never look like a delivered inquiry.
  if (body.website !== undefined && body.website !== '') fieldErrors.form = '入力内容を確認してください。';
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  return { value: { data: { name, company, email, phone, message }, idempotencyKey: body.idempotencyKey.toLowerCase(), turnstileToken: body.turnstileToken } };
}

/** Plain text only, so submitted content is never rendered as HTML in the mailbox. */
export function notificationText(data) {
  return [
    'AIZENのWebサイトからお問い合わせがありました。',
    'このメールに返信すると、お問い合わせいただいた方に届きます。',
    '',
    `会社名：${data.company || '（未入力）'}`,
    `氏名：${data.name}`,
    `メールアドレス：${data.email}`,
    `電話番号：${data.phone || '（未入力）'}`,
    '',
    '■お問い合わせ内容',
    data.message,
  ].join('\n');
}

/**
 * Fixed text with no submitted content. Anyone can type someone else's address, so echoing
 * the form would let a stranger send their own text to that address from AIZEN's domain.
 */
export function autoReplyText(recipient) {
  return [
    'このメールは、株式会社AIZENのWebサイトからお問い合わせいただいた方へ自動でお送りしています。',
    '',
    'お問い合わせいただき、ありがとうございます。',
    '内容を確認のうえ、担当者からご連絡いたします。',
    `数日たっても連絡がない場合は、お手数ですが${recipient}までご連絡ください。`,
    'このメールに返信いただいても、担当者に届きます。',
    '',
    'お心当たりがない場合は、このメールを破棄してください。',
    '',
    '--',
    '株式会社AIZEN',
    '東京都港区芝5丁目36−4',
    '札の辻スクエア9F',
    'https://aizen.ne.jp/',
  ].join('\n');
}

async function boundedJson(response) {
  if (!response.body) throw new Error('empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('oversized response');
      chunks.push(chunk.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid response');
    return value;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

class DeliveryFailure extends Error {}

/** Logs why Resend refused the emails (Vercel → Logs). No inquiry content; addresses masked. */
function logDeliveryFailure(detail) {
  const text = (value) => typeof value === 'string' ? value.slice(0, 300).replace(/[^\s@<>"]+@[^\s@<>"]+/g, '[email]') : undefined;
  console.error('[contact] Resend did not accept the emails', JSON.stringify({ status: detail.status, name: text(detail.name), message: text(detail.message) }));
}

async function verifyTurnstile(token, expectedHostname, env, fetcher, now) {
  // Retries of this one validation share a UUID, so Cloudflare does not count a token twice.
  const key = randomUUID();
  let verification;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetcher(SITEVERIFY, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, idempotency_key: key }),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
        throw new Error('verification unavailable');
      }
      verification = await boundedJson(response);
    } catch (reason) {
      if (attempt === 0 && reason instanceof Error && ['TypeError', 'TimeoutError', 'AbortError'].includes(reason.name)) continue;
      throw reason;
    }
    const codes = verification['error-codes'];
    if (verification.success === false && Array.isArray(codes) && codes.length === 1 && codes[0] === 'internal-error') {
      if (attempt === 0) continue;
      throw new Error('verification unavailable');
    }
    break;
  }
  if (!verification) throw new Error('verification unavailable');
  const challengeTime = typeof verification.challenge_ts === 'string' ? Date.parse(verification.challenge_ts) : NaN;
  const age = now().getTime() - challengeTime;
  const providerErrors = verification['error-codes'];
  return verification.success === true && verification.hostname === expectedHostname && verification.action === TURNSTILE_ACTION &&
    Number.isFinite(challengeTime) && age < 300_000 && age >= -10_000 &&
    (providerErrors === undefined || (Array.isArray(providerErrors) && providerErrors.length === 0)) && verification.error === undefined;
}

/** Framework-independent core, with injected fetch/time for tests. */
export async function processContact(request, env = process.env, dependencies = {}) {
  const config = configuration(env);
  if (request.method === 'GET') {
    return result(200, { ready: config.ready, siteKey: config.ready ? env.TURNSTILE_SITE_KEY : null, checks: config.checks });
  }
  if (request.method !== 'POST') return result(405, { ok: false, code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET, POST' });
  if (!config.ready) return error(503, 'UNAVAILABLE', '現在フォームの受付を準備しています。メールでお問い合わせください。');

  const origin = header(request.headers, 'origin');
  const fetchSite = header(request.headers, 'sec-fetch-site');
  if (!origin || !config.origins.includes(origin) || (fetchSite && fetchSite !== 'same-origin')) {
    return error(403, 'ORIGIN_REJECTED', 'このページから送信してください。');
  }
  if (header(request.headers, 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return error(415, 'UNSUPPORTED_MEDIA_TYPE', '入力内容を確認してください。');
  }
  const length = header(request.headers, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return error(413, 'PAYLOAD_TOO_LARGE', '入力内容が長すぎます。');
  let body;
  try {
    const raw = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    if (typeof raw !== 'string') return error(400, 'INVALID_JSON', '入力内容を確認してください。');
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return error(413, 'PAYLOAD_TOO_LARGE', '入力内容が長すぎます。');
    body = JSON.parse(raw);
  } catch {
    return error(400, 'INVALID_JSON', '入力内容を確認してください。');
  }
  const validation = validate(body);
  if (!validation.value) return error(400, 'VALIDATION_FAILED', '入力内容を確認してください。', { fieldErrors: validation.fieldErrors });
  const { data, idempotencyKey, turnstileToken } = validation.value;

  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => new Date());
  try {
    if (!await verifyTurnstile(turnstileToken, new URL(origin).hostname, env, fetcher, now)) {
      return error(400, 'VERIFICATION_FAILED', '確認の有効期限が切れたか、確認できませんでした。再度お試しください。');
    }
  } catch {
    return error(503, 'VERIFICATION_UNAVAILABLE', '確認サービスに接続できません。時間をおいてお試しください。');
  }

  try {
    // Resend replays the first result for 24 hours for the same key and body, so a retry after
    // a lost response sends neither email twice. Keep the body identical for unchanged input.
    const response = await fetcher(RESEND_BATCH, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Idempotency-Key': `aizen-contact/${idempotencyKey}`,
      },
      body: JSON.stringify([
        {
          from: env.CONTACT_MAIL_FROM,
          to: [config.recipient],
          reply_to: data.email,
          subject: `【AIZEN】Webサイトからのお問い合わせ（${data.company || data.name}）`,
          text: notificationText(data),
        },
        {
          from: env.CONTACT_MAIL_FROM,
          to: [data.email],
          reply_to: config.recipient,
          subject: '【AIZEN】お問い合わせを受け付けました',
          text: autoReplyText(config.recipient),
        },
      ]),
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 409) {
      await response.body?.cancel();
      return error(409, 'IDEMPOTENCY_CONFLICT', '入力内容が変更されています。ページを再読み込みしてお試しください。');
    }
    if (!response.ok) {
      const detail = await boundedJson(response).catch(() => ({}));
      logDeliveryFailure({ status: response.status, name: detail.name, message: detail.message });
      throw new DeliveryFailure();
    }
    const receipt = await boundedJson(response);
    const sent = Array.isArray(receipt.data) ? receipt.data : [];
    if (sent.length !== 2 || !sent.every((item) => typeof item?.id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(item.id))) {
      logDeliveryFailure({ status: response.status, name: 'unexpected_response', message: `keys: ${Object.keys(receipt).join(',')}; items: ${sent.length}` });
      throw new DeliveryFailure();
    }
    return result(202, { ok: true, requestId: sent[0].id });
  } catch (reason) {
    if (!(reason instanceof DeliveryFailure)) logDeliveryFailure({ name: reason instanceof Error ? reason.name : 'unknown', message: reason instanceof Error ? reason.message : undefined });
    return error(503, 'DELIVERY_UNAVAILABLE', '送信を確認できませんでした。入力内容はそのままで、時間をおいて再度お試しください。');
  }
}

export default async function handler(request, response) {
  try {
    const output = await processContact({ method: request.method, headers: request.headers, body: request.body });
    for (const [name, value] of Object.entries(output.headers)) response.setHeader(name, value);
    response.status(output.status).json(output.body);
  } catch {
    // Last resort. No inquiry content is written to the logs.
    response.setHeader('Cache-Control', 'no-store');
    response.status(503).json({ ok: false, code: 'UNAVAILABLE', message: '現在送信できません。時間をおいてお試しください。' });
  }
}
