import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, money } from '../api';
import { ErrorBox, StatusPill } from '../components';
import { useSocketEvent } from '../socket';
import type { Order } from '../types';

export default function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { api<{ data: Order[] }>('/orders?limit=30').then((r) => setOrders(r.data)).catch((e) => setError(errMsg(e))); }, []);
  useEffect(load, [load]);
  useSocketEvent('order:status', load); // any status change refreshes the list

  return (
    <>
      <div className="hero"><h1>My orders</h1></div>
      <ErrorBox error={error} />
      {orders === null ? <div className="empty">Loading…</div> : orders.length === 0 ? <div className="empty">No orders yet. <Link to="/">Order something</Link></div> : (
        <div className="stack">
          {orders.map((o) => (
            <Link key={o.id} to={`/orders/${o.id}`} className="card link">
              <div className="row between"><h3>{o.restaurant.name}</h3><StatusPill status={o.status} /></div>
              <div className="small muted">{new Date(o.placedAt).toLocaleString()} · {o.items.reduce((n, i) => n + i.quantity, 0)} items · {money(o.totalCents)}</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
