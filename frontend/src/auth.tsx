import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore } from './api';
import type { User } from './types';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<User>;
  register(input: { email: string; password: string; name: string; role: string }): Promise<User>;
  logout(): void;
}
const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!tokenStore.get());

  useEffect(() => {
    if (!tokenStore.get()) return;
    api<{ user: User }>('/auth/me').then((r) => setUser(r.user)).catch(() => tokenStore.clear()).finally(() => setLoading(false));
  }, []);

  const finish = useCallback((r: { user: User; token: string }) => { tokenStore.set(r.token); setUser(r.user); return r.user; }, []);
  const login = useCallback((email: string, password: string) => api<{ user: User; token: string }>('/auth/login', { body: { email, password } }).then(finish), [finish]);
  const register = useCallback((input: Parameters<AuthCtx['register']>[0]) => api<{ user: User; token: string }>('/auth/register', { body: input }).then(finish), [finish]);
  const logout = useCallback(() => { tokenStore.clear(); setUser(null); }, []);

  return <Ctx.Provider value={{ user, loading, login, register, logout }}>{children}</Ctx.Provider>;
}
