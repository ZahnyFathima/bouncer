const ACK_BUTTON_LABELS = [
  "Fine, I'm distracted",
  "Ugh, fine, caught me",
  "Yes, guilty as charged",
  "Okay you got me",
  "I regret nothing (lie)",
  "Back to work, I guess",
  "You win this round"
];

function pickAckLabel() {
  return ACK_BUTTON_LABELS[Math.floor(Math.random() * ACK_BUTTON_LABELS.length)];
}

const params = new URLSearchParams(location.search);

document.getElementById("remark").textContent = params.get("remark") || "Nice try.";
document.getElementById("closedTitle").textContent = params.get("title")
  ? `Closed: "${params.get("title")}"`
  : "";

const ackBtn = document.getElementById("ackBtn");
ackBtn.textContent = pickAckLabel();
ackBtn.addEventListener("click", () => {
  window.close();
});
