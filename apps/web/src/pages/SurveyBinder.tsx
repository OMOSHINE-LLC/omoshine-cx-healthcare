import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { openReport } from '../api';
import { LifeSafetyFlag, Loading, fmtDate, useApi } from '../components';

type SectionStatus = 'ready' | 'attention' | 'no_records';
export interface Binder {
  generatedAt: string;
  sections: { key: string; title: string; status: SectionStatus; summary: string; gaps: { severity: string; text: string }[] }[];
  gaps: { severity: 'life_safety' | 'regulatory'; text: string; section: string }[];
  summary: { ready: number; attention: number; noRecords: number; lifeSafetyGaps: number; otherGaps: number };
}

const STATUS: Record<SectionStatus, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'chip-pass' },
  attention: { label: 'Needs attention', cls: 'chip-fail' },
  no_records: { label: 'No records', cls: 'chip-closed' },
};

export function BinderView({ binder, onOpenReport }: { binder: Binder; onOpenReport: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const s = binder.summary;
  const gaps = showAll ? binder.gaps : binder.gaps.slice(0, 10);
  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <p style={{ margin: 0 }}>
            <strong>{s.ready}</strong> section{s.ready === 1 ? '' : 's'} ready, <strong>{s.attention}</strong> need{s.attention === 1 ? 's' : ''} attention, {s.noRecords} with no records.
          </p>
          <button className="primary" onClick={onOpenReport}>Open printable binder</button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Compiled {fmtDate(binder.generatedAt)} from the records in this project.</p>
      </div>
      <div className="card" aria-label="Gaps to close">
        <h2>Gaps to close before the survey</h2>
        {binder.gaps.length === 0 ? <p>No open gaps. Every section is ready.</p> : (
          <>
            <p>{s.lifeSafetyGaps > 0 && <><LifeSafetyFlag /> </>}<strong>{s.lifeSafetyGaps} life safety</strong> and {s.otherGaps} other gap{s.otherGaps === 1 ? '' : 's'}.</p>
            <ol>
              {gaps.map((g, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  {g.severity === 'life_safety' && <><LifeSafetyFlag /> </>}{g.text} <span className="muted">({g.section})</span>
                </li>
              ))}
            </ol>
            {binder.gaps.length > 10 && <button onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${binder.gaps.length}`}</button>}
          </>
        )}
      </div>
      <div className="cards">
        {binder.sections.map((sec) => (
          <div key={sec.key} className="card" aria-label={`Binder section ${sec.title}`}>
            <span className={`chip ${STATUS[sec.status].cls}`}>{STATUS[sec.status].label}</span>
            <h3 style={{ margin: '8px 0 4px', fontSize: 15 }}>{sec.title}</h3>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{sec.summary}</p>
            {sec.gaps.length > 0 && <p style={{ margin: '6px 0 0', fontSize: 13 }}>{sec.gaps.length} gap{sec.gaps.length === 1 ? '' : 's'}</p>}
          </div>
        ))}
      </div>
    </>
  );
}

export function SurveyBinderPage() {
  const { projectId } = useParams();
  const binder = useApi<Binder>(`/projects/${projectId}/survey-binder`);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <h1>Survey binder</h1>
      <p className="muted">Everything a surveyor or inspector asks for, gathered from the project's signed records, with the gaps to close first.</p>
      {err && <p className="error" role="alert">{err}</p>}
      <Loading error={binder.error}>
        {binder.data && <BinderView binder={binder.data} onOpenReport={() => openReport(`/projects/${projectId}/survey-binder/report`).catch((x) => setErr((x as Error).message))} />}
      </Loading>
    </>
  );
}
