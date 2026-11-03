import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, setToken } from '../api';
import { LifeSafetyFlag, Loading, Progress, useApi } from '../components';

export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="login">
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          const r = await api<{ token: string }>('/auth/dev-login', { body: { email, pin } });
          setToken(r.token);
          onLogin();
        } catch (x) { setErr((x as Error).message); }
      }}>
        <img src="/omoshine-logo.png" alt="OMOSHINE logo" />
        <h1>OMOSHINE CX Planner</h1>
        <p className="muted" style={{ marginTop: -8 }}>Healthcare Edition</p>
        <button type="button" className="primary" style={{ width: '100%', marginBottom: 16 }} disabled title="Configured per hospital in production">
          Sign in with your organization (SSO)
        </button>
        <div style={{ display: 'grid', gap: 12, textAlign: 'left' }}>
          <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>PIN<input type="password" autoComplete="current-password" required value={pin} onChange={(e) => setPin(e.target.value)} /></label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="primary" type="submit">Sign in</button>
        </div>
      </form>
    </div>
  );
}

interface Project { id: string; name: string; facility_name: string; state_code: string; accreditor: string }

export function ProjectsPage() {
  const { data, error } = useApi<Project[]>('/projects');
  return (
    <>
      <h1>Projects</h1>
      <Loading error={error}>
        <div className="cards">
          {data?.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <h2>{p.name}</h2>
              <p className="muted">{p.facility_name} · {p.state_code} · {p.accreditor}</p>
            </Link>
          ))}
          {data?.length === 0 && <p className="muted">No projects assigned to you yet.</p>}
        </div>
      </Loading>
    </>
  );
}

interface Readiness {
  tests: { total: number; signed: number; failed: number; percentSigned: number };
  issues: { open: number; closed: number; openLifeSafety: number };
  roomsByPhase: { phase: string; pass: number; fail: number; incomplete: number; notTested: number }[];
}

export function ReadinessView({ data }: { data: Readiness }) {
  return (
    <>
      <div className="cards">
        <div className="card">
          <h2>Tests signed</h2>
          <div className="stat">{data.tests.percentSigned}%</div>
          <Progress value={data.tests.percentSigned} label="Tests signed" />
          <p className="muted">{data.tests.signed} of {data.tests.total} · {data.tests.failed} failed</p>
        </div>
        <div className="card">
          <h2>Open issues</h2>
          <div className="stat">{data.issues.open}</div>
          {data.issues.openLifeSafety > 0 && <p><LifeSafetyFlag /> {data.issues.openLifeSafety} open</p>}
          <p className="muted">{data.issues.closed} closed</p>
        </div>
      </div>
      <div className="card">
        <h2>Room compliance by phase</h2>
        <table>
          <thead><tr><th>Phase</th><th>Pass</th><th>Fail</th><th>Incomplete</th><th>Not tested</th><th>Ready</th></tr></thead>
          <tbody>
            {data.roomsByPhase.map((p) => {
              const total = p.pass + p.fail + p.incomplete + p.notTested;
              const pct = total ? Math.round((p.pass / total) * 100) : 0;
              return (
                <tr key={p.phase}>
                  <td>{p.phase}</td><td>{p.pass}</td><td>{p.fail}</td><td>{p.incomplete}</td><td>{p.notTested}</td>
                  <td style={{ minWidth: 140 }}><Progress value={pct} label={`${p.phase} rooms passing`} /> <span className="muted">{pct}%</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function DashboardPage() {
  const { projectId } = useParams();
  const project = useApi<Project>(`/projects/${projectId}`);
  const { data, error } = useApi<Readiness>(`/projects/${projectId}/readiness`);
  return (
    <>
      <h1>{project.data?.name ?? 'Project'} – Readiness</h1>
      <Loading error={error}>{data && <ReadinessView data={data} />}</Loading>
    </>
  );
}
