// Minimal Supabase Auth + REST client built on plain fetch(). Manifest V3
// disallows bundling remotely-hosted code, so instead of pulling in the
// full @supabase/supabase-js SDK, this talks directly to Supabase's Auth
// (GoTrue) and REST (PostgREST) HTTP APIs, which is all the SDK does under
// the hood anyway.
//
// Loaded both as a classic background script (importScripts, where `self`
// is the service worker global) and as a plain <script> tag in the popup
// and dashboard pages (where `self` === `window`), so it always attaches
// to `self`.

function isConfigured(cfg) {
  return !!(cfg && cfg.url && cfg.anonKey && !cfg.url.includes("YOUR_PROJECT_REF"));
}

function getConfig() {
  const cfg = self.SUPABASE_CONFIG;
  if (!isConfigured(cfg)) {
    throw new Error("Supabase isn't configured yet (see utils/supabaseConfig.js).");
  }
  return cfg;
}

async function authFetch(path, options = {}) {
  const cfg = getConfig();
  const res = await fetch(`${cfg.url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.anonKey,
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error_description || data?.msg || data?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

async function storeSession(data) {
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  await chrome.storage.local.set({
    supabaseSession: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      user: { id: data.user?.id, email: data.user?.email }
    }
  });
}

async function getStoredSession() {
  const { supabaseSession } = await chrome.storage.local.get("supabaseSession");
  return supabaseSession || null;
}

async function signUp(email, password) {
  const data = await authFetch("/auth/v1/signup", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  if (data.access_token) {
    await storeSession(data);
    return { needsEmailConfirmation: false, user: data.user };
  }
  // Project has "Confirm email" turned on: no session yet until they click
  // the link in their inbox.
  return { needsEmailConfirmation: true, user: data.user || data };
}

async function signIn(email, password) {
  const data = await authFetch("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  await storeSession(data);
  return data.user;
}

async function signOut() {
  const session = await getStoredSession();
  if (session?.access_token) {
    try {
      await authFetch("/auth/v1/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
    } catch {
      // Best effort. Clear local session regardless.
    }
  }
  await chrome.storage.local.remove("supabaseSession");
}

async function ensureFreshSession() {
  const session = await getStoredSession();
  if (!session) return null;
  if (Date.now() < session.expires_at - 30_000) return session;

  try {
    const data = await authFetch("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    await storeSession(data);
    return await getStoredSession();
  } catch (err) {
    console.warn("[Bouncer] Supabase session refresh failed, signing out:", err.message);
    await chrome.storage.local.remove("supabaseSession");
    return null;
  }
}

async function restFetch(path, options = {}) {
  const cfg = getConfig();
  const session = await ensureFreshSession();
  if (!session) throw new Error("Not signed in.");

  const res = await fetch(`${cfg.url}/rest/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.anonKey,
      Authorization: `Bearer ${session.access_token}`,
      ...(options.headers || {})
    }
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

async function createFocusSessionRecord(durationMinutes) {
  const rows = await restFetch("/focus_sessions", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ duration_minutes: durationMinutes })
  });
  return rows?.[0]?.id || null;
}

async function updateFocusSessionRecord(remoteId, patch) {
  if (!remoteId) return;
  await restFetch(`/focus_sessions?id=eq.${remoteId}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

async function listFocusSessions() {
  return restFetch("/focus_sessions?select=*&order=started_at.desc");
}

async function logDistractionEvent(sessionId, domain, tabTitle) {
  await restFetch("/distraction_events", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, domain, tab_title: tabTitle || null })
  });
}

async function listDistractionEvents() {
  return restFetch("/distraction_events?select=domain&order=closed_at.desc&limit=2000");
}

// Preferences like the daily distraction goal are stored in the user's own
// Supabase Auth metadata rather than a separate table, so this doesn't
// require any extra SQL setup beyond the focus_sessions table.
async function getUser() {
  const cfg = getConfig();
  const session = await ensureFreshSession();
  if (!session) throw new Error("Not signed in.");

  const res = await fetch(`${cfg.url}/auth/v1/user`, {
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${session.access_token}`
    }
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.msg || data?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

async function updateUserMetadata(patch) {
  const cfg = getConfig();
  const session = await ensureFreshSession();
  if (!session) throw new Error("Not signed in.");

  const res = await fetch(`${cfg.url}/auth/v1/user`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.anonKey,
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ data: patch })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.msg || data?.message || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

self.BouncerAuth = {
  isConfigured: () => isConfigured(self.SUPABASE_CONFIG),
  signUp,
  signIn,
  signOut,
  getStoredSession,
  ensureFreshSession,
  createFocusSessionRecord,
  updateFocusSessionRecord,
  listFocusSessions,
  logDistractionEvent,
  listDistractionEvents,
  getUser,
  updateUserMetadata
};
