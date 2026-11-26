const TOKEN_STORAGE_KEY = 'outreach_desk_token';

let onUnauthorizedHandler: (() => void) | null = null;

export function setOnUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorizedHandler = handler;
}

export function getStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Ignore storage quota errors
  }
}

export function clearStoredToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  data?: Record<string, unknown> | null;

  constructor(
    message: string,
    status: number,
    code = 'API_ERROR',
    retryAfterSeconds?: number,
    data?: Record<string, unknown> | null
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.data = data;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  requiresAuth = true
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (requiresAuth) {
    const token = getStoredToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });

  let data: Record<string, unknown> | null = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && requiresAuth) {
      clearStoredToken();
      onUnauthorizedHandler?.();
    }
    const message =
      (typeof data?.error === 'string' && data.error) ||
      `Request failed with status ${response.status}`;
    const code = (typeof data?.code === 'string' && data.code) || 'API_ERROR';
    const retryAfterSeconds =
      typeof data?.retryAfterSeconds === 'number' ? data.retryAfterSeconds : undefined;
    throw new ApiError(message, response.status, code, retryAfterSeconds, data);
  }

  return data as T;
}
