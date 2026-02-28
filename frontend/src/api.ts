const CLIENT_ID_KEY = 'hipaa-agent:clientId';

export function getClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing && /^[a-zA-Z0-9_-]{6,128}$/.test(existing)) return existing;
    const created = (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`)
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64);
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    // Non-fatal fallback (no localStorage).
    return 'default';
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('x-hipaa-client-id', getClientId());
  return fetch(input, { ...init, headers });
}

