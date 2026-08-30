const SEQUENCE_LENGTH = 6;
const FLASH_MS = 450;
const GAP_MS = 200;

const tiles = [...document.querySelectorAll(".tile")];
const gameStatus = document.getElementById("gameStatus");
const cancelBtn = document.getElementById("cancelBtn");

let sequence = [];
let playerIndex = 0;
let accepting = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSequence(length) {
  return Array.from({ length }, () => Math.floor(Math.random() * tiles.length));
}

async function flashTile(index) {
  tiles[index].classList.add("active");
  await wait(FLASH_MS);
  tiles[index].classList.remove("active");
  await wait(GAP_MS);
}

async function playSequence() {
  accepting = false;
  gameStatus.textContent = "Watch closely...";
  await wait(500);
  for (const index of sequence) {
    await flashTile(index);
  }
  gameStatus.textContent = "Now repeat it.";
  playerIndex = 0;
  accepting = true;
}

function startRound() {
  sequence = randomSequence(SEQUENCE_LENGTH);
  playSequence();
}

tiles.forEach((tile, index) => {
  tile.addEventListener("click", () => {
    if (!accepting) return;

    tile.classList.add("active");
    setTimeout(() => tile.classList.remove("active"), 150);

    if (index === sequence[playerIndex]) {
      playerIndex += 1;
      if (playerIndex === sequence.length) {
        accepting = false;
        winGame();
      }
      return;
    }

    accepting = false;
    gameStatus.textContent = "Not quite. Watch again.";
    setTimeout(startRound, 900);
  });
});

async function winGame() {
  gameStatus.textContent = "Nice focus. Ending your session...";
  try {
    await chrome.runtime.sendMessage({ type: "EMERGENCY_OVERRIDE" });
    gameStatus.textContent = "Session ended. You can close this window.";
  } catch (err) {
    gameStatus.textContent = "Something went wrong ending the session. Try closing and reopening this window.";
    console.warn("[Bouncer] emergency override failed:", err);
  }
  cancelBtn.style.display = "none";
}

cancelBtn.addEventListener("click", () => window.close());

startRound();
