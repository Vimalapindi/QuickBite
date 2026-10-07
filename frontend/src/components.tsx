import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { useSocketEvent } from './socket';
import type { Notification, OrderStatus } from './types';

export const ErrorBox = ({ error }: { error: string | null }) => (error ? <div className="error" role="alert">{error}</div> : null);

export function StatusPill({ status }: { status: string }) {
  const bad = ['CANCELLED', 'REJECTED', 'PAYMENT_FAILED'].includes(status);
  const ok = status === 'DELIVERED';
  return <span className={`pill ${bad ? 'bad' : ok ? 'ok' : ''}`}>{status.replace(/_/g, ' ').toLowerCase()}</span>;
}

export const FLOW: { status: OrderStatus; label: string }[] = [
  { status: 'PLACED', label: 'Placed' },
  { status: 'PAID', label: 'Paid' },
  { status: 'CONFIRMED', label: 'Confirmed' },
  { status: 'PREPARING', label: 'Preparing' },
  { status: 'READY_FOR_PICKUP', label: 'Ready' },
  { status: 'PICKED_UP', label: 'On the way' },
  { status: 'DELIVERED', label: 'Delivered' },
];

/** The route line: the courier emoji slides along it as the status advances. */
export function Tracker({ status }: { status: OrderStatus }) {
  const idx = FLOW.findIndex((s) => s.status === status);
  const terminalBad = idx === -1;
  const pct = terminalBad ? 0 : (idx / (FLOW.length - 1)) * 100;
  const finished = status === 'DELIVERED';
  return (
    <div className="track" aria-label={`Order status: ${status}`}>
      <div className="track-line">
        <div className="track-fill" style={{ width: `${pct}%` }} />
      </div>
      {!terminalBad && <div className="courier" style={{ left: `calc(100% / 14 + (100% - 100% / 7) * ${pct / 100})` }} aria-hidden>{idx >= 5 ? (finished ? '🏠' : '🛵') : '🥡'}</div>}
      <div className="track-stops">
        {FLOW.map((s, i) => (
          <div key={s.status} className={`stop ${i < idx || finished ? 'done' : ''} ${i === idx && !finished ? 'current' : ''}`}>
            <div className="dot" />
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Toast({ children }: { children: ReactNode }) {
  return <div className="toast" role="status">{children}</div>;
}

/** Bell with an unread badge; new notifications arrive over the socket in real time. */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<Notification | null>(null);

  const load = useCallback(() => {
    api<{ data: Notification[]; unreadCount: number }>('/notifications?limit=15').then((r) => { setItems(r.data); setUnread(r.unreadCount); }).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const onNew = useCallback((n: Notification) => {
    setItems((cur) => (cur.some((x) => x.id === n.id) ? cur : [n, ...cur].slice(0, 15)));
    setUnread((u) => u + 1);
    setToast(n);
    setTimeout(() => setToast((t) => (t?.id === n.id ? null : t)), 4500);
  }, []);
  useSocketEvent<Notification>('notification:new', onNew);

  const markAll = async () => { await api('/notifications/read-all', { method: 'POST', body: {} }); load(); };

  return (
    <div className="bell">
      <button className="ghost small" aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen((o) => !o)}>🔔{unread > 0 && <span className="count">{unread}</span>}</button>
      {open && (
        <div className="dropdown">
          <div className="row between item"><strong>Notifications</strong><button className="small ghost" onClick={markAll}>Mark all read</button></div>
          {items.length === 0 && <div className="empty">Nothing yet. Order updates will appear here.</div>}
          {items.map((n) => (
            <div key={n.id} className={`item ${n.readAt ? '' : 'unread'}`}><strong>{n.title}</strong><div className="muted">{n.body}</div></div>
          ))}
        </div>
      )}
      {toast && <Toast><strong>{toast.title}</strong><div className="small">{toast.body}</div></Toast>}
    </div>
  );
}
