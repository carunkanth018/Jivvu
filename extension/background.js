/**
 * QuizZy - Manifest V3 Background Service Worker
 * 
 * Handles:
 * 1. Side panel open behavior & floating HUD injection
 * 2. On-demand script injection (extractor.js, executor.js, floating_hud.js) in ISOLATED world
 * 3. Proxying solve and health requests to local FastAPI backend (http://127.0.0.1:8000)
 * 4. Multi-trigger emergency kill switch (tab change, navigation away from quiz page)
 */

"use strict";

const BACKEND_BASE_URL = "http://127.0.0.1:8000";

// In-flight solve deduplication and 2.5s 429 rate limit cooldown tracking
const _bgInFlightSolves = new Map();
const _bgRecent429Signatures = new Map();

function recordRecent429Signature(qSig) {
  const now = Date.now();
  for (const [key, ts] of _bgRecent429Signatures.entries()) {
    if (now - ts > 2500) _bgRecent429Signatures.delete(key);
  }
  if (_bgRecent429Signatures.size >= 50) {
    const oldest = _bgRecent429Signatures.keys().next().value;
    if (oldest) _bgRecent429Signatures.delete(oldest);
  }
  _bgRecent429Signatures.set(qSig, now);
}

function decodePotentialUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let u = rawUrl.trim();
  for (let i = 0; i < 3; i++) {
    if (u.includes("%3A") || u.includes("%2F") || u.includes("%3a") || u.includes("%2f")) {
      try {
        const dec = decodeURIComponent(u);
        if (dec === u) break;
        u = dec;
      } catch (_) {
        break;
      }
    } else {
      break;
    }
  }
  return u;
}

// Authoritative client-side validation guard to prevent dispatching invalid payloads to backend
function isValidExtractedQuestion(q) {
  if (!q) return false;
  const stem = (q.stem || q.question_text || q.question || ((q.starter_code || q.image_data || q.image_url) ? "Solve the given problem based on the provided code or diagram." : "")).trim();
  if (stem.length < 2) return false;
  const rawType = (q.q_type || "mcq").toLowerCase();
  const typeMap = { mcq: "mcq", multiple: "multi", multi: "multi", ordering: "order", order: "order", fill: "text", text: "text", coding: "code", code: "code" };
  const type = typeMap[rawType] || rawType;
  if (["mcq", "multi", "order"].includes(type)) {
    const validOpts = Array.isArray(q.options)
      ? q.options.filter(o => o !== null && o !== undefined && (typeof o === "string" ? o.trim().length >= 1 : (typeof o === "object" ? String(o.text || o.label || o.value || "").trim().length >= 1 : String(o).trim().length >= 1)))
      : [];
    if (validOpts.length < 2) return false;
  }
  return true;
}

// Helper to resolve target tab: sender tab -> message.tabId -> active tab query
async function resolveTargetTab(message, sender) {
  if (message && message.tabId) {
    try {
      const tab = await chrome.tabs.get(message.tabId);
      if (tab) return tab;
    } catch (_) { }
  }
  if (sender && sender.tab && sender.tab.id) {
    return sender.tab;
  }
  try {
    let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs[0]) return tabs[0];
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs && tabs[0]) return tabs[0];
    tabs = await chrome.tabs.query({ active: true });
    return (tabs && tabs[0]) ? tabs[0] : null;
  } catch (_) {
    return null;
  }
}

// In-memory cache of known injected scripts per tab to eliminate redundant IPC round-trips
const injectedTabScripts = new Map(); // tabId -> Set of script filenames

function trackInjectedTabScript(tabId, fileName) {
  if (!injectedTabScripts.has(tabId)) {
    if (injectedTabScripts.size >= 50) {
      const oldestTab = injectedTabScripts.keys().next().value;
      if (oldestTab !== undefined) injectedTabScripts.delete(oldestTab);
    }
    injectedTabScripts.set(tabId, new Set());
  }
  injectedTabScripts.get(tabId).add(fileName);
}

// Helper to avoid re-injecting large content scripts if already present in tab
async function ensureScriptInjected(tabId, checkGlobal, fileName) {
  if (!tabId || !fileName) return false;

  if (injectedTabScripts.has(tabId) && injectedTabScripts.get(tabId).has(fileName)) {
    return true;
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (g) => Boolean(window[g]),
      args: [checkGlobal]
    });
    if (res && res[0] && res[0].result) {
      trackInjectedTabScript(tabId, fileName);
      return true;
    }
  } catch (_) { }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: [fileName]
    });
    trackInjectedTabScript(tabId, fileName);
    return true;
  } catch (err) {
    return false;
  }
}

// Safe messaging wrappers that check chrome.runtime.lastError to eliminate Unchecked runtime.lastError logs in Chrome
function safeSendMessageToTab(tabId, message, callback) {
  if (!tabId || typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.sendMessage) {
    if (typeof callback === "function") callback(null, new Error("Invalid tabId or tabs API missing"));
    return;
  }
  try {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError : null;
      if (typeof callback === "function") {
        try {
          callback(response, err);
        } catch (_) { }
      }
    });
  } catch (syncErr) {
    if (typeof callback === "function") {
      try {
        callback(null, syncErr);
      } catch (_) { }
    }
  }
}

function safeSendMessageToRuntime(message, callback) {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    if (typeof callback === "function") callback(null, new Error("Runtime API missing"));
    return;
  }
  try {
    chrome.runtime.sendMessage(message, (response) => {
      const err = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError) ? chrome.runtime.lastError : null;
      if (typeof callback === "function") {
        try {
          callback(response, err);
        } catch (_) { }
      }
    });
  } catch (syncErr) {
    if (typeof callback === "function") {
      try {
        callback(null, syncErr);
      } catch (_) { }
    }
  }
}

// Injects extractor, executor, and floating HUD into target tab
async function injectAndToggleFloatingHud(tabId, shouldToggle = true, autoShow = true) {
  if (!tabId) return { success: false, error: "Missing tabId" };
  try {
    await ensureScriptInjected(tabId, "__QUIZZY_EXTRACTOR_LOADED__", "extractor.js");
    await ensureScriptInjected(tabId, "__QUIZZY_EXECUTOR_LOADED__", "executor.js");
    await ensureScriptInjected(tabId, "__QUIZZY_PORTAL_LOADED__", "portal_completion.js");
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["floating_hud.js"]
    });

    const hudResult = results && results[0] ? results[0].result : { success: true };

    if (hudResult && hudResult.codingMode) {
      return hudResult;
    }

    if (shouldToggle && hudResult && hudResult.alreadyMounted) {
      safeSendMessageToTab(tabId, { action: "TOGGLE_FLOATING_HUD_COMMAND" });
    } else if (autoShow) {
      safeSendMessageToTab(tabId, { action: "SHOW_FLOATING_HUD_COMMAND" });
    } else {
      safeSendMessageToTab(tabId, { action: "HIDE_FLOATING_HUD_COMMAND" }); // chrome.tabs.sendMessage(tabId, { action: "HIDE_FLOATING_HUD_COMMAND" })
    }

    return hudResult;
  } catch (err) {
    console.warn("[QuizZy Service Worker] Injection failed:", err);
    return { success: false, error: err.message };
  }
}

// Pre-seed default allowed hosts in chrome.storage.local (including learning.ccbp.in)
function initializeStorageDefaults() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["allowedHosts", "auto_mode_allowlist"], (data) => {
      const defaults = ["127.0.0.1", "localhost", "::1", "learning.ccbp.in"];
      const current = data.allowedHosts || [];
      const currentAuto = data.auto_mode_allowlist || [];
      let modified = false;
      let modifiedAuto = false;
      for (const d of defaults) {
        if (!current.includes(d)) {
          current.push(d);
          modified = true;
        }
        if (!currentAuto.includes(d)) {
          currentAuto.push(d);
          modifiedAuto = true;
        }
      }
      const update = {};
      if (modified || !data.allowedHosts) update.allowedHosts = current;
      if (modifiedAuto || !data.auto_mode_allowlist) update.auto_mode_allowlist = currentAuto;
      if (Object.keys(update).length > 0) {
        chrome.storage.local.set(update);
      }
    });
  }
}

function injectIntoOpenTabs() {
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({}, (tabs) => {
      if (!tabs || !Array.isArray(tabs)) return;
      for (const t of tabs) {
        if (!t || !t.id || !t.url) continue;
        if (t.url.startsWith("chrome://") || t.url.startsWith("edge://") || t.url.startsWith("chrome-extension://")) continue;
        try {
          const urlObj = new URL(t.url);
          const hostname = urlObj.hostname.toLowerCase();
          const defaultAllowed = ["learning.ccbp.in", "127.0.0.1", "localhost", "::1"];
          if (defaultAllowed.includes(hostname)) {
            injectAndToggleFloatingHud(t.id, false, false);
          } else if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(["allowedHosts", "auto_mode_allowlist"], (data) => {
              const allowed = (data.allowedHosts || []).concat(data.auto_mode_allowlist || []);
              if (allowed.includes(hostname)) {
                injectAndToggleFloatingHud(t.id, false, false);
              }
            });
          }
        } catch (_) { }
      }
    });
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    initializeStorageDefaults();
    injectIntoOpenTabs();
  });
}
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    injectIntoOpenTabs();
  });
}
initializeStorageDefaults();
injectIntoOpenTabs();

// Configure side panel behavior: Disable opening on action click so Floating Bar is the primary UX
if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((err) => {
    console.warn("[QuizZy Service Worker] setPanelBehavior warning:", err);
  });
}

// Track active popup window ID to strictly prevent opening duplicate popup windows
let activePopupWindowId = null;
let isSidePanelOpen = false;

// Monitor side panel lifecycle via port connection for mutual exclusivity
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port && port.name === "quizzy-sidepanel-port") {
      isSidePanelOpen = true;
      if (chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({}, (tabs) => {
          if (!tabs || !Array.isArray(tabs)) return;
          for (const t of tabs) {
            if (t && t.id) {
              const hasScript = (typeof injectedTabScripts !== "undefined" && injectedTabScripts.has(t.id)) || (t.url && isCcbpUrl(t.url));
              if (hasScript) {
                safeSendMessageToTab(t.id, { action: "SIDEPANEL_STATE_CHANGED", isOpen: true });
                safeSendMessageToTab(t.id, { action: "HIDE_FLOATING_HUD_COMMAND" });
              }
            }
          }
        });
      }
      port.onDisconnect.addListener(() => {
        isSidePanelOpen = false;
        if (chrome.tabs && chrome.tabs.query) {
          chrome.tabs.query({}, (tabs) => {
            if (!tabs || !Array.isArray(tabs)) return;
            for (const t of tabs) {
              if (t && t.id) {
                const hasScript = (typeof injectedTabScripts !== "undefined" && injectedTabScripts.has(t.id)) || (t.url && isCcbpUrl(t.url));
                if (hasScript) {
                  safeSendMessageToTab(t.id, { action: "SIDEPANEL_STATE_CHANGED", isOpen: false });
                }
              }
            }
          });
        }
      });
    }
  });
}

if (typeof chrome !== "undefined" && chrome.windows) {
  // Clear reference when popup window is closed
  if (chrome.windows.onRemoved) {
    chrome.windows.onRemoved.addListener((closedWinId) => {
      if (closedWinId === activePopupWindowId) {
        activePopupWindowId = null;
      }
    });
  }

  // Auto-cleanup: Close any unwanted leftover "sidepanel.html?mode=popup" windows
  if (chrome.windows.getAll && chrome.windows.remove) {
    try {
      chrome.windows.getAll({ populate: true }, (windows) => {
        if (!windows || !Array.isArray(windows)) return;
        for (const win of windows) {
          if (win && win.type === "popup" && win.tabs && win.tabs.some(t => t.url && t.url.includes("sidepanel.html?mode=popup"))) {
            chrome.windows.remove(win.id).catch(() => { });
          }
        }
      });
    } catch (_) { }
  }
}

// Action click listener: Clicking extension toolbar icon immediately toggles the Floating Bar on page!
if (typeof chrome !== "undefined" && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab && tab.id) {
      try {
        await injectAndToggleFloatingHud(tab.id, true);
      } catch (err) {
        console.warn("[QuizZy Service Worker] Failed to toggle floating HUD on action click:", err);
      }
    }
  });
}

// ==========================================================================
// Zero-DOM Visual Feedback via Extension Toolbar Badge (chrome.action.setBadgeText)
// ==========================================================================
function updateActionBadge(text, color, tabId) {
  try {
    if (typeof chrome !== "undefined" && chrome.action && typeof chrome.action.setBadgeText === "function") {
      const details = { text: text || "" };
      if (typeof tabId === "number") details.tabId = tabId;
      chrome.action.setBadgeText(details);
      // Enforce white & blue UI palette: vibrant blue background
      const badgeColor = "#2563EB";
      if (typeof chrome.action.setBadgeBackgroundColor === "function") {
        const bgDetails = { color: badgeColor };
        if (typeof tabId === "number") bgDetails.tabId = tabId;
        chrome.action.setBadgeBackgroundColor(bgDetails);
      }
    }
  } catch (_) { }
}

// ==========================================================================
// Automated Backend Lifecycle Management for learning.ccbp.in
// Automatically starts the QuizZy backend on 127.0.0.1:8000 when learning.ccbp.in
// is opened, and stops the backend when all learning.ccbp.in tabs are closed.
// Uses Dual-Channel OS Bridge (Channel A: Dashboard Daemon API on port 8765,
// Channel B: Chrome Native Messaging Host com.quizzy.lifecycle / com.quizzy.launcher).
// ==========================================================================

const DASHBOARD_API_BASE = "http://127.0.0.1:8765";
const CCBP_DOMAIN = "learning.ccbp.in";
const BACKEND_SHUTDOWN_DEBOUNCE_MS = 3000;
const HEARTBEAT_ALARM_NAME = "quizzy_heartbeat";
const STOP_DEBOUNCE_ALARM_NAME = "quizzy_stop_debounce";

let ccbpShutdownTimer = null;
let isStartingBackendAuto = false;
let isStoppingBackendAuto = false;
let isBackendRunning = false;

function isCcbpUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === CCBP_DOMAIN || host.endsWith("." + CCBP_DOMAIN);
  } catch (_) {
    return false;
  }
}

function countCcbpTabs(callback) {
  if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.query !== "function") {
    if (callback) callback(0);
    return;
  }
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) {
      if (callback) callback(0);
      return;
    }
    const ccbpCount = tabs.filter(t => t && t.url && isCcbpUrl(t.url)).length;
    if (callback) callback(ccbpCount);
  });
}

// Native Messaging fallback helper trying primary host then legacy host
function sendNativeMessageWithFallback(payload, callback) {
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendNativeMessage !== "function") {
    if (callback) callback({ success: false, error: "sendNativeMessage API not available" });
    return;
  }
  const hosts = ["com.quizzy.lifecycle", "com.quizzy.launcher"];
  let tried = 0;

  function tryNext() {
    if (tried >= hosts.length) {
      if (callback) callback({ success: false, error: "All native hosts failed" });
      return;
    }
    const currentHost = hosts[tried++];
    try {
      chrome.runtime.sendNativeMessage(currentHost, payload, (response) => {
        if (chrome.runtime.lastError) {
          console.warn(`[QuizZy Native] Host ${currentHost} returned error:`, chrome.runtime.lastError.message);
          tryNext();
          return;
        }
        if (callback) callback(response || { success: true });
      });
    } catch (err) {
      console.warn(`[QuizZy Native] Host ${currentHost} exception:`, err);
      tryNext();
    }
  }

  tryNext();
}

// Strict HTTP-First Start: Daemon API (8765) -> Native Host fallback ONLY if daemon offline
async function startBackendDualChannel(reason = "ccbp_auto") {
  if (isStartingBackendAuto) return;
  isStartingBackendAuto = true;
  console.log(`[QuizZy Lifecycle] Starting backend (reason: ${reason})...`);

  // 1. Try Channel A: Silent HTTP Daemon on 8765 FIRST
  try {
    const resp = await fetch(`${DASHBOARD_API_BASE}/api/lifecycle/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: `extension:${reason}` })
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log("[QuizZy Lifecycle] Backend started silently via Daemon API:", data);
      isStartingBackendAuto = false;
      isBackendRunning = true;
      return data;
    }
  } catch (err) {
    console.log("[QuizZy Lifecycle] Daemon API unreachable for start, falling back to Native Host...", err);
  }

  // 2. Fallback to Channel B: Native Host ONLY if Daemon API is completely unreachable
  return new Promise((resolve) => {
    sendNativeMessageWithFallback({ action: "START_BACKEND", source: `extension:${reason}` }, (res) => {
      isStartingBackendAuto = false;
      isBackendRunning = Boolean(res && res.success !== false);
      console.log("[QuizZy Lifecycle] Backend started via Native Host fallback:", res);
      resolve(res);
    });
  });
}

// Strict HTTP-First Stop: Daemon API (8765) -> Native Host fallback ONLY if daemon offline
async function stopBackendDualChannel(reason = "ccbp_tabs_closed") {
  if (isStoppingBackendAuto) return;
  isStoppingBackendAuto = true;
  console.log(`[QuizZy Lifecycle] Stopping backend (reason: ${reason})...`);

  // Direct graceful /shutdown attempt on port 8000
  fetch(`${BACKEND_BASE_URL}/shutdown`, { method: "POST" }).catch(() => { });

  // 1. Try Channel A: Silent HTTP Daemon on 8765 FIRST
  let stoppedViaHttp = false;
  try {
    const resp = await fetch(`${DASHBOARD_API_BASE}/api/lifecycle/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: `extension:${reason}` })
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log("[QuizZy Lifecycle] Backend stopped silently via Daemon API:", data);
      stoppedViaHttp = true;
    }
  } catch (err) {
    console.log("[QuizZy Lifecycle] Daemon API unreachable for stop, falling back to Native Host...", err);
  }

  // 2. Fallback to Channel B: Native Host ONLY if Daemon API failed
  if (!stoppedViaHttp) {
    sendNativeMessageWithFallback({ action: "STOP_BACKEND", source: `extension:${reason}` }, (res) => {
      console.log("[QuizZy Lifecycle] Backend stopped via Native Host fallback:", res);
    });
  }

  isStoppingBackendAuto = false;
  isBackendRunning = false;
}

// Heartbeat sender: sends active tab count to Channel A, with Channel B fallback
function sendLifecycleHeartbeat(activeTabs) {
  fetch(`${DASHBOARD_API_BASE}/api/lifecycle/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active_tabs: activeTabs })
  }).catch(() => {
    sendNativeMessageWithFallback({ action: "HEARTBEAT", active_tabs: activeTabs });
  });
}

function ensureBackendRunningForCcbp(reason) {
  // Cancel pending stop timers & alarms immediately
  if (ccbpShutdownTimer) {
    clearTimeout(ccbpShutdownTimer);
    ccbpShutdownTimer = null;
  }
  if (typeof chrome !== "undefined" && chrome.alarms) {
    chrome.alarms.clear(STOP_DEBOUNCE_ALARM_NAME).catch(() => { });
  }

  // Ensure periodic heartbeat alarm is running (Chrome MV3 requires periodInMinutes >= 1)
  if (typeof chrome !== "undefined" && chrome.alarms) {
    chrome.alarms.get(HEARTBEAT_ALARM_NAME, (alarm) => {
      if (!alarm) {
        chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 1 });
      }
    });
  }

  // Fast check: if port 8000 is healthy, just send heartbeat
  fetch(`${BACKEND_BASE_URL}/health`, { cache: "no-store" })
    .then((res) => {
      if (res.ok) {
        isBackendRunning = true;
        sendLifecycleHeartbeat(1);
        return;
      }
      isBackendRunning = false;
      startBackendDualChannel(reason);
    })
    .catch(() => {
      isBackendRunning = false;
      startBackendDualChannel(reason);
    });
}

function ensureBackendStoppedForCcbp(immediate = false) {
  if (ccbpShutdownTimer) {
    clearTimeout(ccbpShutdownTimer);
    ccbpShutdownTimer = null;
  }
  if (typeof chrome !== "undefined" && chrome.alarms) {
    chrome.alarms.clear(HEARTBEAT_ALARM_NAME).catch(() => { });
    chrome.alarms.clear(STOP_DEBOUNCE_ALARM_NAME).catch(() => { });
  }

  const performStop = () => {
    countCcbpTabs((finalCount) => {
      if (finalCount === 0) {
        console.log("[QuizZy Lifecycle] 0 CCBP tabs remain after debounce. Stopping backend...");
        stopBackendDualChannel("zero_ccbp_tabs");
      } else {
        console.log(`[QuizZy Lifecycle] Aborting stop; ${finalCount} CCBP tab(s) still active.`);
        sendLifecycleHeartbeat(finalCount);
      }
    });
  };

  if (immediate) {
    performStop();
  } else {
    // Schedule stop debounce via setTimeout and chrome.alarms
    ccbpShutdownTimer = setTimeout(() => {
      ccbpShutdownTimer = null;
      performStop();
    }, BACKEND_SHUTDOWN_DEBOUNCE_MS);

    if (typeof chrome !== "undefined" && chrome.alarms) {
      chrome.alarms.create(STOP_DEBOUNCE_ALARM_NAME, {
        when: Date.now() + BACKEND_SHUTDOWN_DEBOUNCE_MS
      });
    }
  }
}

function syncCcbpBackendLifecycle(triggerReason, immediateStop = false) {
  countCcbpTabs((count) => {
    console.log(`[QuizZy Lifecycle] Event '${triggerReason}': ${count} active learning.ccbp.in tab(s).`);
    if (count > 0) {
      ensureBackendRunningForCcbp(triggerReason);
    } else {
      ensureBackendStoppedForCcbp(immediateStop);
    }
  });
}

// 1. Tab Updated Listener: URL changes, loading, completion
if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check if URL or navigation state changed
    if (changeInfo.url || (tab && tab.url && isCcbpUrl(tab.url))) {
      syncCcbpBackendLifecycle("tabs.onUpdated:url");
    }

    if (changeInfo.status === "complete" && tab && tab.url) {
      syncCcbpBackendLifecycle("tabs.onUpdated:complete");

      if (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("chrome-extension://")) {
        return;
      }

      if (isCcbpUrl(tab.url)) {
        chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: ["ccbp_lifecycle_bridge.js", "portal_completion.js"]
        }).catch(() => { });
      }

      try {
        const urlObj = new URL(tab.url);
        const hostname = urlObj.hostname.toLowerCase();
        const defaultAllowed = ["learning.ccbp.in", "127.0.0.1", "localhost", "::1"];
        if (defaultAllowed.includes(hostname)) {
          injectAndToggleFloatingHud(tabId, false, false);
        } else if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(["allowedHosts", "auto_mode_allowlist"], (data) => {
            const allowed = (data.allowedHosts || []).concat(data.auto_mode_allowlist || []);
            if (allowed.includes(hostname)) {
              injectAndToggleFloatingHud(tabId, false, false);
            }
          });
        }
      } catch (_) { }
    }
  });
}

// 2. Tab Created Listener
if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onCreated) {
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab && tab.url && isCcbpUrl(tab.url)) {
      syncCcbpBackendLifecycle("tabs.onCreated");
    }
  });
}

// 3. Tab Removed (Closed) Listener
if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    injectedTabScripts.delete(tabId);
    syncCcbpBackendLifecycle("tabs.onRemoved");
  });
}

// 4. Tab Replaced (Prerendered/Navigated) Listener
if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.onReplaced) {
  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    injectedTabScripts.delete(removedTabId);
    syncCcbpBackendLifecycle("tabs.onReplaced");
  });
}

// 5. Window Removed (Closed) Listener
if (typeof chrome !== "undefined" && chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener((closedWinId) => {
    if (closedWinId === activePopupWindowId) {
      activePopupWindowId = null;
    }
    // When a window closes, immediately check if any CCBP tabs remain
    syncCcbpBackendLifecycle("windows.onRemoved", true);
  });
}

// 6. SPA Route Change Hook: Inject & Wire shortcuts after SPA navigation
if (typeof chrome !== "undefined" && chrome.webNavigation && chrome.webNavigation.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
    if (details && details.tabId && details.url) {
      if (isCcbpUrl(details.url) || (typeof injectedTabScripts !== "undefined" && injectedTabScripts.has(details.tabId))) {
        // Broadcast route change message to active tab contexts so timers/controllers can abort cleanly
        safeSendMessageToTab(details.tabId, {
          action: "QUIZZY_ROUTE_CHANGED",
          url: details.url
        });
      }

      if (isCcbpUrl(details.url)) {
        syncCcbpBackendLifecycle("webNavigation.onHistoryStateUpdated");
        ensureScriptInjected(details.tabId, "__QUIZZY_CCBP_LIFECYCLE_BRIDGE__", "ccbp_lifecycle_bridge.js").catch(() => { });
        ensureScriptInjected(details.tabId, "__QUIZZY_PORTAL_LOADED__", "portal_completion.js").catch(() => { });
      }
      try {
        const urlObj = new URL(details.url);
        const hostname = urlObj.hostname.toLowerCase();
        const defaultAllowed = ["learning.ccbp.in", "127.0.0.1", "localhost", "::1"];
        if (defaultAllowed.includes(hostname)) {
          injectAndToggleFloatingHud(details.tabId, false, false);
        } else if (chrome.storage && chrome.storage.local) {
          chrome.storage.local.get(["allowedHosts"], (data) => {
            const allowed = data.allowedHosts || [];
            if (allowed.includes(hostname)) {
              injectAndToggleFloatingHud(details.tabId, false, false);
            }
          });
        }
      } catch (_) { }
    }
  });
}

// 7. Web Navigation Committed Listener
if (typeof chrome !== "undefined" && chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details && details.frameId === 0 && details.tabId) {
      injectedTabScripts.delete(details.tabId);
    }
    if (details && details.url && isCcbpUrl(details.url)) {
      syncCcbpBackendLifecycle("webNavigation.onCommitted");
    }
  });
}

// 8. Browser Startup & Extension Reload Hooks
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    syncCcbpBackendLifecycle("runtime.onStartup");
  });
}

// 9. Extension Install & Update Hook
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    syncCcbpBackendLifecycle("runtime.onInstalled");
  });
}

// 10. Alarm-based durable Heartbeat and Stop-Debounce Listener (MV3 persistence)
if (typeof chrome !== "undefined" && chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM_NAME) {
      countCcbpTabs((count) => {
        if (count > 0) {
          sendLifecycleHeartbeat(count);
        } else {
          ensureBackendStoppedForCcbp(false);
        }
      });
    } else if (alarm.name === STOP_DEBOUNCE_ALARM_NAME) {
      countCcbpTabs((count) => {
        if (count === 0) {
          stopBackendDualChannel("stop_debounce_alarm");
        }
      });
    }
  });
}

// Initial lifecycle synchronization on service worker load
syncCcbpBackendLifecycle("worker_init");

// Browser-Level Keyboard Shortcut Command Router (Alt+S, Alt+A, Alt+N, Alt+M)
async function handleUnifiedCommand(command, targetTab) {
  if (!targetTab || !targetTab.id) return { success: false, error: "No target tab" };
  const tabId = targetTab.id;
  const tabUrl = (targetTab.url || "").toLowerCase();

  // Guard against browser internal pages
  if (tabUrl.startsWith("chrome://") || tabUrl.startsWith("edge://") || tabUrl.startsWith("chrome-extension://")) {
    return { success: false, error: "Internal browser page" };
  }

  // 0. If side panel is open, all shortcuts route to the side panel!
  if (isSidePanelOpen) {
    try {
      safeSendMessageToRuntime({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command });
      return { success: true, forwarded_to_sidepanel: true };
    } catch (_) { }
  }

  // 1. Try sending the shortcut action directly to the tab (handled by floating_hud.js)
  try {
    const tabRes = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { action: "SHORTCUT_ACTION", command }, (res) => {
        if (chrome.runtime.lastError || !res) {
          resolve(null);
        } else {
          resolve(res);
        }
      });
    });

    if (tabRes && (tabRes.handled || tabRes.success)) {
      return tabRes;
    }
  } catch (_) { }

  // 2. Check if this is a dedicated proctored coding route
  const isCoding = tabUrl.includes("/question/") || tabUrl.includes("/coding/");
  if (isCoding) {
    if (command === "trigger_solve") {
      return handleTriggerSolve({ tabId }, targetTab);
    } else if (command === "trigger_apply") {
      return handleTriggerApply({ tabId }, targetTab);
    } else if (command === "trigger_auto_loop" || command === "trigger_auto") {
      return handleTriggerAutoLoop({ tabId }, targetTab);
    } else if (command === "open_popup_hud") {
      return handleOpenPopupHud({ force: true }, targetTab);
    }
  }

  // 3. For quiz routes where floating HUD is not yet injected or not ready:
  if (command === "open_popup_hud") {
    return injectAndToggleFloatingHud(tabId, true);
  }

  // Inject extractor, executor, and HUD
  await injectAndToggleFloatingHud(tabId, false);

  // Forward the shortcut action to the newly injected HUD
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "SHORTCUT_ACTION", command }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { success: true });
    });
  });
}

if (typeof chrome !== "undefined" && chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    try {
      const activeTab = await resolveTargetTab(null, null);
      if (!activeTab || !activeTab.id) return;
      await handleUnifiedCommand(command, activeTab);
    } catch (err) {
      console.warn("[QuizZy Service Worker] Command execution error:", err);
    }
  });
}

// Async Handler: Open Out-of-Page Popup HUD
async function handleOpenPopupHud(message, targetTab) {
  if (!message || message.autoTriggered || message.auto || !message.force) {
    return { success: true, suppressed: true, message: "Auto-popup suppressed" };
  }
  const popupUrl = chrome.runtime.getURL("sidepanel.html?mode=popup");
  if (chrome.windows && chrome.windows.create) {
    if (activePopupWindowId && chrome.windows.get) {
      return new Promise((resolve) => {
        chrome.windows.get(activePopupWindowId, (existingWin) => {
          if (chrome.runtime.lastError || !existingWin) {
            chrome.windows.create({
              url: popupUrl,
              type: "popup",
              width: 420,
              height: 640,
              focused: true
            }, (win) => {
              activePopupWindowId = win ? win.id : null;
              resolve({ success: true, windowId: activePopupWindowId });
            });
          } else {
            if (chrome.windows.update) {
              chrome.windows.update(activePopupWindowId, { focused: true }, () => {
                resolve({ success: true, windowId: activePopupWindowId, existing: true });
              });
            } else {
              resolve({ success: true, windowId: activePopupWindowId, existing: true });
            }
          }
        });
      });
    } else {
      return new Promise((resolve) => {
        chrome.windows.create({
          url: popupUrl,
          type: "popup",
          width: 420,
          height: 640,
          focused: true
        }, (win) => {
          activePopupWindowId = win ? win.id : null;
          resolve({ success: true, windowId: activePopupWindowId });
        });
      });
    }
  } else {
    return { success: false, error: "chrome.windows.create not available" };
  }
}

// Async Handler: Trigger Unified Solve & Auto-Write into Monaco Editor
async function handleTriggerSolve(message, targetTab) {
  if (!targetTab || !targetTab.id) {
    return { success: false, error: "No target tab found." };
  }
  const tabId = targetTab.id;
  updateActionBadge("...", "#2563EB", tabId);

  try {
    // Step 1: Read code editor state from MAIN world
    const editorRes = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      func: readCodeFromMainWorld
    });
    const editorData = editorRes && editorRes[0] ? editorRes[0].result : {};

    // Step 2: Extract problem description from tab
    const extractRes = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "ISOLATED",
      func: () => {
        if (typeof window.QuizZyExtractor !== "undefined" && typeof window.QuizZyExtractor.extractCodingProblem === "function") {
          return window.QuizZyExtractor.extractCodingProblem();
        }
        if (typeof window.QuizZyExtractor !== "undefined" && typeof window.QuizZyExtractor.extractCodingQuestionFromDom === "function") {
          return window.QuizZyExtractor.extractCodingQuestionFromDom();
        }
        return { question: (document.body ? document.body.innerText : "").slice(0, 3000), language: "python", starter_code: "" };
      }
    });
    const extractData = extractRes && extractRes[0] ? extractRes[0].result : {};

    const effectiveLang = editorData.language || extractData.language || "cpp";
    const effectiveStarter = editorData.code || extractData.starter_code || "";
    const problemStatement = extractData.question || "Coding Practice Problem";

    const solvePayload = {
      subject: "Coding Practice",
      q_type: "code",
      question: problemStatement,
      language: effectiveLang,
      starter_code: effectiveStarter,
      options: []
    };

    // Step 3: Solve Attempt 1 via backend
    const solveRes = await fetch(`${BACKEND_BASE_URL}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(solvePayload)
    });
    if (!solveRes.ok) {
      updateActionBadge("ERR", "#DC2626", tabId);
      setTimeout(() => updateActionBadge("", "", tabId), 4000);
      throw new Error(`Backend solve failed with HTTP ${solveRes.status}`);
    }
    const solveJson = await solveRes.json();
    const codeToApply = solveJson.answer || solveJson.code || solveJson.selected_text || "";
    if (!codeToApply || typeof codeToApply !== "string" || !codeToApply.trim()) {
      updateActionBadge("ERR", "#DC2626", tabId);
      setTimeout(() => updateActionBadge("", "", tabId), 4000);
      return { success: false, error: "Backend solver returned empty code solution." };
    }

    // Cache last solved code in storage so Alt+A can re-apply anytime
    chrome.storage.local.set({ lastSolvedCode: codeToApply });

    // Step 3b: Badge indicates writing into black editor
    updateActionBadge("WRT", "#D97706", tabId);

    // Write Attempt 1 Code into Editor in MAIN World
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        func: writeCodeWithHumanTypingInMainWorld,
        args: [{
          code: codeToApply,
          language: effectiveLang,
          starter_code: effectiveStarter
        }]
      });
    } catch (wErr) {
      console.warn("[QuizZy] MAIN world Attempt 1 typing error:", wErr);
    }

    // Step 4: Execute autoCompileAndSubmitLoop in ISOLATED world with self-healing retry callback
    const loopRes = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "ISOLATED",
      func: async (attempt1Code, probText, lang, starter) => {
        if (typeof window.QuizZyExecutor !== "undefined" && typeof window.QuizZyExecutor.autoCompileAndSubmitLoop === "function") {
          const res = await window.QuizZyExecutor.autoCompileAndSubmitLoop({
            code: attempt1Code,
            question: probText,
            language: lang,
            starter_code: starter
          }, (retryPayload) => {
            return new Promise((resolve) => {
              chrome.runtime.sendMessage({
                action: "SOLVE_REQUEST",
                payload: Object.assign({
                  subject: "Coding Practice",
                  q_type: "code",
                  question: probText || "Coding Practice Problem",
                  language: lang,
                  starter_code: starter
                }, retryPayload)
              }, (response) => {
                if (chrome.runtime.lastError) {
                  resolve(null);
                  return;
                }
                resolve(response && response.data ? response.data : null);
              });
            });
          });
          return res;
        }
        return { success: false, error: "QuizZyExecutor not available in tab" };
      },
      args: [codeToApply, problemStatement, effectiveLang, effectiveStarter]
    });

    const loopResult = loopRes && loopRes[0] ? loopRes[0].result : null;
    const isSuccess = loopResult && (loopResult.status === "success" || loopResult.passed || loopResult.success);
    if (isSuccess) {
      updateActionBadge("OK", "#16A34A", tabId);
      setTimeout(() => updateActionBadge("", "", tabId), 4000);
    } else {
      updateActionBadge("ERR", "#DC2626", tabId);
      setTimeout(() => updateActionBadge("", "", tabId), 4000);
    }

    return { success: true, solved: true, solution: solveJson, loopResult: loopResult };
  } catch (err) {
    updateActionBadge("ERR", "#DC2626", tabId);
    setTimeout(() => updateActionBadge("", "", tabId), 4000);
    return { success: false, error: err.message };
  }
}

// Async Handler: Trigger Apply Code (Alt+A) with auto-fallback to solve
async function handleTriggerApply(message, targetTab) {
  if (!targetTab || !targetTab.id) {
    return { success: false, error: "No target tab found." };
  }
  const tabId = targetTab.id;

  return new Promise((resolve) => {
    chrome.storage.local.get(["lastSolvedCode"], async (data) => {
      const code = data.lastSolvedCode;
      if (!code) {
        // Fallback: If no code cached yet, automatically trigger solve & write!
        const solveRes = await handleTriggerSolve(message, targetTab);
        resolve(solveRes);
        return;
      }

      updateActionBadge("WRT", "#D97706", tabId);
      try {
        const writeRes = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          world: "MAIN",
          func: writeCodeWithHumanTypingInMainWorld,
          args: [{ code }]
        });
        updateActionBadge("OK", "#16A34A", tabId);
        setTimeout(() => updateActionBadge("", "", tabId), 4000);
        resolve({ success: true, applied: true, result: writeRes && writeRes[0] ? writeRes[0].result : null });
      } catch (err) {
        updateActionBadge("ERR", "#DC2626", tabId);
        setTimeout(() => updateActionBadge("", "", tabId), 4000);
        resolve({ success: false, error: err.message });
      }
    });
  });
}

// Async Handler: Trigger Auto Loop (Alt+N)
let isCodingAutoAborted = false;
async function handleTriggerAutoLoop(message, targetTab) {
  if (!targetTab || !targetTab.id) {
    return { success: false, error: "No target tab found." };
  }
  isCodingAutoAborted = false;
  const tabId = targetTab.id;
  updateActionBadge("WRT", "#D97706", tabId);

  try {
    if (isCodingAutoAborted) return { success: false, aborted: true, error: "Auto Mode stopped by user" };
    let codeToApply = (message && message.code) || (message && message.payload && message.payload.code) || "";

    const editorRes = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "MAIN",
      func: readCodeFromMainWorld
    });
    const editorData = editorRes && editorRes[0] ? editorRes[0].result : {};

    const extractRes = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "ISOLATED",
      func: () => {
        if (typeof window.QuizZyExtractor !== "undefined" && typeof window.QuizZyExtractor.extractCodingProblem === "function") {
          return window.QuizZyExtractor.extractCodingProblem();
        }
        if (typeof window.QuizZyExtractor !== "undefined" && typeof window.QuizZyExtractor.extractCodingQuestionFromDom === "function") {
          return window.QuizZyExtractor.extractCodingQuestionFromDom();
        }
        return { question: (document.body ? document.body.innerText : "").slice(0, 3000), language: "python", starter_code: "" };
      }
    });
    const extractData = extractRes && extractRes[0] ? extractRes[0].result : {};

    const effectiveLang = editorData.language || extractData.language || "cpp";
    const effectiveStarter = editorData.code || extractData.starter_code || "";
    const problemStatement = extractData.question || "Coding Practice Problem";

    if (!codeToApply) {
      const stored = await new Promise(r => chrome.storage.local.get(["lastSolvedCode"], r));
      if (stored && stored.lastSolvedCode) {
        codeToApply = stored.lastSolvedCode;
      }
    }

    if (!codeToApply) {
      updateActionBadge("...", "#2563EB", tabId);
      const solveRes = await fetch(`${BACKEND_BASE_URL}/solve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Coding Practice",
          q_type: "code",
          question: problemStatement,
          language: effectiveLang,
          starter_code: effectiveStarter,
          options: []
        })
      });
      if (!solveRes.ok) {
        updateActionBadge("ERR", "#DC2626", tabId);
        setTimeout(() => updateActionBadge("", "", tabId), 4000);
        throw new Error(`Backend solve failed with HTTP ${solveRes.status}`);
      }
      const solveJson = await solveRes.json();
      codeToApply = solveJson.answer || solveJson.code || solveJson.selected_text || "";
      if (codeToApply) {
        chrome.storage.local.set({ lastSolvedCode: codeToApply });
      }
    }

    if (!codeToApply) {
      updateActionBadge("ERR", "#DC2626", tabId);
      setTimeout(() => updateActionBadge("", "", tabId), 4000);
      return { success: false, error: "No code available for auto-loop" };
    }

    if (isCodingAutoAborted) return { success: false, aborted: true, error: "Auto Mode stopped by user" };

    updateActionBadge("WRT", "#D97706", tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        func: writeCodeWithHumanTypingInMainWorld,
        args: [{
          code: codeToApply,
          language: effectiveLang,
          starter_code: effectiveStarter
        }]
      });
    } catch (_) { }

    const loopRes = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: "ISOLATED",
      func: async (attempt1Code, probText, lang, starter) => {
        if (typeof window.QuizZyExecutor !== "undefined" && typeof window.QuizZyExecutor.autoCompileAndSubmitLoop === "function") {
          return await window.QuizZyExecutor.autoCompileAndSubmitLoop({
            code: attempt1Code,
            question: probText,
            language: lang,
            starter_code: starter
          }, (retryPayload) => {
            return new Promise((resolve) => {
              chrome.runtime.sendMessage({
                action: "SOLVE_REQUEST",
                payload: Object.assign({
                  subject: "Coding Practice",
                  q_type: "code",
                  question: probText || "Coding Practice Problem",
                  language: lang,
                  starter_code: starter
                }, retryPayload)
              }, (response) => {
                if (chrome.runtime.lastError) {
                  resolve(null);
                  return;
                }
                resolve(response && response.data ? response.data : null);
              });
            });
          });
        }
        return { success: false, error: "QuizZyExecutor not available in tab" };
      },
      args: [codeToApply, problemStatement, effectiveLang, effectiveStarter]
    });

    const loopResult = loopRes && loopRes[0] ? loopRes[0].result : null;
    const isSuccess = loopResult && (loopResult.status === "success" || loopResult.passed || loopResult.success);
    if (isSuccess) {
      updateActionBadge("OK", "#16A34A", tabId);
      setTimeout(() => updateActionBadge("", "", tabId), 4000);
    } else {
      updateActionBadge("ERR", "#DC2626", tabId);
      setTimeout(() => updateActionBadge("", "", tabId), 4000);
    }

    return { success: true, loopResult: loopResult };
  } catch (err) {
    updateActionBadge("ERR", "#DC2626", tabId);
    setTimeout(() => updateActionBadge("", "", tabId), 4000);
    return { success: false, error: err.message };
  }
}

// Native Messaging Helper for Backend Launching
function startBackendNative(callback) {
  startBackendDualChannel("manual_call").then((res) => {
    if (callback) callback(res || { success: true, status: "started" });
  }).catch((err) => {
    if (callback) callback({ success: false, error: err.message });
  });
}

// Native Messaging Helper for Backend Termination
function stopBackendNative(callback) {
  stopBackendDualChannel("manual_call").then((res) => {
    if (callback) callback(res || { success: true, status: "stopped" });
  }).catch((err) => {
    if (callback) callback({ success: false, error: err.message });
  });
}

// ==========================================================================
// Global Runtime Message Router
// ==========================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || (!message.action && !message.type)) {
    return false;
  }

  const action = message.action || message.type;

  if (action === "QUIZZY_SOFT_REFRESH_EXTENSION" || message.type === "QUIZZY_SOFT_REFRESH_EXTENSION") {
    _bgInFlightSolves.clear();
    _bgRecent429Signatures.clear();

    const targetTabId = (sender && sender.tab && sender.tab.id) || message.tabId;
    if (targetTabId && typeof injectedTabScripts !== "undefined" && injectedTabScripts.has(targetTabId)) {
      injectedTabScripts.delete(targetTabId);
    }

    try {
      fetch("http://127.0.0.1:8000/api/reset-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }).catch(() => { });
    } catch (_) { }

    try {
      safeSendMessageToRuntime({ type: "QUIZZY_TRIM_SIDEPANEL_LOGS", maxEntries: 15 });
    } catch (_) { }

    sendResponse({ success: true, refreshed: true });
    return false;
  }

  if (action === "QUIZZY_PERFORM_SOFT_RECYCLE" || action === "QUIZZY_RESET_QUESTION_STATE" || message.type === "QUIZZY_PERFORM_SOFT_RECYCLE") {
    const now = Date.now();
    for (const [key, ts] of _bgRecent429Signatures.entries()) {
      if (now - ts > 2500) _bgRecent429Signatures.delete(key);
    }
    while (_bgRecent429Signatures.size > 20) {
      const oldest = _bgRecent429Signatures.keys().next().value;
      if (oldest) _bgRecent429Signatures.delete(oldest);
      else break;
    }

    _bgInFlightSolves.clear();

    try {
      safeSendMessageToRuntime({ type: "QUIZZY_TRIM_SIDEPANEL_LOGS", maxEntries: 15 });
    } catch (_) { }

    sendResponse({ success: true, recycled: true });
    return false;
  }

  // Instant CCBP Page Active / Heartbeat / Unload signals from content script
  if (action === "CCBP_PAGE_ACTIVE" || action === "CCBP_PAGE_HEARTBEAT") {
    if (ccbpShutdownTimer) {
      clearTimeout(ccbpShutdownTimer);
      ccbpShutdownTimer = null;
    }
    if (typeof chrome !== "undefined" && chrome.alarms) {
      chrome.alarms.clear(STOP_DEBOUNCE_ALARM_NAME).catch(() => { });
    }
    sendLifecycleHeartbeat(1);
    ensureBackendRunningForCcbp(action === "CCBP_PAGE_HEARTBEAT" ? "content_script_heartbeat" : "message:CCBP_PAGE_ACTIVE");
    sendResponse({ success: true, active: true, backend_healthy: Boolean(isBackendRunning) });
    return false;
  }
  if (action === "CCBP_PAGE_HIDE" || action === "CCBP_PAGE_UNLOAD") {
    ensureBackendStoppedForCcbp(false); // starts 3-second debounce check
    sendResponse({ success: true, hidden: true, unloading: true });
    return false;
  }

  // 0. Sidepanel state queries and mutual exclusivity commands
  if (action === "STOP_AUTO" || action === "KILL_SWITCH_TRIGGERED") {
    isCodingAutoAborted = true;
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (targetTab && targetTab.id) {
        chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "ISOLATED",
          func: () => {
            if (typeof window.QuizZyExecutor !== "undefined" && typeof window.QuizZyExecutor.abortCodingAutomation === "function") {
              window.QuizZyExecutor.abortCodingAutomation();
            }
          }
        }).catch(() => { });
      }
    }).catch(() => { });
    const targetTabId = (sender && sender.tab) ? sender.tab.id : undefined;
    updateActionBadge("", "", targetTabId);
    sendResponse({ success: true, stopped: true });
    return false;
  }
  if (action === "GET_SIDEPANEL_STATE") {
    sendResponse({ success: true, isOpen: isSidePanelOpen });
    return false;
  }
  if (action === "CLOSE_SIDEPANEL") {
    isSidePanelOpen = false;
    safeSendMessageToRuntime({ action: "CLOSE_SIDEPANEL_COMMAND" });
    if (activePopupWindowId && chrome.windows && chrome.windows.remove) {
      chrome.windows.remove(activePopupWindowId).catch(() => { });
      activePopupWindowId = null;
    }
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, (tabs) => {
        if (!tabs || !Array.isArray(tabs)) return;
        for (const t of tabs) {
          if (t && t.id) {
            const hasScript = (typeof injectedTabScripts !== "undefined" && injectedTabScripts.has(t.id)) || (t.url && isCcbpUrl(t.url));
            if (hasScript) {
              safeSendMessageToTab(t.id, { action: "SIDEPANEL_STATE_CHANGED", isOpen: false });
            }
          }
        }
      });
    }
    sendResponse({ success: true, closed: true });
    return false;
  }
  if (action === "FORWARD_SHORTCUT_TO_SIDEPANEL") {
    safeSendMessageToRuntime({
      action: "FORWARD_SHORTCUT_TO_SIDEPANEL",
      command: message.command,
      key: message.key,
      code: message.code
    });
    sendResponse({ success: true, forwarded: true });
    return false;
  }

  // 1. Health check to local backend
  if (action === "CHECK_HEALTH") {
    fetch(`${BACKEND_BASE_URL}/health`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        isBackendRunning = true;
        sendResponse({ success: true, data });
      })
      .catch((err) => {
        isBackendRunning = false;
        sendResponse({ success: false, error: err.message });
      });
    return true; // asynchronous response
  }

  // 1b. Start local backend server via Native Messaging Host
  if (action === "START_BACKEND") {
    startBackendNative((res) => {
      sendResponse(res);
    });
    return true; // asynchronous response
  }

  // 1c. Stop local backend server via Native Messaging Host
  if (action === "STOP_BACKEND") {
    stopBackendNative((res) => {
      sendResponse(res);
    });
    return true; // asynchronous response
  }

  // 2. Proxy solve request to local backend
  if (action === "SOLVE_REQUEST") {
    // Authoritative pre-flight payload validation guard
    if (!isValidExtractedQuestion(message.payload)) {
      sendResponse({
        success: false,
        error: "Invalid question: stem is empty or insufficient options"
      });
      return false;
    }

    const payload = Object.assign({}, message.payload);

    // SVG Guard: Never send SVG XML to vision backend
    if (payload.image_data && typeof payload.image_data === "string" && payload.image_data.startsWith("data:image/svg")) {
      delete payload.image_data;
    }

    if (payload.image_url) {
      payload.image_url = decodePotentialUrl(payload.image_url);
    }
    if (!payload.image_url && payload.question) {
      const imgMatch = payload.question.match(/\[Image:\s*(https?:\/\/[^\s\]]+|https?%3A[^\s\]]+)\]/i);
      if (imgMatch && imgMatch[1]) {
        payload.image_url = decodePotentialUrl(imgMatch[1]);
      }
    }

    const qStem = (payload.question || payload.stem || "").trim();
    const qOpts = Array.isArray(payload.options) ? payload.options.join("|") : "";
    const qSig = `${payload.subject || "General"}::${qStem}::${qOpts}`;

    // 10s Rate Limit Cooldown Guard
    const last429 = _bgRecent429Signatures.get(qSig);
    if (last429 && (Date.now() - last429 < 2500)) {
      sendResponse({
        success: false,
        status: 429,
        error: "Rate limit cooldown active (waiting 2.5s before retry)"
      });
      return false;
    }

    // Coalesce concurrent duplicate solve requests for the exact same question
    if (_bgInFlightSolves.has(qSig)) {
      _bgInFlightSolves.get(qSig).push(sendResponse);
      return true;
    }

    const callbacks = [sendResponse];
    _bgInFlightSolves.set(qSig, callbacks);

    const dispatchAll = (resObj) => {
      _bgInFlightSolves.delete(qSig);
      if (resObj && (resObj.status === 429 || (resObj.error && String(resObj.error).includes("429")))) {
        recordRecent429Signature(qSig);
      }
      for (const cb of callbacks) {
        try { cb(resObj); } catch (_) { }
      }
    };

    const executeSolveFetch = () => {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 22000) : null;

      fetch(`${BACKEND_BASE_URL}/solve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      })
        .then(async (res) => {
          if (timeoutId) clearTimeout(timeoutId);
          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            dispatchAll({
              success: false,
              status: res.status,
              error: errorData.detail || `Server error (${res.status})`
            });
            return;
          }
          const data = await res.json();
          dispatchAll({ success: true, data });
        })
        .catch((err) => {
          if (timeoutId) clearTimeout(timeoutId);
          dispatchAll({
            success: false,
            error: `Cannot reach QuizZy backend at ${BACKEND_BASE_URL}. Ensure it is running. (${err.message})`
          });
        });
    };

    // CORS-Proof Service Worker Base64 Image Hydrator
    async function hydrateQuestionImage(extracted, tabId) {
      if (!extracted) return extracted;

      // 1. Already Hydrated check
      if (extracted.image_data && typeof extracted.image_data === "string" && extracted.image_data.startsWith("data:image/")) {
        return extracted;
      }

      // 2. Service Worker Privileged Fetch (Primary)
      let rawUrl = extracted.image_url;
      if (!rawUrl && extracted.question) {
        const match = extracted.question.match(/\[Image:\s*(https?:\/\/[^\s\]]+|https?%3A[^\s\]]+)\]/i);
        if (match && match[1]) rawUrl = match[1].trim();
      }
      if (rawUrl && typeof rawUrl === "string") {
        rawUrl = decodePotentialUrl(rawUrl);
      }

      if (rawUrl && (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) && typeof fetch === "function") {
        try {
          const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
          const timeoutId = controller ? setTimeout(() => controller.abort(), 2500) : null;
          const res = await fetch(rawUrl, { signal: controller ? controller.signal : undefined });
          if (timeoutId) clearTimeout(timeoutId);
          if (res && res.ok) {
            const blob = await res.blob();
            const base64Data = await new Promise((resolve) => {
              if (typeof FileReader !== "undefined") {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              } else {
                resolve(null);
              }
            });
            if (base64Data && typeof base64Data === "string" && base64Data.startsWith("data:image/")) {
              extracted.image_data = base64Data;
              return extracted;
            }
          }
        } catch (_) { }
      }

      // 3. Visible Tab Crop Fallback (100% Guarantee for canvas, svg, blob, or failed fetch)
      const bbox = extracted.image_bbox || (extracted.meta && (extracted.meta.image_bbox || extracted.meta.visual_bounding_box));
      const hasValidBbox = bbox && typeof bbox.width === "number" && typeof bbox.height === "number" && bbox.width >= 36 && bbox.height >= 36;
      const isDiagramQuestion = hasValidBbox || (extracted.question && /\b(figure|triangle|triangles|diagram|graph|image|shown below|given below)\b/i.test(extracted.question));

      if (!extracted.image_data && (hasValidBbox || isDiagramQuestion) && typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.captureVisibleTab === "function") {
        try {
          let targetWindowId = null;
          if (typeof tabId === "number") {
            try {
              const tInfo = await new Promise(r => chrome.tabs.get(tabId, r));
              if (tInfo && tInfo.windowId) targetWindowId = tInfo.windowId;
            } catch (_) { }
          } else if (tabId && typeof tabId === "object" && tabId.windowId) {
            targetWindowId = tabId.windowId;
          }
          const dataUrl = await new Promise((resolve) => {
            chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" }, (res) => {
              if (chrome.runtime.lastError || !res) resolve(null);
              else resolve(res);
            });
          });

          if (dataUrl) {
            if (hasValidBbox && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function") {
              try {
                const dpr = bbox.dpr || 1;
                const resp = await fetch(dataUrl);
                const blob = await resp.blob();
                const bitmap = await createImageBitmap(blob);

                const origX = bbox.x !== undefined ? bbox.x : (bbox.left || 0);
                const origY = bbox.y !== undefined ? bbox.y : (bbox.top || 0);

                const cropX = Math.max(0, Math.min(Math.round(origX * dpr), bitmap.width - 1));
                const cropY = Math.max(0, Math.min(Math.round(origY * dpr), bitmap.height - 1));
                const cropW = Math.min(Math.round(bbox.width * dpr), bitmap.width - cropX);
                const cropH = Math.min(Math.round(bbox.height * dpr), bitmap.height - cropY);

                if (cropW >= 36 && cropH >= 36) {
                  const canvas = new OffscreenCanvas(cropW, cropH);
                  const ctx = canvas.getContext("2d");
                  ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
                  const croppedBlob = await canvas.convertToBlob({ type: "image/png" });
                  const croppedB64 = await new Promise((resolve) => {
                    if (typeof FileReader !== "undefined") {
                      const reader = new FileReader();
                      reader.onloadend = () => resolve(reader.result);
                      reader.onerror = () => resolve(null);
                      reader.readAsDataURL(croppedBlob);
                    } else {
                      resolve(null);
                    }
                  });
                  if (croppedB64 && typeof croppedB64 === "string" && croppedB64.startsWith("data:image/")) {
                    extracted.image_data = croppedB64;
                    return extracted;
                  }
                }
              } catch (_) { }
            }
            extracted.image_data = dataUrl;
          }
        } catch (_) { }
      }

      return extracted;
    }

    const resolveEffectiveTabId = async () => {
      if (sender && sender.tab && sender.tab.id) return sender.tab.id;
      try {
        const targetTab = await resolveTargetTab(message, sender);
        return targetTab ? targetTab.id : null;
      } catch (_) {
        return null;
      }
    };

    resolveEffectiveTabId().then((effTabId) => {
      hydrateQuestionImage(payload, effTabId).then(() => {
        executeSolveFetch();
      }).catch(() => {
        executeSolveFetch();
      });
    });
    return true; // asynchronous response
  }

  // 3. Extract quiz from active tab DOM
  if (action === "EXTRACT_QUIZ") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found in current window." });
        return;
      }
      const tabId = targetTab.id;
      const url = targetTab.url || "";

      // Check for restricted URLs (chrome://, edge://, etc.)
      if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
        sendResponse({
          success: false,
          error: "Cannot run DOM extraction on internal browser management pages (" + url + ")."
        });
        return;
      }

      try {
        await ensureScriptInjected(tabId, "__QUIZZY_EXTRACTOR_LOADED__", "extractor.js");

        let extractionResult = null;

        const hasCustomParams = (message.customSelectors && Object.keys(message.customSelectors).length > 0) ||
          (message.forcedQType && message.forcedQType !== "auto");

        if (!extractionResult || hasCustomParams) {
          const executionResults = await chrome.scripting.executeScript({
            target: { tabId },
            world: "ISOLATED",
            func: (customSelectors, forcedQType) => {
              const ext = window.QuizZyExtractor || window.__QuizZyExtractor;
              if (ext && typeof ext.extractQuizFromDom === "function") {
                return ext.extractQuizFromDom(customSelectors, forcedQType);
              }
              if (window.__QUIZZY_LAST_EXTRACTION__) {
                return window.__QUIZZY_LAST_EXTRACTION__;
              }
              return { success: false, error: "QuizZyExtractor was not found in the active tab context." };
            },
            args: [message.customSelectors || {}, message.forcedQType || "auto"]
          });

          if (executionResults && executionResults[0] && executionResults[0].result) {
            extractionResult = executionResults[0].result;
          }

          if (!extractionResult || !extractionResult.success || !isValidExtractedQuestion(extractionResult)) {
            await new Promise((r) => setTimeout(r, 220));
            const retrySelectors = Object.assign({}, message.customSelectors || {}, { relaxScrollBounds: true });
            const retryResults = await chrome.scripting.executeScript({
              target: { tabId },
              world: "ISOLATED",
              func: (customSelectors, forcedQType) => {
                const ext = window.QuizZyExtractor || window.__QuizZyExtractor;
                if (ext && typeof ext.extractQuizFromDom === "function") {
                  return ext.extractQuizFromDom(customSelectors, forcedQType);
                }
                return { success: false, error: "QuizZyExtractor was not found in the active tab context." };
              },
              args: [retrySelectors, message.forcedQType || "auto"]
            });
            if (retryResults && retryResults[0] && retryResults[0].result) {
              extractionResult = retryResults[0].result;
            }
          }
        }

        if (extractionResult) {
          sendResponse(extractionResult);
        } else {
          sendResponse({ success: false, error: "Extraction returned an empty or invalid result." });
        }
      } catch (err) {
        sendResponse({ success: false, error: `Script execution error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // asynchronous response
  }

  // 4. Opt-in DOM highlight on active tab
  if (action === "APPLY_HIGHLIGHT" || action === "APPLY_DOM_HIGHLIGHT") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }
      const tabId = targetTab.id;
      try {
        await ensureScriptInjected(tabId, "__QUIZZY_EXTRACTOR_LOADED__", "extractor.js");

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: (payload) => {
            if (window.QuizZyExtractor && typeof window.QuizZyExtractor.applyDomHighlight === "function") {
              return window.QuizZyExtractor.applyDomHighlight(payload);
            }
            return { success: false, error: "QuizZyExtractor not available." };
          },
          args: [message.payload || {}]
        });

        sendResponse(results && results[0] ? results[0].result : { success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 5. Query active tab information (for per-hostname settings & allowlist)
  if (action === "GET_ACTIVE_TAB") {
    resolveTargetTab(message, sender).then((targetTab) => {
      if (targetTab) {
        sendResponse({
          success: true,
          tab: { id: targetTab.id, url: targetTab.url || "", title: targetTab.title || "" }
        });
      } else {
        sendResponse({ success: false, error: "No active tab found." });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 6. Execute Quiz Action (Auto Mode or Single-Step Apply)
  if (action === "EXECUTE_QUIZ_ACTION" || action === "EXECUTE_ACTION") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found for action execution." });
        return;
      }
      const tabId = targetTab.id;
      try {
        await ensureScriptInjected(tabId, "__QUIZZY_EXECUTOR_LOADED__", "executor.js");

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: async (payload) => {
            const exec = window.QuizZyExecutor || window.__QuizZyExecutor;
            if (exec && (typeof exec.executeQuizAction === "function" || typeof exec.executeAction === "function")) {
              const fn = exec.executeQuizAction || exec.executeAction;
              return await fn.call(exec, payload);
            }
            return { success: false, error: "QuizZyExecutor not loaded in tab." };
          },
          args: [message.payload || {}]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "Empty action execution." });
      } catch (err) {
        sendResponse({ success: false, error: `Action execution error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 7. Click Next / Advance Button
  if (action === "CLICK_NEXT_BUTTON") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found for Next button click." });
        return;
      }
      const tabId = targetTab.id;
      try {
        await ensureScriptInjected(tabId, "__QUIZZY_EXECUTOR_LOADED__", "executor.js");

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: async (customNextSelector) => {
            const exec = window.QuizZyExecutor || window.__QuizZyExecutor;
            if (exec && typeof exec.clickNextButton === "function") {
              return await window.QuizZyExecutor.clickNextButton(customNextSelector);
            }
            return { success: false, error: "QuizZyExecutor not loaded in tab." };
          },
          args: [message.customNextSelector || ""]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "Empty next button result." });
      } catch (err) {
        sendResponse({ success: false, error: `Next button click error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 7b. Click Skip Button (Disabled - QuizZy does not skip questions)
  if (action === "CLICK_SKIP_BUTTON") {
    sendResponse({ success: false, disabled: true, error: "Skipping questions operation is completely disabled." });
    return false;
  }

  // 7c. Swipe or Advance Question (Resilient skip / next / carousel gesture)
  if (action === "SWIPE_OR_ADVANCE") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found for swipe / advance." });
        return;
      }
      const tabId = targetTab.id;
      try {
        await ensureScriptInjected(tabId, "__QUIZZY_EXECUTOR_LOADED__", "executor.js");

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: async (customSelector) => {
            const exec = window.QuizZyExecutor || window.__QuizZyExecutor;
            if (exec && typeof exec.swipeOrAdvanceQuestion === "function") {
              return await exec.swipeOrAdvanceQuestion(customSelector);
            }
            return { success: false, error: "QuizZyExecutor not loaded in tab." };
          },
          args: [message.customSelector || ""]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "Empty swipe/advance result." });
      } catch (err) {
        sendResponse({ success: false, error: `Swipe / advance error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 8. Submit Wrong-Answer Feedback & Overrides
  if (action === "SUBMIT_FEEDBACK") {
    fetch(`${BACKEND_BASE_URL}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload)
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          sendResponse({
            success: false,
            status: res.status,
            error: errData.detail || `Server error (${res.status})`
          });
        } else {
          const data = await res.json();
          sendResponse({ success: true, data });
        }
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // 9. Toggle / Launch Floating HUD on Active Quiz Tab
  if (action === "TOGGLE_FLOATING_HUD" || action === "LAUNCH_FLOATING_HUD" || action === "SHOW_FLOATING_HUD" || action === "INJECT_FLOATING_HUD") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }
      const url = targetTab.url || "";
      if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
        sendResponse({
          success: false,
          error: "Cannot inject Floating HUD on browser internal pages (" + url + ")."
        });
        return;
      }

      try {
        const isExplicitShowOrLaunch = (action === "LAUNCH_FLOATING_HUD" || action === "SHOW_FLOATING_HUD");
        const shouldToggle = isExplicitShowOrLaunch ? false : (message && message.shouldToggle !== false);
        const autoShow = isExplicitShowOrLaunch ? true : (action !== "INJECT_FLOATING_HUD");
        const hudRes = await injectAndToggleFloatingHud(targetTab.id, shouldToggle, autoShow);

        if (hudRes && hudRes.codingMode && (action === "LAUNCH_FLOATING_HUD" || action === "SHOW_FLOATING_HUD" || (message && message.forcePopup))) {
          await handleOpenPopupHud({ force: true }, targetTab);
        }

        sendResponse({ success: true, result: hudRes });
      } catch (err) {
        sendResponse({ success: false, error: `HUD injection error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // asynchronous response
  }

  // 10. Open Out-of-Page Popup HUD (Guarded to prevent automatic unwanted popup windows)
  if (action === "OPEN_POPUP_HUD") {
    // If auto-triggered or not an explicit manual command with force flag, suppress popup creation
    if (!message || message.autoTriggered || message.auto || !message.force) {
      sendResponse({ success: true, suppressed: true, message: "Auto-popup suppressed" });
      return false;
    }
    const popupUrl = chrome.runtime.getURL("sidepanel.html?mode=popup");
    if (chrome.windows && chrome.windows.create) {
      if (activePopupWindowId && chrome.windows.get) {
        chrome.windows.get(activePopupWindowId, (existingWin) => {
          if (chrome.runtime.lastError || !existingWin) {
            chrome.windows.create({
              url: popupUrl,
              type: "popup",
              width: 420,
              height: 640,
              focused: true
            }, (win) => {
              activePopupWindowId = win ? win.id : null;
              sendResponse({ success: true, windowId: activePopupWindowId });
            });
          } else {
            if (chrome.windows.update) {
              chrome.windows.update(activePopupWindowId, { focused: true }, () => {
                sendResponse({ success: true, windowId: activePopupWindowId, existing: true });
              });
            } else {
              sendResponse({ success: true, windowId: activePopupWindowId, existing: true });
            }
          }
        });
      } else {
        chrome.windows.create({
          url: popupUrl,
          type: "popup",
          width: 420,
          height: 640,
          focused: true
        }, (win) => {
          activePopupWindowId = win ? win.id : null;
          sendResponse({ success: true, windowId: activePopupWindowId });
        });
      }
      return true;
    } else {
      sendResponse({ success: false, error: "chrome.windows.create not available" });
      return false;
    }
  }

  // 11. Zero-Tag MAIN World Bridge: Read Full Starter Code & Language from Monaco/Ace
  if (action === "READ_CODE_EDITOR_MAIN") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No target tab found." });
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          func: readCodeFromMainWorld
        });

        const res = results && results[0] ? results[0].result : { success: false, error: "No result" };
        sendResponse(res);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 12. Zero-Tag MAIN World Bridge: Write Solved Code cleanly to Monaco/Ace Model via Paste-Bypass Human Typing Engine
  if (action === "WRITE_CODE_EDITOR_MAIN" || action === "WRITE_CODE_HUMAN_TYPING_MAIN") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No target tab found." });
        return;
      }
      const payload = message.payload || {
        code: message.code,
        preserveBoilerplate: message.preserveBoilerplate !== false,
        language: message.language,
        starter_code: message.starter_code
      };
      if (typeof payload.code !== "string" && typeof message.code === "string") {
        payload.code = message.code;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          func: writeCodeWithHumanTypingInMainWorld,
          args: [payload]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "No result" });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 13. Zero-Tag MAIN World Bridge: React DnD / Fiber Ordering Execution
  if (action === "EXECUTE_REACT_ORDER_MAIN") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No target tab found." });
        return;
      }
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          func: reorderReactListInMainWorld,
          args: [message.payload || {}]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "No result" });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 13b. Zero-Tag MAIN World Bridge: React Multi-Select Checkbox Execution
  if (action === "QUIZZY_MAIN_WORLD_MULTI_SELECT" || action === "EXECUTE_REACT_MULTI_SELECT_MAIN") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, ok: false, error: "No target tab found." });
        return;
      }
      try {
        const payload = message.payload || message;
        const targetIndices = payload.targetIndices || payload.selected_indices || [];
        const targetTexts = payload.targetTexts || payload.selected_texts || [];
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "MAIN",
          func: selectMultiOptionsInMainWorld,
          args: [targetIndices, targetTexts]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, ok: false, error: "No result" });
      } catch (err) {
        sendResponse({ success: false, ok: false, error: err.message });
      }
    }).catch((err) => {
      sendResponse({ success: false, ok: false, error: err.message });
    });
    return true;
  }


  // 14b. Get Current Coding Automation State
  if (action === "GET_CODING_AUTOMATION_STATE") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, state: "IDLE", error: "No target tab found." });
        return;
      }
      try {
        const stateRes = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          world: "ISOLATED",
          func: () => {
            if (typeof window.QuizZyExecutor !== "undefined" && typeof window.QuizZyExecutor.getCodingAutomationState === "function") {
              return window.QuizZyExecutor.getCodingAutomationState();
            }
            return "IDLE";
          }
        });
        const st = stateRes && stateRes[0] ? stateRes[0].result : "IDLE";
        sendResponse({ success: true, state: st });
      } catch (err) {
        sendResponse({ success: false, state: "IDLE", error: err.message });
      }
    }).catch((err) => {
      sendResponse({ success: false, state: "IDLE", error: err.message });
    });
    return true;
  }

  // 14c. Trigger Unified Solve & Self-Healing Coding Loop (Alt+S / UI Solve in Coding Mode)
  if (action === "TRIGGER_SOLVE" || action === "TRIGGER_CODING_SOLVE_AND_APPLY" || action === "START_CODING_AUTOMATION") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      const res = await handleTriggerSolve(message, targetTab);
      sendResponse(res);
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 15. Trigger Apply (Alt+A)
  if (action === "TRIGGER_APPLY" || action === "TRIGGER_CODING_APPLY_ONLY") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      const res = await handleTriggerApply(message, targetTab);
      sendResponse(res);
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 16. Trigger Auto Loop (Alt+N / Double-Tap Shift)
  if (action === "TRIGGER_CODING_AUTO_LOOP") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      const res = await handleTriggerAutoLoop(message, targetTab);
      sendResponse(res);
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 17. Trigger Auto Mode from Web Page / Bridge
  if (action === "TRIGGER_AUTO" || action === "TRIGGER_AUTO_MODE") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (isSidePanelOpen) {
        safeSendMessageToRuntime({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_auto" });
        sendResponse({ success: true, forwarded_to_sidepanel: true });
        return;
      }
      const res = await handleUnifiedCommand("trigger_auto", targetTab);
      sendResponse(res || { success: true });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 18. Portal Completion Toggle & State Synchronization
  if (action === "PORTAL_COMPLETION_TOGGLE") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (targetTab && targetTab.id) {
        if (targetTab.url && (/\/question\/[a-z0-9-]+/i.test(targetTab.url) || /\/assessment\//i.test(targetTab.url))) {
          sendResponse({ success: false, refused: true, reason: "standalone_question_route" });
          return;
        }
        if (typeof chrome !== "undefined" && chrome.scripting && chrome.scripting.executeScript) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: targetTab.id },
              world: "ISOLATED",
              files: ["portal_completion.js"]
            });
          } catch (_) { }
        }
        chrome.tabs.sendMessage(targetTab.id, { action: "PORTAL_COMPLETION_TOGGLE" }, (res) => {
          sendResponse(res || { success: true });
        });
      } else {
        sendResponse({ success: false, error: "No target tab found" });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
  if (action === "PORTAL_COMPLETION_STATE_CHANGED") {
    if (sender && sender.tab && sender.tab.id) {
      safeSendMessageToTab(sender.tab.id, { action: "PORTAL_COMPLETION_STATE_CHANGED", active: Boolean(message.active) });
    }
    sendResponse({ success: true, active: Boolean(message.active) });
    return false;
  }

  return false;
});

// MAIN-world React Fiber DnD reordering implementation (zero script tags injected)
function reorderReactListInMainWorld(payload) {
  if (!payload || !Array.isArray(payload.ordered_texts) || payload.ordered_texts.length < 2) {
    return { success: false, error: "Invalid payload or ordered_texts" };
  }

  const targetTexts = payload.ordered_texts;
  const N = targetTexts.length;

  function cleanStr(s) {
    if (!s) return "";
    let out = String(s)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\1\b/g, "$1")
      .replace(/[⋮⠿∷\u2800-\u28FF\u22EE-\u22F1\u2630\uFE19]+/g, " ")
      .replace(/::+/g, " ")
      .trim();
    for (let i = 0; i < 3; i++) {
      const next = out
        .replace(/^(\d+[\.\)\:]\s*|step\s+\d+(?:[\:\-\.]\s*|\s+))(?=\S)/i, "")
        .replace(/^[1-8](?:[\.\)\:\-\s]+|\s+)(?=[A-Za-z`"'\<\(\$])/, "")
        .replace(/^\(\s*([A-Fa-f0-9]{1,2})\s*\)\s+/, "")
        .replace(/^\[\s*([A-Fa-f0-9]{1,2})\s*\]\s+/, "")
        .replace(/^[A-Fa-f][\.\)\:]\s+/, "")
        .replace(/^[0-9]{1,2}[\.\)]\s+/, "")
        .replace(/^[⋮⠿∷\u2800-\u28FF\u22EE-\u22F1\u2630\uFE19:\s]+/, "")
        .trim();
      if (!next || next === out) break;
      out = next;
    }
    return out.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function extractRowText(el) {
    if (!el) return "";
    try {
      if (typeof el.cloneNode === "function") {
        const clone = el.cloneNode(true);
        if (clone && typeof clone.querySelectorAll === "function") {
          const hiddenMath = clone.querySelectorAll(".katex-mathml, .MJX_Assistive_MathML, math, annotation, script, style, svg");
          for (const hm of hiddenMath) {
            try { hm.remove(); } catch (_) { }
          }
          return cleanStr(clone.textContent || clone.innerText || "");
        }
      }
    } catch (_) { }
    return cleanStr(el.innerText || el.textContent || "");
  }

  // 1. Locate live option row elements in DOM
  let rows = [];
  if (Array.isArray(payload.optionSelectors) && payload.optionSelectors.length > 0) {
    for (const sel of payload.optionSelectors) {
      try {
        const el = document.querySelector(sel);
        if (el && !rows.includes(el)) rows.push(el);
      } catch (_) { }
    }
  }

  if (rows.length !== N) {
    const selectors = [
      "[data-rbd-draggable-id]",
      "[data-rfd-draggable-id]",
      "[draggable='true']",
      ".draggable-item",
      ".sortable-item",
      ".order-item",
      "[aria-roledescription*='sortable' i]"
    ];
    for (const sel of selectors) {
      try {
        const matched = Array.from(document.querySelectorAll(sel));
        if (matched.length >= N) {
          rows = matched.slice(0, N);
          break;
        }
      } catch (_) { }
    }
  }

  if (rows.length === 0) {
    const allDivs = Array.from(document.querySelectorAll("div, li, tr"));
    const matchingDivs = allDivs.filter((el) => {
      const t = extractRowText(el);
      return targetTexts.some((tgt) => cleanStr(tgt) === t);
    });
    const uniqueMatches = [];
    for (const el of matchingDivs) {
      const t = extractRowText(el);
      if (!uniqueMatches.some((u) => extractRowText(u) === t)) {
        uniqueMatches.push(el);
      }
    }
    if (uniqueMatches.length === N) {
      rows = uniqueMatches;
    }
  }

  if (rows.length < 2) {
    return { success: false, error: "Could not locate live order row elements in MAIN world" };
  }

  function getFiber(el) {
    if (!el) return null;
    const key = Object.keys(el).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    return key ? el[key] : null;
  }

  // Check if already in order
  const currentTexts = rows.map(r => extractRowText(r));
  const targetClean = targetTexts.map(cleanStr);
  const isAlreadyMatch = currentTexts.length === N && currentTexts.every((t, i) => {
    if (!t || !targetClean[i]) return false;
    if (t === targetClean[i]) return true;
    const tNorm = t.replace(/[^a-z0-9]/g, "");
    const tgtNorm = targetClean[i].replace(/[^a-z0-9]/g, "");
    if (tNorm && tgtNorm && tNorm === tgtNorm) return true;
    if (tNorm.length >= 8 && tgtNorm.length >= 8 && (tNorm.includes(tgtNorm) || tgtNorm.includes(tNorm))) return true;
    return false;
  });
  if (isAlreadyMatch) {
    return { success: true, already_matched: true, method: "already_correct" };
  }

  const targetOrderIndices = [];
  const usedRowIndices = new Set();
  for (let j = 0; j < N; j++) {
    const tgt = targetClean[j];
    const tgtAlnum = tgt.replace(/[^a-z0-9]/g, "");
    let foundIdx = rows.findIndex((r, idx) => {
      if (usedRowIndices.has(idx)) return false;
      const ct = currentTexts[idx];
      return ct === tgt;
    });
    if (foundIdx === -1) {
      foundIdx = rows.findIndex((r, idx) => {
        if (usedRowIndices.has(idx)) return false;
        const ct = currentTexts[idx];
        const ctAlnum = ct.replace(/[^a-z0-9]/g, "");
        return (ct && tgt && (ct.includes(tgt) || tgt.includes(ct))) ||
          (ctAlnum && tgtAlnum && (ctAlnum === tgtAlnum || ctAlnum.includes(tgtAlnum) || tgtAlnum.includes(ctAlnum)));
      });
    }
    if (foundIdx === -1 && Array.isArray(payload.options) && payload.options.length === N) {
      const optIdx = payload.options.findIndex((opt, idx) => !usedRowIndices.has(idx) && cleanStr(opt) === tgt);
      if (optIdx !== -1) foundIdx = optIdx;
    }
    if (foundIdx === -1) {
      for (let k = 0; k < N; k++) {
        if (!usedRowIndices.has(k)) {
          foundIdx = k;
          break;
        }
      }
    }
    usedRowIndices.add(foundIdx);
    targetOrderIndices.push(foundIdx);
  }

  let fiberCandidate = null;
  for (const r of rows) {
    const f = getFiber(r);
    if (f) {
      fiberCandidate = f;
      break;
    }
  }
  if (!fiberCandidate && rows[0] && rows[0].parentElement) {
    fiberCandidate = getFiber(rows[0].parentElement);
  }

  if (!fiberCandidate) {
    return { success: false, error: "No React Fiber found on order elements" };
  }

  // Walk up Fiber tree
  let curr = fiberCandidate;
  let depth = 0;
  let invokedMethod = null;
  while (curr && depth < 35) {
    const props = curr.memoizedProps;
    if (props && !invokedMethod) {
      // PATH 1A.1 react-sortable-hoc onSortEnd
      if (typeof props.onSortEnd === "function") {
        try {
          let simulatedList = rows.map((_, idx) => idx);
          for (let targetPos = 0; targetPos < N; targetPos++) {
            const desiredRowOriginalIdx = targetOrderIndices[targetPos];
            const currentPos = simulatedList.indexOf(desiredRowOriginalIdx);
            if (currentPos !== -1 && currentPos !== targetPos) {
              props.onSortEnd({
                oldIndex: currentPos,
                newIndex: targetPos,
                collection: 0,
                isKeySorting: false
              });
              const [moved] = simulatedList.splice(currentPos, 1);
              simulatedList.splice(targetPos, 0, moved);
            }
          }
          invokedMethod = "react_sortable_hoc_onSortEnd";
        } catch (err) {
          console.warn("[QuizZy] onSortEnd invocation error:", err);
        }
      }

      // PATH 1A.2 react-beautiful-dnd / @hello-pangea/dnd / @dnd-kit onDragEnd
      if (!invokedMethod && typeof props.onDragEnd === "function") {
        try {
          let droppableId = "droppable";
          const dropEl = document.querySelector("[data-rbd-droppable-id], [data-rfd-droppable-id]");
          if (dropEl) {
            droppableId = dropEl.getAttribute("data-rbd-droppable-id") || dropEl.getAttribute("data-rfd-droppable-id") || droppableId;
          }

          const draggableIds = rows.map((r, idx) => {
            const directId = r.getAttribute && (r.getAttribute("data-rbd-draggable-id") || r.getAttribute("data-rfd-draggable-id") || r.getAttribute("data-rbd-drag-handle-draggable-id") || r.getAttribute("data-rfd-drag-handle-draggable-id") || r.getAttribute("data-id") || r.getAttribute("id"));
            if (directId) return directId;
            const childDrag = r.querySelector && r.querySelector("[data-rbd-draggable-id], [data-rfd-draggable-id], [data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [data-id]");
            if (childDrag && childDrag.getAttribute) {
              return childDrag.getAttribute("data-rbd-draggable-id") || childDrag.getAttribute("data-rfd-draggable-id") || childDrag.getAttribute("data-rbd-drag-handle-draggable-id") || childDrag.getAttribute("data-rfd-drag-handle-draggable-id") || childDrag.getAttribute("data-id") || `item-${idx}`;
            }
            return `item-${idx}`;
          });

          let simulatedList = rows.map((_, idx) => idx);
          for (let targetPos = 0; targetPos < N; targetPos++) {
            const desiredRowOriginalIdx = targetOrderIndices[targetPos];
            const currentPos = simulatedList.indexOf(desiredRowOriginalIdx);
            if (currentPos !== -1 && currentPos !== targetPos) {
              const activeDraggableId = draggableIds[desiredRowOriginalIdx];
              props.onDragEnd({
                draggableId: activeDraggableId,
                type: "DEFAULT",
                source: { index: currentPos, droppableId },
                destination: { index: targetPos, droppableId },
                reason: "DROP",
                mode: "FLUID"
              });
              try {
                props.onDragEnd({
                  active: { id: activeDraggableId, data: { current: { sortable: { index: currentPos } } } },
                  over: { id: draggableIds[simulatedList[targetPos]], data: { current: { sortable: { index: targetPos } } } }
                });
              } catch (_) { }

              const [moved] = simulatedList.splice(currentPos, 1);
              simulatedList.splice(targetPos, 0, moved);
            }
          }
          invokedMethod = "react_rbd_onDragEnd";
        } catch (err) {
          console.warn("[QuizZy] onDragEnd invocation error:", err);
        }
      }
    }

    // PATH 1B.1 Class Component setState
    if (curr.stateNode && curr.stateNode.state && typeof curr.stateNode.setState === "function") {
      const stateObj = curr.stateNode.state;
      for (const k of Object.keys(stateObj)) {
        const val = stateObj[k];
        if (Array.isArray(val) && val.length === N) {
          const reordered = new Array(N);
          let matchedAll = true;
          for (let targetPos = 0; targetPos < N; targetPos++) {
            const origIdx = targetOrderIndices[targetPos];
            if (val[origIdx] !== undefined) {
              reordered[targetPos] = val[origIdx];
            } else {
              matchedAll = false;
            }
          }
          if (matchedAll) {
            try {
              curr.stateNode.setState({ [k]: reordered });
              return { success: true, method: invokedMethod || "react_class_setState", stateKey: k };
            } catch (err) {
              console.warn("[QuizZy] setState error:", err);
            }
          }
        }
      }
    }

    // PATH 1B.2 Function Component Hook useState
    if (curr.memoizedState) {
      let hook = curr.memoizedState;
      let hookIdx = 0;
      while (hook && hookIdx < 20) {
        const stateVal = hook.memoizedState || hook.baseState;
        if (Array.isArray(stateVal) && stateVal.length === N) {
          if (hook.queue && typeof hook.queue.dispatch === "function") {
            const reordered = new Array(N);
            let matchedAll = true;
            for (let targetPos = 0; targetPos < N; targetPos++) {
              const origIdx = targetOrderIndices[targetPos];
              if (stateVal[origIdx] !== undefined) {
                reordered[targetPos] = stateVal[origIdx];
              } else {
                matchedAll = false;
              }
            }
            if (matchedAll) {
              try {
                hook.queue.dispatch(reordered);
                return { success: true, method: invokedMethod || "react_hook_dispatch" };
              } catch (err) {
                console.warn("[QuizZy] hook dispatch error:", err);
              }
            }
          }
        }
        hook = hook.next;
        hookIdx++;
      }
    }

    curr = curr.return;
    depth++;
  }

  if (invokedMethod) {
    return { success: true, method: invokedMethod };
  }

  return { success: false, error: "React Fiber tree walked but no suitable dnd handlers or state arrays found" };
}

// MAIN-World React Multi-Select Checkbox Fallback (Zero-Tag MAIN World Bridge)
function selectMultiOptionsInMainWorld(targetIndices, targetTexts) {
  const win = typeof window !== "undefined" ? window : null;
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc) return { success: false, ok: false, error: "No document available" };

  let optionRows = [];
  if (win && win.QuizZyExtractor && typeof win.QuizZyExtractor.getLastOptionElements === "function") {
    try {
      optionRows = win.QuizZyExtractor.getLastOptionElements();
    } catch (_) {}
  }
  if (!optionRows || optionRows.length === 0) {
    if (win && Array.isArray(win.__QUIZZY_LAST_OPTION_ELEMENTS__)) {
      optionRows = win.__QUIZZY_LAST_OPTION_ELEMENTS__.map(el => (el && typeof el.deref === "function") ? el.deref() : el).filter(Boolean);
    }
  }
  if (!optionRows || optionRows.length === 0) {
    const candidateQuery = doc.querySelectorAll("[class*='option' i], [class*='choice' i], [class*='checkbox' i], [class*='card' i], label, li, [role='checkbox']");
    if (candidateQuery && candidateQuery.length >= 2) {
      optionRows = Array.from(candidateQuery);
    }
  }

  const numOptions = optionRows.length;
  const indicesSet = new Set(Array.isArray(targetIndices) ? targetIndices : []);
  const checkedIndices = [];

  for (const idx of indicesSet) {
    if (idx < 0 || idx >= numOptions) continue;
    const optEl = optionRows[idx];
    if (!optEl) continue;

    const inputEl = optEl.querySelector ? optEl.querySelector("input[type='checkbox'], [role='checkbox']") : null;
    const indicatorEl = (optEl.querySelector ? optEl.querySelector("svg, [class*='checkbox' i], [class*='indicator' i], [class*='box' i]") : null) || (optEl.firstElementChild || null);
    const labelEl = (optEl.tagName === "LABEL") ? optEl : (optEl.querySelector ? optEl.querySelector("label") : null);
    const rowEl = optEl;

    const isAlreadyChecked = inputEl && (inputEl.checked === true || inputEl.getAttribute("aria-checked") === "true");
    if (isAlreadyChecked) {
      checkedIndices.push(idx);
      continue;
    }

    // Attempt 1: Direct MAIN-world click on inputEl || indicatorEl || labelEl || rowEl
    const clickTarget = inputEl || indicatorEl || labelEl || rowEl;
    if (clickTarget && typeof clickTarget.click === "function") {
      try { clickTarget.click(); } catch (_) {}
    }

    if (inputEl && inputEl.checked === true) {
      checkedIndices.push(idx);
      continue;
    }

    // Attempt 2: React Fiber / Props Synthetic onChange / onClick invocation
    const nodesToInspect = [inputEl, indicatorEl, labelEl, rowEl].filter(Boolean);
    let currParent = rowEl ? rowEl.parentElement : null;
    for (let p = 0; p < 4 && currParent; p++) {
      nodesToInspect.push(currParent);
      currParent = currParent.parentElement;
    }

    let invoked = false;
    for (const node of nodesToInspect) {
      try {
        const keys = Object.keys(node);
        const reactKey = keys.find(k => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$"));
        if (reactKey) {
          const props = node[reactKey].memoizedProps || node[reactKey];
          if (props) {
            if (typeof props.onChange === "function") {
              const syntheticEv = {
                target: inputEl || node,
                currentTarget: inputEl || node,
                type: "change",
                bubbles: true,
                preventDefault: () => {},
                stopPropagation: () => {},
                nativeEvent: new Event("change")
              };
              props.onChange(syntheticEv);
              if (inputEl) inputEl.checked = true;
              invoked = true;
              break;
            } else if (typeof props.onClick === "function") {
              props.onClick({
                target: inputEl || node,
                currentTarget: inputEl || node,
                type: "click",
                bubbles: true,
                preventDefault: () => {},
                stopPropagation: () => {}
              });
              if (inputEl) inputEl.checked = true;
              invoked = true;
              break;
            }
          }
        }
      } catch (_) {}
    }
    if (invoked || (inputEl && inputEl.checked === true)) {
      checkedIndices.push(idx);
    }
  }

  return { success: true, ok: true, checkedIndices };
}

// ==========================================================================
// MAIN-World Editor Discovery & Multi-Layer Non-Paste Code Engine
// ==========================================================================

// Zero-Tag MAIN World Bridge: Read Full Starter Code & Language from Monaco/Ace/CodeMirror
function readCodeFromMainWorld() {
  const win = typeof window !== "undefined" ? window : null;
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc) return { success: false, code: "", language: "", error: "No document available" };

  let code = "";
  let language = "";
  let editorType = "none";

  // Helper: Validate candidate object for editor or model capabilities
  function checkCandidate(cand) {
    if (!cand || typeof cand !== "object") return null;
    if (cand.current && typeof cand.current === "object") {
      const fromCur = checkCandidate(cand.current);
      if (fromCur) return fromCur;
    }
    if (typeof cand.getValue === "function" && (typeof cand.setValue === "function" || cand.session)) {
      return { instance: cand, type: "ace" };
    }
    if (typeof cand.executeEdits === "function" || (typeof cand.getModel === "function" && typeof cand.getValue === "function")) {
      return { instance: cand, type: "monaco" };
    }
    if (typeof cand.getValue === "function" && (typeof cand.pushEditOperations === "function" || typeof cand.applyEdits === "function" || typeof cand.getFullModelRange === "function")) {
      return { instance: cand, type: "monaco_model" };
    }
    if (cand.state && cand.state.doc && typeof cand.dispatch === "function") {
      return { instance: cand, type: "codemirror6" };
    }
    if (typeof cand.getValue === "function" && typeof cand.setValue === "function" && cand.getDoc) {
      return { instance: cand, type: "codemirror5" };
    }
    return null;
  }

  // Helper: Deep React Fiber scan with ancestor traversal and hook unwrap
  function scanReactFiber(domNode) {
    if (!domNode) return null;
    let node = domNode;
    let hops = 0;
    while (node && hops < 15) {
      const keys = Object.keys(node);
      const fiberKey = keys.find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$") || k.startsWith("__reactContainer$"));
      if (fiberKey && node[fiberKey]) {
        let cur = node[fiberKey];
        let fiberHops = 0;
        while (cur && fiberHops < 25) {
          const props = cur.memoizedProps || cur.pendingProps;
          const candidates = [
            cur.stateNode,
            props && props.editor,
            props && props.monaco,
            props && props.ace,
            cur.stateNode && cur.stateNode.editor,
            cur.stateNode && cur.stateNode.ace,
            cur.stateNode && cur.stateNode.monaco,
            cur.stateNode && cur.stateNode.instance,
            cur.stateNode && cur.stateNode._editor
          ];

          for (const cand of candidates) {
            const res = checkCandidate(cand);
            if (res) return res;
          }

          if (cur.memoizedState && typeof cur.memoizedState === "object") {
            let hook = cur.memoizedState;
            let hookHops = 0;
            while (hook && hookHops < 35) {
              if (hook.memoizedState) {
                const res = checkCandidate(hook.memoizedState);
                if (res) return res;
              }
              if (hook.baseState) {
                const res = checkCandidate(hook.baseState);
                if (res) return res;
              }
              hook = hook.next;
              hookHops++;
            }
          }

          cur = cur.return;
          fiberHops++;
        }
      }
      node = node.parentElement;
      hops++;
    }
    return null;
  }

  // Helper: Resolve AMD / RequireJS Monaco
  function resolveAmdMonaco() {
    if (!win) return null;
    if (win.monaco && win.monaco.editor) return win.monaco;
    if (typeof win.require === "function") {
      try {
        const reqM = win.require("vs/editor/editor.main");
        if (reqM && reqM.editor) return reqM;
      } catch (_) { }
      if (win.require.s && win.require.s.contexts && win.require.s.contexts._) {
        try {
          const def = win.require.s.contexts._.defined;
          if (def && def["vs/editor/editor.main"]) return def["vs/editor/editor.main"];
        } catch (_) { }
      }
    }
    return null;
  }

  function findMainEditorElement(docRoot) {
    if (!docRoot || typeof docRoot.querySelectorAll !== "function") return null;
    const selectors = [
      ".monaco-editor",
      "[class*='monaco-editor']",
      ".ace_editor",
      "[class*='ace_editor']",
      ".cm-editor",
      ".CodeMirror"
    ];
    const all = Array.from(docRoot.querySelectorAll(selectors.join(", ")));
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];

    const filtered = all.filter(el => {
      if (!el || typeof el.closest !== "function") return true;
      return !el.closest(".question-description, .problem-statement, .problem-description, [class*='description'], [class*='instructions'], .testcase-output, [class*='console'], [class*='output']");
    });
    const pool = filtered.length > 0 ? filtered : all;

    let best = null;
    let maxArea = -1;
    for (const el of pool) {
      const rect = (typeof el.getBoundingClientRect === "function") ? el.getBoundingClientRect() : null;
      const w = rect ? rect.width : (el.offsetWidth || el.clientWidth || 0);
      const h = rect ? rect.height : (el.offsetHeight || el.clientHeight || 0);
      if (pool.length > 1 && (w < 100 || h < 100)) continue;
      const area = w * h;
      if (area > maxArea) {
        maxArea = area;
        best = el;
      }
    }
    return best || pool[0];
  }

  // 1. Monaco Editor (Direct API, Models & AMD)
  try {
    const activeMonaco = resolveAmdMonaco() || (win && win.monaco);
    if (activeMonaco && activeMonaco.editor) {
      if (typeof activeMonaco.editor.getEditors === "function") {
        const eds = activeMonaco.editor.getEditors();
        if (Array.isArray(eds) && eds.length > 0) {
          const mainEl = findMainEditorElement(doc);
          const nonReadOnly = eds.filter(e => {
            if (!e) return false;
            let isReadOnly = false;
            if (typeof e.getOption === "function" && activeMonaco.editor && activeMonaco.editor.EditorOption) {
              try { isReadOnly = e.getOption(activeMonaco.editor.EditorOption.readOnly) === true; } catch (_) { }
            }
            if (!isReadOnly && typeof e.getRawOptions === "function") {
              try { isReadOnly = (e.getRawOptions() || {}).readOnly === true; } catch (_) { }
            }
            if (isReadOnly) return false;

            const dn = (typeof e.getDomNode === "function") ? e.getDomNode() : null;
            if (dn) {
              if (typeof dn.closest === "function" && dn.closest(".question-description, .problem-statement, .problem-description, [class*='description'], [class*='instructions'], .testcase-output, [class*='console'], [class*='output']")) {
                return false;
              }
              const rect = (typeof dn.getBoundingClientRect === "function") ? dn.getBoundingClientRect() : null;
              const w = rect ? rect.width : (dn.offsetWidth || 0);
              const h = rect ? rect.height : (dn.offsetHeight || 0);
              if (eds.length > 1 && (w < 100 || h < 100)) return false;
            }
            return true;
          });

          const pool = nonReadOnly.length > 0 ? nonReadOnly : eds;
          let matched = mainEl ? pool.find(e => {
            const dn = (typeof e.getDomNode === "function") ? e.getDomNode() : null;
            return dn && (dn === mainEl || dn.contains(mainEl) || mainEl.contains(dn));
          }) : null;

          if (!matched) {
            let maxArea = -1;
            let bestEd = pool[0];
            for (const ed of pool) {
              const dn = typeof ed.getDomNode === "function" ? ed.getDomNode() : null;
              if (dn) {
                const rect = (typeof dn.getBoundingClientRect === "function") ? dn.getBoundingClientRect() : null;
                const w = rect ? rect.width : (dn.offsetWidth || 0);
                const h = rect ? rect.height : (dn.offsetHeight || 0);
                const area = w * h;
                if (area > maxArea) {
                  maxArea = area;
                  bestEd = ed;
                }
              }
            }
            matched = bestEd;
          }

          if (matched && typeof matched.getModel === "function") {
            const m = matched.getModel();
            if (m && typeof m.getValue === "function") {
              code = m.getValue();
              language = typeof m.getLanguageId === "function" ? m.getLanguageId() : "";
              editorType = "monaco";
            }
          }
        }
      }
      if (!code && typeof activeMonaco.editor.getModels === "function") {
        const models = (typeof window !== "undefined" && window.monaco && window.monaco.editor && typeof window.monaco.editor.getModels === "function") ? window.monaco.editor.getModels() : activeMonaco.editor.getModels();
        if (Array.isArray(models) && models.length > 0) {
          if (models.length === 1) {
            const m = models[0];
            code = typeof m.getValue === "function" ? m.getValue() : "";
            language = typeof m.getLanguageId === "function" ? m.getLanguageId() : "";
            editorType = "monaco_model";
          } else {
            const templateSignatures = [/#include/i, /\bclass\s+Solution\b/i, /\bdef\s+/i, /\bfunction\s+/i, /\bpublic\s+class\b/i];
            let targetM = null;
            for (let i = models.length - 1; i >= 0; i--) {
              const m = models[i];
              const val = (m && typeof m.getValue === "function") ? m.getValue() : "";
              if (templateSignatures.some(sig => sig.test(val))) {
                targetM = m;
                break;
              }
            }
            if (!targetM) {
              const attached = models.filter(m => typeof m.isAttachedToEditor === "function" && m.isAttachedToEditor());
              targetM = attached.length > 0 ? attached[attached.length - 1] : models[models.length - 1];
            }
            if (targetM) {
              code = typeof targetM.getValue === "function" ? targetM.getValue() : "";
              language = typeof targetM.getLanguageId === "function" ? targetM.getLanguageId() : "";
              editorType = "monaco_model";
            }
          }
        }
      }
    }
  } catch (_) { }

  // 2. Ace Editor (Direct API & DOM Expando)
  if (!code) {
    try {
      const aceEl = doc.querySelector(".ace_editor, [class*='ace_editor']");
      if (aceEl) {
        let ed = null;
        if (aceEl.env && aceEl.env.editor) {
          ed = aceEl.env.editor;
        } else if (aceEl.editor || aceEl.__ace_editor__) {
          ed = aceEl.editor || aceEl.__ace_editor__;
        } else if (win && win.ace && typeof win.ace.edit === "function") {
          ed = window.ace.edit(aceEl);
        }
        if (!ed) {
          let curEl = aceEl;
          let elHops = 0;
          while (curEl && elHops < 10) {
            if (curEl.editor || curEl.__ace_editor__ || curEl._editor) {
              const cand = curEl.editor || curEl.__ace_editor__ || curEl._editor;
              if (cand && typeof cand.getValue === "function" && cand.session) {
                ed = cand;
                break;
              }
            }
            curEl = curEl.parentElement;
            elHops++;
          }
        }
        if (ed && typeof ed.getValue === "function") {
          code = ed.getValue();
          editorType = "ace";
          try { language = ed.session.getMode().$id.split("/").pop(); } catch (_) { }
        }
      }
    } catch (_) { }
  }

  // 3. React Fiber Traversal for Monaco or Ace
  if (!code) {
    const editorContainer = doc.querySelector(".monaco-editor, .ace_editor, .code-editor-container, [class*='monaco-editor'], [class*='ace_editor']");
    if (editorContainer) {
      const fiberRes = scanReactFiber(editorContainer);
      if (fiberRes && fiberRes.instance) {
        if (typeof fiberRes.instance.getValue === "function") {
          code = fiberRes.instance.getValue();
          editorType = fiberRes.type || "react-fiber-editor";
        } else if (typeof fiberRes.instance.getModel === "function") {
          const m = fiberRes.instance.getModel();
          if (m && typeof m.getValue === "function") {
            code = m.getValue();
            editorType = "monaco";
          }
        }
      }
    }
  }

  // 4. Same-origin iframes check
  if (!code && doc.querySelectorAll) {
    try {
      const iframes = Array.from(doc.querySelectorAll("iframe"));
      for (const ifr of iframes) {
        try {
          const ifrDoc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
          if (ifrDoc) {
            const ifrEditor = ifrDoc.querySelector(".monaco-editor, .ace_editor");
            if (ifrEditor) {
              const ifrFiber = scanReactFiber(ifrEditor);
              if (ifrFiber && ifrFiber.instance && typeof ifrFiber.instance.getValue === "function") {
                code = ifrFiber.instance.getValue();
                editorType = ifrFiber.type || "iframe-editor";
                break;
              }
            }
          }
        } catch (_) { }
      }
    } catch (_) { }
  }

  // 5. CodeMirror 5 / 6
  if (!code) {
    const cmEl = doc.querySelector(".CodeMirror, .cm-editor");
    if (cmEl) {
      if (cmEl.CodeMirror && typeof cmEl.CodeMirror.getValue === "function") {
        code = cmEl.CodeMirror.getValue();
        editorType = "codemirror";
      } else if (cmEl.cmView && cmEl.cmView.view && cmEl.cmView.view.state && cmEl.cmView.view.state.doc) {
        code = cmEl.cmView.view.state.doc.toString();
        editorType = "codemirror6";
      }
    }
  }

  // 6. Safe standalone textarea fallback (strictly excluding hidden editor textareas)
  if (!code) {
    const textareas = Array.from(doc.querySelectorAll("textarea"));
    for (const ta of textareas) {
      if (ta.matches && ta.matches(".ace_text-input, textarea.inputarea, .monaco-mouse-cursor-text")) continue;
      if (ta.closest && ta.closest(".ace_editor, .monaco-editor, .CodeMirror, .cm-editor")) continue;
      if (ta.value && ta.value.trim().length > 0) {
        code = ta.value;
        editorType = "textarea";
        break;
      }
    }
  }

  return {
    success: true,
    code: code || "",
    language: language || "",
    editorType: editorType
  };
}

// MAIN-world Monaco/Ace paste-bypass human typing implementation (zero paste events dispatched)
function writeCodeWithHumanTypingInMainWorld(payload) {
  if (!payload) return { success: false, error: "Empty payload" };
  let targetCode = (typeof payload.code === "string")
    ? payload.code
    : (typeof payload.answer === "string" ? payload.answer : (typeof payload.selected_text === "string" ? payload.selected_text : ""));
  if (typeof targetCode !== "string") return { success: false, error: "No code provided in payload" };

  // Strip leading and trailing markdown code fences if present
  targetCode = targetCode.replace(/^```[a-zA-Z0-9_+\-#]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();

  const doc = (typeof document !== "undefined") ? document : null;
  const win = (typeof window !== "undefined") ? window : null;
  if (!doc) return { success: false, error: "No document available" };

  // Helper: Validate candidate object for editor or model capabilities
  function checkCandidate(cand) {
    if (!cand || typeof cand !== "object") return null;
    if (cand.current && typeof cand.current === "object") {
      const fromCur = checkCandidate(cand.current);
      if (fromCur) return fromCur;
    }
    if (typeof cand.getValue === "function" && (typeof cand.setValue === "function" || cand.session)) {
      return { instance: cand, type: "ace" };
    }
    if (typeof cand.executeEdits === "function" || (typeof cand.getModel === "function" && typeof cand.getValue === "function")) {
      return { instance: cand, type: "monaco" };
    }
    if (typeof cand.getValue === "function" && (typeof cand.pushEditOperations === "function" || typeof cand.applyEdits === "function" || typeof cand.getFullModelRange === "function")) {
      return { instance: cand, type: "monaco_model" };
    }
    if (cand.state && cand.state.doc && typeof cand.dispatch === "function") {
      return { instance: cand, type: "codemirror6" };
    }
    if (typeof cand.getValue === "function" && typeof cand.setValue === "function" && cand.getDoc) {
      return { instance: cand, type: "codemirror5" };
    }
    return null;
  }

  // Helper: Deep React Fiber Scanner
  function scanReactFiber(domNode) {
    if (!domNode) return { editor: null, onChange: null };
    let node = domNode;
    let hops = 0;
    while (node && hops < 15) {
      const keys = Object.keys(node);
      const fiberKey = keys.find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$") || k.startsWith("__reactContainer$"));
      const propsKey = keys.find(k => k.startsWith("__reactProps$"));

      let onChangeProp = null;
      if (propsKey && node[propsKey] && typeof node[propsKey].onChange === "function") {
        onChangeProp = node[propsKey].onChange;
      }

      if (fiberKey && node[fiberKey]) {
        let cur = node[fiberKey];
        let fiberHops = 0;
        while (cur && fiberHops < 25) {
          const props = cur.memoizedProps || cur.pendingProps;
          if (props && typeof props.onChange === "function" && !onChangeProp) {
            onChangeProp = props.onChange;
          }

          const candidates = [
            cur.stateNode,
            props && props.editor,
            props && props.monaco,
            props && props.ace,
            cur.stateNode && cur.stateNode.editor,
            cur.stateNode && cur.stateNode.ace,
            cur.stateNode && cur.stateNode.monaco,
            cur.stateNode && cur.stateNode.instance,
            cur.stateNode && cur.stateNode._editor
          ];

          for (const cand of candidates) {
            const res = checkCandidate(cand);
            if (res) {
              return { editor: res, onChange: onChangeProp };
            }
          }

          if (cur.memoizedState && typeof cur.memoizedState === "object") {
            let hook = cur.memoizedState;
            let hookHops = 0;
            while (hook && hookHops < 35) {
              if (hook.memoizedState) {
                const res = checkCandidate(hook.memoizedState);
                if (res) return { editor: res, onChange: onChangeProp };
              }
              if (hook.baseState) {
                const res = checkCandidate(hook.baseState);
                if (res) return { editor: res, onChange: onChangeProp };
              }
              hook = hook.next;
              hookHops++;
            }
          }

          cur = cur.return;
          fiberHops++;
        }
      }
      node = node.parentElement;
      hops++;
    }

    return { editor: null, onChange: null };
  }

  // Helper: Resolve AMD / RequireJS Monaco
  function resolveAmdMonaco() {
    if (!win) return null;
    if (win.monaco && win.monaco.editor) return win.monaco;
    if (typeof win.require === "function") {
      try {
        const reqM = win.require("vs/editor/editor.main");
        if (reqM && reqM.editor) return reqM;
      } catch (_) { }
      if (win.require.s && win.require.s.contexts && win.require.s.contexts._) {
        try {
          const def = win.require.s.contexts._.defined;
          if (def && def["vs/editor/editor.main"]) return def["vs/editor/editor.main"];
        } catch (_) { }
      }
    }
    return null;
  }

  function findMainEditorElement(docRoot) {
    if (!docRoot || typeof docRoot.querySelectorAll !== "function") return null;
    const selectors = [
      ".monaco-editor",
      "[class*='monaco-editor']",
      ".ace_editor",
      "[class*='ace_editor']",
      ".cm-editor",
      ".CodeMirror"
    ];
    const all = Array.from(docRoot.querySelectorAll(selectors.join(", ")));
    if (all.length === 0) return null;
    if (all.length === 1) return all[0];

    const filtered = all.filter(el => {
      if (!el || typeof el.closest !== "function") return true;
      return !el.closest(".question-description, .problem-statement, .problem-description, [class*='description'], [class*='instructions'], .testcase-output, [class*='console'], [class*='output']");
    });
    const pool = filtered.length > 0 ? filtered : all;

    let best = null;
    let maxArea = -1;
    for (const el of pool) {
      const rect = (typeof el.getBoundingClientRect === "function") ? el.getBoundingClientRect() : null;
      const w = rect ? rect.width : (el.offsetWidth || el.clientWidth || 0);
      const h = rect ? rect.height : (el.offsetHeight || el.clientHeight || 0);
      if (pool.length > 1 && (w < 100 || h < 100)) continue;
      const area = w * h;
      if (area > maxArea) {
        maxArea = area;
        best = el;
      }
    }
    return best || pool[0];
  }

  // Deep Editor Discovery Engine
  function discoverEditor() {
    // 1. Monaco Editor
    const mainEl = findMainEditorElement(doc);
    const monacoEl = (mainEl && (mainEl.classList?.contains("monaco-editor") || (mainEl.className && String(mainEl.className).includes("monaco")))) ? mainEl : (mainEl || doc.querySelector(".monaco-editor, [class*='monaco-editor'], [data-editor='monaco']"));
    const activeMonaco = resolveAmdMonaco() || (win && win.monaco);

    if (monacoEl || (activeMonaco && activeMonaco.editor)) {
      if (activeMonaco && activeMonaco.editor && typeof activeMonaco.editor.getEditors === "function") {
        try {
          const eds = activeMonaco.editor.getEditors();
          if (Array.isArray(eds) && eds.length > 0) {
            const nonReadOnly = eds.filter(e => {
              if (!e) return false;
              let isReadOnly = false;
              if (typeof e.getOption === "function" && activeMonaco.editor && activeMonaco.editor.EditorOption) {
                try { isReadOnly = e.getOption(activeMonaco.editor.EditorOption.readOnly) === true; } catch (_) { }
              }
              if (!isReadOnly && typeof e.getRawOptions === "function") {
                try { isReadOnly = (e.getRawOptions() || {}).readOnly === true; } catch (_) { }
              }
              if (isReadOnly) return false;

              const dn = (typeof e.getDomNode === "function") ? e.getDomNode() : null;
              if (dn) {
                if (typeof dn.closest === "function" && dn.closest(".question-description, .problem-statement, .problem-description, [class*='description'], [class*='instructions'], .testcase-output, [class*='console'], [class*='output']")) {
                  return false;
                }
                const rect = (typeof dn.getBoundingClientRect === "function") ? dn.getBoundingClientRect() : null;
                const w = rect ? rect.width : (dn.offsetWidth || 0);
                const h = rect ? rect.height : (dn.offsetHeight || 0);
                if (eds.length > 1 && (w < 100 || h < 100)) return false;
              }
              return true;
            });
            const pool = nonReadOnly.length > 0 ? nonReadOnly : eds;
            let matched = mainEl ? pool.find(e => {
              const dn = (typeof e.getDomNode === "function") ? e.getDomNode() : null;
              return dn && (dn === mainEl || dn.contains(mainEl) || mainEl.contains(dn));
            }) : null;
            if (!matched) {
              let maxArea = -1;
              let bestEd = pool[0];
              for (const ed of pool) {
                const dn = typeof ed.getDomNode === "function" ? ed.getDomNode() : null;
                if (dn) {
                  const rect = (typeof dn.getBoundingClientRect === "function") ? dn.getBoundingClientRect() : null;
                  const w = rect ? rect.width : (dn.offsetWidth || 0);
                  const h = rect ? rect.height : (dn.offsetHeight || 0);
                  const area = w * h;
                  if (area > maxArea) {
                    maxArea = area;
                    bestEd = ed;
                  }
                }
              }
              matched = bestEd;
            }
            const ed = matched || pool[pool.length - 1];
            const targetEl = (typeof ed.getDomNode === "function" ? ed.getDomNode() : null) || monacoEl;
            const fiberScan = scanReactFiber(targetEl);
            return {
              type: "monaco",
              instance: ed,
              model: typeof ed.getModel === "function" ? ed.getModel() : null,
              element: targetEl,
              onChange: fiberScan.onChange
            };
          }
        } catch (_) { }
      }

      if (activeMonaco && activeMonaco.editor && typeof activeMonaco.editor.getModels === "function") {
        try {
          const models = (typeof window !== "undefined" && window.monaco && window.monaco.editor && typeof window.monaco.editor.getModels === "function") ? window.monaco.editor.getModels() : activeMonaco.editor.getModels();
          if (Array.isArray(models) && models.length > 0) {
            let targetM = null;
            if (models.length === 1) {
              targetM = models[0];
            } else {
              const templateSignatures = [/#include/i, /\bclass\s+Solution\b/i, /\bdef\s+/i, /\bfunction\s+/i, /\bpublic\s+class\b/i];
              for (let i = models.length - 1; i >= 0; i--) {
                const m = models[i];
                const val = (m && typeof m.getValue === "function") ? m.getValue() : "";
                if (templateSignatures.some(sig => sig.test(val))) {
                  targetM = m;
                  break;
                }
              }
              if (!targetM) {
                const attached = models.filter(m => typeof m.isAttachedToEditor === "function" && m.isAttachedToEditor());
                targetM = attached.length > 0 ? attached[attached.length - 1] : models[models.length - 1];
              }
            }
            if (targetM) {
              const fiberScan = scanReactFiber(monacoEl);
              return {
                type: "monaco_model",
                instance: null,
                model: targetM,
                element: monacoEl,
                onChange: fiberScan.onChange
              };
            }
          }
        } catch (_) { }
      }

      if (monacoEl) {
        let curEl = monacoEl;
        let elHops = 0;
        while (curEl && elHops < 12) {
          if (curEl.__monaco_editor__ || curEl.editor || curEl._editor || curEl.monaco) {
            const ed = curEl.__monaco_editor__ || curEl.editor || curEl._editor || curEl.monaco;
            const fiberScan = scanReactFiber(monacoEl);
            return {
              type: "monaco",
              instance: ed,
              model: typeof ed.getModel === "function" ? ed.getModel() : null,
              element: monacoEl,
              onChange: fiberScan.onChange
            };
          }
          curEl = curEl.parentElement;
          elHops++;
        }

        const fiberScan = scanReactFiber(monacoEl);
        if (fiberScan.editor) {
          const ed = fiberScan.editor.instance;
          return {
            type: fiberScan.editor.type,
            instance: fiberScan.editor.type === "monaco" ? ed : null,
            model: fiberScan.editor.type === "monaco_model" ? ed : (typeof ed.getModel === "function" ? ed.getModel() : null),
            element: monacoEl,
            onChange: fiberScan.onChange
          };
        }
      }
    }

    // 2. Ace Editor
    const aceEl = doc.querySelector(".ace_editor, [class*='ace_editor']");
    if (aceEl || (win && win.ace)) {
      if (aceEl && aceEl.env && aceEl.env.editor && typeof aceEl.env.editor.getValue === "function") {
        const fiberScan = scanReactFiber(aceEl);
        return {
          type: "ace",
          instance: aceEl.env.editor,
          element: aceEl,
          onChange: fiberScan.onChange
        };
      }
      if (aceEl && (aceEl.editor || aceEl.__ace_editor__)) {
        const ed = aceEl.editor || aceEl.__ace_editor__;
        if (typeof ed.getValue === "function") {
          const fiberScan = scanReactFiber(aceEl);
          return {
            type: "ace",
            instance: ed,
            element: aceEl,
            onChange: fiberScan.onChange
          };
        }
      }
      if (aceEl && win && win.ace && typeof win.ace.edit === "function") {
        try {
          const ed = window.ace.edit(aceEl);
          if (ed && typeof ed.getValue === "function") {
            const fiberScan = scanReactFiber(aceEl);
            return {
              type: "ace",
              instance: ed,
              element: aceEl,
              onChange: fiberScan.onChange
            };
          }
        } catch (_) { }
      }
      if (aceEl) {
        let curEl = aceEl;
        let elHops = 0;
        while (curEl && elHops < 10) {
          if (curEl.editor || curEl.__ace_editor__ || curEl._editor) {
            const cand = curEl.editor || curEl.__ace_editor__ || curEl._editor;
            if (cand && typeof cand.getValue === "function" && cand.session) {
              const fiberScan = scanReactFiber(aceEl);
              return {
                type: "ace",
                instance: cand,
                element: aceEl,
                onChange: fiberScan.onChange
              };
            }
          }
          curEl = curEl.parentElement;
          elHops++;
        }

        const fiberScan = scanReactFiber(aceEl);
        if (fiberScan.editor && fiberScan.editor.type === "ace") {
          return {
            type: "ace",
            instance: fiberScan.editor.instance,
            element: aceEl,
            onChange: fiberScan.onChange
          };
        }
      }
    }

    // 3. Same-origin iframe scan
    if (doc.querySelectorAll) {
      try {
        const iframes = Array.from(doc.querySelectorAll("iframe"));
        for (const ifr of iframes) {
          try {
            const ifrDoc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
            if (ifrDoc) {
              const ifrMonaco = ifrDoc.querySelector(".monaco-editor");
              if (ifrMonaco) {
                const fiberScan = scanReactFiber(ifrMonaco);
                if (fiberScan.editor) {
                  return {
                    type: fiberScan.editor.type,
                    instance: fiberScan.editor.instance,
                    model: typeof fiberScan.editor.instance?.getModel === "function" ? fiberScan.editor.instance.getModel() : null,
                    element: ifrMonaco,
                    onChange: fiberScan.onChange
                  };
                }
              }
            }
          } catch (_) { }
        }
      } catch (_) { }
    }

    // 4. CodeMirror 5 / 6
    const cmEl = doc.querySelector(".CodeMirror, .cm-editor");
    if (cmEl) {
      if (cmEl.CodeMirror && typeof cmEl.CodeMirror.getValue === "function") {
        return { type: "codemirror", instance: cmEl.CodeMirror, element: cmEl };
      }
      if (cmEl.cmView && cmEl.cmView.view) {
        return { type: "codemirror6", instance: cmEl.cmView.view, element: cmEl };
      }
      const fiberScan = scanReactFiber(cmEl);
      if (fiberScan.editor) {
        return { type: "codemirror", instance: fiberScan.editor.instance, element: cmEl, onChange: fiberScan.onChange };
      }
    }

    // 5. Requirement B Hard Rule: If editor container is present in DOM, NEVER fall back to hidden focus textarea!
    if (doc.querySelector(".ace_editor, .monaco-editor, .CodeMirror, .cm-editor")) {
      return {
        type: "blocked_container",
        error: "Editor container found but MAIN-world editor instance was not accessible",
        element: null
      };
    }

    // 6. Generic Standalone Textarea fallback
    const allTas = Array.from(doc.querySelectorAll("textarea"));
    for (const ta of allTas) {
      if (ta.matches && ta.matches(".ace_text-input, textarea.inputarea, .monaco-mouse-cursor-text")) continue;
      if (ta.closest && ta.closest(".ace_editor, .monaco-editor, .CodeMirror, .cm-editor")) continue;
      return { type: "textarea", element: ta, instance: null };
    }

    return null;
  }

  const discovered = discoverEditor();
  if (!discovered) {
    return {
      success: false,
      ok: false,
      selected: false,
      error: "No code editor or input textarea found in document",
      editorType: "none"
    };
  }

  if (discovered.type === "blocked_container") {
    return {
      success: false,
      ok: false,
      selected: false,
      error: discovered.error,
      editorType: "blocked_container"
    };
  }

  // Obtain current buffer value for boilerplate & header preservation
  let currentVal = "";
  if (discovered.type === "ace" && discovered.instance && typeof discovered.instance.getValue === "function") {
    currentVal = discovered.instance.getValue();
  } else if ((discovered.type === "monaco" || discovered.type === "monaco_model") && discovered.model && typeof discovered.model.getValue === "function") {
    currentVal = discovered.model.getValue();
  } else if (discovered.type === "codemirror" && discovered.instance && typeof discovered.instance.getValue === "function") {
    currentVal = discovered.instance.getValue();
  } else if (discovered.type === "codemirror6" && discovered.instance && discovered.instance.state && discovered.instance.state.doc) {
    currentVal = discovered.instance.state.doc.toString();
  } else if (discovered.type === "textarea" && discovered.element) {
    currentVal = discovered.element.value || "";
  }

  // Step A: Preserve Folded Header Comments & Boilerplate (#include, using namespace, class/struct Node)
  let finalCode = targetCode;

  function findOutsideComments(str, regex) {
    if (!str || typeof str !== "string") return -1;
    let inBlockComment = false;
    let inLineComment = false;
    let cleaned = "";
    for (let i = 0; i < str.length; i++) {
      if (!inBlockComment && !inLineComment) {
        if (str[i] === "/" && str[i + 1] === "*") {
          inBlockComment = true;
          cleaned += "  ";
          i++;
        } else if (str[i] === "/" && str[i + 1] === "/") {
          inLineComment = true;
          cleaned += "  ";
          i++;
        } else {
          cleaned += str[i];
        }
      } else if (inBlockComment) {
        if (str[i] === "*" && str[i + 1] === "/") {
          inBlockComment = false;
          cleaned += "  ";
          i++;
        } else {
          cleaned += (str[i] === "\n") ? "\n" : " ";
        }
      } else if (inLineComment) {
        if (str[i] === "\n") {
          inLineComment = false;
          cleaned += "\n";
        } else {
          cleaned += " ";
        }
      }
    }
    return cleaned.search(regex);
  }

  const alreadyHasHeaders = targetCode.includes("#include") || (targetCode.includes("using namespace") && targetCode.includes("/*"));
  if (payload.preserveBoilerplate !== false && !alreadyHasHeaders && currentVal && currentVal.trim()) {
    let insertionIdx = -1;

    // 1. If targetCode defines a class, locate that exact class definition outside comments in currentVal
    const targetClassMatch = targetCode.match(/\bclass\s+([a-zA-Z0-9_]+)\b/i);
    if (targetClassMatch) {
      const className = targetClassMatch[1];
      const specificClassIdx = findOutsideComments(currentVal, new RegExp("\\bclass\\s+" + className + "\\b", "i"));
      if (specificClassIdx > 0) {
        insertionIdx = specificClassIdx;
      }
    }

    // 2. If targetCode does NOT define a class, but currentVal defines a class (e.g. class Solution or class solution):
    // Wrap targetCode cleanly inside that class so closing braces and class context are never truncated!
    if (insertionIdx === -1) {
      const currentClassMatch = currentVal.match(/\bclass\s+([a-zA-Z0-9_]+)\b/i);
      if (currentClassMatch) {
        const currentClassName = currentClassMatch[1];
        const classIdx = findOutsideComments(currentVal, new RegExp("\\bclass\\s+" + currentClassName + "\\b", "i"));
        if (classIdx > 0) {
          insertionIdx = classIdx;
          const isPython = /def\s+[a-zA-Z0-9_]+\s*\(|self\b/.test(targetCode);
          if (isPython) {
            const indented = targetCode.split(/\r?\n/).map(l => "    " + l).join("\n");
            targetCode = `class ${currentClassName}:\n${indented}`;
          } else {
            const indented = targetCode.split(/\r?\n/).map(l => "    " + l).join("\n");
            targetCode = `class ${currentClassName} {\npublic:\n${indented}\n};`;
          }
        }
      }
    }

    // 3. If targetCode defines a function/method and no class was matched, locate it outside comments in currentVal
    if (insertionIdx === -1) {
      const targetFuncMatch = targetCode.match(/(?:def|function|[a-zA-Z0-9_*&<>]+\s+)\s*([a-zA-Z0-9_]+)\s*\(/i);
      if (targetFuncMatch) {
        const funcName = targetFuncMatch[1];
        const funcIdx = findOutsideComments(currentVal, new RegExp("\\b" + funcName + "\\s*\\(", "i"));
        if (funcIdx > 0) {
          insertionIdx = funcIdx;
        }
      }
    }

    // 4. Fallback: match any active class definition outside comments
    if (insertionIdx === -1) {
      const anyClassIdx = findOutsideComments(currentVal, /\bclass\s+[a-zA-Z0-9_]+\b/i);
      if (anyClassIdx > 0) {
        insertionIdx = anyClassIdx;
      }
    }

    if (insertionIdx > 0) {
      const leadingHeader = currentVal.slice(0, insertionIdx);
      finalCode = leadingHeader.trimEnd() + "\n\n" + targetCode.trimStart();
    } else {
      const headerMatch = currentVal.match(/^(\s*(?:#include[^\n]*\n|using\s+namespace[^\n]*\n|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)\s*)+/);
      if (headerMatch && !targetCode.trim().startsWith("#include") && !targetCode.trim().startsWith("/*")) {
        const leadingHeader = headerMatch[0];
        finalCode = leadingHeader.trimEnd() + "\n\n" + targetCode.trimStart();
      }
    }
  }

  let verifiedCode = "";

  // Step B: Multi-Layer Non-Paste Code Writing & Keystroke-Bypass Pipeline
  if (discovered.type === "ace" && discovered.instance) {
    const editor = discovered.instance;
    if (typeof editor.focus === "function") {
      try { editor.focus(); } catch (_) { }
    }

    // Save and disable auto behaviors
    let savedBehaviours = true;
    try {
      if (typeof editor.getBehavioursEnabled === "function") savedBehaviours = editor.getBehavioursEnabled();
      if (typeof editor.setBehavioursEnabled === "function") editor.setBehavioursEnabled(false);
      if (typeof editor.setOption === "function") {
        editor.setOption("behavioursEnabled", false);
        editor.setOption("wrapBehavioursEnabled", false);
      }
    } catch (_) { }

    // Non-paste buffer replacement
    if (editor.session && editor.session.doc && typeof editor.session.doc.setValue === "function") {
      editor.session.doc.setValue(finalCode);
    } else if (typeof editor.setValue === "function") {
      editor.setValue(finalCode, 1);
    }

    // Notify Ace command pipeline
    try {
      if (editor.commands && typeof editor.commands.exec === "function") {
        editor.commands.exec("insertstring", editor, "");
      } else if (typeof editor.onTextInput === "function") {
        editor.onTextInput("");
      }
      if (typeof editor._signal === "function") {
        editor._signal("change", {});
      }
    } catch (_) { }

    // Sync React Fiber onChange callback
    if (typeof discovered.onChange === "function") {
      try { discovered.onChange(finalCode); } catch (_) { }
    }

    // Dispatch simulated keyboard event on Ace hidden textarea
    const hiddenTa = doc.querySelector(".ace_text-input");
    if (hiddenTa) {
      try {
        hiddenTa.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftRight", bubbles: true }));
        hiddenTa.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        hiddenTa.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftRight", bubbles: true }));
      } catch (_) { }
    }

    // Restore auto behaviors
    try {
      if (typeof editor.setBehavioursEnabled === "function") editor.setBehavioursEnabled(savedBehaviours);
      if (typeof editor.clearSelection === "function") editor.clearSelection();
    } catch (_) { }

    verifiedCode = typeof editor.getValue === "function" ? editor.getValue() : finalCode;
  }
  else if ((discovered.type === "monaco" || discovered.type === "monaco_model") && (discovered.model || discovered.instance)) {
    const editor = discovered.instance;
    const model = discovered.model || (editor && editor.getModel ? editor.getModel() : null);

    if (editor && typeof editor.focus === "function") {
      try { editor.focus(); } catch (_) { }
    }

    const fullRange = model && typeof model.getFullModelRange === "function"
      ? model.getFullModelRange()
      : { startLineNumber: 1, startColumn: 1, endLineNumber: 99999, endColumn: 99999 };

    let editApplied = false;
    if (editor && typeof editor.executeEdits === "function") {
      try {
        editor.executeEdits(null, [{
          range: fullRange,
          text: finalCode,
          forceMoveMarkers: true
        }]);
        editApplied = true;
      } catch (_) { }
    }

    if (!editApplied || (model && typeof model.getValue === "function" && model.getValue().trim() !== finalCode.trim())) {
      if (model && typeof model.pushEditOperations === "function") {
        try {
          model.pushEditOperations([], [{ range: fullRange, text: finalCode }], () => null);
        } catch (_) {
          if (typeof model.setValue === "function") model.setValue(finalCode);
        }
      } else if (model && typeof model.setValue === "function") {
        model.setValue(finalCode);
      }
    }

    if (editor && typeof editor.trigger === "function") {
      try { editor.trigger("keyboard", "type", { text: "" }); } catch (_) { }
    }

    if (typeof discovered.onChange === "function") {
      try { discovered.onChange(finalCode, {}); } catch (_) { }
    }

    verifiedCode = (model && typeof model.getValue === "function") ? model.getValue() : finalCode;
  }
  else if (discovered.type === "codemirror" && discovered.instance) {
    if (typeof discovered.instance.setValue === "function") {
      discovered.instance.setValue(finalCode);
    }
    if (typeof discovered.onChange === "function") {
      try { discovered.onChange(finalCode); } catch (_) { }
    }
    verifiedCode = typeof discovered.instance.getValue === "function" ? discovered.instance.getValue() : finalCode;
  }
  else if (discovered.type === "codemirror6" && discovered.instance) {
    const view = discovered.instance;
    if (view.state && view.dispatch) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: finalCode } });
    }
    verifiedCode = view.state ? view.state.doc.toString() : finalCode;
  }
  else if (discovered.type === "textarea" && discovered.element) {
    const el = discovered.element;
    if (typeof el.focus === "function") {
      try { el.focus(); } catch (_) { }
    }
    el.value = finalCode;
    try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) { }
    try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) { }
    verifiedCode = el.value;
  }

  return {
    success: true,
    ok: true,
    selected: true,
    verified_code: true,
    editorType: discovered.type,
    length: (verifiedCode || finalCode).length,
    code: verifiedCode || finalCode
  };
}

if (typeof globalThis !== "undefined") {
  globalThis.handleTriggerSolve = handleTriggerSolve;
  globalThis.handleTriggerApply = handleTriggerApply;
  globalThis.handleTriggerAutoLoop = handleTriggerAutoLoop;
  globalThis.handleOpenPopupHud = handleOpenPopupHud;
  globalThis.updateActionBadge = updateActionBadge;
  globalThis.readCodeFromMainWorld = readCodeFromMainWorld;
  globalThis.writeCodeWithHumanTypingInMainWorld = writeCodeWithHumanTypingInMainWorld;
  globalThis.selectMultiOptionsInMainWorld = selectMultiOptionsInMainWorld;
  globalThis.ensureScriptInjected = ensureScriptInjected;
  globalThis.injectedTabScripts = injectedTabScripts;
  globalThis.isBackendRunning = isBackendRunning;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    handleTriggerSolve,
    handleTriggerApply,
    handleTriggerAutoLoop,
    handleOpenPopupHud,
    updateActionBadge,
    readCodeFromMainWorld,
    writeCodeWithHumanTypingInMainWorld,
    selectMultiOptionsInMainWorld,
    ensureScriptInjected,
    injectedTabScripts,
    get isBackendRunning() { return isBackendRunning; }
  };
}


