import { useState } from 'react';
import { ReauthForm } from '../reauth';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Loading, StatusChip, fmtDate, useApi } from '../components';

interface RunListItem { id: string; template_name: string; kind: string; target_label: string; status: string; result: string | null; started_at: string }
interface Template { id: string; name: string; kind: string; applies_to_system_type: string | null; published: boolean }
interface Tree { rooms: { id: string; number: string; name: string }[]; systems: { id: string; name: string }[]; assets: { id: string; tag: string }[] }

export function TestRunsPage() {
  const { projectId } = useParams();
  const runs = useApi<RunListItem[]>(`/projects/${projectId}/test-runs`);
  const templates = useApi<Template[]>('/templates');
  const tree = useApi<Tree>(`/projects/${projectId}/tree`);
  const [templateId, setTemplateId] = useState('');
  const [target, setTarget] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  return (
    <>
      <h1>Checklists and functional tests</h1>
      <form className="card form-grid" onSubmit={async (e) => {
        e.preventDefault();
        const [targetType, targetId] = target.split(':');
        try {
          const run = await api<{ id: string }>('/test-runs', { body: { templateId, targetType, targetId } });
          nav(`/projects/${projectId}/tests/${run.id}`);
        } catch (x) { setErr((x as Error).message); }
      }}>
        <label>Template
          <select required value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Choose…</option>
            {templates.data?.filter((t) => t.published).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <label>Target
          <select required value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose…</option>
            <optgroup label="Rooms">{tree.data?.rooms.map((r) => <option key={r.id} value={`room:${r.id}`}>{r.number} {r.name}</option>)}</optgroup>
            <optgroup label="Systems">{tree.data?.systems.map((s) => <option key={s.id} value={`system:${s.id}`}>{s.name}</option>)}</optgroup>
            <optgroup label="Assets">{tree.data?.assets.map((a) => <option key={a.id} value={`asset:${a.id}`}>{a.tag}</option>)}</optgroup>
          </select>
        </label>
        <div style={{ alignSelf: 'end' }}><button className="primary" type="submit">Start test</button></div>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      <Loading error={runs.error}>
        <div className="card">
          <table>
            <thead><tr><th>Test</th><th>Target</th><th>Started</th><th>Status</th><th>Result</th></tr></thead>
            <tbody>
              {runs.data?.map((r) => (
                <tr key={r.id} className="clickable" tabIndex={0} onClick={() => nav(`/projects/${projectId}/tests/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/projects/${projectId}/tests/${r.id}`)}>
                  <td>{r.template_name}</td><td>{r.target_label}</td><td>{fmtDate(r.started_at)}</td>
                  <td><StatusChip status={r.status} /></td><td>{r.result ? <StatusChip status={r.result} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Loading>
    </>
  );
}

interface RunDetail {
  run: { id: string; status: string; result: string | null };
  template: { name: string };
  items: { id: string; seq: number; prompt: string; response_type: 'pass_fail' | 'number' | 'text'; unit: string | null; required: boolean; requirement_key: string | null }[];
  responses: { template_item_id: string; value: string | null; status: string; evaluation: { required: string; citation: string } | null }[];
  signatures: { id: string; signer_name: string; signer_role: string; meaning: string; signed_at: string; record_sha256: string }[];
}

/** Re-authenticate, then sign. The PIN is never stored. */
/** Signing dialog: choose the meaning, then re-authenticate (PIN or single sign-on). onSign receives the re-authentication token. */
export function SignDialog({ onSign, onClose }: { onSign: (reauthToken: string, meaning: string) => Promise<void>; onClose: () => void }) {
  const [meaning, setMeaning] = useState('performed');
  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="sign-title">
      <ReauthForm onClose={onClose} onToken={(token) => onSign(token, meaning)}>
        <h2 id="sign-title">Sign this record</h2>
        <p className="muted">Signing locks the record. Corrections will require a superseding test.</p>
        <label>Signature meaning
          <select value={meaning} onChange={(e) => setMeaning(e.target.value)}>
            <option value="performed">Performed</option><option value="witnessed">Witnessed</option>
            <option value="reviewed">Reviewed</option><option value="approved">Approved</option>
            <option value="ahj_accepted">AHJ accepted</option>
          </select>
        </label>
      </ReauthForm>
    </div>
  );
}

export function TestRunPage() {
  const { projectId, runId } = useParams();
  const { data, error, reload } = useApi<RunDetail>(`/test-runs/${runId}`);
  const [signing, setSigning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  if (!data) return <Loading error={error}>{null}</Loading>;
  const editable = data.run.status === 'in_progress';
  const resp = new Map(data.responses.map((r) => [r.template_item_id, r]));
  const save = async (itemId: string, value: string | number | null) => {
    setErr(null);
    try { await api(`/test-runs/${runId}/responses/${itemId}`, { method: 'PUT', body: { value } }); reload(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{data.template.name}</h1>
        <div className="row"><StatusChip status={data.run.status} />{data.run.result && <StatusChip status={data.run.result} />}</div>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="card">
        <table>
          <thead><tr><th>#</th><th>Check</th><th>Response</th><th>Result</th></tr></thead>
          <tbody>
            {data.items.map((it) => {
              const r = resp.get(it.id);
              return (
                <tr key={it.id} className={r?.status === 'fail' ? 'failed' : undefined}>
                  <td>{it.seq}</td>
                  <td>{it.prompt}{!it.required && <span className="muted"> (optional)</span>}
                    {r?.evaluation && <div className="muted" style={{ fontSize: 12 }}>Required {r.evaluation.required} · {r.evaluation.citation}</div>}</td>
                  <td>
                    {it.response_type === 'pass_fail' ? (
                      <div className="row" role="group" aria-label={`Response for item ${it.seq}`}>
                        <button type="button" disabled={!editable} aria-pressed={r?.value === 'pass'} onClick={() => save(it.id, 'pass')}>Pass</button>
                        <button type="button" disabled={!editable} aria-pressed={r?.value === 'fail'} onClick={() => save(it.id, 'fail')}>Fail</button>
                      </div>
                    ) : (
                      <input aria-label={`Response for item ${it.seq}`} disabled={!editable} defaultValue={r?.value ?? ''}
                        inputMode={it.response_type === 'number' ? 'decimal' : 'text'}
                        onBlur={(e) => e.target.value !== (r?.value ?? '') && save(it.id, e.target.value === '' ? null : it.response_type === 'number' ? Number(e.target.value) : e.target.value)} />
                    )}
                    {it.unit && <span className="muted"> {it.unit}</span>}
                  </td>
                  <td>{r ? <StatusChip status={r.status} /> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12 }}>
          {editable && <button className="primary" onClick={async () => { try { await api(`/test-runs/${runId}/submit`, { body: {} }); reload(); } catch (x) { setErr((x as Error).message); } }}>Submit</button>}
          {(data.run.status === 'submitted' || data.run.status === 'signed') && <button className="primary" onClick={() => setSigning(true)}>Sign</button>}
          {data.run.status === 'signed' && (
            <button onClick={async () => {
              const reason = window.prompt('Reason for retest');
              if (!reason) return;
              const fresh = await api<{ id: string }>(`/test-runs/${runId}/supersede`, { body: { reason } });
              nav(`/projects/${projectId}/tests/${fresh.id}`);
            }}>Retest (supersede)</button>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Signatures</h2>
        {data.signatures.length === 0 ? <p className="muted">Not signed.</p> : (
          <ul>{data.signatures.map((s) => <li key={s.id}>{s.signer_name} ({s.signer_role}) · {s.meaning.replace('_', ' ')} · {fmtDate(s.signed_at)} · <code title={s.record_sha256}>{s.record_sha256.slice(0, 12)}…</code></li>)}</ul>
        )}
      </div>
      {signing && (
        <SignDialog
          onClose={() => setSigning(false)}
          onSign={async (reauthToken, meaning) => {
            await api(`/test-runs/${runId}/signatures`, { body: { meaning }, headers: { 'x-reauth-token': reauthToken } });
            setSigning(false);
            reload();
          }}
        />
      )}
    </>
  );
}
