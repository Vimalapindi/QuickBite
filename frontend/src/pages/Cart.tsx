import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, errMsg, money } from '../api';
import { ErrorBox } from '../components';
import type { Address, Cart, Order } from '../types';

export default function CartPage() {
  const nav = useNavigate();
  const [cart, setCart] = useState<Cart | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [sim, setSim] = useState<'SUCCESS' | 'FAIL'>('SUCCESS');
  const [newAddr, setNewAddr] = useState({ line1: '', city: 'Hyderabad', pincode: '', lat: '17.43', lng: '78.41' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One Idempotency-Key per checkout ATTEMPT. A double-click or network retry re-sends the SAME key,
  // so the server returns the original order instead of creating a duplicate. A new key is minted only after success.
  const idemKey = useRef(crypto.randomUUID());

  const load = () => {
    api<Cart>('/cart').then(setCart).catch((e) => setError(errMsg(e)));
    api<{ addresses: Address[] }>('/users/me/addresses').then((r) => { setAddresses(r.addresses); setAddressId((cur) => cur || r.addresses[0]?.id || ''); });
  };
  useEffect(load, []);

  async function setQty(menuItemId: string, quantity: number) {
    try { setCart(await api<Cart>('/cart/items', { method: 'PUT', body: { menuItemId, quantity } })); setError(null); } catch (e) { setError(errMsg(e)); }
  }
  async function addAddress() {
    try {
      const { address } = await api<{ address: Address }>('/users/me/addresses', { body: { line1: newAddr.line1, city: newAddr.city, pincode: newAddr.pincode, lat: Number(newAddr.lat), lng: Number(newAddr.lng) } });
      setAddresses((a) => [address, ...a]); setAddressId(address.id); setNewAddr({ ...newAddr, line1: '', pincode: '' }); setError(null);
    } catch (e) { setError(errMsg(e)); }
  }
  async function placeOrder() {
    setBusy(true); setError(null);
    try {
      const { order } = await api<{ order: Order }>('/orders', { body: { addressId, paymentSimulation: sim }, headers: { 'Idempotency-Key': idemKey.current } });
      idemKey.current = crypto.randomUUID();
      nav(`/orders/${order.id}`);
    } catch (e) { setError(errMsg(e)); load(); } finally { setBusy(false); }
  }

  if (!cart) return <div className="empty">Loading…</div>;
  if (cart.items.length === 0) return <div className="empty"><h2>Your cart is empty</h2><Link to="/">Find something delicious</Link></div>;

  return (
    <>
      <div className="hero"><h1>Your order from {cart.restaurant?.name}</h1></div>
      <ErrorBox error={error} />
      <div className="card">
        {cart.items.map((i) => (
          <div className="menu-row" key={i.menuItemId}>
            <div className="grow"><strong>{i.name}</strong>{!i.isAvailable && <div className="small" style={{ color: 'var(--chili)' }}>No longer available in this quantity</div>}</div>
            <div className="qty"><button className="ghost" onClick={() => setQty(i.menuItemId, i.quantity - 1)} aria-label={`Remove one ${i.name}`}>−</button><span>{i.quantity}</span><button className="ghost" onClick={() => setQty(i.menuItemId, i.quantity + 1)} aria-label={`Add one ${i.name}`}>+</button></div>
            <div style={{ minWidth: 70, textAlign: 'right' }}>{money(i.lineTotalCents)}</div>
          </div>
        ))}
        <hr />
        <div className="totals"><span>Subtotal</span><span>{money(cart.subtotalCents)}</span><span>Delivery</span><span>{money(cart.deliveryFeeCents)}</span><span className="grand">Total</span><span className="grand">{money(cart.totalCents)}</span></div>
      </div>
      <div className="card" style={{ marginTop: '1rem' }}>
        <h3>Deliver to</h3>
        {addresses.length > 0 && <select value={addressId} onChange={(e) => setAddressId(e.target.value)} aria-label="Delivery address">{addresses.map((a) => <option key={a.id} value={a.id}>{a.line1}, {a.city} {a.pincode}</option>)}</select>}
        <details style={{ marginTop: '.75rem' }} open={addresses.length === 0}>
          <summary>Add a new address</summary>
          <div className="row" style={{ marginTop: '.6rem' }}>
            <input className="grow" placeholder="Street address" value={newAddr.line1} onChange={(e) => setNewAddr({ ...newAddr, line1: e.target.value })} />
            <input style={{ maxWidth: 130 }} placeholder="City" value={newAddr.city} onChange={(e) => setNewAddr({ ...newAddr, city: e.target.value })} />
            <input style={{ maxWidth: 110 }} placeholder="Pincode" value={newAddr.pincode} onChange={(e) => setNewAddr({ ...newAddr, pincode: e.target.value })} />
            <button className="ghost" onClick={addAddress} disabled={!newAddr.line1 || !newAddr.pincode}>Save address</button>
          </div>
        </details>
      </div>
      <div className="card" style={{ marginTop: '1rem' }}>
        <h3>Payment (simulated)</h3>
        <select value={sim} onChange={(e) => setSim(e.target.value as 'SUCCESS' | 'FAIL')} aria-label="Payment simulation">
          <option value="SUCCESS">Payment succeeds</option>
          <option value="FAIL">Payment is declined (to see the failure + refund flow)</option>
        </select>
        <p className="small muted">No real money moves. A background worker processes this payment asynchronously after your order is placed.</p>
        <button disabled={busy || !addressId} onClick={placeOrder} style={{ width: '100%' }}>{busy ? 'Placing order…' : `Place order · ${money(cart.totalCents)}`}</button>
      </div>
    </>
  );
}
