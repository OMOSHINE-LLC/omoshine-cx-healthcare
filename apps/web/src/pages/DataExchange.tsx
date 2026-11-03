import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, getToken } from '../api';
import { LifeSafetyFlag, Loading, fmtDate, useApi } from '../components';

interface PointSummary { point: string; label: string; samples: number; min: number; max: number; median: number; pctOfTimeCompliant: number | null; excursions: { from: string; to: string; minutes: number; worst: number }[]; longestExcursionMin: number; dataGaps: unknown[] }
export interface TrendRoom { roomId: string; roomNumber: string; roomName: string; overallAtMedian: string | null; worstPctCompliant: number | null; points: PointSummary[] }
interface Connection { id: string; provider: 'procore' | 'acc'; base_url: string; external_project_id: string; active: boolean; last_sync_at: string | null; last_sync_result: { created: number; updated: number; unchanged: number; failed: number } | null; linked_issues: string }

const PROVIDERS = {
  procore: { label: 'Procore (Observations)', base: 'https://api.procore.com', settings: [['companyId', 'Company ID'], ['observationTypeId', 'Observation type ID']] },
  acc: { label: 'Autodesk Construction Cloud (Issues)', base: 'https://developer.api.autodesk.com', settings: [['issueSubtypeId', 'Issue subtype ID']] },
} as const;

/** Trend results, worst room first. Excursions on pressure are life safety for isolation and protective rooms. */
export function TrendTable({ rooms }: { rooms: TrendRoom[] }) {
  return (
    <table aria-label="Trend results">
      <thead><tr><th>Room</th><th>Point</th><th>Samples</th><th>Median</th><th>Range</th><th>Time compliant</th><th>Excursions</th></tr></thead>
      <tbody>
        {rooms.flatMap((r) => r.points.map((pt, i) => (
          <tr key={`${r.roomId}-${pt.point}`}>
            {i === 0 && <td rowSpan={r.points.length}><strong>{r.roomNumber}</strong> {r.roomName}</td>}
            <td>{pt.label}</td>
            <td>{pt.samples}</td>
            <td>{pt.median}</td>
            <td>{pt.min} to {pt.max}</td>
            <td>{pt.pctOfTimeCompliant === null ? <span className="muted">No requirement</span>
              : <span className={`chip ${pt.pctOfTimeCompliant === 100 ? 'chip-pass' : 'chip-fail'}`}>{pt.pctOfTimeCompliant}%</span>}</td>
            <td>{pt.excursions.length === 0 ? '—' : (
              <>{pt.point === 'pressure_in_wc' && <><LifeSafetyFlag /> </>}{pt.excursions.length}, longest {pt.longestExcursionMin} min</>
            )}</td>
          </tr>
        )))}
      </tbody>
    </table>
  );
}

async function download(path: string, filename: string) {
  const res = await fetch(`/api/v1${path}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataExchangePage() {
  const { projectId } = useParams();
  const cobie = useApi<{ sheets: { sheet: string; rows: number }[] }>(`/projects/${projectId}/exports/cobie`);
  const conns = useApi<Connection[]>(`/projects/${projectId}/connections`);
  const [trend, setTrend] = useState<{ rooms: TrendRoom[]; windowStart: string; windowEnd: string; rowsRead: number } | null>(null);
  const [trendErrors, setTrendErrors] = useState<{ row: number; error: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ provider: 'procore' as 'procore' | 'acc', baseUrl: PROVIDERS.procore.base as string, externalProjectId: '', accessToken: '', settings: {} as Record<string, string> });
  const run = async (fn: () => Promise<unknown>) => { setErr(null); setMsg(null); setBusy(true); try { await fn(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };

  return (
    <>
      <h1>Data exchange</h1>
      {err && <p className="error" role="alert">{err}</p>}
      {msg && <p className="card" role="status">{msg}</p>}

      <div className="card">
        <h2>BAS trend import</h2>
        <p className="muted">CSV with columns <code>timestamp, room_number, point, value</code>. Points: pressure_in_wc, temp_f, rh_pct, supply_cfm, exhaust_cfm, oa_cfm. Each reading is checked against the room's requirements; the median is recorded as a BAS measurement.</p>
        <input type="file" accept=".csv,text/csv" aria-label="BAS trend CSV" disabled={busy} style={{ width: 'auto' }} onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          run(async () => {
            setTrend(null); setTrendErrors([]);
            const csv = await f.text();
            const res = await fetch(`/api/v1/projects/${projectId}/imports/bas-trend`, {
              method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ csv }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.status === 422) setTrendErrors(body.errors ?? []);
            else if (!res.ok) throw new Error(body.title ?? `Import failed (${res.status})`);
            else setTrend(body);
          });
        }} />
        {trendErrors.length > 0 && <div role="alert"><p className="error">The file was not imported. Fix these rows:</p><ul>{trendErrors.slice(0, 20).map((e) => <li key={e.row}>Row {e.row}: {e.error}</li>)}</ul></div>}
        {trend && (
          <>
            <p>{trend.rowsRead} readings from {fmtDate(trend.windowStart)} to {fmtDate(trend.windowEnd)}, {trend.rooms.length} rooms.</p>
            <div style={{ overflowX: 'auto' }}><TrendTable rooms={trend.rooms} /></div>
          </>
        )}
      </div>

      <div className="card">
        <h2>COBie export (for the CMMS)</h2>
        <Loading error={cobie.error}>
          <div className="row">
            {cobie.data?.sheets.map((s) => (
              <button key={s.sheet} onClick={() => run(() => download(`/projects/${projectId}/exports/cobie/${s.sheet}.csv`, `COBie-${s.sheet}.csv`))}>{s.sheet} ({s.rows})</button>
            ))}
          </div>
        </Loading>
      </div>

      <div className="card">
        <h2>Procore and Autodesk Construction Cloud</h2>
        <p className="muted">Pushes open commissioning issues to the construction platform so the GC can work them there. OMOSHINE stays the record: changes made on the other platform are not copied back. Tokens are encrypted and never shown again.</p>
        <Loading error={conns.error}>
          <table>
            <thead><tr><th>Platform</th><th>Project</th><th>Linked issues</th><th>Last sync</th><th /></tr></thead>
            <tbody>
              {conns.data?.map((c) => (
                <tr key={c.id}>
                  <td>{PROVIDERS[c.provider].label}{!c.active && <span className="muted"> (paused)</span>}</td>
                  <td>{c.external_project_id}</td>
                  <td>{c.linked_issues}</td>
                  <td>{fmtDate(c.last_sync_at)}{c.last_sync_result && <div className="muted" style={{ fontSize: 12 }}>{c.last_sync_result.created} created, {c.last_sync_result.updated} updated{c.last_sync_result.failed ? `, ${c.last_sync_result.failed} failed` : ''}</div>}</td>
                  <td><button disabled={busy || !c.active} onClick={() => run(async () => {
                    const r = await api<{ created: number; updated: number; failed: number }>(`/connections/${c.id}/sync-issues`, { body: {} });
                    setMsg(`Sync finished: ${r.created} created, ${r.updated} updated, ${r.failed} failed.`);
                    conns.reload();
                  })}>Sync issues now</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Loading>
        <form className="form-grid" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); run(async () => {
          await api(`/projects/${projectId}/connections`, { body: { ...form, settings: Object.fromEntries(Object.entries(form.settings).filter(([, v]) => v)) } });
          setForm({ ...form, accessToken: '' });
          conns.reload();
        }); }}>
          <label>Platform<select value={form.provider} onChange={(e) => { const p = e.target.value as 'procore' | 'acc'; setForm({ ...form, provider: p, baseUrl: PROVIDERS[p].base, settings: {} }); }}>
            <option value="procore">{PROVIDERS.procore.label}</option><option value="acc">{PROVIDERS.acc.label}</option>
          </select></label>
          <label>API base URL<input required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
          <label>Platform project ID<input required value={form.externalProjectId} onChange={(e) => setForm({ ...form, externalProjectId: e.target.value })} /></label>
          {PROVIDERS[form.provider].settings.map(([k, label]) => (
            <label key={k}>{label}<input value={form.settings[k] ?? ''} onChange={(e) => setForm({ ...form, settings: { ...form.settings, [k]: e.target.value } })} /></label>
          ))}
          <label>Access token<input required type="password" autoComplete="off" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} /></label>
          <div style={{ alignSelf: 'end' }}><button className="primary" type="submit" disabled={busy}>Connect</button></div>
        </form>
      </div>
    </>
  );
}
