importScripts("utils/classifier.js", "utils/supabaseConfig.js", "utils/supabaseAuth.js");

const ALARM_NAME = "focusSessionExpiry";
const POST_LOAD_DELAY_MS = 5_000;

const SARCASTIC_REMARKS = [
  "Is this who you are now?",
  "You're better than this. Probably.",
  "Wow. Just... wow.",
  "That tab lasted longer than your focus.",
  "Bold of you to try that during a focus session.",
  "Future you is disappointed. Current you too.",
  "Closed. Try to contain your surprise.",
  "One does not simply doomscroll during focus mode.",
  "That's cute. Anyway, it's closed now.",
  "Your goals called. They're not happy.",
  "Nice try. The tab did not survive.",
  "Was it worth it? Be honest."
];

function pickSarcasticRemark() {
  return SARCASTIC_REMARKS[Math.floor(Math.random() * SARCASTIC_REMARKS.length)];
}

const DEFAULT_WHITELIST = [
  "google.com",
  "github.com",
  "stackoverflow.com",
  "developer.mozilla.org",
  "chrome.google.com",
  "chromewebstore.google.com",
  "localhost",
  "127.0.0.1"
];

// -----------------------------------------------------------------------
// Session state helpers
// -----------------------------------------------------------------------

async function getSession() {
  const { focusSession } = await chrome.storage.local.get("focusSession");
  return focusSession || null;
}

async function isFocusActive() {
  const session = await getSession();
  return !!session && Date.now() < session.endTime;
}

async function getWhitelist() {
  const { customWhitelist } = await chrome.storage.local.get("customWhitelist");
  const custom = Array.isArray(customWhitelist) ? customWhitelist : [];
  return [...DEFAULT_WHITELIST, ...custom];
}

async function getBlocklist() {
  const { customBlocklist } = await chrome.storage.local.get("customBlocklist");
  return Array.isArray(customBlocklist) ? customBlocklist : [];
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isHostInList(url, list) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return false;
  return list.some(
    (entry) => hostname === entry || hostname.endsWith(`.${entry}`)
  );
}

// -----------------------------------------------------------------------
// Session lifecycle
// -----------------------------------------------------------------------

async function startFocusSession(durationMinutes) {
  const existing = await getSession();
  if (existing && Date.now() < existing.endTime) {
    // Tamper prevention: an active session cannot be restarted/overwritten.
    return existing;
  }

  const startTime = Date.now();
  const endTime = startTime + durationMinutes * 60_000;
  const session = {
    startTime,
    endTime,
    durationMinutes,
    active: true,
    distractionCount: 0
  };

  await chrome.storage.local.set({ focusSession: session });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });

  logSessionStartRemote(startTime, durationMinutes);

  return session;
}

// Best-effort: if the user is signed in, create the matching row in
// Supabase for the dashboard. If they're not signed in (or offline, or
// Supabase isn't configured), this silently no-ops. The timer and tab
// classification work fully locally either way.
async function logSessionStartRemote(startTime, durationMinutes) {
  try {
    const remoteId = await self.BouncerAuth.createFocusSessionRecord(durationMinutes);
    if (!remoteId) return;
    const current = await getSession();
    if (current && current.startTime === startTime) {
      current.remoteId = remoteId;
      await chrome.storage.local.set({ focusSession: current });
    }
  } catch (err) {
    console.log("[Bouncer] not logging this session to Supabase:", err.message);
  }
}

async function endFocusSession() {
  const session = await getSession();
  if (session?.remoteId) {
    // Use actual elapsed time, not the originally planned duration —
    // sessions can now end early via the emergency override, and logging
    // the planned length in that case would overstate real focus time in
    // the dashboard stats. For a session that ran its full course this is
    // the same value anyway.
    const actualMinutes = Math.max(1, Math.round((Date.now() - session.startTime) / 60_000));
    self.BouncerAuth.updateFocusSessionRecord(session.remoteId, {
      ended_at: new Date().toISOString(),
      duration_minutes: actualMinutes,
      distraction_count: session.distractionCount || 0
    }).catch((err) => console.log("[Bouncer] could not finalize session in Supabase:", err.message));
  }

  await chrome.storage.local.set({
    focusSession: null
  });
  await chrome.alarms.clear(ALARM_NAME);
}

const EVAL_ALARM_PREFIX = "evalTab-";

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await endFocusSession();
    return;
  }

  if (alarm.name.startsWith(EVAL_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(EVAL_ALARM_PREFIX.length));
    evaluateTab(tabId).catch((err) =>
      console.warn("[FocusMode] evaluateTab failed:", err)
    );
  }
});

// Recreate the alarm on browser/service-worker restart if a session is
// mid-flight, in case the alarm itself didn't survive.
chrome.runtime.onStartup.addListener(async () => {
  const session = await getSession();
  if (session && Date.now() < session.endTime) {
    await chrome.alarms.create(ALARM_NAME, { when: session.endTime });
  } else if (session) {
    await endFocusSession();
  }
});

// -----------------------------------------------------------------------
// Messaging with the popup (with tamper prevention on stop requests)
// -----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "START_SESSION": {
        const session = await startFocusSession(message.durationMinutes);
        sendResponse({ ok: true, session });
        break;
      }
      case "GET_SESSION": {
        const session = await getSession();
        sendResponse({ ok: true, session });
        break;
      }
      case "STOP_SESSION": {
        // Tamper prevention: refuse to stop an active, un-expired session.
        const session = await getSession();
        if (session && Date.now() < session.endTime) {
          sendResponse({
            ok: false,
            error: "Focus session is locked until it expires."
          });
          break;
        }
        await endFocusSession();
        sendResponse({ ok: true });
        break;
      }
      case "EMERGENCY_OVERRIDE": {
        // Only reachable by winning the emergency-override mini-game (see
        // override/override.js), which is the deliberate friction that
        // replaces the normal tamper-prevention check here.
        await endFocusSession();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();
  return true; // keep the message channel open for the async response
});

// -----------------------------------------------------------------------
// Tab classification pipeline
// -----------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  console.log(
    `[FocusMode] tab ${tabId} finished loading ("${tab.title}"), scheduling check in ${POST_LOAD_DELAY_MS}ms`
  );

  // Use chrome.alarms instead of setTimeout: MV3 service workers can be
  // terminated after ~30s idle, which would silently cancel a pending
  // setTimeout before it ever fires. An alarm survives that and wakes the
  // service worker back up to run the check.
  chrome.alarms.create(`${EVAL_ALARM_PREFIX}${tabId}`, {
    when: Date.now() + POST_LOAD_DELAY_MS
  });
});

// A tab can complete-load more than once in quick succession (e.g. a
// YouTube SPA re-render), which schedules more than one eval alarm before
// the first one fires. Guard against evaluating the same tab twice at once.
const tabsCurrentlyEvaluating = new Set();

async function evaluateTab(tabId) {
  if (tabsCurrentlyEvaluating.has(tabId)) {
    console.log(`[FocusMode] tab ${tabId} is already being evaluated, skipping duplicate`);
    return;
  }
  tabsCurrentlyEvaluating.add(tabId);

  try {
    await evaluateTabInner(tabId);
  } finally {
    tabsCurrentlyEvaluating.delete(tabId);
  }
}

async function evaluateTabInner(tabId) {
  console.log(`[FocusMode] evaluateTab(${tabId}) firing`);

  // Re-check focus mode is still active after the delay.
  const active = await isFocusActive();
  console.log(`[FocusMode] focus session active? ${active}`);
  if (!active) return;

  // Re-check the tab still exists after the delay.
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    console.log(`[FocusMode] tab ${tabId} no longer exists, skipping`);
    return; // tab was closed/navigated away during the delay
  }

  console.log(`[FocusMode] evaluating tab ${tabId}: url="${tab.url}" title="${tab.title}"`);

  if (!tab.url || !tab.title) {
    console.log(`[FocusMode] tab ${tabId} missing url/title, skipping`);
    return;
  }
  if (self.FocusModeClassifier.isPlaceholderTitle(tab.title)) {
    console.log(`[FocusMode] tab ${tabId} has placeholder title, skipping`);
    return;
  }
  if (tab.url.startsWith(chrome.runtime.getURL(""))) {
    // Bouncer's own pages (dashboard, guest list, the emergency override
    // game, the sarcastic alert popup) must never be evaluated or closed —
    // hostnameFromUrl() alone doesn't catch these, since a chrome-extension://
    // URL parses to a valid "hostname" (the extension's own ID), not null.
    console.log(`[FocusMode] tab ${tabId} is one of Bouncer's own pages, skipping`);
    return;
  }
  if (!hostnameFromUrl(tab.url)) {
    // chrome://, file://, etc. are never touched.
    console.log(`[FocusMode] tab ${tabId} has no scriptable hostname, skipping`);
    return;
  }

  // "Never block" always wins, even over the user's own block list.
  const whitelist = await getWhitelist();
  if (isHostInList(tab.url, whitelist)) {
    console.log(`[FocusMode] tab ${tabId} is whitelisted, skipping`);
    return;
  }

  // User's explicit block list closes the tab immediately, no
  // classification needed.
  const blocklist = await getBlocklist();
  if (isHostInList(tab.url, blocklist)) {
    console.log(`[FocusMode] tab ${tabId} matches the block list, closing`);
    await closeDistractionTab(tabId, tab);
    return;
  }

  const isDistraction = await self.FocusModeClassifier.classifyTitle(
    tab.title
  );
  console.log(`[FocusMode] tab ${tabId} classified as ${isDistraction ? "DISTRACTION" : "WORK"}`);

  if (isDistraction) {
    await closeDistractionTab(tabId, tab);
  }
}

async function closeDistractionTab(tabId, tab) {
  try {
    await chrome.tabs.remove(tabId);
    console.log(`[FocusMode] closed tab ${tabId}`);
    await recordDistraction(hostnameFromUrl(tab.url), tab.title);
    notifyTabClosed(tab.title);
  } catch (err) {
    // Benign race: the tab was already closed (by the user, or by an
    // earlier evaluation of the same tab) between our tabs.get() check
    // above and this remove() call, so there's nothing left to do.
    console.log(`[FocusMode] tab ${tabId} was already gone by the time we tried to close it:`, err.message);
  }
}

async function notifyTabClosed(closedTabTitle) {
  const remark = pickSarcasticRemark();
  const shown = await showTopPopupAlert(remark, closedTabTitle);
  if (!shown) {
    showOsNotification(remark, closedTabTitle);
  }
}

// Opens a small floating extension window near the top of the current
// Chrome window with the sarcastic remark + an OK button. Unlike injecting
// into the page DOM, this doesn't depend on what tab happens to be active
// (which is often an unscriptable chrome://newtab page right after closing
// a tab), so it's a real top-level browser window that always works.
async function showTopPopupAlert(remark, closedTabTitle) {
  try {
    const popupWidth = 360;
    const popupHeight = 210;

    let top = 80;
    let left = 400;
    try {
      const parentWindow = await chrome.windows.getLastFocused({
        windowTypes: ["normal"]
      });
      if (parentWindow?.left != null && parentWindow?.width != null) {
        top = parentWindow.top + 70;
        left = Math.round(parentWindow.left + (parentWindow.width - popupWidth) / 2);
      }
    } catch {
      // fall through with default position
    }

    const url =
      chrome.runtime.getURL("popup/alert.html") +
      `?remark=${encodeURIComponent(remark)}&title=${encodeURIComponent(closedTabTitle)}`;

    const popupWindow = await chrome.windows.create({
      url,
      type: "popup",
      width: popupWidth,
      height: popupHeight,
      top,
      left,
      focused: true
    });

    chrome.windows.update(popupWindow.id, { drawAttention: true });
    console.log(`[FocusMode] top popup alert shown (window ${popupWindow.id})`);
    return true;
  } catch (err) {
    console.log("[FocusMode] could not open popup alert window, falling back to OS notification:", err.message);
    return false;
  }
}

function showOsNotification(remark, closedTabTitle) {
  chrome.notifications.create(
    "",
    {
      type: "basic",
      iconUrl: "icons/cats/3_cat.png",
      title: remark,
      message: `Closed: "${closedTabTitle}"`,
      priority: 1
    },
    (notificationId) => {
      if (chrome.runtime.lastError) {
        console.log(
          "[FocusMode] notification failed:",
          chrome.runtime.lastError.message
        );
      } else {
        console.log(`[FocusMode] notification shown: ${notificationId}`);
      }
    }
  );
}

async function recordDistraction(domain, tabTitle) {
  const session = await getSession();
  if (!session) return;
  session.distractionCount = (session.distractionCount || 0) + 1;
  await chrome.storage.local.set({ focusSession: session });
  console.log(`[FocusMode] distractionCount is now ${session.distractionCount}`);

  if (session.remoteId) {
    self.BouncerAuth.updateFocusSessionRecord(session.remoteId, {
      distraction_count: session.distractionCount
    }).catch((err) => console.log("[Bouncer] could not sync distraction count to Supabase:", err.message));

    if (domain) {
      self.BouncerAuth.logDistractionEvent(session.remoteId, domain, tabTitle)
        .catch((err) => console.log("[Bouncer] could not log distraction site to Supabase:", err.message));
    }
  }
}
