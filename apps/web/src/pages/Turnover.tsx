import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, openReport } from '../api';
import { LifeSafetyFlag, Loading, Progress, fmtDate, useApi } from '../components';
import { ReauthForm } from '../reauth';

type MatrixStatus = 'accepted' | 'submitted' | 'rejected' | 'missing';
interface Doc {
  id: string; kind: string; title: string; reference: string; status: 'submitted' | 'accepted' | 'rejected'; review_note: string | null; asset_tag: string | null;
  submitted_by_name: string; submitted_at: string; reviewed_by_name: string | null; warranty: { endsOn: string | null; status: string } | null;
}
export interface TurnoverSystem { id: string; name: string; discipline: string; matrix: { kind: string; label: string; status: MatrixStatus }[]; accepted: number; required: number; documents: Doc[] }
interface TurnoverState { systems: TurnoverSystem[]; summary: { required: number; accepted: number; percent: number }; warranties: { system: string; asset: string | null; title: string; endsOn: string; status: string }[] }
interface Catalog { kinds: Record<string, { label: string; hint: string }> }
interface ReportVersion { id: string; version: number; html_sha256: string; issued_at: string; issued_by_name: string; summary: { outstanding: number; outstandingLifeSafety: number } }

const STATUS: Record<MatrixStatus, { label: string; cls: string }> = {
  accepted: { label: 'Accepted', cls: 'chip-pass' }, submitted: { label: 'Under review', cls: 'chip-open' },
  rejected: { label: 'Rejected', cls: 'chip-fail' }, missing: { label: 'Missing', cls: 'chip-closed' },
};

/** One system's required documents with their status. */
export function SystemMatrix({ system, onSubmit, onReview }: { system: TurnoverSystem; onSubmit: (kind: string) => void; onReview: (doc: Doc) => void }) {
  return (
    <div className="card" aria-label={`Turnover for ${system.name}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{system.name} <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>{system.discipline}</span></h2>
        <span>{system.accepted} of {system.required} accepted</span>
      </div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Document</th><th>Status</th><th>Latest submission</th><th /></tr></thead>
        <tbody>
          {system.matrix.map((m) => {
            const latest = system.documents.find((d) => d.kind === m.kind);
            return (
              <tr key={m.kind}>
                <td>{m.label}</td>
                <td><span className={`chip ${STATUS[m.status].cls}`}>{STATUS[m.status].label}</span></td>
                <td>{latest ? (
                  <>
                    <div>{latest.title}{latest.asset_tag ? ` · ${latest.asset_tag}` : ''}</div>
                    <div className="muted" style={{ fontSize: 12 }}>{latest.reference} · {latest.submitted_by_name}, {fmtDate(latest.submitted_at)}</div>
                    {latest.review_note && <div style={{ fontSize: 12 }}>Review: {latest.review_note}</div>}
                    {latest.warranty?.endsOn && <div style={{ fontSize: 12 }}>Warranty ends {latest.warranty.endsOn}{latest.warranty.status === 'expiring' ? ' (within 90 days)' : latest.warranty.status === 'expired' ? ' (expired)' : ''}</div>}
                  </>
                ) : '—'}</td>
                <td className="row">
                  {latest?.status === 'submitted' && <button onClick={() => onReview(latest)}>Review</button>}
                  {m.status !== 'accepted' && m.status !== 'submitted' && <button onClick={() => onSubmit(m.kind)}>{m.status === 'rejected' ? 'Resubmit' : 'Submit'}</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SubmitForm({ system, kind, catalog, onDone, onCancel }: { system: TurnoverSystem; kind: string; catalog: Catalog; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ title: '', reference: '', warrantyStart: '', warrantyMonths: '' });
  const [err, setErr] = useState<string | null>(null);
  const k = catalog.kinds[kind]!;
  return (
    <form className="card form-grid" aria-label={`Submit ${k.label}`} onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      try {
        await api(`/systems/${system.id}/turnover-documents`, { body: {
          kind, title: f.title, reference: f.reference,
          ...(kind === 'warranty' ? { warrantyStart: f.warrantyStart, warrantyMonths: Number(f.warrantyMonths) } : {}),
        } });
        onDone();
      } catch (x) { setErr((x as Error).message); }
    }}>
      <h2 style={{ gridColumn: '1 / -1', margin: 0 }}>{k.label} for {system.name}</h2>
      <p className="muted" style={{ gridColumn: '1 / -1', margin: 0 }}>{k.hint}. Give where the document is filed; OMOSHINE records the reference, not the file.</p>
      <label>Title<input required minLength={2} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
      <label>Document location<input required minLength={3} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="e.g. closeout folder path or link" /></label>
      {kind === 'warranty' && (
        <>
          <label>Warranty start<input type="date" required value={f.warrantyStart} onChange={(e) => setF({ ...f, warrantyStart: e.target.value })} /></label>
          <label>Length (months)<input required inputMode="numeric" value={f.warrantyMonths} onChange={(e) => setF({ ...f, warrantyMonths: e.target.value })} /></label>
        </>
      )}
      {err && <p className="error" role="alert" style={{ gridColumn: '1 / -1' }}>{err}</p>}
      <div className="row" style={{ alignSelf: 'end' }}>
        <button className="primary" type="submit">Submit</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function ReviewForm({ doc, onDecide, onCancel }: { doc: { title: string }; onDecide: (decision: 'accepted' | 'rejected', note: string) => Promise<void>; onCancel: () => void }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const go = async (d: 'accepted' | 'rejected') => { setErr(null); try { await onDecide(d, note.trim()); } catch (x) { setErr((x as Error).message); } };
  return (
    <div className="card" aria-label={`Review ${doc.title}`}>
      <h2 style={{ marginTop: 0 }}>Review: {doc.title}</h2>
      <label>Review note (required to reject)<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={() => go('accepted')}>Accept</button>
        <button disabled={note.trim().length < 3} onClick={() => go('rejected')}>Reject</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function TurnoverPage() {
  const { projectId } = useParams();
  const state = useApi<TurnoverState>(`/projects/${projectId}/turnover`);
  const catalog = useApi<Catalog>('/turnover/catalog');
  const reports = useApi<ReportVersion[]>(`/projects/${projectId}/final-reports`);
  const [submitting, setSubmitting] = useState<{ system: TurnoverSystem; kind: string } | null>(null);
  const [reviewing, setReviewing] = useState<Doc | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = state.data;
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Turnover and final report</h1>
        <div className="row">
          <button onClick={() => openReport(`/projects/${projectId}/turnover/report`).catch((x) => setErr((x as Error).message))}>Export turnover package</button>
        </div>
      </div>
      <p className="muted">Each system hands the owner its O&amp;M manuals, warranties, as-builts, training records and test reports. Contractors submit; the CxA, owner or facilities team accepts or rejects with a note.</p>
      {msg && <p className="card" role="status">{msg}</p>}
      {err && <p className="error" role="alert">{err}</p>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Final commissioning report</h2>
        <p className="muted">Gathers the evidence, phased occupancy, turnover status, warranties and every outstanding item. The CxA issues it with an electronic signature; each issue is a frozen, hashed version.</p>
        <div className="row">
          <button onClick={() => openReport(`/projects/${projectId}/final-report/preview`).catch((x) => setErr((x as Error).message))}>Preview draft</button>
          <button className="primary" onClick={() => setIssuing(true)}>Issue final report (CxA)</button>
        </div>
        <Loading error={reports.error}>
          {reports.data && reports.data.length > 0 && (
            <table style={{ marginTop: 12 }} aria-label="Issued versions">
              <thead><tr><th>Version</th><th>Issued</th><th>Outstanding items</th><th>Hash</th><th /></tr></thead>
              <tbody>
                {reports.data.map((r) => (
                  <tr key={r.id}>
                    <td>v{r.version}</td>
                    <td>{r.issued_by_name}, {fmtDate(r.issued_at)}</td>
                    <td>{r.summary.outstanding}{r.summary.outstandingLifeSafety > 0 && <span className="row" style={{ display: 'inline-flex', marginLeft: 6 }}><LifeSafetyFlag /> {r.summary.outstandingLifeSafety}</span>}</td>
                    <td><code>{r.html_sha256.slice(0, 12)}…</code></td>
                    <td><button onClick={() => openReport(`/final-reports/${r.id}`).catch((x) => setErr((x as Error).message))}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Loading>
      </div>

      <Loading error={state.error ?? catalog.error}>
        {t && (
          <>
            <div className="card">
              <Progress value={t.summary.percent} label="Turnover documents accepted" />
              <p className="muted" style={{ fontSize: 13 }}>{t.summary.accepted} of {t.summary.required} required documents accepted across {t.systems.length} systems.</p>
              {t.warranties.some((w) => w.status !== 'active') && (
                <p style={{ fontSize: 14 }}>Warranties needing attention: {t.warranties.filter((w) => w.status !== 'active').map((w) => `${w.title} (${w.status === 'expired' ? 'expired' : 'ends'} ${w.endsOn})`).join('; ')}</p>
              )}
            </div>
            {submitting && catalog.data && (
              <SubmitForm system={submitting.system} kind={submitting.kind} catalog={catalog.data} onCancel={() => setSubmitting(null)}
                onDone={() => { setSubmitting(null); setMsg('Submitted for review.'); state.reload(); }} />
            )}
            {reviewing && (
              <ReviewForm doc={reviewing} onCancel={() => setReviewing(null)} onDecide={async (decision, note) => {
                await api(`/turnover-documents/${reviewing.id}/review`, { body: { decision, ...(note ? { note } : {}) } });
                setReviewing(null); setMsg(decision === 'accepted' ? 'Document accepted.' : 'Document rejected; the submitter will resubmit.'); state.reload();
              }} />
            )}
            {t.systems.map((s) => (
              <SystemMatrix key={s.id} system={s} onSubmit={(kind) => { setMsg(null); setSubmitting({ system: s, kind }); window.scrollTo({ top: 0 }); }}
                onReview={(d) => { setMsg(null); setReviewing(d); window.scrollTo({ top: 0 }); }} />
            ))}
          </>
        )}
      </Loading>

      {issuing && (
        <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="issue-title">
          <ReauthForm submitLabel="Issue and sign" onClose={() => setIssuing(false)} onToken={async (token) => {
            const r = await api<ReportVersion>(`/projects/${projectId}/final-reports`, { body: {}, headers: { 'x-reauth-token': token } });
            setIssuing(false); setMsg(`Final report v${r.version} issued.`); reports.reload();
          }}>
            <h2 id="issue-title">Issue the final commissioning report</h2>
            <p className="muted">The report is frozen as it stands now, including its list of outstanding items, and signed by you. Later changes need a new version.</p>
          </ReauthForm>
        </div>
      )}
    </>
  );
}
