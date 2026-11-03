import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Loading, StatusChip, fmtDate, useApi } from '../components';
import { SignDialog } from './TestRuns';

export interface IcraZone {
  id: string; name: string; icra_class: 'I' | 'II' | 'III' | 'IV'; construction_type: string; risk_group: string; barrier_type: string | null;
  adjacent_areas: string; department_name: string | null; active: boolean;
  approval: { status: 'approved' | 'pending' | 'reapproval_required'; by: string | null; at: string | null };
  today: string; history: { date: string; status: string }[];
}
interface Control { key: string; label: string; fromClass: string }
interface ZoneDetail extends IcraZone { controls: Control[]; logs: { id: string; logged_at: string; overall: string; recorded_by_name: string; corrective_action: string | null }[] }

const APPROVAL_LABEL = { approved: 'IP approved', pending: 'Awaiting IP approval', reapproval_required: 'IP re-approval needed' };

/** One cell per day: colour plus a text title, with a legend underneath. */
export function HistoryStrip({ history }: { history: { date: string; status: string }[] }) {
  const color: Record<string, string> = { pass: 'var(--pass-fg)', fail: 'var(--fail-fg)', incomplete: 'var(--open-fg)', missing: '#d6d0c2' };
  const fails = history.filter((h) => h.status === 'fail').length;
  const missing = history.filter((h) => h.status === 'missing').length;
  return (
    <div>
      <div style={{ display: 'flex', gap: 2 }} role="img" aria-label={`Last ${history.length} days: ${fails} failed, ${missing} not logged`}>
        {history.map((h) => <span key={h.date} title={`${h.date}: ${h.status}`} style={{ width: 8, height: 20, borderRadius: 2, background: color[h.status] ?? '#d6d0c2' }} />)}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Last {history.length} days · {fails} failed · {missing} not logged</div>
    </div>
  );
}

export function ZoneCard({ zone, onOpen }: { zone: IcraZone; onOpen: () => void }) {
  return (
    <div className="card" aria-label={`ICRA zone ${zone.name}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{zone.name}</h2>
        <span className="chip chip-closed" style={{ background: 'var(--navy)', color: 'var(--ivory)' }}>Class {zone.icra_class}</span>
      </div>
      <p className="muted">{zone.department_name ?? 'No department'} · Type {zone.construction_type} · {zone.risk_group} risk{zone.barrier_type ? ` · ${zone.barrier_type}` : ''}</p>
      <div className="row">
        <span className={`chip ${zone.approval.status === 'approved' ? 'chip-pass' : 'chip-open'}`}>{APPROVAL_LABEL[zone.approval.status]}</span>
        <span>Today: <StatusChip status={zone.today === 'missing' ? 'open' : zone.today} />{zone.today === 'missing' && <span className="muted"> not logged</span>}</span>
      </div>
      <div style={{ margin: '12px 0' }}><HistoryStrip history={zone.history} /></div>
      {zone.active && <button className="primary" onClick={onOpen}>Log today's inspection</button>}
    </div>
  );
}

/** Quick-entry daily log: large yes/no toggles, one pressure reading, done in under a minute. */
export function DailyLogForm({ zone, controls, onSubmit, onCancel }: {
  zone: IcraZone; controls: Control[];
  onSubmit: (body: { controls: Record<string, boolean>; pressureDiffInWc?: number; correctiveAction?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [pressure, setPressure] = useState('');
  const [action, setAction] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const needsPressure = zone.icra_class === 'III' || zone.icra_class === 'IV';
  const anyNo = Object.values(answers).includes(false) || (pressure !== '' && Number(pressure) >= 0);
  const complete = controls.every((c) => answers[c.key] !== undefined) && (!needsPressure || pressure !== '');
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      try {
        await onSubmit({ controls: answers, ...(pressure !== '' ? { pressureDiffInWc: Number(pressure) } : {}), ...(action ? { correctiveAction: action } : {}) });
      } catch (x) { setErr((x as Error).message); }
    }}>
      <h2>Daily ICRA inspection · {zone.name} · Class {zone.icra_class}</h2>
      <table>
        <tbody>
          {controls.map((c) => (
            <tr key={c.key}>
              <td>{c.label}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <div className="row" role="group" aria-label={c.label}>
                  <button type="button" style={{ minWidth: 64, minHeight: 48 }} aria-pressed={answers[c.key] === true} onClick={() => setAnswers({ ...answers, [c.key]: true })}>Yes</button>
                  <button type="button" style={{ minWidth: 64, minHeight: 48 }} aria-pressed={answers[c.key] === false} onClick={() => setAnswers({ ...answers, [c.key]: false })}>No</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {needsPressure && (
        <label style={{ marginTop: 12, maxWidth: 320 }}>Pressure differential to adjacent occupied area (in. w.c., negative = work area negative)
          <input inputMode="decimal" required value={pressure} onChange={(e) => setPressure(e.target.value)} placeholder="-0.02" />
        </label>
      )}
      {anyNo && (
        <label style={{ marginTop: 12 }}>Corrective action taken
          <textarea rows={2} value={action} onChange={(e) => setAction(e.target.value)} />
        </label>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={!complete}>Save inspection</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function IcraPage() {
  const { projectId } = useParams();
  const zones = useApi<IcraZone[]>(`/projects/${projectId}/icra-zones`);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<ZoneDetail>(open ? `/icra-zones/${open}` : null);
  const [approving, setApproving] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <h1>Infection control (ICRA)</h1>
      {msg && <p className="card" role="status">{msg}</p>}
      {open && detail.data && (
        <DailyLogForm
          zone={detail.data}
          controls={detail.data.controls}
          onCancel={() => setOpen(null)}
          onSubmit={async (body) => {
            const r = await api<{ evaluation: { overall: string }; issueId: string | null }>(`/icra-zones/${open}/logs`, { body });
            setMsg(r.evaluation.overall === 'fail' ? 'Inspection saved as FAILED. An issue was opened for follow-up.' : `Inspection saved: ${r.evaluation.overall}.`);
            setOpen(null);
            zones.reload();
          }}
        />
      )}
      <Loading error={zones.error}>
        <div className="cards">
          {zones.data?.map((z) => (
            <div key={z.id}>
              <ZoneCard zone={z} onOpen={() => { setMsg(null); setOpen(z.id); }} />
              {z.approval.status !== 'approved' && <button onClick={() => setApproving(z.id)}>Infection Prevention sign-off</button>}
            </div>
          ))}
          {zones.data?.length === 0 && <p className="muted">No ICRA zones yet.</p>}
        </div>
      </Loading>
      {approving && (
        <SignDialog
          onClose={() => setApproving(null)}
          onSign={async (pin) => {
            const { reauthToken } = await api<{ reauthToken: string }>('/auth/reauth', { body: { pin } });
            await api(`/icra-zones/${approving}/approve`, { body: {}, headers: { 'x-reauth-token': reauthToken } });
            setApproving(null);
            zones.reload();
          }}
        />
      )}
      {detail.data?.logs && open && (
        <div className="card">
          <h2>Recent inspections</h2>
          <ul>{detail.data.logs.slice(0, 10).map((l) => <li key={l.id}>{fmtDate(l.logged_at)} · {l.recorded_by_name} <StatusChip status={l.overall} />{l.corrective_action && <span className="muted"> · {l.corrective_action}</span>}</li>)}</ul>
        </div>
      )}
    </>
  );
}
