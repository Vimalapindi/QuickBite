import { useCallback, useEffect, useState } from 'react';
import { api, errMsg, money } from '../api';
import { ErrorBox, StatusPill } from '../components';
import { useSocketEvent } from '../socket';

interface Stats { users: Record<string, number>; restaurants: number; ordersByStatus: Record<string, number>; deliveredOrders: number; deliveredRevenueCents: number; availablePartners: number; pendingOutboxEvents: number }
interface AdminOrder { id: string; status: string; totalCents: number; placedAt: string; restaurant: { name: string }; customer: { name: string } }
interface AdminUser { id: string; email: string; name: string; role: string; isActive: boolean }

export default function Admin() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Stats>('/admin/stats').then(setStats).catch((e) => setError(errMsg(e)));
    api<{ data: AdminOrder[] }>('/admin/orders?limit=15').then((r) => setOrders(r.data)).catch(() => undefined);
    api<{ data: AdminUser[] }>('/admin/users?limit=20').then((r) => setUsers(r.data)).catch(() => undefined);
  }, []);
  useEffect(() => { load(); }, [load]);
  useSocketEvent('order:status', load); // the admin room receives every order event

  async function toggle(u: AdminUser) { try { await api(`/admin/users/${u.id}/active`, { method: 'PATCH', body: { isActive: !u.isActive } }); load(); } catch (e) { setError(errMsg(e)); } }
  const total = stats ? Object.values(stats.ordersByStatus).reduce((a, b) => a + b, 0) : 0;

  return (
    <>
      <div className="hero"><h1>Admin dashboard</h1><p className="muted small">Stats are cached for 10 seconds on the server.</p></div>
      <ErrorBox error={error} />
      {stats && (
        <div className="grid">
          <div className="card"><div className="stat">{total}</div><div className="muted">orders</div></div>
          <div className="card"><div className="stat">{money(stats.deliveredRevenueCents)}</div><div className="muted">delivered revenue ({stats.deliveredOrders} orders)</div></div>
          <div className="card"><div className="stat">{stats.restaurants}</div><div className="muted">restaurants</div></div>
          <div className="card"><div className="stat">{stats.availablePartners}</div><div className="muted">partners online</div></div>
          <div className="card"><div className="stat">{stats.pendingOutboxEvents}</div><div className="muted">events waiting in outbox</div></div>
        </div>
      )}
      <div className="grid" style={{ marginTop: '1.25rem', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        <div className="card" style={{ overflowX: 'auto' }}>
          <h3>Recent orders</h3>
          <table><tbody>{orders.map((o) => <tr key={o.id}><td>#{o.id.slice(0, 6)}</td><td>{o.restaurant.name}</td><td>{money(o.totalCents)}</td><td><StatusPill status={o.status} /></td></tr>)}</tbody></table>
        </div>
        <div className="card" style={{ overflowX: 'auto' }}>
          <h3>Users</h3>
          <table><tbody>{users.map((u) => <tr key={u.id}><td>{u.name}<div className="small muted">{u.email}</div></td><td><span className="pill">{u.role.replace('_', ' ').toLowerCase()}</span></td><td>{u.role !== 'ADMIN' && <button className="ghost small" onClick={() => toggle(u)}>{u.isActive ? 'Disable' : 'Enable'}</button>}</td></tr>)}</tbody></table>
        </div>
      </div>
    </>
  );
}
