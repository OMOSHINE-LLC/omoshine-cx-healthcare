import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { LifeSafetyFlag, Loading, Progress, StatusChip, fmtDate, useApi } from '../components';
import { SignDialog } from './TestRuns';

type Gas = string;
interface GasSpec { label: string; kind: 'positive' | 'vacuum'; pressurePsig?: { min: number; max: number }; minVacuumInHg?: number; testFlowSlpm: number; maxFlowDropPsi?: number; concentration?: { analyte: string; minPct?: number; maxPct?: number } }
interface TestDef { key: string; label: string; per: 'zone' | 'gas' | 'outlet'; positiveOnly?: boolean; fields: { key: string; label: string; type: 'number' | 'boolean'; unit?: string }[] }
export interface Catalog { gases: Record<Gas, GasSpec>; tests: TestDef[]; pipingLimits: { maxDewPointF: number; maxHydrocarbonDeltaPpm: number; maxParticulateMgPerM3: number; minStandingHours: number } }
type CertStatus = 'certified' | 'not_certified' | 'recertification_required';
interface Summary { required: number; passed: number; failed: number; incomplete: number; notTested: number }
export interface MedGasZone {
  id: string; name: string; zone_valve_tag: string; gases: Gas[]; department_name?: string | null; outletCount: number;
  summary: Summary; readyToCertify: boolean; certification: { status: CertStatus; by: string | null; at: string | null };
}
export interface RequirementItem { key: string; testType: string; gas: Gas | null; outletId: string | null; label: string; status: string; latest: { testedAt: string } | null }
interface ZoneDetail extends Omit<MedGasZone, 'outletCount'> {
  outlets: { id: string; label: string; gas: Gas; room_number: string | null }[];
  items: RequirementItem[];
  tests: { id: string; test_type: string; gas: string | null; overall: string; tested_at: string; recorded_by_name: string; verifier_credential: string; notes: string | null }[];
}

const CERT_LABEL: Record<CertStatus, string> = { certified: 'Certified', not_certified: 'Not certified', recertification_required: 'Recertification needed' };

export function MedGasZoneCard({ zone, catalog, onOpen }: { zone: MedGasZone; catalog: Catalog; onOpen: () => void }) {
  const s = zone.summary;
  return (
    <div className="card" aria-label={`Medical gas zone ${zone.name}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{zone.name}</h2>
        <span className={`chip ${zone.certification.status === 'certified' ? 'chip-pass' : 'chip-open'}`}>{CERT_LABEL[zone.certification.status]}</span>
      </div>
      <p className="muted">{zone.zone_valve_tag || 'No valve tag'} · {zone.gases.map((g) => catalog.gases[g]?.label ?? g).join(', ')} · {zone.outletCount} outlets</p>
      {s.failed > 0 && <p className="row"><LifeSafetyFlag /> <strong>{s.failed} failed test{s.failed > 1 ? 's' : ''}</strong></p>}
      <Progress value={s.required ? (s.passed / s.required) * 100 : 0} label={`${zone.name} verification`} />
      <p className="muted" style={{ fontSize: 13 }}>{s.passed} of {s.required} tests passed · {s.notTested} not tested{s.incomplete ? ` · ${s.incomplete} incomplete` : ''}</p>
      {zone.certification.by && <p className="muted" style={{ fontSize: 13 }}>Certified by {zone.certification.by}, {fmtDate(zone.certification.at)}</p>}
      <button onClick={onOpen}>Open zone</button>
    </div>
  );
}

/** What the result must meet, in words, shown above the entry fields. */
export function limitHint(def: TestDef, gas: GasSpec | null, catalog: Catalog): string {
  const l = catalog.pipingLimits;
  switch (def.key) {
    case 'standing_pressure': return `Hold at least ${l.minStandingHours} h with no loss from leaks.`;
    case 'cross_connection': return 'Test every outlet and inlet in the zone with only the test gas in the system.';
    case 'piping_particulate': return `No more than ${l.maxParticulateMgPerM3} mg/m³.`;
    case 'piping_purity': return `Dew point at most ${l.maxDewPointF} °F; hydrocarbons no more than ${l.maxHydrocarbonDeltaPpm} ppm above source.`;
    case 'outlet_flow':
      if (!gas) return '';
      return gas.kind === 'vacuum'
        ? `At least ${gas.minVacuumInHg} in. Hg at ${gas.testFlowSlpm} SLPM.`
        : `Static ${gas.pressurePsig!.min}–${gas.pressurePsig!.max} psig; drop no more than ${gas.maxFlowDropPsi} psi at ${gas.testFlowSlpm} SLPM.`;
    case 'concentration': {
      const c = gas?.concentration;
      if (!c) return '';
      return c.maxPct !== undefined ? `${c.analyte}: ${c.minPct}–${c.maxPct}%.` : `${c.analyte}: at least ${c.minPct}%.`;
    }
    default: return '';
  }
}

function fieldsFor(def: TestDef, gas: GasSpec | null) {
  return def.fields.filter((f) => {
    if (def.key === 'outlet_flow') return gas?.kind === 'vacuum' ? f.key === 'vacuumInHg' : f.key !== 'vacuumInHg';
    if (def.key === 'alarm_test' && f.key === 'highAlarm') return gas?.kind !== 'vacuum';
    return true;
  });
}

const CRED_KEY = 'omoshine.medgas.credential';
const readCred = () => { try { return localStorage.getItem(CRED_KEY) ?? ''; } catch { return ''; } };
const saveCred = (v: string) => { try { localStorage.setItem(CRED_KEY, v); } catch { /* storage unavailable */ } };

export function TestEntryForm({ item, catalog, onSubmit, onCancel }: {
  item: RequirementItem; catalog: Catalog;
  onSubmit: (body: { readings: Record<string, number | boolean>; verifierCredential: string; instrument?: string; notes?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const def = catalog.tests.find((t) => t.key === item.testType)!;
  const gas = item.gas ? catalog.gases[item.gas] ?? null : null;
  const fields = fieldsFor(def, gas);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [cred, setCred] = useState(readCred);
  const [instrument, setInstrument] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const complete = fields.every((f) => values[f.key] !== undefined && values[f.key] !== '') && cred.trim().length >= 3;
  return (
    <form className="card" aria-label={`Record ${item.label}`} onSubmit={async (e) => {
      e.preventDefault();
      setErr(null);
      const readings: Record<string, number | boolean> = {};
      for (const f of fields) readings[f.key] = f.type === 'number' ? Number(values[f.key]) : (values[f.key] as boolean);
      try {
        saveCred(cred.trim());
        await onSubmit({ readings, verifierCredential: cred.trim(), ...(instrument ? { instrument } : {}), ...(notes ? { notes } : {}) });
      } catch (x) { setErr((x as Error).message); }
    }}>
      <h2>{item.label}</h2>
      <p className="muted">{limitHint(def, gas, catalog)}</p>
      <div className="form-grid">
        {fields.map((f) => f.type === 'boolean' ? (
          <div key={f.key}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{f.label}</div>
            <div className="row" role="group" aria-label={f.label}>
              <button type="button" style={{ minWidth: 64, minHeight: 48 }} aria-pressed={values[f.key] === true} onClick={() => setValues({ ...values, [f.key]: true })}>Yes</button>
              <button type="button" style={{ minWidth: 64, minHeight: 48 }} aria-pressed={values[f.key] === false} onClick={() => setValues({ ...values, [f.key]: false })}>No</button>
            </div>
          </div>
        ) : (
          <label key={f.key}>{f.label}{f.unit ? ` (${f.unit})` : ''}
            <input inputMode="decimal" value={(values[f.key] as string) ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          </label>
        ))}
        <label>Verifier credential<input value={cred} onChange={(e) => setCred(e.target.value)} placeholder="ASSE 6030 number" /></label>
        <label>Instrument (optional)<input value={instrument} onChange={(e) => setInstrument(e.target.value)} /></label>
      </div>
      <label style={{ marginTop: 12 }}>Notes<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" type="submit" disabled={!complete}>Save result</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function RequirementTable({ items, canRecord, onRecord }: { items: RequirementItem[]; canRecord: boolean; onRecord: (i: RequirementItem) => void }) {
  const order: Record<string, number> = { fail: 0, incomplete: 1, not_tested: 2, pass: 3 };
  const sorted = [...items].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return (
    <table aria-label="Required tests">
      <thead><tr><th>Test</th><th>Result</th><th>Last tested</th>{canRecord && <th />}</tr></thead>
      <tbody>
        {sorted.map((i) => (
          <tr key={i.key}>
            <td>{i.label}</td>
            <td>{i.status === 'fail' ? <span className="row"><LifeSafetyFlag /><StatusChip status="fail" /></span> : <StatusChip status={i.status} />}</td>
            <td>{fmtDate(i.latest?.testedAt)}</td>
            {canRecord && <td><button onClick={() => onRecord(i)}>{i.status === 'not_tested' ? 'Record' : 'Retest'}</button></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ZoneDetailView({ id, catalog, onChanged }: { id: string; catalog: Catalog; onChanged: () => void }) {
  const detail = useApi<ZoneDetail>(`/medgas-zones/${id}`);
  const [recording, setRecording] = useState<RequirementItem | null>(null);
  const [outlet, setOutlet] = useState({ label: '', gas: '' });
  const [certifying, setCertifying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d = detail.data;
  const refresh = () => { detail.reload(); onChanged(); };
  return (
    <Loading error={detail.error}>
      {d && (
        <>
          <div className="card" id="medgas-zone-detail">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{d.name}</h2>
              <span className={`chip ${d.certification.status === 'certified' ? 'chip-pass' : 'chip-open'}`}>{CERT_LABEL[d.certification.status]}</span>
            </div>
            <p className="muted">{d.summary.passed} of {d.summary.required} tests passed. Certification needs every test to pass on its latest result; any new outlet or retest after certification requires the verifier to certify again.</p>
            {msg && <p role="status">{msg}</p>}
            {err && <p className="error" role="alert">{err}</p>}
            <div className="row">
              <button className="primary" disabled={!d.readyToCertify || d.certification.status === 'certified'} onClick={() => setCertifying(true)}>Certify zone (verifier)</button>
            </div>
          </div>
          {recording && (
            <TestEntryForm item={recording} catalog={catalog} onCancel={() => setRecording(null)} onSubmit={async (body) => {
              const r = await api<{ evaluation: { overall: string } }>(`/medgas-zones/${id}/tests`, {
                body: { testType: recording.testType, ...(recording.outletId ? { outletId: recording.outletId } : recording.gas ? { gas: recording.gas } : {}), ...body },
              });
              setMsg(r.evaluation.overall === 'fail' ? `${recording.label}: FAILED. A critical life safety issue was opened.` : `${recording.label}: ${r.evaluation.overall}.`);
              setRecording(null);
              refresh();
            }} />
          )}
          <div className="card">
            <h2>Outlets and inlets ({d.outlets.length})</h2>
            <form className="row" onSubmit={async (e) => {
              e.preventDefault();
              setErr(null);
              try {
                await api(`/medgas-zones/${id}/outlets`, { body: { outlets: [{ label: outlet.label, gas: outlet.gas }] } });
                setOutlet({ label: '', gas: outlet.gas });
                refresh();
              } catch (x) { setErr((x as Error).message); }
            }}>
              <input aria-label="Outlet label" placeholder="e.g. OR-04 O2-1" required value={outlet.label} onChange={(e) => setOutlet({ ...outlet, label: e.target.value })} style={{ width: 'auto', flex: 1, minWidth: 160 }} />
              <select aria-label="Outlet gas" required value={outlet.gas} onChange={(e) => setOutlet({ ...outlet, gas: e.target.value })} style={{ width: 'auto' }}>
                <option value="">Gas…</option>
                {d.gases.map((g) => <option key={g} value={g}>{catalog.gases[g]?.label ?? g}</option>)}
              </select>
              <button type="submit">Add outlet</button>
            </form>
            <p className="muted" style={{ fontSize: 13 }}>{d.outlets.map((o) => o.label).join(' · ') || 'No outlets yet.'}</p>
          </div>
          <div className="card" style={{ overflowX: 'auto' }}>
            <h2>Verification tests</h2>
            <RequirementTable items={d.items} canRecord onRecord={(i) => { setMsg(null); setRecording(i); }} />
          </div>
          {certifying && (
            <SignDialog
              onClose={() => setCertifying(false)}
              onSign={async (pin) => {
                const { reauthToken } = await api<{ reauthToken: string }>('/auth/reauth', { body: { pin } });
                await api(`/medgas-zones/${id}/certify`, { body: {}, headers: { 'x-reauth-token': reauthToken } });
                setCertifying(false);
                setMsg('Zone certified.');
                refresh();
              }}
            />
          )}
        </>
      )}
    </Loading>
  );
}

export function MedGasPage() {
  const { projectId } = useParams();
  const zones = useApi<MedGasZone[]>(`/projects/${projectId}/medgas-zones`);
  const catalog = useApi<Catalog>('/medgas/catalog');
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', zoneValveTag: '', gases: [] as string[] });
  const [err, setErr] = useState<string | null>(null);
  const cat = catalog.data;
  return (
    <>
      <h1>Medical gas verification</h1>
      {err && <p className="error" role="alert">{err}</p>}
      <Loading error={zones.error}>
        <div className="cards">
          {cat && zones.data?.map((z) => <MedGasZoneCard key={z.id} zone={z} catalog={cat} onOpen={() => { setOpen(z.id); setTimeout(() => document.getElementById('medgas-zone-detail')?.scrollIntoView({ behavior: 'smooth' }), 300); }} />)}
          {zones.data?.length === 0 && <p className="muted">No medical gas zones yet.</p>}
        </div>
      </Loading>
      {open && cat && <ZoneDetailView key={open} id={open} catalog={cat} onChanged={zones.reload} />}
      <h2>Add a zone</h2>
      {cat && (
        <form className="card form-grid" aria-label="Add a medical gas zone" style={{ alignItems: 'start' }} onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await api(`/projects/${projectId}/medgas-zones`, { body: form });
            setForm({ name: '', zoneValveTag: '', gases: [] });
            zones.reload();
          } catch (x) { setErr((x as Error).message); }
        }}>
          <label>Zone name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Zone valve box tag<input value={form.zoneValveTag} onChange={(e) => setForm({ ...form, zoneValveTag: e.target.value })} /></label>
          <fieldset style={{ border: 0, padding: 0, margin: 0, gridColumn: '1 / -1' }}>
            <legend style={{ fontWeight: 600 }}>Gases served</legend>
            <div className="row">
              {Object.entries(cat.gases).map(([k, g]) => (
                <label key={k} className="row" style={{ display: 'flex', fontWeight: 400 }}>
                  <input type="checkbox" style={{ minHeight: 0, width: 'auto' }} checked={form.gases.includes(k)}
                    onChange={(e) => setForm({ ...form, gases: e.target.checked ? [...form.gases, k] : form.gases.filter((x) => x !== k) })} />
                  {g.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div style={{ gridColumn: '1 / -1' }}><button className="primary" type="submit" disabled={!form.gases.length}>Add zone</button></div>
        </form>
      )}
    </>
  );
}
