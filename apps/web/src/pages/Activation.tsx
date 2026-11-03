import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, openReport } from '../api';
import { LifeSafetyFlag, Loading, fmtDate, useApi } from '../components';

type PhaseStatus = 'planned' | 'active' | 'ready' | 'occupied';
export interface Gate { key: string; label: string; status: 'pass' | 'fail' | 'not_applicable'; detail: string }
export interface ActivationItem {
  id: string; key: string; label: string; category: string; required: boolean; source: 'template' | 'custom';
  status: 'open' | 'done' | 'na'; evidence: string | null; completed_by_name: string | null; completed_at: string | null;
}
interface PhaseSummary { id: string; name: string; sequence: number; targetOccupancyDate: string | null; status: PhaseStatus; ready: boolean; readinessLapsed: boolean; gates: Gate[]; checklist: { required: number; resolved: number }; occupiedOn: string | null }
interface PhaseDetail {
  phase: { id: string; name: string; status: PhaseStatus; target_occupancy_date: string | null };
  gates: Gate[]; ready: boolean; readinessLapsed: boolean; items: ActivationItem[];
  signoffs: { id: string; kind: 'ready' | 'occupied'; occupied_on: string | null; signed_at: string; signed_by_name: string; signer_role: string }[];
  openLifeSafetyIssues: { number: number; title: string }[];
}

export const CATEGORY_LABEL: Record<string, string> = {
  regulatory: 'Regulatory', life_safety: 'Life safety', infection_control: 'Infection control', facilities: 'Facilities', clinical: 'Clinical', it: 'IT and communications',
};
const STATUS_LABEL: Record<PhaseStatus, string> = { planned: 'Planned', active: 'Active', ready: 'Signed ready', occupied: 'Occupied' };
const STATUS_CHIP: Record<PhaseStatus, string> = { planned: 'chip-closed', active: 'chip-open', ready: 'chip-pass', occupied: 'chip-pass' };

/** Life safety gates carry the red flag when they fail. */
const LS_GATES = new Set(['life_safety_items', 'life_safety_issues', 'medgas', 'rooms']);

export function GateList({ gates }: { gates: Gate[] }) {
  return (
    <table aria-label="Evidence gates">
      <thead><tr><th>Gate</th><th>Detail</th><th>Status</th></tr></thead>
      <tbody>
        {gates.map((g) => (
          <tr key={g.key}>
            <td>{g.label}</td>
            <td>{g.detail}</td>
            <td>{g.status === 'pass' ? <span className="chip chip-pass">Pass</span>
              : g.status === 'not_applicable' ? <span className="chip chip-closed">Not applicable</span>
              : <span className="row">{LS_GATES.has(g.key) && <LifeSafetyFlag />}<span className="chip chip-fail">Not met</span></span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One checklist item: mark done with evidence, not applicable with a reason, or reopen. */
export function ChecklistItem({ item, locked, onChange }: { item: ActivationItem; locked: boolean; onChange: (status: 'open' | 'done' | 'na', evidence?: string) => Promise<void> }) {
  const [mode, setMode] = useState<'done' | 'na' | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className="card" style={{ padding: 12, marginBottom: 8 }} aria-label={item.label}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div>{item.label}{!item.required && <span className="muted"> (optional)</span>}</div>
          <div className="muted" style={{ fontSize: 13 }}>{CATEGORY_LABEL[item.category] ?? item.category}{item.source === 'custom' ? ' · added for this project' : ''}</div>
          {item.status !== 'open' && (
            <div style={{ fontSize: 13, marginTop: 4 }}>{item.status === 'na' ? 'Not applicable: ' : 'Evidence: '}{item.evidence}
              <span className="muted"> · {item.completed_by_name}, {fmtDate(item.completed_at)}</span></div>
          )}
        </div>
        <div className="row">
          {item.status === 'done' && <span className="chip chip-pass">Done</span>}
          {item.status === 'na' && <span className="chip chip-closed">Not applicable</span>}
          {item.status === 'open' && <span className="chip chip-open">Open</span>}
          {!locked && item.status === 'open' && mode === null && (
            <>
              <button onClick={() => { setMode('done'); setText(''); }}>Mark done</button>
              <button onClick={() => { setMode('na'); setText(''); }}>Not applicable</button>
            </>
          )}
          {!locked && item.status !== 'open' && <button onClick={() => onChange('open').catch((x) => setErr((x as Error).message))}>Reopen</button>}
        </div>
      </div>
      {mode && (
        <form className="row" style={{ marginTop: 8 }} onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try { await onChange(mode, text.trim()); setMode(null); } catch (x) { setErr((x as Error).message); }
        }}>
          <input aria-label={mode === 'done' ? 'Evidence' : 'Reason not applicable'} required minLength={3} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={mode === 'done' ? 'Document, date and who approved' : 'Why this does not apply'} style={{ flex: 1, minWidth: 220, width: 'auto' }} />
          <button className="primary" type="submit">Save</button>
          <button type="button" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </li>
  );
}

function PinDialog({ title, text, onSign, onClose, withDate }: { title: string; text: string; withDate?: boolean; onSign: (pin: string, date?: string) => Promise<void>; onClose: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [pin, setPin] = useState('');
  const [date, setDate] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="pin-title">
      <form className="dialog" onSubmit={async (e) => { e.preventDefault(); try { await onSign(pin, withDate ? date : undefined); } catch (x) { setErr((x as Error).message); } }}>
        <h2 id="pin-title">{title}</h2>
        <p className="muted">{text}</p>
        {withDate && <label>Occupied on<input type="date" required max={today} value={date} onChange={(e) => setDate(e.target.value)} /></label>}
        <label style={{ marginTop: 8 }}>Re-enter your signing PIN<input type="password" autoComplete="off" required minLength={4} value={pin} onChange={(e) => setPin(e.target.value)} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" type="submit">Sign</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function PhaseView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const d = useApi<PhaseDetail>(`/phases/${id}/activation`);
  const [signing, setSigning] = useState<'ready' | 'occupied' | null>(null);
  const [custom, setCustom] = useState({ label: '', category: 'clinical' });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => { d.reload(); onChanged(); };
  const p = d.data;
  const locked = p?.phase.status === 'occupied';
  const open = p ? p.items.filter((i) => i.status === 'open') : [];
  return (
    <Loading error={d.error}>
      {p && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{p.phase.name}</h2>
              <span className={`chip ${STATUS_CHIP[p.phase.status]}`}>{STATUS_LABEL[p.phase.status]}</span>
            </div>
            {p.readinessLapsed && <p className="row" role="alert"><LifeSafetyFlag /> Signed ready, but the evidence no longer passes every gate. Resolve the gates below before occupancy.</p>}
            {msg && <p role="status">{msg}</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <div style={{ overflowX: 'auto' }}><GateList gates={p.gates} /></div>
            {p.openLifeSafetyIssues.length > 0 && (
              <p className="muted" style={{ fontSize: 13 }}>Open life safety issues: {p.openLifeSafetyIssues.map((i) => `#${i.number} ${i.title}`).join('; ')}</p>
            )}
            {p.signoffs.length > 0 && (
              <ul style={{ paddingLeft: 18 }}>
                {p.signoffs.map((s) => <li key={s.id}>{s.kind === 'ready' ? 'Signed ready to occupy' : `Occupied on ${s.occupied_on}`} by {s.signed_by_name} ({s.signer_role === 'cxa' ? 'CxA' : 'Owner'}), {fmtDate(s.signed_at)}</li>)}
              </ul>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              {(p.phase.status === 'planned' || p.phase.status === 'active') && (
                <button className="primary" disabled={!p.ready} onClick={() => setSigning('ready')}>Sign ready to occupy</button>
              )}
              {p.phase.status === 'ready' && <button className="primary" disabled={!p.ready} onClick={() => setSigning('occupied')}>Record occupancy (owner)</button>}
              <button onClick={() => openReport(`/phases/${id}/activation/report`).catch((x) => setErr((x as Error).message))}>Export activation report</button>
            </div>
            {!p.ready && !locked && <p className="muted" style={{ fontSize: 13 }}>Signing unlocks when every gate passes or does not apply.</p>}
          </div>

          <div className="card">
            <h2>Activation checklist <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>({open.length} open)</span></h2>
            {p.items.length === 0 && !locked && (
              <button onClick={async () => { try { await api(`/phases/${id}/activation/init`, { body: {} }); refresh(); } catch (x) { setErr((x as Error).message); } }}>Add the default checklist</button>
            )}
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {p.items.map((i) => (
                <ChecklistItem key={i.id} item={i} locked={!!locked} onChange={async (status, evidence) => {
                  await api(`/activation-items/${i.id}`, { method: 'PATCH', body: { status, ...(evidence ? { evidence } : {}) } });
                  refresh();
                }} />
              ))}
            </ul>
            {!locked && (
              <form className="row" aria-label="Add checklist item" onSubmit={async (e) => {
                e.preventDefault();
                setErr(null);
                try { await api(`/phases/${id}/activation-items`, { body: { label: custom.label, category: custom.category } }); setCustom({ ...custom, label: '' }); refresh(); } catch (x) { setErr((x as Error).message); }
              }}>
                <input aria-label="New checklist item" required minLength={3} placeholder="Add an item for this phase" value={custom.label} onChange={(e) => setCustom({ ...custom, label: e.target.value })} style={{ flex: 1, minWidth: 220, width: 'auto' }} />
                <select aria-label="Category" value={custom.category} onChange={(e) => setCustom({ ...custom, category: e.target.value })} style={{ width: 'auto' }}>
                  {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <button type="submit">Add item</button>
              </form>
            )}
          </div>

          {signing && (
            <PinDialog
              title={signing === 'ready' ? 'Sign this phase ready to occupy' : 'Record occupancy'}
              text={signing === 'ready'
                ? 'Your signature records that every evidence gate passed and the activation checklist is complete as it stands now.'
                : 'Recording occupancy closes the phase. Its checklist and sign-offs can no longer change.'}
              withDate={signing === 'occupied'}
              onClose={() => setSigning(null)}
              onSign={async (pin, date) => {
                const { reauthToken } = await api<{ reauthToken: string }>('/auth/reauth', { body: { pin } });
                await api(`/phases/${id}/signoff`, { body: { kind: signing, ...(date ? { occupiedOn: date } : {}) }, headers: { 'x-reauth-token': reauthToken } });
                setMsg(signing === 'ready' ? 'Phase signed ready to occupy.' : 'Occupancy recorded. The phase is now closed.');
                setSigning(null);
                refresh();
              }}
            />
          )}
        </>
      )}
    </Loading>
  );
}

export function PhaseCard({ phase, selected, onOpen }: { phase: PhaseSummary; selected: boolean; onOpen: () => void }) {
  const failing = phase.gates.filter((g) => g.status === 'fail').length;
  return (
    <div className="card" style={{ flex: 1, minWidth: 240, outline: selected ? '2px solid var(--gold, #B1844F)' : undefined }} aria-label={`Phase ${phase.name}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>{phase.name}</h2>
        <span className={`chip ${STATUS_CHIP[phase.status]}`}>{STATUS_LABEL[phase.status]}</span>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        {phase.occupiedOn ? `Occupied ${phase.occupiedOn}` : phase.targetOccupancyDate ? `Target occupancy ${phase.targetOccupancyDate}` : 'No target date'}
      </p>
      <p style={{ margin: '4px 0' }}>
        {phase.ready ? 'All gates pass' : `${failing} gate${failing === 1 ? '' : 's'} not met`} · checklist {phase.checklist.resolved}/{phase.checklist.required}
      </p>
      {phase.readinessLapsed && <p className="row"><LifeSafetyFlag /> Readiness lapsed</p>}
      <button onClick={onOpen}>Open phase</button>
    </div>
  );
}

export function ActivationPage() {
  const { projectId } = useParams();
  const list = useApi<PhaseSummary[]>(`/projects/${projectId}/activation`);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected ?? list.data?.find((p) => p.status !== 'occupied')?.id ?? list.data?.[0]?.id ?? null;
  return (
    <>
      <h1>Phased occupancy and activation</h1>
      <p className="muted">Each phase opens when its rooms, tests, medical gas, life safety inspections and issues all pass, and its activation checklist is complete. The CxA or owner signs it ready; the owner records occupancy.</p>
      <Loading error={list.error}>
        {list.data?.length === 0 && <p>No phases yet. Add phases in the project setup.</p>}
        <div className="row" style={{ alignItems: 'stretch' }}>
          {list.data?.map((ph) => <PhaseCard key={ph.id} phase={ph} selected={ph.id === current} onOpen={() => setSelected(ph.id)} />)}
        </div>
        {current && <PhaseView key={current} id={current} onChanged={list.reload} />}
      </Loading>
    </>
  );
}
