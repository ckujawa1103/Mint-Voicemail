// Client for the Worker API.
//
// The session token lives in localStorage and travels as a bearer header.
// Cookies would be cleaner, but the app (github.io) and API (workers.dev) are
// cross-site, and Safari blocks third-party cookies outright — which would
// break sign-in on iPhone. The tradeoff is XSS exposure, mitigated by the
// strict CSP in index.html and having zero third-party scripts.

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
const TOKEN_KEY = 'mv_session';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // Session died or was revoked elsewhere — drop it so the UI shows sign-in.
  if (res.status === 401 && auth && token) {
    setToken(null);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status);
  return data;
}

export const api = {
  /* auth */
  status: () => request('/auth/status'),
  registerOptions: (payload) => request('/auth/register/options', { method: 'POST', body: payload }),
  registerVerify: (payload) => request('/auth/register/verify', { method: 'POST', body: payload }),
  loginOptions: () => request('/auth/login/options', { method: 'POST', body: {}, auth: false }),
  loginVerify: (payload) => request('/auth/login/verify', { method: 'POST', body: payload, auth: false }),
  magicRequest: (email) => request('/auth/magic/request', { method: 'POST', body: { email }, auth: false }),
  magicVerify: (token) => request('/auth/magic/verify', { method: 'POST', body: { token }, auth: false }),
  recoveryUse: (code) => request('/auth/recovery/use', { method: 'POST', body: { code }, auth: false }),
  recoveryStatus: () => request('/auth/recovery/status'),
  recoveryRegenerate: () => request('/auth/recovery/regenerate', { method: 'POST', body: {} }),
  logout: () => request('/auth/logout', { method: 'POST', body: {} }),
  sessions: () => request('/auth/sessions'),
  revokeSessions: () => request('/auth/sessions', { method: 'DELETE' }),
  credentials: () => request('/auth/credentials'),
  removeCredential: (id) => request('/auth/credentials', { method: 'DELETE', body: { id } }),
  auditLog: () => request('/auth/audit'),

  /* voicemails */
  list: (filter = 'inbox', q = '', callerId = null) => {
    const params = new URLSearchParams({ filter });
    if (q) params.set('q', q);
    if (callerId) params.set('callerId', callerId);
    return request(`/api/voicemails?${params}`);
  },
  get: (id) => request(`/api/voicemails/${id}`),
  update: (id, patch) => request(`/api/voicemails/${id}`, { method: 'PATCH', body: patch }),
  remove: (id, permanent = false) =>
    request(`/api/voicemails/${id}${permanent ? '?permanent=1' : ''}`, { method: 'DELETE' }),
  restore: (id) => request(`/api/voicemails/${id}/restore`, { method: 'POST', body: {} }),
  emptyTrash: () => request('/api/trash', { method: 'DELETE' }),
  bulk: (action, ids) =>
    request('/api/voicemails/bulk', { method: 'POST', body: { action, ids: [...ids] } }),
  retranscribe: (id) => request(`/api/voicemails/${id}/retranscribe`, { method: 'POST', body: {} }),
  stats: () => request('/api/stats'),

  /* caller groups */
  callers: () => request('/api/callers'),
  updateCaller: (id, patch) => request(`/api/callers/${id}`, { method: 'PATCH', body: patch }),
  mergeCaller: (id, into) => request(`/api/callers/${id}/merge`, { method: 'POST', body: { into } }),
  deleteCaller: (id) => request(`/api/callers/${id}`, { method: 'DELETE' }),
  identifyPending: (batch = 5) =>
    request('/api/callers/identify-pending', { method: 'POST', body: { batch } }),


  /* push */
  pushKey: () => request('/api/push/key'),
  pushSubscribe: (sub) => request('/api/push/subscribe', { method: 'POST', body: sub }),
  pushUnsubscribe: (endpoint) => request('/api/push/unsubscribe', { method: 'POST', body: { endpoint } }),
};
