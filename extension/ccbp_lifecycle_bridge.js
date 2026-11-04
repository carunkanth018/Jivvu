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

  const bridgeAbortController = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const bridgeSignal = bridgeAbortController ? bridgeAbortController.signal : undefined;

  function isExtensionContextValid() {
    return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
  }

  const HEARTBEAT_VISIBLE_MS = 4000;
  const HEARTBEAT_HIDDEN_MS = 20000;
  let heartbeatTimer = null;

  function sendHeartbeat(trigger = "interval") {
    // Exclusively wake / ping background service worker without direct localhost fetches
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: "CCBP_PAGE_HEARTBEAT",
          trigger,
          url: window.location.href,
        }).then((res) => {
          if (res && typeof window !== "undefined" && typeof window.__QUIZZY_ON_BACKEND_HEALTH_UPDATE__ === "function") {
            window.__QUIZZY_ON_BACKEND_HEALTH_UPDATE__(res.backend_healthy !== false);
          }
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

  function setHeartbeatInterval(intervalMs) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!isExtensionContextValid()) {
        stopHeartbeatLoop();
        if (bridgeAbortController && typeof bridgeAbortController.abort === "function") {
          try { bridgeAbortController.abort("Context Invalidated"); } catch (_) {}
        }
        return;
      }
      const trigger = (typeof document !== "undefined" && document.visibilityState === "hidden")
        ? "interval_background"
        : "interval";
      sendHeartbeat(trigger);
    }, intervalMs);
  }

  function stopHeartbeatLoop() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  if (typeof window !== "undefined") {
    window.__QUIZZY_BRIDGE_IS_CONTEXT_VALID__ = isExtensionContextValid;
    window.__QUIZZY_BRIDGE_STOP_HEARTBEAT__ = stopHeartbeatLoop;
  }

  // 1. Initial heartbeat and loop start (throttle to 20s if background tab, 4s if visible)
  sendHeartbeat("init");
  const initialInterval = (typeof document !== "undefined" && document.visibilityState === "hidden")
    ? HEARTBEAT_HIDDEN_MS
    : HEARTBEAT_VISIBLE_MS;
  setHeartbeatInterval(initialInterval);

  // 2. Tab visibility and focus triggers
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        sendHeartbeat("visibility_visible");
        setHeartbeatInterval(HEARTBEAT_VISIBLE_MS);
      } else {
        setHeartbeatInterval(HEARTBEAT_HIDDEN_MS);
      }
    }, bridgeSignal ? { signal: bridgeSignal } : undefined);
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", () => {
      sendHeartbeat("focus");
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        setHeartbeatInterval(HEARTBEAT_VISIBLE_MS);
      }
    }, bridgeSignal ? { signal: bridgeSignal } : undefined);

    // 3. Page hide / unload listener (safe notification only)
    window.addEventListener("pagehide", () => {
      stopHeartbeatLoop();
      notifyUnload();
    }, bridgeSignal ? { signal: bridgeSignal, capture: true } : { capture: true });

    window.addEventListener("beforeunload", () => {
      stopHeartbeatLoop();
      notifyUnload();
    }, bridgeSignal ? { signal: bridgeSignal, capture: true } : { capture: true });
  }

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

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("keydown", (e) => {
    if (!e || e.__quizzy_handled__) return;

    // Ctrl + Alt + 0: Portal Completion Toggle
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0")) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      e.__quizzy_handled__ = true;

      // Route safety guard: do not start if on standalone question or quiz runner
      const pathname = (typeof window !== "undefined" && window.location) ? (window.location.pathname || "") : "";
      if (/\/question\/[a-z0-9-]+/i.test(pathname) || /\/assessment\/|\/test-runner\//i.test(pathname)) {
        return;
      }

      if (typeof window !== "undefined" && window.QuizZyPortalCompletion && typeof window.QuizZyPortalCompletion.toggle === "function") {
        window.QuizZyPortalCompletion.toggle();
        return;
      }

      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "PORTAL_COMPLETION_TOGGLE" }).catch(() => {});
        }
      } catch (_) {}
      return;
    }

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
  }, bridgeSignal ? { signal: bridgeSignal, capture: true } : { capture: true });

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
  }, bridgeSignal ? { signal: bridgeSignal, capture: true } : { capture: true });
  }
})();
