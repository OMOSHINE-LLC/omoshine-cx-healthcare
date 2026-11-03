import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { LifeSafetyFlag, Loading, StatusChip, fmtDate, useApi } from '../components';

export interface Assessment {
  id: string; deficiency_type: string; description: string; location: string; identified_at: string; expected_out_of_service_hours: string;
  required_measures: string[]; implemented_measures: string[]; status: 'open' | 'resolved';
  fireWatchRequired: boolean; patrolIntervalMin: number;
  patrols: { id: string; patrolled_at: string; area: string; all_clear: boolean; findings: string; recorded_by_name: string }[];
  gaps: { from: string; to: string; minutes: number }[];
}
interface Catalog { deficiencyTypes: Record<string, string>; measures: Record<string, string> }

export function AssessmentCard({ a, catalog, onToggleMeasure, onPatrol, onResolve }: {
  a: Assessment; catalog: Catalog;
  onToggleMeasure: (m: string, on: boolean) => void;
  onPatrol: (allClear: boolean, findings: string) => void;
  onResolve: () => void;
}) {
  const [findings, setFindings] = useState('');
  const last = a.patrols.at(-1);
  const missing = a.required_measures.filter((m) => !a.implemented_measures.includes(m));
  return (
    <div className="card" aria-label={`ILSM assessment ${a.location}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{catalog.deficiencyTypes[a.deficiency_type] ?? a.deficiency_type}</h2>
        <div className="row"><LifeSafetyFlag /><StatusChip status={a.status === 'open' ? 'open' : 'closed'} /></div>
      </div>
      <p className="muted">{a.location} · identified {fmtDate(a.identified_at)} · expected {a.expected_out_of_service_hours} h out of service</p>
      <p>{a.description}</p>
      <h3 style={{ fontSize: 14 }}>Required measures</h3>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {a.required_measures.map((m) => (
          <li key={m}>
            <label className="row" style={{ display: 'flex', fontWeight: 400 }}>
              <input type="checkbox" style={{ minHeight: 0, width: 'auto' }} disabled={a.status !== 'open'} checked={a.implemented_measures.includes(m)} onChange={(e) => onToggleMeasure(m, e.target.checked)} />
              {catalog.measures[m] ?? m}
            </label>
          </li>
        ))}
      </ul>
      {a.fireWatchRequired && (
        <>
          <h3 style={{ fontSize: 14 }}>Fire watch (patrol at least every {a.patrolIntervalMin} min)</h3>
          {a.gaps.length > 0 && (
            <p className="error" role="alert">{a.gaps.length} gap{a.gaps.length > 1 ? 's' : ''} over {a.patrolIntervalMin} min, longest {Math.max(...a.gaps.map((g) => g.minutes))} min{a.status === 'open' && last ? `; last patrol ${fmtDate(last.patrolled_at)}` : ''}</p>
          )}
          {a.status === 'open' && (
            <div className="row">
              <button className="primary" style={{ minHeight: 48 }} onClick={() => onPatrol(true, '')}>Patrol done, all clear</button>
              <input aria-label="Findings" placeholder="Findings, if not all clear" value={findings} onChange={(e) => setFindings(e.target.value)} style={{ flex: 1, minWidth: 180, width: 'auto' }} />
              <button style={{ minHeight: 48 }} disabled={!findings.trim()} onClick={() => { onPatrol(false, findings); setFindings(''); }}>Log with findings</button>
            </div>
          )}
          <ul>{a.patrols.slice(-5).reverse().map((p) => <li key={p.id}>{fmtDate(p.patrolled_at)} · {p.area} · {p.recorded_by_name} · {p.all_clear ? 'All clear' : <strong>{p.findings}</strong>}</li>)}</ul>
        </>
      )}
      {a.status === 'open' && (
        <button onClick={onResolve} disabled={missing.length > 0} title={missing.length ? 'Document every required measure first' : undefined}>Resolve deficiency</button>
      )}
    </div>
  );
}

export function IlsmPage() {
  const { projectId } = useParams();
  const list = useApi<Assessment[]>(`/projects/${projectId}/ilsm-assessments`);
  const catalog = useApi<Catalog>('/ilsm/catalog');
  const [form, setForm] = useState({ deficiencyType: 'fire_alarm_impaired', description: '', location: '', hours: '' });
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); list.reload(); } catch (x) { setErr((x as Error).message); } };
  return (
    <>
      <h1>Interim life safety (ILSM)</h1>
      {catalog.data && (
        <form className="card form-grid" onSubmit={(e) => { e.preventDefault(); run(() => api(`/projects/${projectId}/ilsm-assessments`, { body: { deficiencyType: form.deficiencyType, description: form.description, location: form.location, expectedOutOfServiceHours: Number(form.hours) } })); }}>
          <label>Deficiency<select value={form.deficiencyType} onChange={(e) => setForm({ ...form, deficiencyType: e.target.value })}>{Object.entries(catalog.data.deficiencyTypes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Location<input required value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
          <label>Description<input required minLength={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>Expected hours out of service<input required inputMode="decimal" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>
          <div style={{ alignSelf: 'end' }}><button className="primary" type="submit">Assess</button></div>
        </form>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <Loading error={list.error}>
        {catalog.data && list.data?.map((a) => (
          <AssessmentCard key={a.id} a={a} catalog={catalog.data!}
            onToggleMeasure={(m, on) => run(() => api(`/ilsm-assessments/${a.id}`, { method: 'PATCH', body: { implementedMeasures: on ? [...a.implemented_measures, m] : a.implemented_measures.filter((x) => x !== m) } }))}
            onPatrol={(allClear, findings) => run(() => api(`/ilsm-assessments/${a.id}/fire-watch`, { body: { area: a.location, allClear, findings } }))}
            onResolve={() => run(() => api(`/ilsm-assessments/${a.id}`, { method: 'PATCH', body: { status: 'resolved' } }))}
          />
        ))}
        {list.data?.length === 0 && <p className="muted">No interim life safety assessments.</p>}
      </Loading>
    </>
  );
}
