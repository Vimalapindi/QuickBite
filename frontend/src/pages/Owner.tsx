import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, money } from '../api';
import { ErrorBox, StatusPill } from '../components';
import { useSocketEvent } from '../socket';
import type { Category, Order, OrderStatus } from '../types';

interface Resto { id: string; name: string; isOpen: boolean; city: string }
interface ManagedItem { id: string; name: string; priceCents: number; stock: number | null; isAvailable: boolean; categoryId: string | null }

export default function Owner() {
  const [restos, setRestos] = useState<Resto[]>([]);
  const [sel, setSel] = useState<string>('');
  const [tab, setTab] = useState<'orders' | 'menu'>('orders');
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', cuisine: '', city: 'Hyderabad', address: '' });

  const loadRestos = useCallback(() => api<{ restaurants: Resto[] }>('/restaurants/mine').then((r) => { setRestos(r.restaurants); setSel((s) => s || r.restaurants[0]?.id || ''); }).catch((e) => setError(errMsg(e))), []);
  useEffect(() => { loadRestos(); }, [loadRestos]);

  async function create() {
    try { await api('/restaurants', { body: { ...form, lat: 17.4, lng: 78.45 } }); setForm({ ...form, name: '', cuisine: '', address: '' }); setError(null); loadRestos(); } catch (e) { setError(errMsg(e)); }
  }
  async function toggleOpen(r: Resto) { try { await api(`/restaurants/${r.id}`, { method: 'PATCH', body: { isOpen: !r.isOpen } }); loadRestos(); } catch (e) { setError(errMsg(e)); } }

  const current = restos.find((r) => r.id === sel);
  return (
    <>
      <div className="hero"><h1>Kitchen</h1></div>
      <ErrorBox error={error} />
      {restos.length === 0 && (
        <div className="card"><h3>Create your first restaurant</h3>
          <div className="row"><input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><input placeholder="Cuisine" value={form.cuisine} onChange={(e) => setForm({ ...form, cuisine: e.target.value })} /><input placeholder="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /><input placeholder="Address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /><button onClick={create} disabled={!form.name || !form.cuisine || !form.address}>Create</button></div></div>
      )}
      {current && (
        <>
          <div className="row between" style={{ marginBottom: '1rem' }}>
            <div className="row">
              {restos.length > 1 && <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ width: 'auto' }}>{restos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}
              {restos.length === 1 && <h2 style={{ margin: 0 }}>{current.name}</h2>}
              <span className={`pill ${current.isOpen ? 'ok' : 'bad'}`}>{current.isOpen ? 'Open' : 'Closed'}</span>
              <button className="ghost small" onClick={() => toggleOpen(current)}>{current.isOpen ? 'Close restaurant' : 'Open restaurant'}</button>
            </div>
            <div className="row"><button className={tab === 'orders' ? '' : 'ghost'} onClick={() => setTab('orders')}>Orders</button><button className={tab === 'menu' ? '' : 'ghost'} onClick={() => setTab('menu')}>Menu</button></div>
          </div>
          {tab === 'orders' ? <OrdersTab restaurantId={current.id} /> : <MenuTab restaurantId={current.id} />}
        </>
      )}
    </>
  );
}

function OrdersTab({ restaurantId }: { restaurantId: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ data: Order[] }>(`/orders/restaurant/${restaurantId}?limit=30${filter ? `&status=${filter}` : ''}`).then((r) => setOrders(r.data)).catch((e) => setError(errMsg(e))), [restaurantId, filter]);
  useEffect(() => { load(); }, [load]);
  useSocketEvent('order:status', load); // new orders and status changes appear instantly

  async function act(id: string, status: OrderStatus) { try { await api(`/orders/${id}/status`, { body: { status } }); setError(null); load(); } catch (e) { setError(errMsg(e)); } }
  return (
    <div className="stack">
      <ErrorBox error={error} />
      <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 240 }} aria-label="Filter by status">
        <option value="">All statuses</option>{['PAID', 'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ').toLowerCase()}</option>)}
      </select>
      {orders.length === 0 && <div className="empty">No orders yet. New paid orders show up here instantly.</div>}
      {orders.map((o) => (
        <div className="card" key={o.id}>
          <div className="row between"><h3><Link to={`/orders/${o.id}`}>#{o.id.slice(0, 8)}</Link></h3><StatusPill status={o.status} /></div>
          <div className="small muted">{new Date(o.placedAt).toLocaleTimeString()} · {money(o.totalCents)}</div>
          <div className="small">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</div>
          {!!o.nextStatuses?.length && <div className="row" style={{ marginTop: '.6rem' }}>{o.nextStatuses.map((s) => <button key={s} className={s === 'REJECTED' ? 'danger small' : 'small'} onClick={() => act(o.id, s)}>{s === 'REJECTED' ? 'Reject' : s === 'CONFIRMED' ? 'Accept' : `Mark ${s.replace(/_/g, ' ').toLowerCase()}`}</button>)}</div>}
        </div>
      ))}
    </div>
  );
}

function MenuTab({ restaurantId }: { restaurantId: string }) {
  const [items, setItems] = useState<ManagedItem[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', price: '', stock: '', categoryId: '' });
  const [catName, setCatName] = useState('');
  const load = useCallback(() => api<{ items: ManagedItem[]; categories: Category[] }>(`/restaurants/${restaurantId}/menu/manage`).then((r) => { setItems(r.items); setCats(r.categories); }).catch((e) => setError(errMsg(e))), [restaurantId]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(null); load(); } catch (e) { setError(errMsg(e)); } };
  const addItem = () => run(async () => { await api(`/restaurants/${restaurantId}/items`, { body: { name: f.name, priceCents: Math.round(Number(f.price) * 100), stock: f.stock === '' ? null : Number(f.stock), categoryId: f.categoryId || undefined } }); setF({ name: '', price: '', stock: '', categoryId: '' }); });
  const addCat = () => run(async () => { await api(`/restaurants/${restaurantId}/categories`, { body: { name: catName } }); setCatName(''); });

  return (
    <div className="stack">
      <ErrorBox error={error} />
      <div className="card">
        <h3>Add a dish</h3>
        <div className="row">
          <input className="grow" placeholder="Dish name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input style={{ maxWidth: 110 }} placeholder="Price ₹" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
          <input style={{ maxWidth: 140 }} placeholder="Stock (blank = ∞)" inputMode="numeric" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value })} />
          <select style={{ maxWidth: 160 }} value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} aria-label="Category"><option value="">No category</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <button onClick={addItem} disabled={!f.name || !f.price}>Add dish</button>
        </div>
        <div className="row" style={{ marginTop: '.75rem' }}><input style={{ maxWidth: 240 }} placeholder="New category" value={catName} onChange={(e) => setCatName(e.target.value)} /><button className="ghost" onClick={addCat} disabled={!catName}>Add category</button></div>
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Dish</th><th>Price</th><th>Stock</th><th>Status</th><th /></tr></thead>
          <tbody>{items.map((i) => (
            <tr key={i.id}>
              <td>{i.name}</td><td>{money(i.priceCents)}</td>
              <td>{i.stock === null ? '∞' : <span className="row" style={{ gap: '.3rem' }}>{i.stock}<button className="ghost small" onClick={() => run(() => api(`/menu-items/${i.id}`, { method: 'PATCH', body: { stock: i.stock! + 10 } }))}>+10</button></span>}</td>
              <td><span className={`pill ${i.isAvailable ? 'ok' : 'bad'}`}>{i.isAvailable ? 'available' : 'hidden'}</span></td>
              <td><button className="ghost small" onClick={() => run(() => api(`/menu-items/${i.id}`, { method: 'PATCH', body: { isAvailable: !i.isAvailable } }))}>{i.isAvailable ? 'Hide' : 'Show'}</button>{' '}<button className="ghost small" onClick={() => confirm(`Delete ${i.name}?`) && run(() => api(`/menu-items/${i.id}`, { method: 'DELETE' }))}>Delete</button></td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}
