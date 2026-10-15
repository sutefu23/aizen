// Contact form: checks /api/contact, gets a Turnstile token on submit, then posts the inquiry.
(() => {
  const form = document.getElementById('contact-form');
  if (!form) return;
  const fields = document.getElementById('contact-fields');
  const submit = document.getElementById('contact-submit');
  const notice = document.getElementById('contact-notice');
  const statusLine = document.getElementById('contact-status');
  const errorBox = document.getElementById('contact-error');
  const widget = document.getElementById('contact-turnstile');
  const done = document.getElementById('contact-done');
  const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const SUBMIT_LABEL = 'この内容で送信する';
  let siteKey = null;
  let busy = false;
  let inquiryKey = '';
  let lastSnapshot = '';

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
    if (message) errorBox.focus();
  }

  function unavailable() {
    notice.hidden = false;
    fields.disabled = true;
    submit.disabled = true;
    submit.textContent = '受付準備中';
  }

  const statusTimeout = AbortSignal.timeout(8000);
  fetch('/api/contact', { cache: 'no-store', signal: statusTimeout })
    .then((response) => (response.ok ? response.json() : null))
    .then((status) => {
      if (status && status.ready === true && typeof status.siteKey === 'string' && status.siteKey) {
        siteKey = status.siteKey;
        fields.disabled = false;
        submit.disabled = false;
        submit.textContent = SUBMIT_LABEL;
      } else unavailable();
    })
    .catch(unavailable);

  /** Load api.js once. Do not call turnstile.ready(): it throws for async scripts like this one. */
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = (message) => { window.clearTimeout(timer); script.remove(); reject(new Error(message)); };
      const timer = window.setTimeout(() => fail('認証の読み込みがタイムアウトしました。時間をおいて再度お試しください。'), 15000);
      script.src = SCRIPT_URL;
      script.async = true;
      script.addEventListener('load', () => {
        window.clearTimeout(timer);
        if (window.turnstile) resolve(window.turnstile);
        else fail('認証を読み込めませんでした。通信環境をご確認ください。');
      }, { once: true });
      script.addEventListener('error', () => fail('認証を読み込めませんでした。通信環境をご確認ください。'), { once: true });
      document.head.append(script);
    });
  }

  /** Render a fresh widget and resolve with its one-time token. Always call cleanup afterwards. */
  function requestToken(api) {
    let widgetId;
    let timer;
    const token = new Promise((resolve, reject) => {
      const fail = (message) => () => reject(new Error(message));
      timer = window.setTimeout(fail('認証が完了しませんでした。再度お試しください。'), 120000);
      widgetId = api.render(widget, {
        sitekey: siteKey,
        action: 'contact',
        execution: 'execute',
        appearance: 'interaction-only',
        theme: 'light',
        language: 'ja',
        retry: 'never',
        'refresh-expired': 'never',
        'response-field': false,
        callback: resolve,
        'before-interactive-callback': () => { statusLine.textContent = '下の認証画面で確認を完了してください。'; widget.focus(); },
        'error-callback': fail('認証に失敗しました。再度お試しください。'),
        'expired-callback': fail('認証の有効期限が切れました。再度お試しください。'),
        'timeout-callback': fail('認証が完了しませんでした。再度お試しください。'),
        'unsupported-callback': fail('このブラウザでは認証を表示できません。メールでお問い合わせください。'),
      });
      if (widgetId === undefined) reject(new Error('認証を表示できませんでした。再度お試しください。'));
      else api.execute(widgetId);
    });
    const cleanup = () => {
      window.clearTimeout(timer);
      if (widgetId !== undefined) { try { api.remove(widgetId); } catch { widget.replaceChildren(); } }
    };
    return { token, cleanup };
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    showError('');
    if (!siteKey) { unavailable(); return; }
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const text = (name) => String(values.get(name) ?? '').normalize('NFC').replace(/\r\n?/g, '\n').trim();
    const payload = {
      name: text('name'), company: text('company'), email: text('email'), phone: text('phone'), message: text('message'),
      website: text('website'), privacyConsent: values.get('privacyConsent') === 'on',
    };
    // Keep one key while the input is unchanged, so a retry never sends a second email.
    const snapshot = JSON.stringify(payload);
    if (!inquiryKey || snapshot !== lastSnapshot) { inquiryKey = crypto.randomUUID(); lastSnapshot = snapshot; }
    busy = true;
    fields.disabled = true;
    submit.disabled = true;
    submit.textContent = '送信しています';
    statusLine.textContent = 'スパム対策の確認をしています。';
    let challenge;
    try {
      const api = await loadTurnstile();
      challenge = requestToken(api);
      const turnstileToken = await challenge.token;
      statusLine.textContent = '送信しています。';
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, turnstileToken, idempotencyKey: inquiryKey }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json().catch(() => null);
      if (response.status !== 202 || !result || result.ok !== true) {
        throw new Error(result?.message || '送信できませんでした。入力内容を確認して、再度お試しください。');
      }
      form.hidden = true;
      done.hidden = false;
      done.focus();
    } catch (reason) {
      const network = reason instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(reason.name);
      showError(network ? '通信に失敗しました。送信できたかは確認できていません。入力内容はそのままで、時間をおいて再度お試しください。' : reason.message);
    } finally {
      challenge?.cleanup();
      busy = false;
      statusLine.textContent = '';
      if (!form.hidden) {
        fields.disabled = false;
        submit.disabled = false;
        submit.textContent = SUBMIT_LABEL;
      }
    }
  });
})();
