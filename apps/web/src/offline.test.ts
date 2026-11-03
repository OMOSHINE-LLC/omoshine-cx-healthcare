import { api, isQueued, setToken } from './api';
import { allQueued, discard, replay } from './offline';

const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.s`;
const ASSESSMENT = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const setOnline = (v: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v });

describe('offline field entries', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    for (const e of await allQueued()) await discard(e.id);
    fetchMock = vi.fn(async () => new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    setToken(jwt('user-a'));
  });
  afterEach(() => { vi.unstubAllGlobals(); setOnline(true); });

  it('queues allowed entries while offline, stamped with when they were recorded', async () => {
    setOnline(false);
    const r = await api(`/ilsm-assessments/${ASSESSMENT}/fire-watch`, { body: { area: 'Level 2 riser', allClear: true, findings: '' } });
    expect(isQueued(r)).toBe(true);
    const r2 = await api(`/ls-items/${ITEM}/inspections`, { body: { answers: { latches: true } } });
    expect(isQueued(r2)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const q = await allQueued();
    expect(q).toHaveLength(2);
    expect(q[0]).toMatchObject({ userId: 'user-a', label: 'Fire watch patrol' });
    expect(q[0]!.body.patrolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(q[1]!.body.performedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('never queues signatures or other writes', async () => {
    setOnline(false);
    await api(`/ls-items/${ITEM}/inspections`, { body: {}, headers: { 'x-reauth-token': 't' } }).catch(() => {});
    await api('/projects/x/issues', { body: { title: 'x' } }).catch(() => {});
    expect(await allQueued()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('replays only the recording person\'s entries, keeping refusals for review', async () => {
    setOnline(false);
    await api(`/ilsm-assessments/${ASSESSMENT}/fire-watch`, { body: { area: 'A', allClear: true } });
    setToken(jwt('user-b'));
    await api(`/ilsm-assessments/${ASSESSMENT}/fire-watch`, { body: { area: 'B', allClear: true } });
    setToken(jwt('user-a'));
    setOnline(true);
    const sent: unknown[] = [];
    const r = await replay(async (path, body) => { sent.push(body); }, jwt('user-a'));
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([expect.objectContaining({ area: 'A' })]);
    const left = await allQueued();
    expect(left.map((e) => e.userId)).toEqual(['user-b']);
    const r2 = await replay(async () => { throw new Error('Assessment is resolved'); }, jwt('user-b'));
    expect(r2).toEqual({ sent: 0, failed: 1 });
    expect((await allQueued())[0]!.lastError).toBe('Assessment is resolved');
  });
});
