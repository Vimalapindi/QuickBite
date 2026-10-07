import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, money } from '../api';
import { ErrorBox, StatusPill } from '../components';
import { useSocketEvent } from '../socket';

interface Delivery { id: string; status: string; order: { id: string; status: string; totalCents: number; restaurant: { name: string; address: string; lat: number; lng: number }; address: { line1: string; city: string; lat: number; lng: number } } }
interface Profile { isAvailable: boolean; currentLat: number | null; currentLng: number | null }

export default function Partner() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [active, setActive] = useState<Delivery[]>([]);
  const [done, setDone] = useState<Delivery[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const pos = useRef({ lat: 17.4, lng: 78.45 });

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([api<{ profile: Profile; deliveries: Delivery[] }>('/delivery/me?scope=active'), api<{ deliveries: Delivery[] }>('/delivery/me?scope=completed')]);
      setProfile(a.profile); setActive(a.deliveries); setDone(c.deliveries);
      if (a.profile.currentLat !== null) pos.current = { lat: a.profile.currentLat, lng: a.profile.currentLng! };
    } catch (e) { setError(errMsg(e)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useSocketEvent('delivery:assigned', load);
  useSocketEvent('order:status', load);

  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(null); await load(); } catch (e) { setError(errMsg(e)); } };
  const ping = () => api('/delivery/me/location', { method: 'PUT', body: pos.current });

  // Demo "drive": nudges the partner's coordinates every 2s. Customers watching the order see these live.
  useEffect(() => {
    if (!driving) return;
    const t = setInterval(() => { pos.current = { lat: pos.current.lat + 0.0006, lng: pos.current.lng + 0.0004 }; ping().catch(() => undefined); }, 2000);
    return () => clearInterval(t);
  }, [driving]);

  if (!profile) return <div className="empty">{error ?? 'Loading…'}</div>;
  return (
    <>
      <div className="hero"><h1>Deliveries</h1></div>
      <ErrorBox error={error} />
      <div className="card row between">
        <div><strong>{profile.isAvailable ? 'You are online' : 'You are offline'}</strong><div className="small muted">Online partners near a restaurant are assigned new orders automatically.</div></div>
        <div className="row">
          <button className="ghost" onClick={() => run(ping)}>Send my location</button>
          <button className={driving ? 'danger' : 'ghost'} onClick={() => setDriving((d) => !d)}>{driving ? 'Stop demo drive' : 'Simulate driving'}</button>
          <button onClick={() => run(async () => { await ping(); await api('/delivery/me/availability', { method: 'PATCH', body: { isAvailable: !profile.isAvailable } }); })}>{profile.isAvailable ? 'Go offline' : 'Go online'}</button>
        </div>
      </div>
      <h2 style={{ marginTop: '1.5rem' }}>Active</h2>
      {active.length === 0 && <div className="empty">No active delivery. Stay online to receive one.</div>}
      {active.map((d) => (
        <div className="card" key={d.id} style={{ marginBottom: '1rem' }}>
          <div className="row between"><h3>{d.order.restaurant.name}</h3><StatusPill status={d.order.status} /></div>
          <div className="small">Pick up: {d.order.restaurant.address}</div><div className="small">Drop off: {d.order.address.line1}, {d.order.address.city}</div>
          <div className="row" style={{ marginTop: '.7rem' }}>
            <button disabled={d.order.status !== 'READY_FOR_PICKUP'} onClick={() => run(() => api(`/orders/${d.order.id}/status`, { body: { status: 'PICKED_UP' } }))}>Picked up</button>
            <button disabled={d.order.status !== 'PICKED_UP'} onClick={() => { setDriving(false); run(() => api(`/orders/${d.order.id}/status`, { body: { status: 'DELIVERED' } })); }}>Delivered</button>
            <Link to={`/orders/${d.order.id}`}>Details</Link>
            {d.order.status !== 'READY_FOR_PICKUP' && d.order.status !== 'PICKED_UP' && <span className="small muted">Waiting for the kitchen…</span>}
          </div>
        </div>
      ))}
      <h2 style={{ marginTop: '1.5rem' }}>Completed</h2>
      {done.length === 0 ? <div className="muted small">Nothing delivered yet.</div> : <div className="card"><table><tbody>{done.map((d) => <tr key={d.id}><td>{d.order.restaurant.name}</td><td>{money(d.order.totalCents)}</td></tr>)}</tbody></table></div>}
    </>
  );
}
