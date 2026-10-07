import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errMsg, money } from '../api';
import { ErrorBox } from '../components';
import type { RestaurantSummary } from '../types';

interface SearchResult { restaurants: RestaurantSummary[]; items: { id: string; name: string; priceCents: number; restaurantId: string; restaurantName: string }[] }

export default function Restaurants() {
  const [q, setQ] = useState('');
  const [city, setCity] = useState('');
  const [list, setList] = useState<RestaurantSummary[] | null>(null);
  const [dishes, setDishes] = useState<SearchResult['items']>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [q, city]);

  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ page: String(page), limit: '12' });
      if (city) params.set('city', city);
      if (q.trim().length >= 2) params.set('q', q.trim());
      api<{ data: RestaurantSummary[]; meta: { totalPages: number } }>(`/restaurants?${params}`)
        .then((r) => { setList(r.data); setTotalPages(r.meta.totalPages); setError(null); })
        .catch((e) => setError(errMsg(e)));
      if (q.trim().length >= 2) api<SearchResult>(`/search?q=${encodeURIComponent(q.trim())}${city ? `&city=${encodeURIComponent(city)}` : ''}`).then((r) => setDishes(r.items)).catch(() => setDishes([]));
      else setDishes([]);
    }, 250); // debounce keystrokes so we don't hammer the API
    return () => clearTimeout(t);
  }, [q, city, page]);

  return (
    <>
      <div className="hero">
        <h1>What are you craving?</h1>
        <p className="muted">Search restaurants or dishes. Your order is tracked live from the kitchen to your door.</p>
        <div className="row">
          <input className="grow" placeholder="Search biryani, pizza, a restaurant…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <input style={{ maxWidth: 200 }} placeholder="City (optional)" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City" />
        </div>
      </div>
      <ErrorBox error={error} />
      {dishes.length > 0 && (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h3>Matching dishes</h3>
          {dishes.slice(0, 6).map((d) => (
            <div className="menu-row" key={d.id}>
              <div className="grow"><strong>{d.name}</strong><div className="small muted">{d.restaurantName}</div></div>
              <span>{money(d.priceCents)}</span>
              <Link to={`/restaurants/${d.restaurantId}`}>View menu</Link>
            </div>
          ))}
        </div>
      )}
      {list === null ? <div className="empty">Loading…</div> : list.length === 0 ? <div className="empty">No restaurants match. Try a different search.</div> : (
        <div className="grid">
          {list.map((r) => (
            <Link key={r.id} to={`/restaurants/${r.id}`} className="card link">
              <div className="row between"><h3>{r.name}</h3><span className={`pill ${r.isOpen ? 'ok' : 'bad'}`}>{r.isOpen ? 'Open' : 'Closed'}</span></div>
              <div className="muted small">{r.cuisine} · {r.city}</div>
              <p className="small" style={{ margin: '.5rem 0 0' }}>{r.description ?? 'Fresh and fast.'}</p>
              <div className="small muted" style={{ marginTop: '.5rem' }}>Delivery {money(r.deliveryFeeCents)}</div>
            </Link>
          ))}
        </div>
      )}
      {totalPages > 1 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: '1.25rem' }}>
          <button className="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted">Page {page} of {totalPages}</span>
          <button className="ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </>
  );
}
