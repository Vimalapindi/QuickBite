import type { ReactElement } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { NotificationBell } from './components';
import Admin from './pages/Admin';
import CartPage from './pages/Cart';
import Login from './pages/Login';
import Orders from './pages/Orders';
import Owner from './pages/Owner';
import Partner from './pages/Partner';
import RestaurantPage from './pages/RestaurantPage';
import Restaurants from './pages/Restaurants';
import Tracking from './pages/Tracking';
import type { Role } from './types';

function Guard({ roles, children }: { roles?: Role[]; children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="shell empty">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function Home() {
  const { user } = useAuth();
  if (user?.role === 'RESTAURANT_OWNER') return <Navigate to="/owner" replace />;
  if (user?.role === 'DELIVERY_PARTNER') return <Navigate to="/partner" replace />;
  if (user?.role === 'ADMIN') return <Navigate to="/admin" replace />;
  return <Restaurants />;
}

export default function App() {
  const { user, logout } = useAuth();
  return (
    <>
      <header className="topbar">
        <div className="shell">
          <Link to="/" className="brand">Quick<b>Bite</b></Link>
          <nav className="nav">
            {(!user || user.role === 'CUSTOMER') && <NavLink to="/">Restaurants</NavLink>}
            {user?.role === 'CUSTOMER' && <><NavLink to="/cart">Cart</NavLink><NavLink to="/orders">My orders</NavLink></>}
            {user?.role === 'RESTAURANT_OWNER' && <NavLink to="/owner">Kitchen</NavLink>}
            {user?.role === 'DELIVERY_PARTNER' && <NavLink to="/partner">Deliveries</NavLink>}
            {user?.role === 'ADMIN' && <NavLink to="/admin">Admin</NavLink>}
          </nav>
          <div className="who">
            {user ? (<><NotificationBell /><span>{user.name}</span><button className="ghost small" onClick={logout}>Log out</button></>) : <Link to="/login" className="btn">Log in</Link>}
          </div>
        </div>
      </header>
      <main className="shell">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/restaurants/:id" element={<RestaurantPage />} />
          <Route path="/cart" element={<Guard roles={['CUSTOMER']}><CartPage /></Guard>} />
          <Route path="/orders" element={<Guard roles={['CUSTOMER']}><Orders /></Guard>} />
          <Route path="/orders/:id" element={<Guard><Tracking /></Guard>} />
          <Route path="/owner" element={<Guard roles={['RESTAURANT_OWNER']}><Owner /></Guard>} />
          <Route path="/partner" element={<Guard roles={['DELIVERY_PARTNER']}><Partner /></Guard>} />
          <Route path="/admin" element={<Guard roles={['ADMIN']}><Admin /></Guard>} />
          <Route path="*" element={<div className="empty">Page not found. <Link to="/">Go home</Link></div>} />
        </Routes>
      </main>
    </>
  );
}
