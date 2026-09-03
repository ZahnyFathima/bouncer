// -----------------------------------------------------------------------
// Start a session (mirrors popup.js, since the dashboard is a full tab and
// can talk to the background service worker the same way the popup does)
// -----------------------------------------------------------------------

const dashSetupView = document.getElementById("dashSetupView");
const dashLockedView = document.getElementById("dashLockedView");
const dashCustomDuration = document.getElementById("dashCustomDuration");
const dashStartBtn = document.getElementById("dashStartBtn");
const dashCountdown = document.getElementById("dashCountdown");
const dashCatImage = document.getElementById("dashCatImage");
const dashCatCaption = document.getElementById("dashCatCaption");

// Same mood progression as the popup's in-session cat: every 3 closed
// distraction tabs, the cat advances to the next, madder stage.
const SESSION_CAT_STAGES = [
  { src: "../icons/cats/1_cat.png", caption: "" },
  { src: "../icons/cats/2_cat.png", caption: "getting annoyed..." },
  { src: "../icons/cats/3_cat.png", caption: "pretty mad now." },
  { src: "../icons/cats/4_cat.png", caption: "furious." },
  { src: "../icons/cats/5_cat.png", caption: "the cat has had enough." }
];
const SESSION_DISTRACTIONS_PER_STAGE = 3;

let sessionTickInterval = null;

function sendBackgroundMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatRemainingTime(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stopSessionTicking() {
  if (sessionTickInterval) {
    clearInterval(sessionTickInterval);
    sessionTickInterval = null;
  }
}

function updateSessionCatMood(distractionCount) {
  const stageIndex = Math.floor((distractionCount || 0) / SESSION_DISTRACTIONS_PER_STAGE);
  if (stageIndex >= SESSION_CAT_STAGES.length) {
    dashCatImage.style.visibility = "hidden";
    dashCatCaption.textContent = "the cat left. it's just you now.";
    return;
  }
  const stage = SESSION_CAT_STAGES[stageIndex];
  dashCatImage.style.visibility = "visible";
  dashCatImage.src = stage.src;
  dashCatCaption.textContent = stage.caption;
}

async function refreshSessionCard() {
  const { session } = (await sendBackgroundMessage({ type: "GET_SESSION" })) || {};

  stopSessionTicking();

  if (session && Date.now() < session.endTime) {
    dashSetupView.classList.add("hidden");
    dashLockedView.classList.add("visible");
    updateSessionCatMood(session.distractionCount);
    const tick = () => {
      const remaining = session.endTime - Date.now();
      if (remaining <= 0) {
        stopSessionTicking();
        refreshSessionCard();
        return;
      }
      dashCountdown.textContent = formatRemainingTime(remaining);
    };
    tick();
    sessionTickInterval = setInterval(tick, 1000);
  } else if (session) {
    // Expired but not yet cleared by the background alarm.
    await sendBackgroundMessage({ type: "STOP_SESSION" });
    dashSetupView.classList.remove("hidden");
    dashLockedView.classList.remove("visible");
  } else {
    dashSetupView.classList.remove("hidden");
    dashLockedView.classList.remove("visible");
  }
}

function getDashDurationMinutes() {
  const value = Math.floor(Number(dashCustomDuration.value));
  if (!Number.isFinite(value) || value < 1 || value > 1440) return null;
  return value;
}

dashStartBtn.addEventListener("click", async () => {
  const durationMinutes = getDashDurationMinutes();
  if (durationMinutes === null) {
    dashCustomDuration.focus();
    dashCustomDuration.reportValidity?.();
    return;
  }
  dashStartBtn.disabled = true;
  try {
    await sendBackgroundMessage({ type: "START_SESSION", durationMinutes });
  } finally {
    dashStartBtn.disabled = false;
  }
  refreshSessionCard();
});

// Live-update the cat's mood the instant a distracting tab gets closed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.focusSession) return;
  const newSession = changes.focusSession.newValue;
  if (newSession && Date.now() < newSession.endTime) {
    updateSessionCatMood(newSession.distractionCount);
  } else {
    refreshSessionCard();
  }
});

refreshSessionCard();

// -----------------------------------------------------------------------
// Guest list management (block list / whitelist)
// -----------------------------------------------------------------------

const blocklistInput = document.getElementById("blocklistInput");
const blocklistAddBtn = document.getElementById("blocklistAddBtn");
const blocklistItems = document.getElementById("blocklistItems");

const whitelistInput = document.getElementById("whitelistInput");
const whitelistAddBtn = document.getElementById("whitelistAddBtn");
const whitelistItems = document.getElementById("whitelistItems");

function normalizeDomain(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // Allow pasting a full URL, and extract just the hostname.
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else {
    value = value.split("/")[0];
  }

  value = value.replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(value)) return null;
  return value;
}

async function getList(key) {
  const result = await chrome.storage.local.get(key);
  return Array.isArray(result[key]) ? result[key] : [];
}

async function setList(key, list) {
  await chrome.storage.local.set({ [key]: list });
}

function renderList(listEl, items, storageKey) {
  listEl.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-note";
    empty.textContent = "Nothing here yet.";
    empty.style.border = "none";
    empty.style.background = "transparent";
    listEl.appendChild(empty);
    return;
  }

  for (const domain of items) {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.className = "domain";
    span.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.title = `Remove ${domain}`;
    removeBtn.addEventListener("click", async () => {
      const current = await getList(storageKey);
      await setList(storageKey, current.filter((d) => d !== domain));
      refreshGuestList();
    });

    li.appendChild(span);
    li.appendChild(removeBtn);
    listEl.appendChild(li);
  }
}

async function refreshGuestList() {
  const [blocklist, whitelist] = await Promise.all([
    getList("customBlocklist"),
    getList("customWhitelist")
  ]);
  renderList(blocklistItems, blocklist, "customBlocklist");
  renderList(whitelistItems, whitelist, "customWhitelist");
}

async function addToList(inputEl, storageKey) {
  const domain = normalizeDomain(inputEl.value);
  if (!domain) {
    inputEl.focus();
    return;
  }
  const current = await getList(storageKey);
  if (!current.includes(domain)) {
    await setList(storageKey, [...current, domain]);
  }
  inputEl.value = "";
  inputEl.focus();
  refreshGuestList();
}

blocklistAddBtn.addEventListener("click", () => addToList(blocklistInput, "customBlocklist"));
whitelistAddBtn.addEventListener("click", () => addToList(whitelistInput, "customWhitelist"));

blocklistInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addToList(blocklistInput, "customBlocklist");
});
whitelistInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addToList(whitelistInput, "customWhitelist");
});

refreshGuestList();

// -----------------------------------------------------------------------
// Account + analytics
// -----------------------------------------------------------------------

const configWarning = document.getElementById("configWarning");
const authCard = document.getElementById("authCard");
const analyticsSection = document.getElementById("analyticsSection");
const accountChip = document.getElementById("accountChip");
const accountEmail = document.getElementById("accountEmail");
const signOutBtn = document.getElementById("signOutBtn");

const authToggle = document.getElementById("authToggle");
const loginLabel = document.getElementById("loginLabel");
const signupLabel = document.getElementById("signupLabel");
const loginForm = document.getElementById("loginForm");
const loginEmail = document.getElementById("loginEmail");
const loginPassword = document.getElementById("loginPassword");
const signupForm = document.getElementById("signupForm");
const signupEmail = document.getElementById("signupEmail");
const signupPassword = document.getElementById("signupPassword");
const authMessage = document.getElementById("authMessage");

const loadingState = document.getElementById("loadingState");
const emptyState = document.getElementById("emptyState");
const dailyTable = document.getElementById("dailyTable");
const dailyTableBody = document.getElementById("dailyTableBody");

const goalInput = document.getElementById("goalInput");
const goalSaveBtn = document.getElementById("goalSaveBtn");
const streakSummary = document.getElementById("streakSummary");
const calPrevBtn = document.getElementById("calPrevBtn");
const calNextBtn = document.getElementById("calNextBtn");
const calMonthLabel = document.getElementById("calMonthLabel");
const calendarGrid = document.getElementById("calendarGrid");

const topSitesEmpty = document.getElementById("topSitesEmpty");
const topSitesList = document.getElementById("topSitesList");

function setAuthMessage(text, kind) {
  authMessage.textContent = text;
  authMessage.className = kind ? `auth-message ${kind}` : "auth-message";
}

function setAuthFlipped(flipped) {
  authToggle.checked = flipped;
  authCard.classList.toggle("flipped", flipped);
  loginLabel.classList.toggle("active", !flipped);
  signupLabel.classList.toggle("active", flipped);
}

// Keeps things in sync if the checkbox itself changes (keyboard toggling
// via Tab + Space, for accessibility) rather than a label click.
authToggle.addEventListener("change", () => {
  setAuthFlipped(authToggle.checked);
});

loginLabel.addEventListener("click", () => setAuthFlipped(false));
signupLabel.addEventListener("click", () => setAuthFlipped(true));

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = loginForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  setAuthMessage("");

  try {
    await self.BouncerAuth.signIn(loginEmail.value.trim(), loginPassword.value);
    await showSignedInState();
  } catch (err) {
    setAuthMessage(err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = signupForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  setAuthMessage("");

  try {
    const result = await self.BouncerAuth.signUp(signupEmail.value.trim(), signupPassword.value);
    if (result.needsEmailConfirmation) {
      setAuthMessage("Check your email to confirm your account, then log in.", "info");
      setAuthFlipped(false);
    } else {
      await showSignedInState();
    }
  } catch (err) {
    setAuthMessage(err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", async () => {
  await self.BouncerAuth.signOut();
  location.reload();
});

async function showSignedInState() {
  const session = await self.BouncerAuth.getStoredSession();
  authCard.style.display = "none";
  accountChip.style.display = "flex";
  accountEmail.textContent = session?.user?.email || "";
  analyticsSection.style.display = "block";
  await loadDailyGoal();
  loadAnalytics();
  loadTopSites();
}

function formatMinutes(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.round(totalMinutes % 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function localDateKey(isoString) {
  const d = new Date(isoString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLabel(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

async function loadAnalytics() {
  loadingState.style.display = "block";
  emptyState.style.display = "none";
  dailyTable.style.display = "none";

  let sessions;
  try {
    sessions = await self.BouncerAuth.listFocusSessions();
  } catch (err) {
    loadingState.textContent = `Couldn't load your stats: ${err.message}`;
    return;
  }

  loadingState.style.display = "none";

  if (!sessions || sessions.length === 0) {
    emptyState.style.display = "block";
    renderStatTiles(0, 0, 0);
    byDayCache = new Map();
    renderCalendar();
    return;
  }

  const totalSessions = sessions.length;
  const totalDistractions = sessions.reduce((sum, s) => sum + (s.distraction_count || 0), 0);
  const totalFocusMinutes = sessions
    .filter((s) => s.ended_at)
    .reduce((sum, s) => sum + (s.duration_minutes || 0), 0);

  renderStatTiles(totalSessions, totalFocusMinutes, totalDistractions);

  const byDay = new Map();
  for (const s of sessions) {
    const key = localDateKey(s.started_at);
    if (!byDay.has(key)) {
      byDay.set(key, { sessions: 0, focusMinutes: 0, distractions: 0 });
    }
    const entry = byDay.get(key);
    entry.sessions += 1;
    entry.distractions += s.distraction_count || 0;
    if (s.ended_at) entry.focusMinutes += s.duration_minutes || 0;
  }
  byDayCache = byDay;
  renderCalendar();

  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const maxDistractions = Math.max(...days.map(([, v]) => v.distractions), 1);

  dailyTableBody.innerHTML = "";
  for (const [dateKey, entry] of days) {
    const tr = document.createElement("tr");

    const dateTd = document.createElement("td");
    dateTd.textContent = formatDateLabel(dateKey);

    const sessionsTd = document.createElement("td");
    sessionsTd.textContent = entry.sessions;

    const focusTd = document.createElement("td");
    focusTd.textContent = formatMinutes(entry.focusMinutes);

    const distractionsTd = document.createElement("td");
    const barCell = document.createElement("div");
    barCell.className = "bar-cell";

    const barTrack = document.createElement("div");
    barTrack.className = "bar-track";
    const barFill = document.createElement("div");
    barFill.className = "bar-fill";
    barFill.style.width = `${Math.round((entry.distractions / maxDistractions) * 100)}%`;
    barTrack.appendChild(barFill);

    const countLabel = document.createElement("span");
    countLabel.textContent = entry.distractions;
    countLabel.style.minWidth = "16px";

    barCell.appendChild(countLabel);
    barCell.appendChild(barTrack);
    distractionsTd.appendChild(barCell);

    tr.appendChild(dateTd);
    tr.appendChild(sessionsTd);
    tr.appendChild(focusTd);
    tr.appendChild(distractionsTd);
    dailyTableBody.appendChild(tr);
  }

  dailyTable.style.display = "table";
}

function renderStatTiles(totalSessions, totalFocusMinutes, totalDistractions) {
  document.getElementById("statSessions").textContent = totalSessions;
  document.getElementById("statFocusTime").textContent = formatMinutes(totalFocusMinutes);
  document.getElementById("statDistractions").textContent = totalDistractions;
  document.getElementById("statAvg").textContent =
    totalSessions === 0 ? "0" : (totalDistractions / totalSessions).toFixed(1);
}

// -----------------------------------------------------------------------
// Distraction goal & streak calendar
// -----------------------------------------------------------------------

let byDayCache = new Map(); // dateKey -> { sessions, focusMinutes, distractions }
let dailyGoal = 5;
let calendarMonthOffset = 0; // 0 = current month, negative = past months

const TOP_SITES_LIMIT = 8;

async function loadTopSites() {
  let events;
  try {
    events = await self.BouncerAuth.listDistractionEvents();
  } catch (err) {
    console.warn("[Bouncer] could not load top distracting sites:", err.message);
    return;
  }

  if (!events || events.length === 0) {
    topSitesEmpty.style.display = "block";
    topSitesList.innerHTML = "";
    return;
  }

  const counts = new Map();
  for (const event of events) {
    const domain = event.domain || "unknown";
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SITES_LIMIT);
  const maxCount = ranked[0][1];

  topSitesEmpty.style.display = "none";
  topSitesList.innerHTML = "";

  for (const [domain, count] of ranked) {
    const li = document.createElement("li");
    li.className = "site-rank-row";

    const domainSpan = document.createElement("span");
    domainSpan.className = "site-rank-domain";
    domainSpan.textContent = domain;
    domainSpan.title = domain;

    const barTrack = document.createElement("div");
    barTrack.className = "bar-track";
    const barFill = document.createElement("div");
    barFill.className = "bar-fill";
    barFill.style.width = `${Math.round((count / maxCount) * 100)}%`;
    barTrack.appendChild(barFill);

    const countSpan = document.createElement("span");
    countSpan.className = "site-rank-count";
    countSpan.textContent = count;

    li.appendChild(domainSpan);
    li.appendChild(barTrack);
    li.appendChild(countSpan);
    topSitesList.appendChild(li);
  }
}

async function loadDailyGoal() {
  try {
    const user = await self.BouncerAuth.getUser();
    const stored = user?.user_metadata?.daily_goal;
    dailyGoal = Number.isFinite(stored) ? stored : 5;
  } catch (err) {
    console.warn("[Bouncer] could not load daily goal, using default:", err.message);
    dailyGoal = 5;
  }
  goalInput.value = dailyGoal;
}

goalSaveBtn.addEventListener("click", async () => {
  const value = Math.floor(Number(goalInput.value));
  if (!Number.isFinite(value) || value < 0) {
    goalInput.focus();
    return;
  }
  goalSaveBtn.disabled = true;
  try {
    await self.BouncerAuth.updateUserMetadata({ daily_goal: value });
    dailyGoal = value;
    renderCalendar();
  } catch (err) {
    console.warn("[Bouncer] could not save daily goal:", err.message);
  } finally {
    goalSaveBtn.disabled = false;
  }
});

calPrevBtn.addEventListener("click", () => {
  calendarMonthOffset -= 1;
  renderCalendar();
});
calNextBtn.addEventListener("click", () => {
  if (calendarMonthOffset >= 0) return;
  calendarMonthOffset += 1;
  renderCalendar();
});

function dateKeyFromParts(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function renderCalendar() {
  const now = new Date();
  const viewDate = new Date(now.getFullYear(), now.getMonth() + calendarMonthOffset, 1);
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  calMonthLabel.textContent = viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  calNextBtn.disabled = calendarMonthOffset >= 0;

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKeyFromParts(now.getFullYear(), now.getMonth(), now.getDate());

  calendarGrid.innerHTML = "";

  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement("div");
    blank.className = "cal-day empty";
    calendarGrid.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKeyFromParts(year, month, day);
    const cell = document.createElement("div");
    cell.className = "cal-day";
    cell.textContent = day;

    const entry = byDayCache.get(key);
    if (entry) {
      cell.classList.add(entry.distractions <= dailyGoal ? "met" : "missed");
    }
    if (key === todayKey) {
      cell.classList.add("today");
    }
    calendarGrid.appendChild(cell);
  }

  renderStreak(todayKey);
}

// Walks backward day by day from today. A day with session data that met
// the goal extends the streak; a day with session data that missed the
// goal ends it. A day with no session data is skipped without breaking
// the streak, except once today is reached: if today has no data yet
// (the day isn't over), it's skipped too, but any earlier day with no
// data still ends the streak.
function renderStreak(todayKey) {
  let streak = 0;
  const cursor = new Date();

  for (let i = 0; i < 3650; i++) {
    const key = dateKeyFromParts(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
    const entry = byDayCache.get(key);

    if (key === todayKey && !entry) {
      cursor.setDate(cursor.getDate() - 1);
      continue;
    }

    if (!entry || entry.distractions > dailyGoal) break;

    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  streakSummary.textContent = `Current streak: ${streak} day${streak === 1 ? "" : "s"}`;
}

async function init() {
  if (!self.BouncerAuth.isConfigured()) {
    configWarning.style.display = "block";
    return;
  }

  const session = await self.BouncerAuth.getStoredSession();
  if (session) {
    await showSignedInState();
  } else {
    authCard.style.display = "flex";
  }
}

init();
