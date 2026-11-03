import { useCallback, useEffect, useState } from 'react';
import { api, getToken } from './api';
import { allQueued, discard, isOffline, onQueueChange, replay, userIdOf, type QueuedEntry } from './offline';

/** Shows when the device is offline and what is waiting to be sent; sends it when the connection returns. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(isOffline());
  const [mine, setMine] = useState<QueuedEntry[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const me = userIdOf(getToken());
    setMine((await allQueued()).filter((e) => e.userId === me));
  }, []);
  const sync = useCallback(async () => {
    if (isOffline()) return;
    const r = await replay((path, body) => api(path, { body }).then(() => undefined), getToken());
    if (r.sent || r.failed) setNote(`${r.sent} offline entr${r.sent === 1 ? 'y' : 'ies'} sent${r.failed ? `, ${r.failed} refused` : ''}.`);
  }, []);
  useEffect(() => {
    const on = () => { setOffline(false); sync(); };
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const unsub = onQueueChange(refresh);
    refresh().then(sync);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); unsub(); };
  }, [refresh, sync]);

  const failed = mine.filter((e) => e.lastError);
  if (!offline && mine.length === 0 && !note) return null;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      {offline && <strong>Offline. </strong>}
      {offline && 'Fire watch patrols, ICRA logs and life safety inspections are saved on this device; signing needs a connection. '}
      {mine.length > 0 && <span>{mine.length} entr{mine.length === 1 ? 'y' : 'ies'} waiting to send. </span>}
      {!offline && mine.length > failed.length && <button onClick={sync}>Send now</button>}
      {note && !offline && <span> {note} <button onClick={() => setNote(null)}>Dismiss</button></span>}
      {failed.length > 0 && (
        <ul>
          {failed.map((e) => (
            <li key={e.id}>{e.label} recorded {new Date(e.queuedAt).toLocaleString()} was refused: {e.lastError} <button onClick={() => discard(e.id)}>Discard</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
