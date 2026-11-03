import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, download, openReport } from '../api';
import { LifeSafetyFlag, Loading, Progress, useApi } from '../components';

type TaskStatus = 'current' | 'due' | 'overdue' | 'failed';
export interface ComplianceTask {
  id: string; kind: string; label: string; category: string; target_label: string | null; frequency: string;
  status: TaskStatus; nextDue: string; last_done_on: string | null; checks: { key: string; label: string }[];
}
interface Compliance { tasks: ComplianceTask[]; summary: { total: number; current: number; due: number; overdue: number; failed: number }; verified: boolean }
interface CalendarEvent { date: string; source: 'task' | 'life_safety'; id: string; label: string; target: string | null; status: string }
type Cell = { audience: string; label: string; status: 'trained' | 'scheduled' | 'needed' };
export interface TrainingRow { id: string; name: string; discipline: string; audiences: Cell[] }
interface Session { id: string; system_id: string | null; topic: string; trainer: string; scheduled_at: string; duration_min: number; status: 'scheduled' | 'held' | 'cancelled'; attendee_count: number; materials_reference: string | null }
interface Training { matrix: TrainingRow[]; sessions: Session[]; summary: { required: number; trained: number; scheduled: number } }
interface Catalog { audiences: Record<string, string> }

const TASK_STATUS: Record<string, { label: string; cls: string }> = {
  current: { label: 'Current', cls: 'chip-pass' }, due: { label: 'Due', cls: 'chip-open' }, overdue: { label: 'Overdue', cls: 'chip-fail' },
  failed: { label: 'Failed', cls: 'chip-fail' }, upcoming: { label: 'Upcoming', cls: 'chip-closed' }, due_soon: { label: 'Due soon', cls: 'chip-open' },
  never_inspected: { label: 'Never inspected', cls: 'chip-open' },
};
const CELL: Record<Cell['status'], { label: string; cls: string }> = {
  trained: { label: 'Trained', cls: 'chip-pass' }, scheduled: { label: 'Scheduled', cls: 'chip-open' }, needed: { label: 'Needed', cls: 'chip-closed' },
};
const LS_CATEGORIES = new Set(['ees', 'life_safety', 'ventilation', 'medical_gas']);
const chip = (s: string) => <span className={`chip ${(TASK_STATUS[s] ?? TASK_STATUS.upcoming!).cls}`}>{(TASK_STATUS[s] ?? { label: s }).label}</span>;

/** Recurring tasks with status, most urgent first. */
export function TaskTable({ tasks, onRecord }: { tasks: ComplianceTask[]; onRecord: (t: ComplianceTask) => void }) {
  const rank: Record<TaskStatus, number> = { failed: 0, overdue: 1, due: 2, current: 3 };
  const sorted = [...tasks].sort((a, b) => rank[a.status] - rank[b.status] || a.nextDue.localeCompare(b.nextDue));
  return (
    <table>
      <thead><tr><th>Task</th><th>Applies to</th><th>Frequency</th><th>Last done</th><th>Next due</th><th>Status</th><th /></tr></thead>
      <tbody>
        {sorted.map((t) => (
          <tr key={t.id}>
            <td>{LS_CATEGORIES.has(t.category) && (t.status === 'failed' || t.status === 'overdue') && <><LifeSafetyFlag />{' '}</>}{t.label}</td>
            <td>{t.target_label ?? 'Building'}</td>
            <td>{t.frequency}</td>
            <td>{t.last_done_on ?? '—'}</td>
            <td>{t.nextDue}</td>
            <td>{chip(t.status)}</td>
            <td><button onClick={() => onRecord(t)}>Record</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Every check gets an explicit yes or no; any no needs notes and opens an issue. */
export function CompletionForm({ task, onSave, onCancel }: { task: ComplianceTask; onSave: (body: { performedOn: string; answers: Record<string, boolean>; notes?: string }) => Promise<void>; onCancel: () => void }) {
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [performedOn, setPerformedOn] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const failing = Object.values(answers).some((v) => v === false);
  const complete = task.checks.every((c) => typeof answers[c.key] === 'boolean');
  const ready = complete && (!failing || notes.trim().length > 0);
  return (
    <form className="card" aria-label={`Record ${task.label}`} onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      try { await onSave({ performedOn, answers, ...(notes.trim() ? { notes } : {}) }); } catch (x) { setErr((x as Error).message); }
    }}>
      <h2 style={{ marginTop: 0 }}>{task.label}{task.target_label ? ` · ${task.target_label}` : ''}</h2>
      <label>Date performed<input type="date" required value={performedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setPerformedOn(e.target.value)} /></label>
      {task.checks.map((c) => (
        <fieldset key={c.key} style={{ border: 0, padding: 0, margin: '8px 0' }}>
          <legend>{c.label}</legend>
          <label style={{ display: 'inline-flex', gap: 4, marginRight: 16 }}><input type="radio" name={c.key} checked={answers[c.key] === true} onChange={() => setAnswers({ ...answers, [c.key]: true })} />Yes</label>
          <label style={{ display: 'inline-flex', gap: 4 }}><input type="radio" name={c.key} checked={answers[c.key] === false} onChange={() => setAnswers({ ...answers, [c.key]: false })} />No</label>
        </fieldset>
      ))}
      <label>{failing ? 'What was found (required)' : 'Notes'}<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {failing && <p className="muted">A "No" fails this task and opens an issue{LS_CATEGORIES.has(task.category) ? ' flagged life safety' : ''}.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row"><button className="primary" disabled={!ready}>Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

/** Each system and the audiences that need training, with a text status. */
export function TrainingMatrix({ rows }: { rows: TrainingRow[] }) {
  return (
    <table>
      <thead><tr><th>System</th><th>Who needs training</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td className="row" style={{ flexWrap: 'wrap' }}>
              {r.audiences.map((a) => <span key={a.audience}>{a.label} <span className={`chip ${CELL[a.status].cls}`}>{CELL[a.status].label}</span></span>)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ScheduleForm({ projectId, systems, audiences, onDone, onCancel }: { projectId: string; systems: TrainingRow[]; audiences: Record<string, string>; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ systemId: '', topic: '', trainer: '', when: '', durationMin: '60', audiences: [] as string[] });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="card" aria-label="Schedule training" onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      try {
        await api(`/projects/${projectId}/training-sessions`, { body: { ...(f.systemId ? { systemId: f.systemId } : {}), topic: f.topic, trainer: f.trainer, audiences: f.audiences, scheduledAt: new Date(f.when).toISOString(), durationMin: Number(f.durationMin) } });
        onDone();
      } catch (x) { setErr((x as Error).message); }
    }}>
      <h2 style={{ marginTop: 0 }}>Schedule training</h2>
      <label>System<select value={f.systemId} onChange={(e) => setF({ ...f, systemId: e.target.value })}><option value="">General (no system)</option>{systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Topic<input required minLength={3} value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} /></label>
      <label>Trainer<input required minLength={2} value={f.trainer} onChange={(e) => setF({ ...f, trainer: e.target.value })} /></label>
      <label>When<input type="datetime-local" required value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} /></label>
      <label>Length (minutes)<input required inputMode="numeric" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: e.target.value })} /></label>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Audiences</legend>
        {Object.entries(audiences).map(([k, label]) => (
          <label key={k} style={{ display: 'inline-flex', gap: 4, marginRight: 12 }}>
            <input type="checkbox" checked={f.audiences.includes(k)} onChange={(e) => setF({ ...f, audiences: e.target.checked ? [...f.audiences, k] : f.audiences.filter((x) => x !== k) })} />{label}
          </label>
        ))}
      </fieldset>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row"><button className="primary" disabled={!f.audiences.length}>Schedule</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function CloseSession({ session, audiences, onDone, onCancel }: { session: Session; audiences: Record<string, string>; onDone: () => void; onCancel: () => void }) {
  const [names, setNames] = useState('');
  const [audience, setAudience] = useState(Object.keys(audiences)[0] ?? 'facilities');
  const [reference, setReference] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); onDone(); } catch (x) { setErr((x as Error).message); } };
  return (
    <div className="card" aria-label={`Close ${session.topic}`}>
      <h2 style={{ marginTop: 0 }}>{session.topic}</h2>
      <p className="muted">{session.attendee_count} attendees recorded. Record names only, never patient information.</p>
      <label>Attendee names, one per line<textarea rows={3} value={names} onChange={(e) => setNames(e.target.value)} /></label>
      <label>Their role<select value={audience} onChange={(e) => setAudience(e.target.value)}>{Object.entries(audiences).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <div className="row"><button disabled={!names.trim()} onClick={() => run(() => api(`/training-sessions/${session.id}/attendance`, { body: { attendees: names.split('\n').map((n) => n.trim()).filter(Boolean).map((name) => ({ name, audience })) } }))}>Add attendees</button></div>
      <label>Where the sign-in sheet and materials are filed<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. document system path" /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row">
        <button className="primary" disabled={reference.trim().length < 3} onClick={() => run(() => api(`/training-sessions/${session.id}/close`, { body: { outcome: 'held', materialsReference: reference } }))}>Mark held</button>
        <button onClick={() => run(() => api(`/training-sessions/${session.id}/close`, { body: { outcome: 'cancelled' } }))}>Cancel session</button>
        <button type="button" onClick={onCancel}>Close</button>
      </div>
    </div>
  );
}

export function OperationsPage() {
  const { projectId } = useParams();
  const compliance = useApi<Compliance>(`/projects/${projectId}/compliance`);
  const calendar = useApi<{ from: string; to: string; events: CalendarEvent[] }>(`/projects/${projectId}/compliance/calendar`);
  const training = useApi<Training>(`/projects/${projectId}/training`);
  const catalog = useApi<Catalog>('/compliance/catalog');
  const [recording, setRecording] = useState<ComplianceTask | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [closing, setClosing] = useState<Session | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = () => { compliance.reload(); calendar.reload(); training.reload(); };
  const run = (fn: () => Promise<unknown>) => { setErr(null); fn().catch((x) => setErr((x as Error).message)); };

  // Daily tasks would fill every day of the window; list them once instead.
  const daily = new Set((compliance.data?.tasks ?? []).filter((t) => t.frequency === 'Daily').map((t) => t.id));
  const dailyTasks = (compliance.data?.tasks ?? []).filter((t) => daily.has(t.id));
  const byDate = new Map<string, CalendarEvent[]>();
  for (const e of calendar.data?.events ?? []) {
    if (daily.has(e.id) && e.status === 'upcoming') continue;
    byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  }

  return (
    <>
      <h1>Operations</h1>
      <p className="muted">Recurring compliance after occupancy, owner training, and exports for the maintenance system. Intervals are starting values pending review; hospitals can set stricter ones.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {msg && <p role="status">{msg}</p>}

      <section className="card" aria-label="Compliance tasks">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Compliance tasks</h2>
          <button onClick={() => run(async () => { const r = await api<{ created: number }>(`/projects/${projectId}/compliance/generate`, { body: {} }); setMsg(`${r.created} tasks added.`); reload(); })}>Add standard tasks</button>
        </div>
        <Loading error={compliance.error}>
          {compliance.data && (compliance.data.tasks.length ? (
            <>
              <p>{compliance.data.summary.overdue} overdue, {compliance.data.summary.failed} failed, {compliance.data.summary.due} due, {compliance.data.summary.current} current</p>
              <TaskTable tasks={compliance.data.tasks} onRecord={setRecording} />
            </>
          ) : <p>No tasks yet. Add the standard tasks to start the calendar.</p>)}
        </Loading>
      </section>
      {recording && (
        <CompletionForm task={recording} onCancel={() => setRecording(null)} onSave={async (body) => {
          const r = await api<{ result: string }>(`/compliance-tasks/${recording.id}/completions`, { body });
          setRecording(null);
          setMsg(r.result === 'pass' ? 'Recorded as passed.' : 'Recorded as failed. An issue was opened.');
          reload();
        }} />
      )}

      <section className="card" aria-label="Next 30 days">
        <h2 style={{ marginTop: 0 }}>Next 30 days</h2>
        <Loading error={calendar.error}>
          {dailyTasks.length > 0 && <p>Every day: {dailyTasks.map((t) => `${t.label}${t.target_label ? ` (${t.target_label})` : ''}`).join('; ')}.</p>}
          {byDate.size ? [...byDate.entries()].map(([date, events]) => (
            <div key={date} style={{ marginBottom: 8 }}>
              <h3 style={{ fontSize: 15, margin: '8px 0 4px' }}>{date}</h3>
              <ul style={{ margin: 0 }}>
                {events.map((e, i) => <li key={`${e.id}-${i}`}>{e.source === 'life_safety' && <><LifeSafetyFlag />{' '}</>}{e.label}{e.target ? ` · ${e.target}` : ''} {chip(e.status)}</li>)}
              </ul>
            </div>
          )) : <p>Nothing falls due in this window.</p>}
        </Loading>
      </section>

      <section className="card" aria-label="Owner training">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Owner training</h2>
          <div className="row">
            <button onClick={() => setScheduling(true)}>Schedule training</button>
            <button onClick={() => run(() => openReport(`/projects/${projectId}/training/report`))}>Export training record</button>
          </div>
        </div>
        <Loading error={training.error ?? catalog.error}>
          {training.data && (
            <>
              <Progress value={training.data.summary.required ? Math.round((100 * training.data.summary.trained) / training.data.summary.required) : 0} label={`${training.data.summary.trained} of ${training.data.summary.required} trained`} />
              <TrainingMatrix rows={training.data.matrix} />
              <h3>Sessions</h3>
              {training.data.sessions.length ? (
                <table>
                  <thead><tr><th>Topic</th><th>Trainer</th><th>When</th><th>Attendees</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {training.data.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{s.topic}</td><td>{s.trainer}</td><td>{new Date(s.scheduled_at).toLocaleString()}</td><td>{s.attendee_count}</td>
                        <td><span className={`chip ${s.status === 'held' ? 'chip-pass' : s.status === 'scheduled' ? 'chip-open' : 'chip-closed'}`}>{s.status}</span></td>
                        <td>{s.status === 'scheduled' && <button onClick={() => setClosing(s)}>Attendance</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p>No sessions yet.</p>}
            </>
          )}
        </Loading>
      </section>
      {scheduling && training.data && catalog.data && <ScheduleForm projectId={projectId!} systems={training.data.matrix} audiences={catalog.data.audiences} onCancel={() => setScheduling(false)} onDone={() => { setScheduling(false); reload(); }} />}
      {closing && catalog.data && <CloseSession session={closing} audiences={catalog.data.audiences} onCancel={() => setClosing(null)} onDone={() => { setClosing(null); reload(); }} />}

      <section className="card" aria-label="Maintenance system export">
        <h2 style={{ marginTop: 0 }}>Maintenance system (CMMS) export</h2>
        <p className="muted">CSV files most maintenance systems can import: the asset register with warranty end dates, and the preventive maintenance schedule.</p>
        <div className="row">
          <button onClick={() => run(() => download(`/projects/${projectId}/exports/cmms/assets.csv`, 'cmms-assets.csv'))}>Asset register</button>
          <button onClick={() => run(() => download(`/projects/${projectId}/exports/cmms/pm-schedule.csv`, 'cmms-pm-schedule.csv'))}>PM schedule</button>
        </div>
      </section>
    </>
  );
}
