const setupView = document.getElementById("setupView");
const lockedView = document.getElementById("lockedView");
const customDurationInput = document.getElementById("customDuration");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const countdownEl = document.getElementById("countdown");
const catImage = document.getElementById("catImage");
const catCaption = document.getElementById("catCaption");
const dashboardBtn = document.getElementById("dashboardBtn");
const emergencyBtn = document.getElementById("emergencyBtn");

dashboardBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

emergencyBtn.addEventListener("click", () => {
  chrome.windows.create({
    url: chrome.runtime.getURL("override/override.html"),
    type: "popup",
    width: 340,
    height: 480,
    focused: true
  });
});

// Every 3 closed distraction tabs, the cat advances to the next, madder
// stage. After the final "mad" stage the cat storms off, then disappears.
const CAT_STAGES = [
  { src: "../icons/cats/1_cat.png", caption: "" },
  { src: "../icons/cats/2_cat.png", caption: "getting annoyed..." },
  { src: "../icons/cats/3_cat.png", caption: "pretty mad now." },
  { src: "../icons/cats/4_cat.png", caption: "furious." },
  { src: "../icons/cats/5_cat.png", caption: "the cat has had enough." }
];
const DISTRACTIONS_PER_STAGE = 3;

let tickInterval = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function showView(view) {
  for (const el of [setupView, lockedView]) {
    el.classList.remove("visible");
  }
  view.classList.add("visible");
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stopTicking() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

function updateCatMood(distractionCount) {
  const stageIndex = Math.floor((distractionCount || 0) / DISTRACTIONS_PER_STAGE);
  if (stageIndex >= CAT_STAGES.length) {
    catImage.style.visibility = "hidden";
    catCaption.textContent = "the cat left. it's just you now.";
    return;
  }
  const stage = CAT_STAGES[stageIndex];
  catImage.style.visibility = "visible";
  catImage.src = stage.src;
  catCaption.textContent = stage.caption;
}

async function refresh() {
  const { session } = (await sendMessage({ type: "GET_SESSION" })) || {};

  stopTicking();

  if (session && Date.now() < session.endTime) {
    showView(lockedView);
    updateCatMood(session.distractionCount);
    const tick = () => {
      const remaining = session.endTime - Date.now();
      if (remaining <= 0) {
        stopTicking();
        refresh();
        return;
      }
      countdownEl.textContent = formatRemaining(remaining);
    };
    tick();
    tickInterval = setInterval(tick, 1000);
  } else if (session) {
    // Session object exists but has expired (e.g. the popup was reopened
    // right at expiry, before the background alarm cleared it). Clear it
    // now so a new session can be started, rather than getting stuck on
    // a dead-end "complete" screen.
    await sendMessage({ type: "STOP_SESSION" });
    showView(setupView);
  } else {
    showView(setupView);
  }
}

function getEnteredDurationMinutes() {
  const value = Math.floor(Number(customDurationInput.value));
  if (!Number.isFinite(value) || value < 1 || value > 1440) return null;
  return value;
}

startBtn.addEventListener("click", async () => {
  const durationMinutes = getEnteredDurationMinutes();
  if (durationMinutes === null) {
    customDurationInput.focus();
    customDurationInput.reportValidity?.();
    return;
  }
  startBtn.disabled = true;
  try {
    await sendMessage({ type: "START_SESSION", durationMinutes });
  } finally {
    startBtn.disabled = false;
  }
  refresh();
});

// The stop button is permanently disabled while locked. This handler
// exists only as defense in depth. The background service worker is the
// real enforcement point and will reject any STOP_SESSION message sent
// before endTime.
stopBtn.addEventListener("click", async () => {
  await sendMessage({ type: "STOP_SESSION" });
  refresh();
});

// Live-update the cat's mood the instant a distracting tab gets closed,
// without waiting for the once-a-second countdown tick.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.focusSession) return;
  const newSession = changes.focusSession.newValue;
  if (newSession && Date.now() < newSession.endTime) {
    updateCatMood(newSession.distractionCount);
  } else {
    refresh();
  }
});

refresh();
