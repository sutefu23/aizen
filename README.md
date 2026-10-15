# AIZEN website

Static site (`index.html`, `styles.css`, `/privacy/`) deployed on Vercel, plus one Vercel function for the contact form.

## Contact form

`contact.js` asks `GET /api/contact` whether the form is ready. On submit it gets a Cloudflare Turnstile token and posts to `api/contact.js`, which verifies the token and sends, in one Resend batch request:

- a notification to `info@aizen.ne.jp` (or `CONTACT_MAIL_TO`), Reply-To set to the visitor;
- a fixed-text auto-reply to the visitor, Reply-To set to AIZEN. It never echoes the form, so it cannot be abused to send arbitrary text from AIZEN's domain.

Nothing is stored. A retry with unchanged input reuses the same idempotency key, so Resend does not send either email twice. Until every setting below is valid, the form stays disabled and points visitors to the email address.

### Vercel environment variables (Production)

| Variable | Value |
| --- | --- |
| `CONTACT_ENABLED` | `true` to open the form |
| `CONTACT_ALLOWED_ORIGIN` | Exact origins, comma-separated, e.g. `https://aizen.ne.jp,https://www.aizen.ne.jp` (no trailing `/`) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | From a Managed Turnstile widget whose hostnames include the domains above |
| `RESEND_API_KEY` | Resend key (`re_...`) with sending access |
| `CONTACT_MAIL_FROM` | Sender on a domain verified in Resend, e.g. `AIZEN <noreply@aizen.ne.jp>` |
| `CONTACT_MAIL_TO` | Optional; defaults to `info@aizen.ne.jp` |

The same Turnstile widget and Resend key as the SENTINEL site can be reused: add this site's hostnames to the widget. After deploying, open `/api/contact`: `"ready": true` means the form is live; otherwise a `false` under `checks` names the variable to fix. If Resend rejects a send, the reason is written to the Vercel function log (`[contact] Resend did not accept the emails`).

### Tests

```sh
npm test
```

The tests mock Cloudflare and Resend and send nothing.
