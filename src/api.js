// The server's JSON API, for the game and the dashboard. Never throws: a dead server gives
// { ok: false, status: 0 }. Training results that could not be sent (no server, not signed in)
// wait in localStorage and go up the next time flushQueue() runs.
export async function api(path, { method = 'GET', body } = {}) {
  try {
    const r = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try {
      data = await r.json();
    } catch (e) {
      // no body
    }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null };
  }
}

const KEY = 'cuas:pending';

export function pending() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch (e) {
    return [];
  }
}

export function queueSession(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...pending(), session].slice(-20)));
  } catch (e) {
    // storage full or blocked: the result is lost, but it was also shown in the review
  }
}

// Send what is waiting. Returns how many went up.
export async function flushQueue() {
  const q = pending();
  if (!q.length) return 0;
  const left = [];
  let sent = 0;
  for (const session of q) {
    const r = await api('/api/sessions', { method: 'POST', body: { session } });
    if (r.ok || r.status === 400) sent += r.ok ? 1 : 0; // a result the server rejects as invalid is dropped
    else left.push(session);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(left));
  } catch (e) {
    // nothing to do
  }
  return sent;
}
