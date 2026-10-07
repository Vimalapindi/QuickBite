import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { errMsg } from '../api';
import { useAuth } from '../auth';
import { ErrorBox } from '../components';

export default function Login() {
  const { user, login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'CUSTOMER' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (mode === 'login') await login(form.email, form.password);
      else await register(form);
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  return (
    <div className="hero" style={{ maxWidth: 440 }}>
      <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
      <form className="card" onSubmit={submit}>
        {mode === 'register' && <label>Name<input value={form.name} onChange={set('name')} required autoComplete="name" /></label>}
        <label>Email<input type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></label>
        <label>Password<input type="password" value={form.password} onChange={set('password')} required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {mode === 'register' && (
          <label>I am a
            <select value={form.role} onChange={set('role')}>
              <option value="CUSTOMER">Customer</option>
              <option value="RESTAURANT_OWNER">Restaurant owner</option>
              <option value="DELIVERY_PARTNER">Delivery partner</option>
            </select>
          </label>
        )}
        <ErrorBox error={error} />
        <button disabled={busy} style={{ width: '100%' }}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {mode === 'login' ? 'New here? ' : 'Already registered? '}
          <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>{mode === 'login' ? 'Create an account' : 'Log in'}</a>
        </p>
      </form>
      <p className="small muted">Demo accounts after seeding: customer1@quickbite.dev, owner1@quickbite.dev, partner1@quickbite.dev (password Password123!) and admin@quickbite.dev (Admin12345!).</p>
    </div>
  );
}
