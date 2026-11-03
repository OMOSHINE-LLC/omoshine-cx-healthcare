import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { OFFLINE_SAVED, api, isQueued, openReport, type QueuedOffline } from '../api';
import { LifeSafetyFlag, Loading, useApi } from '../components';

type Group = 'damper' | 'door' | 'fire_alarm';
export type DueStatus = 'current' | 'due_soon' | 'overdue' | 'never_inspected' | 'failed';
interface KindDef { label: string; group: Group; standard: string; items: { key: string; label: string }[] }
export interface LsCatalog { kinds: Record<string, KindDef> }
export interface LsItem {
  id: string; kind: string; tag: string; label: string; group: Group; room_number: string | null; location: string;
  rating_minutes: number | null; last_performed_on: string | null; dueStatus: DueStatus; nextDue: string | null;
}
export interface PfiItem {
  id: string; number: number; deficiency: string; code_reference: string; location: string; planned_completion: string;
  status: 'open' | 'resolved'; resolution: string | null; pfiStatus: 'open' | 'overdue' | 'resolved';
}
type GroupSummary = Record<DueStatus | 'total', number>;

const GROUPS: { key: Group; title: string }[] = [
  { key: 'damper', title: 'Fire and smoke dampers' },
  { key: 'door', title: 'Fire and smoke doors' },
  { key: 'fire_alarm', title: 'Fire alarm devices' },
];
const DUE_LABEL: Record<string, string> = { current: 'Current', due_soon: 'Due soon', overdue: 'Overdue', never_inspected: 'Never inspected', failed: 'Failed', open: 'Open', resolved: 'Resolved' };
const DUE_CHIP: Record<string, string> = { current: 'chip-pass', resolved: 'chip-pass', failed: 'chip-fail', overdue: 'chip-fail', due_soon: 'chip-open', open: 'chip-open', never_inspected: 'chip-closed' };
const ORDER: Record<DueStatus, number> = { failed: 0, overdue: 1, due_soon: 2, never_inspected: 3, current: 4 };

/** Due status as a text chip; failed and overdue items also carry the life safety flag. */
export function DueChip({ status }: { status: string }) {
  const chip = <span className={`chip ${DUE_CHIP[status] ?? 'chip-closed'}`}>{DUE_LABEL[status] ?? status}</span>;
  return status === 'failed' || status === 'overdue' ? <span className="row"><LifeSafetyFlag />{chip}</span> : chip;
}

export function LsSummaryCards({ summary }: { summary: Record<string, GroupSummary> }) {
  return (
    <div className="row" style={{ alignItems: 'stretch' }}>
      {GROUPS.map((g) => {
        const s = summary[g.key];
        return (
          <div key={g.key} className="card" style={{ flex: 1, minWidth: 200 }} aria-label={`${g.title} summary`}>
            <h2 style={{ marginTop: 0 }}>{g.title}</h2>
            {!s ? <p className="muted">None recorded</p> : (
              <div style={{ display: 'grid', gap: 6 }}>
                <div><strong>{s.total}</strong> items · {s.current} current</div>
                {s.failed + s.overdue > 0 && <div className="row"><LifeSafetyFlag /> {s.failed} failed, {s.overdue} overdue</div>}
                {s.due_soon > 0 && <div>{s.due_soon} due within 30 days</div>}
                {s.never_inspected > 0 && <div className="muted">{s.never_inspected} never inspected</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function LsItemTable({ items, canInspect, onInspect }: { items: LsItem[]; canInspect: boolean; onInspect: (i: LsItem) => void }) {
  const sorted = [...items].sort((a, b) => ORDER[a.dueStatus] - ORDER[b.dueStatus] || a.tag.localeCompare(b.tag));
  return (
    <table aria-label="Life safety items">
      <thead><tr><th>Tag</th><th>Type</th><th>Location</th><th>Rating</th><th>Last inspected</th><th>Next due</th><th>Status</th>{canInspect && <th />}</tr></thead>
      <tbody>
        {sorted.map((i) => (
          <tr key={i.id}>
            <td style={{ whiteSpace: 'nowrap' }}><strong>{i.tag}</strong></td>
            <td>{i.label}</td>
            <td>{[i.room_number, i.location].filter(Boolean).join(' · ') || '—'}</td>
            <td>{i.rating_minutes ? `${i.rating_minutes} min` : '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{i.last_performed_on ?? '—'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{i.nextDue ?? '—'}</td>
            <td><DueChip status={i.dueStatus} /></td>
            {canInspect && <td><button onClick={() => onInspect(i)}>Inspect</button></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Answer = boolean | 'na';

/** Inspection checklist to fill in: Yes, No or N/A on every item. */
export function InspectionForm({ item, def, onSubmit, onCancel }: {
  item: LsItem; def: KindDef;
  onSubmit: (body: { answers: Record<string, Answer>; performedOn: string; inspectorCredential?: string; notes?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [performedOn, setPerformedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [cred, setCred] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const complete = def.items.every((it) => answers[it.key] !== undefined);
  const anyNo = def.items.some((it) => answers[it.key] === false);
  const opt = (key: string, value: Answer, text: string) => (
    <button type="button" style={{ minWidth: 64, minHeight: 48 }} aria-pressed={answers[key] === value} onClick={() => setAnswers({ ...answers, [key]: value })}>{text}</button>
  );
  return (
    <form className="card" aria-label={`Inspect ${item.tag}`} onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      try {
        await onSubmit({ answers, performedOn, ...(cred.trim() ? { inspectorCredential: cred.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) });
      } catch (x) { setErr((x as Error).message); }
    }}>
      <h2 style={{ marginTop: 0 }}>{def.label} {item.tag}</h2>
      <p className="muted">{def.standard} · {[item.room_number, item.location].filter(Boolean).join(' · ')}. Every item must be Yes or N/A to pass.</p>
      <ol style={{ paddingLeft: 20 }}>
        {def.items.map((it) => (
          <li key={it.key} style={{ marginBottom: 10 }}>
            <div style={{ marginBottom: 4 }}>{it.label}</div>
            <div className="row" role="group" aria-label={it.label}>
              {opt(it.key, true, 'Yes')}{opt(it.key, false, 'No')}{opt(it.key, 'na', 'N/A')}
            </div>
          </li>
        ))}
      </ol>
      <div className="form-grid">
        <label>Date inspected<input type="date" required value={performedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setPerformedOn(e.target.value)} /></label>
        <label>Inspector credential (optional)<input value={cred} onChange={(e) => setCred(e.target.value)} placeholder="e.g. fire door inspector certification" /></label>
      </div>
      <label style={{ marginTop: 12 }}>Notes<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {anyNo && <p className="row" role="note"><LifeSafetyFlag /> Saving will record a failure and open a high-priority life safety issue.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={!complete}>Save inspection</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function PfiTable({ items, canManage, onResolve }: { items: PfiItem[]; canManage: boolean; onResolve: (p: PfiItem, resolution: string) => void }) {
  const [resolving, setResolving] = useState<string | null>(null);
  const [text, setText] = useState('');
  if (!items.length) return <p className="muted">No plan-for-improvement items.</p>;
  return (
    <table aria-label="Plan for improvement">
      <thead><tr><th>#</th><th>Deficiency</th><th>Code reference</th><th>Location</th><th>Planned completion</th><th>Status</th>{canManage && <th />}</tr></thead>
      <tbody>
        {items.map((p) => (
          <tr key={p.id}>
            <td>{p.number}</td>
            <td>{p.deficiency}{p.resolution && <div className="muted" style={{ fontSize: 13 }}>Resolution: {p.resolution}</div>}</td>
            <td>{p.code_reference || '—'}</td>
            <td>{p.location}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{p.planned_completion}</td>
            <td><DueChip status={p.pfiStatus} /></td>
            {canManage && <td>{p.status === 'open' && (resolving === p.id ? (
              <form className="row" onSubmit={(e) => { e.preventDefault(); onResolve(p, text); setResolving(null); setText(''); }}>
                <input aria-label={`How PFI ${p.number} was corrected`} required minLength={3} value={text} onChange={(e) => setText(e.target.value)} style={{ width: 'auto', minWidth: 180 }} />
                <button className="primary" type="submit">Resolve</button>
              </form>
            ) : <button onClick={() => { setResolving(p.id); setText(''); }}>Resolve</button>)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LifeSafetyPage() {
  const { projectId } = useParams();
  const catalog = useApi<LsCatalog>('/life-safety/catalog');
  const [group, setGroup] = useState<Group | ''>('');
  const list = useApi<{ summary: Record<string, GroupSummary>; items: LsItem[] }>(`/projects/${projectId}/ls-items`);
  const pfi = useApi<PfiItem[]>(`/projects/${projectId}/pfi`);
  const [inspecting, setInspecting] = useState<LsItem | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [add, setAdd] = useState({ kind: 'fire_damper', tag: '', location: '', ratingMinutes: '', installedOn: '' });
  const [newPfi, setNewPfi] = useState({ deficiency: '', codeReference: '', location: '', plannedCompletion: '' });
  const run = async (fn: () => Promise<unknown>) => { setErr(null); setMsg(null); try { await fn(); } catch (x) { setErr((x as Error).message); } };
  const kinds = catalog.data?.kinds ?? {};
  const items = (list.data?.items ?? []).filter((i) => !group || i.group === group);

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Life safety</h1>
        <button onClick={() => run(() => openReport(`/projects/${projectId}/life-safety/report`))}>Export life safety report</button>
      </div>
      <p className="muted">Fire and smoke dampers, fire and smoke doors and fire alarm devices, with inspection due dates from the hospital's life safety policy, and the Statement of Conditions plan for improvement.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {msg && <p className="card" role="status">{msg}</p>}

      <Loading error={list.error ?? catalog.error}>
        {list.data && <LsSummaryCards summary={list.data.summary} />}
        {inspecting && kinds[inspecting.kind] && (
          <InspectionForm item={inspecting} def={kinds[inspecting.kind]!} onCancel={() => setInspecting(null)} onSubmit={async (body) => {
            const r = await api<{ evaluation: { overall: string }; issueId: string | null } | QueuedOffline>(`/ls-items/${inspecting.id}/inspections`, { body });
            if (isQueued(r)) setMsg(`${inspecting.tag}: ${OFFLINE_SAVED}`);
            else setMsg(r.evaluation.overall === 'fail'
              ? `${inspecting.tag} FAILED. A high-priority life safety issue was opened.`
              : `${inspecting.tag}: inspection ${r.evaluation.overall === 'pass' ? 'passed' : 'saved as incomplete'}.`);
            setInspecting(null);
            list.reload();
          }} />
        )}
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>Inventory</h2>
            <select aria-label="Show group" value={group} onChange={(e) => setGroup(e.target.value as Group | '')} style={{ width: 'auto' }}>
              <option value="">All groups</option>
              {GROUPS.map((g) => <option key={g.key} value={g.key}>{g.title}</option>)}
            </select>
          </div>
          {items.length ? <div style={{ overflowX: 'auto' }}><LsItemTable items={items} canInspect onInspect={(i) => { setInspecting(i); window.scrollTo({ top: 0 }); }} /></div>
            : <p className="muted">No items yet. Add dampers, doors and devices below.</p>}
          <form className="form-grid" style={{ marginTop: 12 }} aria-label="Add life safety item" onSubmit={(e) => { e.preventDefault(); run(async () => {
            const r = await api<{ created: number; skipped: number }>(`/projects/${projectId}/ls-items`, { body: { items: [{
              kind: add.kind, tag: add.tag, location: add.location,
              ...(add.ratingMinutes ? { ratingMinutes: Number(add.ratingMinutes) } : {}), ...(add.installedOn ? { installedOn: add.installedOn } : {}),
            }] } });
            setMsg(r.created ? `Added ${add.tag}.` : `${add.tag} already exists.`);
            setAdd({ ...add, tag: '', location: '' });
            list.reload();
          }); }}>
            <label>Type<select value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}>
              {GROUPS.map((g) => (
                <optgroup key={g.key} label={g.title}>
                  {Object.entries(kinds).filter(([, d]) => d.group === g.key).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
                </optgroup>
              ))}
            </select></label>
            <label>Tag<input required value={add.tag} onChange={(e) => setAdd({ ...add, tag: e.target.value })} placeholder="e.g. FD-2-014" /></label>
            <label>Location<input value={add.location} onChange={(e) => setAdd({ ...add, location: e.target.value })} /></label>
            <label>Rating<select value={add.ratingMinutes} onChange={(e) => setAdd({ ...add, ratingMinutes: e.target.value })}>
              <option value="">—</option>{[20, 45, 60, 90, 180].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select></label>
            <label>Installed on<input type="date" value={add.installedOn} onChange={(e) => setAdd({ ...add, installedOn: e.target.value })} /></label>
            <div style={{ alignSelf: 'end' }}><button className="primary" type="submit">Add item</button></div>
          </form>
        </div>
      </Loading>

      <div className="card">
        <h2>Statement of Conditions: plan for improvement</h2>
        <Loading error={pfi.error}>
          {pfi.data && <PfiTable items={pfi.data} canManage onResolve={(p, resolution) => run(async () => {
            await api(`/pfi/${p.id}`, { method: 'PATCH', body: { status: 'resolved', resolution } });
            pfi.reload();
          })} />}
        </Loading>
        <form className="form-grid" style={{ marginTop: 12 }} aria-label="Add plan-for-improvement item" onSubmit={(e) => { e.preventDefault(); run(async () => {
          await api(`/projects/${projectId}/pfi`, { body: newPfi });
          setNewPfi({ deficiency: '', codeReference: '', location: '', plannedCompletion: '' });
          pfi.reload();
        }); }}>
          <label>Deficiency<input required minLength={3} value={newPfi.deficiency} onChange={(e) => setNewPfi({ ...newPfi, deficiency: e.target.value })} /></label>
          <label>Code reference<input value={newPfi.codeReference} onChange={(e) => setNewPfi({ ...newPfi, codeReference: e.target.value })} placeholder="e.g. NFPA 101 8.5.6" /></label>
          <label>Location<input required value={newPfi.location} onChange={(e) => setNewPfi({ ...newPfi, location: e.target.value })} /></label>
          <label>Planned completion<input type="date" required value={newPfi.plannedCompletion} onChange={(e) => setNewPfi({ ...newPfi, plannedCompletion: e.target.value })} /></label>
          <div style={{ alignSelf: 'end' }}><button className="primary" type="submit">Add PFI item</button></div>
        </form>
      </div>
    </>
  );
}
