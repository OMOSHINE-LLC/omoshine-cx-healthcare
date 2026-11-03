import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface SigningMethods { sso: boolean; pin: boolean }

let cached: Promise<SigningMethods> | null = null;
/** How this person re-authenticates to sign: their signing PIN, an SSO step-up, or either. */
export function signingMethods(): Promise<SigningMethods> {
  cached ??= api<{ signing?: SigningMethods }>('/me').then((m) => m.signing ?? { sso: false, pin: true }).catch(() => ({ sso: false, pin: true }));
  return cached;
}
export function resetSigningMethods() { cached = null; }

export const SSO_CALLBACK_PATH = '/sso/callback';
const MESSAGE_TYPE = 'omoshine-sso-reauth';

/**
 * Re-authenticate at the identity provider in a popup (fresh sign-in forced by the API),
 * then exchange the result for a short-lived re-authentication token.
 */
export async function ssoStepUp(): Promise<string> {
  const { authorizationUrl } = await api<{ authorizationUrl: string }>('/auth/sso/reauth/start', { body: { redirectUri: `${location.origin}${SSO_CALLBACK_PATH}` } });
  const popup = window.open(authorizationUrl, 'omoshine-sso', 'width=520,height=680');
  if (!popup) throw new Error('Allow pop-ups for this site to sign with single sign-on');
  const result = await new Promise<{ code?: string; state?: string; error?: string }>((resolve, reject) => {
    const timer = setInterval(() => { if (popup.closed) { cleanup(); reject(new Error('Single sign-on window was closed')); } }, 500);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== MESSAGE_TYPE) return;
      cleanup();
      resolve(e.data);
    };
    const cleanup = () => { clearInterval(timer); window.removeEventListener('message', onMessage); };
    window.addEventListener('message', onMessage);
  });
  if (result.error || !result.code || !result.state) throw new Error(result.error ?? 'Single sign-on did not complete');
  const { reauthToken } = await api<{ reauthToken: string }>('/auth/sso/reauth/callback', { body: { code: result.code, state: result.state } });
  return reauthToken;
}

/** Runs in the popup (or the main window for sign-in) when the identity provider redirects back. */
export function SsoCallbackPage({ onLogin }: { onLogin: (token: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get('code') ?? undefined;
    const state = q.get('state') ?? undefined;
    const error = q.get('error_description') ?? q.get('error') ?? undefined;
    if (window.opener && window.opener !== window) {
      window.opener.postMessage({ type: MESSAGE_TYPE, code, state, error }, location.origin);
      window.close();
      return;
    }
    if (error || !code || !state) { setErr(error ?? 'Single sign-on did not complete'); return; }
    api<{ token: string }>('/auth/sso/callback', { body: { code, state } })
      .then((r) => onLogin(r.token))
      .catch((x) => setErr((x as Error).message));
  }, [onLogin]);
  return (
    <div className="login">
      <div className="card">
        <img src="/omoshine-logo.png" alt="OMOSHINE logo" />
        {err ? <><p className="error" role="alert">{err}</p><a href="/">Back to sign in</a></> : <p>Completing sign-in…</p>}
      </div>
    </div>
  );
}

/**
 * The re-authentication part of every signing dialog: the signing PIN, an SSO step-up,
 * or both, depending on the organization's policy. Calls onToken with a re-authentication token.
 */
export function ReauthForm({ children, onToken, onClose, submitLabel = 'Sign', methods }: {
  children?: ReactNode; onToken: (reauthToken: string) => Promise<void>; onClose: () => void; submitLabel?: string; methods?: SigningMethods;
}) {
  const [m, setM] = useState<SigningMethods | null>(methods ?? null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!methods) signingMethods().then(setM); }, [methods]);
  const run = async (get: () => Promise<string>) => {
    setErr(null); setBusy(true);
    try { await onToken(await get()); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="dialog" onSubmit={(e) => {
      e.preventDefault();
      run(async () => (await api<{ reauthToken: string }>('/auth/reauth', { body: { pin } })).reauthToken);
    }}>
      {children}
      {m?.pin !== false && (
        <label style={{ marginTop: 8 }}>Re-enter your signing PIN<input type="password" autoComplete="off" required minLength={4} value={pin} onChange={(e) => setPin(e.target.value)} /></label>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        {m?.pin !== false && <button className="primary" type="submit" disabled={busy}>{submitLabel}</button>}
        {m?.sso && (
          <button type="button" className={m.pin ? undefined : 'primary'} disabled={busy} onClick={() => run(ssoStepUp)}>
            {m.pin ? 'Sign with single sign-on instead' : `${submitLabel} with single sign-on`}
          </button>
        )}
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
