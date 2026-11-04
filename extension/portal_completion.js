/**
 * QuizZy - CCBP Portal Completion Engine
 * Automates Videos ("Slides" -> "Mark as Completed" -> "YES") and
 * Reading Materials ("Continue" -> Inline Checkpoint MCQs -> "Completed")
 * within the currently active/expanded Module on learning.ccbp.in/course* pages.
 *
 * STRICT GUARDRAILS:
 * 1. Current-Module Boundary Lock: NEVER crosses, clicks, or expands next/previous module.
 * 2. Strict Blacklist: NEVER clicks MCQ Practice, Coding Practice, Quizzes, Assessments, or Tests.
 * 3. Hotkey: Ctrl + Alt + 0 toggles automation on/off.
 * 4. Visual State: Pulsing violet dot (#a855f7) while active; restores normal dot upon completion or cancellation.
 */
(() => {
  "use strict";

  if (typeof window !== "undefined" && window.__QUIZZY_PORTAL_LOADED__) {
    return (typeof module !== "undefined" && module.exports)
      ? module.exports
      : window.QuizZyPortalCompletion;
  }
  if (typeof window !== "undefined") {
    window.__QUIZZY_PORTAL_LOADED__ = true;
  }

  // Strict blacklist: Never click, touch, or interact with any item matching this pattern
  const STRICT_BLACKLIST_REGEX = /\b(mcq\s*practice|mcq|coding\s*practice|coding|practice|classroom\s*quiz|module\s*quiz|course\s*quiz|quiz|quizzes|assessment|test|exam|assignment|project|mock)\b/i;

  let isActive = false;
  let cancelRequested = false;
  let lockedModuleId = null;
  let lockedModuleTitle = null;
  let activeLoopPromise = null;

  const stats = {
    completedUnits: 0,
    completedVideos: 0,
    completedTutorials: 0,
    solvedInlineMCQs: 0
  };

  function getGlobalDoc(docRef) {
    if (docRef) return docRef;
    if (typeof document !== "undefined") return document;
    return null;
  }

  function getGlobalWin() {
    if (typeof window !== "undefined") return window;
    if (typeof global !== "undefined") return global;
    return {};
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  function isExtensionContextValid() {
    return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
  }

  async function pollUntil(predicateFn, maxWaitMs = 3000, intervalMs = 150) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (cancelRequested) return null;
      try {
        const res = predicateFn();
        if (res) return res;
      } catch (_) {}
      await sleep(intervalMs);
    }
    return null;
  }

  /**
   * Fast, layout-safe visible text extractor for narrow containers.
   * Separates text nodes with spaces to preserve word boundaries without serializing scripts/styles or triggering reflows.
   */
  function getCleanVisibleText(rootEl) {
    if (!rootEl) return "";
    let extracted = "";
    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        const val = (node.nodeValue || "").trim();
        if (val) {
          extracted += (extracted ? " " : "") + val;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node.tagName || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg" || tag === "template") return;
      const children = node.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }
    }
    walk(rootEl);
    if (!extracted && (rootEl.innerText || rootEl.textContent)) {
      return (rootEl.innerText || rootEl.textContent).replace(/\s+/g, " ").trim();
    }
    return extracted.replace(/\s+/g, " ").trim();
  }

  /**
   * Safe event dispatch simulating realistic user click sequence.
   */
  function dispatchRealisticClick(el, bubbles = true) {
    if (!el) return false;
    try {
      if (typeof el.focus === "function") el.focus();
    } catch (_) {}

    const win = getGlobalWin();
    let clientX = 0;
    let clientY = 0;
    if (typeof el.getBoundingClientRect === "function") {
      try {
        const rect = el.getBoundingClientRect();
        clientX = Math.round(rect.left + (rect.width || 0) / 2);
        clientY = Math.round(rect.top + (rect.height || 0) / 2);
      } catch (_) {}
    }

    const mouseInit = {
      bubbles: !!bubbles,
      cancelable: true,
      composed: !!bubbles,
      view: win,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    const EventCtor = (typeof win.MouseEvent === "function") ? win.MouseEvent : (win.Event || null);

    if (EventCtor && typeof el.dispatchEvent === "function") {
      ["pointerover", "mouseover", "pointerdown", "mousedown", "focus", "pointerup", "mouseup"].forEach((type) => {
        try {
          if (type === "focus") {
            try { el.focus(); } catch (_) {}
            return;
          }
          const ev = new EventCtor(type, mouseInit);
          el.dispatchEvent(ev);
        } catch (_) {}
      });
    }

    try {
      if (typeof el.click === "function") {
        el.click();
        return true;
      }
    } catch (_) {}

    if (EventCtor && typeof el.dispatchEvent === "function") {
      try {
        const clickEv = new EventCtor("click", mouseInit);
        el.dispatchEvent(clickEv);
        return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * React-safe radio / option selection with mouse event escalation, container click,
   * 250ms wait, and selection verification.
   */
  async function selectInlineOption(optEl) {
    if (!optEl) return false;

    // Resolve radio input and option container
    let radioEl = null;
    let containerEl = null;

    if (optEl.tagName === "INPUT" && optEl.type === "radio") {
      radioEl = optEl;
      containerEl = optEl.closest("label, [role='radio'], div[class*='option' i], li") || optEl.parentElement;
    } else {
      containerEl = optEl;
      radioEl = optEl.querySelector ? optEl.querySelector("input[type='radio'], [role='radio']") : null;
    }

    try {
      if (typeof optEl.focus === "function") optEl.focus();
    } catch (_) {}

    // Escalate clicks: click container first, then radio if present
    if (containerEl) {
      dispatchRealisticClick(containerEl);
    }

    if (radioEl) {
      try {
        radioEl.checked = true;
        const tracker = radioEl._valueTracker;
        if (tracker && typeof tracker.setValue === "function") {
          tracker.setValue("");
        }
      } catch (_) {}

      const win = getGlobalWin();
      const EventCtor = (typeof win.Event === "function") ? win.Event : null;
      if (EventCtor && typeof radioEl.dispatchEvent === "function") {
        try { radioEl.dispatchEvent(new EventCtor("change", { bubbles: true, composed: true })); } catch (_) {}
        try { radioEl.dispatchEvent(new EventCtor("input", { bubbles: true, composed: true })); } catch (_) {}
      }
      dispatchRealisticClick(radioEl);
    }

    // Pacing wait for React state reconciliation
    await sleep(250);

    // Verify selection
    const isSelected = (radioEl && radioEl.checked) ||
      (containerEl && (
        (containerEl.className || "").toString().toLowerCase().includes("selected") ||
        (containerEl.className || "").toString().toLowerCase().includes("active") ||
        (typeof containerEl.getAttribute === "function" && (
          containerEl.getAttribute("aria-checked") === "true" ||
          containerEl.getAttribute("data-selected") === "true"
        ))
      ));

    return Boolean(isSelected);
  }

  function selectRadioOption(radioEl) {
    if (!radioEl) return;
    try {
      if (typeof radioEl.focus === "function") radioEl.focus();
    } catch (_) {}

    try {
      radioEl.checked = true;
      const tracker = radioEl._valueTracker;
      if (tracker && typeof tracker.setValue === "function") {
        tracker.setValue("");
      }
    } catch (_) {}

    const win = getGlobalWin();
    const EventCtor = (typeof win.Event === "function") ? win.Event : null;
    if (EventCtor && typeof radioEl.dispatchEvent === "function") {
      try { radioEl.dispatchEvent(new EventCtor("change", { bubbles: true, composed: true })); } catch (_) {}
      try { radioEl.dispatchEvent(new EventCtor("input", { bubbles: true, composed: true })); } catch (_) {}
    }
    dispatchRealisticClick(radioEl);
  }

  /**
   * Route Safety Guard:
   * Refuses to start if directly inside a standalone question/quiz runner or outside CCBP courses.
   */
  function isRouteEligible(url, doc) {
    try {
      const win = getGlobalWin();
      const rawUrl = url || (win.location ? win.location.href : "");
      if (!rawUrl) return false;

      const parsed = new URL(rawUrl);
      const hostname = (parsed.hostname || "").toLowerCase();
      const isAllowedHost = hostname === "learning.ccbp.in" || hostname.endsWith(".ccbp.in") || hostname === "localhost" || hostname === "127.0.0.1";
      if (!isAllowedHost) {
        return false;
      }

      const pathname = parsed.pathname || "";

      // Refuse standalone question coding environment or assessment runner
      if (/\/question\/[a-z0-9-]+/i.test(pathname) || /\/assessment\//i.test(pathname) || /\/test-runner\//i.test(pathname)) {
        return false;
      }

      // Must be on CCBP course curriculum page
      if (!pathname.includes("/course") && !rawUrl.includes("/course")) {
        return false;
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Checks if an item's label matches the strict blacklist.
   */
  function isBlacklisted(text) {
    if (!text || typeof text !== "string") return false;
    return STRICT_BLACKLIST_REGEX.test(text.trim());
  }

  /**
   * Checks if a sidebar unit item displays a completed green checkmark or badge.
   */
  function isItemCompleted(itemEl) {
    if (!itemEl) return false;

    // 1. Direct class or status attribute
    const className = (itemEl.className || "").toString().toLowerCase();
    if (className.includes("completed") || className.includes("is-completed") || className.includes("unit-completed")) {
      return true;
    }
    const statusAttr = (itemEl.getAttribute && itemEl.getAttribute("data-status") || "").toLowerCase();
    if (statusAttr === "completed" || statusAttr === "done") {
      return true;
    }

    // 2. Scan child SVGs, paths, and icons for green tick / completed checkmark
    const svgs = itemEl.querySelectorAll ? Array.from(itemEl.querySelectorAll("svg, [data-icon], i, img")) : [];
    for (const icon of svgs) {
      const aria = (icon.getAttribute && icon.getAttribute("aria-label") || "").toLowerCase();
      const title = (icon.getAttribute && icon.getAttribute("title") || "").toLowerCase();
      const iconClass = (icon.className || "").toString().toLowerCase();

      if (aria.includes("completed") || aria.includes("complete") || aria.includes("tick") || aria.includes("checked") ||
          title.includes("completed") || title.includes("complete") ||
          iconClass.includes("completed") || iconClass.includes("check") || iconClass.includes("tick")) {
        return true;
      }

      // Check fill or stroke color for green hues (#22c55e, #16a34a, #10b981, #2e7d32, etc.)
      const fill = (icon.getAttribute && icon.getAttribute("fill") || "").toLowerCase();
      const stroke = (icon.getAttribute && icon.getAttribute("stroke") || "").toLowerCase();
      const isGreen = (c) => (
        c.includes("22c55e") || c.includes("16a34a") || c.includes("10b981") || c.includes("2e7d32") ||
        c.includes("rgb(34, 197, 94)") || c.includes("rgb(46, 125, 50)") || c.includes("rgb(22, 163, 74)") ||
        c.includes("green")
      );
      if (isGreen(fill) || isGreen(stroke)) {
        return true;
      }

      // Check SVG paths for checkmark path data or inline styles
      const paths = icon.querySelectorAll ? Array.from(icon.querySelectorAll("path, polygon, polyline")) : [];
      for (const p of paths) {
        const pFill = (p.getAttribute && p.getAttribute("fill") || "").toLowerCase();
        const pStroke = (p.getAttribute && p.getAttribute("stroke") || "").toLowerCase();
        const pStyle = (p.getAttribute && p.getAttribute("style") || "").toLowerCase();
        if (isGreen(pFill) || isGreen(pStroke) || isGreen(pStyle)) {
          return true;
        }
        const d = (p.getAttribute && p.getAttribute("d") || "").toLowerCase();
        // Common checkmark SVG paths often have check classes or d attributes matching checkmark strokes
        const pCls = (p.className || "").toString().toLowerCase();
        if (pCls.includes("check") || pCls.includes("tick") || pCls.includes("completed")) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Auto-detect or locate the top-left sidebar toggle button.
   */
  function findSidebarToggleButton(docRef) {
    const doc = getGlobalDoc(docRef);
    if (!doc) return null;

    const buttons = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, [role='button'], div[class*='toggle' i]")) : [];
    for (const btn of buttons) {
      const aria = (btn.getAttribute && btn.getAttribute("aria-label") || "").toLowerCase();
      const title = (btn.getAttribute && btn.getAttribute("title") || "").toLowerCase();
      const cls = (btn.className || "").toString().toLowerCase();

      if (aria.includes("sidebar") || aria.includes("drawer") || aria.includes("menu") || aria.includes("navigation") || aria.includes("curriculum") ||
          title.includes("sidebar") || title.includes("drawer") || title.includes("menu") ||
          cls.includes("sidebar-toggle") || cls.includes("drawer-toggle") || cls.includes("menu-icon")) {
        return btn;
      }

      // Buttons near top-left containing hamburger/bars SVG
      if (typeof btn.getBoundingClientRect === "function") {
        try {
          const rect = btn.getBoundingClientRect();
          if (rect.left >= 0 && rect.left < 260 && rect.top >= 0 && rect.top < 140) {
            const hasSvg = btn.querySelector && btn.querySelector("svg");
            if (hasSvg || cls.includes("menu") || cls.includes("hamburger") || cls.includes("drawer")) {
              return btn;
            }
          }
        } catch (_) {}
      }
    }
    return null;
  }

  /**
   * Ensures the left curriculum sidebar is open and visible.
   */
  async function ensureSidebarOpen(docRef) {
    const doc = getGlobalDoc(docRef);
    if (!doc) return false;

    // Check if module items or sidebar is currently visible
    const sidebarContainer = doc.querySelector ? (
      doc.querySelector(".course-curriculum, [data-testid*='curriculum'], .curriculum-sidebar, nav[class*='sidebar'], div[class*='drawer' i], div[class*='module' i]")
    ) : null;

    let isVisible = false;
    if (sidebarContainer) {
      if (typeof sidebarContainer.getBoundingClientRect === "function") {
        try {
          const rect = sidebarContainer.getBoundingClientRect();
          isVisible = rect.width > 50 && rect.height > 50;
        } catch (_) {}
      } else {
        isVisible = true;
      }
    }

    if (!isVisible) {
      const toggleBtn = findSidebarToggleButton(doc);
      if (toggleBtn) {
        dispatchRealisticClick(toggleBtn);
        await sleep(450); // Pacing wait for drawer animation
        return true;
      }
    }
    return isVisible;
  }

  /**
   * Discovers and locks onto the currently active/expanded module container.
   */
  function getActiveModule(docRef) {
    const doc = getGlobalDoc(docRef);
    if (!doc) return null;

    // Candidate module containers: accordions, module sections, or groups
    const moduleElements = doc.querySelectorAll ? Array.from(doc.querySelectorAll("[class*='module' i], [data-testid*='module' i], .accordion-item, div[class*='chapter' i], div[class*='section' i]")) : [];

    // Filter to those that represent actual modules (contain "Module" header or index)
    const validModules = moduleElements.filter((el) => {
      const text = (el.textContent || el.innerText || "").slice(0, 300);
      return /module\s+([0-9]+|[ivxlcdm]+)\b/i.test(text);
    });

    const candidates = validModules.length > 0 ? validModules : moduleElements;

    // 1. Look for module containing the currently active / selected unit
    for (const mod of candidates) {
      const activeUnit = mod.querySelector ? mod.querySelector(".active, .selected, [aria-current='true'], [data-active='true'], [class*='active-unit' i]") : null;
      if (activeUnit) {
        return mod;
      }
    }

    // 2. Look for module accordion with expanded state
    for (const mod of candidates) {
      const isExpanded = (mod.getAttribute && mod.getAttribute("aria-expanded") === "true") ||
        (mod.className || "").toString().toLowerCase().includes("expanded") ||
        (mod.className || "").toString().toLowerCase().includes("open");
      if (isExpanded) {
        return mod;
      }
    }

    // 3. Fallback: match by locked title if already set
    if (lockedModuleTitle) {
      for (const mod of candidates) {
        const text = (mod.textContent || mod.innerText || "");
        if (text.includes(lockedModuleTitle)) {
          return mod;
        }
      }
    }

    // Default to the first valid module if nothing else active
    return candidates[0] || null;
  }

  /**
   * Extracts clean module title from a module container.
   */
  function extractModuleTitle(modEl) {
    if (!modEl) return "";
    const header = modEl.querySelector ? (modEl.querySelector("h1, h2, h3, h4, h5, h6, [class*='header' i], [class*='title' i]") || modEl) : modEl;
    const raw = (header.textContent || header.innerText || "").split("\n")[0].trim();
    const match = raw.match(/module\s+([0-9]+|[ivxlcdm]+)[^:\n]*:?[^\n]*/i);
    return match ? match[0].trim() : raw.slice(0, 60).trim();
  }

  /**
   * Scans the locked module for uncompleted eligible units (Videos & Reading Materials).
   * STRICTLY excludes practices, quizzes, assessments, and tests.
   */
  function getEligibleUnits(moduleContainer, docRef) {
    const mod = moduleContainer || getActiveModule(docRef);
    if (!mod) return [];

    // Unit items inside module container
    const items = mod.querySelectorAll ? Array.from(mod.querySelectorAll("li, a, div[role='button'], div[class*='unit' i], div[class*='item' i], div[class*='topic' i], div[class*='session' i]")) : [];

    // Filter out items that are accordion headers or module wrappers themselves
    const unitCandidates = items.filter((el) => {
      const text = (el.textContent || el.innerText || "").trim();
      if (!text) return false;
      // Skip if this element is the module accordion header itself
      if (/^module\s+([0-9]+|[ivxlcdm]+)\b/i.test(text) && text.length < 50 && el.querySelector && el.querySelector("[class*='module' i]")) {
        return false;
      }
      return true;
    });

    const eligible = [];
    for (const item of unitCandidates) {
      const text = (item.textContent || item.innerText || "").trim();

      // Guardrail 1: Strict Blacklist
      if (isBlacklisted(text)) {
        continue;
      }

      // Guardrail 2: Must not already be completed
      if (isItemCompleted(item)) {
        continue;
      }

      eligible.push(item);
    }

    return eligible;
  }

  /**
   * Helper that finds the nearest scrollable ancestor container
   * (or candidate content panes) and scrolls it to the bottom.
   */
  function scrollContentPaneToBottom(elOrDoc) {
    if (!elOrDoc) return null;
    const doc = (elOrDoc && elOrDoc.nodeType === 9) ? elOrDoc : (elOrDoc.ownerDocument || getGlobalDoc());
    const win = getGlobalWin();

    // 1. Ancestor walk from element (supports DOM elements or mocks with parentElement)
    let cur = (elOrDoc && (elOrDoc.nodeType === 1 || elOrDoc.tagName || elOrDoc.parentElement)) ? elOrDoc : null;
    while (cur && (!doc || (cur !== doc.body && cur !== doc.documentElement))) {
      try {
        const style = (win.getComputedStyle && typeof win.getComputedStyle === "function")
          ? win.getComputedStyle(cur)
          : (cur.style || {});
        const overflowY = (style.overflowY || style.overflow || "").toString().toLowerCase();
        const isScrollable = (cur.scrollHeight > cur.clientHeight) && (overflowY === "auto" || overflowY === "scroll");
        if (isScrollable) {
          cur.scrollTop = cur.scrollHeight;
          return cur;
        }
      } catch (_) {}
      cur = cur.parentElement;
    }

    // 2. Query scrollable content containers on CCBP
    if (doc) {
      const candidates = doc.querySelectorAll ? Array.from(doc.querySelectorAll(
        "[class*='content-pane' i], [class*='content-container' i], [class*='course-content' i], [class*='right-pane' i], [class*='main-content' i], [class*='reading' i], [class*='video' i], main, section, [role='main']"
      )) : [];
      for (const cand of candidates) {
        try {
          if (cand.scrollHeight <= cand.clientHeight && cand.scrollHeight <= 400) {
            continue;
          }
          const style = (win.getComputedStyle && typeof win.getComputedStyle === "function")
            ? win.getComputedStyle(cand)
            : (cand.style || {});
          const overflowY = (style.overflowY || style.overflow || "").toString().toLowerCase();
          const isScrollable = (cand.scrollHeight > cand.clientHeight) && (overflowY === "auto" || overflowY === "scroll" || cand.scrollHeight > 400);
          if (isScrollable) {
            cand.scrollTop = cand.scrollHeight;
            return cand;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  /**
   * Automates a Video unit:
   * "Slides" -> "Mark as Completed" -> confirm "YES" -> wait for "Completed".
   */
  async function automateVideoUnit(docRef) {
    const doc = getGlobalDoc(docRef);
    if (!doc) return { success: false, reason: "No document" };

    // 1. Check if already completed
    const completedBadge = findCompletedIndicator(doc);
    if (completedBadge) {
      return { success: true, alreadyCompleted: true };
    }

    // 2. Scroll content pane to bottom to ensure "Slides" and "Mark as Completed" are rendered/visible
    scrollContentPaneToBottom(doc);
    await sleep(200);

    // 3. Click "Slides" tab if present and not active
    const slidesTab = findSlidesTab(doc);
    if (slidesTab) {
      const isActiveTab = (slidesTab.className || "").toString().toLowerCase().includes("active") ||
        (slidesTab.getAttribute && slidesTab.getAttribute("aria-selected") === "true");
      if (!isActiveTab) {
        dispatchRealisticClick(slidesTab);
        await sleep(350);
        scrollContentPaneToBottom(slidesTab);
      }
    }

    // 4. Find and click "Mark as Completed" button
    let markCompletedBtn = findMarkAsCompletedButton(doc);
    if (!markCompletedBtn) {
      scrollContentPaneToBottom(doc);
      await sleep(300);
      markCompletedBtn = findMarkAsCompletedButton(doc);
    }

    if (!markCompletedBtn) {
      // Maybe already completed during click
      if (findCompletedIndicator(doc)) {
        return { success: true };
      }
      return { success: false, reason: "Mark as Completed button not found" };
    }

    scrollContentPaneToBottom(markCompletedBtn);
    if (typeof markCompletedBtn.scrollIntoView === "function") {
      try { markCompletedBtn.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
    }
    await sleep(200);

    // Click both the element and its clickable parent wrapper (React event escalation)
    dispatchRealisticClick(markCompletedBtn);
    if (markCompletedBtn.parentElement && markCompletedBtn.parentElement !== doc.body) {
      dispatchRealisticClick(markCompletedBtn.parentElement);
    }

    // 5. Wait up to 3,000ms for confirmation dialog (checking portals in doc.body)
    const modalFound = await pollUntil(() => findConfirmationModal(doc), 3000, 150);
    if (modalFound) {
      const yesBtn = findYesButtonInModal(modalFound || doc);
      if (yesBtn) {
        dispatchRealisticClick(yesBtn);
        if (yesBtn.parentElement && yesBtn.parentElement !== modalFound) {
          dispatchRealisticClick(yesBtn.parentElement);
        }
        await sleep(400);
      }
    }

    // 6. Wait up to 3,500ms for page to reflect "Completed"
    const isDone = await pollUntil(() => findCompletedIndicator(doc), 3500, 150);
    if (isDone) {
      stats.completedVideos++;
      stats.completedUnits++;
    }
    return { success: Boolean(isDone) };
  }

  function findSlidesTab(doc) {
    const elements = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, div[role='tab'], a, span, div[class*='tab' i]")) : [];
    for (const el of elements) {
      const text = (el.textContent || el.innerText || "").trim();
      if (/^\s*slides\s*$/i.test(text)) {
        return el;
      }
    }
    return null;
  }

  function findMarkAsCompletedButton(doc) {
    if (!doc) return null;
    const candidates = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, [role='button'], div[class*='btn' i], a, label, span, div")) : [];
    for (const b of candidates) {
      const text = (b.textContent || b.innerText || "").trim();
      if (/^mark\s+as\s+completed$/i.test(text) || /\bmark\s+as\s+completed\b/i.test(text)) {
        const btnWrapper = b.closest ? b.closest("button, [role='button'], div[class*='btn' i], a") : null;
        return btnWrapper || b;
      }
    }
    return null;
  }

  function findConfirmationModal(doc) {
    if (!doc) return null;
    const isConfirmText = (t) => /are\s+you\s+sure[\s\S]*?mark[\s\S]*?completed/i.test(t) || /(?:are\s+you\s+sure|confirm)[\s\S]*?(?:mark\s+as\s+)?completed/i.test(t);
    const modals = doc.querySelectorAll ? Array.from(doc.querySelectorAll("[role='dialog'], [aria-modal='true'], .modal, div[class*='modal' i], div[class*='popup' i], div[class*='dialog' i], [class*='portal' i], [class*='overlay' i]")) : [];
    for (const m of modals) {
      const text = getCleanVisibleText(m);
      if (isConfirmText(text)) {
        return m;
      }
    }
    // Scan direct children of body instead of full document.body textContent serialization
    if (doc.body && doc.body.children) {
      const bodyChildren = Array.from(doc.body.children);
      for (const child of bodyChildren) {
        const tag = (child.tagName || "").toLowerCase();
        if (tag === "script" || tag === "style" || tag === "svg") continue;
        const text = getCleanVisibleText(child);
        if (isConfirmText(text)) {
          return child;
        }
      }
    }
    return null;
  }

  function findYesButtonInModal(modalOrDoc) {
    const root = modalOrDoc || (typeof document !== "undefined" ? document.body : null);
    if (!root) return null;
    const buttons = root.querySelectorAll ? Array.from(root.querySelectorAll("button, [role='button'], div[class*='btn' i], a, span")) : [];
    for (const b of buttons) {
      const text = (b.textContent || b.innerText || "").trim();
      if (/^\s*yes\s*$/i.test(text) || /\b(yes|confirm|proceed|ok)\b/i.test(text)) {
        const btnWrapper = b.closest ? b.closest("button, [role='button'], div[class*='btn' i], a") : null;
        return btnWrapper || b;
      }
    }
    return null;
  }

  function findCompletedIndicator(doc) {
    const badges = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, span, div, [class*='badge' i], [class*='status' i]")) : [];
    for (const el of badges) {
      const text = (el.textContent || el.innerText || "").trim();
      if (/^completed$/i.test(text)) {
        return el;
      }
    }
    return null;
  }

  /**
   * Automates a Reading Material / Tutorial unit:
   * Loops clicking "Continue" and solving/sweeping inline checkpoint MCQs until "Completed".
   */
  async function automateReadingUnit(docRef, solveFn) {
    const doc = getGlobalDoc(docRef);
    if (!doc) return { success: false, reason: "No document" };

    const maxSteps = 40;
    let stepCount = 0;

    while (!cancelRequested && stepCount < maxSteps) {
      stepCount++;
      scrollContentPaneToBottom(doc);

      // 1. Check for page-level Completed badge
      const completedBadge = findCompletedIndicator(doc);
      const continueBtn = findContinueButton(doc);
      const inlineCard = findInlineQuestionCard(doc);

      if (completedBadge && (!continueBtn || continueBtn.disabled) && !inlineCard) {
        stats.completedTutorials++;
        stats.completedUnits++;
        return { success: true };
      }

      // 2. Check for inline checkpoint question card
      if (inlineCard) {
        await handleInlineCheckpointQuestion(inlineCard, doc, solveFn);
        await sleep(500);
        continue;
      }

      // 3. Click active Continue button
      if (continueBtn && !continueBtn.disabled && continueBtn.getAttribute("aria-disabled") !== "true") {
        if (typeof continueBtn.scrollIntoView === "function") {
          try { continueBtn.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
        }
        await sleep(200);
        dispatchRealisticClick(continueBtn);
        await sleep(500); // Pacing wait for next section to render
        continue;
      }

      // If neither continue button nor inline card exists, check for completed badge once more
      if (findCompletedIndicator(doc)) {
        stats.completedTutorials++;
        stats.completedUnits++;
        return { success: true };
      }

      // Short wait to avoid hot spin
      await sleep(400);
      break;
    }

    const finalCompleted = Boolean(findCompletedIndicator(doc));
    return { success: finalCompleted };
  }

  function findContinueButton(doc) {
    const buttons = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, [role='button'], div[class*='btn' i]")) : [];
    for (const b of buttons) {
      const text = (b.textContent || b.innerText || "").trim();
      if (/^\s*continue\s*$/i.test(text)) {
        return b;
      }
    }
    return null;
  }

  function findInlineQuestionCard(doc) {
    const cards = doc.querySelectorAll ? Array.from(doc.querySelectorAll("[class*='question' i], [class*='mcq' i], [class*='card' i], div[class*='checkpoint' i]")) : [];
    for (const c of cards) {
      const text = (c.textContent || c.innerText || "").trim();
      // Must contain inline question cues or radio options + submit button
      const hasInlineCue = /question\s+[0-9]+\s+of\s+[0-9]+|complete\s+the\s+mcqs\s+to\s+proceed/i.test(text);
      const submitBtn = findInlineSubmitButton(c);
      const hasRadio = (c.querySelector && c.querySelector("input[type='radio'], [role='radio']")) || (c.querySelectorAll && c.querySelectorAll("input[type='radio'], [role='radio']").length > 0);
      if ((hasInlineCue || hasRadio) && submitBtn) {
        return c;
      }
    }
    return null;
  }

  function findInlineSubmitButton(cardOrDoc) {
    if (!cardOrDoc) return null;
    const buttons = cardOrDoc.querySelectorAll ? Array.from(cardOrDoc.querySelectorAll("button, [role='button'], div[class*='btn' i]")) : [];
    for (const b of buttons) {
      const text = (b.textContent || b.innerText || "").trim();
      // Guardrail: MUST NOT match "Submit Feedback" or global assessment submit
      if (/submit\s+feedback/i.test(text)) {
        continue;
      }
      if (/^\s*submit\s*$/i.test(text)) {
        return b;
      }
    }
    return null;
  }

  function isInlineQuestionSolved(card, doc) {
    if (!card) return true;
    if (findCompletedIndicator(doc)) return true;
    const submitBtn = findInlineSubmitButton(card);
    if (!submitBtn) return true; // Submit button disappeared upon completion

    const continueBtn = findContinueButton(doc);
    if (continueBtn && !continueBtn.disabled && continueBtn.getAttribute("aria-disabled") !== "true") {
      return true; // Continue button became enabled
    }

    const cardText = (card.textContent || card.innerText || "").trim();
    if (/\b(correct|completed)\b/i.test(cardText) && !/\b(wrong|try\s+again|incorrect)\b/i.test(cardText)) {
      return true;
    }
    return false;
  }

  function findInlineShowAnswerButton(cardOrDoc) {
    if (!cardOrDoc) return null;
    const buttons = cardOrDoc.querySelectorAll ? Array.from(cardOrDoc.querySelectorAll("button, [role='button'], div[class*='btn' i], a")) : [];
    for (const b of buttons) {
      const text = (b.textContent || b.innerText || "").trim();
      if (/^\s*show\s+answer\s*$/i.test(text)) {
        return b;
      }
    }
    return null;
  }

  function findInlineRetryButton(cardOrDoc) {
    if (!cardOrDoc) return null;
    const buttons = cardOrDoc.querySelectorAll ? Array.from(cardOrDoc.querySelectorAll("button, [role='button'], div[class*='btn' i], a")) : [];
    for (const b of buttons) {
      const text = (b.textContent || b.innerText || "").trim();
      if (/^\s*(retry|try\s+again)\s*$/i.test(text)) {
        return b;
      }
    }
    return null;
  }

  function findCorrectOptionInCard(card) {
    if (!card) return null;
    const candidateOptions = card.querySelectorAll ? Array.from(card.querySelectorAll("label, div[class*='option' i], [role='radio'], li")) : [];
    for (const opt of candidateOptions) {
      const cls = (opt.className || "").toString().toLowerCase();
      if (cls.includes("correct") || cls.includes("success") || cls.includes("right-answer")) {
        return opt;
      }
      // Check for green checkmark icon inside option
      const svgs = opt.querySelectorAll ? Array.from(opt.querySelectorAll("svg, i, [class*='check' i]")) : [];
      for (const icon of svgs) {
        const iCls = (icon.className || "").toString().toLowerCase();
        if (iCls.includes("check") || iCls.includes("tick") || iCls.includes("correct")) {
          return opt;
        }
      }
    }
    return null;
  }

  /**
   * Solves inline checkpoint question:
   * Step 1: AI solver attempt via solveFn.
   * Step 2: Deterministic option sweep fallback.
   * Step 3: Show Answer / Retry button escalation fallback.
   */
  async function handleInlineCheckpointQuestion(card, doc, solveFn) {
    const options = card.querySelectorAll ? Array.from(card.querySelectorAll("input[type='radio'], [role='radio'], label, div[class*='option' i]")) : [];
    const validOptions = options.filter((opt) => {
      const t = (opt.innerText || opt.textContent || "").trim();
      return t.length > 0 || opt.tagName === "INPUT";
    });

    if (validOptions.length === 0) return;

    let solved = false;

    // Step 1: AI Solver Attempt if available
    if (typeof solveFn === "function") {
      try {
        const questionText = (card.innerText || card.textContent || "").slice(0, 500);
        const optTexts = validOptions.map((o) => (o.innerText || o.textContent || "").trim());
        const solvePromise = Promise.race([
          solveFn({ question: questionText, options: optTexts }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Solve timeout")), 2500))
        ]);
        const res = await solvePromise;
        if (res && typeof res.selectedIndex === "number" && validOptions[res.selectedIndex]) {
          await selectInlineOption(validOptions[res.selectedIndex]);
          const submitBtn = findInlineSubmitButton(card);
          if (submitBtn) {
            dispatchRealisticClick(submitBtn);
            await sleep(500);
            if (isInlineQuestionSolved(card, doc)) {
              solved = true;
              stats.solvedInlineMCQs++;
            }
          }
        }
      } catch (_) {}
    }

    // Step 2: Deterministic Self-Healing Option Sweep Fallback
    if (!solved) {
      for (let i = 0; i < validOptions.length; i++) {
        if (cancelRequested) break;
        const opt = validOptions[i];
        await selectInlineOption(opt);

        const submitBtn = findInlineSubmitButton(card);
        if (!submitBtn) {
          solved = true;
          stats.solvedInlineMCQs++;
          break;
        }

        dispatchRealisticClick(submitBtn);
        await sleep(500);

        if (isInlineQuestionSolved(card, doc)) {
          solved = true;
          stats.solvedInlineMCQs++;
          break;
        }
      }
    }

    // Step 3: Show Answer / Retry Button Escalation Fallback
    if (!solved && !cancelRequested) {
      const retryBtn = findInlineRetryButton(card) || findInlineRetryButton(doc);
      if (retryBtn && !retryBtn.disabled) {
        dispatchRealisticClick(retryBtn);
        await sleep(300);
      }

      const showAnswerBtn = findInlineShowAnswerButton(card) || findInlineShowAnswerButton(doc);
      if (showAnswerBtn && !showAnswerBtn.disabled) {
        dispatchRealisticClick(showAnswerBtn);
        await sleep(350);

        const correctOpt = findCorrectOptionInCard(card);
        if (correctOpt) {
          await selectInlineOption(correctOpt);
          const submitBtn = findInlineSubmitButton(card);
          if (submitBtn) {
            dispatchRealisticClick(submitBtn);
            await sleep(500);
          }
          if (isInlineQuestionSolved(card, doc)) {
            solved = true;
            stats.solvedInlineMCQs++;
          }
        }
      }
    }
  }

  /**
   * Main state-machine Portal Completion loop.
   */
  async function runPortalCompletionLoop(options = {}) {
    const doc = getGlobalDoc(options.document);
    const win = getGlobalWin();
    const pacing = typeof options.pacing === "number" ? options.pacing : (typeof options.pacingMs === "number" ? options.pacingMs : 400);
    const solveFn = options.solveFn || null;

    if (!isRouteEligible(win.location ? win.location.href : "", doc)) {
      stop("Ineligible route");
      return { success: false, reason: "Ineligible route" };
    }

    // 1. Ensure sidebar drawer is open
    await ensureSidebarOpen(doc);

    // 2. Lock onto active module
    const activeMod = getActiveModule(doc);
    if (!activeMod) {
      stop("No active module found");
      return { success: false, reason: "No active module found" };
    }
    lockedModuleTitle = extractModuleTitle(activeMod);
    lockedModuleId = lockedModuleTitle;

    // Loop through eligible units in the locked module
    const maxUnits = 60;
    let iterations = 0;

    while (isActive && !cancelRequested && iterations < maxUnits) {
      iterations++;

      // Re-open sidebar if it collapsed
      await ensureSidebarOpen(doc);

      // Locate locked module container strictly
      const currentMod = getActiveModule(doc);
      if (!currentMod) break;

      // Scan for next uncompleted eligible units inside locked module only
      const eligibleUnits = getEligibleUnits(currentMod, doc);

      if (eligibleUnits.length === 0) {
        // Module is finished!
        break;
      }

      // Take the first uncompleted eligible unit
      const targetUnit = eligibleUnits[0];
      const unitText = (targetUnit.innerText || targetUnit.textContent || "").trim();

      // Scroll into view and click
      if (typeof targetUnit.scrollIntoView === "function") {
        try { targetUnit.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
      }
      await sleep(pacing);
      dispatchRealisticClick(targetUnit);

      // Wait for content pane readiness dynamically
      await pollUntil(() => findSlidesTab(doc) || findMarkAsCompletedButton(doc) || findContinueButton(doc) || findCompletedIndicator(doc), 800, 80);

      // Determine unit type and automate
      const isReading = /tutorial\b|reading\b/i.test(unitText) || Boolean(findContinueButton(doc));
      if (isReading) {
        await automateReadingUnit(doc, solveFn);
      } else {
        await automateVideoUnit(doc);
      }

      await sleep(pacing);
    }

    // Finished or cancelled
    stop("Loop completed");
    return { success: true, stats };
  }

  function notifyStateChange(active) {
    const win = getGlobalWin();

    // 1. Update in-page Floating HUD instance if present
    const hudInst = win.__QUIZZY_HUD_INSTANCE__ || win.__QUIZZY_IN_PAGE_HUD__;
    if (hudInst && typeof hudInst.setPortalCompletionActive === "function") {
      hudInst.setPortalCompletionActive(active);
    }

    // 2. Broadcast via chrome.runtime messaging if available and context valid
    try {
      if (isExtensionContextValid() && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: "PORTAL_COMPLETION_STATE_CHANGED",
          active: Boolean(active)
        }, () => {
          if (chrome.runtime && chrome.runtime.lastError) {}
        });
      }
    } catch (_) {}
  }

  function start(options = {}) {
    const win = getGlobalWin();
    const doc = getGlobalDoc(options.document);

    if (!isRouteEligible(win.location ? win.location.href : "", doc)) {
      return false;
    }

    isActive = true;
    cancelRequested = false;
    notifyStateChange(true);

    activeLoopPromise = runPortalCompletionLoop(options).catch((err) => {
      console.warn("[QuizZy Portal Completion] Loop error:", err);
      stop("Loop error");
    });

    return true;
  }

  function stop(reason = "") {
    isActive = false;
    cancelRequested = true;
    lockedModuleId = null;
    lockedModuleTitle = null;
    notifyStateChange(false);
    return true;
  }

  function toggle(options = {}) {
    if (isActive) {
      stop("User toggled off");
      return false;
    } else {
      return start(options);
    }
  }

  function getState() {
    return {
      isActive,
      lockedModuleId,
      lockedModuleTitle,
      stats: { ...stats }
    };
  }

  // Keyboard shortcut listener: Ctrl + Alt + 0 and Alt + R
  function handleKeyDown(e) {
    if (!e || e.__quizzy_handled__) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "r" || e.key === "R" || e.code === "KeyR")) {
      const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
      const tag = (activeEl && activeEl.tagName) ? activeEl.tagName.toUpperCase() : "";
      const isEdit = tag === "INPUT" || tag === "TEXTAREA" || (activeEl && activeEl.isContentEditable) || (activeEl && activeEl.closest && activeEl.closest('.monaco-editor, .ace_editor'));
      if (!isEdit && typeof window !== "undefined" && typeof window.__QUIZZY_SOFT_REFRESH_EXTENSION__ === "function") {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        e.__quizzy_handled__ = true;
        window.__QUIZZY_SOFT_REFRESH_EXTENSION__();
        return;
      }
    }
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0")) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      e.__quizzy_handled__ = true;
      toggle();
    }
  }

  const win = getGlobalWin();
  if (win && !win.__QUIZZY_PORTAL_KEYBOARD_INITIALIZED__ && typeof win.addEventListener === "function") {
    win.__QUIZZY_PORTAL_KEYBOARD_INITIALIZED__ = true;
    win.addEventListener("keydown", handleKeyDown, { capture: true, passive: false });
  }

  const QuizZyPortalCompletion = {
    start,
    stop,
    toggle,
    getState,
    isRouteEligible,
    isBlacklisted,
    isItemCompleted,
    findSidebarToggleButton,
    ensureSidebarOpen,
    getActiveModule,
    getEligibleUnits,
    automateVideoUnit,
    automateReadingUnit,
    scrollContentPaneToBottom,
    findMarkAsCompletedButton,
    findYesButtonInModal,
    selectInlineOption,
    handleInlineCheckpointQuestion,
    runPortalCompletionLoop,
    isExtensionContextValid,
    STRICT_BLACKLIST_REGEX
  };

  if (typeof window !== "undefined") {
    window.QuizZyPortalCompletion = QuizZyPortalCompletion;
    if (window.QuizZyExecutor) {
      window.QuizZyExecutor.runPortalCompletionLoop = QuizZyPortalCompletion.runPortalCompletionLoop;
      window.QuizZyExecutor.togglePortalCompletion = QuizZyPortalCompletion.toggle;
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = QuizZyPortalCompletion;
  }

  return QuizZyPortalCompletion;
})();
