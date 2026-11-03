import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { LifeSafetyFlag, Loading, StatusChip, useApi } from '../components';

interface Issue { id: string; number: number; title: string; status: string; priority: string; life_safety: boolean; ball_in_court_name: string | null; ball_in_court_org_id: string | null; room_number: string | null; system_name: string | null }
interface Org { id: string; name: string }

export function IssuesPage() {
  const { projectId } = useParams();
  const [status, setStatus] = useState('not_closed');
  const { data, error, reload } = useApi<Issue[]>(`/projects/${projectId}/issues${status ? `?status=${status}` : ''}`);
  const orgs = useApi<Org[]>('/organizations');
  const [title, setTitle] = useState('');
  const [lifeSafety, setLifeSafety] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = async (id: string, body: Record<string, unknown>) => {
    try { await api(`/issues/${id}`, { method: 'PATCH', body }); reload(); } catch (x) { setErr((x as Error).message); }
  };

  return (
    <>
      <h1>Issues</h1>
      <form className="card row" onSubmit={async (e) => {
        e.preventDefault();
        try { await api(`/projects/${projectId}/issues`, { body: { title, lifeSafety } }); setTitle(''); setLifeSafety(false); reload(); } catch (x) { setErr((x as Error).message); }
      }}>
        <label style={{ flex: 1 }}>New issue<input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} /></label>
        <label className="row" style={{ display: 'flex' }}><input type="checkbox" checked={lifeSafety} onChange={(e) => setLifeSafety(e.target.checked)} style={{ minHeight: 0 }} /> Life safety</label>
        <button className="primary" type="submit">Add issue</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginBottom: 12 }}>
        <label>Show
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="not_closed">Open (all not closed)</option>
            <option value="">All</option>
            <option value="closed">Closed</option>
          </select>
        </label>
      </div>
      <Loading error={error}>
        {data && (
          <div className="card">
            <table>
              <thead><tr><th>#</th><th>Issue</th><th>Location</th><th>Priority</th><th>Ball in court</th><th>Status</th></tr></thead>
              <tbody>
                {data.map((i) => (
                  <tr key={i.id}>
                    <td>{i.number}</td>
                    <td>{i.title} {i.life_safety && <LifeSafetyFlag />}</td>
                    <td>{i.room_number ?? i.system_name ?? '—'}</td>
                    <td>{i.priority}</td>
                    <td>
                      <select aria-label={`Ball in court for issue ${i.number}`} value={i.ball_in_court_org_id ?? ''} onChange={(e) => update(i.id, { ballInCourtOrgId: e.target.value || null })}>
                        <option value="">Unassigned</option>
                        {orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <StatusChip status={i.status} />{' '}
                      <select aria-label={`Status for issue ${i.number}`} value={i.status} onChange={(e) => update(i.id, { status: e.target.value })}>
                        <option value="open">Open</option><option value="in_progress">In progress</option>
                        <option value="ready_for_review">Ready for review</option><option value="closed">Closed</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Loading>
    </>
  );
}
