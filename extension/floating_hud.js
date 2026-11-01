/**
 * QuizZy - Compact Rectangular Floating Bar & Movable White Dot HUD
 * 
 * Crisp, Shadow-DOM isolated on-page toolbar (~36px height, dark slate #111827).
 * Featuring Movable White Dot mode (double-tap Z or double-click dot)
 * and double-tap hotkeys (Ctrl, Z/Alt, Fn/Shift).
 */

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") {
    const mockInstance = {
      isMock: true,
      isVisible: () => true,
      isHidden: () => false,
      isMinimized: () => false,
      toggle: () => { },
      show: () => { },
      hide: () => { },
      setMinimized: () => { },
      setHidden: () => { },
      destroy: () => { }
    };
    if (typeof module !== "undefined" && module.exports) {
      module.exports = mockInstance;
    }
    return { success: true, mounted: false, mock: true };
  }

  function isInsideCodeEditor(el) {
    if (!el) return false;
    if (typeof el.closest === "function") {
      try {
        return !!el.closest('.monaco-editor, .ace_editor, .cm-editor, .CodeMirror, [class*="monaco-editor"], [class*="ace_editor"]');
      } catch (_) { }
    }
    let cur = el;
    while (cur) {
      const cls = cur.className || "";
      if (typeof cls === "string" && (cls.includes("monaco-editor") || cls.includes("ace_editor") || cls.includes("cm-editor") || cls.includes("CodeMirror"))) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function hasQuizOptionsOutsideEditor(docRef) {
    if (typeof window !== "undefined" && window.QuizZyExtractor && typeof window.QuizZyExtractor.hasQuizOptionsOutsideEditor === "function") {
      try {
        return window.QuizZyExtractor.hasQuizOptionsOutsideEditor(docRef);
      } catch (_) { }
    }
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc) return false;
    try {
      const headerText = (doc.body ? (doc.body.innerText || doc.body.textContent || "") : (doc.documentElement ? doc.documentElement.textContent || "" : "")).slice(0, 1500).toLowerCase();
      const isCodingHeader = /coding\s*practice/i.test(headerText);
      const hasQuizHeader = !isCodingHeader && (/mcq\s*practice|practice\s*\|\s*|quiz\b/i.test(headerText));

      const allRadios = doc.querySelectorAll ? Array.from(doc.querySelectorAll("input[type='radio']")) : [];
      const radios = allRadios.filter(r => !isInsideCodeEditor(r));
      if (radios.length >= 2) return true;

      const allCheckboxes = doc.querySelectorAll ? Array.from(doc.querySelectorAll("input[type='checkbox'], [role='checkbox']")) : [];
      const checkboxes = allCheckboxes.filter(c => !isInsideCodeEditor(c));
      if (checkboxes.length >= 2) return true;

      const candidateEls = doc.querySelectorAll ? Array.from(doc.querySelectorAll(".quiz-option, [data-quiz-option], [class*='radio-item'], [class*='option-item'], [role='radio'], [role='option'], [data-rbd-draggable-id]")) : [];
      const optionCandidates = candidateEls.filter(el => !isInsideCodeEditor(el));
      if (optionCandidates.length >= 2) return true;

      if (!isCodingHeader) {
        const buttons = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn")).filter(b => !isInsideCodeEditor(b)) : [];
        const btnTexts = buttons.map(b => (b.innerText || b.textContent || b.value || "").trim().toLowerCase());
        const hasSubmit = btnTexts.some(t => /^(?:submit|submit\s*answer)$/i.test(t));
        const hasShowOrSkip = btnTexts.some(t => /^(?:show\s*answer|skip)$/i.test(t));
        if (hasSubmit && (hasShowOrSkip || hasQuizHeader)) {
          return true;
        }
      }
    } catch (_) { }
    return false;
  }

  function isProctoredCodingPage() {
    if (typeof window === "undefined") return false;
    try {
      const loc = window.location;
      const pathname = (loc && loc.pathname) ? loc.pathname : "";

      // 1. Dedicated coding routes on CCBP (never mount in-page HUD on /question/*)
      if (pathname.includes("/question/") && !pathname.includes("/primitive-coding/practice/")) {
        return true;
      }
      if (pathname.includes("/coding/") && !pathname.includes("/practice")) {
        return true;
      }

      const doc = (typeof document !== "undefined") ? document : null;
      if (doc && hasQuizOptionsOutsideEditor(doc)) {
        return false;
      }

      const headerText = (doc && doc.body ? (doc.body.innerText || doc.body.textContent || "") : "").slice(0, 1500).toLowerCase();
      if (/coding\s*practice/i.test(headerText)) {
        return true;
      }

      if (doc && doc.querySelector) {
        const editor = doc.querySelector(".monaco-editor, .ace_editor, [data-editor='monaco']");
        if (editor) {
          const runBtns = Array.from(doc.querySelectorAll("button, [role='button']"))
            .map(b => (b.innerText || b.textContent || "").trim().toLowerCase());
          const hasRunCode = runBtns.some(t => /^(?:run|run\s*code|custom\s*input|compile\s*&\s*run|▶\s*run)$/i.test(t));
          if (hasRunCode) return true;
        }
      }
    } catch (_) { }
    return false;
  }

  const HOST_ID = "__quizzy_hud_host__";

  function destroyInPageHudIfPresent() {
    try {
      const doc = (typeof document !== "undefined") ? document : null;
      if (doc) {
        const host = (typeof doc.getElementById === "function") ? doc.getElementById(HOST_ID) : null;
        if (host) {
          try {
            if (typeof host.remove === "function") {
              host.remove();
            } else if (host.parentNode && typeof host.parentNode.removeChild === "function") {
              host.parentNode.removeChild(host);
            }
          } catch (_) { }
        }
        if (typeof doc.querySelectorAll === "function") {
          try {
            const staleHosts = doc.querySelectorAll(`#${HOST_ID}, [id*="quizzy_hud"]`);
            if (staleHosts && staleHosts.length > 0) {
              for (const sh of staleHosts) {
                try {
                  if (typeof sh.remove === "function") sh.remove();
                  else if (sh.parentNode && typeof sh.parentNode.removeChild === "function") sh.parentNode.removeChild(sh);
                } catch (_) { }
              }
            }
          } catch (_) { }
        }
      }
      if (typeof window !== "undefined") {
        if (window.__QUIZZY_HUD_INSTANCE__) {
          if (!window.__QUIZZY_HUD_INSTANCE__.isCodingMode) {
            try {
              if (typeof window.__QUIZZY_HUD_INSTANCE__.destroy === "function") {
                window.__QUIZZY_HUD_INSTANCE__.destroy();
              }
            } catch (_) { }
            try { delete window.__QUIZZY_HUD_INSTANCE__; } catch (_) { window.__QUIZZY_HUD_INSTANCE__ = null; }
          }
        }
      }
    } catch (_) { }
  }

  // Hook SPA navigation transitions without duplicate listeners or unnecessary polling
  function setupSpaNavigationListeners() {
    if (typeof window === "undefined") return;
    if (window.__QUIZZY_SPA_LISTENERS_INITIALIZED__) return;
    window.__QUIZZY_SPA_LISTENERS_INITIALIZED__ = true;

    const onNavigation = () => {
      if (isProctoredCodingPage()) {
        destroyInPageHudIfPresent();
        const codingInst = getActiveCodingHudInstance();
        setupStealthCodingKeyboardShortcuts(codingInst);
      } else {
        // Hide HUD on page redirect/navigation so it only appears when user presses Ctrl
        if (typeof hide === "function") {
          hide();
        } else if (typeof setHidden === "function") {
          setHidden(true);
        }
      }
    };

    if (typeof window.addEventListener === "function") {
      window.addEventListener("popstate", onNavigation);
      window.addEventListener("hashchange", onNavigation);
    }

    if (typeof history !== "undefined") {
      if (typeof history.pushState === "function") {
        const origPush = history.pushState;
        history.pushState = function (...args) {
          const res = origPush.apply(this, args);
          try { onNavigation(); } catch (_) { }
          return res;
        };
      }
      if (typeof history.replaceState === "function") {
        const origReplace = history.replaceState;
        history.replaceState = function (...args) {
          const res = origReplace.apply(this, args);
          try { onNavigation(); } catch (_) { }
          return res;
        };
      }
    }
  }

  setupSpaNavigationListeners();

  function getCornerCoordinates(dotSize = 9, margin = 16) {
    const winW = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1920;
    const winH = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 1080;
    const targetX = Math.max(3, winW - dotSize - margin);
    const targetY = Math.max(3, winH - dotSize - margin);
    return { x: targetX, y: targetY };
  }

  function resetDotPositionToCorner(wrapperEl) {
    if (!wrapperEl || !wrapperEl.style) return;
    const corner = getCornerCoordinates();
    wrapperEl.style.left = `${corner.x}px`;
    wrapperEl.style.top = `${corner.y}px`;
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ quizzy_dot_pos: { left: corner.x, top: corner.y } });
    }
  }

  function positionWrapperAtCurrentLocation(wrapperEl) {
    if (!wrapperEl || !wrapperEl.style) return;
    resetDotPositionToCorner(wrapperEl);
  }

  const CODING_DOT_STYLES = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :host { all: initial; }
    .quizzy-hud-wrapper { position: fixed; pointer-events: auto; user-select: none; z-index: 2147483647; }
    .quizzy-hud-wrapper.hidden { display: none !important; }
    .hud-mini-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #93C5FD; border: 1px solid #FFFFFF;
      box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.6), 0 0 4px 1.5px rgba(96, 165, 250, 0.4);
      cursor: grab; user-select: none; transition: transform 0.15s ease, box-shadow 0.25s ease, background-color 0.25s ease, border-color 0.25s ease;
      display: block !important; visibility: visible !important; opacity: 1 !important; pointer-events: auto !important; position: relative; box-sizing: border-box;
    }
    .hud-mini-dot::before { content: ""; position: absolute; top: -12px; left: -12px; right: -12px; bottom: -12px; border-radius: 50%; cursor: grab; }
    .hud-mini-dot:hover { transform: scale(1.35); }
    .hud-mini-dot.dragging { cursor: grabbing; transform: scale(1.45); }
    .hud-mini-dot.glow-red { background: #FCA5A5 !important; border: 1px solid #FFFFFF !important; box-shadow: 0 0 0 1px rgba(252, 165, 165, 0.65), 0 0 4px 1.5px rgba(248, 113, 113, 0.45), 0 0 7px 2px rgba(254, 202, 202, 0.3) !important; animation: hud-dot-pulse-red 1.2s infinite ease-in-out !important; }
    @keyframes hud-dot-pulse-red { 0%, 100% { box-shadow: 0 0 0 1px rgba(252, 165, 165, 0.55), 0 0 3px 1px rgba(248, 113, 113, 0.4); transform: scale(1); } 50% { box-shadow: 0 0 0 1.5px rgba(252, 165, 165, 0.35), 0 0 6px 2px rgba(248, 113, 113, 0.55); transform: scale(1.15); } }
    .hud-mini-dot.glow-green { background: #86EFAC !important; border: 1px solid #FFFFFF !important; box-shadow: 0 0 0 1px rgba(134, 239, 172, 0.65), 0 0 4px 1.5px rgba(74, 222, 128, 0.45), 0 0 7px 2px rgba(187, 247, 208, 0.3) !important; animation: hud-dot-pulse-green 1.2s infinite ease-in-out !important; }
    @keyframes hud-dot-pulse-green {
      0%, 100% {
        opacity: 1;
        transform: scale(1.15);
        box-shadow: 0 0 0 1.5px rgba(134, 239, 172, 0.7), 0 0 5px 1.5px rgba(74, 222, 128, 0.5), 0 0 8px 2px rgba(187, 247, 208, 0.35);
      }
      50% {
        opacity: 0.2;
        transform: scale(0.85);
        box-shadow: 0 0 0 0 rgba(134, 239, 172, 0);
      }
    }
    .hud-mini-dot.glow-orange { background: #FDE68A !important; border: 1px solid #FFFFFF !important; box-shadow: 0 0 0 1px rgba(253, 230, 138, 0.65), 0 0 4px 1.5px rgba(251, 191, 36, 0.45), 0 0 7px 2px rgba(254, 243, 199, 0.3) !important; animation: hud-dot-pulse-orange 1.2s infinite ease-in-out !important; }
    @keyframes hud-dot-pulse-orange {
      0%, 100% {
        opacity: 1;
        transform: scale(1.15);
        box-shadow: 0 0 0 1.5px rgba(253, 230, 138, 0.7), 0 0 5px 1.5px rgba(251, 191, 36, 0.5), 0 0 8px 2px rgba(254, 243, 199, 0.35);
      }
      50% {
        opacity: 0.2;
        transform: scale(0.85);
        box-shadow: 0 0 0 0 rgba(253, 230, 138, 0);
      }
    }
    .hud-mini-dot.glow-blue { background: #93C5FD !important; border: 1px solid #FFFFFF !important; box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.6), 0 0 4px 1.5px rgba(96, 165, 250, 0.4), 0 0 7px 2px rgba(191, 219, 254, 0.3) !important; animation: none !important; }
    .hud-mini-dot.auto-running { animation: hud-dot-pulse-green 1.2s infinite ease-in-out !important; }
  `;

  let isStartingBackend = false;
  let backendPollTimer = null;
  const pendingBackendCallbacks = [];

  function handleTriggerStartBackend(inst, dotEl, onOnlineCallback) {
    if (typeof onOnlineCallback === "function") {
      pendingBackendCallbacks.push(onOnlineCallback);
    }

    const checkFn = (inst && typeof inst.checkHealth === "function")
      ? inst.checkHealth
      : (typeof checkHealth === "function" ? checkHealth : null);

    const fireOnline = () => {
      if (backendPollTimer) {
        clearInterval(backendPollTimer);
        backendPollTimer = null;
      }
      isStartingBackend = false;
      if (inst) inst.isBackendOnline = true;
      if (typeof backendOnline !== "undefined") backendOnline = true;
      if (inst && typeof inst.updateDotState === "function") inst.updateDotState();
      else if (typeof updateDotState === "function") updateDotState();
      while (pendingBackendCallbacks.length > 0) {
        const cb = pendingBackendCallbacks.shift();
        try { cb(); } catch (_) { }
      }
    };

    if (isStartingBackend) {
      if (checkFn) {
        checkFn((isOnline) => {
          if (isOnline) {
            fireOnline();
          }
        });
      }
      return;
    }
    isStartingBackend = true;

    const isAuto = Boolean((inst && inst.isAutoRunning) || (typeof isAutoRunning !== "undefined" && isAutoRunning));
    if (!isAuto && dotEl && dotEl.classList) {
      dotEl.classList.remove("glow-red", "glow-green", "glow-blue");
      dotEl.classList.add("glow-orange");
      dotEl.title = "QuizZy: Starting backend server... Please wait";
    }

    if (checkFn) {
      checkFn((isOnline) => {
        if (isOnline) {
          fireOnline();
        }
      });
    }

    const onBackendStartMsg = (res) => {
      console.log("[QuizZy] START_BACKEND response:", res);
    };

    if (typeof sendExtensionMessage === "function") {
      sendExtensionMessage({ action: "START_BACKEND" }, onBackendStartMsg);
    } else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ action: "START_BACKEND" }, onBackendStartMsg);
    }

    let attempts = 0;
    const maxAttempts = 24;
    if (backendPollTimer) {
      clearInterval(backendPollTimer);
      backendPollTimer = null;
    }
    backendPollTimer = setInterval(() => {
      attempts++;
      if (checkFn) {
        checkFn((isOnline) => {
          if (isOnline) {
            fireOnline();
          } else if (attempts >= maxAttempts) {
            if (backendPollTimer) {
              clearInterval(backendPollTimer);
              backendPollTimer = null;
            }
            isStartingBackend = false;
            pendingBackendCallbacks.length = 0;
            if (inst) {
              if (inst.isAutoRunning) {
                inst.isAutoRunning = false;
                inst.autoErrorOccurred = true;
                inst.autoErrorMessage = "Backend failed to start";
                if (typeof inst.updateDotState === "function") inst.updateDotState();
              }
            }
            if (typeof isAutoRunning !== "undefined" && isAutoRunning) {
              if (typeof stopAutoMode === "function") {
                stopAutoMode("Backend failed to start");
              } else {
                isAutoRunning = false;
                autoErrorOccurred = true;
                autoErrorMessage = "Backend failed to start";
                if (typeof updateDotState === "function") updateDotState();
              }
            }
            if (dotEl && dotEl.classList) {
              dotEl.classList.remove("glow-orange", "glow-green", "auto-running");
              dotEl.classList.add("glow-red");
              dotEl.title = "QuizZy: Backend Offline (Click dot to start backend)";
            }
          }
        });
      } else {
        if (backendPollTimer) {
          clearInterval(backendPollTimer);
          backendPollTimer = null;
        }
        isStartingBackend = false;
        pendingBackendCallbacks.length = 0;
      }
    }, 350);
  }

  let globalStealthCodingInstance = null;

  function createStealthCodingHudInstance() {
    const inst = {
      isCodingMode: true,
      quizzyMode: "code",
      getMode: () => "code",
      setMode: () => { },
      toggleMode: () => { },
      isMock: true,
      isProctoredCodingPage: () => true,
      isVisible: () => Boolean(inst.wrapper && !inst.wrapper.classList.contains("hidden")),
      isHidden: () => !inst.wrapper || inst.wrapper.classList.contains("hidden"),
      isMinimized: () => false,
      isAutoRunning: false,
      isBackendOnline: false,
      autoErrorOccurred: false,
      autoErrorMessage: "",
      toggle: () => {
        if (inst.wrapper && inst.wrapper.classList) {
          inst.wrapper.classList.toggle("hidden");
          if (!inst.wrapper.classList.contains("hidden")) {
            inst.updateDotState();
          }
        }
      },
      show: () => {
        if (inst.wrapper && inst.wrapper.classList) {
          inst.wrapper.classList.remove("hidden");
        }
        inst.updateDotState();
      },
      hide: () => {
        if (inst.wrapper && inst.wrapper.classList) {
          inst.wrapper.classList.add("hidden");
        }
      },
      setMinimized: () => { },
      setHidden: (val) => {
        if (!inst.wrapper || !inst.wrapper.classList) return;
        if (val) inst.wrapper.classList.add("hidden");
        else {
          inst.wrapper.classList.remove("hidden");
          inst.updateDotState();
        }
      },
      solve: () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "TRIGGER_SOLVE" }, () => { if (chrome.runtime.lastError) {} });
        }
      },
      apply: () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "TRIGGER_APPLY" }, () => { if (chrome.runtime.lastError) {} });
        }
      },
      skip: () => { },
      next: () => {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "TRIGGER_CODING_AUTO_LOOP" }, () => { if (chrome.runtime.lastError) {} });
        }
      },
      startAuto: () => {
        inst.isAutoRunning = true;
        inst.autoErrorOccurred = false;
        inst.autoErrorMessage = "";
        if (inst.wrapper && inst.wrapper.classList) {
          resetDotPositionToCorner(inst.wrapper);
          inst.wrapper.classList.remove("hidden");
        }
        inst.updateDotState();

        if (!inst.isBackendOnline) {
          handleTriggerStartBackend(inst, inst.miniDot);
        }

        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "TRIGGER_CODING_AUTO_LOOP" }, (res) => {
            if (res && res.error) {
              inst.autoErrorOccurred = true;
              inst.autoErrorMessage = res.error;
            } else {
              inst.autoErrorOccurred = false;
              inst.autoErrorMessage = "";
            }
            inst.isAutoRunning = false;
            inst.updateDotState();
          });
        }
      },
      stopAuto: () => {
        inst.isAutoRunning = false;
        inst.updateDotState();
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "STOP_AUTO" }, () => { if (chrome.runtime.lastError) {} });
        }
      },
      updateDotState: () => { },
      checkHealth: (cb) => {
        const sendFn = (typeof sendExtensionMessage === "function")
          ? sendExtensionMessage
          : ((typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function")
            ? chrome.runtime.sendMessage.bind(chrome.runtime)
            : null);
        if (sendFn) {
          try {
            sendFn({ action: "CHECK_HEALTH" }, (res) => {
              const ok = Boolean(res && res.success && res.data && (res.data.status === "ok" || res.data.status === "degraded"));
              inst.isBackendOnline = ok;
              inst.updateDotState();
              if (cb) cb(ok, res);
            });
            return;
          } catch (_) {}
        }
        inst.isBackendOnline = false;
        inst.updateDotState();
        if (cb) cb(false);
      },
      destroy: () => {
        if (inst.__codingHealthInterval__) {
          clearInterval(inst.__codingHealthInterval__);
          inst.__codingHealthInterval__ = null;
        }
        const doc = (typeof document !== "undefined") ? document : null;
        if (doc) {
          const host = (typeof doc.getElementById === "function") ? doc.getElementById(HOST_ID) : null;
          if (host && host.parentNode) {
            host.parentNode.removeChild(host);
          }
        }
        if (typeof window !== "undefined") {
          try { delete window.__QUIZZY_HUD_INSTANCE__; } catch (_) { window.__QUIZZY_HUD_INSTANCE__ = null; }
        }
      }
    };
    return inst;
  }

  function getActiveCodingHudInstance() {
    if (typeof window !== "undefined" && window.__QUIZZY_HUD_INSTANCE__ && window.__QUIZZY_HUD_INSTANCE__.isCodingMode) {
      return window.__QUIZZY_HUD_INSTANCE__;
    }
    if (globalStealthCodingInstance && globalStealthCodingInstance.isCodingMode) {
      if (typeof window !== "undefined") {
        window.__QUIZZY_HUD_INSTANCE__ = globalStealthCodingInstance;
      }
      return globalStealthCodingInstance;
    }
    globalStealthCodingInstance = createStealthCodingHudInstance();
    if (typeof window !== "undefined") {
      window.__QUIZZY_HUD_INSTANCE__ = globalStealthCodingInstance;
    }
    return globalStealthCodingInstance;
  }

  function mountCodingDotHud(inst) {
    if (!inst) inst = getActiveCodingHudInstance();
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    let host = (typeof document.getElementById === "function") ? document.getElementById(HOST_ID) : null;
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.setAttribute("data-quizzy-ignore", "true");
      host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: none; overflow: visible;";
      if (document.documentElement && typeof document.documentElement.appendChild === "function") {
        document.documentElement.appendChild(host);
      } else if (document.body && typeof document.body.appendChild === "function") {
        document.body.appendChild(host);
      }
    }
    let shadow = host ? host.shadowRoot : null;
    if (host && !shadow) {
      try {
        if (typeof host.attachShadow === "function") {
          shadow = host.attachShadow({ mode: "open" });
        } else {
          shadow = host.shadowRoot || host;
        }
      } catch (_) {
        shadow = host.shadowRoot || host;
      }
    }

    let wrapper = (shadow && shadow.querySelector) ? (shadow.querySelector("#quizzy-hud-wrapper") || shadow.querySelector(".quizzy-hud-wrapper")) : null;
    let miniDot = (shadow && shadow.querySelector) ? shadow.querySelector("#hud-mini-dot") : null;

    if (!wrapper || !miniDot) {
      if (shadow && typeof shadow.appendChild === "function") {
        const styleEl = document.createElement("style");
        styleEl.textContent = CODING_DOT_STYLES;
        shadow.appendChild(styleEl);

        wrapper = document.createElement("div");
        wrapper.className = "quizzy-hud-wrapper";
        wrapper.id = "quizzy-hud-wrapper";

        miniDot = document.createElement("div");
        miniDot.className = "hud-mini-dot glow-blue";
        miniDot.id = "hud-mini-dot";
        miniDot.setAttribute("role", "button");
        miniDot.setAttribute("tabindex", "0");
        miniDot.setAttribute("aria-label", "QuizZy Status Dot");
        miniDot.title = "QuizZy: Initializing...";

        wrapper.appendChild(miniDot);
        shadow.appendChild(wrapper);
      }

      const dotSize = 8;
      if (wrapper && wrapper.style) {
        wrapper.style.position = "fixed";
        positionWrapperAtCurrentLocation(wrapper);
      }

      let isDragging = false;
      let dragStartX = 0;
      let dragStartY = 0;
      let startLeft = 0;
      let startTop = 0;
      let dragDistance = 0;

      const onDotPointerMove = (e) => {
        if (!isDragging || !e || !wrapper) return;
        const dx = (e.clientX || 0) - dragStartX;
        const dy = (e.clientY || 0) - dragStartY;
        dragDistance += Math.abs(dx) + Math.abs(dy);
        const winW = (typeof window !== "undefined" ? window.innerWidth : 1920);
        const winH = (typeof window !== "undefined" ? window.innerHeight : 1080);
        const newX = Math.max(3, Math.min(startLeft + dx, winW - dotSize - 3));
        const newY = Math.max(3, Math.min(startTop + dy, winH - dotSize - 3));
        wrapper.style.left = `${newX}px`;
        wrapper.style.top = `${newY}px`;
      };

      const onDotPointerUp = () => {
        if (!isDragging) return;
        isDragging = false;
        if (miniDot && miniDot.classList) miniDot.classList.remove("dragging");
        if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
          window.removeEventListener("pointermove", onDotPointerMove, true);
          window.removeEventListener("pointerup", onDotPointerUp, true);
        }
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local && wrapper) {
          const rect = wrapper.getBoundingClientRect ? wrapper.getBoundingClientRect() : null;
          if (rect) {
            chrome.storage.local.set({ quizzy_dot_pos: { left: rect.left, top: rect.top } });
          }
        }
      };

      const onDotPointerDown = (e) => {
        if (!e) return;
        isDragging = true;
        dragDistance = 0;
        dragStartX = e.clientX || 0;
        dragStartY = e.clientY || 0;
        const rect = (wrapper && wrapper.getBoundingClientRect) ? wrapper.getBoundingClientRect() : { left: 0, top: 0 };
        startLeft = rect.left;
        startTop = rect.top;
        if (miniDot && miniDot.classList) miniDot.classList.add("dragging");
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
          window.addEventListener("pointermove", onDotPointerMove, { capture: true, passive: false });
          window.addEventListener("pointerup", onDotPointerUp, { capture: true, passive: false });
        }
      };

      if (miniDot && typeof miniDot.addEventListener === "function") {
        miniDot.addEventListener("pointerdown", onDotPointerDown);
        miniDot.addEventListener("click", () => {
          if (dragDistance > 10) return;
          const currentHud = getActiveCodingHudInstance();
          if (currentHud) {
            if (!currentHud.isBackendOnline) {
              handleTriggerStartBackend(currentHud, miniDot, () => {
                currentHud.startAuto();
              });
              return;
            }
            if (currentHud.isAutoRunning) {
              currentHud.stopAuto();
            } else {
              currentHud.startAuto();
            }
          }
        });
      }
    }

    const updateCodingDotState = () => {
      if (!miniDot || !miniDot.classList) return;
      miniDot.classList.remove("glow-red", "glow-green", "glow-orange", "glow-blue", "auto-running");
      const currentInst = getActiveCodingHudInstance();
      if (currentInst) {
        if (currentInst.autoErrorOccurred) {
          miniDot.classList.add("glow-orange");
          miniDot.title = `QuizZy Auto Mode Error: ${currentInst.autoErrorMessage || "Error occurred"}`;
        } else if (currentInst.isAutoRunning) {
          miniDot.classList.add("glow-green", "auto-running");
          miniDot.title = "QuizZy Coding Auto Mode: Running (Press Shift or click dot to stop)";
        } else if (!currentInst.isBackendOnline) {
          miniDot.classList.add("glow-red");
          miniDot.title = "QuizZy: Backend Offline (Click dot to start backend)";
        } else {
          miniDot.classList.add("glow-blue");
          miniDot.title = "QuizZy: Ready (Press Shift to toggle Auto Mode)";
        }
      }
    };

    const checkCodingHealth = (cb) => {
      const sendFn = (typeof sendExtensionMessage === "function")
        ? sendExtensionMessage
        : ((typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function")
          ? chrome.runtime.sendMessage.bind(chrome.runtime)
          : null);

      if (sendFn) {
        try {
          sendFn({ action: "CHECK_HEALTH" }, (res) => {
            const ok = Boolean(res && res.success && res.data && (res.data.status === "ok" || res.data.status === "degraded"));
            const currentInst = getActiveCodingHudInstance();
            if (currentInst) currentInst.isBackendOnline = ok;
            updateCodingDotState();
            if (cb) cb(ok, res);
          });
          return;
        } catch (_) {}
      }

      const currentInst = getActiveCodingHudInstance();
      if (currentInst) currentInst.isBackendOnline = false;
      updateCodingDotState();
      if (cb) cb(false);
    };

    if (inst) {
      inst.host = host;
      inst.shadow = shadow;
      inst.wrapper = wrapper;
      inst.miniDot = miniDot;
      inst.updateDotState = updateCodingDotState;
      inst.checkHealth = checkCodingHealth;
      inst.isVisible = () => wrapper && !wrapper.classList.contains("hidden");
      inst.isHidden = () => !wrapper || wrapper.classList.contains("hidden");
      inst.show = () => {
        if (wrapper && wrapper.classList) wrapper.classList.remove("hidden");
        updateCodingDotState();
      };
      inst.hide = () => {
        if (wrapper && wrapper.classList) wrapper.classList.add("hidden");
      };
      inst.toggle = () => {
        if (wrapper && wrapper.classList) {
          wrapper.classList.toggle("hidden");
          if (!wrapper.classList.contains("hidden")) updateCodingDotState();
        }
      };
      inst.setHidden = (val) => {
        if (!wrapper || !wrapper.classList) return;
        if (val) wrapper.classList.add("hidden");
        else {
          wrapper.classList.remove("hidden");
          updateCodingDotState();
        }
      };
    }

    checkCodingHealth();
    if (inst && !inst.__codingHealthInterval__) {
      inst.__codingHealthInterval__ = setInterval(() => {
        checkCodingHealth();
      }, 3000);
      if (inst.__codingHealthInterval__ && typeof inst.__codingHealthInterval__.unref === "function") {
        inst.__codingHealthInterval__.unref();
      }
    }
    updateCodingDotState();
    return { host, shadow, wrapper, miniDot };
  }

  // Stealth keyboard shortcuts: active on window with ZERO DOM footprint
  function setupStealthCodingKeyboardShortcuts(codingHudInstance) {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    if (window.__QUIZZY_KEYBOARD_INITIALIZED__) return;
    window.__QUIZZY_KEYBOARD_INITIALIZED__ = true;

    let ctrlDown = false;
    let ctrlComboUsed = false;
    let shiftDown = false;
    let shiftComboUsed = false;

    const onStealthCodingKeyDown = function (e) {
      if (!e) return;
      const hud = getActiveCodingHudInstance();
      if (e.key === "Escape" || e.key === "Esc") {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "KILL_SWITCH_TRIGGERED", reason: "Escape hotkey" }, () => { if (chrome.runtime.lastError) {} });
        }
        if (hud && hud.isAutoRunning) {
          hud.stopAuto();
        }
        return;
      }

      if (e.repeat) return;

      const isControl = e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight" || e.keyCode === 17 || e.which === 17;
      const isShift = e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight" || e.keyCode === 16 || e.which === 16;

      if (isControl) {
        if (ctrlDown) return;
        ctrlDown = true;
        ctrlComboUsed = false;
        return;
      } else if (isShift) {
        const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
        if (isEditableElement(e.target) || isEditableElement(activeEl) || e.ctrlKey || e.altKey || e.metaKey) {
          shiftComboUsed = true;
          return;
        }
        if (shiftDown) return;
        shiftDown = true;
        shiftComboUsed = false;
        return;
      } else {
        if (ctrlDown) ctrlComboUsed = true;
        if (shiftDown) shiftComboUsed = true;
      }

      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const key = (e.key || "").toLowerCase();
      const code = e.code || "";

      // Specifically allow Alt+S, Alt+A, Alt+N, Alt+M even when focused inside Monaco's <textarea class="inputarea">
      if (key === "s" || code === "KeyS") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "TRIGGER_SOLVE" }, () => { if (chrome.runtime.lastError) {} });
        }
        return;
      }
      if (key === "a" || code === "KeyA") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "TRIGGER_APPLY" }, () => { if (chrome.runtime.lastError) {} });
        }
        return;
      }
      if (key === "n" || code === "KeyN") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "TRIGGER_CODING_AUTO_LOOP" }, () => { if (chrome.runtime.lastError) {} });
        }
        return;
      }
      if (key === "m" || code === "KeyM") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ action: "OPEN_POPUP_HUD", force: true }, () => { if (chrome.runtime.lastError) {} });
        }
        return;
      }
    };

    let lastStealthHandledEvent = null;

    const onStealthCodingKeyUp = function (e) {
      if (!e || e === lastStealthHandledEvent || e.__quizzy_handled__) return;
      const isControl = e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight" || e.keyCode === 17 || e.which === 17;
      const isShift = e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight" || e.keyCode === 16 || e.which === 16;

      const hud = getActiveCodingHudInstance();

      if (isControl) {
        ctrlDown = false;
        if (!ctrlComboUsed) {
          lastStealthHandledEvent = e;
          e.__quizzy_handled__ = true;

          const wasMounted = Boolean(hud && hud.wrapper);
          mountCodingDotHud(hud);
          if (hud) {
            resetDotPositionToCorner(hud.wrapper);
            if (!wasMounted || hud.isHidden()) {
              hud.show();
            } else {
              hud.hide();
            }
          }
        }
      } else if (isShift) {
        const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
        if (isEditableElement(e.target) || isEditableElement(activeEl)) {
          shiftDown = false;
          shiftComboUsed = true;
          return;
        }
        const wasDown = shiftDown;
        const wasCombo = shiftComboUsed;
        shiftDown = false;
        shiftComboUsed = false;
        if (wasDown && !wasCombo) {
          lastStealthHandledEvent = e;
          e.__quizzy_handled__ = true;

          mountCodingDotHud(hud);
          if (hud) {
            if (hud.isAutoRunning) {
              hud.stopAuto();
            } else {
              resetDotPositionToCorner(hud.wrapper);
              hud.show();
              hud.startAuto();
            }
          }
        }
      }
    };

    const onStealthCodingPointerDown = function (e) {
      if (!e || e === lastStealthHandledEvent || e.__quizzy_handled__) return;

      const hud = getActiveCodingHudInstance();
      const isInsideHud = Boolean(e.target && (
        (hud && hud.miniDot && (e.target === hud.miniDot || (hud.miniDot.contains && hud.miniDot.contains(e.target)))) ||
        (hud && hud.wrapper && (e.target === hud.wrapper || (hud.wrapper.contains && hud.wrapper.contains(e.target))))
      ));
      if (isInsideHud) return;

      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        ctrlComboUsed = true;
        lastStealthHandledEvent = e;
        e.__quizzy_handled__ = true;

        const wasMounted = Boolean(hud && hud.wrapper);
        mountCodingDotHud(hud);
        if (hud) {
          resetDotPositionToCorner(hud.wrapper);
          if (!wasMounted || hud.isHidden()) {
            hud.show();
          } else {
            hud.hide();
          }
        }
      }
    };

    const onStealthCodingBlur = function () {
      ctrlDown = false;
      ctrlComboUsed = false;
      shiftDown = false;
      shiftComboUsed = false;
    };

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.__QUIZZY_STEALTH_SHORTCUT_HANDLER__ = onStealthCodingKeyDown;
      window.addEventListener("keydown", onStealthCodingKeyDown, { capture: true, passive: false });
      window.addEventListener("keyup", onStealthCodingKeyUp, { capture: true, passive: false });
      window.addEventListener("pointerdown", onStealthCodingPointerDown, { capture: true, passive: true });
      window.addEventListener("blur", onStealthCodingBlur);
    } else if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("keydown", onStealthCodingKeyDown, { capture: true, passive: false });
      document.addEventListener("keyup", onStealthCodingKeyUp, { capture: true, passive: false });
      document.addEventListener("pointerdown", onStealthCodingPointerDown, { capture: true, passive: true });
      document.addEventListener("blur", onStealthCodingBlur);
    }
  }

  // Strict Zero-DOM Stealth on Dedicated Coding Routes (e.g. learning.ccbp.in/question/*)
  // Aborts host/shadow DOM creation on pure coding routes.
  // Actively unmounts any leaked in-page HUD if user navigated via SPA.
  if (isProctoredCodingPage()) {
    if (typeof window !== "undefined" && window.__QUIZZY_HUD_INSTANCE__ && window.__QUIZZY_HUD_INSTANCE__.isCodingMode) {
      const existing = window.__QUIZZY_HUD_INSTANCE__;
      return {
        success: true,
        mounted: Boolean(existing.wrapper),
        codingMode: true,
        quizzyMode: "code",
        instance: existing
      };
    }
    destroyInPageHudIfPresent();

    const codingHudInstance = getActiveCodingHudInstance();
    setupStealthCodingKeyboardShortcuts(codingHudInstance);

    window.__QUIZZY_HUD_INSTANCE__ = codingHudInstance;
    if (typeof module !== "undefined" && module.exports) {
      module.exports = codingHudInstance;
    }
    return {
      success: true,
      mounted: Boolean(codingHudInstance.wrapper),
      codingMode: true,
      quizzyMode: "code",
      instance: codingHudInstance
    };
  }

  // Idempotency: Return existing instance if already initialized
  if (window.__QUIZZY_HUD_INSTANCE__) {
    const existing = window.__QUIZZY_HUD_INSTANCE__;
    return {
      success: true,
      mounted: true,
      alreadyMounted: true,
      visible: existing.isVisible(),
      instance: existing
    };
  }

  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    const fallbackInstance = {
      isMock: true,
      getMode: () => "mcq",
      toggleMode: () => { },
      isVisible: () => false,
      isHidden: () => true,
      isMinimized: () => false,
      toggle: () => { },
      show: () => { },
      hide: () => { },
      setMinimized: () => { },
      setHidden: () => { },
      destroy: () => { }
    };
    if (typeof module !== "undefined" && module.exports) {
      module.exports = fallbackInstance;
    }
    return { success: false, mounted: false, error: "document.createElement is not a function", instance: fallbackInstance };
  }

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-quizzy-ignore", "true");
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: none; overflow: visible;";

    if (document.documentElement && typeof document.documentElement.appendChild === "function") {
      document.documentElement.appendChild(host);
    } else if (document.body && typeof document.body.appendChild === "function") {
      document.body.appendChild(host);
    }
  }

  let shadow = host.shadowRoot;
  if (!shadow) {
    try {
      if (typeof host.attachShadow === "function") {
        shadow = host.attachShadow({ mode: "open" });
      } else {
        shadow = host.shadowRoot || host;
      }
    } catch (_) {
      shadow = host.shadowRoot || host;
    }
  }

  // ==========================================================================
  // HUD Scoped Compact Rectangular & White Dot CSS Styles
  // ==========================================================================
  const HUD_STYLES = `
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    :host {
      all: initial;
    }

    .quizzy-hud-wrapper {
      position: fixed;
      pointer-events: auto;
      user-select: none;
      z-index: 2147483647;
      box-shadow: none;
      filter: none;
      transition: opacity 120ms ease, transform 120ms ease;
    }

    .quizzy-hud-wrapper.hidden {
      display: none !important;
    }

    /* Compact Rectangular Bar: Permanently Hidden (Dot remains visible) */
    .hud-bar,
    .hud-bar.hidden,
    .hud-bar:not(.hidden) {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      max-height: 0 !important;
      max-width: 0 !important;
      overflow: hidden !important;
      position: absolute !important;
      left: -9999px !important;
    }

    /* Movable Glow Dot (Always Visible, Tiny, Light Color, Follows Cursor) */
    .hud-mini-dot,
    .hud-mini-dot.hidden {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #FFFFFF;
      border: 1px solid #60A5FA;
      box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.6), 0 0 4px 1.5px rgba(96, 165, 250, 0.4);
      cursor: grab;
      user-select: none;
      transition: transform 0.15s ease, box-shadow 0.25s ease, background-color 0.25s ease, border-color 0.25s ease;
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: auto !important;
      position: relative;
      box-sizing: border-box;
    }

    /* Generous invisible grab zone so the tiny dot is effortless to drag & click */
    .hud-mini-dot::before {
      content: "";
      position: absolute;
      top: -12px;
      left: -12px;
      right: -12px;
      bottom: -12px;
      border-radius: 50%;
      cursor: grab;
    }

    .hud-mini-dot:hover {
      transform: scale(1.35);
    }

    .hud-mini-dot.dragging {
      cursor: grabbing;
      transform: scale(1.45);
    }

    /* 1. Red Glow: Backend is not running (Light soft red) */
    .hud-mini-dot.glow-red {
      background: #FCA5A5 !important;
      border: 1px solid #FFFFFF !important;
      box-shadow: 0 0 0 1px rgba(252, 165, 165, 0.65), 0 0 4px 1.5px rgba(248, 113, 113, 0.45), 0 0 7px 2px rgba(254, 202, 202, 0.3) !important;
      animation: hud-dot-pulse-red 1.2s infinite ease-in-out !important;
    }

    @keyframes hud-dot-pulse-red {
      0%, 100% {
        box-shadow: 0 0 0 1px rgba(252, 165, 165, 0.55), 0 0 3px 1px rgba(248, 113, 113, 0.4);
        transform: scale(1);
      }
      50% {
        box-shadow: 0 0 0 1.5px rgba(252, 165, 165, 0.35), 0 0 6px 2px rgba(248, 113, 113, 0.55);
        transform: scale(1.15);
      }
    }

    /* 2. Green Glow: Working in auto mode with no errors (Light soft green blink) */
    .hud-mini-dot.glow-green {
      background: #86EFAC !important;
      border: 1px solid #FFFFFF !important;
      box-shadow: 0 0 0 1px rgba(134, 239, 172, 0.65), 0 0 4px 1.5px rgba(74, 222, 128, 0.45), 0 0 7px 2px rgba(187, 247, 208, 0.3) !important;
      animation: hud-dot-pulse-green 1.2s infinite ease-in-out !important;
    }

    @keyframes hud-dot-pulse-green {
      0%, 100% {
        opacity: 1;
        transform: scale(1.15);
        box-shadow: 0 0 0 1.5px rgba(134, 239, 172, 0.7), 0 0 5px 1.5px rgba(74, 222, 128, 0.5), 0 0 8px 2px rgba(187, 247, 208, 0.35);
      }
      50% {
        opacity: 0.2;
        transform: scale(0.85);
        box-shadow: 0 0 0 0 rgba(134, 239, 172, 0);
      }
    }

    /* 3. Orange Glow: Working in auto mode but errors occur (Light soft orange) */
    .hud-mini-dot.glow-orange {
      background: #FDE68A !important;
      border: 1px solid #FFFFFF !important;
      box-shadow: 0 0 0 1px rgba(253, 230, 138, 0.65), 0 0 4px 1.5px rgba(251, 191, 36, 0.45), 0 0 7px 2px rgba(254, 243, 199, 0.3) !important;
      animation: hud-dot-pulse-orange 1.2s infinite ease-in-out !important;
    }

    @keyframes hud-dot-pulse-orange {
      0%, 100% {
        opacity: 1;
        transform: scale(1.15);
        box-shadow: 0 0 0 1.5px rgba(253, 230, 138, 0.7), 0 0 5px 1.5px rgba(251, 191, 36, 0.5), 0 0 8px 2px rgba(254, 243, 199, 0.35);
      }
      50% {
        opacity: 0.2;
        transform: scale(0.85);
        box-shadow: 0 0 0 0 rgba(253, 230, 138, 0);
      }
    }

    /* 4. Blue Glow: Backend connected & idle / ready (Light white with soft sky-blue glow) */
    .hud-mini-dot.glow-blue {
      background: #FFFFFF !important;
      border: 1px solid #60A5FA !important;
      box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.6), 0 0 4px 1.5px rgba(96, 165, 250, 0.4), 0 0 7px 2px rgba(191, 219, 254, 0.3) !important;
      animation: none !important;
    }

    .hud-mini-dot.auto-running {
      animation: hud-dot-pulse-green 1.2s infinite ease-in-out !important;
    }

    /* Left Status Dot & Mode Pill */
    .hud-grip-group {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      padding: 0 2px;
      gap: 5px;
    }

    .hud-logo-z {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      border-radius: 4px;
      background: #2563EB;
      color: #FFFFFF;
      font-weight: 800;
      font-size: 11px;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      transition: transform 120ms ease, background 120ms ease;
      flex-shrink: 0;
    }

    .hud-logo-z:hover {
      background: #1D4ED8;
      transform: scale(1.1);
    }

    .hud-mode-pill {
      display: inline-flex;
      align-items: center;
      background: #081024;
      border: 1px solid #1D356A;
      border-radius: 9px;
      padding: 1px;
      cursor: pointer;
      user-select: none;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }

    .hud-mode-opt {
      padding: 1px 4px;
      border-radius: 7px;
      color: #93C5FD;
      transition: background 120ms ease, color 120ms ease;
    }

    .hud-mode-opt.active {
      background: #2563EB;
      color: #FFFFFF;
    }

    .hud-health-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #1E3A8A;
      box-shadow: 0 0 4px rgba(30, 58, 138, 0.5);
      transition: background 200ms;
    }

    .hud-health-dot.online {
      background: #60A5FA;
      box-shadow: 0 0 5px rgba(96, 165, 250, 0.7);
    }

    .hud-health-dot.solving {
      background: #FFFFFF;
      animation: hud-pulse 1.2s infinite ease-in-out;
    }

    @keyframes hud-pulse {
      0% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.7); }
      70% { box-shadow: 0 0 0 5px rgba(96, 165, 250, 0); }
      100% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0); }
    }

    /* Center Answer Zone */
    .hud-answer-zone {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 2px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      cursor: default;
    }

    .hud-badge-option {
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      letter-spacing: 0.3px;
      padding: 1px 5px;
      border-radius: 3px;
      background: #2563EB;
      color: #FFFFFF;
      flex-shrink: 0;
    }

    .hud-badge-option.order {
      background: #1D4ED8;
      color: #FFFFFF;
    }

    .hud-badge-option.text {
      background: #0284C7;
      color: #FFFFFF;
    }

    .hud-answer-text {
      font-size: 12.5px;
      font-weight: 500;
      color: #FFFFFF;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hud-answer-text.ready {
      color: #93C5FD;
      font-weight: 400;
    }

    .hud-answer-text.solving {
      color: #BFDBFE;
      font-weight: 500;
    }

    .hud-answer-text.complete {
      color: #FFFFFF;
      font-weight: 600;
    }

    .hud-answer-text.uncertain {
      color: #93C5FD;
    }

    .hud-pill-tag {
      font-size: 9.5px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }

    .hud-tag-high {
      background: rgba(37, 99, 235, 0.2);
      color: #FFFFFF;
      border: 1px solid rgba(96, 165, 250, 0.4);
    }

    .hud-tag-med {
      background: rgba(30, 58, 138, 0.3);
      color: #BFDBFE;
      border: 1px solid rgba(59, 130, 246, 0.35);
    }

    .hud-tag-cache {
      background: rgba(2, 132, 199, 0.25);
      color: #38BDF8;
      border: 1px solid rgba(56, 189, 248, 0.35);
    }

    .hud-tag-latency {
      background: rgba(255, 255, 255, 0.08);
      color: #93C5FD;
      border: 1px solid rgba(255, 255, 255, 0.15);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    /* Right Action Group */
    .hud-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .hud-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      outline: none;
      transition: all 120ms ease-in-out;
      white-space: nowrap;
    }

    .hud-btn:focus-visible {
      box-shadow: 0 0 0 2px #60A5FA;
    }

    .hud-btn-primary {
      background: #2563EB;
      color: #FFFFFF;
    }

    .hud-btn-primary:hover:not(:disabled) {
      background: #1D4ED8;
    }

    .hud-btn-secondary {
      background: #0E1B38;
      color: #FFFFFF;
      border: 1px solid #1D356A;
    }

    .hud-btn-secondary:hover:not(:disabled) {
      background: #162B55;
      color: #FFFFFF;
    }

    .hud-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .hud-btn-auto {
      background: rgba(37, 99, 235, 0.2);
      color: #BFDBFE;
      border: 1px solid rgba(96, 165, 250, 0.35);
    }

    .hud-btn-auto:hover:not(:disabled) {
      background: rgba(37, 99, 235, 0.35);
      color: #FFFFFF;
    }

    .hud-btn-auto.running {
      background: #2563EB !important;
      color: #FFFFFF !important;
      border: none !important;
      box-shadow: 0 0 8px rgba(37, 99, 235, 0.7) !important;
      animation: hud-auto-pulse 1s infinite alternate;
    }

    @keyframes hud-auto-pulse {
      0% { opacity: 0.85; }
      100% { opacity: 1; }
    }

    .hud-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      background: transparent;
      border: none;
      color: #93C5FD;
      cursor: pointer;
      transition: background 120ms, color 120ms;
    }

    .hud-icon-btn:hover {
      background: #162B55;
      color: #FFFFFF;
    }

    /* More Popover Drawer: Permanently Hidden */
    .hud-popover,
    .hud-popover.hidden,
    .hud-popover:not(.hidden) {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      max-height: 0 !important;
      max-width: 0 !important;
      overflow: hidden !important;
      position: absolute !important;
      left: -9999px !important;
    }

    .hud-popover-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .hud-reason-text {
      font-size: 11.5px;
      color: #BFDBFE;
      line-height: 1.35;
      max-height: 48px;
      overflow-y: auto;
    }

    .hud-checkbox-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #93C5FD;
      cursor: pointer;
    }

    .hud-checkbox-label input {
      accent-color: #2563EB;
      cursor: pointer;
    }

    .hud-btn-flag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 0 8px;
      border-radius: 4px;
      background: rgba(30, 58, 138, 0.3);
      border: 1px solid rgba(59, 130, 246, 0.3);
      color: #BFDBFE;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }

    .hud-btn-flag:hover {
      background: rgba(30, 58, 138, 0.5);
    }

    .hud-btn-flag.flagged {
      background: #2563EB;
      border-color: #60A5FA;
      color: #FFFFFF;
    }

    .hud-svg {
      width: 13px;
      height: 13px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .hidden {
      display: none !important;
    }
  `;

  const styleEl = document.createElement("style");
  styleEl.textContent = HUD_STYLES;
  shadow.appendChild(styleEl);

  // ==========================================================================
  // HUD HTML Layout
  // ==========================================================================
  const wrapper = document.createElement("div");
  wrapper.className = "quizzy-hud-wrapper";
  wrapper.innerHTML = `
    <!-- Very Small Movable White Dot (9x9px) with Dark Border -->
    <div class="hud-mini-dot hidden" id="hud-mini-dot" title="Double-click or double-tap Z to expand QuizZy"></div>

    <!-- Main Compact Rectangular Bar (~36px height) -->
    <div class="hud-bar" id="hud-full-bar" title="Drag to move bar">
      <!-- Left Status & Mode Switcher -->
      <div class="hud-grip-group">
        <span class="hud-health-dot" id="hud-health-dot" title="Backend: Offline"></span>
        <span class="hud-logo-z" id="hud-logo-z" title="Double-click 'Z' to convert to dot">Z</span>
        <div class="hud-mode-pill" id="hud-mode-pill" title="Toggle Mode (Alt+M)">
          <span class="hud-mode-opt active" id="hud-mode-mcq">MCQ</span>
          <span class="hud-mode-opt" id="hud-mode-code">CODE</span>
        </div>
      </div>

      <!-- Center Answer Zone -->
      <div class="hud-answer-zone" id="hud-answer-zone">
        <span class="hud-badge-option hidden" id="hud-badge-opt">[A]</span>
        <span class="hud-answer-text ready" id="hud-answer-text" title="Ready">Ready — Click Solve (Alt+S)</span>
        <span class="hud-pill-tag hud-tag-high hidden" id="hud-tag-conf">HIGH</span>
        <span class="hud-pill-tag hud-tag-cache hidden" id="hud-tag-cache">CACHE</span>
        <span class="hud-pill-tag hud-tag-latency hidden" id="hud-tag-latency">0ms</span>
      </div>

      <!-- Right Action Group -->
      <div class="hud-actions">
        <!-- Solve (Primary) -->
        <button class="hud-btn hud-btn-primary" id="hud-btn-solve" title="Extract & Solve Question (Alt+S)">
          <svg class="hud-svg" viewBox="0 0 24 24">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"></polygon>
          </svg>
          <span>Solve</span>
        </button>

        <!-- Apply (Secondary) -->
        <button class="hud-btn hud-btn-secondary" id="hud-btn-apply" title="Apply Winning Answer Once (Alt+A)" disabled>
          <svg class="hud-svg" viewBox="0 0 24 24">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Apply</span>
        </button>

        <!-- Next / Submit Button -->
        <button class="hud-btn hud-btn-secondary" id="hud-btn-next" title="Submit & Click Next Question (Alt+N)">
          <svg class="hud-svg" viewBox="0 0 24 24">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
          <span>Next</span>
        </button>

        <!-- Auto Mode (Toggle) -->
        <button class="hud-btn hud-btn-auto" id="hud-btn-auto" title="Auto Mode (Press Shift or click dot to toggle)">
          <svg class="hud-svg" id="hud-auto-icon" viewBox="0 0 24 24">
            <polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>
          </svg>
          <span id="hud-auto-label">Auto</span>
        </button>

        <!-- More Drawer Toggle (⋯) -->
        <button class="hud-icon-btn" id="hud-btn-more" title="More Options & Reasoning">
          <svg class="hud-svg" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="1.5" fill="currentColor"></circle>
            <circle cx="19" cy="12" r="1.5" fill="currentColor"></circle>
            <circle cx="5" cy="12" r="1.5" fill="currentColor"></circle>
          </svg>
        </button>

        <!-- Minimize to Dot (—) -->
        <button class="hud-icon-btn" id="hud-btn-min" title="Shrink to Dot (Double-tap Z)">
          <svg class="hud-svg" viewBox="0 0 24 24">
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- More Popover Drawer (Reasoning, Flag Wrong, Strict Toggle) -->
    <div class="hud-popover hidden" id="hud-popover">
      <div class="hud-popover-row">
        <div class="hud-reason-text" id="hud-reason-text">No reasoning available yet. Click Solve to get explanations.</div>
        <div style="display: flex; gap: 6px; flex-shrink: 0;">
          <button class="hud-btn-flag" id="hud-btn-flag" title="Flag as wrong and evict from cache">
            <svg class="hud-svg" viewBox="0 0 24 24" style="width: 12px; height: 12px;">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
              <line x1="4" y1="22" x2="4" y2="15"></line>
            </svg>
            <span>Flag Wrong</span>
          </button>
        </div>
      </div>
      <div class="hud-popover-row" style="border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 6px;">
        <label class="hud-checkbox-label">
          <input type="checkbox" id="hud-chk-strict">
          <span>Strict Mode: Pause on Tie-Breaker (Require Primary Agreement Only)</span>
        </label>
      </div>
    </div>
  `;

  shadow.appendChild(wrapper);

  // ==========================================================================
  // DOM References
  // ==========================================================================
  const getShadowEl = (id) => (shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector("#" + id));
  const fullBar = getShadowEl("hud-full-bar") || getShadowEl("hud-bar");
  const miniDot = getShadowEl("hud-mini-dot") || getShadowEl("hud-min-pill");
  const healthDot = getShadowEl("hud-health-dot");
  const badgeOpt = getShadowEl("hud-badge-opt");
  const answerText = getShadowEl("hud-answer-text");
  const tagConf = getShadowEl("hud-tag-conf");
  const tagCache = getShadowEl("hud-tag-cache");
  const tagLatency = getShadowEl("hud-tag-latency");
  const btnSolve = getShadowEl("hud-btn-solve");
  const btnApply = getShadowEl("hud-btn-apply");
  const btnNext = getShadowEl("hud-btn-next");
  const btnAuto = getShadowEl("hud-btn-auto");
  const autoIcon = getShadowEl("hud-auto-icon");
  const autoLabel = getShadowEl("hud-auto-label");
  const btnMore = getShadowEl("hud-btn-more");
  const btnMin = getShadowEl("hud-btn-min");
  const popover = getShadowEl("hud-popover");
  const reasonText = getShadowEl("hud-reason-text");
  const btnFlag = getShadowEl("hud-btn-flag");
  const chkStrict = getShadowEl("hud-chk-strict");
  const modePill = getShadowEl("hud-mode-pill");
  const modeMcq = getShadowEl("hud-mode-mcq");
  const modeCode = getShadowEl("hud-mode-code");
  const logoZ = getShadowEl("hud-logo-z");

  // ==========================================================================
  // Internal State
  // ==========================================================================
  let isVisibleState = true;
  let isHiddenState = false;
  let isMinimizedState = false;
  let isSolving = false;
  let isAutoRunning = false;
  let autoStepCount = 0;
  let autoRetryCount = 0;
  let latestSolution = null;
  let latestExtracted = null;
  let lastSolvedSignature = "";
  let lastSolvedTime = 0;
  let isSidePanelOpen = false;
  let backendOnline = false;
  let autoErrorOccurred = false;
  let autoErrorMessage = "";

  function updateDotState() {
    if (!miniDot) return;
    if (miniDot.classList) {
      miniDot.classList.remove("glow-red", "glow-green", "glow-orange", "glow-blue", "auto-running");
    }

    if (autoErrorOccurred) {
      // 3. If working in auto mode but errors occur, it should glow orange
      if (miniDot.classList) miniDot.classList.add("glow-orange");
      miniDot.title = `QuizZy Auto Mode Error: ${autoErrorMessage || "Error occurred"} (Click dot to restart)`;
    } else if (isAutoRunning) {
      // 2. When working in auto mode with no errors, it should glow green
      if (miniDot.classList) {
        miniDot.classList.add("glow-green");
        miniDot.classList.add("auto-running");
      }
      miniDot.title = "QuizZy Auto Mode: Running (Press Shift or click dot to stop)";
    } else if (!backendOnline) {
      // 1. If the backend is not running, the dot should glow red
      if (miniDot.classList) miniDot.classList.add("glow-red");
      miniDot.title = "QuizZy: Backend Offline (Click dot to start backend)";
    } else {
      // Default: Connected & Idle
      if (miniDot.classList) miniDot.classList.add("glow-blue");
      miniDot.title = "QuizZy: Connected & Ready (Press Shift to toggle Auto Mode)";
    }
  }

  // Query background for side panel presence on startup (mutual exclusivity)
  sendExtensionMessage({ action: "GET_SIDEPANEL_STATE" }, (res) => {
    if (res && res.isOpen) {
      isSidePanelOpen = true;
      hide();
    }
  });

  function autoDetectMode() {
    try {
      const loc = (typeof window !== "undefined") ? window.location : null;
      const pathname = (loc && loc.pathname) ? loc.pathname : "";
      if (/\/question\/[a-z0-9-]+/i.test(pathname)) {
        return "code";
      }
      const doc = (typeof document !== "undefined") ? document : null;
      if (doc) {
        const headerText = (doc.body ? (doc.body.innerText || doc.body.textContent || "") : "").slice(0, 1500).toLowerCase();
        const hasCodingPractice = /coding\s*practice/i.test(headerText);
        const buttons = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, input[type='button'], [role='button']")) : [];
        const btnTexts = buttons.map(b => (b.innerText || b.textContent || "").trim().toLowerCase());
        const hasCompileAndRun = btnTexts.some(t => /compile\s*&\s*run|run\s*code/i.test(t));
        const hasMcq = hasQuizOptionsOutsideEditor(doc);
        if ((hasCodingPractice || hasCompileAndRun) && !hasMcq) {
          return "code";
        }
      }
    } catch (_) { }
    return "mcq";
  }

  let quizzyMode = autoDetectMode();

  function updateModePillUi() {
    if (modeMcq && modeCode) {
      if (quizzyMode === "code") {
        modeMcq.classList.remove("active");
        modeCode.classList.add("active");
      } else {
        modeCode.classList.remove("active");
        modeMcq.classList.add("active");
      }
    }
  }

  function setMode(newMode) {
    quizzyMode = (newMode === "code") ? "code" : "mcq";
    updateModePillUi();
  }

  function toggleMode() {
    setMode(quizzyMode === "mcq" ? "code" : "mcq");
  }

  if (modePill) {
    modePill.addEventListener("click", () => toggleMode());
  }
  updateModePillUi();

  const storage = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
    ? chrome.storage.local
    : {
      get: (keys, cb) => { if (cb) cb({}); },
      set: (data, cb) => { if (cb) cb(); }
    };

  // Restore strict agreement preference (default: false)
  storage.get(["quizzy_strict_agreement"], (res) => {
    if (chkStrict && res.quizzy_strict_agreement !== undefined) {
      chkStrict.checked = Boolean(res.quizzy_strict_agreement);
    } else if (chkStrict) {
      chkStrict.checked = false;
    }
  });

  if (chkStrict) {
    chkStrict.addEventListener("change", () => {
      storage.set({ quizzy_strict_agreement: chkStrict.checked });
    });
  }

  // Restore position or set default
  function applyBarPosition(pos) {
    const margin = 16;
    let x = (pos && typeof pos.left === "number") ? pos.left : (window.innerWidth - 420);
    let y = (pos && typeof pos.top === "number") ? pos.top : (window.innerHeight - 60);

    const barW = fullBar ? (fullBar.offsetWidth || 340) : 340;
    const barH = fullBar ? (fullBar.offsetHeight || 36) : 36;
    const maxX = Math.max(0, window.innerWidth - barW - 8);
    const maxY = Math.max(0, window.innerHeight - barH - 8);

    x = Math.max(margin, Math.min(x, maxX));
    y = Math.max(margin, Math.min(y, maxY));

    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
  }

  function applyDotPosition(pos) {
    if (!pos || typeof pos.left !== "number" || typeof pos.top !== "number") {
      return;
    }
    const dotSize = 7;
    const maxX = Math.max(0, window.innerWidth - dotSize - 3);
    const maxY = Math.max(0, window.innerHeight - dotSize - 3);

    const x = Math.max(3, Math.min(pos.left, maxX));
    const y = Math.max(3, Math.min(pos.top, maxY));

    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
  }

  storage.get(["quizzy_hud_pos", "quizzy_dot_pos", "quizzy_hud_minimized", "quizzy_hud_hidden"], (res) => {
    if (res && res.quizzy_hud_hidden) {
      setHidden(true);
    }
    if (res && res.quizzy_dot_pos && (!wrapper.style.left || !wrapper.style.top)) {
      applyDotPosition(res.quizzy_dot_pos);
    }
  });

  // ==========================================================================
  // Dragging Implementation for Bar & White Dot
  // ==========================================================================
  let isBarDragging = false;
  let isDotDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dotDragDistance = 0;

  function onBarDragStart(e) {
    const target = e.target;
    if (target && target.closest && target.closest("button, input, label, a, .hud-btn-flag, .hud-popover")) {
      return;
    }

    isBarDragging = true;
    if (fullBar) fullBar.classList.add("dragging");

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;

    const rect = wrapper.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    window.addEventListener("mousemove", onBarDragMove, { passive: true });
    window.addEventListener("mouseup", onBarDragEnd);
    window.addEventListener("touchmove", onBarDragMove, { passive: true });
    window.addEventListener("touchend", onBarDragEnd);
  }

  function onBarDragMove(e) {
    if (!isBarDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    let newLeft = startLeft + dx;
    let newTop = startTop + dy;

    const w = wrapper.offsetWidth || 340;
    const h = wrapper.offsetHeight || 36;
    newLeft = Math.max(8, Math.min(newLeft, window.innerWidth - w - 8));
    newTop = Math.max(8, Math.min(newTop, window.innerHeight - h - 8));

    wrapper.style.left = `${newLeft}px`;
    wrapper.style.top = `${newTop}px`;
  }

  function onBarDragEnd() {
    if (!isBarDragging) return;
    isBarDragging = false;
    if (fullBar) fullBar.classList.remove("dragging");

    window.removeEventListener("mousemove", onBarDragMove);
    window.removeEventListener("mouseup", onBarDragEnd);
    window.removeEventListener("touchmove", onBarDragMove);
    window.removeEventListener("touchend", onBarDragEnd);

    const rect = wrapper.getBoundingClientRect();
    storage.set({ quizzy_hud_pos: { left: rect.left, top: rect.top } });
  }

  function onDotDragStart(e) {
    isDotDragging = true;
    dotDragDistance = 0;
    if (miniDot) miniDot.classList.add("dragging");

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;

    const rect = wrapper.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    window.addEventListener("mousemove", onDotDragMove, { passive: true });
    window.addEventListener("mouseup", onDotDragEnd);
    window.addEventListener("touchmove", onDotDragMove, { passive: true });
    window.addEventListener("touchend", onDotDragEnd);
  }

  function onDotDragMove(e) {
    if (!isDotDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;
    dotDragDistance = Math.hypot(dx, dy);

    let newLeft = startLeft + dx;
    let newTop = startTop + dy;

    const dotSize = 7;
    newLeft = Math.max(3, Math.min(newLeft, window.innerWidth - dotSize - 3));
    newTop = Math.max(3, Math.min(newTop, window.innerHeight - dotSize - 3));

    wrapper.style.left = `${newLeft}px`;
    wrapper.style.top = `${newTop}px`;
  }

  function onDotDragEnd() {
    if (!isDotDragging) return;
    isDotDragging = false;
    if (miniDot) miniDot.classList.remove("dragging");

    window.removeEventListener("mousemove", onDotDragMove);
    window.removeEventListener("mouseup", onDotDragEnd);
    window.removeEventListener("touchmove", onDotDragMove);
    window.removeEventListener("touchend", onDotDragEnd);

    if (dotDragDistance >= 5) {
      const rect = wrapper.getBoundingClientRect();
      storage.set({ quizzy_dot_pos: { left: rect.left, top: rect.top } });
    }
  }

  if (fullBar) {
    fullBar.addEventListener("mousedown", onBarDragStart);
    fullBar.addEventListener("touchstart", onBarDragStart, { passive: false });
  }

  if (miniDot) {
    miniDot.addEventListener("mousedown", onDotDragStart);
    miniDot.addEventListener("touchstart", onDotDragStart, { passive: false });
    miniDot.addEventListener("dblclick", (e) => {
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      setMinimized(false);
    });
    miniDot.addEventListener("click", (e) => {
      if (dotDragDistance < 10) {
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (!backendOnline) {
          handleTriggerStartBackend(hudInstance, miniDot);
          return;
        }
        if (isAutoRunning) {
          stopAutoMode("Auto Mode stopped via dot click");
        } else {
          startAutoMode();
        }
      }
    });
  }

  // ==========================================================================
  // Communication Helpers
  // ==========================================================================
  function sendExtensionMessage(message, callback) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            if (callback) callback({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (callback) callback(res || { success: false });
        });
        return;
      } catch (err) {
        if (callback) callback({ success: false, error: err.message });
        return;
      }
    }
    if (callback) callback({ success: false, error: "chrome.runtime unavailable" });
  }

  // ==========================================================================
  // Health Polling (Backend Status)
  // ==========================================================================
  function checkHealth(cb) {
    sendExtensionMessage({ action: "CHECK_HEALTH" }, (res) => {
      const isOnline = Boolean(res && res.success && res.data && (res.data.status === "ok" || res.data.status === "degraded"));
      backendOnline = isOnline;
      if (isOnline) {
        if (healthDot && !isSolving) {
          healthDot.className = "hud-health-dot online";
          healthDot.title = `Backend Connected (Cache: ${res.data.cache_entries || 0})`;
        }
      } else {
        if (healthDot && !isSolving) {
          healthDot.className = "hud-health-dot";
          healthDot.title = "Backend: Offline (Click to start backend)";
        }
      }
      updateDotState();
      if (typeof cb === "function") cb(isOnline, res);
    });
  }

  if (healthDot) {
    healthDot.addEventListener("click", () => {
      if (!backendOnline) {
        handleTriggerStartBackend(hudInstance, miniDot);
      }
    });
  }

  checkHealth();
  const healthInterval = setInterval(checkHealth, 2500);
  if (healthInterval && typeof healthInterval.unref === "function") {
    healthInterval.unref();
  }

  // ==========================================================================
  // Question Signature for Stuck-Detection
  // ==========================================================================
  function getQuestionSig(ext) {
    if (!ext) return "";
    let q = (ext.question || "").trim();
    if (q.includes("[CODE SNIPPET]:")) {
      const parts = q.split("[CODE SNIPPET]:");
      const basePrompt = parts[0].trim();
      const codeLines = (parts[1] || "").trim().split("\n");
      const firstLine = codeLines.length > 0 ? codeLines[0].trim() : "";
      q = `${basePrompt}::${firstLine}`;
    }
    const opts = Array.isArray(ext.options) ? ext.options.join("|") : "";
    const img = ext.image_url || (ext.image_data ? ext.image_data.length : "");
    return `${q}::${opts}::${img}`;
  }

  // ==========================================================================
  // Display & State Renderers
  // ==========================================================================
  function resetSolutionDisplay() {
    latestSolution = null;
    latestExtracted = null;
    if (typeof window !== "undefined") {
      window.__QUIZZY_LAST_SELECTED_OPTION__ = null;
      window.__QUIZZY_CURRENT_QUESTION_OPTION_SELECTED__ = null;
    }
    if (badgeOpt) {
      badgeOpt.className = "hud-badge-option hidden";
      badgeOpt.textContent = "";
    }
    if (answerText) {
      answerText.className = "hud-answer-text";
      answerText.textContent = "Ready to solve";
      answerText.title = "Ready to solve";
    }
    if (tagConf) tagConf.classList.add("hidden");
    if (tagCache) tagCache.classList.add("hidden");
    if (tagLatency) tagLatency.classList.add("hidden");
    if (btnApply) btnApply.disabled = true;
    if (reasonText) {
      reasonText.textContent = "Click Solve to evaluate question with dual models.";
    }
  }

  function setSolvingState() {
    isSolving = true;
    if (healthDot) healthDot.className = "hud-health-dot solving";
    if (badgeOpt) badgeOpt.classList.add("hidden");
    if (answerText) {
      answerText.className = "hud-answer-text solving";
      answerText.textContent = "Solving question with dual models...";
    }
    if (tagConf) tagConf.classList.add("hidden");
    if (tagCache) tagCache.classList.add("hidden");
    if (tagLatency) tagLatency.classList.add("hidden");
    if (btnApply) btnApply.disabled = true;
  }

  function renderSolution(solution, extracted) {
    isSolving = false;
    latestSolution = solution;
    latestExtracted = extracted;
    checkHealth();

    const hasCandidate = solution && (
      (typeof solution.selected_index === "number" && solution.selected_index >= 0) ||
      (Array.isArray(solution.selected_indices) && solution.selected_indices.length > 0) ||
      (typeof solution.answer === "string" && solution.answer.trim().length > 0) ||
      (typeof solution.canonical_key === "string" && solution.canonical_key.trim().length > 0) ||
      (Array.isArray(solution.canonical_keys) && solution.canonical_keys.length > 0) ||
      (typeof solution.letter === "string" && solution.letter.trim().length > 0) ||
      (typeof solution.selected_text === "string" && solution.selected_text.trim().length > 0)
    );

    if (!hasCandidate) {
      if (badgeOpt) badgeOpt.classList.add("hidden");
      if (answerText) {
        answerText.className = "hud-answer-text uncertain";
        answerText.textContent = solution && solution.error ? solution.error : "Model consensus uncertain";
        answerText.title = answerText.textContent;
      }
      if (tagConf) tagConf.classList.add("hidden");
      if (tagCache) tagCache.classList.add("hidden");
      if (tagLatency) tagLatency.classList.add("hidden");
      if (btnApply) btnApply.disabled = true;
      if (reasonText) {
        reasonText.textContent = (solution && solution.reason) || "No consensus reached between models.";
      }
      return;
    }

    const qType = (solution.q_type || (extracted && extracted.q_type) || "mcq").toLowerCase();

    // 1. Badge Display
    if (badgeOpt) {
      badgeOpt.className = "hud-badge-option";
      if (qType === "order") {
        badgeOpt.classList.add("order");
        badgeOpt.textContent = "ORD";
      } else if (qType === "text") {
        badgeOpt.classList.add("text");
        badgeOpt.textContent = "TXT";
      } else if (qType === "multi") {
        badgeOpt.classList.add("multi");
        const keys = (solution.canonical_keys && solution.canonical_keys.length)
          ? solution.canonical_keys
          : (solution.canonical_key ? solution.canonical_key.split(/[\s,]+/).filter(Boolean) : []);
        badgeOpt.textContent = keys.length ? `[${keys.join(", ")}]` : "[MULTI]";
      } else {
        const letter = solution.canonical_key || solution.letter ||
          (typeof solution.selected_index === "number" ? String.fromCharCode(65 + solution.selected_index) : "A");
        badgeOpt.textContent = `[${letter}]`;
      }
      badgeOpt.classList.remove("hidden");
    }

    // 2. Answer Text Display
    if (answerText) {
      answerText.className = "hud-answer-text";
      let displayText = "";
      if (qType === "order") {
        displayText = (solution.ordered_texts && solution.ordered_texts.length)
          ? solution.ordered_texts.join(" ➔ ")
          : (solution.answer || "Ordered sequence ready");
      } else if (qType === "multi") {
        if (solution.selected_texts && solution.selected_texts.length) {
          displayText = solution.selected_texts.join(" | ");
        } else {
          displayText = solution.selected_text || solution.selected_option || solution.answer || "Multiple options ready";
        }
      } else {
        displayText = solution.selected_text || solution.selected_option || solution.answer || "Answer ready";
      }
      answerText.textContent = displayText;
      answerText.title = displayText;
    }

    // 3. Confidence Tag
    if (tagConf) {
      const tier = (solution.confidence_tier || "").toUpperCase();
      const label = (solution.confidence_label || "").toLowerCase();
      if (tier.includes("HIGH") || label === "high" || solution.agreement_status === "both_agree") {
        tagConf.className = "hud-pill-tag hud-tag-high";
        tagConf.textContent = "HIGH";
        tagConf.classList.remove("hidden");
      } else if (tier.includes("MEDIUM") || label === "medium" || solution.agreement_status === "tiebreaker_agree") {
        tagConf.className = "hud-pill-tag hud-tag-med";
        tagConf.textContent = "MED";
        tagConf.classList.remove("hidden");
      } else {
        tagConf.classList.add("hidden");
      }
    }

    // 4. Cache & Latency Tags
    if (tagCache) {
      if (solution.cache_hit) {
        tagCache.classList.remove("hidden");
      } else {
        tagCache.classList.add("hidden");
      }
    }

    if (tagLatency && typeof solution.latency_ms === "number") {
      tagLatency.textContent = `${Math.round(solution.latency_ms)}ms`;
      tagLatency.classList.remove("hidden");
    }

    // 5. Enable Apply Button
    if (btnApply) {
      btnApply.disabled = false;
    }

    // 6. Update Drawer Reasoning
    if (reasonText) {
      reasonText.textContent = solution.reason || "Derivation verified step-by-step.";
    }
  }

  // ==========================================================================
  // Core Extraction, Solve & Execution Routines
  // ==========================================================================
  function extractCurrentQuiz() {
    if (window.__QuizZyExtractor && typeof window.__QuizZyExtractor.extractQuizFromDom === "function") {
      try {
        return window.__QuizZyExtractor.extractQuizFromDom(document);
      } catch (err) {
        console.error("[QuizZy HUD] Extraction error:", err);
      }
    }
    return null;
  }

  function isValidExtractedQuestion(q) {
    if (window.__QuizZyExtractor && typeof window.__QuizZyExtractor.isValidExtractedQuestion === "function") {
      return window.__QuizZyExtractor.isValidExtractedQuestion(q);
    }
    if (!q) return false;
    const stem = (q.stem || q.question_text || q.question || "").trim();
    if (stem.length < 2) return false;
    const type = (q.q_type || "mcq").toLowerCase();
    if (["mcq", "multi", "order"].includes(type)) {
      const validOpts = Array.isArray(q.options)
        ? q.options.filter(o => o && (typeof o === "string" ? o.trim().length > 0 : (typeof o === "object" ? String(o.text || o.label || o.value || "").trim().length > 0 : true)))
        : [];
      if (validOpts.length < 2) return false;
    }
    return true;
  }

  function solveCurrentQuestion(callback) {
    if (isSolving) return;
    const extracted = extractCurrentQuiz();

    if (!extracted || !extracted.success || !isValidExtractedQuestion(extracted)) {
      if (answerText) {
        answerText.className = "hud-answer-text uncertain";
        answerText.textContent = "No quiz question detected on page";
      }
      if (callback) callback(null, extracted);
      return;
    }

    const currentSig = getQuestionSig(extracted);
    const nowTs = Date.now();
    if (latestSolution && currentSig && currentSig === lastSolvedSignature && (nowTs - lastSolvedTime) < 3500) {
      if (callback) callback(latestSolution, extracted);
      return;
    }

    setSolvingState();

    const payload = {
      subject: extracted.subject || "General",
      q_type: extracted.q_type || "mcq",
      question: extracted.question,
      options: extracted.options || [],
      language: (extracted && extracted.language) ? extracted.language : null,
      starter_code: (extracted && extracted.starter_code) ? extracted.starter_code : null,
      image_data: (extracted && extracted.image_data) ? extracted.image_data : null,
      image_url: (extracted && extracted.image_url) ? extracted.image_url : null,
      meta: (extracted && extracted.meta) ? extracted.meta : null
    };

    let solveTimedOut = false;
    const solveTimer = setTimeout(() => {
      if (!isSolving) return;
      solveTimedOut = true;
      isSolving = false;
      if (isAutoRunning) {
        autoErrorOccurred = true;
        autoErrorMessage = "Question solve timed out (>22s)";
      }
      checkHealth();
      if (answerText) {
        answerText.className = "hud-answer-text uncertain";
        answerText.textContent = "Question solve timed out (>22s)";
      }
      if (callback) callback({ error: "Question solve timed out (>22s)" }, extracted);
    }, 22000);

    sendExtensionMessage({ action: "SOLVE_REQUEST", payload }, (res) => {
      if (solveTimedOut) return;
      clearTimeout(solveTimer);

      if (!res || !res.success || !res.data) {
        isSolving = false;
        const errMsg = (res && res.error) ? String(res.error) : "Backend solve error";
        const isRateLimited = (res && res.status === 429) || errMsg.includes("429") || errMsg.toLowerCase().includes("rate limit");

        if (isRateLimited) {
          if (answerText) {
            answerText.className = "hud-answer-text uncertain";
            answerText.textContent = "Rate limit cooldown (10s)...";
          }
          if (isAutoRunning) {
            autoErrorOccurred = false;
            autoErrorMessage = "Rate limit cooldown";
            updateDotState();
            setTimeout(() => {
              if (isAutoRunning) {
                runAutoStep();
              }
            }, 10000);
            return;
          }
        }

        if (errMsg.toLowerCase().includes("fetch") || errMsg.toLowerCase().includes("network") || errMsg.toLowerCase().includes("connect") || errMsg.toLowerCase().includes("offline")) {
          backendOnline = false;
        }
        if (isAutoRunning && !isRateLimited) {
          autoErrorOccurred = true;
          autoErrorMessage = errMsg;
        }
        updateDotState();
        checkHealth();
        if (answerText && !isRateLimited) {
          answerText.className = "hud-answer-text uncertain";
          answerText.textContent = errMsg;
        }
        if (callback) callback(null, extracted);
        return;
      }

      backendOnline = true;
      lastSolvedSignature = currentSig;
      lastSolvedTime = Date.now();
      renderSolution(res.data, extracted);
      if (callback) callback(res.data, extracted);
    });
  }

  function buildExecuteActionPayload(solveData, extracted) {
    if (!solveData) return null;
    const qType = (solveData.q_type || (extracted && extracted.q_type) || "mcq").toLowerCase();
    const options = (extracted && Array.isArray(extracted.options)) ? extracted.options : [];

    // Resolve targetIndex (0-based integer)
    let targetIndex = null;
    if (typeof solveData.selected_index === "number" && solveData.selected_index >= 0 && (options.length === 0 || solveData.selected_index < options.length)) {
      targetIndex = solveData.selected_index;
    } else if (typeof solveData.canonical_key === "string" && /^[A-F]$/i.test(solveData.canonical_key.trim())) {
      targetIndex = solveData.canonical_key.trim().toUpperCase().charCodeAt(0) - 65;
    } else if (typeof solveData.answer === "string" && /^[A-F]$/i.test(solveData.answer.trim())) {
      targetIndex = solveData.answer.trim().toUpperCase().charCodeAt(0) - 65;
    } else if (typeof solveData.letter === "string" && /^[A-F]$/i.test(solveData.letter.trim())) {
      targetIndex = solveData.letter.trim().toUpperCase().charCodeAt(0) - 65;
    } else if (options.length > 0) {
      const matchText = solveData.selected_text || solveData.selected_option || solveData.answer;
      if (matchText) {
        const cleanMatch = String(matchText).trim().toLowerCase();
        const foundIdx = options.findIndex(opt => opt && String(opt).trim().toLowerCase() === cleanMatch);
        if (foundIdx !== -1) {
          targetIndex = foundIdx;
        }
      }
    }

    // Resolve targetText
    let targetText = "";
    if (targetIndex !== null && targetIndex >= 0 && targetIndex < options.length) {
      targetText = options[targetIndex];
    } else {
      targetText = solveData.selected_text || solveData.selected_option || solveData.answer || "";
    }

    const letter = (targetIndex !== null && targetIndex >= 0) ? String.fromCharCode(65 + targetIndex) : "";

    return {
      question_type: qType,
      q_type: qType,
      targetIndex,
      selected_index: targetIndex,
      targetText,
      selected_text: targetText,
      answer: (qType === "mcq" && targetText) ? targetText : solveData.answer,
      letter,
      ordered_indices: solveData.ordered_indices,
      ordered_texts: solveData.ordered_texts,
      target_permutation: solveData.ordered_indices,
      permutation_indices: solveData.permutation_indices,
      selected_indices: solveData.selected_indices,
      selected_texts: solveData.selected_texts,
      canonical_keys: solveData.canonical_keys,
      canonical_key: solveData.canonical_key,
      options: (extracted && Array.isArray(extracted.options)) ? extracted.options : [],
      optionSelectors: (extracted && Array.isArray(extracted.optionSelectors)) ? extracted.optionSelectors : [],
      dragHandleSelectors: (extracted && Array.isArray(extracted.dragHandleSelectors)) ? extracted.dragHandleSelectors : []
    };
  }

  function applyCurrentSolution(callback, explicitSolution, explicitExtracted) {
    const sol = explicitSolution || latestSolution;
    const ext = explicitExtracted || latestExtracted;
    if (!sol || sol.status !== "ok") {
      if (callback) callback({ success: false, reason: "No valid solution to apply" });
      return;
    }

    const actionPayload = buildExecuteActionPayload(sol, ext);
    if (!actionPayload) {
      if (callback) callback({ success: false, reason: "Could not build action payload" });
      return;
    }

    const exec = window.__QuizZyExecutor || window.QuizZyExecutor;
    if (exec && (typeof exec.executeQuizAction === "function" || typeof exec.executeAction === "function")) {
      try {
        const fn = exec.executeQuizAction || exec.executeAction;
        const res = fn.call(exec, actionPayload);
        if (res && typeof res.then === "function") {
          res.then((asyncRes) => {
            if (callback) callback(asyncRes);
          }).catch((err) => {
            console.error("[QuizZy HUD] Async executor call error:", err);
            if (callback) callback({ success: false, ok: false, selected: false, error: String(err) });
          });
          return;
        }
        if (callback) callback(res);
        return;
      } catch (err) {
        console.error("[QuizZy HUD] Direct executor call failed:", err);
      }
    }

    sendExtensionMessage({ action: "EXECUTE_ACTION", payload: actionPayload }, (res) => {
      if (callback) callback(res);
    });
  }

  function clickNextOnPage(callback) {
    const exec = window.__QuizZyExecutor || window.QuizZyExecutor;
    if (exec && typeof exec.clickNextButton === "function") {
      exec.clickNextButton().then((res) => {
        if (callback) callback(res);
      }).catch((err) => {
        if (callback) callback({ ok: false, error: err.message });
      });
      return;
    }

    sendExtensionMessage({ action: "CLICK_NEXT_BUTTON" }, (res) => {
      if (callback) callback(res && res.result ? res.result : res);
    });
  }

  // ==========================================================================
  // Self-Sufficient Auto Mode
  // ==========================================================================
  let autoStepEpoch = 0;

  function updateAutoButtonState(running) {
    if (!btnAuto) return;
    if (running) {
      btnAuto.className = "hud-btn hud-btn-auto running";
      if (autoLabel) autoLabel.textContent = "Stop";
      if (autoIcon) {
        autoIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" fill="currentColor"></rect>';
      }
      if (miniDot) miniDot.classList.add("auto-running");
    } else {
      btnAuto.className = "hud-btn hud-btn-auto";
      if (autoLabel) autoLabel.textContent = "Auto";
      if (autoIcon) {
        autoIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>';
      }
      if (miniDot) miniDot.classList.remove("auto-running");
    }
  }

  function startAutoMode() {
    isAutoRunning = true;
    autoErrorOccurred = false;
    autoErrorMessage = "";
    autoStepCount = 0;
    autoRetryCount = 0;
    autoStepEpoch++;
    resetSolutionDisplay();
    updateAutoButtonState(true);
    if (wrapper) {
      resetDotPositionToCorner(wrapper);
      setHidden(false);
    }
    updateDotState();

    if (!backendOnline) {
      handleTriggerStartBackend(hudInstance, miniDot, () => {
        if (isAutoRunning) {
          if (quizzyMode === "code") {
            sendExtensionMessage({ action: "TRIGGER_CODING_AUTO_LOOP" }, (res) => {
              if (res && res.error) {
                autoErrorOccurred = true;
                autoErrorMessage = res.error;
                stopAutoMode(res.error);
              } else {
                autoErrorOccurred = false;
                autoErrorMessage = "";
                stopAutoMode("Coding automation complete.");
              }
            });
          } else {
            runAutoStep();
          }
        }
      });
      return;
    }

    // Auto-allowlist current host
    const currentHost = (window.location && window.location.hostname) ? window.location.hostname.toLowerCase() : "";
    if (currentHost && storage && storage.get) {
      storage.get(["allowedHosts", "auto_mode_allowlist"], (data) => {
        const list = data.allowedHosts || [];
        if (!list.includes(currentHost)) {
          list.push(currentHost);
          storage.set({ allowedHosts: list });
        }
        const autoList = data.auto_mode_allowlist || [];
        if (!autoList.includes(currentHost)) {
          autoList.push(currentHost);
          storage.set({ auto_mode_allowlist: autoList });
        }
      });
    }

    if (quizzyMode === "code") {
      sendExtensionMessage({ action: "TRIGGER_CODING_AUTO_LOOP" }, (res) => {
        if (res && res.error) {
          autoErrorOccurred = true;
          autoErrorMessage = res.error;
          stopAutoMode(res.error);
        } else {
          autoErrorOccurred = false;
          autoErrorMessage = "";
          stopAutoMode("Coding automation complete.");
        }
      });
      return;
    }

    runAutoStep();
  }

  function stopAutoMode(message) {
    isAutoRunning = false;
    autoRetryCount = 0;
    autoStepEpoch++;
    updateAutoButtonState(false);

    const isErrorStop = message && (
      message.toLowerCase().includes("error") ||
      message.toLowerCase().includes("uncertain") ||
      message.toLowerCase().includes("did not advance") ||
      message.toLowerCase().includes("prevent") ||
      message.toLowerCase().includes("timed out") ||
      message.toLowerCase().includes("cannot solve") ||
      message.toLowerCase().includes("coding question")
    );
    if (isErrorStop) {
      autoErrorOccurred = true;
      if (!autoErrorMessage) autoErrorMessage = message;
    } else {
      autoErrorOccurred = false;
      autoErrorMessage = "";
    }
    updateDotState();

    if (message && answerText) {
      if (message.includes("Completed")) {
        answerText.className = "hud-answer-text complete";
      } else {
        answerText.className = "hud-answer-text ready";
      }
      answerText.textContent = message;
      answerText.title = message;
    }
  }

  function runAutoStep() {
    if (!isAutoRunning) return;

    if (autoStepCount >= 1000) {
      stopAutoMode("Auto Mode reached step limit.");
      return;
    }
    autoStepCount++;

    const currentEpoch = ++autoStepEpoch;
    let stepSettled = false;

    solveCurrentQuestion((solution, extracted) => {
      if (stepSettled || !isAutoRunning || currentEpoch !== autoStepEpoch) return;

      // Content Protection Gate: Halt on pure coding question in quiz auto loop
      const isPureCoding = (solution && solution.q_type === "code") || (extracted && extracted.q_type === "code");
      const hasOptions = extracted && Array.isArray(extracted.options) && extracted.options.length >= 2;
      if (isPureCoding && !hasOptions) {
        stepSettled = true;
        console.warn("[QuizZy HUD] Coding question detected. Stopped auto mode (never skip).");
        autoErrorOccurred = true;
        autoErrorMessage = "Coding question detected in quiz mode";
        stopAutoMode("Coding question detected. Solve in Code mode or answer manually.");
        return;
      }

      const isStrict = chkStrict && chkStrict.checked;
      const hasValidSelection = solution && (
        (typeof solution.selected_index === "number" && solution.selected_index >= 0) ||
        (solution.answer && typeof solution.answer === "string" && solution.answer.trim().length > 0) ||
        (solution.canonical_key && typeof solution.canonical_key === "string" && solution.canonical_key.trim().length > 0) ||
        (solution.selected_text && typeof solution.selected_text === "string" && solution.selected_text.trim().length > 0)
      );

      if (!hasValidSelection) {
        // If question cannot be parsed or solved yet (e.g. rate-limit or loading), back off 10s
        if (!stepSettled && isAutoRunning && currentEpoch === autoStepEpoch) {
          autoErrorOccurred = true;
          autoErrorMessage = "Cannot solve question or rate limit backoff";
          updateDotState();
          if (autoRetryCount < 2) {
            autoRetryCount++;
            console.warn("[QuizZy HUD] Solve failed/empty, backing off 10s before retry (" + autoRetryCount + "/2)...");
            setTimeout(runAutoStep, 10000);
            return;
          }
          stepSettled = true;
          autoRetryCount = 0;
          stopAutoMode("Cannot solve question. Stopped to prevent skipping.");
          return;
        }
        return;
      }

      autoRetryCount = 0;

      // Check strict HIGH agreement constraint
      if (isStrict) {
        const isHigh = solution.confidence_label === "high" ||
          solution.agreement_status === "both_agree" ||
          (solution.confidence_tier && solution.confidence_tier.includes("HIGH"));
        if (!isHigh) {
          stepSettled = true;
          console.warn("[QuizZy HUD] Model consensus uncertain in strict mode. Stopped to protect accuracy.");
          autoErrorOccurred = true;
          autoErrorMessage = "Model consensus uncertain in strict mode";
          stopAutoMode("Consensus uncertain in strict mode. Stopped to protect accuracy.");
          return;
        }
      }

      const prevSig = getQuestionSig(extracted);

      // Apply answer
      applyCurrentSolution((applyRes) => {
        if (stepSettled || !isAutoRunning || currentEpoch !== autoStepEpoch) return;

        // Resilient Selection Error Handling: retry, then stop instead of skipping!
        if (!applyRes || applyRes.ok === false || applyRes.selected === false || !applyRes.success) {
          autoErrorOccurred = true;
          autoErrorMessage = "Selection verification failed";
          updateDotState();
          if (autoRetryCount < 3) {
            autoRetryCount++;
            setTimeout(runAutoStep, 250);
            return;
          }
          stepSettled = true;
          autoRetryCount = 0;
          console.warn("[QuizZy HUD] Selection verification failed. Stopped to prevent incorrect submission.");
          stopAutoMode("Selection error. Stopped to prevent incorrect submission.");
          return;
        }

        // For drag-and-drop ordering questions: proceed to advance so auto mode continues
        if (solution && solution.q_type === "order" && !applyRes.verified_order) {
          console.warn("[QuizZy HUD] Order unverified. Proceeding to advance so auto mode continues.");
        }

        // Fast delay before clicking Submit / Next for React state commit (120ms)
        setTimeout(() => {
          if (stepSettled || !isAutoRunning || currentEpoch !== autoStepEpoch) return;

          clickNextOnPage((nextRes) => {
            if (stepSettled || !isAutoRunning || currentEpoch !== autoStepEpoch) return;

            if (nextRes && nextRes.ok === false && nextRes.error && nextRes.error.includes("NO_OPTION_SELECTED")) {
              stepSettled = true;
              autoErrorOccurred = true;
              autoErrorMessage = "No option selected";
              updateDotState();
              stopAutoMode("Cannot submit question: No option selected.");
              return;
            }

            if (nextRes && nextRes.step === "quiz_completed") {
              stepSettled = true;
              autoErrorOccurred = false;
              autoErrorMessage = "";
              stopAutoMode("Quiz Completed!");
              return;
            }

            // Snappy poll for question advance using composite signature (75ms interval)
            let pollAttempts = 0;
            const pollInterval = setInterval(() => {
              if (stepSettled || !isAutoRunning || currentEpoch !== autoStepEpoch) {
                clearInterval(pollInterval);
                return;
              }

              pollAttempts++;
              let currentExt = null;
              if (window.__QuizZyExtractor && typeof window.__QuizZyExtractor.extractQuizFromDom === "function") {
                currentExt = window.__QuizZyExtractor.extractQuizFromDom(document);
              }

              const newSig = getQuestionSig(currentExt);
              if (newSig && newSig !== prevSig) {
                clearInterval(pollInterval);
                stepSettled = true;
                autoErrorOccurred = false;
                autoErrorMessage = "";
                resetSolutionDisplay();
                updateDotState();
                setTimeout(runAutoStep, 80);
                return;
              }

              if (pollAttempts >= 80) { // 80 * 75ms = 6s timeout
                clearInterval(pollInterval);
                if (!stepSettled) {
                  stepSettled = true;
                  autoErrorOccurred = true;
                  autoErrorMessage = "Question did not advance after submit";
                  stopAutoMode("Question did not advance after submit.");
                }
              }
            }, 75);
          });
        }, 120);
      }, solution, extracted);
    });
  }

  // ==========================================================================
  // UI Interactions (Buttons, Drawer, Minimize, Visibility)
  // ==========================================================================
  function setMinimized(minimized) {
    isMinimizedState = Boolean(minimized);
    storage.set({ quizzy_hud_minimized: isMinimizedState });

    if (isMinimizedState) {
      if (fullBar) fullBar.classList.add("hidden");
      if (popover) popover.classList.add("hidden");
      if (miniDot) {
        miniDot.classList.remove("hidden");
        if (isAutoRunning) {
          miniDot.classList.add("auto-running");
        } else {
          miniDot.classList.remove("auto-running");
        }
      }
    } else {
      if (miniDot) miniDot.classList.add("hidden");
      if (fullBar) fullBar.classList.remove("hidden");
    }
  }

  function setHidden(hidden) {
    isHiddenState = Boolean(hidden);
    if (isHiddenState) {
      wrapper.classList.add("hidden");
    } else {
      wrapper.classList.remove("hidden");
      // Mutual Exclusivity: When floating HUD is open, the side panel disappears!
      if (isSidePanelOpen) {
        isSidePanelOpen = false;
        sendExtensionMessage({ action: "CLOSE_SIDEPANEL" });
      }
      checkHealth();
    }
    storage.set({ quizzy_hud_hidden: isHiddenState });
  }

  function toggleVisibility() {
    const willBeHidden = !isHiddenState;
    if (!willBeHidden) {
      positionWrapperAtCurrentLocation(wrapper);
    }
    setHidden(willBeHidden);
    if (!willBeHidden && isMinimizedState) {
      setMinimized(false);
    }
    if (!willBeHidden) {
      updateDotState();
    }
    return !isHiddenState;
  }

  function show(forceExpand = false) {
    positionWrapperAtCurrentLocation(wrapper);
    setHidden(false);
    if (forceExpand || isMinimizedState) {
      setMinimized(false);
    }
  }

  function hide() {
    setHidden(true);
  }

  if (btnSolve) {
    btnSolve.addEventListener("click", () => solveCurrentQuestion());
  }

  if (btnApply) {
    btnApply.addEventListener("click", () => applyCurrentSolution());
  }

  if (btnNext) {
    btnNext.addEventListener("click", () => {
      if (quizzyMode === "code") {
        const exec = window.__QuizZyExecutor || window.QuizZyExecutor;
        if (exec && typeof exec.autoCompileAndSubmitLoop === "function") {
          const extracted = (window.__QuizZyExtractor && typeof window.__QuizZyExtractor.extractCodingQuestionFromDom === "function")
            ? window.__QuizZyExtractor.extractCodingQuestionFromDom(document)
            : extractCurrentQuiz();
          const code = latestSolution ? (latestSolution.answer || latestSolution.selected_text) : (extracted ? extracted.starter_code : "");
          exec.autoCompileAndSubmitLoop({
            code: code,
            language: extracted ? extracted.language : null,
            starter_code: extracted ? extracted.starter_code : null
          }, (solvePayload) => {
            return new Promise((resolve) => {
              sendExtensionMessage({
                action: "SOLVE_REQUEST",
                payload: Object.assign({
                  subject: "Coding Practice",
                  q_type: "code",
                  question: (extracted && extracted.question) ? extracted.question : "Coding Practice Problem",
                  language: extracted ? extracted.language : null,
                  starter_code: extracted ? extracted.starter_code : null
                }, solvePayload)
              }, (res) => {
                resolve(res && res.data ? res.data : null);
              });
            });
          }, document).then((loopRes) => {
            if (answerText && loopRes) {
              answerText.textContent = loopRes.status === "submitted" ? "Submitted Successfully!" : (loopRes.error || "Done");
            }
          });
          return;
        }
      }
      resetSolutionDisplay();
      clickNextOnPage((res) => {
        if (res && res.button_text && answerText) {
          answerText.textContent = `Advanced: ${res.button_text}`;
        }
      });
    });
  }

  if (btnAuto) {
    btnAuto.addEventListener("click", () => {
      if (isAutoRunning) {
        stopAutoMode("Auto Mode stopped.");
      } else {
        startAutoMode();
      }
    });
  }

  if (btnMore) {
    btnMore.addEventListener("click", () => {
      if (popover) popover.classList.toggle("hidden");
    });
  }

  if (btnMin) {
    btnMin.addEventListener("click", () => setMinimized(true));
  }

  if (logoZ) {
    logoZ.addEventListener("dblclick", (e) => {
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      setMinimized(true);
    });
    logoZ.addEventListener("click", (e) => {
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      setMinimized(true);
    });
  }

  if (btnFlag) {
    btnFlag.addEventListener("click", () => {
      if (!latestSolution || !latestExtracted) return;
      btnFlag.disabled = true;

      const payload = {
        subject: latestExtracted.subject || "General",
        q_type: latestExtracted.q_type || "mcq",
        question: latestExtracted.question,
        options: latestExtracted.options || [],
        wrong_answer: latestSolution.answer,
        is_unverified_flag: true
      };

      sendExtensionMessage({ action: "SUBMIT_FEEDBACK", payload }, (res) => {
        btnFlag.disabled = false;
        if (res && res.success) {
          btnFlag.className = "hud-btn-flag flagged";
          btnFlag.innerHTML = "<span>✓ Evicted</span>";
          if (answerText) {
            answerText.className = "hud-answer-text ready";
            answerText.textContent = "Answer flagged wrong. Cache evicted.";
          }
        }
      });
    });
  }

  // ==========================================================================
  // Double-Tap Hotkeys (Ctrl, Z / Alt, Fn / Shift)
  // ==========================================================================
  let ctrlDown = false;
  let ctrlComboUsed = false;
  let altDown = false;
  let altComboUsed = false;
  let shiftDown = false;
  let shiftComboUsed = false;
  let fnDown = false;
  let fnComboUsed = false;
  let zDown = false;
  let zComboUsed = false;

  const lastTapTimes = {
    Control: 0,
    Alt: 0,
    Shift: 0,
    Fn: 0,
    Z: 0
  };

  function isEditableElement(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    if (typeof el.getAttribute === "function" && el.getAttribute("contenteditable") === "true") return true;
    return false;
  }

  function isFnKey(e) {
    return e.key === "Fn" || e.key === "Function" || e.code === "Fn" || e.key === "Unidentified" || e.keyCode === 255;
  }

  const singleTapTimers = {
    Control: null,
    Shift: null,
    Fn: null,
    Z: null,
    Alt: null
  };

  let lastGlobalHandledEvent = null;

  function executeModifierAction(modName, isDouble, e) {
    if (e && (e === lastGlobalHandledEvent || e.__quizzy_handled__)) return;

    if (isProctoredCodingPage()) {
      if (e) {
        lastGlobalHandledEvent = e;
        e.__quizzy_handled__ = true;
      }
      const codingHud = getActiveCodingHudInstance();
      if (modName === "Control") {
        const wasMounted = Boolean(codingHud && codingHud.wrapper);
        mountCodingDotHud(codingHud);
        if (codingHud) {
          resetDotPositionToCorner(codingHud.wrapper);
          if (!wasMounted || codingHud.isHidden()) {
            codingHud.show();
          } else {
            codingHud.hide();
          }
        }
      } else if (modName === "Shift" || modName === "Fn") {
        mountCodingDotHud(codingHud);
        if (codingHud) {
          if (codingHud.isAutoRunning) {
            codingHud.stopAuto();
          } else {
            resetDotPositionToCorner(codingHud.wrapper);
            codingHud.show();
            codingHud.startAuto();
          }
        }
      }
      return;
    }

    if (modName === "Control") {
      if (e) {
        lastGlobalHandledEvent = e;
        e.__quizzy_handled__ = true;
      }

      if (isSidePanelOpen) {
        sendExtensionMessage({ action: "CLOSE_SIDEPANEL" });
        isSidePanelOpen = false;
        resetDotPositionToCorner(wrapper);
        setHidden(false);
        setMinimized(false);
      } else {
        resetDotPositionToCorner(wrapper);
        toggleVisibility();
      }
    } else if (modName === "Alt") {
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (isSidePanelOpen) {
        sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_mode" });
      } else {
        if (isHiddenState) setHidden(false);
        setMinimized(!isMinimizedState);
      }
    } else if (modName === "Z") {
      if (isDouble) {
        if (e && typeof e.preventDefault === "function") e.preventDefault();
        if (!isSidePanelOpen) {
          if (isHiddenState) setHidden(false);
          setMinimized(!isMinimizedState);
        }
      }
    } else if (modName === "Fn" || modName === "Shift") {
      if (e) {
        lastGlobalHandledEvent = e;
        e.__quizzy_handled__ = true;
      }

      if (isSidePanelOpen) {
        sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_auto" });
      } else {
        if (isAutoRunning) {
          stopAutoMode("Stopped via hotkey");
        } else {
          resetDotPositionToCorner(wrapper);
          setHidden(false);
          startAutoMode();
        }
      }
    }
  }

  function handleModifierDoubleTap(modName, e) {
    if (modName === "Control" || modName === "Shift") {
      executeModifierAction(modName, false, e);
      return;
    }
    const now = Date.now();
    const last = lastTapTimes[modName] || 0;
    const diff = now - last;

    if (last > 0 && diff >= 0 && diff <= 650) {
      lastTapTimes[modName] = 0;
      if (singleTapTimers[modName]) {
        clearTimeout(singleTapTimers[modName]);
        singleTapTimers[modName] = null;
      }
      executeModifierAction(modName, true, e);
    } else {
      lastTapTimes[modName] = now;
      if (singleTapTimers[modName]) {
        clearTimeout(singleTapTimers[modName]);
      }
      if (modName === "Control" || modName === "Shift" || modName === "Fn") {
        singleTapTimers[modName] = setTimeout(() => {
          singleTapTimers[modName] = null;
          lastTapTimes[modName] = 0;
          executeModifierAction(modName, false, e);
        }, 260);
      }
    }
  }

  function onGlobalKeyDown(e) {
    if (!e) return;
    if (e.key === "Escape" || e.key === "Esc") {
      ctrlComboUsed = true;
      shiftComboUsed = true;
      altComboUsed = true;
      if (isSidePanelOpen) {
        sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "escape" });
        if (typeof e.preventDefault === "function") e.preventDefault();
        return;
      }
      if (isAutoRunning) {
        stopAutoMode("Escape key pressed.");
        if (typeof e.preventDefault === "function") e.preventDefault();
        return;
      }
    }

    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = (e.key || "").toLowerCase();
      const code = e.code || "";
      if (key === "s" || code === "KeyS") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (isSidePanelOpen) {
          sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_solve" });
        } else {
          solveCurrentQuestion();
        }
        return;
      }
      if (key === "a" || code === "KeyA") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (isSidePanelOpen) {
          sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_apply" });
        } else {
          applyCurrentSolution();
        }
        return;
      }
      if (key === "n" || code === "KeyN") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (isSidePanelOpen) {
          sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_next" });
        } else {
          clickNextOnPage((res) => {
            if (res && res.button_text && answerText) {
              answerText.textContent = `Advanced: ${res.button_text}`;
            }
          });
        }
        return;
      }
      if (key === "m" || code === "KeyM") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (isSidePanelOpen) {
          sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_mode" });
        } else {
          if (e.shiftKey) {
            toggleMode();
          } else {
            toggleVisibility();
          }
        }
        return;
      }
      if (key === "o" || code === "KeyO") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (isSidePanelOpen) {
          sendExtensionMessage({ action: "FORWARD_SHORTCUT_TO_SIDEPANEL", command: "trigger_auto" });
        } else {
          if (isAutoRunning) {
            stopAutoMode("Stopped via Alt+O");
          } else {
            startAutoMode();
          }
        }
        return;
      }
    }

    if (e.repeat) return;

    const isControl = e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight" || e.keyCode === 17 || e.which === 17;
    const isAlt = e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight";
    const isShift = e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight" || e.keyCode === 16 || e.which === 16;
    const isZ = e.key === "z" || e.key === "Z" || e.code === "KeyZ";

    if (isControl) {
      if (ctrlDown) return;
      ctrlDown = true;
      ctrlComboUsed = false;
      return;
    } else {
      if (ctrlDown) ctrlComboUsed = true;
    }

    if (isShift) {
      const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
      if (isEditableElement(e.target) || isEditableElement(activeEl) || e.ctrlKey || e.altKey || e.metaKey) {
        shiftComboUsed = true;
        return;
      }
      if (shiftDown) return;
      shiftDown = true;
      shiftComboUsed = false;
      return;
    } else {
      if (shiftDown) shiftComboUsed = true;
    }

    if (isAlt) {
      altDown = true;
      altComboUsed = false;
    } else {
      if (altDown) altComboUsed = true;
    }

    if (isFnKey(e)) {
      fnDown = true;
      fnComboUsed = false;
      handleModifierDoubleTap("Fn", e);
      return;
    } else {
      if (fnDown) fnComboUsed = true;
    }

    if (isZ) {
      const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
      if (!isEditableElement(e.target) && !isEditableElement(activeEl) && !e.ctrlKey && !e.altKey && !e.metaKey && !ctrlDown && !altDown) {
        zDown = true;
        zComboUsed = false;
      } else {
        zDown = false;
        zComboUsed = true;
      }
    } else {
      if (zDown) zComboUsed = true;
    }
  }

  function onGlobalKeyUp(e) {
    if (!e || e === lastGlobalHandledEvent || e.__quizzy_handled__) return;
    const isControl = e.key === "Control" || e.code === "ControlLeft" || e.code === "ControlRight" || e.keyCode === 17 || e.which === 17;
    const isAlt = e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight";
    const isShift = e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight" || e.keyCode === 16 || e.which === 16;
    const isZ = e.key === "z" || e.key === "Z" || e.code === "KeyZ";

    if (isControl) {
      ctrlDown = false;
      if (!ctrlComboUsed) {
        executeModifierAction("Control", false, e);
      }
    } else if (isAlt) {
      altDown = false;
      if (!altComboUsed) {
        handleModifierDoubleTap("Alt", e);
      }
    } else if (isShift) {
      const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
      if (isEditableElement(e.target) || isEditableElement(activeEl)) {
        shiftDown = false;
        shiftComboUsed = true;
        return;
      }
      const wasDown = shiftDown;
      const wasCombo = shiftComboUsed;
      shiftDown = false;
      shiftComboUsed = false;
      if (wasDown && !wasCombo) {
        executeModifierAction("Shift", false, e);
      }
    } else if (isFnKey(e)) {
      fnDown = false;
      if (!fnComboUsed) {
        handleModifierDoubleTap("Fn", e);
      }
    } else if (isZ) {
      if (zDown && !zComboUsed) {
        handleModifierDoubleTap("Z", e);
      }
      zDown = false;
      zComboUsed = false;
    }
  }

  function onGlobalPointerDown(e) {
    if (!e || e === lastGlobalHandledEvent || e.__quizzy_handled__) return;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      ctrlComboUsed = true;
      const isInsideHud = e.target && (
        (miniDot && (e.target === miniDot || (miniDot.contains && miniDot.contains(e.target)))) ||
        (wrapper && (e.target === wrapper || (wrapper.contains && wrapper.contains(e.target))))
      );
      if (!isInsideHud) {
        lastGlobalHandledEvent = e;
        e.__quizzy_handled__ = true;

        resetDotPositionToCorner(wrapper);
        toggleVisibility();
      }
    }
  }

  function resetGlobalModifierStates() {
    ctrlDown = false;
    ctrlComboUsed = false;
    shiftDown = false;
    shiftComboUsed = false;
    altDown = false;
    altComboUsed = false;
    fnDown = false;
    fnComboUsed = false;
    zDown = false;
    zComboUsed = false;
  }

  if (typeof window !== "undefined" && !window.__QUIZZY_GLOBAL_KEYBOARD_INITIALIZED__) {
    window.__QUIZZY_GLOBAL_KEYBOARD_INITIALIZED__ = true;
    if (typeof window.addEventListener === "function") {
      window.addEventListener("keydown", onGlobalKeyDown, { capture: true, passive: false });
      window.addEventListener("keyup", onGlobalKeyUp, { capture: true, passive: false });
      window.addEventListener("pointerdown", onGlobalPointerDown, { capture: true, passive: true });
      window.addEventListener("blur", resetGlobalModifierStates);
    }
  } else if (typeof document !== "undefined" && !document.__QUIZZY_GLOBAL_KEYBOARD_INITIALIZED__ && typeof document.addEventListener === "function") {
    document.__QUIZZY_GLOBAL_KEYBOARD_INITIALIZED__ = true;
    document.addEventListener("keydown", onGlobalKeyDown, { capture: true, passive: false });
    document.addEventListener("keyup", onGlobalKeyUp, { capture: true, passive: false });
    document.addEventListener("pointerdown", onGlobalPointerDown, { capture: true, passive: true });
    document.addEventListener("blur", resetGlobalModifierStates);
  }

  // Runtime message listener for background commands & shortcuts
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.action) return false;
      if (message.action === "KILL_SWITCH_TRIGGERED") {
        if (isAutoRunning) {
          stopAutoMode(message.reason || "Kill switch triggered.");
        }
        if (typeof sendResponse === "function") sendResponse({ success: true });
        return;
      }
      if (message.action === "TOGGLE_FLOATING_HUD_COMMAND") {
        toggleVisibility();
        if (typeof sendResponse === "function") sendResponse({ success: true });
        return;
      }
      if (message.action === "SHOW_FLOATING_HUD_COMMAND") {
        show(true);
        if (typeof sendResponse === "function") sendResponse({ success: true });
        return;
      }
      if (message.action === "HIDE_FLOATING_HUD_COMMAND") {
        hide();
        if (typeof sendResponse === "function") sendResponse({ success: true });
        return;
      }
      if (message.action === "SIDEPANEL_STATE_CHANGED") {
        isSidePanelOpen = Boolean(message.isOpen);
        if (isSidePanelOpen) {
          hide();
        }
        if (typeof sendResponse === "function") sendResponse({ success: true, isSidePanelOpen });
        return true;
      }
      if (message.action === "SHORTCUT_ACTION") {
        const cmd = message.command;
        if (cmd === "trigger_solve") {
          solveCurrentQuestion();
          if (typeof sendResponse === "function") sendResponse({ handled: true, success: true });
        } else if (cmd === "trigger_apply") {
          applyCurrentSolution();
          if (typeof sendResponse === "function") sendResponse({ handled: true, success: true });
        } else if (cmd === "trigger_auto_loop" || cmd === "trigger_auto") {
          if (isAutoRunning) {
            stopAutoMode("Stopped via shortcut");
          } else {
            startAutoMode();
          }
          if (typeof sendResponse === "function") sendResponse({ handled: true, success: true, running: isAutoRunning });
        } else if (cmd === "open_popup_hud" || cmd === "toggle_hud") {
          toggleVisibility();
          if (typeof sendResponse === "function") sendResponse({ handled: true, success: true });
        } else if (cmd === "trigger_next") {
          clickNextOnPage();
          if (typeof sendResponse === "function") sendResponse({ handled: true, success: true });
        } else {
          if (typeof sendResponse === "function") sendResponse({ handled: false });
        }
        return true;
      }
    });
  }

  // ==========================================================================
  // Public Instance Definition
  // ==========================================================================
  const hudInstance = {
    host,
    shadow,
    wrapper,
    fullBar,
    miniDot,
    isCodingMode: false,
    get quizzyMode() { return quizzyMode; },
    getMode: () => quizzyMode,
    setMode,
    toggleMode,
    isProctoredCodingPage: () => false,
    isVisible: () => isVisibleState && !isHiddenState,
    isHidden: () => isHiddenState,
    isMinimized: () => isMinimizedState,
    get isAutoRunning() { return isAutoRunning; },
    get isSidePanelOpen() { return isSidePanelOpen; },
    get isBackendOnline() { return backendOnline; },
    get autoErrorOccurred() { return autoErrorOccurred; },
    get autoErrorMessage() { return autoErrorMessage; },
    updateDotState,
    checkHealth,
    setSidePanelOpen: (val) => {
      isSidePanelOpen = Boolean(val);
      if (isSidePanelOpen) hide();
    },
    toggle: toggleVisibility,
    show,
    hide,
    setMinimized,
    setHidden,
    solve: solveCurrentQuestion,
    apply: applyCurrentSolution,
    next: clickNextOnPage,
    startAuto: startAutoMode,
    stopAuto: stopAutoMode,
    destroy: () => {
      clearInterval(healthInterval);
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("keydown", onGlobalKeyDown, true);
        window.removeEventListener("keyup", onGlobalKeyUp, true);
      }
      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
      }
      delete window.__QUIZZY_HUD_INSTANCE__;
    }
  };

  window.__QUIZZY_HUD_INSTANCE__ = hudInstance;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = hudInstance;
  }

  return {
    success: true,
    mounted: true,
    visible: isVisibleState && !isHiddenState,
    instance: hudInstance,
    shadow,
    wrapper,
    fullBar,
    miniDot,
    ...hudInstance,
    get isAutoRunning() { return isAutoRunning; },
    get isSidePanelOpen() { return isSidePanelOpen; },
    get isBackendOnline() { return backendOnline; },
    get autoErrorOccurred() { return autoErrorOccurred; },
    get autoErrorMessage() { return autoErrorMessage; },
    updateDotState,
    checkHealth
  };
})();
