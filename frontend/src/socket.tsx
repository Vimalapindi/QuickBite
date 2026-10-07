import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { tokenStore } from './api';
import { useAuth } from './auth';

const Ctx = createContext<Socket | null>(null);
export const useSocket = () => useContext(Ctx);

/** One authenticated Socket.IO connection for the whole app while logged in. */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!user) return;
    const s = io({ auth: { token: tokenStore.get() }, transports: ['websocket'] });
    setSocket(s);
    return () => { s.close(); setSocket(null); };
  }, [user?.id]);

  return <Ctx.Provider value={socket}>{children}</Ctx.Provider>;
}

/**
 * Subscribe to a socket event. Handlers are kept fresh via a ref-free effect dependency on `handler`
 * (callers wrap in useCallback or accept re-subscription; both are cheap).
 */
export function useSocketEvent<T>(event: string, handler: (payload: T) => void) {
  const socket = useSocket();
  useEffect(() => {
    if (!socket) return;
    socket.on(event, handler);
    return () => { socket.off(event, handler); };
  }, [socket, event, handler]);
}
