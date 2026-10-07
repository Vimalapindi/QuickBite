import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errMsg, money } from '../api';
import { ErrorBox, StatusPill, Tracker } from '../components';
import { useSocket, useSocketEvent } from '../socket';
import type { Order, OrderStatus } from '../types';

interface View { order: Order; viewerRole: string; nextStatuses: OrderStatus[] }
interface Track { history: { from: string | null; to: string; at: string }[]; delivery: { status: string; partner: { name: string; phone: string | null; lat: number | null; lng: number | null } } | null }

export default function Tracking() {
  const { id } = useParams();
  const socket = useSocket();
  const [view, setView] = useState<View | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  const lastSeq = useRef(0);

  const load = useCallback(() => {
    api<View>(`/orders/${id}`).then(setView).catch((e) => setError(errMsg(e)));
    api<Track>(`/orders/${id}/tracking`).then(setTrack).catch(() => undefined);
  }, [id]);
  useEffect(load, [load]);

  // Join this order's private room (server verifies we're a participant).
  useEffect(() => {
    if (!socket || !id) return;
    const join = () => socket.emit('order:subscribe', id, (r: { ok: boolean }) => setLive(r.ok));
    if (socket.connected) join();
    socket.on('connect', join);
    return () => { socket.off('connect', join); socket.emit('order:unsubscribe', id); setLive(false); };
  }, [socket, id]);

  // Events can arrive out of order (concurrent consumers), so each carries a monotonic `seq`: stale ones are ignored.
  // The server is the source of truth: we re-fetch rather than trusting the payload alone.
  const onStatus = useCallback((e: { orderId: string; seq?: number }) => {
    if (e.orderId !== id) return;
    if (e.seq !== undefined) { if (e.seq <= lastSeq.current) return; lastSeq.current = e.seq; }
    load();
  }, [id, load]);
  useSocketEvent('order:status', onStatus);
  useSocketEvent('delivery:assigned', onStatus);
  useSocketEvent<{ orderId: string; lat: number; lng: number }>('delivery:location', useCallback((e) => { if (e.orderId === id) setLoc({ lat: e.lat, lng: e.lng }); }, [id]));

  async function act(status: OrderStatus) {
    try { await api(`/orders/${id}/status`, { body: { status } }); setError(null); load(); } catch (e) { setError(errMsg(e)); }
  }

  if (!view) return <div className="empty">{error ?? 'Loading…'}</div>;
  const o = view.order;
  const bad = ['CANCELLED', 'REJECTED', 'PAYMENT_FAILED'].includes(o.status);

  return (
    <>
      <div className="hero">
        <Link to={view.viewerRole === 'CUSTOMER' ? '/orders' : '/'} className="small">← Back</Link>
        <div className="row between"><h1>{o.restaurant.name}</h1><StatusPill status={o.status} /></div>
        <p className="muted small">Order {o.id.slice(0, 8)} · {live ? '🟢 live updates on' : '⚪ connecting…'}</p>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        {bad ? <div className="notice">This order was {o.status.replace('_', ' ').toLowerCase()}.{o.payment?.status === 'REFUNDED' && ' Your payment has been refunded.'}{o.payment?.failureReason && ` (${o.payment.failureReason})`}</div> : <Tracker status={o.status} />}
        {track?.delivery && <p className="small">🛵 {track.delivery.partner.name} is your delivery partner{loc ? ` · live location ${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}` : ''}</p>}
        {view.nextStatuses.length > 0 && (
          <div className="row" style={{ marginTop: '.75rem' }}>
            {view.nextStatuses.map((s) => <button key={s} className={['CANCELLED', 'REJECTED'].includes(s) ? 'danger' : ''} onClick={() => act(s)}>{s === 'CANCELLED' ? 'Cancel order' : `Mark ${s.replace(/_/g, ' ').toLowerCase()}`}</button>)}
          </div>
        )}
      </div>
      <div className="grid" style={{ marginTop: '1rem' }}>
        <div className="card">
          <h3>Items</h3>
          {o.items.map((i) => <div className="row between small" key={i.menuItemId}><span>{i.quantity} × {i.name}</span><span>{money(i.priceCents * i.quantity)}</span></div>)}
          <hr />
          <div className="row between small"><span>Delivery</span><span>{money(o.deliveryFeeCents)}</span></div>
          <div className="row between"><strong>Total</strong><strong>{money(o.totalCents)}</strong></div>
          <div className="small muted">Payment: {o.payment?.status.toLowerCase()}</div>
        </div>
        <div className="card">
          <h3>History</h3>
          <ul className="timeline">{track?.history.map((h, i) => <li key={i}><time>{new Date(h.at).toLocaleTimeString()}</time><span>{h.to.replace(/_/g, ' ').toLowerCase()}</span></li>)}</ul>
        </div>
      </div>
    </>
  );
}
