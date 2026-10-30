const statusElement = document.getElementById("status");
const exportButton = document.getElementById("export");
let activeTabId = null;

function setStatus(message, error = false) {
  statusElement.textContent = message;
  statusElement.dataset.error = String(error);
}

function sendToActiveTab(message) {
  return new Promise((resolve, reject) => {
    if (activeTabId === null) {
      reject(new Error("No active tab."));
      return;
    }
    chrome.tabs.sendMessage(activeTabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function isFacebookUrl(url) {
  try {
    return /(^|\.)facebook\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function updateCount() {
  try {
    const response = await sendToActiveTab({ type: "getCollectedPosts" });
    if (!response || !Array.isArray(response.posts)) {
      throw new Error("The exporter did not return post data.");
    }
    exportButton.disabled = response.posts.length === 0;
    setStatus(
      `נאספו ${response.posts.length} פוסטים בלשונית הזו.`
    );
    return response.posts;
  } catch (error) {
    exportButton.disabled = true;
    setStatus("פתח קבוצת פייסבוק או פיד וגלול בפוסטים לפני הייצוא.", true);
    return null;
  }
}

function downloadPosts(posts) {
  const content = posts
    .map(
      (post, index) =>
        `========== פוסט ${index + 1} ==========\n${post.text}\n` +
        (post.url ? `קישור לפוסט: ${post.url}\n` : "")
    )
    .join("\n\n");
  const blob = new Blob(["\uFEFF", content], { type: "text/plain;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = objectUrl;
  link.download = `facebook-posts-${timestamp}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  const posts = await updateCount();
  if (!posts) return;
  if (posts.length === 0) {
    setStatus("עדיין לא נאספו פוסטים שהגעת אליהם בגלילה.", true);
    return;
  }
  downloadPosts(posts);
  setStatus(`יוצאו ${posts.length} פוסטים לקובץ TXT.`);
  exportButton.disabled = false;
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab || !isFacebookUrl(tab.url) || tab.id === undefined) {
    setStatus("פתח קבוצת פייסבוק או פיד כדי להשתמש בתוסף.", true);
    return;
  }
  activeTabId = tab.id;
  updateCount();
});
