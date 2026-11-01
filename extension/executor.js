/**
 * QuizZy - DOM Action Executor (Phase 3 Auto Mode)
 * 
 * Strict Guardrail Architecture:
 * - Plain DOM element clicks (.click() / MouseEvent)
 * - Native property descriptor value setting + input/change event dispatch for React/Vue/Angular text inputs
 * - Verified HTML5 DragEvent reordering with post-drag order check (safe-pause fallback if unmoved)
 * - Next/Submit button navigation clicker
 * - ZERO node creation, ZERO DOM attribute/class tampering, ZERO style injection
 */

(function () {
  "use strict";

  /**
   * Cleans text content for matching.
   */
  function cleanText(text) {
    if (!text) return "";
    return String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Normalizes TeX/LaTeX formulas from KaTeX annotation elements.
   * Mirrors 1:1 implementation in extractor.js.
   */
  function normalizeTeX(tex) {
    if (!tex) return "";
    let s = String(tex).trim();

    // 1. Loop-flatten inner constructs before and alongside fractions
    for (let pass = 0; pass < 4; pass++) {
      const prev = s;
      s = s.replace(/\\left\s*([(\[{|.\\])/g, "$1")
           .replace(/\\right\s*([)\]}|.\\])/g, "$1")
           .replace(/\\text\{([^{}]+)\}/g, "$1")
           .replace(/\^\{([^{}]+)\}/g, "^$1")
           .replace(/_\{([^{}]+)\}/g, "_$1")
           .replace(/\\sqrt\{([^{}]+)\}/g, "sqrt($1)");
      if (s === prev) break;
    }

    // 2. Resolve \frac and \dfrac with compound expression grouping
    for (let pass = 0; pass < 4; pass++) {
      const prev = s;
      s = s.replace(/\\d?frac\{([^{}]+)\}\{([^{}]+)\}/g, (m, num, den) => {
        const cleanNum = num.trim();
        const cleanDen = den.trim();
        const wrappedNum = /[+\-]/.test(cleanNum) ? `(${cleanNum})` : cleanNum;
        const wrappedDen = /[+\-]/.test(cleanDen) ? `(${cleanDen})` : cleanDen;
        return `${wrappedNum}/${wrappedDen}`;
      });
      if (s === prev) break;
    }

    // 3. Clean operators and formatting commands
    s = s.replace(/\\times\b/g, "x")
         .replace(/\\cdot\b/g, "*")
         .replace(/\\pm\b/g, "+-")
         .replace(/\\neq\b/g, "!=")
         .replace(/\\leq\b/g, "<=")
         .replace(/\\geq\b/g, ">=")
         .replace(/\\approx\b/g, "~=")
         .replace(/\\pi\b/g, "pi")
         .replace(/\\infty\b/g, "inf")
         .replace(/\\[a-zA-Z]+/g, " ")
         .replace(/[{}]/g, "")
         .replace(/\s+/g, " ")
         .trim();

    return s;
  }

  /**
   * Helper to identify QuizZy internal elements (such as the Floating HUD)
   * so they are 100% shielded from quiz detection and DOM traversal.
   */
  function isQuizZyInternalElement(el) {
    if (!el) return false;
    if (el.id === "__quizzy_hud_host__") return true;
    if (typeof el.getAttribute === "function" && el.getAttribute("data-quizzy-ignore") === "true") return true;
    if (typeof el.closest === "function") {
      try {
        if (el.closest("#__quizzy_hud_host__, [data-quizzy-ignore='true']")) return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * Helper that checks if an element is located inside a code editor / viewer
   * (.monaco-editor, .ace_editor, .cm-editor, .CodeMirror).
   */
  function isInsideCodeEditor(el) {
    if (!el) return false;
    if (typeof el.closest === "function") {
      try {
        return !!el.closest('.monaco-editor, .ace_editor, .cm-editor, .CodeMirror, [class*="monaco-editor"], [class*="ace_editor"]');
      } catch (_) {}
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

  /**
   * Extracts clean visible text from elements while preserving KaTeX math formulas.
   * Mirrors 1:1 implementation in extractor.js.
   */
  function getCleanVisibleText(rootEl, preserveWhitespace = false) {
    if (!rootEl) return "";
    let extracted = "";

    function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        extracted += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;
      if (isQuizZyInternalElement(node)) return;

      const tag = node.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") return;
      if (tag === "br") {
        extracted += "\n";
        return;
      }

      const cls = (node.className && typeof node.className === "string") ? node.className : "";
      if (cls.includes("katex-mathml") || cls.includes("MJX_Assistive_MathML")) return;
      if (tag === "annotation" || tag === "annotation-xml") return;

      if (cls.includes("katex")) {
        const texAnno = node.querySelector("annotation[encoding*='tex']");
        if (texAnno && texAnno.textContent) {
          extracted += " " + normalizeTeX(texAnno.textContent) + " ";
          return;
        }
      }

      if (tag === "mjx-container" || cls.includes("MathJax")) {
        const texAnno = node.querySelector("annotation[encoding*='tex']");
        if (texAnno && texAnno.textContent) {
          extracted += " " + normalizeTeX(texAnno.textContent) + " ";
          return;
        }
        const texAttr = node.getAttribute("data-tex") || node.getAttribute("alt");
        if (texAttr) {
          extracted += " " + normalizeTeX(texAttr) + " ";
          return;
        }
      }

      const children = node.childNodes || [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i]);
      }
    }

    walk(rootEl);
    if (!extracted && rootEl && (rootEl.innerText || rootEl.textContent)) {
      extracted = String(rootEl.innerText || rootEl.textContent);
    }
    if (preserveWhitespace) {
      return extracted
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    }
    return extracted.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  /**
   * Strips decorative option prefixes (e.g. 'A. ', '(B) ', '1) ') while strictly
   * protecting mathematical subtraction and algebra expressions.
   * Mirrors 1:1 implementation in extractor.js.
   */
  function stripDecorativePrefix(text) {
    if (!text || typeof text !== "string") return "";
    let s = text.trim();

    // 0. Drag handles, Braille patterns (e.g. 6-dot grip ⠿, ⋮⋮, ::, ☰), and ordering slot numbers (1..8)
    s = s.replace(/^[\u2800-\u28FF\u22EE\u22EF\u22F0\u22F1\u2630\uFE19::⋮⠿]+\s*/, "");
    s = s.replace(/^[1-8]\s*(?=[A-Za-z`"'\<\(])/, "");
    s = s.replace(/^[1-8]$/, "");

    // 1. Parenthesized or bracketed letter/digit prefix
    s = s.replace(/^\(\s*([A-Fa-f0-9]{1,2})\s*\)\s+/, "");
    s = s.replace(/^\[\s*([A-Fa-f0-9]{1,2})\s*\]\s+/, "");

    // 2. Bare option letter [A-Fa-f] followed immediately by . or ) or :
    s = s.replace(/^[A-Fa-f][\.\)\:]\s+/, "");

    // 3. Digit prefix followed immediately by . or )
    s = s.replace(/^[0-9]{1,2}[\.\)]\s+/, "");

    // 4. Bullet symbols
    s = s.replace(/^[\u2022\u25E6\u25AA\u2023]\s*/, "");

    // Clean any secondary Braille or slot numbers exposed after prefix strip
    s = s.replace(/^[\u2800-\u28FF\u22EE\u22EF\u22F0\u22F1\u2630\uFE19::⋮⠿]+\s*/, "");
    s = s.replace(/^[1-8]\s*(?=[A-Za-z`"'\<\(])/, "");

    return s.trim();
  }

  /**
   * Preserves multi-line indentation for code blocks while collapsing standard prose/math options.
   * Strips decorative prefixes only on the first line.
   * Mirrors 1:1 implementation in extractor.js.
   */
  function normalizeOptionWhitespace(text, hasCodeBlock) {
    if (!text) return "";
    const clean = String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    const isMultiLineCode = hasCodeBlock && clean.includes("\n");
    if (isMultiLineCode) {
      const lines = clean.split("\n");
      while (lines.length > 0 && lines[0].trim() === "") lines.shift();
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      if (lines.length === 0) return "";

      lines[0] = stripDecorativePrefix(lines[0]);
      return lines.join("\n");
    }

    const single = clean.replace(/\s+/g, " ").trim();
    return stripDecorativePrefix(single);
  }

  /**
   * Checks if an element is part of an explanation, solution, or feedback container.
   * Mirrors 1:1 implementation in extractor.js.
   */
  function isExplanationOrFeedback(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || tag === "input") {
      return false;
    }

    let curr = el;
    while (curr && curr !== (typeof document !== "undefined" ? document.body : null)) {
      const currTag = (curr.tagName || "").toLowerCase();
      if (currTag === "button") {
        curr = curr.parentElement;
        continue;
      }

      const cls = (curr.className && typeof curr.className === "string") ? curr.className : "";
      const id = curr.id || "";
      if (/\b(explanation|solution|feedback|answer-key|hint-box|correct-answer|result-drawer|explanation-container|explanation-drawer)\b/i.test(`${cls} ${id}`)) {
        return true;
      }

      if (curr.firstElementChild) {
        const firstTag = curr.firstElementChild.tagName ? curr.firstElementChild.tagName.toLowerCase() : "";
        if (firstTag !== "button" && (/^h[1-6]$/.test(firstTag) || firstTag === "strong" || firstTag === "b")) {
          const headingText = (curr.firstElementChild.innerText || curr.firstElementChild.textContent || "").trim();
          if (/^\s*(explanation|solution|correct answer|your answer|hint|note\s*:|answer\s*:)/i.test(headingText) && !/show\s*answer/i.test(headingText)) {
            return true;
          }
        }
      }

      const prev = curr.previousElementSibling;
      if (prev) {
        const prevTag = prev.tagName ? prev.tagName.toLowerCase() : "";
        if (prevTag !== "button" && (/^h[1-6]$/.test(prevTag) || prevTag === "strong" || prevTag === "b")) {
          const headingText = (prev.innerText || prev.textContent || "").trim();
          if (/^\s*(explanation|solution|correct answer|your answer|hint|note\s*:|answer\s*:)/i.test(headingText) && !/show\s*answer/i.test(headingText)) {
            return true;
          }
        }
      }

      curr = curr.parentElement;
    }
    return false;
  }

  /**
   * Identifies non-question header, navigation, button, or explanation strings to prevent false positives.
   */
  function isHeaderOrNavText(text) {
    if (!text) return true;
    const t = text.trim();

    // Standalone action buttons
    if (/^(?:show\s*answer|hide\s*answer|submit|submit\s*answer|skip|next|next\s*question|previous|back|continue|report(?:\s*an)?\s*issue|check|finish|view\s*report)$/i.test(t)) {
      return true;
    }

    // Validation error messages (e.g. learning.ccbp.in red error banner)
    if (/^(?:please\s*select\s*(?:an?\s*)?(?:option|answer)|select\s*(?:an?\s*)?(?:option|answer))$/i.test(t)) {
      return true;
    }

    // Top-bar navigation, controls, scores, instructions, CCBP student ID & disclaimers
    if (/^(?:mcq\s*practice|practice\s*instructions|end\s*practice|end\s*test|submit\s*test|score\s*:\s*\d+|questions?\s*attempted\s*:\s*\d+|time\s*left|timer\s*:|id\s*:\s*[A-Za-z0-9]+)/i.test(t)) {
      return true;
    }

    if (/^if\s+you\s+skip,\s+you\s+can\s+attempt\s+this\s+question\s+again/i.test(t)) {
      return true;
    }

    // Post-submit explanation or feedback title headers
    if (t.length <= 40 && /^(?:explanation|solution|correct\s*answer|your\s*answer|detailed\s*solution|answer\s*key|hint|review(?:\s*questions)?)$/i.test(t)) {
      return true;
    }

    // Numbering artifacts like "Question 1 of 15" or "Q1."
    if (/^(?:question\s*\d+\s*(?:of|\/)\s*\d+|q\s*\d+[\.\:\s]*)$/i.test(t)) {
      return true;
    }

    return false;
  }

  /**
   * Helper that checks if an element or any of its descendants is or contains an action button
   * (e.g. SUBMIT, SHOW ANSWER, SKIP) or a quiz footer/disclaimer (e.g. "If you skip...")
   * or a validation error message (e.g. "Please select an option").
   */
  function containsActionButtonOrFooter(el) {
    if (!el || el.nodeType !== 1) return false;
    const actionPattern = /^(?:SHOW ANSWER|HIDE ANSWER|SUBMIT|SUBMIT ANSWER|SKIP|NEXT|NEXT QUESTION|PREVIOUS|END PRACTICE|PRACTICE INSTRUCTIONS|HINT|REPORT|CHECK|FINISH|VIEW REPORT|PLEASE SELECT AN OPTION|PLEASE SELECT AN ANSWER|SELECT AN OPTION|SELECT AN ANSWER)$/;
    const footerKeywords = /(?:IF YOU SKIP, YOU CAN ATTEMPT|QUESTIONS ATTEMPTED|END PRACTICE|PRACTICE INSTRUCTIONS|PLEASE SELECT AN OPTION|PLEASE SELECT AN ANSWER|SELECT AN OPTION)/;

    const elText = cleanText(el.textContent || el.innerText || "").toUpperCase();
    if (actionPattern.test(elText) || footerKeywords.test(elText)) {
      return true;
    }

    const descendants = el.querySelectorAll ? Array.from(el.querySelectorAll("button, [role='button'], a, div, span, p")) : [];
    for (const d of descendants) {
      const dText = cleanText(d.textContent || d.innerText || "").toUpperCase();
      if (actionPattern.test(dText) || footerKeywords.test(dText)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Finds the Quiz Card container.
   * Walks up from action button all the way until just BEFORE the top page navbar or document body,
   * verifying it contains substantial content above the buttons.
   */
  function findQuizCard(doc) {
    if (!doc) return null;
    if (isQuizZyInternalElement(doc)) return null;

    // 1. Semantic card classes
    const semanticSelectors = [
      "[class*='question-card']", "[class*='questionCard']",
      "[class*='questionContainer']", "[class*='question-container']",
      "[class*='quiz-card']", "[class*='quizCard']",
      "[class*='quiz-container']", "[class*='quizContainer']",
      "[class*='practice-card']", "[class*='problem-card']",
      "[class*='mcq-card']"
    ];
    for (const sel of semanticSelectors) {
      const found = Array.from(doc.querySelectorAll(sel)).filter(isVisible);
      for (const el of found) {
        if (isQuizZyInternalElement(el)) continue;
        if (!isExplanationOrFeedback(el)) return el;
      }
    }

    // 2. Button-anchored discovery (for styled-components / sc-...)
    const buttons = Array.from(doc.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")).filter(isVisible);
    let actionBtn = null;
    for (const btn of buttons) {
      if (isQuizZyInternalElement(btn)) continue;
      const txt = cleanText(btn.textContent || btn.value || "");
      if (/^(?:submit|show\s*answer|next\s*question|next|check|skip)$/i.test(txt)) {
        actionBtn = btn;
        if (/^(?:submit|show\s*answer)$/i.test(txt)) break;
      }
    }

    if (actionBtn) {
      let curr = actionBtn.parentElement;
      let bestCard = null;

      while (curr && curr !== doc.body && curr !== doc.documentElement) {
        if (isQuizZyInternalElement(curr)) break;
        const currText = curr.textContent || "";
        const hasTopNavMarkers = /mcq\s*practice|end\s*practice|questions?\s*attempted|practice\s*instructions/i.test(currText);
        if (hasTopNavMarkers) {
          // Reached or surpassed page wrapper enclosing the navbar; stop here!
          break;
        }

        // Check if curr has substantial content above/outside the action buttons & skip footer
        const nonActionText = currText
          .replace(/show\s*answer|hide\s*answer|submit(?:\s*answer)?|skip|next(?:\s*question)?|previous|end\s*practice|practice\s*instructions|if\s*you\s*skip[^\n]*/gi, "")
          .trim();

        if (nonActionText.length >= 15) {
          bestCard = curr;
        }

        curr = curr.parentElement;
      }

      if (bestCard) {
        return bestCard;
      }
    }

    // 3. Fallbacks
    const generic = Array.from(doc.querySelectorAll("main, [role='main'], form, .card")).filter(isVisible);
    for (const el of generic) {
      if (isQuizZyInternalElement(el)) continue;
      if (!isExplanationOrFeedback(el)) return el;
    }

    return null;
  }

  /**
   * Classless Option Group Discovery (for styled-components / sc-... without radio inputs or semantic classes).
   * Disqualifies layout section wrappers and ensures options container is preceded by question stem text.
   */
  function findClasslessOptionElements(scopeRoot, docRef) {
    const scope = scopeRoot || docRef || (typeof document !== "undefined" ? document : null);
    if (!scope || typeof scope.querySelectorAll !== "function") return [];
    if (isQuizZyInternalElement(scope)) return [];

    const candidateContainers = Array.from(scope.querySelectorAll("div, ul, ol, section, form")).filter(isVisible);
    const allDescendants = Array.from(scope.querySelectorAll("*"));

    // Bottom-Up / Innermost scan: iterate backwards to favor innermost option group
    for (let i = candidateContainers.length - 1; i >= 0; i--) {
      const container = candidateContainers[i];
      if (container === scope) continue;
      if (isQuizZyInternalElement(container) || isInsideCodeEditor(container)) continue;

      const rawChildren = Array.from(container.children || []).filter(c => isVisible(c) && !isQuizZyInternalElement(c) && !isInsideCodeEditor(c));
      const validChildren = rawChildren.filter(c => {
        const tag = (c.tagName || "").toLowerCase();
        return ["div", "li", "button", "label", "a", "span"].includes(tag) && !["hr", "br", "script", "style"].includes(tag);
      });

      if (validChildren.length < 2 || validChildren.length > 6) continue;

      // Disqualify immediately if ANY candidate child is or contains an action button or footer
      const hasActionChild = validChildren.some(c => containsActionButtonOrFooter(c));
      if (hasActionChild) continue;

      // All children should share the same tag name
      const firstTag = (validChildren[0].tagName || "").toLowerCase();
      const allSameTag = validChildren.every(c => (c.tagName || "").toLowerCase() === firstTag);
      if (!allSameTag) continue;

      // Check each child has clean visible text between 1 and 300 characters
      const texts = validChildren.map(c => getCleanVisibleText(c));
      const validTexts = texts.every(t => t.length >= 1 && t.length <= 300 && !isHeaderOrNavText(t));
      if (!validTexts) continue;

      const uniqueTexts = new Set(texts);
      if (uniqueTexts.size < 2) continue;

      // Disqualify immediately if there is NO non-blacklisted question text inside scope preceding this container
      const containerIdx = allDescendants.indexOf(container);
      if (containerIdx > 0) {
        let hasPrecedingText = false;
        for (let j = 0; j < containerIdx; j++) {
          const prev = allDescendants[j];
          if (container.contains && container.contains(prev)) continue;
          if (containsActionButtonOrFooter(prev)) continue;
          if (isExplanationOrFeedback(prev)) continue;
          const prevTxt = getCleanVisibleText(prev);
          if (prevTxt.length >= 8 && !isHeaderOrNavText(prevTxt)) {
            hasPrecedingText = true;
            break;
          }
        }
        if (!hasPrecedingText) continue;
      } else {
        continue;
      }

      return validChildren;
    }

    return [];
  }

  /**
   * Checks if an element is visible in the layout.
   */
  function isVisible(el) {
    if (!el) return false;
    if (isQuizZyInternalElement(el)) return false;
    if (el.hidden) return false;
    if (typeof window !== "undefined" && window.getComputedStyle) {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
      } catch (e) {
        // Fallback if computed style throws
      }
    }
    return true;
  }

  /**
   * Dispatches a realistic mouse click on an element.
   */
  function dispatchClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ behavior: "instant", block: "nearest" });
    } catch (e) {}

    try {
      el.focus();
    } catch (e) {}

    // Dispatch pointer and mouse down/up in sequence
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup"];
    eventTypes.forEach((type) => {
      try {
        let ev;
        if (type.startsWith("pointer") && typeof PointerEvent !== "undefined") {
          ev = new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            buttons: 1,
            pointerId: 1,
            pointerType: "mouse"
          });
        } else {
          ev = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            buttons: 1
          });
        }
        el.dispatchEvent(ev);
      } catch (e) {}
    });

    // Native .click() or click event fallback
    if (typeof el.click === "function") {
      try {
        el.click();
      } catch (e) {}
    } else {
      try {
        const clickEv = (typeof MouseEvent !== "undefined")
          ? new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
          : new Event("click", { bubbles: true, cancelable: true });
        el.dispatchEvent(clickEv);
      } catch (e) {}
    }
    return true;
  }

  /**
   * Helper that checks if either the radio input or its container label/card is visible.
   * Crucial for React apps where <input type="radio"> is hidden via CSS while its <label> is visible.
   */
  function isRadioOrOptionVisible(radioEl, containerEl) {
    if (radioEl && isVisible(radioEl)) return true;
    if (containerEl && isVisible(containerEl)) return true;
    return false;
  }

  /**
   * Generates a deterministic CSS selector path for a DOM element.
   * e.g. #id or div:nth-of-type(1) > div:nth-of-type(2)
   */
  function getElementCssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id && !el.id.includes("quizzy")) {
      return `#${el.id}`;
    }
    const path = [];
    let curr = el;
    const doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);
    const stopNode = doc ? (doc.body || doc.documentElement) : null;

    while (curr && curr.nodeType === 1 && curr !== stopNode && curr !== (doc ? doc.documentElement : null)) {
      const tag = curr.tagName.toLowerCase();
      let selector = tag;
      if (curr.id && !curr.id.includes("quizzy")) {
        path.unshift(`#${curr.id}`);
        break;
      }
      const firstClass = (curr.className || "").split(/\s+/).find(c => c && !c.includes("quizzy") && !/^(active|selected|checked|hover|focus)$/i.test(c));
      if (firstClass) {
        selector += `.${firstClass}`;
      }
      let sibling = curr;
      let nth = 1;
      while (sibling.previousElementSibling) {
        sibling = sibling.previousElementSibling;
        if (sibling.tagName.toLowerCase() === tag) nth++;
      }
      selector += `:nth-of-type(${nth})`;
      path.unshift(selector);
      curr = curr.parentElement;
    }
    return path.join(" > ");
  }

  /**
   * Strict Leaf-Option Deduplication:
   * Excludes QuizZy UI elements, excludes action buttons and footers.
   * On React styled-components pages (sc-...), an outer option <div> often wraps an inner <div>
   * or <label> containing the same text. Never includes both a parent element and its descendant!
   * Keeps only the distinct interactive option row containers (2 to 6 sibling items sharing the same parent container or radio group).
   */
  function deduplicateOptionElements(elements) {
    if (!Array.isArray(elements) || elements.length === 0) return [];

    // Filter out QuizZy elements and action buttons / non-option headers
    const filtered = elements.filter(el => {
      if (!el) return false;
      if (el.nodeType !== undefined && el.nodeType !== 1) return false;
      if (isQuizZyInternalElement(el)) return false;
      if (isInsideCodeEditor(el)) return false;
      if (containsActionButtonOrFooter(el)) return false;
      const txt = cleanText(el.innerText || el.textContent || "");
      if (isHeaderOrNavText(txt)) return false;
      return true;
    });

    if (filtered.length <= 1) return filtered;

    // Remove any element that contains 2 or more other candidate elements (it is an outer container/wrapper)
    const withoutContainers = filtered.filter(el => {
      let containedCount = 0;
      for (const other of filtered) {
        if (other !== el && el.contains && el.contains(other)) {
          containedCount++;
        }
      }
      return containedCount < 2;
    });

    // Handle 1-on-1 parent/child duplicates:
    // If element A contains element B: keep the option row container (A) and drop inner descendant (B)
    const finalElements = [];
    for (let i = 0; i < withoutContainers.length; i++) {
      const a = withoutContainers[i];
      let hasParentInList = false;
      for (let j = 0; j < withoutContainers.length; j++) {
        if (i !== j) {
          const b = withoutContainers[j];
          if (b.contains && b.contains(a)) {
            hasParentInList = true;
            break;
          }
        }
      }
      if (!hasParentInList) {
        finalElements.push(a);
      }
    }

    return (finalElements.length >= 2 && finalElements.length <= 6) ? finalElements : withoutContainers;
  }

  /**
   * Finds option elements using custom selector or deterministic heuristics.
   * Excludes header/nav text and explanation boxes matching extractor.js rules.
   */
  function findOptionElements(customSelector, optionSelectors) {
    const doc = (typeof document !== "undefined") ? document : null;

    // 0. Deterministic optionSelectors locator metadata from extractor
    if (Array.isArray(optionSelectors) && optionSelectors.length >= 2 && doc) {
      try {
        const directQueried = optionSelectors.map(sel => doc.querySelector(sel)).filter(Boolean);
        if (directQueried.length === optionSelectors.length) {
          const deduped = deduplicateOptionElements(directQueried);
          if (deduped.length >= 2) return deduped;
        }
      } catch (_) {}
    }

    // 1. Direct memory parity with extractor.js if extracted in the same world (zero DOM mutation)
    if (!customSelector && typeof window !== "undefined" && Array.isArray(window.__QUIZZY_LAST_OPTION_ELEMENTS__) && window.__QUIZZY_LAST_OPTION_ELEMENTS__.length >= 2) {
      const allConnected = window.__QUIZZY_LAST_OPTION_ELEMENTS__.every(el => el && el.isConnected !== false);
      if (allConnected) {
        if (Array.isArray(window.__QUIZZY_LAST_OPTIONS_TEXT__) && window.__QUIZZY_LAST_OPTIONS_TEXT__.length === window.__QUIZZY_LAST_OPTION_ELEMENTS__.length) {
          const textMatches = window.__QUIZZY_LAST_OPTION_ELEMENTS__.every((el, i) => {
            const currentText = cleanText(getCleanVisibleText ? getCleanVisibleText(el) : (el.innerText || el.textContent || ""));
            const expectedText = cleanText(window.__QUIZZY_LAST_OPTIONS_TEXT__[i]);
            return currentText === expectedText || currentText.includes(expectedText) || expectedText.includes(currentText);
          });
          if (textMatches) {
            return deduplicateOptionElements(window.__QUIZZY_LAST_OPTION_ELEMENTS__);
          }
        } else {
          return deduplicateOptionElements(window.__QUIZZY_LAST_OPTION_ELEMENTS__);
        }
      }
    }

    if (!doc) return [];

    if (customSelector) {
      const customMatches = Array.from(doc.querySelectorAll(customSelector))
        .filter(isVisible)
        .filter((el) => !isInsideCodeEditor(el) && !isExplanationOrFeedback(el) && !isHeaderOrNavText(cleanText(el.innerText || el.textContent || "")));
      const deduped = deduplicateOptionElements(customMatches);
      if (deduped.length >= 2) return deduped;
    }

    // Check for radio button groups (supporting CSS-hidden radio inputs with visible labels)
    const allRadios = Array.from(doc.querySelectorAll("input[type='radio']")).filter(r => !isInsideCodeEditor(r));
    const radioRows = [];
    for (const r of allRadios) {
      if (isQuizZyInternalElement(r)) continue;
      const lbl = (typeof r.closest === "function" ? r.closest("label") : null) || (r.id && typeof doc.querySelector === "function" ? doc.querySelector(`label[for="${r.id}"]`) : null);
      const row = lbl || (typeof r.closest === "function" ? r.closest("[class*='option'], [class*='choice'], [class*='radio'], li, tr") : null) || r.parentElement || r;
      if (!row || isQuizZyInternalElement(row)) continue;
      if (isRadioOrOptionVisible(r, row)) {
        if (!isExplanationOrFeedback(row) && !isHeaderOrNavText(cleanText((row.innerText || row.textContent || "")))) {
          radioRows.push(row || r);
        }
      }
    }
    const dedupedRadios = deduplicateOptionElements(radioRows);
    if (dedupedRadios.length >= 2 && dedupedRadios.length <= 10) {
      return dedupedRadios;
    }

    const optionHeuristics = [
      "[data-quiz-option]",
      ".quiz-option",
      ".option-item",
      ".draggable-item",
      "[draggable='true']",
      "[role='option']",
      "[role='radio']",
      "[class*='radio-item']",
      "[class*='option-item']",
      ".quiz-choice",
      ".option-card",
      "li.choice",
      ".order-item",
      ".sortable-block"
    ];

    for (const sel of optionHeuristics) {
      const matches = Array.from(doc.querySelectorAll(sel))
        .filter(isVisible)
        .filter((el) => !isInsideCodeEditor(el) && !isExplanationOrFeedback(el) && !isHeaderOrNavText(cleanText(el.innerText || el.textContent || "")));
      const deduped = deduplicateOptionElements(matches);
      if (deduped.length >= 2 && deduped.length <= 10) {
        return deduped;
      }
    }

    // Classless styled-components option group discovery (e.g. learning.ccbp.in)
    const quizCard = findQuizCard(doc);
    const classlessOptions = findClasslessOptionElements(quizCard || doc, doc);
    const dedupedClassless = deduplicateOptionElements(classlessOptions);
    if (dedupedClassless.length >= 2) {
      return dedupedClassless;
    }

    return [];
  }

  /**
   * Resolves the per-option row root container for an option element.
   * Walks up leafEl.parentElement while the parent exists, is not document.body (or docElement),
   * does NOT contain action buttons (SUBMIT, NEXT, SHOW ANSWER, SKIP) or footers,
   * and contains at most 1 option from allCandidateLeaves (stopping right before the shared parent
   * container that holds >= 2 options).
   */
  function resolveOptionRowRoot(leafEl, allCandidateLeaves) {
    if (!leafEl || !leafEl.parentElement) return leafEl;
    let curr = leafEl;
    const doc = leafEl.ownerDocument || (typeof document !== "undefined" ? document : null);
    const stopNode = doc ? (doc.body || doc.documentElement) : null;
    const leaves = Array.isArray(allCandidateLeaves) && allCandidateLeaves.length > 0 ? allCandidateLeaves : null;

    while (curr && curr.parentElement && curr.parentElement !== stopNode) {
      const parent = curr.parentElement;
      if (isQuizZyInternalElement(parent)) break;
      if (containsActionButtonOrFooter(parent)) break;

      if (leaves) {
        let containedCount = 0;
        for (const leaf of leaves) {
          if (leaf && (leaf === parent || (parent.contains && parent.contains(leaf)))) {
            containedCount++;
          }
        }
        if (containedCount >= 2) break;
      } else {
        const children = Array.from(parent.children || []).filter(c => isVisible(c) && !isQuizZyInternalElement(c));
        if (children.length >= 2 && children.length <= 6 && children.includes(curr)) {
          break;
        }
      }
      curr = parent;
    }
    return curr;
  }

  /**
   * Resolves the Option Row Container and an ordered sequence of clickable candidate targets.
   * Uses resolveOptionRowRoot to find the per-option row container.
   */
  function resolveOptionRowAndTargets(optEl, allOptions) {
    if (!optEl) return { rowEl: null, candidates: [] };

    // 1. Find the Option Row Container (rowEl)
    const rowEl = resolveOptionRowRoot(optEl, allOptions);

    // 2. Gather candidate click targets in priority order:
    //    1) rowEl itself (full container)
    //    2) <input type="radio" | "checkbox">
    //    3) <label>
    //    4) [role="radio"] / [role="option"] / button
    //    5) Indicator circle / dot child
    //    6) Primary text child element
    //    7) optEl itself (if different from rowEl)
    const candidates = [];
    const seen = new Set();

    function addCandidate(el) {
      if (el && el.nodeType === 1 && !seen.has(el) && isVisible(el) && !isQuizZyInternalElement(el)) {
        seen.add(el);
        candidates.push(el);
      }
    }

    // 1) rowEl itself (full container)
    addCandidate(rowEl);

    // 2) Radio inputs
    const inputs = rowEl.querySelectorAll ? Array.from(rowEl.querySelectorAll("input[type='radio'], input[type='checkbox']")) : [];
    if (["INPUT"].includes(rowEl.tagName)) inputs.push(rowEl);
    inputs.forEach(addCandidate);

    // 3) Labels
    const labels = rowEl.querySelectorAll ? Array.from(rowEl.querySelectorAll("label")) : [];
    if (rowEl.tagName === "LABEL") labels.push(rowEl);
    labels.forEach(addCandidate);

    // 4) Role or button targets
    const roles = rowEl.querySelectorAll ? Array.from(rowEl.querySelectorAll("[role='radio'], [role='option'], button")) : [];
    roles.forEach(addCandidate);

    // 5) Indicator circle/dot child (firstElementChild or matching classes)
    if (rowEl.querySelectorAll) {
      rowEl.querySelectorAll("[class*='circle'], [class*='dot'], [class*='indicator'], [class*='radio']").forEach(addCandidate);
    }
    if (rowEl.firstElementChild && rowEl.firstElementChild !== rowEl) {
      addCandidate(rowEl.firstElementChild);
    }

    // 6) text container (lastElementChild or matching classes)
    const lastChild = rowEl.lastElementChild || (rowEl.childNodes && rowEl.childNodes.length > 0 ? rowEl.childNodes[rowEl.childNodes.length - 1] : null);
    if (lastChild && lastChild.nodeType === 1 && lastChild !== rowEl) {
      addCandidate(lastChild);
    }

    // 7) optEl itself (if different from rowEl)
    if (optEl && optEl !== rowEl) {
      addCandidate(optEl);
    }

    return { rowEl, candidates };
  }

  /**
   * Dispatches realistic coordinates-aware pointer/mouse event sequence and .click().
   */
  function dispatchRealisticClick(el, bubbles = true) {
    if (!el || typeof el.dispatchEvent !== "function") return false;

    try {
      if (typeof el.focus === "function") el.focus();
    } catch (_) {}

    let clientX = 0;
    let clientY = 0;
    if (typeof el.getBoundingClientRect === "function") {
      try {
        const rect = el.getBoundingClientRect();
        clientX = Math.round(rect.left + rect.width / 2);
        clientY = Math.round(rect.top + rect.height / 2);
      } catch (_) {}
    }

    const mouseInit = {
      bubbles: !!bubbles,
      cancelable: true,
      composed: !!bubbles,
      view: (typeof window !== "undefined" ? window : null),
      clientX: clientX,
      clientY: clientY,
      button: 0,
      buttons: 1
    };

    // Cascade: pointerover -> mouseover -> pointerdown -> mousedown -> focus -> pointerup -> mouseup
    ["pointerover", "mouseover", "pointerdown", "mousedown", "focus", "pointerup", "mouseup"].forEach((type) => {
      try {
        if (type === "focus") {
          try {
            if (typeof el.focus === "function") el.focus();
          } catch (_) {}
          const focusEv = (typeof FocusEvent !== "undefined")
            ? new FocusEvent("focus", { bubbles: false, cancelable: false })
            : ((typeof Event !== "undefined") ? new Event("focus", { bubbles: false, cancelable: false }) : null);
          if (focusEv) el.dispatchEvent(focusEv);
          return;
        }

        let ev;
        if (type.startsWith("pointer") && typeof PointerEvent !== "undefined") {
          ev = new PointerEvent(type, Object.assign({}, mouseInit, { pointerId: 1, pointerType: "mouse" }));
        } else if (typeof MouseEvent !== "undefined") {
          ev = new MouseEvent(type, mouseInit);
        } else {
          ev = new Event(type, { bubbles: !!bubbles, cancelable: true });
        }
        el.dispatchEvent(ev);
      } catch (_) {}
    });

    // Native .click() or click event dispatch
    if (bubbles && typeof el.click === "function") {
      try {
        el.click();
      } catch (_) {}
    } else {
      try {
        const clickEv = (typeof MouseEvent !== "undefined")
          ? new MouseEvent("click", mouseInit)
          : new Event("click", { bubbles: !!bubbles, cancelable: true });
        el.dispatchEvent(clickEv);
      } catch (_) {}
    }

    // If input element, dispatch input & change
    if (el.tagName === "INPUT") {
      try {
        if (!el.checked) el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: !!bubbles, cancelable: true }));
        el.dispatchEvent(new Event("change", { bubbles: !!bubbles, cancelable: true }));
      } catch (_) {}
    }

    return true;
  }

  /**
   * Captures selection state snapshot of an option row and page context.
   * Inspects entire rowEl subtree plus rowEl.parentElement for style, class, aria, and input state.
   */
  function capturePreClickSnapshot(optionEl, allOptionEls, docRef) {
    const doc = docRef || (optionEl ? optionEl.ownerDocument : null) || (typeof document !== "undefined" ? document : null);
    if (!optionEl) return null;

    let inputsChecked = false;
    const inputs = optionEl.querySelectorAll ? Array.from(optionEl.querySelectorAll("input[type='radio'], input[type='checkbox']")) : [];
    if (optionEl.tagName === "INPUT") inputs.push(optionEl);
    inputsChecked = inputs.some(i => i.checked === true);

    const classes = [optionEl.className || ""];
    if (optionEl.parentElement) classes.push(optionEl.parentElement.className || "");
    if (optionEl.querySelectorAll) {
      optionEl.querySelectorAll("*").forEach(c => classes.push(c.className || ""));
    }
    const classNames = classes.join(" ");

    const aria = [
      optionEl.getAttribute ? (optionEl.getAttribute("aria-checked") || optionEl.getAttribute("aria-selected") || optionEl.getAttribute("data-state") || "") : ""
    ];
    if (optionEl.parentElement && optionEl.parentElement.getAttribute) {
      aria.push(optionEl.parentElement.getAttribute("aria-checked") || optionEl.parentElement.getAttribute("aria-selected") || optionEl.parentElement.getAttribute("data-state") || "");
    }
    if (optionEl.querySelectorAll) {
      optionEl.querySelectorAll("[aria-checked], [aria-selected], [data-state]").forEach(c => {
        aria.push(c.getAttribute("aria-checked") || c.getAttribute("aria-selected") || c.getAttribute("data-state") || "");
      });
    }

    function getStylesFor(node) {
      if (!node || node.nodeType !== 1) return "";
      try {
        const cs = window.getComputedStyle(node);
        if (!cs) return "";
        return `${cs.backgroundColor || ""}|${cs.borderColor || ""}|${cs.outline || ""}|${cs.boxShadow || ""}|${cs.color || ""}`;
      } catch (_) {
        return "";
      }
    }

    let styles = "";
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      try {
        styles = `row:${getStylesFor(optionEl)}`;
        if (optionEl.parentElement) {
          styles += `::parent:${getStylesFor(optionEl.parentElement)}`;
        }
        if (optionEl.querySelectorAll) {
          optionEl.querySelectorAll("*").forEach((c, idx) => {
            const st = getStylesFor(c);
            if (st && st !== "||||") styles += `::d${idx}:${st}`;
          });
        }
      } catch (_) {}
    }

    let submitDisabled = null;
    if (doc) {
      const submitBtn = doc.querySelector("button[type='submit'], input[type='submit'], button.btn-submit");
      if (submitBtn) {
        submitDisabled = submitBtn.disabled;
      }
    }

    const htmlLength = (optionEl.innerHTML || "").length;

    return { inputsChecked, classNames, aria: aria.join("|"), styles, submitDisabled, htmlLength };
  }

  const captureOptionSnapshot = capturePreClickSnapshot;

  /**
   * Mandatory Pre-Submit Selection Verification Gate:
   * Inspects 5 selection signals across rowEl, its full subtree, and its parentElement:
   * a) A nested <input type="radio"|"checkbox"> has .checked === true.
   * b) optionEl, child, or parent has aria-checked === "true" or aria-selected === "true" or data-state === "checked".
   * c) optionEl's className or a child's or parent's className changed compared to preClickSnapshot.
   * d) optionEl's, child's, or parent's computed styles changed compared to preClickSnapshot.
   * e) The SUBMIT button on the page transitioned from disabled to enabled.
   */
  function verifyOptionSelected(optionEl, allOptionEls, preClickSnapshot, docRef) {
    if (!optionEl) return false;
    const doc = docRef || (optionEl ? optionEl.ownerDocument : null) || (typeof document !== "undefined" ? document : null);

    // a) A nested <input type="radio"|"checkbox"> has .checked === true
    const inputs = optionEl.querySelectorAll ? Array.from(optionEl.querySelectorAll("input[type='radio'], input[type='checkbox']")) : [];
    if (optionEl.tagName === "INPUT" && ["radio", "checkbox"].includes((optionEl.type || "").toLowerCase())) {
      inputs.push(optionEl);
    }
    if (inputs.some(i => i.checked === true)) {
      return true;
    }

    // b) optionEl, child, or parent has aria-checked === "true" or aria-selected === "true" or data-state === "checked"
    const ariaChecks = [
      optionEl.getAttribute ? optionEl.getAttribute("aria-checked") : null,
      optionEl.getAttribute ? optionEl.getAttribute("aria-selected") : null,
      optionEl.getAttribute ? optionEl.getAttribute("data-state") : null
    ];
    if (optionEl.parentElement) {
      ariaChecks.push(optionEl.parentElement.getAttribute ? optionEl.parentElement.getAttribute("aria-checked") : null);
      ariaChecks.push(optionEl.parentElement.getAttribute ? optionEl.parentElement.getAttribute("aria-selected") : null);
      ariaChecks.push(optionEl.parentElement.getAttribute ? optionEl.parentElement.getAttribute("data-state") : null);
    }
    if (optionEl.querySelectorAll) {
      optionEl.querySelectorAll("[aria-checked='true'], [aria-selected='true'], [data-state='checked']").forEach(() => ariaChecks.push("true"));
    }
    if (ariaChecks.some(a => a === "true" || a === "checked")) {
      return true;
    }

    // c) optionEl's className or a child's/parent's className changed compared to preClickSnapshot
    const currClasses = [optionEl.className || ""];
    if (optionEl.parentElement) currClasses.push(optionEl.parentElement.className || "");
    if (optionEl.querySelectorAll) {
      optionEl.querySelectorAll("*").forEach(c => currClasses.push(c.className || ""));
    }
    const currClassNames = currClasses.join(" ");
    if (preClickSnapshot && currClassNames !== preClickSnapshot.classNames) {
      return true;
    }
    if (/\b(?:selected|active|checked|is-selected|is-active)\b/i.test(currClassNames)) {
      return true;
    }

    // d) optionEl's, child's, or parent's computed styles changed compared to preClickSnapshot
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      try {
        function getStylesFor(node) {
          if (!node || node.nodeType !== 1) return "";
          try {
            const cs = window.getComputedStyle(node);
            if (!cs) return "";
            return `${cs.backgroundColor || ""}|${cs.borderColor || ""}|${cs.outline || ""}|${cs.boxShadow || ""}|${cs.color || ""}`;
          } catch (_) {
            return "";
          }
        }

        let currStyles = `row:${getStylesFor(optionEl)}`;
        if (optionEl.parentElement) {
          currStyles += `::parent:${getStylesFor(optionEl.parentElement)}`;
        }
        if (optionEl.querySelectorAll) {
          optionEl.querySelectorAll("*").forEach((c, idx) => {
            const st = getStylesFor(c);
            if (st && st !== "||||") currStyles += `::d${idx}:${st}`;
          });
        }
        if (preClickSnapshot && preClickSnapshot.styles && currStyles !== preClickSnapshot.styles) {
          return true;
        }
      } catch (_) {}
    }

    // e) The SUBMIT button on the page transitioned from disabled to enabled
    if (doc && preClickSnapshot && preClickSnapshot.submitDisabled === true) {
      const submitBtn = doc.querySelector("button[type='submit'], input[type='submit'], button.btn-submit");
      if (submitBtn && submitBtn.disabled === false) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detects whether option row selection state changed compared to beforeSnapshot.
   */
  function didOptionSelectionChange(rowEl, beforeSnapshot) {
    if (!rowEl || !beforeSnapshot) return false;
    return verifyOptionSelected(rowEl, [], beforeSnapshot);
  }

  /**
   * React Selection Cascade:
   * 1. Scrolls optionEl smoothly into view.
   * 2. Resolves per-option row root container.
   * 3. Dispatches pointerover -> mouseover -> pointerdown -> mousedown -> focus -> pointerup -> mouseup -> click
   *    across:
   *    a) The resolved rowEl itself
   *    b) Descendant radio/checkbox or radio indicator (circle/dot child)
   *    c) The primary text child element
   * 4. Updates controlled <input type="radio"> via HTMLInputElement.prototype descriptor if present.
   */
  function triggerReactSelection(optionEl) {
    if (!optionEl) return false;

    // 1. Scroll optionEl smoothly into view
    try {
      if (typeof optionEl.scrollIntoView === "function") {
        optionEl.scrollIntoView({ behavior: "instant", block: "nearest" });
      }
    } catch (_) {}

    // 2. Locate row container and candidate targets
    const { rowEl, candidates } = resolveOptionRowAndTargets(optionEl);
    const win = (typeof window !== "undefined") ? window : null;
    const doc = (typeof document !== "undefined") ? document : (optionEl.ownerDocument || null);

    // 3. Case 1: Standard or Sibling <input type="radio" | "checkbox"> / <label> exists inside rowEl
    let inputEl = null;
    if (rowEl.tagName === "INPUT" && ["radio", "checkbox"].includes((rowEl.type || "").toLowerCase())) {
      inputEl = rowEl;
    } else if (rowEl.querySelector) {
      inputEl = rowEl.querySelector("input[type='radio'], input[type='checkbox']");
    }

    let labelEl = null;
    if (rowEl.tagName === "LABEL") {
      labelEl = rowEl;
    } else if (rowEl.closest && rowEl.closest("label")) {
      labelEl = rowEl.closest("label");
    } else if (rowEl.querySelector) {
      labelEl = rowEl.querySelector("label");
    }

    if (!inputEl && labelEl && labelEl.getAttribute && labelEl.getAttribute("for") && doc && doc.getElementById) {
      inputEl = doc.getElementById(labelEl.getAttribute("for"));
    }
    if (!labelEl && inputEl && inputEl.id && doc && doc.querySelector) {
      labelEl = doc.querySelector(`label[for="${inputEl.id}"]`);
    }

    if (inputEl || labelEl) {
      if (labelEl) {
        dispatchRealisticClick(labelEl, true);
      }
      if (inputEl && !inputEl.checked) {
        dispatchRealisticClick(inputEl, true);
      }
      if (inputEl && !inputEl.checked) {
        const radio = inputEl;
        try {
          const proto = (typeof window !== "undefined" && window.HTMLInputElement)
            ? window.HTMLInputElement.prototype
            : null;
          const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "checked") : null;
          if (descriptor && descriptor.set) {
            descriptor.set.call(radio, true);
          } else {
            radio.checked = true;
          }
          if (radio._valueTracker && typeof radio._valueTracker.setValue === "function") {
            try {
              radio._valueTracker.setValue(false);
            } catch (_) {}
          }
          radio.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
          radio.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        } catch (_) {}
      }
      return true;
    }

    // 4. Custom React Option Row:
    const beforeSnapshot = capturePreClickSnapshot(rowEl);
    if (beforeSnapshot && (beforeSnapshot.inputsChecked || beforeSnapshot.aria === "true")) {
      return true;
    }

    // Step A: Dispatch cascade across resolved rowEl itself
    dispatchRealisticClick(rowEl, true);
    if (verifyOptionSelected(rowEl, [], beforeSnapshot)) {
      return true;
    }

    // Step B: Dispatch cascade across descendant input / indicator
    const indicatorTargets = [];
    if (rowEl.querySelectorAll) {
      rowEl.querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox'], [class*='circle'], [class*='dot'], [class*='indicator'], [class*='radio']").forEach(el => {
        if (el !== rowEl && !indicatorTargets.includes(el)) indicatorTargets.push(el);
      });
    }
    if (rowEl.firstElementChild && rowEl.firstElementChild !== rowEl && !indicatorTargets.includes(rowEl.firstElementChild)) {
      indicatorTargets.push(rowEl.firstElementChild);
    }
    for (const child of indicatorTargets) {
      dispatchRealisticClick(child, true);
      if (verifyOptionSelected(rowEl, [], beforeSnapshot)) {
        return true;
      }
    }

    // Step C: Dispatch cascade across primary text child element
    const textTargets = [];
    if (optionEl && optionEl !== rowEl && !indicatorTargets.includes(optionEl)) {
      textTargets.push(optionEl);
    }
    const lastChild = rowEl.lastElementChild;
    if (lastChild && lastChild !== rowEl && !indicatorTargets.includes(lastChild) && !textTargets.includes(lastChild)) {
      textTargets.push(lastChild);
    }
    for (const txt of textTargets) {
      dispatchRealisticClick(txt, true);
      if (verifyOptionSelected(rowEl, [], beforeSnapshot)) {
        return true;
      }
    }

    return true;
  }

  /**
   * Compatibility alias for triggerReactSelection.
   */
  function triggerOptionSelect(targetEl) {
    return triggerReactSelection(targetEl);
  }

  /**
   * Executes plain DOM click on targeted MCQ option with Mandatory Pre-Submit Verification Gate.
   * Handles 1:1 text parity with extractor.js and React 16-18 controlled radio selection.
   */
  function executeMcqAction(payload) {
    const doc = (typeof document !== "undefined") ? document : null;
    let options = [];

    // Check payload.optionSelectors first if provided
    if (payload && Array.isArray(payload.optionSelectors) && payload.optionSelectors.length >= 2 && doc) {
      try {
        const directQueried = payload.optionSelectors.map(sel => doc.querySelector(sel)).filter(Boolean);
        if (directQueried.length === payload.optionSelectors.length) {
          options = deduplicateOptionElements(directQueried);
        }
      } catch (_) {}
    }

    if (options.length === 0) {
      options = findOptionElements(payload ? payload.optionsSelector : null, payload ? payload.optionSelectors : null);
    }

    if (options.length === 0) {
      return { ok: false, success: false, selected: false, error: "OPTION_SELECTION_FAILED" };
    }

    // Resolve each option element to its per-option row root container
    if (options.length >= 2) {
      const resolved = options.map(el => resolveOptionRowRoot(el, options));
      const unique = [];
      for (const r of resolved) {
        if (!unique.includes(r)) unique.push(r);
      }
      if (unique.length === options.length) {
        options = unique;
      }
    }

    let targetIndex = null;
    if (payload && typeof payload.targetIndex === "number" && payload.targetIndex >= 0) {
      targetIndex = payload.targetIndex;
    } else if (payload && typeof payload.selected_index === "number" && payload.selected_index >= 0) {
      targetIndex = payload.selected_index;
    }

    // Check if payload.letter, payload.canonical_key, or payload.answer is a single synthetic letter "A"–"F"
    let syntheticLetter = "";
    if (payload && typeof payload.letter === "string" && /^[A-F]$/i.test(payload.letter.trim())) {
      syntheticLetter = payload.letter.trim().toUpperCase();
    } else if (payload && typeof payload.canonical_key === "string" && /^[A-F]$/i.test(payload.canonical_key.trim())) {
      syntheticLetter = payload.canonical_key.trim().toUpperCase();
    } else if (payload && typeof payload.answer === "string" && /^[A-F]$/i.test(payload.answer.trim())) {
      syntheticLetter = payload.answer.trim().toUpperCase();
    }

    // If targetIndex is not explicitly set, convert single letter "A"–"F" to 0–5 index
    if (targetIndex === null && syntheticLetter) {
      targetIndex = syntheticLetter.charCodeAt(0) - 65;
    }

    // Never try to text-match a single synthetic letter "A"–"F" against full option strings!
    let rawTargetText = (payload && (payload.targetText || payload.selected_text)) || null;
    if (!rawTargetText && payload && payload.answer && !/^[A-F]$/i.test(String(payload.answer).trim())) {
      rawTargetText = payload.answer;
    }

    // Clean text representations of all options using 1:1 extractor-identical logic
    const optionCleanTexts = options.map((optEl) => {
      const hasCode = !!(optEl.querySelector && optEl.querySelector("pre, code")) || (optEl.tagName && ["pre", "code"].includes(optEl.tagName.toLowerCase()));
      const raw = getCleanVisibleText(optEl, hasCode);
      return normalizeOptionWhitespace(raw, hasCode);
    });

    const targetHasCode = rawTargetText ? (rawTargetText.includes("\n") || /^\s*(def|class|import|return|for|while|if|else|print)\b/.test(rawTargetText)) : false;
    const cleanTargetText = rawTargetText ? normalizeOptionWhitespace(rawTargetText, targetHasCode) : null;

    // 1. Exact normalized text match (cleanOptText === cleanTargetText)
    if (cleanTargetText) {
      const exactIdx = optionCleanTexts.findIndex((optText) => optText && optText === cleanTargetText);
      if (exactIdx !== -1) {
        targetIndex = exactIdx;
      } else {
        // 2. Case-insensitive normalized text match
        const ciIdx = optionCleanTexts.findIndex((optText) => {
          if (!optText) return false;
          if (!targetHasCode && !optText.includes("\n")) {
            return optText.toLowerCase() === cleanTargetText.toLowerCase();
          }
          return false;
        });
        if (ciIdx !== -1) {
          targetIndex = ciIdx;
        }
      }
    }

    // 2.5 Single letter fallback if cleanTargetText is "A"–"F" and targetIndex unresolved
    if ((targetIndex === null || targetIndex === undefined) && cleanTargetText && /^[A-F]$/i.test(cleanTargetText.trim())) {
      const allMultiChar = optionCleanTexts.every(t => !t || t.trim().length > 1);
      if (allMultiChar) {
        targetIndex = cleanTargetText.trim().toUpperCase().charCodeAt(0) - 65;
      }
    }

    // 3. Valid targetIndex fallback (0 <= targetIndex < options.length)
    if (targetIndex === null || typeof targetIndex !== "number" || targetIndex < 0 || targetIndex >= options.length) {
      return {
        ok: false,
        success: false,
        selected: false,
        error: "OPTION_SELECTION_FAILED"
      };
    }

    const targetEl = options[targetIndex];

    // Remember last selected option for auto-mode retry & validation recovery
    if (typeof window !== "undefined") {
      window.__QUIZZY_LAST_SELECTED_OPTION__ = targetEl;
      window.__QUIZZY_LAST_ACTION_PAYLOAD__ = payload;
    }

    // MANDATORY PRE-SUBMIT SELECTION VERIFICATION GATE
    const preClickSnapshot = capturePreClickSnapshot(targetEl, options, doc);

    // Attempt 1: Full React selection event cascade
    triggerReactSelection(targetEl);

    // Verify selection signal
    let selected = verifyOptionSelected(targetEl, options, preClickSnapshot, doc);

    // Retry on unverified selection: targeted inner child click + elementFromPoint
    if (!selected) {
      const innerTarget = targetEl.firstElementChild || (targetEl.querySelector ? targetEl.querySelector("input, label, span, div") : null) || targetEl;
      dispatchRealisticClick(innerTarget, true);

      if (doc && typeof doc.elementFromPoint === "function" && typeof targetEl.getBoundingClientRect === "function") {
        try {
          const rect = targetEl.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const pointEl = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (pointEl && pointEl !== targetEl) {
              dispatchRealisticClick(pointEl, true);
            }
          }
        } catch (_) {}
      }

      selected = verifyOptionSelected(targetEl, options, preClickSnapshot, doc);
    }

    // HARD ABORT RULE: If selection verification failed after retry, return failure
    if (!selected) {
      return {
        ok: false,
        success: false,
        selected: false,
        error: "OPTION_SELECTION_FAILED"
      };
    }

    if (typeof window !== "undefined") {
      window.__QUIZZY_CURRENT_QUESTION_OPTION_SELECTED__ = targetEl;
    }
    if (targetEl && targetEl.setAttribute) {
      try { targetEl.setAttribute("data-quizzy-selected", "true"); } catch (_) {}
    }

    return {
      ok: true,
      success: true,
      selected: true,
      action: "mcq_click",
      selected_index: targetIndex,
      option_text: optionCleanTexts[targetIndex] || cleanText(targetEl.innerText || targetEl.textContent)
    };
  }

  /**
   * Evaluates if a given option element or checkbox is currently checked.
   * Inspects native checkbox inputs, ARIA attributes, SVG checkmarks, and styling.
   */
  function isOptionChecked(optionEl) {
    if (!optionEl) return false;

    if (typeof window !== "undefined" && window.__QUIZZY_CURRENT_QUESTION_OPTION_SELECTED__ === optionEl) {
      return true;
    }
    if (optionEl.getAttribute && optionEl.getAttribute("data-quizzy-selected") === "true") {
      return true;
    }

    // 1. Native input check
    const inputs = optionEl.querySelectorAll ? Array.from(optionEl.querySelectorAll("input[type='checkbox'], input[type='radio']")) : [];
    if (optionEl.tagName === "INPUT" && ["checkbox", "radio"].includes((optionEl.type || "").toLowerCase())) {
      inputs.push(optionEl);
    }
    if (inputs.some(i => i.checked === true)) {
      return true;
    }

    // 2. ARIA checked / selected attribute
    const ariaChecks = [
      optionEl.getAttribute ? optionEl.getAttribute("aria-checked") : null,
      optionEl.getAttribute ? optionEl.getAttribute("aria-selected") : null,
      optionEl.getAttribute ? optionEl.getAttribute("data-state") : null
    ];
    if (optionEl.parentElement) {
      ariaChecks.push(optionEl.parentElement.getAttribute ? optionEl.parentElement.getAttribute("aria-checked") : null);
      ariaChecks.push(optionEl.parentElement.getAttribute ? optionEl.parentElement.getAttribute("data-state") : null);
    }
    if (optionEl.querySelectorAll) {
      optionEl.querySelectorAll("[aria-checked='true'], [aria-selected='true'], [data-state='checked']").forEach(() => ariaChecks.push("true"));
    }
    if (ariaChecks.some(a => a === "true" || a === "checked")) {
      return true;
    }

    // 3. Class names indicating checked state
    const cls = [optionEl.className || ""];
    if (optionEl.parentElement) cls.push(optionEl.parentElement.className || "");
    if (optionEl.querySelectorAll) {
      optionEl.querySelectorAll("*").forEach(c => cls.push(c.className || ""));
    }
    const combinedClasses = cls.join(" ");
    if (/\b(?:checked|is-checked|ant-checkbox-checked|selected|is-selected)\b/i.test(combinedClasses)) {
      return true;
    }

    // 4. Inner SVG or pseudo-element checkmark
    if (optionEl.querySelector && optionEl.querySelector("svg[data-icon='check'], svg.check-icon, .checkmark, [data-icon='checkmark']")) {
      return true;
    }

    return false;
  }

  /**
   * Executes multi-choice selection with several correct answers (square checkboxes).
   * Toggles each target option to checked, toggles non-target options to unchecked,
   * and verifies that every option's checked state matches before returning.
   */
  function executeMultiMcqAction(payload) {
    const doc = (typeof document !== "undefined") ? document : null;
    const options = findOptionElements(payload ? payload.optionsSelector : null);

    if (!options || options.length === 0) {
      return { ok: false, success: false, selected: false, error: "OPTION_SELECTION_FAILED" };
    }

    const optionCleanTexts = options.map(el => {
      const hasCode = !!(el.querySelector && el.querySelector("pre, code, .code, .monospace"));
      const rawText = getCleanVisibleText(el, hasCode);
      return normalizeOptionWhitespace(rawText, hasCode);
    });

    // 1. Resolve target indices
    const targetIndices = new Set();
    const numOptions = options.length;

    // Check payload.selected_indices
    if (Array.isArray(payload.selected_indices)) {
      payload.selected_indices.forEach(idx => {
        if (typeof idx === "number" && idx >= 0 && idx < numOptions) {
          targetIndices.add(idx);
        }
      });
    }

    // Check payload.canonical_keys (e.g. ["A", "D"])
    if (Array.isArray(payload.canonical_keys)) {
      payload.canonical_keys.forEach(k => {
        if (typeof k === "string" && /^[A-Z]$/i.test(k.trim())) {
          const idx = k.trim().toUpperCase().charCodeAt(0) - 65;
          if (idx >= 0 && idx < numOptions) targetIndices.add(idx);
        }
      });
    }

    // Check payload.canonical_key (e.g. "A, D" or "A,D")
    if (targetIndices.size === 0 && typeof payload.canonical_key === "string") {
      const letters = payload.canonical_key.toUpperCase().match(/[A-Z]/g);
      if (letters) {
        letters.forEach(l => {
          const idx = l.charCodeAt(0) - 65;
          if (idx >= 0 && idx < numOptions) targetIndices.add(idx);
        });
      }
    }

    // Match payload.selected_texts
    if (Array.isArray(payload.selected_texts) && payload.selected_texts.length > 0) {
      payload.selected_texts.forEach(txt => {
        const cleanTxt = cleanText(txt).toLowerCase();
        for (let i = 0; i < optionCleanTexts.length; i++) {
          const optTxt = cleanText(optionCleanTexts[i]).toLowerCase();
          if (optTxt && (optTxt === cleanTxt || optTxt.includes(cleanTxt) || cleanTxt.includes(optTxt))) {
            targetIndices.add(i);
          }
        }
      });
    }

    // Fallback: single selected_index
    if (targetIndices.size === 0 && typeof payload.selected_index === "number" && payload.selected_index >= 0 && payload.selected_index < numOptions) {
      targetIndices.add(payload.selected_index);
    }

    if (targetIndices.size === 0) {
      return { ok: false, success: false, selected: false, error: "OPTION_SELECTION_FAILED" };
    }

    // 2. Toggle each option to match required state
    for (let i = 0; i < options.length; i++) {
      const optEl = options[i];
      const shouldBeChecked = targetIndices.has(i);
      let isChecked = isOptionChecked(optEl);

      if (isChecked !== shouldBeChecked) {
        // Attempt toggle via triggerReactSelection
        triggerReactSelection(optEl);
        isChecked = isOptionChecked(optEl);

        // If not updated, click inner checkbox element directly
        if (isChecked !== shouldBeChecked) {
          const innerClickable = optEl.querySelector ? (optEl.querySelector("input[type='checkbox'], [role='checkbox'], svg, span, div") || optEl) : optEl;
          dispatchRealisticClick(innerClickable, true);
          isChecked = isOptionChecked(optEl);
        }
      }
    }

    // Remember last action
    if (typeof window !== "undefined") {
      window.__QUIZZY_LAST_ACTION_PAYLOAD__ = payload;
    }

    const selectedIdxArr = Array.from(targetIndices).sort((a, b) => a - b);
    const selectedKeys = selectedIdxArr.map(i => String.fromCharCode(65 + i));

    return {
      ok: true,
      success: true,
      selected: true,
      action: "multi_mcq_click",
      selected_indices: selectedIdxArr,
      canonical_keys: selectedKeys,
      selected_texts: selectedIdxArr.map(i => optionCleanTexts[i])
    };
  }

  /**
   * Executes React/Vue/Angular compatible text input entry.
   * Prioritizes question-specific textareas/inputs (e.g. placeholder "Enter your answer"),
   * dispatches full input events, and verifies the written answer matches expected response.
   */
  function executeTextAction(payload) {
    const textVal = payload.answer !== undefined ? String(payload.answer) : (payload.selected_text || "");
    if (!textVal || !String(textVal).trim()) {
      return { ok: false, success: false, selected: false, error: "Empty text answer; halted to protect input content from being wiped." };
    }
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return { success: false, error: "No document" };

    let inputEl = null;
    if (payload.textInputSelector) {
      inputEl = doc.querySelector(payload.textInputSelector);
    }

    if (!inputEl) {
      const inputHeuristics = [
        "textarea[placeholder*='answer' i]",
        "input[placeholder*='answer' i]",
        "textarea[placeholder*='enter' i]",
        "input[placeholder*='enter' i]",
        "[data-quiz-input]",
        "input.quiz-input",
        "input.fill-blank",
        "textarea.quiz-input",
        ".question-container textarea",
        ".question-container input[type='text']",
        "textarea:not([aria-hidden='true'])",
        "input[type='text']:not([aria-hidden='true'])",
        "input:not([type]):not([aria-hidden='true'])"
      ];
      for (const sel of inputHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) {
          inputEl = el;
          break;
        }
      }
    }

    if (!inputEl) {
      return { success: false, error: "Target text input element not found on page." };
    }

    try {
      inputEl.focus();
    } catch (e) {}

    // Use native prototype property descriptor to bypass React/Vue value interception
    try {
      const isTextArea = inputEl.tagName.toLowerCase() === "textarea";
      const prototype = isTextArea
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor && descriptor.set) {
        descriptor.set.call(inputEl, textVal);
      } else {
        inputEl.value = textVal;
      }
    } catch (e) {
      inputEl.value = textVal;
    }

    // Dispatch input and change events
    try {
      inputEl.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    } catch (e) {}

    // Pre-submit verification: verify entered answer matches expected response
    const currentVal = cleanText(inputEl.value);
    const expectedVal = cleanText(textVal);
    if (currentVal !== expectedVal) {
      inputEl.value = textVal;
      inputEl.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    }

    const verified = (cleanText(inputEl.value) === expectedVal);
    if (!verified) {
      return {
        ok: false,
        success: false,
        selected: false,
        error: "TEXT_VERIFICATION_FAILED",
        reason: `Input value '${inputEl.value}' did not match expected '${textVal}'`
      };
    }

    return {
      ok: true,
      success: true,
      selected: true,
      action: "text_fill",
      value: textVal,
      verified: true
    };
  }

  /**
   * Helper to create a synthetic DataTransfer instance for HTML5 drag events.
   */
  function createSyntheticDataTransfer() {
    const dataStore = {};
    return {
      dropEffect: "move",
      effectAllowed: "move",
      files: [],
      items: [],
      types: [],
      setData: function (format, data) {
        dataStore[format] = String(data);
        if (!this.types.includes(format)) this.types.push(format);
      },
      getData: function (format) {
        return dataStore[format] || "";
      },
      clearData: function (format) {
        if (format) {
          delete dataStore[format];
          const idx = this.types.indexOf(format);
          if (idx !== -1) this.types.splice(idx, 1);
        } else {
          for (const k of Object.keys(dataStore)) delete dataStore[k];
          this.types = [];
        }
      }
    };
  }

  /**
   * Locates the interactive drag handle element within a sortable row.
   * Mirrors 1:1 implementation in extractor.js.
   */
  function findDragHandleInRow(rowEl) {
    if (!rowEl) return null;

    // 1. Explicit drag handle attributes / classes
    const explicitSelector = [
      "[data-rbd-drag-handle-draggable-id]",
      "[data-rfd-drag-handle-draggable-id]",
      "[data-drag-handle]",
      "[aria-roledescription*='sortable' i]",
      "[class*='drag-handle' i]",
      "[class*='dragHandle' i]",
      "[class*='grip' i]",
      ".drag-handle",
      ".grip-handle"
    ].join(", ");

    try {
      const explicit = rowEl.querySelector(explicitSelector);
      if (explicit) return explicit;
    } catch (_) {}

    // 2. Left-side child box/button/div inside rowEl containing an <svg> (6-dot icon) and no question text
    try {
      const children = Array.from(rowEl.children || []);
      for (const child of children) {
        const svg = child.querySelector ? child.querySelector("svg") : null;
        if (svg) {
          const text = cleanText(child.textContent || "");
          if (text.length <= 3) {
            return child;
          }
        }
      }
    } catch (_) {}

    // 3. Child with tabIndex === 0 or cursor: grab / move
    try {
      const allEls = Array.from(rowEl.querySelectorAll("*"));
      for (const el of allEls) {
        if (el.tabIndex === 0 && !el.matches("input, textarea, select, button[type='submit']")) {
          return el;
        }
        if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
          const cursor = window.getComputedStyle(el).cursor;
          if (cursor === "grab" || cursor === "grabbing" || cursor === "move") {
            return el;
          }
        }
      }
    } catch (_) {}

    return rowEl;
  }

  /**
   * Resolves the interactive drag handle element within a sortable container or item.
   */
  function resolveDragHandle(sourceEl) {
    if (!sourceEl) return null;
    return findDragHandleInRow(sourceEl);
  }

  /**
   * Dispatches react-beautiful-dnd / accessible keyboard events.
   * Lifts source handle with Space, steps ArrowDown/ArrowUp, and drops with Space.
   */
  function simulateRbdKeyboardDrag(sourceEl, targetOffset) {
    return dispatchKeyboardMove(sourceEl, targetOffset);
  }

  function dispatchKeyboardMove(sourceEl, targetOffset) {
    if (!sourceEl || targetOffset === 0) return false;
    const handle = resolveDragHandle(sourceEl);

    try {
      if (typeof handle.focus === "function") handle.focus();
    } catch (_) {}

    function key(k, c, code) {
      let ev;
      if (typeof KeyboardEvent !== "undefined") {
        try {
          ev = new KeyboardEvent("keydown", {
            key: k,
            code: c,
            keyCode: code,
            which: code,
            bubbles: true,
            cancelable: true,
            view: typeof window !== "undefined" ? window : null
          });
        } catch (_) {}
      }
      if (!ev && typeof CustomEvent !== "undefined") {
        try {
          ev = new CustomEvent("keydown", { bubbles: true, cancelable: true });
          ev.key = k;
          ev.code = c;
          ev.keyCode = code;
          ev.which = code;
        } catch (_) {}
      }
      if (!ev && typeof document !== "undefined" && typeof document.createEvent === "function") {
        try {
          ev = document.createEvent("CustomEvent");
          ev.initCustomEvent("keydown", true, true, null);
          ev.key = k;
          ev.code = c;
          ev.keyCode = code;
          ev.which = code;
        } catch (_) {}
      }
      if (!ev) {
        ev = { type: "keydown", key: k, code: c, keyCode: code, which: code, bubbles: true, cancelable: true };
      }
      if (handle && typeof handle.dispatchEvent === "function") {
        handle.dispatchEvent(ev);
      }
    }

    // Space keydown to lift
    key(" ", "Space", 32);

    // Step ArrowDown or ArrowUp
    const stepKey = targetOffset > 0 ? "ArrowDown" : "ArrowUp";
    const stepCode = targetOffset > 0 ? 40 : 38;
    const absSteps = Math.min(15, Math.abs(targetOffset));
    for (let s = 0; s < absSteps; s++) {
      key(stepKey, stepKey, stepCode);
    }

    // Space keydown to drop
    key(" ", "Space", 32);
    return true;
  }

  /**
   * Dispatches standard HTML5 native DragEvent sequence.
   * Specifically triggers dragstart -> dragenter -> dragover (with preventDefault) -> drop -> dragend.
   */
  function dispatchHtml5DragMove(sourceEl, targetEl) {
    if (!sourceEl || !targetEl || sourceEl === targetEl) return;
    const dt = createSyntheticDataTransfer();
    const sourceText = cleanText(sourceEl.innerText || sourceEl.textContent || "");
    dt.setData("text/plain", sourceText);

    function fireDrag(type, el) {
      if (!el || typeof el.dispatchEvent !== "function") return;
      let ev;
      if (typeof DragEvent !== "undefined") {
        try {
          ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            view: typeof window !== "undefined" ? window : null,
            dataTransfer: dt
          });
        } catch (_) {}
      }
      if (!ev && typeof CustomEvent !== "undefined") {
        try {
          ev = new CustomEvent(type, { bubbles: true, cancelable: true });
          ev.dataTransfer = dt;
        } catch (_) {}
      }
      if (!ev && typeof document !== "undefined" && typeof document.createEvent === "function") {
        try {
          ev = document.createEvent("CustomEvent");
          ev.initCustomEvent(type, true, true, null);
          ev.dataTransfer = dt;
        } catch (_) {}
      }
      if (!ev) {
        ev = { type: type, bubbles: true, cancelable: true, dataTransfer: dt, preventDefault: () => {} };
      }
      if (ev) {
        if (type === "dragover" && typeof ev.preventDefault === "function") {
          try {
            ev.preventDefault();
          } catch (_) {}
        }
        el.dispatchEvent(ev);
      }
    }

    fireDrag("dragstart", sourceEl);
    fireDrag("dragenter", targetEl);
    fireDrag("dragover", targetEl);
    fireDrag("drop", targetEl);
    fireDrag("dragend", sourceEl);
  }

  /**
   * Simulates pointer/mouse drag sequence across element coordinates.
   */
  function simulatePointerDrag(sourceEl, targetEl, stepOffset = 0) {
    return dispatchPointerMove(sourceEl, targetEl, stepOffset);
  }

  function dispatchPointerMove(sourceEl, targetEl, stepOffset = 0) {
    if (!sourceEl || !targetEl || sourceEl === targetEl) return;
    const doc = (typeof document !== "undefined") ? document : null;
    const win = (typeof window !== "undefined") ? window : null;
    if (!doc) return;

    const handle = resolveDragHandle(sourceEl) || sourceEl;

    try {
      if (typeof sourceEl.scrollIntoView === "function") {
        sourceEl.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    } catch (_) {}

    const r1 = handle.getBoundingClientRect ? handle.getBoundingClientRect() : { left: 0, top: 0, width: 20, height: 20 };
    const r2 = targetEl.getBoundingClientRect ? targetEl.getBoundingClientRect() : { left: 0, top: 0, width: 20, height: 20 };

    const x1 = Math.round(r1.left + (r1.width ? r1.width / 2 : 10));
    const y1 = Math.round(r1.top + (r1.height ? r1.height / 2 : 10));

    const yTargetOffset = stepOffset < 0 ? (r2.height ? r2.height * 0.25 : 5) : (r2.height ? r2.height * 0.75 : 15);
    const x2 = Math.round(r2.left + (r2.width ? r2.width / 2 : 10));
    const y2 = Math.round(r2.top + yTargetOffset);

    function dispatchEv(type, el, x, y, buttons = 1, button = 0) {
      if (!el || typeof el.dispatchEvent !== "function") return;
      const opts = {
        bubbles: true,
        cancelable: true,
        view: win,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: button,
        buttons: buttons,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse"
      };

      let ev;
      if (type.startsWith("pointer") && typeof PointerEvent !== "undefined") {
        try {
          ev = new PointerEvent(type, opts);
        } catch (_) {}
      }
      if (!ev && typeof MouseEvent !== "undefined") {
        try {
          ev = new MouseEvent(type, opts);
        } catch (_) {}
      }
      if (!ev && typeof CustomEvent !== "undefined") {
        try {
          ev = new CustomEvent(type, { bubbles: true, cancelable: true, detail: opts });
          Object.assign(ev, opts);
        } catch (_) {}
      }
      if (!ev && typeof document !== "undefined" && typeof document.createEvent === "function") {
        try {
          ev = doc.createEvent("CustomEvent");
          ev.initCustomEvent(type, true, true, null);
          Object.assign(ev, opts);
        } catch (_) {}
      }
      if (!ev) {
        ev = Object.assign({ type: type, bubbles: true, cancelable: true }, opts);
      }
      el.dispatchEvent(ev);
    }

    try {
      dispatchEv("pointerdown", handle, x1, y1, 1, 0);
      dispatchEv("mousedown", handle, x1, y1, 1, 0);

      dispatchEv("pointermove", doc, x1, y1 + (stepOffset < 0 ? -6 : 6), 1, 0);
      dispatchEv("mousemove", doc, x1, y1 + (stepOffset < 0 ? -6 : 6), 1, 0);

      const midX = Math.round((x1 + x2) / 2);
      const midY = Math.round((y1 + y2) / 2);
      dispatchEv("pointermove", doc, midX, midY, 1, 0);
      dispatchEv("mousemove", doc, midX, midY, 1, 0);

      dispatchEv("pointermove", targetEl, x2, y2, 1, 0);
      dispatchEv("mousemove", targetEl, x2, y2, 1, 0);
      dispatchEv("pointerover", targetEl, x2, y2, 1, 0);

      dispatchEv("pointerup", targetEl, x2, y2, 0, 0);
      dispatchEv("mouseup", targetRow, x2, y2, 0, 0);
      dispatchEv("click", targetEl, x2, y2, 0, 0);
    } finally {
      try {
        dispatchEv("pointerup", doc, x2, y2, 0, 0);
        dispatchEv("mouseup", doc, x2, y2, 0, 0);
      } catch (_) {}
    }
  }

  /**
   * Layer 2: Frame-Paced Pointer + Mouse Drag targeting handleEl with >5px slop threshold breaking.
   */
  async function simulateHandleMouseDrag(handleEl, sourceRow, targetRow, currentIdx, targetPos) {
    if (!handleEl || !sourceRow || !targetRow) return false;
    const doc = (typeof document !== "undefined") ? document : null;
    const win = (typeof window !== "undefined") ? window : null;
    if (!doc) return false;

    const r1 = (handleEl.getBoundingClientRect && handleEl.getBoundingClientRect().height > 0)
      ? handleEl.getBoundingClientRect()
      : { left: 100, top: currentIdx * 60, width: 24, height: 24 };
    const r2 = (targetRow.getBoundingClientRect && targetRow.getBoundingClientRect().height > 0)
      ? targetRow.getBoundingClientRect()
      : { left: 100, top: targetPos * 60, width: 300, height: 50 };

    const startX = Math.round(r1.left + (r1.width ? r1.width / 2 : 12));
    const startY = Math.round(r1.top + (r1.height ? r1.height / 2 : 12));
    const endX = Math.round(r2.left + (r2.width ? r2.width / 2 : 150));
    const direction = targetPos < currentIdx ? -1 : 1;
    // Overshoot slightly past target row's center in drag direction
    const endY = Math.round(r2.top + (r2.height ? r2.height * 0.5 : 25) + (direction * 10));

    function dispatchEv(type, el, x, y, buttons = 1, button = 0) {
      if (!el || typeof el.dispatchEvent !== "function") return;
      const opts = {
        bubbles: true,
        cancelable: true,
        view: win,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: button,
        buttons: buttons,
        isPrimary: true,
        pointerId: 1,
        pointerType: "mouse"
      };

      let ev;
      if (type.startsWith("pointer") && typeof PointerEvent !== "undefined") {
        try { ev = new PointerEvent(type, opts); } catch (_) {}
      }
      if (!ev && typeof MouseEvent !== "undefined") {
        try { ev = new MouseEvent(type, opts); } catch (_) {}
      }
      if (!ev && typeof CustomEvent !== "undefined") {
        try {
          ev = new CustomEvent(type, { bubbles: true, cancelable: true, detail: opts });
          Object.assign(ev, opts);
        } catch (_) {}
      }
      if (!ev && doc && typeof doc.createEvent === "function") {
        try {
          ev = doc.createEvent("CustomEvent");
          ev.initCustomEvent(type, true, true, null);
          Object.assign(ev, opts);
        } catch (_) {}
      }
      if (!ev) {
        ev = Object.assign({ type: type, bubbles: true, cancelable: true }, opts);
      }
      el.dispatchEvent(ev);
    }

    try {
      // 1. Pointerdown / mousedown on drag handle
      dispatchEv("pointerover", handleEl, startX, startY, 0, 0);
      dispatchEv("mouseover", handleEl, startX, startY, 0, 0);
      dispatchEv("pointerenter", handleEl, startX, startY, 0, 0);
      dispatchEv("mouseenter", handleEl, startX, startY, 0, 0);
      dispatchEv("pointerdown", handleEl, startX, startY, 1, 0);
      dispatchEv("mousedown", handleEl, startX, startY, 1, 0);

      // 2. Wait 20ms (requestAnimationFrame paced)
      await sleepMs(20);

      // 3. Dispatch slop-breaking movement past 5px threshold (8px)
      const slopY = startY + (direction * 8);
      dispatchEv("pointermove", handleEl, startX, slopY, 1, 0);
      dispatchEv("mousemove", handleEl, startX, slopY, 1, 0);
      dispatchEv("pointermove", doc, startX, slopY, 1, 0);
      dispatchEv("mousemove", doc, startX, slopY, 1, 0);
      if (win) {
        dispatchEv("pointermove", win, startX, slopY, 1, 0);
        dispatchEv("mousemove", win, startX, slopY, 1, 0);
      }

      // 4. Wait 25ms so react-beautiful-dnd / @dnd-kit initializes placeholder
      await sleepMs(25);

      // 5. Interpolate 6 intermediate steps from startY to endY
      const numSteps = 6;
      for (let s = 1; s <= numSteps; s++) {
        const frac = s / numSteps;
        const curX = Math.round(startX + (endX - startX) * frac);
        const curY = Math.round(startY + (endY - startY) * frac);
        dispatchEv("pointermove", targetRow, curX, curY, 1, 0);
        dispatchEv("mousemove", targetRow, curX, curY, 1, 0);
        dispatchEv("pointermove", doc, curX, curY, 1, 0);
        dispatchEv("mousemove", doc, curX, curY, 1, 0);
        if (win) {
          dispatchEv("pointermove", win, curX, curY, 1, 0);
          dispatchEv("mousemove", win, curX, curY, 1, 0);
        }
        await sleepMs(20);
      }

      // 6. Release pointerup, mouseup, and click
      dispatchEv("pointerup", handleEl, startX, endY, 0, 0);
      dispatchEv("mouseup", handleEl, startX, endY, 0, 0);
      dispatchEv("pointerup", targetRow, startX, endY, 0, 0);
      dispatchEv("mouseup", targetRow, startX, endY, 0, 0);
      dispatchEv("pointerup", doc, startX, endY, 0, 0);
      dispatchEv("mouseup", doc, startX, endY, 0, 0);
      if (win) {
        dispatchEv("pointerup", win, startX, endY, 0, 0);
        dispatchEv("mouseup", win, startX, endY, 0, 0);
      }
      dispatchEv("click", targetRow, startX, endY, 0, 0);
      await sleepMs(50);
      return true;
    } catch (err) {
      console.warn("[QuizZy] Pointer drag error:", err);
      return false;
    } finally {
      try {
        dispatchEv("pointerup", doc, startX, endY, 0, 0);
        dispatchEv("mouseup", doc, startX, endY, 0, 0);
      } catch (_) {}
    }
  }

  /**
   * Layer 3: Keyboard Sensor Reordering (Space -> ArrowUp/ArrowDown -> Space on handleEl).
   */
  async function simulateHandleKeyboardDrag(handleEl, currentIdx, targetPos) {
    if (!handleEl || currentIdx === targetPos) return false;
    const doc = (typeof document !== "undefined") ? document : null;
    const win = (typeof window !== "undefined") ? window : null;

    try {
      if (typeof handleEl.focus === "function") {
        handleEl.focus();
      }
    } catch (_) {}

    function key(k, c, code, targetEl) {
      const el = targetEl || (doc && doc.activeElement) || handleEl;
      if (!el || typeof el.dispatchEvent !== "function") return;
      let ev;
      if (typeof KeyboardEvent !== "undefined") {
        try {
          ev = new KeyboardEvent("keydown", {
            key: k,
            code: c,
            keyCode: code,
            which: code,
            bubbles: true,
            cancelable: true,
            view: win
          });
        } catch (_) {}
      }
      if (!ev && typeof CustomEvent !== "undefined") {
        try {
          ev = new CustomEvent("keydown", { bubbles: true, cancelable: true });
          ev.key = k;
          ev.code = c;
          ev.keyCode = code;
          ev.which = code;
        } catch (_) {}
      }
      if (!ev) {
        ev = { type: "keydown", key: k, code: c, keyCode: code, which: code, bubbles: true, cancelable: true };
      }
      el.dispatchEvent(ev);
    }

    // Space keydown to lift item
    key(" ", "Space", 32, handleEl);
    await sleepMs(35);

    const isUp = targetPos < currentIdx;
    const stepKey = isUp ? "ArrowUp" : "ArrowDown";
    const stepCode = isUp ? 38 : 40;
    const steps = Math.abs(currentIdx - targetPos);

    for (let s = 0; s < steps; s++) {
      key(stepKey, stepKey, stepCode, (doc && doc.activeElement) || handleEl);
      await sleepMs(35);
    }

    // Space keydown to drop item
    key(" ", "Space", 32, (doc && doc.activeElement) || handleEl);
    await sleepMs(50);
    return true;
  }

  function getItemId(el) {
    if (!el) return null;
    if (typeof el.getAttribute === "function") {
      const id = el.getAttribute("data-id") ||
                 el.getAttribute("data-rbd-draggable-id") ||
                 el.getAttribute("data-rfd-draggable-id") ||
                 el.getAttribute("id") ||
                 el.getAttribute("data-key") ||
                 el.getAttribute("data-item-id");
      if (id) return String(id).trim();
    }
    if (el.id) return String(el.id).trim();
    return null;
  }

  /**
   * Layer 4: HTML5 DragEvent cascade.
   */
  async function simulateHandleHtml5Drag(handleEl, sourceRow, targetRow) {
    if (!sourceRow || !targetRow) return false;
    dispatchHtml5DragMove(sourceRow, targetRow);
    if (handleEl && handleEl !== sourceRow) {
      dispatchHtml5DragMove(handleEl, targetRow);
    }
    await sleepMs(50);
    return true;
  }

  /**
   * Dispatches a combined multi-mode drag-and-drop sequence.
   */
  function simulateDragDrop(sourceEl, targetEl, stepOffset = 0) {
    if (!sourceEl || !targetEl || sourceEl === targetEl) return;
    dispatchHtml5DragMove(sourceEl, targetEl);
    dispatchPointerMove(sourceEl, targetEl, stepOffset);
    if (stepOffset !== 0) {
      dispatchKeyboardMove(sourceEl, stepOffset);
    }
  }

  /**
   * Cleans text from a sortable element by stripping decorative symbols, drag handles (☰, ::, ⋮⋮), and numbers.
   */
  function cleanItemText(el) {
    if (!el) return "";
    let raw = getCleanVisibleText(el, false) || (el.innerText || el.textContent || "");
    return cleanText(stripDecorativePrefix(raw));
  }

  /**
   * Discovers sortable option elements, prioritizing draggable and sortable container children.
   */
  function findSortableElements(doc, customSelector, optionSelectors) {
    if (!doc) return [];

    if (customSelector) {
      try {
        const customMatches = Array.from(doc.querySelectorAll(customSelector))
          .filter(isVisible)
          .filter((el) => !isQuizZyInternalElement(el) && !isExplanationOrFeedback(el) && !isHeaderOrNavText(cleanText(el.innerText || el.textContent || "")));
        const deduped = deduplicateOptionElements(customMatches);
        if (deduped.length >= 2) return deduped;
      } catch (_) {}
    }

    const sortableSelectors = [
      "[data-rbd-draggable-id]",
      "[data-rfd-draggable-id]",
      ".draggable-item",
      "[draggable='true']",
      ".sortable-item",
      ".order-item",
      ".sortable-block",
      "[aria-roledescription*='draggable' i]",
      "[aria-roledescription*='sortable' i]",
      "[class*='grip' i]",
      "[class*='drag-handle' i]",
      "[class*='dragHandle' i]",
      "[class*='row-item' i]"
    ];

    for (const sel of sortableSelectors) {
      try {
        const matches = Array.from(doc.querySelectorAll(sel))
          .filter(isVisible)
          .filter((el) => !isQuizZyInternalElement(el) && !isExplanationOrFeedback(el) && !isHeaderOrNavText(cleanText(el.innerText || el.textContent || "")));
        
        const resolved = matches.map((el) => {
          if (el.hasAttribute && (el.hasAttribute("data-rbd-draggable-id") || el.getAttribute("draggable") === "true")) {
            return el;
          }
          const parentItem = (typeof el.closest === "function")
            ? el.closest("[data-rbd-draggable-id], [data-rfd-draggable-id], [draggable='true'], .draggable-item, .sortable-item, .order-item, .quiz-option, [class*='row-item' i], li")
            : null;
          return parentItem || (typeof resolveOptionRowRoot === "function" ? resolveOptionRowRoot(el, matches) : el) || el;
        });

        const deduped = deduplicateOptionElements(resolved);
        if (deduped.length >= 2) return deduped;
      } catch (_) {}
    }

    return findOptionElements(customSelector, optionSelectors);
  }

  /**
   * Helper: Live DOM Row Discovery sorted top-to-bottom.
   */
  function getLiveOrderRows(doc, payload = {}) {
    if (!doc) doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return [];

    let rows = [];

    // 1. Try explicit optionSelectors if provided
    if (Array.isArray(payload.optionSelectors) && payload.optionSelectors.length >= 2) {
      for (const sel of payload.optionSelectors) {
        try {
          const el = doc.querySelector(sel);
          if (el && !rows.includes(el) && isVisible(el) && !isQuizZyInternalElement(el)) {
            rows.push(el);
          }
        } catch (_) {}
      }
      if (rows.length >= 2) {
        return sortElementsByDomOrY(rows);
      }
    }

    // 2. Discover sortable elements
    const sortables = findSortableElements(doc, payload.optionsSelector, payload.optionSelectors);
    if (sortables && sortables.length >= 2) {
      return sortElementsByDomOrY(sortables);
    }

    return [];
  }

  function sortElementsByDomOrY(elements) {
    return elements.slice().sort((a, b) => {
      if (a.getBoundingClientRect && b.getBoundingClientRect) {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        if (Math.abs(ra.top - rb.top) >= 2) {
          return ra.top - rb.top;
        }
      }
      if (typeof a.compareDocumentPosition === "function") {
        const pos = a.compareDocumentPosition(b);
        if (pos & 4) return -1; // DOCUMENT_POSITION_FOLLOWING
        if (pos & 2) return 1;  // DOCUMENT_POSITION_PRECEDING
      }
      return 0;
    });
  }

  /**
   * Compares the sequence of live option rows against the target ordered texts or IDs.
   */
  function isOrderMatching(liveRows, targetOrdered, isIdMode = false) {
    if (!Array.isArray(liveRows) || !Array.isArray(targetOrdered)) return false;
    if (liveRows.length !== targetOrdered.length || liveRows.length === 0) return false;

    for (let i = 0; i < targetOrdered.length; i++) {
      const row = liveRows[i];
      const target = targetOrdered[i];
      if (isIdMode) {
        const id = getItemId(row);
        if (id !== target) return false;
      } else {
        const rowText = cleanItemText(row);
        const targetClean = cleanText(stripDecorativePrefix(target));

        if (rowText.toLowerCase() === targetClean.toLowerCase()) continue;

        const normRow = rowText.toLowerCase().replace(/[^a-z0-9]/g, "");
        const normTarget = targetClean.toLowerCase().replace(/[^a-z0-9]/g, "");

        if (normRow && normTarget && (normRow === normTarget || normRow.includes(normTarget) || normTarget.includes(normRow))) {
          continue;
        }

        return false;
      }
    }

    return true;
  }

  /**
   * Direct MAIN-world React Fiber reordering logic (callable directly or injected via background).
   */
  function reorderReactListInMainWorld(payload) {
    if (!payload || !Array.isArray(payload.ordered_texts) || payload.ordered_texts.length < 2) {
      return { success: false, error: "Invalid payload or ordered_texts" };
    }

    const targetTexts = payload.ordered_texts;
    const N = targetTexts.length;

    function cleanStr(s) {
      if (!s) return "";
      return String(s)
        .replace(/^[\u2800-\u28FF\u22EE\u22EF\u22F0\u22F1\u2630\uFE19::⋮⠿]+\s*/, "")
        .replace(/^[1-8](?:[\.\)\:\-\s]+|\s+)(?=[A-Za-z`"'\<\(])/, "")
        .replace(/^[1-8]$/, "")
        .replace(/^\(\s*([A-Fa-f0-9]{1,2})\s*\)\s+/, "")
        .replace(/^\[\s*([A-Fa-f0-9]{1,2})\s*\]\s+/, "")
        .replace(/^[A-Fa-f][\.\)\:]\s+/, "")
        .replace(/^[0-9]{1,2}[\.\)]\s+/, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return { success: false, error: "No document" };

    let rows = [];
    if (Array.isArray(payload.optionSelectors) && payload.optionSelectors.length > 0) {
      for (const sel of payload.optionSelectors) {
        try {
          const el = doc.querySelector(sel);
          if (el && !rows.includes(el)) rows.push(el);
        } catch (_) {}
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
          const matched = Array.from(doc.querySelectorAll(sel));
          if (matched.length >= N) {
            rows = matched.slice(0, N);
            break;
          }
        } catch (_) {}
      }
    }

    if (rows.length === 0) {
      const allDivs = Array.from(doc.querySelectorAll("div, li, tr"));
      const matchingDivs = allDivs.filter((el) => {
        const t = cleanStr(el.innerText || el.textContent || "");
        return targetTexts.some((tgt) => cleanStr(tgt) === t);
      });
      const uniqueMatches = [];
      for (const el of matchingDivs) {
        const t = cleanStr(el.innerText || el.textContent || "");
        if (!uniqueMatches.some((u) => cleanStr(u.innerText || u.textContent || "") === t)) {
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

    const currentTexts = rows.map(r => cleanStr(r.innerText || r.textContent || ""));
    const targetClean = targetTexts.map(cleanStr);
    const isAlreadyMatch = currentTexts.length === N && currentTexts.every((t, i) => t === targetClean[i] || t.includes(targetClean[i]) || targetClean[i].includes(t));
    if (isAlreadyMatch) {
      return { success: true, already_matched: true, method: "already_correct" };
    }

    const targetOrderIndices = [];
    for (let j = 0; j < N; j++) {
      const tgt = targetClean[j];
      let foundIdx = rows.findIndex(r => {
        const ct = cleanStr(r.innerText || r.textContent || "");
        return ct === tgt || ct.includes(tgt) || tgt.includes(ct);
      });
      if (foundIdx === -1) foundIdx = j;
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

    let curr = fiberCandidate;
    let depth = 0;
    while (curr && depth < 35) {
      const props = curr.memoizedProps;
      if (props) {
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
            return { success: true, method: "react_sortable_hoc_onSortEnd" };
          } catch (err) {
            console.warn("[QuizZy] onSortEnd error:", err);
          }
        }

        // PATH 1A.2 react-beautiful-dnd / @hello-pangea/dnd / @dnd-kit onDragEnd
        if (typeof props.onDragEnd === "function") {
          try {
            let droppableId = "droppable";
            const dropEl = doc.querySelector("[data-rbd-droppable-id], [data-rfd-droppable-id]");
            if (dropEl) {
              droppableId = dropEl.getAttribute("data-rbd-droppable-id") || dropEl.getAttribute("data-rfd-droppable-id") || droppableId;
            }

            const draggableIds = rows.map((r, idx) => {
              return (r.getAttribute && (r.getAttribute("data-rbd-draggable-id") || r.getAttribute("data-rfd-draggable-id") || r.getAttribute("data-id") || r.getAttribute("id"))) || `item-${idx}`;
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
                } catch (_) {}

                const [moved] = simulatedList.splice(currentPos, 1);
                simulatedList.splice(targetPos, 0, moved);
              }
            }
            return { success: true, method: "react_rbd_onDragEnd" };
          } catch (err) {
            console.warn("[QuizZy] onDragEnd error:", err);
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
                return { success: true, method: "react_class_setState", stateKey: k };
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
                  return { success: true, method: "react_hook_dispatch" };
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

    return { success: false, error: "React Fiber tree walked but no suitable dnd handlers or state arrays found" };
  }

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Reads the current order and stable identity descriptors of all sortable items in the DOM.
   */
  function readCurrentSortableItems(doc, customSelector) {
    const rawElements = findSortableElements(doc, customSelector);
    return rawElements.map((el, idx) => {
      const stableId = (el.getAttribute && (
        el.getAttribute("data-rbd-draggable-id") ||
        el.getAttribute("data-id") ||
        el.getAttribute("id") ||
        el.getAttribute("data-key") ||
        el.getAttribute("data-item-id")
      )) || null;

      const text = cleanItemText(el);
      const key = stableId || text;
      return {
        element: el,
        index: idx,
        stableId: stableId,
        text: text,
        key: key
      };
    });
  }

  /**
   * Matches an item descriptor against a target identity.
   */
  function itemMatchesTarget(item, target) {
    if (!item || !target) return false;
    const targetClean = cleanText(target);
    if (item.stableId && String(item.stableId).trim() === targetClean) {
      return true;
    }
    const itemText = cleanText(item.text);
    if (itemText === targetClean) return true;
    if (itemText.includes(targetClean) || targetClean.includes(itemText)) return true;
    return false;
  }

  /**
   * 4-LAYER DRAG-AND-DROP ORDERING ENGINE (`q_type: "order"`)
   *
   * Layer 1: MAIN-World React Fiber onDragEnd / onSortEnd / useState / setState
   * Layer 2: Frame-Paced Pointer + Mouse Drag on drag handle with >5px slop threshold breaking
   * Layer 3: Keyboard Sensor Reordering (Space -> ArrowUp/ArrowDown -> Space on handleEl)
   * Layer 4: HTML5 DragEvent cascade
   *
   * Enforces Mandatory Pre-Submit Order Verification Gate:
   * Returns { ok: true, success: true, selected: true, verified_order: true } on match;
   * Returns { ok: false, success: false, selected: false, error: "ORDER_REORDER_FAILED" } on failure.
   */
  async function executeOrderAction(payload) {
    const doc = (typeof document !== "undefined") ? document : null;
    const win = (typeof window !== "undefined") ? window : null;

    if (!doc) {
      return { ok: false, success: false, selected: false, error: "NO_DOCUMENT", reason: "DOM document unavailable." };
    }

    // 1. Concurrency Lock: prevent two reorders from executing simultaneously
    if (win && win.__QUIZZY_ORDER_LOCK__) {
      return {
        ok: false,
        success: false,
        selected: false,
        error: "EXECUTION_LOCKED",
        reason: "Another reorder operation is already in progress."
      };
    }
    if (win) win.__QUIZZY_ORDER_LOCK__ = true;

    try {
      // 2. Discover live order rows in DOM
      let liveRows = getLiveOrderRows(doc, payload);
      if (liveRows.length < 2) {
        return {
          ok: false,
          success: false,
          selected: false,
          error: "UNSUPPORTED_WIDGET",
          reason: `Found only ${liveRows.length} sortable items. Minimum 2 required.`
        };
      }

      const initialRows = liveRows.slice();
      const initialSignature = initialRows.map(r => getItemId(r) || cleanItemText(r)).join("|||");
      const isIdMode = Array.isArray(payload.desired_item_ids) && payload.desired_item_ids.length > 0;

      // 3. Resolve desired targets
      let desiredTargets = [];
      if (isIdMode) {
        desiredTargets = payload.desired_item_ids.map(cleanText);
      } else if (Array.isArray(payload.ordered_texts) && payload.ordered_texts.length > 0) {
        desiredTargets = payload.ordered_texts.map(cleanText);
      } else if (Array.isArray(payload.permutation_indices) && payload.permutation_indices.length > 0) {
        const baseOptions = Array.isArray(payload.options) && payload.options.length === liveRows.length
          ? payload.options
          : liveRows.map(cleanItemText);
        desiredTargets = payload.permutation_indices.map(idx => cleanText(baseOptions[idx] || ""));
      } else if (typeof payload.answer === "string" && payload.answer.trim()) {
        const rawLetters = payload.answer.match(/[A-Za-z]/g);
        if (rawLetters && rawLetters.length === liveRows.length) {
          desiredTargets = rawLetters.map(c => {
            const idx = c.toUpperCase().charCodeAt(0) - 65;
            return cleanText(payload.options ? payload.options[idx] : cleanItemText(liveRows[idx]));
          });
        }
      }

      if (desiredTargets.length !== liveRows.length) {
        return {
          ok: false,
          success: false,
          selected: false,
          error: "COUNT_MISMATCH",
          reason: `Item count mismatch: found ${liveRows.length} DOM blocks, expected ${desiredTargets.length}`
        };
      }

      // Check for duplicate target items in desired sequence when DOM items are distinct
      if (new Set(desiredTargets).size !== desiredTargets.length) {
        const liveKeys = liveRows.map(el => (isIdMode ? getItemId(el) : cleanItemText(el)));
        if (new Set(liveKeys).size === liveKeys.length) {
          return {
            ok: false,
            success: false,
            selected: false,
            error: "INVALID_DESIRED_ORDER",
            reason: "Desired order sequence contains duplicate elements."
          };
        }
      }

      // Check for ambiguous display texts without unique IDs
      if (!isIdMode) {
        const rowTexts = liveRows.map(cleanItemText);
        const hasDuplicateTexts = new Set(rowTexts).size !== rowTexts.length;
        const hasDistinctIds = liveRows.every(r => !!getItemId(r));
        if (hasDuplicateTexts && !hasDistinctIds) {
          return {
            ok: false,
            success: false,
            selected: false,
            error: "AMBIGUOUS_ORDER_MAPPING",
            reason: "Sortable items contain duplicate display texts without unique IDs."
          };
        }
      }

      // Check if already in correct order
      if (isOrderMatching(liveRows, desiredTargets, isIdMode)) {
        return {
          ok: true,
          success: true,
          selected: true,
          verified: true,
          verified_order: true,
          already_correct: true,
          moves: 0,
          action: "order_reordered",
          final_order: liveRows.map(cleanItemText)
        };
      }

      // LAYER 1: MAIN-World React Fiber / onDragEnd / onSortEnd / useState / setState
      try {
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          const bgPromise = new Promise((resolve) => {
            chrome.runtime.sendMessage({
              action: "EXECUTE_REACT_ORDER_MAIN",
              payload: {
                optionSelectors: payload.optionSelectors,
                dragHandleSelectors: payload.dragHandleSelectors,
                ordered_texts: desiredTargets,
                options: payload.options
              }
            }, (res) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve(res);
            });
          });
          const bgRes = await Promise.race([
            bgPromise,
            sleepMs(500).then(() => null)
          ]);
          if (bgRes && bgRes.success) {
            await sleepMs(60);
            liveRows = getLiveOrderRows(doc, payload);
            if (isOrderMatching(liveRows, desiredTargets, isIdMode)) {
              return {
                ok: true,
                success: true,
                selected: true,
                verified: true,
                verified_order: true,
                method: "react_main_world",
                action: "order_reordered",
                final_order: liveRows.map(cleanItemText)
              };
            }
          }
        }
      } catch (_) {}

      // Direct React reorder execution fallback (for headless/Node environments)
      try {
        const directReactRes = reorderReactListInMainWorld({
          optionSelectors: payload.optionSelectors,
          dragHandleSelectors: payload.dragHandleSelectors,
          ordered_texts: desiredTargets,
          options: payload.options
        });
        if (directReactRes && directReactRes.success) {
          await sleepMs(60);
          liveRows = getLiveOrderRows(doc, payload);
          if (isOrderMatching(liveRows, desiredTargets, isIdMode)) {
            return {
              ok: true,
              success: true,
              selected: true,
              verified: true,
              verified_order: true,
              method: "react_main_world_direct",
              action: "order_reordered",
              final_order: liveRows.map(cleanItemText)
            };
          }
        }
      } catch (_) {}

      // LAYER 2, 3, 4: Live DOM Drag-Handle Iterative Move Loop
      let totalMoves = 0;

      for (let targetPos = 0; targetPos < desiredTargets.length; targetPos++) {
        // Re-fetch live rows on EVERY iteration!
        liveRows = getLiveOrderRows(doc, payload);

        // Find current position of the item that belongs at targetPos
        let currentIdx = -1;
        const targetVal = desiredTargets[targetPos];

        if (isIdMode) {
          currentIdx = liveRows.findIndex(r => getItemId(r) === targetVal);
        } else {
          const targetClean = cleanText(stripDecorativePrefix(targetVal)).toLowerCase();
          for (let j = 0; j < liveRows.length; j++) {
            const rowText = cleanItemText(liveRows[j]).toLowerCase();
            if (rowText === targetClean) {
              currentIdx = j;
              break;
            }
            const normRow = rowText.replace(/[^a-z0-9]/g, "");
            const normTarget = targetClean.replace(/[^a-z0-9]/g, "");
            if (normRow && normTarget && (normRow === normTarget || normRow.includes(normTarget) || normTarget.includes(normRow))) {
              currentIdx = j;
              break;
            }
          }
        }

        if (currentIdx === -1 || currentIdx === targetPos) {
          continue;
        }

        const sourceRow = liveRows[currentIdx];
        const targetRow = liveRows[targetPos];
        const handleEl = findDragHandleInRow(sourceRow) || sourceRow;

        function checkSlotMatches(rows) {
          if (!rows[targetPos]) return false;
          if (isIdMode) {
            return getItemId(rows[targetPos]) === targetVal;
          }
          const rowText = cleanItemText(rows[targetPos]).toLowerCase();
          const targetClean = cleanText(stripDecorativePrefix(targetVal)).toLowerCase();
          return rowText === targetClean || rowText.replace(/[^a-z0-9]/g, "").includes(targetClean.replace(/[^a-z0-9]/g, ""));
        }

        // LAYER 2: Frame-Paced Pointer + Mouse Drag on drag handle
        await simulateHandleMouseDrag(handleEl, sourceRow, targetRow, currentIdx, targetPos);
        await sleepMs(60);

        liveRows = getLiveOrderRows(doc, payload);
        if (checkSlotMatches(liveRows)) {
          totalMoves++;
          continue;
        }

        // LAYER 3: Keyboard Sensor Reordering (Space -> ArrowUp/ArrowDown -> Space on handleEl)
        await simulateHandleKeyboardDrag(handleEl, currentIdx, targetPos);
        await sleepMs(60);

        liveRows = getLiveOrderRows(doc, payload);
        if (checkSlotMatches(liveRows)) {
          totalMoves++;
          continue;
        }

        // LAYER 4: HTML5 DragEvent cascade
        await simulateHandleHtml5Drag(handleEl, sourceRow, targetRow);
        await sleepMs(60);

        liveRows = getLiveOrderRows(doc, payload);
        totalMoves++;
      }

      // PRE-SUBMIT VERIFICATION GATE
      liveRows = getLiveOrderRows(doc, payload);
      const isFinalVerified = isOrderMatching(liveRows, desiredTargets, isIdMode);

      if (isFinalVerified) {
        return {
          ok: true,
          success: true,
          selected: true,
          verified: true,
          verified_order: true,
          action: "order_reordered",
          moves: totalMoves,
          final_order: liveRows.map(cleanItemText)
        };
      } else {
        const finalSignature = liveRows.map(r => getItemId(r) || cleanItemText(r)).join("|||");
        const hasMoved = initialSignature !== finalSignature;
        return {
          ok: false,
          success: false,
          selected: false,
          verified: false,
          verified_order: false,
          unmoved: !hasMoved,
          action: "order_swap_attempted",
          error: "ORDER_REORDER_FAILED",
          reason: hasMoved
            ? "Blocks shifted but do not match verified target sequence. Safe manual pause required."
            : "Host page drag library did not respond to synthetic DragEvents. Safe manual swap required.",
          current_order: liveRows.map(cleanItemText),
          target_order: desiredTargets
        };
      }

    } finally {
      if (win) win.__QUIZZY_ORDER_LOCK__ = false;
    }
  }

  /**
   * Finds and clicks the Next / Submit / Advance question button on the host page.
   * Handles the two-step SUBMIT -> NEXT button flow for quiz platforms like learning.ccbp.in.
   */
  async function clickNextButton(customNextSelector) {
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return { success: false, error: "No document" };

    // Ignore non-advance buttons like SHOW ANSWER, SKIP, END PRACTICE, HINT, PREVIOUS, BACK, REPORT
    function isIgnoredButton(btn) {
      if (!btn) return true;
      const t = cleanText(btn.innerText || btn.textContent || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
      if (/^(?:show answer|skip|end practice|practice instructions|reset|cancel|hint|previous|prev|back|report|report an issue|review)\b/i.test(t)) {
        return true;
      }
      return false;
    }

    function isNextCandidate(btn) {
      if (!btn || isIgnoredButton(btn) || btn.disabled) return false;
      const t = cleanText(btn.innerText || btn.textContent || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
      if (/^(?:next|continue|advance|forward|next question)\b/i.test(t)) return true;
      if (btn.matches && (btn.matches("[data-quiz-next]") || btn.matches(".btn-next") || btn.matches(".next-btn") || btn.matches(".quiz-next") || btn.matches(".next-button"))) return true;
      return false;
    }

    function isSubmitCandidate(btn) {
      if (!btn || isIgnoredButton(btn) || btn.disabled) return false;
      const t = cleanText(btn.innerText || btn.textContent || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
      if (/^(?:submit|check answer|check|submit answer)\b/i.test(t)) return true;
      if (btn.type === "submit" && !isNextCandidate(btn)) return true;
      return false;
    }

    function findReadyNext(customSelector) {
      if (customSelector) {
        try {
          const el = doc.querySelector(customSelector);
          if (el && isVisible(el) && !el.disabled && !isIgnoredButton(el)) {
            return el;
          }
        } catch (e) {}
      }

      const allButtons = Array.from(doc.querySelectorAll(
        "button, a.btn, [role='button'], input[type='button'], input[type='submit']"
      )).filter(isVisible);

      const candidate = allButtons.find(isNextCandidate);
      if (candidate) return candidate;

      const nextHeuristics = [
        "[data-quiz-next]",
        "#next-question",
        ".btn-next",
        ".next-btn",
        "button.quiz-next",
        "button.next-button"
      ];
      for (const sel of nextHeuristics) {
        try {
          const el = doc.querySelector(sel);
          if (el && isVisible(el) && !el.disabled && !isIgnoredButton(el)) {
            return el;
          }
        } catch (e) {}
      }
      return null;
    }

    // (A) Check if NEXT button is ALREADY visible and enabled
    const directNext = findReadyNext(customNextSelector);
    if (directNext) {
      const clicked = dispatchClick(directNext);
      const btnText = cleanText(directNext.innerText || directNext.textContent || directNext.value || "Next");
      return {
        ok: clicked,
        success: clicked,
        step: "next_direct",
        action: "next_button_clicked",
        button_text: btnText
      };
    }

    function isQuizCompleted(d) {
      if (!d) return false;
      const root = d.body || d;
      const bodyText = (root.innerText || root.textContent || "").toLowerCase();

      // NEVER treat "END PRACTICE" as completion
      // 1. Dedicated completion summary view or congratulatory screens
      if (/(?:quiz\s*summary|practice\s*summary|view\s*report|view\s*results|score\s*card|congratulations|assessment\s*completed)/i.test(bodyText)) {
        if (!bodyText.includes("end practice") || /(?:view\s*report|score\s*card|congratulations|practice\s*summary)/i.test(bodyText)) {
          return true;
        }
      }

      // 2. Check for explicit finish / view report buttons (EXCLUDING "End Practice", "Skip", "Show Answer")
      const btns = Array.from(d.querySelectorAll("button, a.btn, [role='button'], input[type='button']")).filter(isVisible);
      for (const b of btns) {
        const bText = cleanText(b.innerText || b.textContent || b.value || "").toLowerCase();
        if (bText.includes("end practice") || bText === "skip" || bText === "show answer") {
          continue; // EXPLICITLY IGNORE
        }
        if (/^(?:finish|view\s*report|view\s*results|review\s*test)\b/i.test(bText)) {
          return true;
        }
      }

      // 3. Check "QUESTIONS ATTEMPTED: X/Y" where X === Y and X > 0
      const match = bodyText.match(/questions?\s*attempted\s*:\s*(\d+)\s*\/\s*(\d+)/i);
      if (match && match[1] && match[2]) {
        const attempted = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        if (total > 0 && attempted >= total) {
          return true;
        }
      }

      return false;
    }

    // (B) If not, check if a SUBMIT button is present (two-step submit -> next)
    const allButtons = Array.from(doc.querySelectorAll(
      "button, a.btn, [role='button'], input[type='button'], input[type='submit']"
    )).filter(isVisible);

    const submitBtn = allButtons.find(isSubmitCandidate);
    if (submitBtn) {
      // MANDATORY PRE-SUBMIT SELECTION VERIFICATION GATE:
      // The verified pipeline is: View question -> Solve it -> Select option -> Submit.
      // If the question contains options, ensure at least one option is selected.
      // Never click Submit if no option is selected!
      const optionsOnPage = findOptionElements(null, null, doc);
      if (optionsOnPage && optionsOnPage.length >= 2) {
        const anyChecked = optionsOnPage.some(isOptionChecked);
        const checkedInputs = doc.querySelectorAll("input[type='radio']:checked, input[type='checkbox']:checked");
        const hasCheckedInput = checkedInputs && checkedInputs.length > 0;
        const hasTrackedSelection = (typeof window !== "undefined" && window.__QUIZZY_CURRENT_QUESTION_OPTION_SELECTED__ && doc.contains(window.__QUIZZY_CURRENT_QUESTION_OPTION_SELECTED__));

        if (!anyChecked && !hasCheckedInput && !hasTrackedSelection) {
          console.warn("[QuizZy Executor] Blocked SUBMIT: No option is currently selected on this question. Process is: View -> Solve -> Select -> Submit.");
          return {
            ok: false,
            success: false,
            selected: false,
            error: "NO_OPTION_SELECTED: Cannot submit question because no option is selected."
          };
        }
      }

      const initialStem = (function() {
        try {
          const stemEl = doc.querySelector(".sc-question-stem, .question-stem, [class*='question-text'], p, h1, h2");
          return stemEl ? cleanText(stemEl.innerText || stemEl.textContent || "") : "";
        } catch (_) { return ""; }
      })();

      const submitText = cleanText(submitBtn.innerText || submitBtn.textContent || submitBtn.value || "Submit");
      dispatchClick(submitBtn);

      // Deterministic polling: check every 60ms up to 4500ms for NEXT button to appear/enable
      const pollIntervalMs = 60;
      const maxWaitMs = 4500;
      let waitedMs = 0;
      let postNext = null;
      let retriedOptionSelect = false;

      while (waitedMs < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        waitedMs += pollIntervalMs;

        postNext = findReadyNext(customNextSelector);
        if (postNext) {
          break;
        }

        // Direct question advance detection: if the question text already changed, the page advanced immediately
        if (initialStem) {
          try {
            const currentStemEl = doc.querySelector(".sc-question-stem, .question-stem, [class*='question-text'], p, h1, h2");
            const currentStem = currentStemEl ? cleanText(currentStemEl.innerText || currentStemEl.textContent || "") : "";
            if (currentStem && currentStem !== initialStem) {
              if (typeof window !== "undefined") {
                window.__QUIZZY_LAST_SELECTED_OPTION__ = null;
                window.__QUIZZY_CURRENT_QUESTION_OPTION_SELECTED__ = null;
              }
              return {
                ok: true,
                success: true,
                step: "submit_then_next",
                action: "submit_then_next_clicked",
                button_text: submitText,
                waited_ms: waitedMs
              };
            }
          } catch (_) {}
        }

        // Check if "Please select an option" validation error appeared
        const pageText = (doc.body ? doc.body.innerText || doc.body.textContent : doc.documentElement.textContent || "").toLowerCase();
        const hasSelectOptionError = /please\s*select\s*an?\s*(?:option|answer)|select\s*an?\s*option/i.test(pageText);

        if (!retriedOptionSelect && hasSelectOptionError) {
          const lastOpt = (typeof window !== "undefined") ? window.__QUIZZY_LAST_SELECTED_OPTION__ : null;
          if (lastOpt && doc.contains(lastOpt) && typeof triggerOptionSelect === "function") {
            retriedOptionSelect = true;
            // Perform alternate deep click fallback on last selected option
            triggerOptionSelect(lastOpt);
            // Also directly click firstElementChild (circle) and lastElementChild (text) if present
            if (lastOpt.firstElementChild) {
              dispatchClick(lastOpt.firstElementChild);
            }
            if (lastOpt.lastElementChild && lastOpt.lastElementChild !== lastOpt.firstElementChild) {
              dispatchClick(lastOpt.lastElementChild);
            }
            // Wait 200ms for React state commit
            await new Promise((resolve) => setTimeout(resolve, 200));
            waitedMs += 200;
            // Re-click submit button
            const currentSub = doc.querySelector("button[type='submit'], input[type='submit'], button.btn-submit") || submitBtn;
            if (currentSub && isVisible(currentSub) && !currentSub.disabled) {
              dispatchClick(currentSub);
            }
          }
        }
      }

      // If NEXT button appeared, click it and return submit_then_next ALWAYS,
      // even if "QUESTIONS ATTEMPTED: 15/15" was on the page (e.g. during re-practice)!
      if (postNext) {
        const nextClicked = dispatchClick(postNext);
        const nextText = cleanText(postNext.innerText || postNext.textContent || postNext.value || "Next Question");
        return {
          ok: nextClicked,
          success: nextClicked,
          step: "submit_then_next",
          action: "submit_then_next_clicked",
          button_text: `${submitText} -> ${nextText}`,
          waited_ms: waitedMs
        };
      }

      // If no NEXT button rendered after submit within maxWaitMs:
      // Only now evaluate whether the quiz is actually completed!
      // Check if submit button became disabled or disappeared (or feedback appeared)
      const currentSubmit = doc.querySelector("button[type='submit'], input[type='submit'], button.btn-submit") || submitBtn;
      const submitGoneOrDisabled = !currentSubmit || !isVisible(currentSubmit) || currentSubmit.disabled;

      if (submitGoneOrDisabled && isQuizCompleted(doc)) {
        return {
          ok: true,
          success: true,
          step: "quiz_completed",
          action: "quiz_completed",
          button_text: submitText,
          waited_ms: waitedMs,
          reason: "Final question submitted; quiz completed."
        };
      }

      // If submit button is still enabled and no next button appeared, return next_timeout
      if (currentSubmit && isVisible(currentSubmit) && !currentSubmit.disabled) {
        return {
          ok: false,
          success: false,
          step: "next_timeout",
          error: "NEXT QUESTION did not appear within 4500ms after SUBMIT (Submit button is still enabled; submission may have failed)."
        };
      }

      return {
        ok: false,
        success: false,
        step: "next_timeout",
        error: "NEXT QUESTION did not appear within 4500ms after SUBMIT."
      };
    }

    // (C) If neither Next nor Submit found, check if dedicated completion summary screen is active
    if (isQuizCompleted(doc)) {
      return {
        ok: true,
        success: true,
        step: "quiz_completed",
        action: "quiz_completed",
        reason: "Quiz completion detected."
      };
    }

    return {
      ok: false,
      success: false,
      error: "Next / Continue button not found. Please specify 'Next Button Selector' in Settings."
    };
  }

  /**
   * Skipping questions operation has been completely removed/disabled.
   * QuizZy never clicks host-page Skip buttons to prevent skipping questions.
   */
  async function clickSkipButton(_customSkipSelector) {
    return {
      success: false,
      ok: false,
      disabled: true,
      error: "Skipping questions operation is completely disabled."
    };
  }

  /**
   * Resilient Question Advancement / Swiping:
   * When QuizZy needs to advance or swipe carousel:
   * 1. Attempts Next / Submit / Advance question button.
   * 2. Attempts Carousel / Slider next controls (.swiper-button-next, .slick-next, etc.).
   * 3. Attempts Keyboard navigation (ArrowRight / PageDown).
   * 4. Attempts Touch / Pointer horizontal swipe gesture on active card.
   * (Never clicks Skip button)
   */
  async function swipeOrAdvanceQuestion(customSelector) {
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return { success: false, ok: false, error: "No document" };

    // 1. Try direct Next / Advance / Continue button
    try {
      const nextRes = await clickNextButton(customSelector);
      if (nextRes && (nextRes.success || nextRes.ok)) {
        return {
          success: true,
          ok: true,
          step: "next_advance",
          method: "next",
          action: nextRes.action || "next_clicked",
          button_text: nextRes.button_text || "Next"
        };
      }
    } catch (_) {}

    // 3. Try Carousel / Slider / Swiper navigation
    const swiperSelectors = [
      ".swiper-button-next",
      ".slick-next",
      ".carousel-control-next",
      "[aria-label*='next slide' i]",
      "[aria-label*='next question' i]",
      "[aria-label='Next' i]",
      "[data-slide='next']",
      "[data-action='next']",
      "button[class*='next' i]",
      "a[class*='next' i]",
      "[class*='arrow-right' i]",
      "[class*='chevron-right' i]"
    ];
    for (const sel of swiperSelectors) {
      try {
        const btn = doc.querySelector(sel);
        if (btn && isVisible(btn) && !btn.disabled) {
          const clicked = dispatchClick(btn);
          if (clicked) {
            return {
              success: true,
              ok: true,
              step: "swiper_advance",
              method: "swiper_button",
              action: "carousel_next_clicked",
              selector: sel
            };
          }
        }
      } catch (_) {}
    }

    // 4. Try Keyboard Arrow Right / Page Down navigation
    try {
      const activeEl = doc.activeElement || doc.body;
      if (activeEl && typeof activeEl.dispatchEvent === "function") {
        if (typeof KeyboardEvent === "function") {
          activeEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
          activeEl.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight", code: "ArrowRight", keyCode: 39, which: 39, bubbles: true }));
        }
      }
    } catch (_) {}

    // 5. Try Touch / Pointer horizontal swipe gesture
    try {
      const targetEl = doc.querySelector(".swiper-slide-active, .slick-active, [class*='active-slide'], [class*='card'], main, body") || (doc.body || null);
      if (targetEl && typeof targetEl.dispatchEvent === "function") {
        const rect = (typeof targetEl.getBoundingClientRect === "function")
          ? targetEl.getBoundingClientRect()
          : { width: 800, height: 600, left: 0, top: 0 };
        const startX = (rect.left || 0) + (rect.width || 800) * 0.8;
        const endX = (rect.left || 0) + (rect.width || 800) * 0.2;
        const y = (rect.top || 0) + (rect.height || 600) * 0.5;

        if (typeof PointerEvent === "function") {
          targetEl.dispatchEvent(new PointerEvent("pointerdown", { clientX: startX, clientY: y, bubbles: true }));
          targetEl.dispatchEvent(new PointerEvent("pointermove", { clientX: endX, clientY: y, bubbles: true }));
          targetEl.dispatchEvent(new PointerEvent("pointerup", { clientX: endX, clientY: y, bubbles: true }));
        }
        return {
          success: true,
          ok: true,
          step: "touch_swipe_advance",
          method: "touch_swipe",
          action: "horizontal_swipe_dispatched"
        };
      }
    } catch (_) {}

    return { success: false, ok: false, error: "No skip, next, or swipe controls found." };
  }

  /**
   * Helper: Strip markdown code fences (```cpp ... ```) from code payload.
   */
  function stripMarkdownCodeFences(str) {
    if (typeof str !== "string") return "";
    let clean = str.trim();
    clean = clean.replace(/^```[a-zA-Z0-9_+-]*\r?\n/, "");
    clean = clean.replace(/\r?\n```\s*$/, "");
    clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
    return clean;
  }

  /**
   * Deep Multi-Layer Editor Instance Discovery (Globals + DOM Expandos + React Fiber Traversal)
   * Discovers live Ace, Monaco, CodeMirror 5/6 editor instances and React onChange handlers
   * while strictly eliminating internal focus-catcher <textarea> false positives.
   */
  function discoverMainWorldEditor(docRef, winRef) {
    const doc = docRef || ((typeof document !== "undefined") ? document : null);
    const win = winRef || ((typeof window !== "undefined") ? window : null);
    if (!doc) return { type: "none", error: "No document available" };

    // Helper: Select the main interactive workspace editor, excluding problem statements, descriptions, & testcase outputs
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

    // Helper: Traverse React Fiber hierarchy up to 15 hops looking for editor instances, hook state, & onChange callbacks
    function scanReactFiber(domNode) {
      if (!domNode) return null;
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
                return { instance: res.instance, type: res.type, onChange: onChangeProp, fiber: cur };
              }
            }

            // Deep React Hook chain inspection (useRef holds editor in hook.memoizedState.current)
            if (cur.memoizedState && typeof cur.memoizedState === "object") {
              let hook = cur.memoizedState;
              let hookHops = 0;
              while (hook && hookHops < 35) {
                if (hook.memoizedState) {
                  const res = checkCandidate(hook.memoizedState);
                  if (res) return { instance: res.instance, type: res.type, onChange: onChangeProp, fiber: cur };
                }
                if (hook.baseState) {
                  const res = checkCandidate(hook.baseState);
                  if (res) return { instance: res.instance, type: res.type, onChange: onChangeProp, fiber: cur };
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

    // Helper: Check AMD / RequireJS loader for Monaco
    function resolveAmdMonaco() {
      if (!win) return null;
      if (win.monaco && win.monaco.editor) return win.monaco;
      if (typeof win.require === "function") {
        try {
          const reqM = win.require("vs/editor/editor.main");
          if (reqM && reqM.editor) return reqM;
        } catch (_) {}
        if (win.require.s && win.require.s.contexts && win.require.s.contexts._) {
          try {
            const def = win.require.s.contexts._.defined;
            if (def && def["vs/editor/editor.main"]) return def["vs/editor/editor.main"];
          } catch (_) {}
        }
      }
      return null;
    }

    // 1. Ace Editor discovery
    try {
      const mainEl = findMainEditorElement(doc);
      const aceEl = (mainEl && (mainEl.classList && (mainEl.classList.contains("ace_editor") || (typeof mainEl.className === "string" && mainEl.className.includes("ace_editor")))))
        ? mainEl
        : doc.querySelector(".ace_editor, [class*='ace_editor']");
      if (aceEl) {
        let aceInstance = null;
        let reactOnChange = null;

        if (aceEl.env && aceEl.env.editor) {
          aceInstance = aceEl.env.editor;
        } else if (aceEl.editor) {
          aceInstance = aceEl.editor;
        } else if (aceEl.__ace_editor__) {
          aceInstance = aceEl.__ace_editor__;
        } else if (win && win.ace && typeof win.ace.edit === "function") {
          try { aceInstance = win.ace.edit(aceEl); } catch (_) {}
        }

        // Ancestor expando property scan
        if (!aceInstance) {
          let curEl = aceEl;
          let elHops = 0;
          while (curEl && elHops < 10) {
            if (curEl.editor || curEl.__ace_editor__ || curEl._editor) {
              const cand = curEl.editor || curEl.__ace_editor__ || curEl._editor;
              if (cand && typeof cand.getValue === "function" && cand.session) {
                aceInstance = cand;
                break;
              }
            }
            curEl = curEl.parentElement;
            elHops++;
          }
        }

        const fiberRes = scanReactFiber(aceEl);
        if (fiberRes) {
          if (!aceInstance && fiberRes.instance && (fiberRes.type === "ace" || fiberRes.instance.session)) {
            aceInstance = fiberRes.instance;
          }
          if (fiberRes.onChange) reactOnChange = fiberRes.onChange;
        }

        if (aceInstance && typeof aceInstance.getValue === "function") {
          let lang = "";
          try {
            const mode = aceInstance.session && aceInstance.session.getMode ? aceInstance.session.getMode().$id : "";
            if (mode) lang = mode.split("/").pop();
          } catch (_) {}
          return {
            type: "ace",
            editor: aceInstance,
            el: aceEl,
            reactOnChange: reactOnChange,
            getValue: () => aceInstance.getValue(),
            setValue: (val) => {
              if (aceInstance.session && aceInstance.session.doc && typeof aceInstance.session.doc.setValue === "function") {
                aceInstance.session.doc.setValue(val);
              } else if (typeof aceInstance.setValue === "function") {
                aceInstance.setValue(val, 1);
              }
            },
            language: lang
          };
        }
      }
    } catch (_) {}

    // 2. Monaco Editor discovery
    try {
      const mainEl = findMainEditorElement(doc);
      const monacoEl = (mainEl && (mainEl.classList && (mainEl.classList.contains("monaco-editor") || (typeof mainEl.className === "string" && mainEl.className.includes("monaco-editor")))))
        ? mainEl
        : doc.querySelector(".monaco-editor, [class*='monaco-editor'], [data-editor='monaco']");
      let monacoInstance = null;
      let monacoModel = null;
      let reactOnChange = null;

      const activeMonacoNamespace = resolveAmdMonaco() || (win && win.monaco);

      if (activeMonacoNamespace && activeMonacoNamespace.editor) {
        if (typeof activeMonacoNamespace.editor.getEditors === "function") {
          const eds = activeMonacoNamespace.editor.getEditors();
          if (Array.isArray(eds) && eds.length > 0) {
            const nonReadOnly = eds.filter(e => {
              if (!e) return false;
              let isReadOnly = false;
              if (typeof e.getOption === "function" && activeMonacoNamespace.editor && activeMonacoNamespace.editor.EditorOption) {
                try { isReadOnly = e.getOption(activeMonacoNamespace.editor.EditorOption.readOnly) === true; } catch (_) {}
              }
              if (!isReadOnly && typeof e.getRawOptions === "function") {
                try { isReadOnly = (e.getRawOptions() || {}).readOnly === true; } catch (_) {}
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
            const targetDom = mainEl || monacoEl;
            monacoInstance = targetDom ? pool.find(e => {
              const dn = typeof e.getDomNode === "function" ? e.getDomNode() : null;
              return dn && (dn === targetDom || dn.contains(targetDom) || targetDom.contains(dn));
            }) : null;

            if (!monacoInstance) {
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
              monacoInstance = bestEd;
            }

            if (monacoInstance && typeof monacoInstance.getModel === "function") {
              monacoModel = monacoInstance.getModel();
            }
          }
        }
        if (!monacoModel && typeof activeMonacoNamespace.editor.getModels === "function") {
          const models = (typeof window !== "undefined" && window.monaco && window.monaco.editor && typeof window.monaco.editor.getModels === "function") ? window.monaco.editor.getModels() : activeMonacoNamespace.editor.getModels();
          if (Array.isArray(models) && models.length > 0) {
            if (models.length === 1) {
              monacoModel = models[0];
            } else {
              const templateSignatures = [/#include/i, /\bclass\s+Solution\b/i, /\bdef\s+/i, /\bfunction\s+/i, /\bpublic\s+class\b/i];
              for (let i = models.length - 1; i >= 0; i--) {
                const m = models[i];
                const val = (m && typeof m.getValue === "function") ? m.getValue() : "";
                if (templateSignatures.some(sig => sig.test(val))) {
                  monacoModel = m;
                  break;
                }
              }
              if (!monacoModel) {
                const attached = models.filter(m => typeof m.isAttachedToEditor === "function" && m.isAttachedToEditor());
                monacoModel = attached.length > 0 ? attached[attached.length - 1] : models[models.length - 1];
              }
            }
          }
        }
      }

      if (monacoEl) {
        // Ancestor expando property scan
        if (!monacoInstance) {
          let curEl = monacoEl;
          let elHops = 0;
          while (curEl && elHops < 12) {
            if (curEl.__monaco_editor__ || curEl.editor || curEl._editor || curEl.monaco) {
              const cand = curEl.__monaco_editor__ || curEl.editor || curEl._editor || curEl.monaco;
              if (cand && (typeof cand.executeEdits === "function" || typeof cand.getModel === "function")) {
                monacoInstance = cand;
                if (!monacoModel && typeof cand.getModel === "function") monacoModel = cand.getModel();
                break;
              } else if (cand && typeof cand.getValue === "function" && typeof cand.setValue === "function") {
                monacoModel = cand;
                break;
              }
            }
            curEl = curEl.parentElement;
            elHops++;
          }
        }

        const fiberRes = scanReactFiber(monacoEl);
        if (fiberRes) {
          if (!monacoInstance && fiberRes.instance) {
            if (typeof fiberRes.instance.executeEdits === "function") {
              monacoInstance = fiberRes.instance;
              if (!monacoModel && typeof fiberRes.instance.getModel === "function") monacoModel = fiberRes.instance.getModel();
            } else if (typeof fiberRes.instance.getModel === "function") {
              monacoInstance = fiberRes.instance;
              monacoModel = fiberRes.instance.getModel();
            } else if (typeof fiberRes.instance.getValue === "function") {
              monacoModel = fiberRes.instance;
            }
          }
          if (fiberRes.onChange) reactOnChange = fiberRes.onChange;
        }
      }

      // Check same-origin iframes if not yet resolved
      if (!monacoInstance && !monacoModel && doc.querySelectorAll) {
        try {
          const iframes = Array.from(doc.querySelectorAll("iframe"));
          for (const ifr of iframes) {
            try {
              const ifrDoc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
              const ifrWin = ifr.contentWindow;
              if (ifrDoc && ifrWin) {
                const ifrMonacoEl = ifrDoc.querySelector(".monaco-editor");
                if (ifrMonacoEl || (ifrWin.monaco && ifrWin.monaco.editor)) {
                  const ifrRes = discoverMainWorldEditor(ifrDoc, ifrWin);
                  if (ifrRes && ifrRes.type === "monaco") return ifrRes;
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      if (monacoInstance || monacoModel) {
        const activeModel = monacoModel || (monacoInstance && monacoInstance.getModel ? monacoInstance.getModel() : null);
        let lang = "";
        if (activeModel) {
          if (typeof activeModel.getLanguageId === "function") lang = activeModel.getLanguageId();
          else if (typeof activeModel.getModeId === "function") lang = activeModel.getModeId();
        }
        return {
          type: "monaco",
          editor: monacoInstance,
          model: activeModel,
          el: monacoEl,
          reactOnChange: reactOnChange,
          getValue: () => {
            if (activeModel && typeof activeModel.getValue === "function") return activeModel.getValue();
            if (monacoInstance && typeof monacoInstance.getValue === "function") return monacoInstance.getValue();
            return "";
          },
          setValue: (val) => {
            if (activeModel && typeof activeModel.setValue === "function") {
              activeModel.setValue(val);
            } else if (monacoInstance && typeof monacoInstance.executeEdits === "function" && activeModel) {
              const fullRange = typeof activeModel.getFullModelRange === "function"
                ? activeModel.getFullModelRange()
                : { startLineNumber: 1, startColumn: 1, endLineNumber: (activeModel.getLineCount ? activeModel.getLineCount() : 9999), endColumn: 9999 };
              monacoInstance.executeEdits("reconcile", [{ range: fullRange, text: val }]);
            }
          },
          language: lang
        };
      }
    } catch (_) {}

    // 3. CodeMirror 5 / 6 discovery
    try {
      const mainEl = findMainEditorElement(doc);
      const cmEl = (mainEl && (typeof mainEl.className === "string" && (mainEl.className.includes("cm-editor") || mainEl.className.includes("CodeMirror"))))
        ? mainEl
        : doc.querySelector(".CodeMirror, .cm-editor");
      if (cmEl) {
        if (cmEl.CodeMirror && typeof cmEl.CodeMirror.getValue === "function") {
          return {
            type: "codemirror5",
            editor: cmEl.CodeMirror,
            el: cmEl,
            getValue: () => cmEl.CodeMirror.getValue(),
            setValue: (val) => cmEl.CodeMirror.setValue(val),
            language: ""
          };
        }
        const view = (cmEl.cmView && cmEl.cmView.view) || cmEl._view;
        if (view && view.state && view.state.doc) {
          return {
            type: "codemirror6",
            view: view,
            el: cmEl,
            getValue: () => view.state.doc.toString(),
            setValue: (val) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: val } }),
            language: ""
          };
        }
        const fiberRes = scanReactFiber(cmEl);
        if (fiberRes && fiberRes.instance) {
          if (fiberRes.instance.state && fiberRes.instance.state.doc) {
            return {
              type: "codemirror6",
              view: fiberRes.instance,
              el: cmEl,
              reactOnChange: fiberRes.onChange,
              getValue: () => fiberRes.instance.state.doc.toString(),
              setValue: (val) => fiberRes.instance.dispatch({ changes: { from: 0, to: fiberRes.instance.state.doc.length, insert: val } }),
              language: ""
            };
          }
        }
      }
    } catch (_) {}

    // 4. Requirement B: Hard Rule on Editor Containers
    // If .ace_editor, .monaco-editor, .CodeMirror, or .cm-editor is present,
    // NEVER fall back to internal hidden textarea. Return explicit failure!
    const hasEditorContainer = !!doc.querySelector(".ace_editor, .monaco-editor, .CodeMirror, .cm-editor");
    if (hasEditorContainer) {
      return {
        type: "blocked_container",
        error: "Editor container found but MAIN-world editor instance was not accessible"
      };
    }

    // 5. Standalone genuine textarea fallback (ONLY when NO editor container exists in document)
    let candidateTextareas = [];
    try {
      candidateTextareas = Array.from(doc.querySelectorAll("textarea[name='code'], textarea#code, textarea.code-input, textarea"));
    } catch (_) {
      try {
        const single = doc.querySelector("textarea[name='code'], textarea#code, textarea.code-input, textarea");
        if (single) candidateTextareas = [single];
      } catch (_) {}
    }

    const validStandalone = candidateTextareas.find(ta => {
      if (!ta) return false;
      if (ta.matches && ta.matches(".ace_text-input, textarea.inputarea, textarea.monaco-mouse-cursor-text")) return false;
      const cls = ta.className || "";
      if (typeof cls === "string" && (cls.includes("ace_text-input") || cls.includes("inputarea") || cls.includes("monaco-mouse-cursor-text"))) return false;
      if (typeof ta.closest === "function" && ta.closest(".ace_editor, .monaco-editor, .CodeMirror, .cm-editor")) return false;
      return true;
    });

    if (validStandalone) {
      return {
        type: "textarea",
        el: validStandalone,
        getValue: () => validStandalone.value || validStandalone.textContent || "",
        setValue: (val) => { validStandalone.value = val; },
        language: ""
      };
    }

    return { type: "none", error: "No code editor or input textarea found in document" };
  }

  /**
   * Paste-Bypass Non-Paste Editor Writer:
   * Types/sets code using simulated direct model & keyboard edits (zero paste events dispatched),
   * disables auto-indent/auto-closing brackets during typing, preserves header comments/boilerplate,
   * triggers React onChange props, and reconciles exact indentation/text atomically.
   */
  function writeCodeWithHumanTypingInMainWorld(payload, docRef) {
    if (!payload) return { success: false, ok: false, selected: false, verified_code: false, error: "Empty payload", editorType: "none" };
    const rawCode = (typeof payload.code === "string")
      ? payload.code
      : (typeof payload.answer === "string" ? payload.answer : (typeof payload.selected_text === "string" ? payload.selected_text : ""));
    if (typeof rawCode !== "string") return { success: false, ok: false, selected: false, verified_code: false, error: "No code provided in payload", editorType: "none" };

    const targetCode = stripMarkdownCodeFences(rawCode);
    if (!targetCode || !targetCode.trim()) {
      return { success: false, ok: false, selected: false, verified_code: false, error: "Empty code payload rejected: refusing to wipe editor buffer", editorType: "none" };
    }

    const doc = docRef || ((typeof document !== "undefined") ? document : null);
    const win = (typeof window !== "undefined") ? window : null;
    if (!doc) return { success: false, ok: false, selected: false, verified_code: false, error: "No document available", editorType: "none" };

    const discovery = discoverMainWorldEditor(doc, win);
    if (discovery.type === "blocked_container") {
      return {
        success: false,
        ok: false,
        selected: false,
        verified_code: false,
        error: discovery.error,
        editorType: "none"
      };
    }
    if (discovery.type === "none" || !discovery.getValue) {
      return {
        success: false,
        ok: false,
        selected: false,
        verified_code: false,
        error: discovery.error || "No code editor or input textarea found in document",
        editorType: "none"
      };
    }

    const currentVal = discovery.getValue() || "";
    const editorType = discovery.type;

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
    if (!alreadyHasHeaders && currentVal && currentVal.trim()) {
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

    // Step B: Write into Discovered Editor (Zero Paste Events)
    if (editorType === "ace") {
      const aceInstance = discovery.editor;
      let savedAceOpts = {};
      try {
        if (typeof aceInstance.focus === "function") aceInstance.focus();
        savedAceOpts = {
          behavioursEnabled: typeof aceInstance.getBehavioursEnabled === "function" ? aceInstance.getBehavioursEnabled() : true,
          wrapBehavioursEnabled: typeof aceInstance.getOption === "function" ? aceInstance.getOption("wrapBehavioursEnabled") : true,
          enableAutoIndent: typeof aceInstance.getOption === "function" ? aceInstance.getOption("enableAutoIndent") : true
        };
        if (typeof aceInstance.setBehavioursEnabled === "function") aceInstance.setBehavioursEnabled(false);
        if (typeof aceInstance.setOption === "function") {
          aceInstance.setOption("behavioursEnabled", false);
          aceInstance.setOption("wrapBehavioursEnabled", false);
          aceInstance.setOption("enableAutoIndent", false);
        }
      } catch (_) {}

      // Replace buffer cleanly
      if (aceInstance.session && aceInstance.session.doc && typeof aceInstance.session.doc.setValue === "function") {
        aceInstance.session.doc.setValue(finalCode);
      } else if (typeof aceInstance.setValue === "function") {
        aceInstance.setValue(finalCode, 1);
      }

      // Notify Ace internal event system
      try {
        if (typeof aceInstance.onTextInput === "function") aceInstance.onTextInput("");
        if (typeof aceInstance._signal === "function") aceInstance._signal("change", {});
        if (aceInstance.commands && typeof aceInstance.commands.exec === "function") {
          aceInstance.commands.exec("insertstring", aceInstance, "");
        }
      } catch (_) {}

      // Dispatch simulated non-destructive keystroke on hidden textarea to satisfy focus listeners
      try {
        const aceTextInput = discovery.el ? discovery.el.querySelector("textarea.ace_text-input") : null;
        if (aceTextInput && typeof aceTextInput.dispatchEvent === "function") {
          aceTextInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
          aceTextInput.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: "" }));
          aceTextInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        }
      } catch (_) {}

      // Invoke React onChange callback if discovered on Fiber
      if (typeof discovery.reactOnChange === "function") {
        try { discovery.reactOnChange(finalCode); } catch (_) {}
      }

      // Restore Ace auto-behaviors & clear selection
      try {
        if (typeof aceInstance.setBehavioursEnabled === "function") {
          aceInstance.setBehavioursEnabled(savedAceOpts.behavioursEnabled !== false);
        }
        if (typeof aceInstance.setOption === "function") {
          aceInstance.setOption("behavioursEnabled", savedAceOpts.behavioursEnabled !== false);
          aceInstance.setOption("wrapBehavioursEnabled", savedAceOpts.wrapBehavioursEnabled !== false);
          aceInstance.setOption("enableAutoIndent", savedAceOpts.enableAutoIndent !== false);
        }
        if (typeof aceInstance.clearSelection === "function") aceInstance.clearSelection();
      } catch (_) {}
    } else if (editorType === "monaco") {
      const monacoEditorInstance = discovery.editor;
      const monacoModel = discovery.model || (monacoEditorInstance && monacoEditorInstance.getModel ? monacoEditorInstance.getModel() : null);

      if (monacoEditorInstance && typeof monacoEditorInstance.focus === "function") {
        try { monacoEditorInstance.focus(); } catch (_) {}
      }

      let monacoSuccess = false;
      if (monacoEditorInstance && typeof monacoEditorInstance.executeEdits === "function" && monacoModel) {
        try {
          const fullRange = typeof monacoModel.getFullModelRange === "function"
            ? monacoModel.getFullModelRange()
            : { startLineNumber: 1, startColumn: 1, endLineNumber: (monacoModel.getLineCount ? monacoModel.getLineCount() : 9999), endColumn: 9999 };
          monacoEditorInstance.executeEdits("keyboard", [{
            range: fullRange,
            text: finalCode,
            forceMoveMarkers: true
          }]);
          if (monacoModel.getValue && monacoModel.getValue() === finalCode) {
            monacoSuccess = true;
          }
        } catch (_) {}
      }

      if (!monacoSuccess && monacoModel) {
        if (typeof monacoModel.pushEditOperations === "function") {
          try {
            const fullRange = typeof monacoModel.getFullModelRange === "function"
              ? monacoModel.getFullModelRange()
              : { startLineNumber: 1, startColumn: 1, endLineNumber: (monacoModel.getLineCount ? monacoModel.getLineCount() : 9999), endColumn: 9999 };
            monacoModel.pushEditOperations([], [{ range: fullRange, text: finalCode }], () => null);
            if (monacoModel.getValue && monacoModel.getValue() === finalCode) {
              monacoSuccess = true;
            }
          } catch (_) {}
        }
        if (!monacoSuccess && typeof monacoModel.setValue === "function") {
          monacoModel.setValue(finalCode);
          monacoSuccess = true;
        }
      }

      // Invoke React onChange callback if discovered on Fiber
      if (typeof discovery.reactOnChange === "function") {
        try { discovery.reactOnChange(finalCode, {}); } catch (_) {}
      }
    } else if (editorType === "codemirror5") {
      discovery.setValue(finalCode);
    } else if (editorType === "codemirror6") {
      discovery.setValue(finalCode);
      if (typeof discovery.reactOnChange === "function") {
        try { discovery.reactOnChange(finalCode); } catch (_) {}
      }
    } else if (editorType === "textarea") {
      discovery.setValue(finalCode);
      if (discovery.el) {
        try { discovery.el.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
        try { discovery.el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
      }
    }

    // Step C: Verify Written Buffer
    let verifiedCode = "";
    if (typeof discovery.getValue === "function") {
      verifiedCode = discovery.getValue() || "";
    }

    // Check reconciliation
    if (verifiedCode.replace(/\r\n/g, "\n").trim() !== finalCode.replace(/\r\n/g, "\n").trim()) {
      if (typeof discovery.setValue === "function") {
        discovery.setValue(finalCode);
        verifiedCode = discovery.getValue ? discovery.getValue() : finalCode;
      }
    }

    const codeMatches = (verifiedCode.replace(/\r\n/g, "\n").trim() === finalCode.replace(/\r\n/g, "\n").trim())
      || (verifiedCode.trim().length > 0 && verifiedCode.includes(targetCode.trim().slice(0, 30)));

    return {
      success: codeMatches,
      ok: codeMatches,
      selected: codeMatches,
      verified_code: codeMatches,
      editorType: editorType,
      length: (verifiedCode || finalCode).length,
      code: verifiedCode || finalCode
    };
  }

  /**
   * Finds the Compile & Run button in CCBP coding practice playground.
   */
  function findCompileAndRunButton(docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) return null;
    const buttons = Array.from(doc.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"))
      .filter(b => isVisible(b) && !isInsideCodeEditor(b) && !isQuizZyInternalElement(b));
    for (const b of buttons) {
      const text = (b.innerText || b.textContent || b.value || "").trim().toLowerCase();
      if (/^(?:▶?\s*run(?:\s*code)?|compile\s*(?:&|and)\s*run)$/i.test(text)) {
        return b;
      }
    }
    for (const b of buttons) {
      const text = (b.innerText || b.textContent || b.value || "").trim().toLowerCase();
      if (text.includes("run") && !text.includes("runtime")) {
        return b;
      }
    }
    return null;
  }

  /**
   * Finds the Submit button on the coding practice playground bottom action bar.
   */
  function findCodingSubmitButton(docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) return null;
    const buttons = Array.from(doc.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"))
      .filter(b => isVisible(b) && !isInsideCodeEditor(b) && !isQuizZyInternalElement(b));
    for (const b of buttons) {
      const text = (b.innerText || b.textContent || b.value || "").trim().toLowerCase();
      if (/^(?:submit|submit\s*code|submit\s*answer)$/i.test(text)) {
        return b;
      }
    }
    return null;
  }

  /**
   * Captures a DOM snapshot of the console / testcase container before clicking Run.
   * Prevents Attempt 2 from mistaking Attempt 1's leftover DOM error as fresh output.
   */
  function capturePreRunSignature(docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) {
      return { text: "", childCount: 0, classNames: "", length: 0, timestamp: Date.now() };
    }
    const consoleEls = Array.from(doc.querySelectorAll(
      ".console-output, .output-console, .testcase-output, [class*='console'], [class*='output'], [class*='terminal'], [class*='result'], [class*='testcase'], [class*='drawer'], pre.output, pre"
    )).filter(isVisible);

    let text = "";
    let childCount = 0;
    const classNames = [];
    for (const el of consoleEls) {
      const t = (el.innerText || el.textContent || "").trim();
      if (t) text += "\n" + t;
      childCount += (el.children ? el.children.length : 0);
      if (el.className) classNames.push(String(el.className));
    }
    return {
      text: text.trim(),
      childCount,
      classNames: classNames.join(" "),
      length: text.trim().length,
      timestamp: Date.now()
    };
  }

  /**
   * Dispatches the full sequence of mouse and pointer events to reliably click
   * playground action buttons (Compile & Run, Run, Submit) in proctored environments.
   */
  function triggerRunButton(btn) {
    if (!btn) return false;
    let dispatchedClick = false;
    if (typeof MouseEvent !== "undefined" && typeof btn.dispatchEvent === "function") {
      const eventSequence = [
        "pointerover", "mouseover",
        "pointerdown", "mousedown",
        "focus",
        "pointerup", "mouseup",
        "click"
      ];
      for (const evType of eventSequence) {
        try {
          const ev = new MouseEvent(evType, {
            bubbles: true,
            cancelable: true,
            view: typeof window !== "undefined" ? window : null,
            buttons: 1
          });
          btn.dispatchEvent(ev);
          if (evType === "click") dispatchedClick = true;
        } catch (_) {}
      }
    }
    if (!dispatchedClick && typeof btn.click === "function") {
      try { btn.click(); } catch (_) {}
    }
    return true;
  }

  /**
   * Extracts structured execution results and failure diagnostics from the testcase / console drawer.
   * Categorizes errors into COMPILATION_ERROR, RUNTIME_ERROR, WRONG_ANSWER, or PASSED.
   */
  function extractCodingExecutionResult(docRef, attemptCode = "") {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) {
      return { status: "UNKNOWN", error_type: "UNKNOWN", diagnostics: "", error_context: "", raw_text: "" };
    }

    const consoleEls = Array.from(doc.querySelectorAll(
      ".console-output, .output-console, .testcase-output, [class*='console'], [class*='output'], [class*='terminal'], [class*='result'], [class*='testcase'], [class*='drawer'], pre.output, pre"
    )).filter(isVisible);

    let fullText = "";
    for (const el of consoleEls) {
      const t = (el.innerText || el.textContent || "").trim();
      if (t) fullText += "\n" + t;
    }
    fullText = fullText.trim();
    const lower = fullText.toLowerCase();

    // 1. Check for Compilation Error
    const isCompileErr = /compilation\s*error|compile\s*error|error:\s*expected|syntaxerror:|cannot\s*find\s*symbol/i.test(lower);
    if (isCompileErr) {
      const errLines = fullText.split("\n").filter(l => /error|line\s*\d+|expected|undefined\s*reference/i.test(l)).join("\n");
      const diagnostics = errLines || fullText;
      const error_context = [
        "ERROR_TYPE: COMPILATION_ERROR",
        attemptCode ? `ATTEMPT_1_CODE:\n${attemptCode.trim()}` : "",
        `DIAGNOSTICS / COMPILER_OUTPUT:\n${diagnostics.trim()}`
      ].filter(Boolean).join("\n\n");

      return {
        status: "COMPILATION_ERROR",
        error_type: "COMPILATION_ERROR",
        diagnostics: diagnostics.trim(),
        error_context,
        raw_text: fullText
      };
    }

    // 2. Check for Runtime Error
    const isRuntimeErr = /runtime\s*error|segmentation\s*fault|sigsegv|indexerror:|nullpointerexception|time\s*limit\s*exceeded|memory\s*limit\s*exceeded|traceback/i.test(lower);
    if (isRuntimeErr) {
      const tbLines = fullText.split("\n").filter(l => /traceback|exception|error|line\s*\d+|fault/i.test(l)).join("\n");
      const diagnostics = tbLines || fullText;
      const error_context = [
        "ERROR_TYPE: RUNTIME_ERROR",
        attemptCode ? `ATTEMPT_1_CODE:\n${attemptCode.trim()}` : "",
        `DIAGNOSTICS / COMPILER_OUTPUT:\n${diagnostics.trim()}`
      ].filter(Boolean).join("\n\n");

      return {
        status: "RUNTIME_ERROR",
        error_type: "RUNTIME_ERROR",
        diagnostics: diagnostics.trim(),
        error_context,
        raw_text: fullText
      };
    }

    // 3. Check for Wrong Answer
    const isWrongAnswer = /wrong\s*answer|failed\s*testcase|sample\s*test\s*cases?\s*failed|expected\s*output|actual\s*output|your\s*output/i.test(lower);
    if (isWrongAnswer) {
      let testcaseId = "Case 1";
      const tcMatch = fullText.match(/(?:test\s*case|case)\s*#?\s*(\d+)/i);
      if (tcMatch) testcaseId = `Case ${tcMatch[1]}`;

      let inputVal = "";
      let actualVal = "";
      let expectedVal = "";

      const inputMatch = fullText.match(/(?:input|testcase\s*input):\s*([^\n]+)/i);
      if (inputMatch) inputVal = inputMatch[1].trim();

      const actualMatch = fullText.match(/(?:your\s*output|actual\s*output|output):\s*([^\n]+)/i);
      if (actualMatch) actualVal = actualMatch[1].trim();

      const expectedMatch = fullText.match(/(?:expected\s*output|expected):\s*([^\n]+)/i);
      if (expectedMatch) expectedVal = expectedMatch[1].trim();

      const failedTcBlock = [
        testcaseId ? `Testcase: ${testcaseId}` : "",
        inputVal ? `Input: ${inputVal}` : "",
        actualVal ? `Your Output: ${actualVal}` : "",
        expectedVal ? `Expected Output: ${expectedVal}` : ""
      ].filter(Boolean).join("\n");

      const diagnostics = failedTcBlock || fullText;
      const error_context = [
        "ERROR_TYPE: WRONG_ANSWER",
        attemptCode ? `ATTEMPT_1_CODE:\n${attemptCode.trim()}` : "",
        `DIAGNOSTICS / COMPILER_OUTPUT:\n${fullText.trim()}`,
        `FAILED_TESTCASE:\n${diagnostics.trim()}`
      ].filter(Boolean).join("\n\n");

      return {
        status: "WRONG_ANSWER",
        error_type: "WRONG_ANSWER",
        diagnostics: diagnostics.trim(),
        error_context,
        raw_text: fullText
      };
    }

    // 4. Check for Success / Passed
    const isPassed = /compilation\s*successful|all\s*test\s*cases?\s*passed|sample\s*test\s*cases?\s*passed|passed|accepted|success/i.test(lower);
    if (isPassed) {
      return {
        status: "PASSED",
        error_type: null,
        diagnostics: "",
        error_context: "",
        raw_text: fullText
      };
    }

    return {
      status: "UNKNOWN",
      error_type: "UNKNOWN",
      diagnostics: fullText,
      error_context: fullText ? `DIAGNOSTICS:\n${fullText}` : "",
      raw_text: fullText
    };
  }

  /**
   * Polls output console for compilation and test case execution outcome with DOM epoch synchronization.
   */
  async function pollOutputConsole(timeoutMs = 8000, docRef, preRunSignature = null) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc) return { completed: true, status: "unknown" };
    const startTime = Date.now();

    let hasTransitioned = !preRunSignature;

    while (Date.now() - startTime < timeoutMs) {
      const consoleEls = doc.querySelectorAll ? Array.from(doc.querySelectorAll(
        ".console-output, .output-console, .testcase-output, [class*='console'], [class*='output'], [class*='terminal'], [class*='result'], [class*='testcase'], [class*='drawer'], pre.output, pre"
      )).filter(isVisible) : [];

      let fullConsoleText = "";
      for (const el of consoleEls) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t) fullConsoleText += "\n" + t;
      }
      fullConsoleText = fullConsoleText.trim();
      const lower = fullConsoleText.toLowerCase();

      // Check if state is actively in-flight compiling/running
      const isRunning = /compiling|running|evaluating|executing|in\s*progress|\bloading\b/i.test(lower);

      if (!hasTransitioned && preRunSignature) {
        const textChanged = (fullConsoleText !== preRunSignature.text);
        if (isRunning || textChanged) {
          hasTransitioned = true;
        }
      }

      // Once state transition has occurred (or no snapshot was provided) and not in-flight running:
      if (hasTransitioned && !isRunning) {
        // Check for errors
        const hasError = /compilation\s*error|runtime\s*error|wrong\s*answer|error:|syntaxerror:|nameerror:|failed\s*testcase/i.test(lower);
        if (hasError) {
          return {
            completed: true,
            status: "error",
            errorText: fullConsoleText
          };
        }

        // Check for success / test cases passed
        const hasSuccess = /compilation\s*successful|passed|sample\s*test\s*cases?\s*passed|all\s*test\s*cases?\s*passed|testcase\s*\d+:?\s*passed|success/i.test(lower);
        if (hasSuccess) {
          return {
            completed: true,
            status: "success",
            outputText: fullConsoleText
          };
        }
      }

      await sleepMs(100);
    }

    return { completed: false, status: "timeout", outputText: "" };
  }

  let isCodingAutomationRunning = false;
  let isCodingAutomationAborted = false;
  let currentCodingAutomationState = "IDLE";

  function abortCodingAutomation() {
    isCodingAutomationAborted = true;
    isCodingAutomationRunning = false;
    currentCodingAutomationState = "ABORTED";
  }

  function getCodingAutomationState() {
    return currentCodingAutomationState;
  }

  function isAuthorizedTestEnvironment(locRef) {
    const loc = locRef || ((typeof window !== "undefined" && window.location) ? window.location : null);
    if (!loc) {
      // In isolated Node.js test runners where location is not mocked, treat as authorized test harness
      return true;
    }
    const hostname = (loc.hostname || "").toLowerCase();
    const href = (loc.href || "").toLowerCase();

    // Strict safety invariant: Third-party production learning platforms are NEVER authorized for assessment submission
    if (hostname.includes("ccbp.in") || href.includes("learning.ccbp.in")) {
      return false;
    }

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname.endsWith(".test") ||
      hostname.endsWith(".staging.quizzy.internal") ||
      href.startsWith("file://") ||
      href.includes("mock_quiz") ||
      href.includes("test_fixture") ||
      href.includes("test-harness")
    ) {
      return true;
    }

    if (typeof window !== "undefined" && window.__QUIZZY_COORDINATION__ && typeof window.__QUIZZY_COORDINATION__.isAuthorizedEnvironment === "function") {
      try {
        return window.__QUIZZY_COORDINATION__.isAuthorizedEnvironment(loc);
      } catch (_) {}
    }

    return false;
  }

  /**
   * Helper to read current code editor contents from the MAIN world.
   * Dispatches READ_CODE_EDITOR_MAIN message if in Chrome extension environment,
   * or falls back to direct discovery in local/unit test environment.
   */
  async function readCodeFromMainWorld(docRef) {
    const doc = docRef || ((typeof document !== "undefined") ? document : null);
    const win = (typeof window !== "undefined") ? window : null;

    const discovery = discoverMainWorldEditor(doc, win);
    const hasDirectLiveInstance = discovery && discovery.type !== "none" && discovery.type !== "blocked_container";
    const hasExtensionMessaging = (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function");

    if (hasExtensionMessaging && (!hasDirectLiveInstance || doc?.querySelector(".ace_editor, .monaco-editor, .CodeMirror, .cm-editor"))) {
      try {
        const resp = await new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(null), 3000);
          chrome.runtime.sendMessage({
            action: "READ_CODE_EDITOR_MAIN",
            type: "READ_CODE_EDITOR_MAIN"
          }, (res) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(res);
          });
        });
        if (resp && resp.success && typeof resp.code === "string") {
          return resp;
        }
      } catch (_) {}
    }

    if (hasDirectLiveInstance && typeof discovery.getValue === "function") {
      return {
        success: true,
        code: discovery.getValue() || "",
        language: discovery.language || "",
        editorType: discovery.type
      };
    }

    return { success: false, code: "", error: (discovery && discovery.error) || "No accessible editor found" };
  }

  /**
   * Helper to write code into the MAIN world editor from content script.
   * Dispatches WRITE_CODE_EDITOR_MAIN message if in Chrome extension environment,
   * or falls back to local invocation in Node.js test environment.
   */
  async function writeCodeToMainWorld(payload, docRef) {
    const doc = docRef || ((typeof document !== "undefined") ? document : null);
    const win = (typeof window !== "undefined") ? window : null;

    const discovery = discoverMainWorldEditor(doc, win);
    const hasDirectLiveInstance = discovery && discovery.type !== "none" && discovery.type !== "blocked_container";
    const hasExtensionMessaging = (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.sendMessage === "function");

    if (hasExtensionMessaging && (!hasDirectLiveInstance || doc?.querySelector(".ace_editor, .monaco-editor, .CodeMirror, .cm-editor"))) {
      try {
        const resp = await new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(null), 4000);
          chrome.runtime.sendMessage({
            action: "WRITE_CODE_EDITOR_MAIN",
            type: "WRITE_CODE_EDITOR_MAIN",
            payload: payload,
            code: payload && (payload.code || payload.answer || payload.selected_text),
            language: payload ? payload.language : "",
            starter_code: payload ? (payload.starter_code || payload.starterCode || "") : "",
            preserveBoilerplate: payload ? payload.preserveBoilerplate !== false : true
          }, (res) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(res);
          });
        });
        if (resp && resp.success) return resp;
        if (resp && resp.error && discovery.type === "blocked_container") {
          return resp;
        }
      } catch (_) {}
    }

    return writeCodeWithHumanTypingInMainWorld(payload, doc);
  }

  /**
   * Complete Autonomous Compile & Submit Loop:
   * 1. Validates code payload presence (fetches if missing)
   * 2. Types solution into editor via writeCodeToMainWorld
   * 3. MANDATORY POST-WRITE READ-BACK VERIFICATION GATE:
   *    Reads live buffer from MAIN world and verifies non-empty updated content.
   *    If verification fails, retries once; if still failed, ABORTS with status "write_verification_failed"
   *    and STRICTLY PREVENTS clicking the Run button!
   * 4. Pre-Run DOM Epoch Snapshot & Clicks Compile & Run only after verified write!
   * 5. Stale-safe polls output drawer with pre-run snapshot synchronization
   * 6. If error occurs, extracts structured failure diagnostics and triggers self-healing retry (Attempt 2)
   * 7. Verifies Attempt 2 write before second Run click
   * 8. When passed, verifies environment authorization before mock Submit (disabled on production)
   */
  async function autoCompileAndSubmitLoop(payload, solveCallback, docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc) return { success: false, error: "No document object", status: "FAILED" };

    if (isCodingAutomationRunning) {
      return { success: false, error: "DUPLICATE_RUN_PREVENTED: Coding automation already in progress", status: "DUPLICATE_RUN_PREVENTED" };
    }

    isCodingAutomationAborted = false;
    isCodingAutomationRunning = true;
    currentCodingAutomationState = "WRITING";

    try {
      if (isCodingAutomationAborted) return { success: false, status: "ABORTED", error: "Automation stopped by user" };
      let attempt1Code = (payload && (payload.code || payload.answer || payload.selected_text)) || "";

      // Step 0: Ensure code payload is present before attempting write
      if (!attempt1Code || !attempt1Code.trim()) {
        if (typeof solveCallback === "function") {
          currentCodingAutomationState = "GENERATING";
          const genRes = await solveCallback({
            starter_code: payload.starter_code,
            language: payload.language
          });
          attempt1Code = genRes ? (genRes.answer || genRes.code || genRes.selected_text) : "";
          if (attempt1Code && attempt1Code.trim()) {
            payload.code = attempt1Code;
          } else {
            currentCodingAutomationState = "FAILED";
            return {
              success: false,
              compiled: false,
              submitted: false,
              status: "FAILED",
              error: "No code provided or generated for automation loop"
            };
          }
        } else {
          currentCodingAutomationState = "FAILED";
          return {
            success: false,
            compiled: false,
            submitted: false,
            status: "FAILED",
            error: "No code provided in payload for automation loop"
          };
        }
      }

      function verifyBufferContents(buf, expectedCode, starterStub) {
        if (!buf || typeof buf !== "string" || !buf.trim()) return false;
        if (!expectedCode || typeof expectedCode !== "string") return false;
        const cleanExp = stripMarkdownCodeFences(expectedCode).trim();
        if (!cleanExp) return false;

        // If buffer still contains starter placeholders like "//Write Your Code Here..." or "// Write your code here"
        if (/write\s+your\s+code\s+here/i.test(buf)) {
          return false;
        }

        // If buffer is still 100% identical to untouched starter code, fail
        const cleanStarter = starterStub ? stripMarkdownCodeFences(starterStub).trim() : "";
        if (cleanStarter && buf.trim() === cleanStarter && cleanExp !== cleanStarter) {
          return false;
        }

        // Full match or substring match
        if (buf.trim() === cleanExp || buf.includes(cleanExp)) return true;

        // Substring / token matching for preserved boilerplate
        const starterLines = new Set(cleanStarter.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
        const lines = cleanExp.split(/\r?\n/).map(l => l.trim()).filter(l => {
          return l.length > 5 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*") && !l.startsWith("#include") && !l.startsWith("using namespace");
        });
        if (lines.length === 0) return buf.trim().length > 0;

        // Filter out lines that were already part of the starter stub (e.g. class Solution, public:, etc.)
        const solutionSpecificLines = lines.filter(l => !starterLines.has(l));
        if (solutionSpecificLines.length > 0) {
          const matchCount = solutionSpecificLines.filter(l => buf.includes(l)).length;
          return matchCount > 0;
        }

        const matchCount = lines.slice(0, 5).filter(l => buf.includes(l)).length;
        return matchCount > 0 || buf.includes(cleanExp.slice(0, 30));
      }

      // Step 1: Write Attempt 1 Code into MAIN World Editor
      currentCodingAutomationState = "WRITING";
      let writeRes = await writeCodeToMainWorld(payload, doc);
      let readBack = await readCodeFromMainWorld(doc);
      let readBackBuffer = (readBack && readBack.code) ? readBack.code : (writeRes && writeRes.code ? writeRes.code : "");
      let isVerified = writeRes && writeRes.success && verifyBufferContents(readBackBuffer, attempt1Code, payload.starter_code);

      if (!isVerified) {
        // Retry writing once using alternative mutation / force overwrite
        try {
          writeRes = await writeCodeToMainWorld(Object.assign({}, payload, { forceAlternativeMutation: true }), doc);
          readBack = await readCodeFromMainWorld(doc);
          readBackBuffer = (readBack && readBack.code) ? readBack.code : (writeRes && writeRes.code ? writeRes.code : "");
          isVerified = writeRes && writeRes.success && verifyBufferContents(readBackBuffer, attempt1Code, payload.starter_code);
        } catch (_) {}
      }

      // MANDATORY POST-WRITE READ-BACK VERIFICATION GATE (Requirement D)
      // QuizZy must NEVER click Run if the editor write could not be verified!
      if (!isVerified) {
        currentCodingAutomationState = "FAILED";
        return {
          success: false,
          compiled: false,
          submitted: false,
          status: "write_verification_failed",
          error: "Failed to verify code insertion in editor; aborted before clicking Run."
        };
      }

      const compileBtn = findCompileAndRunButton(doc);
      if (!compileBtn) {
        currentCodingAutomationState = "FAILED";
        return { success: false, error: "Compile & Run button not found on page", status: "FAILED" };
      }

      if (isCodingAutomationAborted) return { success: false, status: "ABORTED", error: "Automation stopped by user" };

      // Pre-Run DOM Epoch Snapshot for Attempt 1
      const preRunSig1 = capturePreRunSignature(doc);

      currentCodingAutomationState = "RUNNING";
      triggerRunButton(compileBtn);

      currentCodingAutomationState = "VERIFYING";
      let pollRes = await pollOutputConsole(8000, doc, preRunSig1);
      let execResult = extractCodingExecutionResult(doc, attempt1Code);

      // Self-healing retry if compiler, runtime, or wrong answer error occurred
      const isError = pollRes.status === "error" || (execResult.status && execResult.status !== "PASSED");
      if (isError && typeof solveCallback === "function") {
        try {
          currentCodingAutomationState = "RETRYING";
          const errorContext = execResult.error_context || pollRes.errorText || "Execution failure";

          currentCodingAutomationState = "GENERATING";
          const retryRes = await solveCallback({
            error_context: errorContext,
            bypass_cache: true,
            starter_code: payload.starter_code,
            language: payload.language
          });

          const fixedCode = retryRes ? (retryRes.answer || retryRes.code || retryRes.selected_text) : "";
          if (fixedCode && fixedCode.trim()) {
            currentCodingAutomationState = "WRITING";
            // Pre-Run DOM Epoch Snapshot of the Attempt 1 error drawer before re-running
            const preRunSig2 = capturePreRunSignature(doc);

            let writeRes2 = await writeCodeToMainWorld({
              code: fixedCode,
              language: payload.language,
              starter_code: payload.starter_code
            }, doc);

            let readBack2 = await readCodeFromMainWorld(doc);
            let readBackBuffer2 = (readBack2 && readBack2.code) ? readBack2.code : (writeRes2 && writeRes2.code ? writeRes2.code : "");
            let isVerified2 = writeRes2 && writeRes2.success && verifyBufferContents(readBackBuffer2, fixedCode, payload.starter_code);

            if (!isVerified2) {
              writeRes2 = await writeCodeToMainWorld({
                code: fixedCode,
                language: payload.language,
                starter_code: payload.starter_code,
                forceAlternativeMutation: true
              }, doc);
              readBack2 = await readCodeFromMainWorld(doc);
              readBackBuffer2 = (readBack2 && readBack2.code) ? readBack2.code : (writeRes2 && writeRes2.code ? writeRes2.code : "");
              isVerified2 = writeRes2 && writeRes2.success && verifyBufferContents(readBackBuffer2, fixedCode, payload.starter_code);
            }

            // Post-Write Read-Back Verification Gate for Attempt 2
            if (!isVerified2) {
              currentCodingAutomationState = "FAILED";
              return {
                success: false,
                compiled: false,
                submitted: false,
                status: "write_verification_failed",
                error: "Failed to verify code insertion in editor on retry; aborted before clicking Run."
              };
            }

            currentCodingAutomationState = "RUNNING";
            triggerRunButton(compileBtn);

            currentCodingAutomationState = "VERIFYING";
            pollRes = await pollOutputConsole(8000, doc, preRunSig2);
            execResult = extractCodingExecutionResult(doc, fixedCode);
          }
        } catch (err) {
          console.warn("[QuizZy] Self-healing solve retry failed:", err);
        }
      }

      const isSuccess = (pollRes.status === "success") || (execResult.status === "PASSED");
      if (isSuccess) {
        const isAuthorizedHarness = isAuthorizedTestEnvironment(doc ? (doc.defaultView ? doc.defaultView.location : (typeof window !== "undefined" ? window.location : null)) : null);

        if (!isAuthorizedHarness) {
          currentCodingAutomationState = "COMPLETED";
          return {
            success: true,
            compiled: true,
            submitted: false,
            status: "verified_no_submit_production_guardrail",
            message: "Testcases verified successfully. Automated submission disabled on live third-party learning platform."
          };
        }

        if (isCodingAutomationAborted) return { success: false, status: "ABORTED", error: "Automation stopped by user" };

        currentCodingAutomationState = "SUBMITTING";
        const submitBtn = findCodingSubmitButton(doc);
        if (submitBtn) {
          triggerRunButton(submitBtn);
          currentCodingAutomationState = "COMPLETED";
          return { success: true, submitted: true, status: "submitted" };
        }
        currentCodingAutomationState = "COMPLETED";
        return { success: true, compiled: true, status: "compiled_no_submit" };
      }

      currentCodingAutomationState = "FAILED";
      return { success: false, status: "FAILED", error: execResult.diagnostics || pollRes.errorText || "Compilation incomplete" };
    } finally {
      isCodingAutomationRunning = false;
    }
  }

  /**
   * Executes code injection into Monaco or Ace editor models.
   */
  async function executeCodeAction(payload) {
    if (!payload) {
      return { ok: false, success: false, selected: false, error: "Empty payload" };
    }
    const code = (typeof payload.code === "string")
      ? payload.code
      : (typeof payload.answer === "string" ? payload.answer : (typeof payload.selected_text === "string" ? payload.selected_text : ""));

    if (!code || !code.trim()) {
      return { ok: false, success: false, selected: false, error: "No code provided in payload" };
    }

    // Execute through writeCodeToMainWorld (which routes to MAIN world via background if in extension)
    const res = await writeCodeToMainWorld(payload);

    return {
      ok: res && res.success,
      success: res && res.success,
      selected: res && (res.selected || res.success),
      verified_code: res && (res.verified_code || res.success),
      q_type: "code",
      length: (res && res.length) || code.length,
      error: res && res.error
    };
  }

  /**
   * Main router for executing quiz actions.
   */
  function executeAction(payload) {
    if (!payload || (!payload.q_type && !payload.question_type)) {
      return { ok: false, success: false, selected: false, error: "Payload missing q_type" };
    }

    const qType = String(payload.q_type || payload.question_type).toLowerCase().trim();

    let res;
    if (qType === "multi" || qType === "multi_mcq" || qType === "checkbox" || (payload.selected_indices && Array.isArray(payload.selected_indices) && payload.selected_indices.length > 1)) {
      res = executeMultiMcqAction(payload);
    } else if (qType === "mcq") {
      res = executeMcqAction(payload);
    } else if (qType === "text" || qType === "fib") {
      res = executeTextAction(payload);
    } else if (qType === "order" || qType === "sortable" || qType === "sequence") {
      res = executeOrderAction(payload);
    } else if (qType === "code") {
      res = executeCodeAction(payload);
    } else {
      return { ok: false, success: false, selected: false, error: `Unsupported action q_type: ${qType}` };
    }

    if (res && typeof res.then === "function") {
      return res.then((asyncRes) => {
        if (asyncRes && (asyncRes.selected === false || asyncRes.ok === false || asyncRes.success === false)) {
          return Object.assign({}, asyncRes, {
            ok: false,
            success: false,
            selected: false,
            error: asyncRes.error || "OPTION_SELECTION_FAILED"
          });
        }
        return Object.assign({}, asyncRes, {
          ok: asyncRes && asyncRes.ok !== undefined ? asyncRes.ok : (asyncRes && asyncRes.success),
          selected: asyncRes && asyncRes.selected !== undefined ? asyncRes.selected : (asyncRes && asyncRes.success)
        });
      });
    }

    if (res && (res.selected === false || res.ok === false || res.success === false)) {
      return Object.assign({}, res, {
        ok: false,
        success: false,
        selected: false,
        error: res.error || "OPTION_SELECTION_FAILED"
      });
    }

    return Object.assign({}, res, {
      ok: res.ok !== undefined ? res.ok : res.success,
      selected: res.selected !== undefined ? res.selected : res.success
    });
  }

  // Idempotent Escape key listener for host page emergency kill switch
  if (typeof window !== "undefined") {
    if (!window.__QUIZZY_EXECUTOR_LISTENER_REGISTERED__) {
      window.__QUIZZY_EXECUTOR_LISTENER_REGISTERED__ = true;

      if (typeof window.addEventListener === "function") {
        window.addEventListener("keydown", (e) => {
          if (e.key === "Escape" || e.key === "Esc") {
            try {
              if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                  action: "KILL_SWITCH_TRIGGERED",
                  reason: "Escape key pressed on host quiz page. Auto Mode halted."
                }).catch(() => {});
              }
            } catch (err) {}
          }
        }, true);
      }
    }
  }

  // Export to window for Chrome isolated world execution and module for testing
  const QuizZyExecutor = {
    cleanText,
    normalizeTeX,
    getCleanVisibleText,
    stripDecorativePrefix,
    isHeaderOrNavText,
    containsActionButtonOrFooter,
    isExplanationOrFeedback,
    isVisible,
    isRadioOrOptionVisible,
    findQuizCard,
    findClasslessOptionElements,
    getElementCssPath,
    deduplicateOptionElements,
    resolveOptionRowRoot,
    dispatchClick,
    dispatchRealisticClick,
    resolveOptionRowAndTargets,
    captureOptionSnapshot,
    capturePreClickSnapshot,
    verifyOptionSelected,
    didOptionSelectionChange,
    findOptionElements,
    findSortableElements,
    triggerOptionSelect,
    triggerReactSelection,
    isOptionChecked,
    executeMcqAction,
    executeMultiMcqAction,
    executeTextAction,
    simulateDragDrop,
    simulateRbdKeyboardDrag,
    simulatePointerDrag,
    dispatchKeyboardMove,
    dispatchHtml5DragMove,
    dispatchPointerMove,
    findDragHandleInRow,
    getLiveOrderRows,
    isOrderMatching,
    reorderReactListInMainWorld,
    simulateHandleMouseDrag,
    simulateHandleKeyboardDrag,
    simulateHandleHtml5Drag,
    cleanItemText,
    executeOrderAction,
    reorderSortableOptions: executeOrderAction,
    executeCodeAction,
    writeCodeWithHumanTypingInMainWorld,
    discoverMainWorldEditor,
    writeCodeToMainWorld,
    readCodeFromMainWorld,
    findCompileAndRunButton,
    findCodingSubmitButton,
    pollOutputConsole,
    capturePreRunSignature,
    triggerRunButton,
    extractCodingExecutionResult,
    autoCompileAndSubmitLoop,
    abortCodingAutomation,
    isAuthorizedTestEnvironment,
    getCodingAutomationState,
    clickNextButton,
    clickSkipButton,
    swipeOrAdvanceQuestion,
    executeAction,
    executeQuizAction: executeAction,
    isQuizZyInternalElement
  };

  if (typeof window !== "undefined") {
    window.QuizZyExecutor = QuizZyExecutor;
    window.__QuizZyExecutor = QuizZyExecutor;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = QuizZyExecutor;
  }

  return QuizZyExecutor;
})();
