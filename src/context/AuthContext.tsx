import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  apiFetch,
  clearStoredToken,
  getStoredToken,
  setOnUnauthorizedHandler,
  setStoredToken,
} from '../lib/api';
import type { AuthStatusResponse, LoginResponse, SessionResponse } from '../types/outreach';

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  authStatus: AuthStatusResponse | null;
  statusError: string | null;
  login: (accessCode: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const checkAuth = useCallback(async () => {
    setIsLoading(true);
    setStatusError(null);

    try {
      const status = await apiFetch<AuthStatusResponse>('/api/auth/status', {}, false);
      setAuthStatus(status);

      const token = getStoredToken();
      if (!token) {
        setIsAuthenticated(false);
        return;
      }

      try {
        const session = await apiFetch<SessionResponse>('/api/auth/session', {}, true);
        setIsAuthenticated(Boolean(session.authenticated));
      } catch {
        clearStoredToken();
        setIsAuthenticated(false);
      }
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Unable to reach the Outreach Desk server.';
      setStatusError(message);
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setOnUnauthorizedHandler(() => {
      setIsAuthenticated(false);
    });
    void checkAuth();
    return () => setOnUnauthorizedHandler(null);
  }, [checkAuth]);

  const login = useCallback(async (accessCode: string) => {
    const result = await apiFetch<LoginResponse>(
      '/api/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ accessCode }),
      },
      false
    );
    setStoredToken(result.token);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' }, false);
    } catch {
      // Clear local session regardless
    }
    clearStoredToken();
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isLoading,
        authStatus,
        statusError,
        login,
        logout,
        refreshStatus: checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
