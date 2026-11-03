import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, openReport } from '../api';
import { LifeSafetyFlag, Loading, StatusChip, fmtDate, useApi } from '../components';

export interface Requirement { key: string; parameter: string; description: string; required: string; citation: string; severity: string; verified: boolean }
export interface EvalResult { requirementKey: string; parameter: string; status: string; measured: unknown; required: string; citation: string; severity: string; reason?: string }
export interface DataSheet {
  room: { id: string; number: string; name: string; department_name: string; phase_name: string | null; qr_code: string; volume_cuft: string; state_code: string };
  spaceType: { id: string; name: string; pressureRelationship: string };
  requirements: Requirement[];
  latest: null | { source: string; measured_at: string; recorded_by_name: string; readings: Record<string, unknown>; evaluation: { results: EvalResult[]; computed: { totalAch?: number; oaAch?: number } }; engine_version: string };
  overall: string;
  lifeSafetyFailure: boolean;
  history: { id: string; measured_at: string; overall: string; source: string }[];
  issues: { id: string; number: number; title: string; status: string; life_safety: boolean; requirement_key: string | null; ball_in_court_name: string | null }[];
}

const PARAM_LABEL: Record<string, string> = {
  pressure_relationship: 'Pressure relationship',
  total_ach: 'Total air changes',
  oa_ach: 'Outdoor air changes',
  all_exhaust: 'All air exhausted outdoors',
  no_recirc_room_units: 'No recirculating room units',
  rh_pct: 'Relative humidity',
  temp_f: 'Temperature',
};

function fmtMeasured(param: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (param === 'pressure_relationship' && typeof v === 'number') return `${v > 0 ? '+' : ''}${v.toFixed(3)} in. w.c.`;
  if (param === 'all_exhaust' || param === 'no_recirc_room_units') return v === 'true' ? 'Yes' : 'No';
  return String(v);
}

/** Room data sheet: requirement-by-requirement comparison with code citations. Pure view for testing. */
export function RoomDataSheetView({ sheet, onCreateIssue }: { sheet: DataSheet; onCreateIssue: (r: EvalResult) => void }) {
  const results = new Map((sheet.latest?.evaluation.results ?? []).map((r) => [r.requirementKey, r]));
  const pressure = sheet.latest?.readings.pressureDiffInWc as number | undefined;
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ marginBottom: 4 }}>{sheet.room.number} {sheet.room.name}</h1>
            <div className="muted">{sheet.spaceType.name} · {sheet.room.department_name}{sheet.room.phase_name ? ` · ${sheet.room.phase_name}` : ''}</div>
          </div>
          <div className="row">
            {sheet.lifeSafetyFailure && <LifeSafetyFlag />}
            <span aria-label="Overall status"><StatusChip status={sheet.overall} /></span>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Requirements</h2>
        <table>
          <thead>
            <tr><th>Parameter</th><th>Required</th><th>Measured</th><th>Result</th><th>Code citation</th><th></th></tr>
          </thead>
          <tbody>
            {sheet.requirements.map((req) => {
              const r = results.get(req.key);
              const status = r?.status ?? 'not_tested';
              return (
                <tr key={req.key} className={status === 'fail' ? 'failed' : undefined}>
                  <td>
                    {PARAM_LABEL[req.parameter] ?? req.parameter}{' '}
                    {req.severity === 'life_safety' && <LifeSafetyFlag />}
                    {!req.verified && <div className="muted" style={{ fontSize: 12 }}>Value pending code review</div>}
                  </td>
                  <td>{req.required === 'true' ? 'Yes' : req.required}</td>
                  <td>{fmtMeasured(req.parameter, r?.measured)}</td>
                  <td><StatusChip status={status} />{r?.reason && <div className="muted" style={{ fontSize: 12 }}>{r.reason}</div>}</td>
                  <td>{req.citation}</td>
                  <td>{status === 'fail' && r && <button onClick={() => onCreateIssue(r)}>Create issue</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sheet.latest ? (
          <p className="muted">
            Source: {sheet.latest.source.toUpperCase()} · measured {fmtDate(sheet.latest.measured_at)} · recorded by {sheet.latest.recorded_by_name}
            {sheet.latest.evaluation.computed.totalAch !== undefined && ` · ${sheet.latest.evaluation.computed.totalAch} total ACH`}
          </p>
        ) : (
          <p className="muted">No measurements recorded yet.</p>
        )}
      </div>

      <div className="cards">
        <div className="card">
          <h2>Pressure relationship</h2>
          <div className="pressure" aria-label="Pressure relationship diagram">
            <span>Corridor</span>
            <span aria-hidden="true">{pressure === undefined ? '·' : pressure > 0 ? '⟵ air flows out' : '⟶ air flows in'}</span>
            <span>{sheet.room.number}</span>
          </div>
          <p className="muted">Required: {sheet.spaceType.pressureRelationship.replace('_', ' ')}. Measured: {fmtMeasured('pressure_relationship', pressure)}</p>
        </div>
        <div className="card">
          <h2>Linked issues</h2>
          {sheet.issues.length === 0 ? <p className="muted">None</p> : (
            <ul>
              {sheet.issues.map((i) => (
                <li key={i.id}>#{i.number} {i.title} <StatusChip status={i.status} /> {i.life_safety && <LifeSafetyFlag />}
                  {i.ball_in_court_name && <span className="muted"> · Ball in court: {i.ball_in_court_name}</span>}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>History</h2>
          <ul>{sheet.history.map((h) => <li key={h.id}>{fmtDate(h.measured_at)} · {h.source.toUpperCase()} <StatusChip status={h.overall} /></li>)}</ul>
        </div>
      </div>
    </>
  );
}

export function MeasurementForm({ onSubmit }: { onSubmit: (m: Record<string, number | boolean>) => Promise<void> }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const fields: [string, string][] = [
    ['supplyCfm', 'Supply (cfm)'], ['exhaustCfm', 'Exhaust (cfm)'], ['oaCfm', 'Outdoor air (cfm)'],
    ['pressureDiffInWc', 'Pressure diff (in. w.c.)'], ['tempF', 'Temperature (°F)'], ['rhPct', 'Humidity (%RH)'],
  ];
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      const body: Record<string, number | boolean> = {};
      for (const [k] of fields) if (vals[k]) body[k] = Number(vals[k]);
      if (vals.allExhaust) body.allExhaust = vals.allExhaust === 'yes';
      if (vals.recirc) body.recircRoomUnits = vals.recirc === 'yes';
      try { await onSubmit(body); setVals({}); } catch (x) { setErr((x as Error).message); }
    }}>
      <h2>Add measurement</h2>
      <div className="form-grid">
        {fields.map(([k, label]) => (
          <label key={k}>{label}<input inputMode="decimal" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>
        ))}
        <label>All air exhausted?<select value={vals.allExhaust ?? ''} onChange={(e) => setVals({ ...vals, allExhaust: e.target.value })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        <label>Recirculating room units?<select value={vals.recirc ?? ''} onChange={(e) => setVals({ ...vals, recirc: e.target.value })}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 12 }}><button className="primary" type="submit">Save and evaluate</button></div>
    </form>
  );
}

export function RoomPage() {
  const { projectId, roomId } = useParams();
  const { data, error, reload } = useApi<DataSheet>(`/rooms/${roomId}/data-sheet`);
  const nav = useNavigate();
  return (
    <Loading error={error}>
      {data && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <button onClick={() => nav(`/projects/${projectId}/rooms`)}>← All rooms</button>
            <button onClick={() => openReport(`/rooms/${roomId}/report`)}>Export room sheet</button>
          </div>
          <RoomDataSheetView
            sheet={data}
            onCreateIssue={async (r) => {
              await api(`/projects/${projectId}/issues`, {
                body: {
                  title: `${data.room.number}: ${PARAM_LABEL[r.parameter] ?? r.parameter} does not meet ${r.citation}`,
                  description: `Required ${r.required}; measured ${fmtMeasured(r.parameter, r.measured)}.`,
                  roomId, requirementKey: r.requirementKey, lifeSafety: r.severity === 'life_safety',
                },
              });
              reload();
            }}
          />
          <MeasurementForm onSubmit={async (m) => { await api(`/rooms/${roomId}/measurements`, { body: m }); reload(); }} />
        </>
      )}
    </Loading>
  );
}

interface GridRow { id: string; number: string; name: string; spaceTypeName: string; department_name: string; overall: string; life_safety_failure: boolean | null; parameters: Record<string, { status: string }> }
const GRID_PARAMS = ['pressure_relationship', 'total_ach', 'oa_ach', 'temp_f', 'rh_pct'];

export function RoomGridView({ rows, onOpen }: { rows: GridRow[]; onOpen: (id: string) => void }) {
  return (
    <table>
      <thead>
        <tr><th>Room</th><th>Space type</th><th>Department</th>{GRID_PARAMS.map((p) => <th key={p}>{PARAM_LABEL[p]}</th>)}<th>Overall</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={`clickable ${r.overall === 'fail' ? 'failed' : ''}`} onClick={() => onOpen(r.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(r.id)}>
            <td><strong>{r.number}</strong> {r.name}</td>
            <td>{r.spaceTypeName}</td>
            <td>{r.department_name}</td>
            {GRID_PARAMS.map((p) => <td key={p}>{r.parameters[p] ? <StatusChip status={r.parameters[p]!.status} /> : <span className="muted">—</span>}</td>)}
            <td><StatusChip status={r.overall} /> {r.life_safety_failure && <LifeSafetyFlag />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RoomGridPage() {
  const { projectId } = useParams();
  const [failOnly, setFailOnly] = useState(false);
  const { data, error } = useApi<GridRow[]>(`/projects/${projectId}/room-compliance${failOnly ? '?status=fail' : ''}`);
  const nav = useNavigate();
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Room compliance (ASHRAE 170)</h1>
        <label className="row" style={{ display: 'flex' }}><input type="checkbox" checked={failOnly} onChange={(e) => setFailOnly(e.target.checked)} style={{ minHeight: 0 }} /> Failures only</label>
      </div>
      <Loading error={error}>{data && <div className="card"><RoomGridView rows={data} onOpen={(id) => nav(`/projects/${projectId}/rooms/${id}`)} /></div>}</Loading>
    </>
  );
}
