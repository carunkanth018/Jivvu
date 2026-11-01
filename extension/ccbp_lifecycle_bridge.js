/**
 * QuizZy - CCBP Automatic Lifecycle Bridge Content Script
 * Dispatches active heartbeats every 4000ms to background.js,
 * keeping the backend alive without falling into the MV3 30-second alarm throttling trap.
 * Exclusively uses chrome.runtime.sendMessage (zero direct localhost fetches to eliminate Chrome PNA prompts).
 * Zero-DOM mutation, read-only lifecycle keeper.
 */
(() => {
  "use strict";

  if (window.__QUIZZY_CCBP_LIFECYCLE_BRIDGE__) return;
  window.__QUIZZY_CCBP_LIFECYCLE_BRIDGE__ = true;

  const HEARTBEAT_INTERVAL_MS = 4000;

  function sendHeartbeat(trigger = "interval") {
    // Exclusively wake / ping background service worker without direct localhost fetches
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: "CCBP_PAGE_HEARTBEAT",
          trigger,
          url: window.location.href,
        }).catch(() => {});
      }
    } catch (_) {}
  }

  function notifyUnload() {
    // Only notify background.js via extension messaging — NEVER post directly to localhost
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: "CCBP_PAGE_UNLOAD",
          url: window.location.href,
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // 1. Immediate heartbeat on script execution
  sendHeartbeat("init");

  // 2. Continuous 4000ms heartbeat loop (content scripts never sleep while tab is open)
  setInterval(() => {
    sendHeartbeat("interval");
  }, HEARTBEAT_INTERVAL_MS);

  // 3. Tab visibility and focus triggers
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      sendHeartbeat("visibility_visible");
    }
  });
  window.addEventListener("focus", () => sendHeartbeat("focus"));

  // 4. Page hide / unload listener (safe notification only)
  window.addEventListener("pagehide", notifyUnload, { capture: true });
  window.addEventListener("beforeunload", notifyUnload, { capture: true });

  // 5. Solo Shift Key Listener to enable Auto Mode if HUD is not yet mounted
  let bridgeShiftDown = false;
  let bridgeShiftComboUsed = false;

  function isEditableElement(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    if (typeof el.getAttribute === "function" && el.getAttribute("contenteditable") === "true") return true;
    return false;
  }

  window.addEventListener("keydown", (e) => {
    if (!e || e.__quizzy_handled__) return;
    const isShift = e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight" || e.keyCode === 16;
    if (isShift) {
      const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
      if (isEditableElement(e.target) || isEditableElement(activeEl) || e.ctrlKey || e.altKey || e.metaKey) {
        bridgeShiftComboUsed = true;
        return;
      }
      if (bridgeShiftDown) return;
      bridgeShiftDown = true;
      bridgeShiftComboUsed = false;
    } else {
      if (bridgeShiftDown) bridgeShiftComboUsed = true;
    }
  }, { capture: true });

  window.addEventListener("keyup", (e) => {
    if (!e || e.__quizzy_handled__) return;
    const isShift = e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight" || e.keyCode === 16;
    if (isShift) {
      bridgeShiftDown = false;
      if (!bridgeShiftComboUsed) {
        // If floating HUD is already active and handled the event, do nothing
        if (window.__QUIZZY_HUD_INSTANCE__ || window.__QUIZZY_IN_PAGE_HUD__) {
          return;
        }
        try {
          if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ action: "TRIGGER_AUTO" }).catch(() => {});
          }
        } catch (_) {}
      }
      bridgeShiftComboUsed = false;
    }
  }, { capture: true });
})();
