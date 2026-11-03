import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { LifeSafetyFlag, Loading, Progress, useApi } from '../components';

interface Latest { result: 'pass' | 'fail'; tested_on: string; evidence_reference: string | null; notes: string | null; recorded_by_name: string }
export interface SpecialtyInterface { key: string; with: string; label: string; acceptance: string; lifeSafety: boolean; latest: Latest | null }
export interface SpecialtySystem {
  id: string; name: string; type: string; label: string; interfaces: SpecialtyInterface[];
  readiness: { total: number; passed: number; failed: number; untested: number; ready: boolean };
  templates: { id: string; name: string; kind: string }[]; runs: { kind: string; status: string; result: string | null }[];
}
interface State { systems: SpecialtySystem[]; summary: { systems: number; interfaces: number; passed: number; failed: number } }
interface Catalog { systems: Record<string, { label: string; references: string[] }> }

const RESULT = { pass: { label: 'Passed', cls: 'chip-pass' }, fail: { label: 'Failed', cls: 'chip-fail' } } as const;

/** One system: its interfaces with latest result, and its checklist and functional test. */
export function SpecialtyCard({ system, onRecord, onStart }: { system: SpecialtySystem; onRecord: (i: SpecialtyInterface) => void; onStart: (templateId: string) => void }) {
  return (
    <section className="card" aria-label={system.name}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{system.name} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>{system.label}</span></h2>
        <span>{system.readiness.passed} of {system.readiness.total} interfaces passed</span>
      </div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Interface</th><th>With</th><th>Must show</th><th>Latest</th><th /></tr></thead>
        <tbody>
          {system.interfaces.map((i) => (
            <tr key={i.key}>
              <td>{i.lifeSafety && <><LifeSafetyFlag />{' '}</>}{i.label}</td>
              <td>{i.with}</td>
              <td className="muted" style={{ fontSize: 13 }}>{i.acceptance}</td>
              <td>{i.latest ? (
                <>
                  <span className={`chip ${RESULT[i.latest.result].cls}`}>{RESULT[i.latest.result].label}</span>
                  <div className="muted" style={{ fontSize: 12 }}>{i.latest.tested_on} · {i.latest.recorded_by_name}</div>
                  {i.latest.notes && <div style={{ fontSize: 12 }}>{i.latest.notes}</div>}
                </>
              ) : <span className="chip chip-closed">Not tested</span>}</td>
              <td><button onClick={() => onRecord(i)}>{i.latest ? 'Retest' : 'Record'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {system.templates.map((t) => {
          const runs = system.runs.filter((r) => r.kind === t.kind);
          return <button key={t.id} onClick={() => onStart(t.id)}>Start {t.kind === 'pfc' ? 'checklist' : 'functional test'}{runs.length ? ` (${runs.length} on record)` : ''}</button>;
        })}
      </div>
    </section>
  );
}

/** Pass needs where the record is filed; fail needs what was found and opens an issue. */
export function InterfaceForm({ system, iface, onSave, onCancel }: { system: string; iface: SpecialtyInterface; onSave: (b: { interfaceKey: string; result: 'pass' | 'fail'; testedOn: string; evidenceReference?: string; notes?: string }) => Promise<void>; onCancel: () => void }) {
  const [result, setResult] = useState<'pass' | 'fail' | null>(null);
  const [testedOn, setTestedOn] = useState(new Date().toISOString().slice(0, 10));
  const [evidence, setEvidence] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const ready = result === 'pass' ? evidence.trim().length >= 3 : result === 'fail' ? notes.trim().length > 0 : false;
  return (
    <form className="card" aria-label={`Record ${iface.label}`} onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      try {
        await onSave({ interfaceKey: iface.key, result: result!, testedOn, ...(evidence.trim() ? { evidenceReference: evidence } : {}), ...(notes.trim() ? { notes } : {}) });
      } catch (x) { setErr((x as Error).message); }
    }}>
      <h2 style={{ marginTop: 0 }}>{system}: {iface.label}</h2>
      <p className="muted">Must show: {iface.acceptance}</p>
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Result</legend>
        <label style={{ display: 'inline-flex', gap: 4, marginRight: 16 }}><input type="radio" name="result" checked={result === 'pass'} onChange={() => setResult('pass')} />Passed</label>
        <label style={{ display: 'inline-flex', gap: 4 }}><input type="radio" name="result" checked={result === 'fail'} onChange={() => setResult('fail')} />Failed</label>
      </fieldset>
      <label>Date tested<input type="date" required value={testedOn} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setTestedOn(e.target.value)} /></label>
      <label>{result === 'pass' ? 'Where the test record is filed (required)' : 'Where the test record is filed'}<input value={evidence} onChange={(e) => setEvidence(e.target.value)} /></label>
      <label>{result === 'fail' ? 'What failed (required)' : 'Notes'}<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {result === 'fail' && <p className="muted">A failure opens an issue{iface.lifeSafety ? ' flagged life safety' : ''}.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row"><button className="primary" disabled={!ready}>Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

export function SpecialtyPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const state = useApi<State>(`/projects/${projectId}/specialty`);
  const catalog = useApi<Catalog>('/specialty/catalog');
  const [recording, setRecording] = useState<{ system: SpecialtySystem; iface: SpecialtyInterface } | null>(null);
  const [add, setAdd] = useState({ type: 'nurse_call', name: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => { setErr(null); fn().catch((x) => setErr((x as Error).message)); };

  return (
    <>
      <h1>Specialty systems</h1>
      <p className="muted">Nurse call, pneumatic tube, real-time location and imaging. Most of their risk is in the interfaces to other systems, so each one lists the interfaces to prove. Lists are starting points pending review.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {msg && <p role="status">{msg}</p>}
      <form className="card row" aria-label="Add specialty system" style={{ flexWrap: 'wrap', alignItems: 'end' }} onSubmit={(e) => {
        e.preventDefault();
        run(async () => { await api(`/projects/${projectId}/specialty-systems`, { body: add }); setAdd({ ...add, name: '' }); setMsg('System added.'); state.reload(); });
      }}>
        <label>Type<select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value })}>
          {Object.entries(catalog.data?.systems ?? {}).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select></label>
        <label>Name<input required minLength={2} value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="e.g. Nurse call, 4 West" /></label>
        <button className="primary">Add system</button>
      </form>
      <Loading error={state.error ?? catalog.error}>
        {state.data && (state.data.systems.length ? (
          <>
            <Progress value={state.data.summary.interfaces ? Math.round((100 * state.data.summary.passed) / state.data.summary.interfaces) : 0} label={`${state.data.summary.passed} of ${state.data.summary.interfaces} interfaces passed, ${state.data.summary.failed} failed`} />
            {state.data.systems.map((s) => (
              <div key={s.id}>
                <SpecialtyCard system={s} onRecord={(iface) => setRecording({ system: s, iface })} onStart={(templateId) => run(async () => {
                  const r = await api<{ id: string }>('/test-runs', { body: { templateId, targetType: 'system', targetId: s.id } });
                  navigate(`/projects/${projectId}/tests/${r.id}`);
                })} />
                {recording?.system.id === s.id && (
                  <InterfaceForm system={s.name} iface={recording.iface} onCancel={() => setRecording(null)} onSave={async (body) => {
                    const r = await api<{ result: string }>(`/systems/${s.id}/interface-tests`, { body });
                    setRecording(null);
                    setMsg(r.result === 'pass' ? 'Recorded as passed.' : 'Recorded as failed. An issue was opened.');
                    state.reload();
                  }} />
                )}
              </div>
            ))}
          </>
        ) : <p>No specialty systems yet. Add one above.</p>)}
      </Loading>
    </>
  );
}
