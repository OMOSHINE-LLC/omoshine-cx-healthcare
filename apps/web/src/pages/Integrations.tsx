import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Loading, fmtDate, useApi } from '../components';

interface ApiKey { id: string; name: string; prefix: string; role: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
export interface Webhook { id: string; url: string; events: string[]; active: boolean; description: string; failed: string; pending: string; last_delivered_at: string | null }
interface Delivery { id: string; event: string; status: string; attempts: number; last_status_code: number | null; last_error: string | null; created_at: string }

const ROLES = ['tab', 'design_engineer', 'facilities_ops', 'cxa', 'gc'];

/** A secret shown exactly once, with a copy button. */
export function OneTimeSecret({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="card" role="alert" style={{ borderColor: 'var(--gold)' }}>
      <strong>{label}</strong>
      <p className="muted" style={{ margin: '4px 0 8px' }}>Copy it now. It is stored only as a hash and will not be shown again.</p>
      <code style={{ display: 'block', wordBreak: 'break-all', padding: 8, background: 'var(--ivory)' }}>{value}</code>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => { navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined); }}>{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={onDone}>I have stored it</button>
      </div>
    </div>
  );
}

export function WebhookRow({ hook, onToggle, onPing, onShowDeliveries }: { hook: Webhook; onToggle: () => void; onPing: () => void; onShowDeliveries: () => void }) {
  return (
    <tr>
      <td style={{ wordBreak: 'break-all' }}>{hook.url}{hook.description && <div className="muted" style={{ fontSize: 12 }}>{hook.description}</div>}</td>
      <td style={{ fontSize: 12 }}>{hook.events.join(', ')}</td>
      <td><span className={`chip ${hook.active ? 'chip-pass' : 'chip-closed'}`}>{hook.active ? 'Active' : 'Paused'}</span>
        {Number(hook.failed) > 0 && <div className="error" style={{ fontSize: 12 }}>{hook.failed} failed</div>}</td>
      <td>{fmtDate(hook.last_delivered_at)}</td>
      <td className="row">
        <button onClick={onToggle}>{hook.active ? 'Pause' : 'Resume'}</button>
        <button onClick={onPing}>Send test</button>
        <button onClick={onShowDeliveries}>Deliveries</button>
      </td>
    </tr>
  );
}

export function IntegrationsPage() {
  const { projectId } = useParams();
  const keys = useApi<ApiKey[]>('/integration-keys');
  const hooks = useApi<Webhook[]>('/webhooks');
  const events = useApi<{ events: string[] }>('/integrations/events');
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [keyForm, setKeyForm] = useState({ name: '', role: 'tab' });
  const [hookForm, setHookForm] = useState({ url: '', events: [] as string[], description: '' });
  const [deliveriesOf, setDeliveriesOf] = useState<string | null>(null);
  const deliveries = useApi<Delivery[]>(deliveriesOf ? `/webhooks/${deliveriesOf}/deliveries` : null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); } catch (x) { setErr((x as Error).message); } };

  if (keys.error && /permission|administrator/i.test(keys.error)) {
    return <><h1>Integrations</h1><p className="card">Only a tenant administrator can manage API keys and webhooks.</p></>;
  }
  return (
    <>
      <h1>Integrations</h1>
      <p className="muted">API keys let another system (a BAS gateway, a scheduling tool) read and write this project with a fixed role. Webhooks notify another system when something happens here. Both are tenant-administrator settings.</p>
      {secret && <OneTimeSecret label={secret.label} value={secret.value} onDone={() => setSecret(null)} />}
      {err && <p className="error" role="alert">{err}</p>}

      <div className="card">
        <h2>API keys</h2>
        <form className="row" onSubmit={(e) => { e.preventDefault(); run(async () => {
          const k = await api<{ token: string }>('/integration-keys', { body: { name: keyForm.name, projectId, role: keyForm.role } });
          setSecret({ label: `API key for ${keyForm.name}`, value: k.token });
          setKeyForm({ ...keyForm, name: '' });
          keys.reload();
        }); }}>
          <input aria-label="Key name" placeholder="e.g. BAS gateway" required minLength={2} value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} style={{ width: 'auto', flex: 1, minWidth: 180 }} />
          <select aria-label="Role" value={keyForm.role} onChange={(e) => setKeyForm({ ...keyForm, role: e.target.value })} style={{ width: 'auto' }}>
            {ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
          </select>
          <button className="primary" type="submit">Create key</button>
        </form>
        <Loading error={keys.error}>
          <table>
            <thead><tr><th>Name</th><th>Key</th><th>Role</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {keys.data?.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td><td><code>omk_{k.prefix}_…</code></td><td>{k.role}</td><td>{fmtDate(k.last_used_at)}</td>
                  <td>{k.revoked_at ? <span className="muted">Revoked {fmtDate(k.revoked_at)}</span>
                    : <button onClick={() => run(async () => { await api(`/integration-keys/${k.id}`, { method: 'DELETE' }); keys.reload(); })}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
      </div>

      <div className="card">
        <h2>Webhooks</h2>
        <form onSubmit={(e) => { e.preventDefault(); run(async () => {
          const h = await api<{ secret: string }>('/webhooks', { body: { url: hookForm.url, events: hookForm.events, projectId, description: hookForm.description } });
          setSecret({ label: 'Webhook signing secret', value: h.secret });
          setHookForm({ url: '', events: [], description: '' });
          hooks.reload();
        }); }}>
          <div className="form-grid">
            <label>Endpoint URL (https)<input required value={hookForm.url} onChange={(e) => setHookForm({ ...hookForm, url: e.target.value })} placeholder="https://example.com/omoshine" /></label>
            <label>Description<input value={hookForm.description} onChange={(e) => setHookForm({ ...hookForm, description: e.target.value })} /></label>
          </div>
          <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
            <legend style={{ fontWeight: 600 }}>Events</legend>
            <div className="row">
              {events.data?.events.map((ev) => (
                <label key={ev} className="row" style={{ display: 'flex', fontWeight: 400, fontSize: 13 }}>
                  <input type="checkbox" style={{ minHeight: 0, width: 'auto' }} checked={hookForm.events.includes(ev)}
                    onChange={(e) => setHookForm({ ...hookForm, events: e.target.checked ? [...hookForm.events, ev] : hookForm.events.filter((x) => x !== ev) })} />
                  {ev}
                </label>
              ))}
            </div>
          </fieldset>
          <button className="primary" type="submit" disabled={!hookForm.events.length}>Add webhook</button>
        </form>
        <p className="muted" style={{ fontSize: 13 }}>Each delivery carries an <code>x-omoshine-signature</code> header: <code>t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256 of "t.body"&gt;</code> using the signing secret. Failed deliveries retry with back-off for about a day.</p>
        <Loading error={hooks.error}>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Endpoint</th><th>Events</th><th>State</th><th>Last delivered</th><th /></tr></thead>
              <tbody>
                {hooks.data?.map((h) => (
                  <WebhookRow key={h.id} hook={h}
                    onToggle={() => run(async () => { await api(`/webhooks/${h.id}`, { method: 'PATCH', body: { active: !h.active } }); hooks.reload(); })}
                    onPing={() => run(async () => { await api(`/webhooks/${h.id}/ping`, { body: {} }); setDeliveriesOf(h.id); deliveries.reload(); })}
                    onShowDeliveries={() => setDeliveriesOf(h.id)} />
                ))}
              </tbody>
            </table>
          </div>
        </Loading>
        {deliveriesOf && (
          <Loading error={deliveries.error}>
            <h3 style={{ fontSize: 14 }}>Recent deliveries</h3>
            <table>
              <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>Queued</th></tr></thead>
              <tbody>
                {deliveries.data?.map((d) => (
                  <tr key={d.id}>
                    <td>{d.event}</td>
                    <td><span className={`chip ${d.status === 'delivered' ? 'chip-pass' : d.status === 'failed' ? 'chip-fail' : 'chip-open'}`}>{d.status}</span></td>
                    <td>{d.attempts}</td><td>{d.last_status_code ?? d.last_error ?? '—'}</td><td>{fmtDate(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Loading>
        )}
      </div>
      <SsoCard />
    </>
  );
}

interface SsoConnection { id: string; name: string; issuer: string; client_id: string; email_domains: string[]; auto_provision: boolean; allow_pin_signing: boolean; active: boolean; hasClientSecret: boolean }

/** Tenant administrators connect the hospital's identity provider (OpenID Connect). */
export function SsoCard() {
  const list = useApi<SsoConnection[]>('/sso-connections');
  const [form, setForm] = useState({ name: '', issuer: '', clientId: '', clientSecret: '', domains: '', autoProvision: false, allowPinSigning: true });
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); list.reload(); } catch (x) { setErr((x as Error).message); } };
  const patch = (c: SsoConnection, body: Record<string, unknown>) => run(() => api(`/sso-connections/${c.id}`, { method: 'PATCH', body }));
  return (
    <div className="card">
      <h2>Single sign-on (OpenID Connect)</h2>
      <p className="muted">People at these email domains sign in through your identity provider (for example Microsoft Entra ID, Okta or Ping). Register OMOSHINE there as a web application with the redirect URI <code>{location.origin}/sso/callback</code>. E-signatures can require a fresh sign-in at the identity provider instead of the signing PIN.</p>
      {err && <p className="error" role="alert">{err}</p>}
      <Loading error={list.error}>
        {list.data && list.data.length > 0 && (
          <table aria-label="SSO connections">
            <thead><tr><th>Connection</th><th>Domains</th><th>New people</th><th>E-signatures</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><div className="muted" style={{ fontSize: 12 }}>{c.issuer} · {c.client_id}{c.hasClientSecret ? ' · secret stored' : ''}</div></td>
                  <td>{c.email_domains.join(', ')}</td>
                  <td><label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto' }} checked={c.auto_provision} onChange={(e) => patch(c, { autoProvision: e.target.checked })} /> Create on first sign-in</label></td>
                  <td><label className="row" style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto' }} checked={!c.allow_pin_signing} onChange={(e) => patch(c, { allowPinSigning: !e.target.checked })} /> Require SSO to sign</label></td>
                  <td><button onClick={() => patch(c, { active: !c.active })}>{c.active ? 'Turn off' : 'Turn on'}</button> <span className={`chip ${c.active ? 'chip-pass' : 'chip-closed'}`}>{c.active ? 'Active' : 'Off'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loading>
      <form className="form-grid" style={{ marginTop: 12 }} aria-label="Add SSO connection" onSubmit={(e) => { e.preventDefault(); run(async () => {
        await api('/sso-connections', { body: {
          name: form.name, issuer: form.issuer, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
          emailDomains: form.domains.split(/[\s,]+/).filter(Boolean), autoProvision: form.autoProvision, allowPinSigning: form.allowPinSigning,
        } });
        setForm({ name: '', issuer: '', clientId: '', clientSecret: '', domains: '', autoProvision: false, allowPinSigning: true });
      }); }}>
        <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Riverside Entra ID" /></label>
        <label>Issuer URL<input required type="url" value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="https://login.example.com/tenant/v2.0" /></label>
        <label>Client ID<input required value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} /></label>
        <label>Client secret (if required)<input type="password" autoComplete="off" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} /></label>
        <label>Email domains<input required value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} placeholder="hospital.org, health.org" /></label>
        <div style={{ alignSelf: 'end' }}><button className="primary" type="submit">Add connection</button></div>
      </form>
    </div>
  );
}
