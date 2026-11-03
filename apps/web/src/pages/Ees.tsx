import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { LifeSafetyFlag, Loading, Progress, StatusChip, fmtDate, useApi } from '../components';

export interface EesSummary {
  branches: { branch: string; name: string; atsCount: number; passed: number; failed: number; percentPassed: number; lifeSafetyFailure: boolean }[];
  ats: { id: string; tag: string; branch: string; servedPanel: string | null; lastTestAt: string | null; transferTimeS: number | null; result: string; lifeSafetyFailure: boolean }[];
  generators: { id: string; tag: string; ratingKw: number | null; lastTestType: string | null; lastTestAt: string | null; loadPct: number | null; durationMin: number | null; result: string; nextMonthlyDue: string | null }[];
  openIssues: number;
}

const TRANSFER_LIMIT_S = 10;

export function EesDashboardView({ data, onRecordAts }: { data: EesSummary; onRecordAts: (atsId: string) => void }) {
  return (
    <>
      <div className="cards">
        {data.branches.map((b) => (
          <div className="card" key={b.branch} aria-label={`${b.name} summary`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{b.name}</h2>
              {b.lifeSafetyFailure && <LifeSafetyFlag />}
            </div>
            <div className="stat">{b.percentPassed}%</div>
            <Progress value={b.percentPassed} label={`${b.name} transfer tests passed`} />
            <p className="muted">{b.passed} of {b.atsCount} transfer switches passed · {b.failed} failed</p>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Generators</h2>
        <table>
          <thead><tr><th>Tag</th><th>Rating</th><th>Last test</th><th>Load</th><th>Duration</th><th>Result</th><th>Next monthly due</th></tr></thead>
          <tbody>
            {data.generators.map((g) => (
              <tr key={g.id}>
                <td>{g.tag}</td><td>{g.ratingKw ? `${g.ratingKw} kW` : '—'}</td>
                <td>{g.lastTestType ? `${g.lastTestType.replace('generator_', '')} · ${fmtDate(g.lastTestAt)}` : '—'}</td>
                <td>{g.loadPct ?? '—'}{g.loadPct !== null && '%'}</td><td>{g.durationMin ?? '—'}{g.durationMin !== null && ' min'}</td>
                <td><StatusChip status={g.result} /></td><td>{g.nextMonthlyDue ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Automatic transfer switches</h2>
        <table>
          <thead><tr><th>Tag</th><th>Branch</th><th>Panel</th><th>Transfer time (limit {TRANSFER_LIMIT_S} s)</th><th>Result</th><th>Last test</th><th></th></tr></thead>
          <tbody>
            {data.ats.map((a) => (
              <tr key={a.id} className={a.result === 'fail' ? 'failed' : undefined}>
                <td>{a.tag}</td>
                <td>{a.branch.replace('_', ' ')}</td>
                <td>{a.servedPanel ?? '—'}</td>
                <td>{a.transferTimeS === null ? '—' : `${a.transferTimeS} s`}{a.transferTimeS !== null && a.transferTimeS > TRANSFER_LIMIT_S && <span className="muted"> (exceeds NFPA 110 Type 10)</span>}</td>
                <td><StatusChip status={a.result} /> {a.lifeSafetyFailure && <LifeSafetyFlag />}</td>
                <td>{fmtDate(a.lastTestAt)}</td>
                <td><button onClick={() => onRecordAts(a.id)}>Record test</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function EesPage() {
  const { projectId } = useParams();
  const { data, error, reload } = useApi<EesSummary>(`/projects/${projectId}/ees/summary`);
  const [atsId, setAtsId] = useState<string | null>(null);
  const [seconds, setSeconds] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <h1>Essential electrical system</h1>
      <Loading error={error}>{data && <EesDashboardView data={data} onRecordAts={setAtsId} />}</Loading>
      {atsId && (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="ats-title">
          <form className="dialog" onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(`/assets/${atsId}/ats-tests`, { body: { transferTimeS: Number(seconds) } });
              setAtsId(null); setSeconds(''); reload();
            } catch (x) { setErr((x as Error).message); }
          }}>
            <h2 id="ats-title">Record transfer test</h2>
            <label>Transfer time (seconds)<input autoFocus inputMode="decimal" required value={seconds} onChange={(e) => setSeconds(e.target.value)} /></label>
            {err && <p className="error" role="alert">{err}</p>}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" type="submit">Save and evaluate</button>
              <button type="button" onClick={() => setAtsId(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
