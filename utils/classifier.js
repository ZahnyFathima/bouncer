/**
 * 100% local title classifier.
 *
 * Primary path: Chrome's built-in on-device Prompt API (window.ai /
 * chrome.aiOriginTrial.languageModel), when available in this Chrome build.
 * All inference for that path runs on-device via Gemini Nano, with no
 * network calls and no API keys.
 *
 * Fallback path: a lightweight local heuristic/keyword classifier. This
 * keeps the extension fully functional on Chrome versions/channels where
 * the on-device model isn't available, without ever calling out to a cloud
 * API.
 */

// ---- Fallback keyword model -----------------------------------------

const DISTRACTION_KEYWORDS = [
  "reddit", "tiktok", "instagram", "facebook", "twitter", "x.com",
  "netflix", "hulu", "disney+", "twitch", "9gag", "buzzfeed", "pinterest",
  "snapchat", "discord chat", "meme", "memes", "gossip", "celebrity",
  "highlights", "funny video", "prank", "trailer", "gameplay", "let's play",
  "gaming", "game review", "sports scores", "shopping cart", "for you page",
  "fyp", "trending", "viral", "watch now", "episode", "season", "livestream",
  "live stream", "vlog", "unboxing", "reaction video"
];

const PRODUCTIVE_KEYWORDS = [
  "docs", "documentation", "github", "gitlab", "stack overflow",
  "stackoverflow", "jira", "confluence", "notion", "google docs",
  "google sheets", "google slides", "calendar", "gmail", "outlook", "slack",
  "zoom meeting", "research", "paper", "pdf", "tutorial", "course",
  "lecture", "study", "exam", "assignment", "api reference", "changelog",
  "pull request", "merge request", "compiler", "terminal", "localhost",
  "dashboard", "analytics", "spreadsheet", "report", "invoice", "wiki"
];

const GENERIC_PLACEHOLDER_TITLES = new Set([
  "new tab",
  "loading...",
  "loading",
  "untitled",
  ""
]);

function isPlaceholderTitle(title) {
  if (!title) return true;
  return GENERIC_PLACEHOLDER_TITLES.has(title.trim().toLowerCase());
}

function keywordClassify(title) {
  const normalized = title.toLowerCase();

  let distractionScore = 0;
  for (const kw of DISTRACTION_KEYWORDS) {
    if (normalized.includes(kw)) distractionScore++;
  }

  let productiveScore = 0;
  for (const kw of PRODUCTIVE_KEYWORDS) {
    if (normalized.includes(kw)) productiveScore++;
  }

  // Ties, or no signal at all, default to NOT closing the tab
  // (fail open toward productivity; never punish an unrecognized page).
  return distractionScore > productiveScore;
}

// ---- On-device Prompt API model (when available) ---------------------

let promptSession = null;
let promptApiUnavailable = false;

async function getPromptSession() {
  if (promptApiUnavailable) return null;
  if (promptSession) return promptSession;

  try {
    const languageModel =
      (typeof LanguageModel !== "undefined" && LanguageModel) ||
      (typeof window !== "undefined" &&
        window.ai &&
        window.ai.languageModel) ||
      (typeof chrome !== "undefined" &&
        chrome.aiOriginTrial &&
        chrome.aiOriginTrial.languageModel);

    if (!languageModel) {
      promptApiUnavailable = true;
      return null;
    }

    const availability =
      (await languageModel.availability?.()) ??
      (await languageModel.capabilities?.())?.available;

    if (availability === "no" || availability === "unavailable") {
      promptApiUnavailable = true;
      return null;
    }

    promptSession = await (languageModel.create
      ? languageModel.create({
          initialPrompts: [
            {
              role: "system",
              content:
                "You classify browser tab titles as either DISTRACTION " +
                "(entertainment, social media, gaming, video binging) or " +
                "WORK (productive, educational, or professional content). " +
                "Reply with exactly one word: DISTRACTION or WORK."
            }
          ]
        })
      : null);

    if (!promptSession) {
      promptApiUnavailable = true;
      return null;
    }

    return promptSession;
  } catch (err) {
    console.warn("[FocusMode] Prompt API unavailable, using local fallback:", err);
    promptApiUnavailable = true;
    return null;
  }
}

// The very first call to the on-device model (session creation and/or its
// first prompt()) can hang for a long time, e.g. Gemini Nano still
// downloading/initializing in the background. Without a bound, that first
// call can block classification indefinitely and the tab never gets
// evaluated no matter how long you wait. Bound the whole model round trip
// so a stuck first call falls back to the (fast, reliable) keyword model
// instead of hanging forever.
const PROMPT_API_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("prompt API timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function promptApiClassify(title) {
  try {
    return await withTimeout(promptApiClassifyInner(title), PROMPT_API_TIMEOUT_MS);
  } catch (err) {
    console.warn("[FocusMode] Prompt API inference failed/timed out, using local fallback:", err.message);
    return null;
  }
}

async function promptApiClassifyInner(title) {
  const session = await getPromptSession();
  if (!session) return null;

  const response = await session.prompt(`Tab title: "${title}"`);
  const normalized = response.trim().toUpperCase();
  if (normalized.includes("DISTRACTION")) return true;
  if (normalized.includes("WORK")) return false;
  return null; // ambiguous model output, fall back to keyword model
}

/**
 * Classifies a tab title.
 * @param {string} title
 * @returns {Promise<boolean>} true if DISTRACTION, false if WORK/neutral.
 */
async function classifyTitle(title) {
  if (isPlaceholderTitle(title)) return false;

  const modelResult = await promptApiClassify(title);
  if (modelResult !== null) {
    console.log(`[FocusMode] classified via Prompt API: ${modelResult}`);
    return modelResult;
  }

  const fallbackResult = keywordClassify(title);
  console.log(`[FocusMode] classified via keyword fallback: ${fallbackResult}`);
  return fallbackResult;
}

// Exposed for the service worker (classic script import via importScripts).
self.FocusModeClassifier = {
  classifyTitle,
  isPlaceholderTitle
};
