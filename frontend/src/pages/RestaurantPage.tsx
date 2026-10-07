import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, errMsg, money } from '../api';
import { useAuth } from '../auth';
import { ErrorBox } from '../components';
import type { Cart, RestaurantDetail } from '../types';

export default function RestaurantPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const [r, setR] = useState<RestaurantDetail | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<{ restaurant: RestaurantDetail }>(`/restaurants/${id}`).then((x) => setR(x.restaurant)).catch((e) => setError(errMsg(e))); }, [id]);
  useEffect(() => { if (user?.role === 'CUSTOMER') api<Cart>('/cart').then(setCart).catch(() => undefined); }, [user]);

  const qtyOf = (itemId: string) => cart?.items.find((i) => i.menuItemId === itemId)?.quantity ?? 0;

  const setQty = useCallback(async (menuItemId: string, quantity: number, replaceCart = false) => {
    if (!user) return nav('/login');
    try {
      setCart(await api<Cart>('/cart/items', { method: 'PUT', body: { menuItemId, quantity, replaceCart } }));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_RESTAURANT_MISMATCH') {
        if (confirm('Your cart has items from another restaurant. Start a new cart here?')) return setQty(menuItemId, quantity, true);
      } else setError(errMsg(e));
    }
  }, [user, nav]);

  if (!r) return <div className="empty">{error ?? 'Loading…'}</div>;
  const uncategorised = r.items.filter((i) => !i.categoryId);
  const sections = [...r.categories.map((c) => ({ name: c.name, items: r.items.filter((i) => i.categoryId === c.id) })), { name: 'More', items: uncategorised }].filter((s) => s.items.length);
  const isCustomer = user?.role === 'CUSTOMER' || !user;
  const inCart = cart?.restaurant?.id === r.id ? cart.items.reduce((n, i) => n + i.quantity, 0) : 0;

  return (
    <>
      <div className="hero">
        <Link to="/" className="small">← All restaurants</Link>
        <h1>{r.name}</h1>
        <p className="muted">{r.cuisine} · {r.address} · Delivery {money(r.deliveryFeeCents)}{!r.isOpen && ' · Closed right now'}</p>
      </div>
      <ErrorBox error={error} />
      {sections.map((s) => (
        <div className="card" key={s.name} style={{ marginBottom: '1rem' }}>
          <h2>{s.name}</h2>
          {s.items.map((i) => {
            const q = qtyOf(i.id);
            const orderable = r.isOpen && i.isAvailable && !i.soldOut;
            return (
              <div className="menu-row" key={i.id}>
                <div className="grow"><strong>{i.name}</strong>{i.description && <div className="small muted">{i.description}</div>}</div>
                <div>{money(i.priceCents)}</div>
                {isCustomer && (!orderable ? <span className="pill bad">{i.soldOut ? 'Sold out' : 'Unavailable'}</span> : q === 0 ? <button onClick={() => setQty(i.id, 1)}>Add</button> : (
                  <div className="qty"><button className="ghost" aria-label={`Remove one ${i.name}`} onClick={() => setQty(i.id, q - 1)}>−</button><span>{q}</span><button className="ghost" aria-label={`Add one ${i.name}`} onClick={() => setQty(i.id, q + 1)}>+</button></div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
      {inCart > 0 && <div className="row between card" style={{ position: 'sticky', bottom: '1rem', background: 'var(--plum)', color: '#fff' }}><span>{inCart} item{inCart > 1 ? 's' : ''} · {money(cart!.subtotalCents)}</span><Link to="/cart" className="btn" style={{ textDecoration: 'none' }}>Review cart</Link></div>}
    </>
  );
}
