/**
 * QuizZy - Read-Only DOM Extractor
 * 
 * Strict Zero-DOM-Mutation by default:
 * extractQuizFromDom performs purely read-only queries (querySelector, textContent,
 * getAttribute, etc.) and NEVER mutates DOM nodes, attributes, classes, or styles.
 */

(function () {
  "use strict";

  /**
   * Detects proctored coding practice environments (such as learning.ccbp.in/question/*
   * or pages containing Monaco / Ace code editors) where aggressive anti-cheat MutationObservers
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
   * Helper that decodes URL-encoded parameters or CloudFront URL fragments.
   * Handles multi-pass percent-encoding up to 3 times (e.g. https%3A%2F%2F...).
   */
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

  /**
   * Checks whether valid quiz options (radios, checkboxes, option cards, or MCQ practice header)
   * exist on the page outside any code editor.
   * Strict MCQ vs Code Rule: If the page has >= 2 clickable options or option cards,
   * it MUST return true (indicating quiz mode), even on coding practice pages.
   */
  function hasQuizOptionsOutsideEditor(docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc) return false;
    try {
      // 1. Check for radio buttons outside code editor
      const allRadios = doc.querySelectorAll ? Array.from(doc.querySelectorAll("input[type='radio']")) : [];
      const radios = allRadios.filter(r => !isInsideCodeEditor(r));
      if (radios.length >= 2) return true;

      // 2. Check for checkboxes outside code editor
      const allCheckboxes = doc.querySelectorAll ? Array.from(doc.querySelectorAll("input[type='checkbox'], [role='checkbox']")) : [];
      const checkboxes = allCheckboxes.filter(c => !isInsideCodeEditor(c) && !isQuizZyInternalElement(c));
      if (checkboxes.length >= 2) return true;

      // 3. Check for option elements outside code editor (including styled-components option cards)
      const candidateEls = doc.querySelectorAll ? Array.from(doc.querySelectorAll(
        ".quiz-option, [data-quiz-option], [class*='radio-item'], [class*='option-item'], [class*='choice-item'], [role='radio'], [role='option'], [data-rbd-draggable-id], [class*='optionCard'], [class*='option-card']"
      )) : [];
      const optionCandidates = candidateEls.filter(el => !isInsideCodeEditor(el) && !isQuizZyInternalElement(el) && isVisible(el));
      if (optionCandidates.length >= 2) return true;

      // 4. Classless styled-components option group discovery (e.g. learning.ccbp.in)
      if (typeof findClasslessOptionElements === "function") {
        const classless = findClasslessOptionElements(doc, doc);
        if (classless && classless.length >= 2) return true;
      }

      // 5. Check for header containing "MCQ PRACTICE" or "QUIZ"
      const headerText = (doc.body ? (doc.body.innerText || doc.body.textContent || "") : (doc.documentElement ? doc.documentElement.textContent || "" : "")).slice(0, 1500).toLowerCase();
      const isCodingHeader = /coding\s*practice/i.test(headerText);
      const hasQuizHeader = !isCodingHeader && (/mcq\s*practice|practice\s*\|\s*|quiz\b/i.test(headerText));

      // 6. Check for SUBMIT + (SHOW ANSWER or SKIP) buttons alongside options or header
      const buttons = doc.querySelectorAll ? Array.from(doc.querySelectorAll("button, input[type='button'], input[type='submit'], a.btn")).filter(b => !isInsideCodeEditor(b)) : [];
      const btnTexts = buttons.map(b => (b.innerText || b.textContent || b.value || "").trim().toLowerCase());
      const hasSubmit = btnTexts.some(t => /^(?:submit|submit\s*answer)$/i.test(t));
      const hasShowOrSkip = btnTexts.some(t => /^(?:show\s*answer|skip)$/i.test(t));
      if (hasSubmit && (hasShowOrSkip || hasQuizHeader)) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * Helper that strips gutter elements and line numbers cleanly from extracted code text.
   */
  function extractCodeLinesWithoutGutters(el) {
    if (!el) return [];
    let clone;
    try {
      clone = el.cloneNode(true);
      const gutterEls = clone.querySelectorAll(
        ".ace_gutter, .line-numbers, .linenumber, [class*='gutter'], [class*='line-number'], [class*='linenumber'], [class*='lineNumbers'], .react-syntax-highlighter-line-number"
      );
      for (const g of gutterEls) {
        try { g.remove(); } catch (_) {}
      }
    } catch (_) {
      clone = el;
    }

    const raw = (clone.textContent || clone.innerText || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\u00a0/g, " ");

    const lines = raw.split("\n");
    const result = [];
    for (const line of lines) {
      // Strip standalone leading line numbers (e.g. " 1  int maxDownPath" or "1: maxDownPath" or "1 | maxDownPath")
      const stripped = line.replace(/^\s*\d{1,4}(?:\s*[:\|]\s*|\s{2,})/, "  ");
      result.push(stripped);
    }
    return result;
  }

  function cleanCodeSnippet(raw) {
    if (!raw) return "";
    const lines = raw.split("\n");
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines.join("\n");
  }

  /**
   * Complete Scrollable / Swipeable Code Box Extractor.
   * Extracts 100% of code from Ace, Monaco, CodeMirror, Prism, or pre/code blocks
   * located inside or adjacent to the question container.
   * Steps virtualized scrollers, strips line-number gutters, and captures multi-line code.
   */
  function extractFullCodeSnippets(containerEl, docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc) return "";

    const snippets = [];

    try {
      const root = containerEl || doc;

      // 1. Check Ace editors
      const aceEditors = Array.from(root.querySelectorAll ? root.querySelectorAll(".ace_editor, [class*='ace_editor']") : []);
      for (const editor of aceEditors) {
        let code = "";
        try {
          if (editor.env && editor.env.editor && typeof editor.env.editor.getValue === "function") {
            code = editor.env.editor.getValue();
          } else if (typeof window !== "undefined" && window.ace && typeof window.ace.edit === "function") {
            const ed = window.ace.edit(editor);
            if (ed && typeof ed.getValue === "function") {
              code = ed.getValue();
            }
          }
        } catch (_) {}

        if (!code) {
          const scroller = editor.querySelector(".ace_scroller") || editor;
          const textLayer = editor.querySelector(".ace_text-layer");
          if (scroller && textLayer) {
            const linesCollected = new Set();
            const origTop = scroller.scrollTop;
            const origLeft = scroller.scrollLeft;
            const clientH = scroller.clientHeight || 200;
            const scrollH = scroller.scrollHeight || clientH;

            for (let top = 0; top <= scrollH; top += Math.max(40, clientH * 0.75)) {
              try { scroller.scrollTop = top; } catch (_) {}
              const renderedLines = Array.from(textLayer.querySelectorAll(".ace_line"));
              for (const lineEl of renderedLines) {
                const t = (lineEl.textContent || "").replace(/\u00a0/g, " ").replace(/\r/g, "");
                if (t.trim()) linesCollected.add(t);
              }
            }
            try {
              scroller.scrollTop = origTop;
              scroller.scrollLeft = origLeft;
            } catch (_) {}

            if (linesCollected.size > 0) {
              code = Array.from(linesCollected).join("\n");
            }
          }
        }

        if (code && code.trim().length >= 10) {
          snippets.push(cleanCodeSnippet(code));
        }
      }

      // 2. Check Monaco editors
      const monacoEditors = Array.from(root.querySelectorAll ? root.querySelectorAll(".monaco-editor, [class*='monaco-editor']") : []);
      for (const editor of monacoEditors) {
        let code = "";
        try {
          if (typeof window !== "undefined" && window.monaco && window.monaco.editor) {
            const models = window.monaco.editor.getModels ? window.monaco.editor.getModels() : [];
            if (models.length > 0 && typeof models[0].getValue === "function") {
              code = models[0].getValue();
            }
          }
        } catch (_) {}

        if (!code) {
          const viewLines = Array.from(editor.querySelectorAll(".view-lines .view-line, .view-line"));
          if (viewLines.length > 0) {
            const sortedLines = viewLines.slice().sort((a, b) => {
              let topA = a.style && a.style.top ? parseFloat(a.style.top) : NaN;
              let topB = b.style && b.style.top ? parseFloat(b.style.top) : NaN;
              return (isNaN(topA) || isNaN(topB)) ? 0 : topA - topB;
            });
            code = sortedLines.map(el => (el.textContent || "").replace(/\u00a0/g, " ")).join("\n");
          }
        }

        if (code && code.trim().length >= 10) {
          snippets.push(cleanCodeSnippet(code));
        }
      }

      // 3. Check CodeMirror
      const cmEditors = Array.from(root.querySelectorAll ? root.querySelectorAll(".cm-editor, .CodeMirror") : []);
      for (const editor of cmEditors) {
        let code = "";
        try {
          if (editor.CodeMirror && typeof editor.CodeMirror.getValue === "function") {
            code = editor.CodeMirror.getValue();
          }
        } catch (_) {}
        if (!code) {
          const cmLines = Array.from(editor.querySelectorAll(".cm-line, .CodeMirror-line"));
          if (cmLines.length > 0) {
            code = cmLines.map(el => (el.textContent || "").replace(/\u00a0/g, " ")).join("\n");
          }
        }
        if (code && code.trim().length >= 10) {
          snippets.push(cleanCodeSnippet(code));
        }
      }

      // 4. Scrollable / Swipeable Code Containers, Prism, pre, code blocks
      const codeBoxes = Array.from(root.querySelectorAll ? root.querySelectorAll(
        "pre, code, .prism-code, [class*='code-block'], [class*='code-container'], [class*='codeBlock'], [class*='codeContainer'], [class*='syntax-highlighter'], [class*='highlight']"
      ) : []).filter(el => {
        if (!isVisible(el)) return false;
        if (isInsideCodeEditor(el)) return false;
        const txt = (el.textContent || "").trim();
        return txt.length >= 15 && (txt.includes("\n") || txt.includes("{") || txt.includes(";") || txt.includes("def ") || txt.includes("function") || txt.includes("class "));
      });

      for (const box of codeBoxes) {
        if (codeBoxes.some(parent => parent !== box && parent.contains(box))) continue;

        let harvestedCode = "";
        const scroller = (box.scrollHeight > box.clientHeight + 5 || box.scrollWidth > box.clientWidth + 5)
          ? box
          : (box.parentElement && (box.parentElement.scrollHeight > box.parentElement.clientHeight + 5) ? box.parentElement : null);

        if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
          const linesSet = new Set();
          const origTop = scroller.scrollTop;
          const origLeft = scroller.scrollLeft;
          const clientH = scroller.clientHeight || 200;
          const scrollH = scroller.scrollHeight || clientH;

          for (let top = 0; top <= scrollH; top += Math.max(30, clientH * 0.75)) {
            try { scroller.scrollTop = top; } catch (_) {}
            const textNodes = extractCodeLinesWithoutGutters(box);
            for (const l of textNodes) {
              if (l.trim()) linesSet.add(l);
            }
          }
          try {
            scroller.scrollTop = origTop;
            scroller.scrollLeft = origLeft;
          } catch (_) {}

          if (linesSet.size > 0) {
            harvestedCode = Array.from(linesSet).join("\n");
          }
        }

        if (!harvestedCode) {
          harvestedCode = extractCodeLinesWithoutGutters(box).join("\n");
        }

        if (harvestedCode && harvestedCode.trim().length >= 15) {
          const clean = cleanCodeSnippet(harvestedCode);
          if (clean && !snippets.includes(clean)) {
            snippets.push(clean);
          }
        }
      }
    } catch (_) {}

    return snippets.join("\n\n");
  }

  /**
   * Extracts split-pane reference code from Monaco / Ace / CodeMirror / pre code blocks.
   * For Monaco: extracts .view-lines .view-line elements sorted by vertical coordinate (style.top or getBoundingClientRect().top)
   * to guarantee correct line order even when Monaco virtualizes and renders view-lines out of order.
   * Strips gutter line numbers and replaces non-breaking spaces (\u00a0) with regular spaces, preserving indentation.
   */
  function extractSplitPaneCodeContext(questionRootEl, docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) return "";

    try {
      // 1. Check Monaco editors
      const monacoEditors = Array.from(doc.querySelectorAll(".monaco-editor, [class*='monaco-editor']")).filter(isVisible);
      for (const editor of monacoEditors) {
        const viewLines = Array.from(editor.querySelectorAll(".view-lines .view-line, .view-line"));
        if (viewLines.length > 0) {
          const sortedLines = viewLines.slice().sort((a, b) => {
            let topA = a.style && a.style.top ? parseFloat(a.style.top) : NaN;
            let topB = b.style && b.style.top ? parseFloat(b.style.top) : NaN;
            if (isNaN(topA) && typeof a.getBoundingClientRect === "function") {
              try { topA = a.getBoundingClientRect().top; } catch (_) {}
            }
            if (isNaN(topB) && typeof b.getBoundingClientRect === "function") {
              try { topB = b.getBoundingClientRect().top; } catch (_) {}
            }
            if (!isNaN(topA) && !isNaN(topB)) {
              return topA - topB;
            }
            return 0;
          });

          const lines = sortedLines.map(el => {
            return (el.textContent || "").replace(/\u00a0/g, " ").replace(/\r/g, "");
          });

          while (lines.length > 0 && lines[0].trim() === "") lines.shift();
          while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

          if (lines.length > 0) {
            return lines.join("\n");
          }
        }
      }

      // 2. Check Ace editors
      const aceEditors = Array.from(doc.querySelectorAll(".ace_editor, [class*='ace_editor']")).filter(isVisible);
      for (const editor of aceEditors) {
        const aceLines = Array.from(editor.querySelectorAll(".ace_text-layer .ace_line"));
        if (aceLines.length > 0) {
          const lines = aceLines.map(el => {
            return (el.textContent || "").replace(/\u00a0/g, " ").replace(/\r/g, "");
          });
          while (lines.length > 0 && lines[0].trim() === "") lines.shift();
          while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
          if (lines.length > 0) {
            return lines.join("\n");
          }
        }
      }

      // 3. Check CodeMirror
      const cmEditors = Array.from(doc.querySelectorAll(".cm-editor, .CodeMirror")).filter(isVisible);
      for (const editor of cmEditors) {
        const cmLines = Array.from(editor.querySelectorAll(".cm-line, .CodeMirror-line"));
        if (cmLines.length > 0) {
          const lines = cmLines.map(el => {
            return (el.textContent || "").replace(/\u00a0/g, " ").replace(/\r/g, "");
          });
          while (lines.length > 0 && lines[0].trim() === "") lines.shift();
          while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
          if (lines.length > 0) {
            return lines.join("\n");
          }
        }
      }

      // 4. Standalone pre / code blocks outside questionRootEl
      const standalonePre = Array.from(doc.querySelectorAll("pre code, pre.code-block, pre")).filter(el => {
        if (!isVisible(el)) return false;
        if (questionRootEl && questionRootEl.contains && questionRootEl.contains(el)) return false;
        if (isInsideCodeEditor(el)) return false;
        return true;
      });
      for (const el of standalonePre) {
        const codeText = (el.textContent || "").replace(/\u00a0/g, " ").trim();
        if (codeText.length >= 20 && (codeText.includes("def ") || codeText.includes("function") || codeText.includes("for ") || codeText.includes("class "))) {
          return codeText;
        }
      }
    } catch (_) {}

    return "";
  }

  /**
   * Deep SVG Graph & Tree Topology Extractor.
   * Extracts all nodes (<circle>, <rect>, <text>) and connections (<line>, <path>),
   * matches edges via Euclidean proximity, orders parent-child relationships,
   * traces all leaf-to-leaf paths, and calculates exact tree diameter.
   */
  function extractSvgGraphTopology(svgEl) {
    if (!svgEl) return null;
    try {
      // 1. Collect all shapes that could be node containers (<circle>, <rect>, <ellipse>)
      const shapes = [];
      const circles = Array.from(svgEl.querySelectorAll ? svgEl.querySelectorAll("circle") : []);
      for (const c of circles) {
        let cx = parseFloat(c.getAttribute ? c.getAttribute("cx") : 0);
        let cy = parseFloat(c.getAttribute ? c.getAttribute("cy") : 0);
        let r = parseFloat(c.getAttribute ? c.getAttribute("r") : 15);
        if (isNaN(cx) || isNaN(cy)) {
          if (typeof c.getBoundingClientRect === "function") {
            const rect = c.getBoundingClientRect();
            cx = rect.left + rect.width / 2;
            cy = rect.top + rect.height / 2;
          }
        }
        if (!isNaN(cx) && !isNaN(cy)) {
          shapes.push({ type: "circle", cx, cy, r: isNaN(r) ? 15 : r });
        }
      }

      const rects = Array.from(svgEl.querySelectorAll ? svgEl.querySelectorAll("rect") : []);
      for (const r of rects) {
        let w = parseFloat(r.getAttribute ? r.getAttribute("width") : 0);
        let h = parseFloat(r.getAttribute ? r.getAttribute("height") : 0);
        if (w >= 10 && h >= 10 && w <= 300 && h <= 300) {
          let x = parseFloat(r.getAttribute ? r.getAttribute("x") : 0);
          let y = parseFloat(r.getAttribute ? r.getAttribute("y") : 0);
          if (!isNaN(x) && !isNaN(y)) {
            shapes.push({ type: "rect", cx: x + w / 2, cy: y + h / 2, r: Math.max(w, h) / 2 });
          }
        }
      }

      // 2. Collect all text labels (<text>, <tspan>)
      const textEls = Array.from(svgEl.querySelectorAll ? svgEl.querySelectorAll("text, tspan") : []);
      const rawLabels = [];
      for (const t of textEls) {
        const txt = (t.textContent || t.innerText || "").trim();
        if (!txt) continue;
        let x = parseFloat(t.getAttribute ? t.getAttribute("x") : 0);
        let y = parseFloat(t.getAttribute ? t.getAttribute("y") : 0);
        if (isNaN(x) || isNaN(y)) {
          if (typeof t.getBoundingClientRect === "function") {
            const rect = t.getBoundingClientRect();
            x = rect.left;
            y = rect.top;
          }
        }
        if (!isNaN(x) && !isNaN(y)) {
          rawLabels.push({ text: txt, x, y, el: t });
        }
      }

      if (rawLabels.length === 0) return null;

      // Deduplicate labels if tspan is nested inside text
      const filteredLabels = [];
      for (const l of rawLabels) {
        const isDupe = filteredLabels.some(existing => existing.text === l.text && Math.hypot(existing.x - l.x, existing.y - l.y) < 10);
        if (!isDupe) {
          filteredLabels.push(l);
        }
      }

      // 3. Form Nodes: associate each label with nearest shape center (or label's own position)
      const nodes = [];
      for (let i = 0; i < filteredLabels.length; i++) {
        const l = filteredLabels[i];
        let bestShape = null;
        let minDist = 45.0; // max radius to associate shape to text
        for (const s of shapes) {
          const d = Math.hypot(s.cx - l.x, s.cy - l.y);
          if (d < minDist) {
            minDist = d;
            bestShape = s;
          }
        }
        const nx = bestShape ? bestShape.cx : l.x;
        const ny = bestShape ? bestShape.cy : l.y;
        nodes.push({
          id: `node_${i}`,
          label: l.text,
          x: Math.round(nx),
          y: Math.round(ny)
        });
      }

      // Sort nodes top-to-bottom, left-to-right
      nodes.sort((a, b) => (Math.abs(a.y - b.y) > 15 ? a.y - b.y : a.x - b.x));

      // 4. Collect Lines and Paths (Edges)
      const lines = [];
      const lineEls = Array.from(svgEl.querySelectorAll ? svgEl.querySelectorAll("line") : []);
      for (const line of lineEls) {
        let x1 = parseFloat(line.getAttribute ? line.getAttribute("x1") : 0);
        let y1 = parseFloat(line.getAttribute ? line.getAttribute("y1") : 0);
        let x2 = parseFloat(line.getAttribute ? line.getAttribute("x2") : 0);
        let y2 = parseFloat(line.getAttribute ? line.getAttribute("y2") : 0);
        if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
          lines.push({ x1, y1, x2, y2 });
        }
      }

      const pathEls = Array.from(svgEl.querySelectorAll ? svgEl.querySelectorAll("path") : []);
      for (const p of pathEls) {
        const d = (p.getAttribute ? p.getAttribute("d") : "") || "";
        const nums = d.match(/[-+]?[0-9]*\.?[0-9]+/g);
        if (nums && nums.length >= 4) {
          const x1 = parseFloat(nums[0]);
          const y1 = parseFloat(nums[1]);
          const x2 = parseFloat(nums[nums.length - 2]);
          const y2 = parseFloat(nums[nums.length - 1]);
          if (!isNaN(x1) && !isNaN(y1) && !isNaN(x2) && !isNaN(y2)) {
            if (Math.hypot(x2 - x1, y2 - y1) >= 15) {
              lines.push({ x1, y1, x2, y2 });
            }
          }
        }
      }

      // 5. Match lines to nodes to create explicit Edges
      const edges = [];
      const edgeKeySet = new Set();
      const adj = {};
      const childrenMap = {};
      const parentMap = {};
      for (const n of nodes) {
        adj[n.label] = [];
        childrenMap[n.label] = [];
      }

      for (const l of lines) {
        let bestA = null, minDistA = 70.0;
        let bestB = null, minDistB = 70.0;
        for (const n of nodes) {
          const dA = Math.hypot(n.x - l.x1, n.y - l.y1);
          if (dA < minDistA) {
            minDistA = dA;
            bestA = n;
          }
          const dB = Math.hypot(n.x - l.x2, n.y - l.y2);
          if (dB < minDistB) {
            minDistB = dB;
            bestB = n;
          }
        }

        if (bestA && bestB && bestA.label !== bestB.label) {
          const parent = bestA.y <= bestB.y ? bestA : bestB;
          const child = bestA.y <= bestB.y ? bestB : bestA;
          const edgeKey = `${parent.label}->${child.label}`;
          if (!edgeKeySet.has(edgeKey)) {
            edgeKeySet.add(edgeKey);
            const isLeft = child.x < parent.x;
            const dir = isLeft ? "left child" : "right child";
            edges.push({ parent: parent.label, child: child.label, dir });
            adj[parent.label].push(child.label);
            adj[child.label].push(parent.label);
            childrenMap[parent.label].push(child.label);
            parentMap[child.label] = parent.label;
          }
        }
      }

      // 6. Graph Analysis (Root, Leaves, Longest Path Diameter)
      const allLabels = nodes.map(n => n.label);
      const rootCandidates = allLabels.filter(lbl => !parentMap[lbl] && (childrenMap[lbl] || []).length > 0);
      const root = rootCandidates.length > 0 ? rootCandidates[0] : allLabels[0];
      const leaves = allLabels.filter(lbl => (childrenMap[lbl] || []).length === 0);

      // BFS shortest path between any two nodes
      function findPath(start, target) {
        if (start === target) return [start];
        const queue = [[start]];
        const visited = new Set([start]);
        while (queue.length > 0) {
          const path = queue.shift();
          const curr = path[path.length - 1];
          for (const neighbor of (adj[curr] || [])) {
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              const newPath = path.concat([neighbor]);
              if (neighbor === target) return newPath;
              queue.push(newPath);
            }
          }
        }
        return null;
      }

      let longestPath = [];
      for (let i = 0; i < leaves.length; i++) {
        for (let j = i + 1; j < leaves.length; j++) {
          const p = findPath(leaves[i], leaves[j]);
          if (p && p.length > longestPath.length) {
            longestPath = p;
          }
        }
      }

      if (longestPath.length === 0) {
        for (let i = 0; i < allLabels.length; i++) {
          for (let j = i + 1; j < allLabels.length; j++) {
            const p = findPath(allLabels[i], allLabels[j]);
            if (p && p.length > longestPath.length) {
              longestPath = p;
            }
          }
        }
      }

      const diameterEdges = Math.max(0, longestPath.length - 1);
      const diameterNodes = longestPath.length;

      // Construct output string
      const linesOut = [
        "[EXTRACTED DIAGRAM STRUCTURE]",
        `SVG Tree/Graph Diagram with ${nodes.length} nodes:`,
        "Nodes:"
      ];
      for (const n of nodes) {
        linesOut.push(`- Node "${n.label}" at pos (${n.x}, ${n.y})`);
      }
      if (edges.length > 0) {
        linesOut.push("Edges:");
        for (const e of edges) {
          linesOut.push(`- Edge: Node "${e.parent}" -> Node "${e.child}" (${e.dir})`);
        }
      }
      linesOut.push("Graph Topology Analysis:");
      linesOut.push(`- Root Node: "${root}"`);
      linesOut.push(`- Leaf Nodes: ${leaves.map(l => `"${l}"`).join(", ")}`);
      if (longestPath.length > 0) {
        linesOut.push(`- Longest Path: ${longestPath.join(" -> ")}`);
        linesOut.push(`- Longest Path Edges (Diameter): ${diameterEdges}`);
        linesOut.push(`- Nodes on Longest Path: ${diameterNodes}`);
      }

      return linesOut.join("\n");
    } catch (_) {
      return null;
    }
  }

  /**
   * Scans question container for visual diagrams (SVG trees, graphs, canvas, or img)
   * and extracts both structured topology summary (nodes, edges, longest path)
   * and raster image data / URLs. Never emits data:image/svg+xml as image_data.
   */
  function extractVisualContext(containerEl, docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!containerEl || !doc) {
      return { image_data: null, image_url: null, diagram_structure: null, bounding_box: null };
    }

    // Never scan the entire document root for random page images/logos if no quiz card was identified
    if (containerEl === doc || containerEl === doc.body || containerEl === doc.documentElement) {
      return { image_data: null, image_url: null, diagram_structure: null, bounding_box: null };
    }

    try {
      const svgs = Array.from(containerEl.querySelectorAll ? containerEl.querySelectorAll("svg") : []).filter(s => {
        try {
          const rect = s.getBoundingClientRect ? s.getBoundingClientRect() : { width: 0, height: 0 };
          if (rect.width < 50 || rect.height < 50) return false;
          const cls = (s.getAttribute ? (s.getAttribute("class") || "") : "").toLowerCase();
          if (cls.includes("icon") || cls.includes("btn") || cls.includes("check") || cls.includes("arrow") || cls.includes("close")) return false;
          // Real diagrams usually contain multiple graphic elements (nodes, edges, shapes)
          const shapes = s.querySelectorAll ? s.querySelectorAll("circle, line, path, text, rect") : [];
          return shapes.length >= 3;
        } catch (_) {
          return true;
        }
      });

      const imgs = Array.from(containerEl.querySelectorAll ? containerEl.querySelectorAll("img") : []).filter(img => {
        try {
          const rect = img.getBoundingClientRect ? img.getBoundingClientRect() : { width: 0, height: 0 };
          const w = img.naturalWidth || rect.width || 0;
          const h = img.naturalHeight || rect.height || 0;
          const src = (img.getAttribute ? (img.getAttribute("src") || "") : (img.src || "")).toLowerCase();
          const isDecorative = (
            src.includes("logo") ||
            src.includes("avatar") ||
            src.includes("icon") ||
            src.includes("banner") ||
            src.includes("header") ||
            src.includes("brand") ||
            src.includes("profile") ||
            src.includes("user") ||
            src.includes("spacer") ||
            src.includes("badge") ||
            src.includes("button")
          );
          return (w >= 50 && h >= 40) && !isDecorative;
        } catch (_) {
          return true;
        }
      });

      const canvases = Array.from(containerEl.querySelectorAll ? containerEl.querySelectorAll("canvas") : []).filter(c => {
        try {
          const rect = c.getBoundingClientRect ? c.getBoundingClientRect() : { width: 0, height: 0 };
          return rect.width >= 40 && rect.height >= 40;
        } catch (_) {
          return true;
        }
      });

      let image_data = null;
      let image_url = null;
      let diagram_structure = null;
      let bounding_box = null;

      // 1. Process SVG (extract full node + edge topology)
      if (svgs.length > 0) {
        const targetSvg = svgs[0];
        try {
          if (typeof targetSvg.getBoundingClientRect === "function") {
            const rect = targetSvg.getBoundingClientRect();
            bounding_box = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          }
        } catch (_) {}

        diagram_structure = extractSvgGraphTopology(targetSvg);
        // Note: Do NOT serialize to data:image/svg+xml! Vision APIs reject SVG with HTTP 400.
        // Bounding box is recorded so background.js can crop a clean PNG tab capture if needed.
      }

      // 2. Process IMG
      if (imgs.length > 0) {
        const targetImg = imgs[0];
        try {
          if (typeof targetImg.getBoundingClientRect === "function") {
            const rect = targetImg.getBoundingClientRect();
            bounding_box = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          }
        } catch (_) {}

        let rawSrc = (targetImg.getAttribute ? targetImg.getAttribute("src") : targetImg.src) || targetImg.src || "";
        const src = decodePotentialUrl(rawSrc);
        if (src.startsWith("data:image/png") || src.startsWith("data:image/jpeg") || src.startsWith("data:image/webp")) {
          image_data = src;
        } else if (src.startsWith("http://") || src.startsWith("https://")) {
          image_url = src;
          // Attempt canvas rasterization if not tainted by CORS
          if (typeof document !== "undefined" && typeof document.createElement === "function") {
            try {
              const offCanvas = document.createElement("canvas");
              offCanvas.width = targetImg.naturalWidth || targetImg.width || 300;
              offCanvas.height = targetImg.naturalHeight || targetImg.height || 300;
              const ctx = offCanvas.getContext("2d");
              ctx.drawImage(targetImg, 0, 0);
              const dataUrl = offCanvas.toDataURL("image/png");
              if (dataUrl && dataUrl.startsWith("data:image/png")) {
                image_data = dataUrl;
              }
            } catch (_) {
              // CORS SecurityError: image_data remains null, image_url is fetched by background/backend
            }
          }
        }
      }

      // 3. Process CANVAS
      if (!image_data && canvases.length > 0) {
        const targetCanvas = canvases[0];
        try {
          if (typeof targetCanvas.getBoundingClientRect === "function") {
            const rect = targetCanvas.getBoundingClientRect();
            bounding_box = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
          }
          if (typeof targetCanvas.toDataURL === "function") {
            image_data = targetCanvas.toDataURL("image/png");
          }
        } catch (_) {}
      }

      return { image_data, image_url, diagram_structure, bounding_box };
    } catch (_) {
      return { image_data: null, image_url: null, diagram_structure: null, bounding_box: null };
    }
  }

  /**
   * Locates the interactive drag handle element within a sortable row container.
   * Checks explicit drag handle attributes, 6-dot grip icons, tabindex="0", and grab cursor.
   */
  function findDragHandleInRow(rowEl) {
    if (!rowEl) return null;
    try {
      // 1. Direct explicit drag handle selectors/attributes
      const explicitHandle = rowEl.querySelector(
        "[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [data-drag-handle], [aria-roledescription*='sortable' i], [aria-roledescription*='drag' i], [class*='drag-handle' i], [class*='dragHandle' i], [class*='grip' i]"
      );
      if (explicitHandle) return explicitHandle;

      // 2. First child containing SVG and no question text (e.g., 6-dot grip icon)
      const allDivs = Array.from(rowEl.querySelectorAll("div, span, button, a"));
      for (const d of allDivs) {
        if (d.querySelector && d.querySelector("svg")) {
          const txt = cleanText(d.textContent || "");
          if (txt.length === 0 || /^[\u2630\u22EE\u22EF\u2800-\u28FF\:\:\s\d]+$/.test(txt)) {
            return d;
          }
        }
      }

      // 3. Child with tabIndex === 0 or cursor: grab / move
      for (const d of allDivs) {
        if (d.tabIndex === 0 || d.getAttribute("tabindex") === "0") {
          return d;
        }
        if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
          try {
            const cursor = window.getComputedStyle(d).cursor;
            if (cursor === "grab" || cursor === "move") return d;
          } catch (_) {}
        }
      }
    } catch (_) {}

    return rowEl;
  }

  /**
   * Detects proctored coding practice environments (such as learning.ccbp.in/question/*
   * with standalone interactive code editors and RUN/SUBMIT test runner buttons) where aggressive
   * anti-cheat MutationObservers monitor for DOM alterations.
   * NEVER flags a page if valid quiz options or MCQ practice headers exist.
   */
  function isProctoredCodingPage() {
    if (typeof window === "undefined") return false;
    try {
      const doc = (typeof document !== "undefined") ? document : null;
      if (doc && hasQuizOptionsOutsideEditor(doc)) {
        return false;
      }
      const loc = window.location;
      const pathname = (loc && loc.pathname) ? loc.pathname : "";
      if (pathname.includes("/question/") || (pathname.includes("/coding/") && !pathname.includes("/practice"))) {
        return true;
      }
      if (doc && doc.querySelector) {
        const editor = doc.querySelector(".monaco-editor, .ace_editor, [data-editor='monaco']");
        if (editor) {
          const runBtns = Array.from(doc.querySelectorAll("button, [role='button']"))
            .map(b => (b.innerText || b.textContent || "").trim().toLowerCase());
          const hasRunCode = runBtns.some(t => /^(?:run|run\s*code|custom\s*input|compile\s*&\s*run)$/i.test(t));
          if (hasRunCode) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  /**
   * Cleans text content: trims whitespace, collapses inner spaces,
   * and removes zero-width characters.
   */
  function cleanText(text) {
    if (!text) return "";
    return String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Normalizes common LaTeX mathematical notation into clean readable ASCII.
   * e.g. \frac{1}{6} -> 1/6, \frac{2^{3}}{6} -> 2^3/6, \frac{n+1}{2} -> (n+1)/2
   */
  function normalizeTeX(tex) {
    if (!tex) return "";
    let s = String(tex).trim();

    // 1. First normalize inner constructs (exponents, subscripts, roots, text formatting)
    // in a loop up to 4 passes so nested braces inside numerators/denominators are flattened first
    for (let pass = 0; pass < 4; pass++) {
      const before = s;
      s = s.replace(/\\(?:left|right)\b/g, "")
           .replace(/\^\{([^{}]+)\}/g, "^$1")
           .replace(/\_\{([^{}]+)\}/g, "_$1")
           .replace(/\\sqrt\s*\{([^{}]+)\}/g, "sqrt($1)")
           .replace(/\\sqrt\s*([0-9a-zA-Z])/g, "sqrt($1)")
           .replace(/\\(?:text|mathbf|mathit|mathrm|mathbb|mathcal)\s*\{([^{}]+)\}/g, "$1");
      if (s === before) break;
    }

    // 2. Convert \frac{num}{den} and \dfrac{num}{den}
    // If num or den has compound operators (+ or -), wrap in parentheses: (n+1)/2 or 1/(n-1)
    for (let pass = 0; pass < 4; pass++) {
      const before = s;
      s = s.replace(/\\d?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (match, num, den) => {
        let n = num.trim();
        let d = den.trim();
        if (/[+\-]/.test(n) && !/^\(.*\)$/.test(n)) {
          n = `(${n})`;
        }
        if (/[+\-]/.test(d) && !/^\(.*\)$/.test(d)) {
          d = `(${d})`;
        }
        return `${n}/${d}`;
      });
      s = s.replace(/\\d?frac\s*([0-9a-zA-Z])\s*([0-9a-zA-Z])/g, "$1/$2");
      if (s === before) break;
    }


    // 3. Common operators & symbols
    s = s.replace(/\\times\b/g, " * ")
         .replace(/\\cdot\b/g, " * ")
         .replace(/\\div\b/g, " / ")
         .replace(/\\pm\b/g, " +/- ")
         .replace(/\\mp\b/g, " -/+ ")
         .replace(/\\neq\b/g, " != ")
         .replace(/\\leq\b/g, " <= ")
         .replace(/\\geq\b/g, " >= ")
         .replace(/\\approx\b/g, " approx ")
         .replace(/\\infty\b/g, " infinity ")
         .replace(/\\pi\b/g, " pi ");

    // 4. Clean escaped symbols: \% -> %, \$ -> $, \_ -> _
    s = s.replace(/\\([%$&_#{}\\])/g, "$1");

    // 5. Strip remaining TeX command words, remove leftover braces, collapse spaces
    s = s.replace(/\\[a-zA-Z]+/g, " ")
         .replace(/[\{\}]/g, "")
         .replace(/\s+/g, " ")
         .trim();

    return s;
  }

  /**
   * Strips decorative leading bullets/letters (e.g. 'A.', '1)', '(A)')
   * while strictly preserving algebra/subtraction ('1 - 1/6', '1 - P(A)', 'A - B', 'n - 1'),
   * ratios ('1:6', 'A : B', 'x : y'), decimals ('1.5', '0.25'), fractions ('1/6', '2/36'),
   * negatives ('-1/6'), and single character options ('0', 'A').
   */
  function stripDecorativePrefix(text) {
    if (!text) return "";
    let s = String(text).trim();

    // Strip grab handle symbols if present: e.g. "::" or "⋮⋮" or "☰"
    s = s.replace(/^[:\u22EE\u22EF\u2800-\u28FF\u2630\s]+\s*/, "");

    // 0. Slot numbers (1..8) followed by whitespace or directly attached to English letter/code tag
    s = s.replace(/^[1-8]\s*(?=[A-Za-z`"'\<\(])/, "");

    // 1. Parenthesized/bracketed prefix: (A) 1/6, [B] option, (1) text
    s = s.replace(/^(?:\(\s*[A-Fa-f0-9]{1,2}\s*\)|\[\s*[A-Fa-f0-9]{1,2}\s*\])\s+/, "");

    // 2. Letter prefix [A-Fa-f] followed immediately by . or ) or : and whitespace:
    // e.g., 'A. foo', 'b) bar', 'C: baz'
    // Requires immediate attachment (no space before delimiter) and trailing whitespace (\s+)
    // to strictly preserve 'A : B', 'A - B', 'x : y', and single letter 'A'
    s = s.replace(/^[A-Fa-f][\.\)\:]\s+/, "");

    // 3. Digit prefix 1-99 followed immediately by . or ) and whitespace:
    // e.g., '1. 1/6', '2) option'
    // NEVER allow '-' or ':' as numeric delimiter (preserves '1 - 1/6', '1 - P(A)', '10 - 2', '1:6')
    // and requires trailing whitespace (preserves '1.5', '0.25')
    s = s.replace(/^[0-9]{1,2}[\.\)]\s+/, "");
    s = s.replace(/^[0-9]{1,2}\s+(?![-+*/:])/i, "");

    // 4. Bullet symbols followed by whitespace
    s = s.replace(/^[\u2022\u25E6\u25AA\u2023]\s+/, "");

    // Strip remaining grab handle if after digit: e.g. "1 :: foo" or "1 ⋮⋮ foo"
    s = s.replace(/^[:\u22EE\u22EF\u2800-\u28FF\u2630\s]+\s*/, "");

    // Strip secondary standalone slot number if preceded by icon: e.g. ":: 1 Update..."
    s = s.replace(/^[1-8]\s*(?=[A-Za-z`"'\<\(])/, "");
    s = s.replace(/^[0-9]{1,2}[\.\)]\s+/, "");
    s = s.replace(/^[0-9]{1,2}\s+(?![-+*/:])/i, "");

    return s.trim();
  }

  /**
   * Preserves multi-line indentation for code blocks while collapsing standard prose/math options.
   * Strips decorative prefixes only on the first line.
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
   * Math-Safe Text Reader:
   * Extracts clean visible text while reading raw TeX from KaTeX/MathJax annotations
   * or normalizing KaTeX visual HTML fallback, ignoring hidden/duplicate elements (ZERO DOM MUTATION).
   */
  function getCleanVisibleText(el, preserveWhitespace = false) {
    if (!el) return "";

    function walk(node) {
      if (!node) return "";
      if (node.nodeType === 3) {
        return node.nodeValue || node.textContent || "";
      }
      if (node.nodeType !== 1) {
        return "";
      }
      if (isQuizZyInternalElement(node)) {
        return "";
      }

      const tag = node.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") {
        return "";
      }
      if (tag === "br") {
        return "\n";
      }

      // Check inline display:none or visibility:hidden
      const styleAttr = (node.getAttribute && node.getAttribute("style")) || "";
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(styleAttr)) {
        return "";
      }
      if (node.hasAttribute && node.hasAttribute("hidden")) {
        return "";
      }

      const cls = typeof node.className === "string" ? node.className : ((node.getAttribute && node.getAttribute("class")) || "");

      // Check for KaTeX or MathJax container
      const isKatexContainer = cls.includes("katex") && !cls.includes("katex-html") && !cls.includes("katex-mathml");
      const isMathJaxContainer = tag === "mjx-container" || cls.includes("MathJax") || tag === "math";

      if (isKatexContainer || isMathJaxContainer) {
        // 1. Look for <annotation encoding="application/x-tex">, <annotation>, data-latex, or alttext
        const annotation = node.querySelector ? node.querySelector("annotation[encoding*='tex'], annotation") : null;
        let rawTex = annotation ? (annotation.textContent || annotation.innerText) : null;

        if (!rawTex && node.getAttribute) {
          rawTex = node.getAttribute("data-latex") || node.getAttribute("alttext") || node.getAttribute("aria-label");
        }

        if (rawTex && rawTex.trim()) {
          return " " + normalizeTeX(rawTex) + " ";
        }

        // 2. Fallback: inspect .katex-html structure for .mfrac / .frac-line
        const katexHtml = node.querySelector ? node.querySelector(".katex-html") : (cls.includes("katex-html") ? node : null);
        if (katexHtml) {
          const mfrac = katexHtml.querySelector ? katexHtml.querySelector(".mfrac") : null;
          if (mfrac) {
            const vlists = mfrac.querySelectorAll(".vlist > span");
            if (vlists.length >= 2) {
              const numText = cleanText(vlists[0].textContent || "");
              const denText = cleanText(vlists[vlists.length - 1].textContent || "");
              if (numText && denText) {
                return " " + numText + "/" + denText + " ";
              }
            }
          }
        }
      }

      // Filter out KaTeX/MathJax duplicate assistive MathML or TeX annotations if encountered standalone
      if (
        cls.includes("katex-mathml") ||
        cls.includes("MJX_Assistive_MathML") ||
        cls.includes("sr-only") ||
        cls.includes("visually-hidden") ||
        tag === "annotation" ||
        tag === "annotation-xml"
      ) {
        return "";
      }

      // KaTeX puts aria-hidden="true" on .katex-html, but that is the real visual math we want!
      const ariaHidden = node.getAttribute ? node.getAttribute("aria-hidden") : null;
      if (ariaHidden === "true" && !cls.includes("katex-html") && !(node.closest && node.closest(".katex-html"))) {
        if (tag === "svg" || tag === "i" || tag === "img" || cls.includes("icon")) {
          return "";
        }
      }

      // Inline code badges: pad with spaces so words never concatenate (e.g. `maxPathSum`, `N`)
      if (tag === "code" || tag === "kbd" || tag === "samp" || cls.includes("badge") || cls.includes("inline-code") || cls.includes("code-badge")) {
        const fullContent = (node.textContent || node.innerText || "").replace(/[\u200B-\u200D\uFEFF]/g, "");
        if (!fullContent.includes("\n") && fullContent.trim().length > 0 && fullContent.trim().length <= 60) {
          return " " + fullContent.trim() + " ";
        }
      }

      // Skip radio/checkbox inputs from contributing raw value text
      if (tag === "input" && (node.type === "radio" || node.type === "checkbox")) {
        return "";
      }

      // Deep scan images: extract alt, title, aria-label, or filename for diagram / formula / photo questions and options
      if (tag === "img") {
        const alt = node.getAttribute ? (node.getAttribute("alt") || node.getAttribute("title") || node.getAttribute("aria-label")) : null;
        if (alt && alt.trim()) {
          return " [Image: " + cleanText(alt) + "] ";
        }
        let src = node.getAttribute ? (node.getAttribute("src") || node.getAttribute("data-src")) : null;
        if (src && src.trim()) {
          src = decodePotentialUrl(src);
          const parts = src.split("/").pop().split("?")[0];
          if (parts && parts.length > 2 && !parts.includes("spacer") && !parts.includes("blank")) {
            return " [Image: " + cleanText(parts) + "] ";
          }
          return " [Image: " + cleanText(src) + "] ";
        }
        return " [Image] ";
      }

      // Deep scan SVG diagrams
      if (tag === "svg") {
        const titleEl = node.querySelector ? node.querySelector("title, desc") : null;
        const ariaLabel = node.getAttribute ? node.getAttribute("aria-label") : null;
        const svgText = titleEl ? (titleEl.textContent || titleEl.innerText) : (ariaLabel || "");
        if (svgText && svgText.trim()) {
          return " [Diagram: " + cleanText(svgText) + "] ";
        }
      }

      // Deep scan table rows and cells into structured rows
      if (tag === "tr") {
        let rowText = "";
        if (node.childNodes && node.childNodes.length > 0) {
          for (let i = 0; i < node.childNodes.length; i++) {
            rowText += walk(node.childNodes[i]);
          }
        }
        return "\n| " + cleanText(rowText) + " |\n";
      }
      if (tag === "td" || tag === "th") {
        let cellText = "";
        if (node.childNodes && node.childNodes.length > 0) {
          for (let i = 0; i < node.childNodes.length; i++) {
            cellText += walk(node.childNodes[i]);
          }
        }
        return " " + cleanText(cellText) + " |";
      }

      if (tag === "br") {
        return "\n";
      }

      // In KaTeX HTML fallback, if we encounter .msupsub, handle superscript/subscript prefix
      if (cls.includes("msupsub")) {
        const vlist = node.querySelector ? node.querySelector(".vlist") : null;
        if (vlist) {
          const text = cleanText(vlist.textContent || "");
          if (text) {
            return "^" + text;
          }
        }
      }

      let text = "";
      if (node.childNodes && node.childNodes.length > 0) {
        for (let i = 0; i < node.childNodes.length; i++) {
          text += walk(node.childNodes[i]);
        }
      } else {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          text += walk(child);
        }
      }
      return text;
    }

    const rawWalk = walk(el);
    if (preserveWhitespace) {
      return String(rawWalk)
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    }
    return cleanText(rawWalk);
  }

  /**
   * Identifies non-question header, navigation, button, or explanation strings to prevent false positives.
   */
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

    // Sub-headings like "Drag and Drop to Order"
    if (/^(?:drag\s*and\s*drop\s*to\s*order)$/i.test(t)) {
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
   * Checks if an element is part of a post-submit explanation or feedback container.
   * Walks up the ancestor chain and inspects container classes, IDs, headings, and sibling headings.
   */
  function isExplanationOrFeedback(el) {
    if (!el || el.nodeType !== 1) return false;
    // Interactive action buttons (SHOW ANSWER, SUBMIT, SKIP, etc.) are NOT explanation boxes
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || tag === "input") {
      return false;
    }

    const doc = (typeof document !== "undefined") ? document : null;
    const stopNode = doc ? doc.body : null;

    const classIdPattern = /\b(explanation|solution|feedback|answer-key|hint-box|hint-drawer|correct-answer|result-drawer|review-box)\b/i;
    const headingPattern = /^\s*(?:explanation|solution|correct\s*answer|your\s*answer|hint|note\s*:|answer\s*:)/i;

    let curr = el;
    while (curr && curr !== stopNode && curr.nodeType === 1) {
      const currTag = (curr.tagName || "").toLowerCase();
      if (currTag === "button") {
        curr = curr.parentElement;
        continue;
      }

      // 1. Check id and className on curr
      const cls = typeof curr.className === "string" ? curr.className : ((curr.getAttribute && curr.getAttribute("class")) || "");
      const id = typeof curr.id === "string" ? curr.id : ((curr.getAttribute && curr.getAttribute("id")) || "");
      if (classIdPattern.test(cls) || classIdPattern.test(id)) {
        return true;
      }

      // 2. Check if curr's first element child is a heading that identifies an explanation section
      const firstChild = curr.firstElementChild || (curr.children && curr.children[0]);
      if (firstChild) {
        const fcTag = (firstChild.tagName || "").toLowerCase();
        if (fcTag !== "button" && /^h[1-6]$|strong|b/.test(fcTag)) {
          const fcText = cleanText(firstChild.textContent || firstChild.innerText || "");
          if (headingPattern.test(fcText) && !/show\s*answer/i.test(fcText)) {
            return true;
          }
        }
      }

      // 3. Check curr's previous element sibling if it was a heading for an explanation section
      if (curr.previousElementSibling) {
        const prevTag = (curr.previousElementSibling.tagName || "").toLowerCase();
        if (prevTag !== "button" && /^h[1-6]$|strong|b/.test(prevTag)) {
          const prevText = cleanText(curr.previousElementSibling.textContent || curr.previousElementSibling.innerText || "");
          if (headingPattern.test(prevText) && !/show\s*answer/i.test(prevText)) {
            return true;
          }
        }
      }

      curr = curr.parentElement;
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
    if (!scope) return [];
    if (isQuizZyInternalElement(scope) || isInsideCodeEditor(scope)) return [];

    // Disqualify immediately if scope contains a prominent text input/textarea (fill-in-the-box question)
    const textInput = scope.querySelector("textarea, input[type='text'], input:not([type])");
    if (textInput && isVisible(textInput)) {
      const ph = (textInput.getAttribute("placeholder") || "").toLowerCase();
      const isTextArea = textInput.tagName.toLowerCase() === "textarea";
      if (isTextArea || ph.includes("answer") || ph.includes("enter") || ph.includes("type")) {
        const hasRadiosOrBoxes = !!scope.querySelector("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox'], [data-rbd-draggable-id]");
        if (!hasRadiosOrBoxes) {
          return [];
        }
      }
    }

    const candidateContainers = Array.from(scope.querySelectorAll("div, ul, ol")).filter(isVisible);
    const allDescendants = Array.from(scope.querySelectorAll("*"));

    for (let i = candidateContainers.length - 1; i >= 0; i--) {
      const container = candidateContainers[i];
      if (container === scope) continue;
      if (isQuizZyInternalElement(container) || isInsideCodeEditor(container)) continue;

      const rawChildren = Array.from(container.children || []).filter(c => isVisible(c) && !isQuizZyInternalElement(c) && !isInsideCodeEditor(c));
      const validChildren = rawChildren.filter(c => {
        const tag = (c.tagName || "").toLowerCase();
        return ["div", "li", "button", "label", "a", "span"].includes(tag);
      });

      // Filter out children that are action buttons, footers, headers or dividers
      const optionRows = validChildren.filter(c => {
        if (containsActionButtonOrFooter(c)) return false;
        const tag = (c.tagName || "").toLowerCase();
        if (tag === "hr" || tag === "br") return false;
        const txt = getCleanVisibleText(c);
        if (txt.length < 1 || txt.length > 500 || isHeaderOrNavText(txt)) return false;
        return true;
      });

      if (optionRows.length < 2 || optionRows.length > 8) continue;

      // All option rows should share the same tag name
      const firstTag = (optionRows[0].tagName || "").toLowerCase();
      const allSameTag = optionRows.every(c => (c.tagName || "").toLowerCase() === firstTag);
      if (!allSameTag) continue;

      const texts = optionRows.map(c => getCleanVisibleText(c));
      const uniqueTexts = new Set(texts);
      if (uniqueTexts.size < 2) continue;

      // Disqualify immediately if there is NO question text inside scope preceding this container
      const containerIdx = allDescendants.indexOf(container);
      if (containerIdx > 0) {
        let hasPrecedingText = false;
        for (let j = 0; j < containerIdx; j++) {
          const prev = allDescendants[j];
          if (container.contains && container.contains(prev)) continue;
          if (containsActionButtonOrFooter(prev)) continue;
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

      return optionRows;
    }

    return [];
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
      if (!el || el.nodeType !== 1) return false;
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
    const leaves = Array.isArray(allCandidateLeaves) && allCandidateLeaves.length > 0 ? allCandidateLeaves : [leafEl];

    while (curr && curr.parentElement && curr.parentElement !== stopNode) {
      const parent = curr.parentElement;
      if (isQuizZyInternalElement(parent)) break;
      if (containsActionButtonOrFooter(parent)) break;

      // Count how many candidate leaves are contained within parent
      let containedCount = 0;
      for (const leaf of leaves) {
        if (leaf && (leaf === parent || (parent.contains && parent.contains(leaf)))) {
          containedCount++;
        }
      }
      // Stop right before the container that holds >= 2 options
      if (containedCount >= 2) {
        break;
      }
      curr = parent;
    }
    return curr;
  }

  /**
   * Dedicated read-only Coding Problem Extractor for Monaco/Ace and CCBP coding environments.
   * Extracts unfolded starter code, language dropdown setting, and left pane problem statement.
   * Performs ZERO DOM mutations.
   */
  /**
   * Deterministically detects the active coding language across Monaco, Ace, dropdowns,
   * toolbar indicators, or starter-code syntax signatures.
   * Returns normalized language string: "cpp", "python", "java", or "javascript".
   */
  function detectCodingLanguage(docRef, starterCodeHint = "") {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    let detected = "";

    // 1. Language dropdowns / selectors / comboboxes / badges
    if (doc) {
      const langSelectors = [
        "select[name*='lang']",
        "select.language-select",
        ".language-selector select",
        ".language-selector",
        ".language-dropdown",
        "[role='combobox'][aria-label*='lang' i]",
        "[role='combobox'][data-testid*='lang' i]",
        "[data-testid*='lang' i]",
        "[data-mode-id]",
        ".monaco-editor [data-mode-id]",
        ".language-badge",
        ".lang-badge",
        "button[class*='lang']",
        ".code-language-picker",
        "[class*='language-select']",
        "[class*='language-dropdown']",
        "[class*='language']",
        "[class*='lang']",
        "select"
      ];
      for (const lSel of langSelectors) {
        try {
          const el = (typeof doc.querySelector === "function") ? doc.querySelector(lSel) : null;
          const candidates = el ? [el] : ((typeof doc.querySelectorAll === "function") ? Array.from(doc.querySelectorAll(lSel)) : []);
          for (const cand of candidates) {
            const raw = (cand.value || (typeof cand.getAttribute === "function" ? (cand.getAttribute("data-mode-id") || cand.getAttribute("data-lang")) : "") || cand.textContent || "").trim();
            const lower = raw.toLowerCase();
            if (lower.includes("c++") || lower.includes("cpp")) { detected = "cpp"; break; }
            if (lower.includes("java") && !lower.includes("script")) { detected = "java"; break; }
            if (lower.includes("script") || lower.includes("js") || lower.includes("ts") || lower.includes("typescript")) { detected = "javascript"; break; }
            if (lower.includes("py") || lower.includes("python")) { detected = "python"; break; }
            if (lower === "c") { detected = "cpp"; break; }
          }
          if (detected) break;
        } catch (_) {}
      }
    }

    // 2. Monaco / Ace editor model language metadata
    if (!detected && typeof window !== "undefined") {
      try {
        if (window.monaco && window.monaco.editor) {
          if (typeof window.monaco.editor.getEditors === "function") {
            const eds = window.monaco.editor.getEditors();
            if (Array.isArray(eds) && eds.length > 0) {
              const nonReadOnly = eds.filter(e => {
                const rawOpts = (typeof e.getRawOptions === "function") ? e.getRawOptions() : {};
                return !rawOpts.readOnly;
              });
              const pool = nonReadOnly.length > 0 ? nonReadOnly : eds;
              const targetEd = pool[pool.length - 1];
              if (targetEd && typeof targetEd.getModel === "function") {
                const m = targetEd.getModel();
                if (m && typeof m.getLanguageId === "function") {
                  const mLang = (m.getLanguageId() || "").toLowerCase();
                  if (mLang.includes("cpp") || mLang.includes("c++")) detected = "cpp";
                  else if (mLang.includes("py")) detected = "python";
                  else if (mLang.includes("java") && !mLang.includes("script")) detected = "java";
                  else if (mLang.includes("javascript") || mLang.includes("js") || mLang.includes("typescript") || mLang.includes("ts")) detected = "javascript";
                }
              }
            }
          }
          if (!detected && typeof window.monaco.editor.getModels === "function") {
            const models = window.monaco.editor.getModels();
            if (Array.isArray(models) && models.length > 0) {
              const attached = models.filter(m => typeof m.isAttachedToEditor === "function" && m.isAttachedToEditor());
              const targetM = attached.length > 0 ? attached[attached.length - 1] : models[models.length - 1];
              if (targetM && typeof targetM.getLanguageId === "function") {
                const mLang = (targetM.getLanguageId() || "").toLowerCase();
                if (mLang.includes("cpp") || mLang.includes("c++")) detected = "cpp";
                else if (mLang.includes("py")) detected = "python";
                else if (mLang.includes("java") && !mLang.includes("script")) detected = "java";
                else if (mLang.includes("javascript") || mLang.includes("js") || mLang.includes("typescript") || mLang.includes("ts")) detected = "javascript";
              }
            }
          }
        }
      } catch (_) {}
      if (!detected && window.ace) {
        try {
          const aceEl = doc ? doc.querySelector(".ace_editor") : null;
          const aceEd = aceEl && window.ace.edit ? window.ace.edit(aceEl) : null;
          if (aceEd && aceEd.session && aceEd.session.getMode) {
            const modeId = (aceEd.session.getMode().$id || "").toLowerCase();
            if (modeId.includes("c_cpp") || modeId.includes("cpp") || modeId.includes("c++")) detected = "cpp";
            else if (modeId.includes("python")) detected = "python";
            else if (modeId.includes("java") && !modeId.includes("javascript")) detected = "java";
            else if (modeId.includes("javascript")) detected = "javascript";
          }
        } catch (_) {}
      }
    }

    // 3. Syntax signatures in starter code
    if (!detected && starterCodeHint) {
      const codeStr = String(starterCodeHint);
      if (/class\s+solution\s*:\s*|def\s+[a-zA-Z0-9_]+\s*\(|import\s+sys|self\b/i.test(codeStr)) {
        detected = "python";
      } else if (/public\s+class|public\s+static|System\.out\.println|ArrayList\s*<|String\[\]/i.test(codeStr)) {
        detected = "java";
      } else if (/#include\s*<|using\s+namespace\s+std|Node\s*\*|nullptr\b|std::|vector\s*<|\b(?:int|void|bool|double|float|long|long\s+long)\s+[a-zA-Z0-9_]+\s*\(/i.test(codeStr)) {
        detected = "cpp";
      } else if (/function\s+[a-zA-Z0-9_]+\s*\(|const\s+|let\s+|console\.log|module\.exports/i.test(codeStr)) {
        detected = "javascript";
      }
    }

    return detected || "python";
  }

  /**
   * Dedicated read-only Coding Problem & Playground Extractor.
   * Extracts unfolded starter code, active language, and left-pane problem statement.
   * Guarantees ZERO DOM mutations.
   */
  function extractCodingProblem(docRef) {
    const doc = docRef || (typeof document !== "undefined" ? document : null);
    if (!doc) {
      return { success: false, error: "No document available for coding extraction." };
    }

    // 1. Starter code extraction (Monaco/Ace unfolded models or DOM textarea)
    let starterCode = "";
    if (typeof window !== "undefined" && window.monaco && window.monaco.editor) {
      try {
        if (typeof window.monaco.editor.getEditors === "function") {
          const eds = window.monaco.editor.getEditors();
          if (Array.isArray(eds) && eds.length > 0) {
            const nonReadOnly = eds.filter(e => {
              const rawOpts = (typeof e.getRawOptions === "function") ? e.getRawOptions() : {};
              return !rawOpts.readOnly;
            });
            const pool = nonReadOnly.length > 0 ? nonReadOnly : eds;
            const targetEd = pool[pool.length - 1];
            if (targetEd && typeof targetEd.getModel === "function") {
              const m = targetEd.getModel();
              if (m && typeof m.getValue === "function") {
                starterCode = m.getValue();
              }
            }
          }
        }
        if (!starterCode && typeof window.monaco.editor.getModels === "function") {
          const models = window.monaco.editor.getModels();
          if (Array.isArray(models) && models.length > 0) {
            const attached = models.filter(m => typeof m.isAttachedToEditor === "function" && m.isAttachedToEditor());
            const targetM = attached.length > 0 ? attached[attached.length - 1] : models[models.length - 1];
            if (targetM && typeof targetM.getValue === "function") {
              starterCode = targetM.getValue();
            }
          }
        }
      } catch (_) {}
    }
    if (!starterCode) {
      try {
        const aceEl = doc.querySelector(".ace_editor");
        if (aceEl) {
          if (typeof window !== "undefined" && window.ace && typeof window.ace.edit === "function") {
            try {
              const aceEd = window.ace.edit(aceEl);
              if (aceEd && typeof aceEd.getValue === "function") {
                starterCode = aceEd.getValue();
              }
            } catch (_) {}
          }
          if (!starterCode && aceEl.env && aceEl.env.editor && typeof aceEl.env.editor.getValue === "function") {
            starterCode = aceEl.env.editor.getValue();
          } else if (!starterCode && typeof aceEl.getValue === "function") {
            starterCode = aceEl.getValue();
          } else if (!starterCode && (aceEl.innerText || aceEl.textContent)) {
            starterCode = (aceEl.innerText || aceEl.textContent).trim();
          }
        }
      } catch (_) {}
    }
    if (!starterCode) {
      const starterSelectors = [
        "textarea.monaco-mouse-cursor-text",
        "textarea[name='code']",
        "textarea#code",
        ".ace_text-input",
        "textarea.code-input",
        "textarea"
      ];
      for (const sSel of starterSelectors) {
        const el = doc.querySelector(sSel);
        if (el && (el.value || el.textContent)) {
          const val = (el.value || el.textContent).trim();
          if (val && !val.includes("quizzy")) {
            starterCode = val;
            break;
          }
        }
      }
    }

    // 2. Language detection
    const detectedLanguage = detectCodingLanguage(doc, starterCode);

    // 3. Problem statement / description extraction (left pane)
    const descContainers = [
      "[class*='problem-statement']",
      "[class*='question-description']",
      "[class*='problem-description']",
      "[class*='coding-question']",
      "[class*='instructions']",
      "[class*='instruction']",
      "[class*='question-detail']",
      "[class*='problem-detail']",
      ".description",
      ".problem-statement",
      ".content-panel",
      "main",
      "article"
    ];

    let descEl = null;
    for (const dSel of descContainers) {
      const el = doc.querySelector(dSel);
      if (el && isVisible(el)) {
        const hasEditor = (typeof el.querySelector === "function") ? el.querySelector(".monaco-editor, .ace_editor") : false;
        if (!hasEditor) {
          descEl = el;
          break;
        }
      }
    }

    let problemText = "";
    if (descEl) {
      const blocks = (typeof descEl.querySelectorAll === "function")
        ? Array.from(descEl.querySelectorAll("h1, h2, h3, h4, p, pre, code, li, div")).filter(isVisible)
        : [];
      const parts = [];
      const seen = new Set();
      for (const b of blocks) {
        if (b && typeof b.closest === "function" && b.closest(".monaco-editor, .ace_editor, #__quizzy_hud_host__")) continue;
        if (b.children && b.children.length > 0 && b.tagName && b.tagName.toLowerCase() !== "pre" && b.tagName.toLowerCase() !== "code") continue;
        const txt = getCleanVisibleText(b, b.tagName && (b.tagName.toLowerCase() === "pre" || b.tagName.toLowerCase() === "code"));
        if (txt && txt.length >= 2 && !seen.has(txt)) {
          seen.add(txt);
          parts.push(txt);
        }
      }
      if (parts.length > 0) {
        problemText = parts.join("\n\n").trim();
      } else {
        problemText = getCleanVisibleText(descEl).trim();
      }
    }

    if (!problemText) {
      const outsideBlocks = Array.from(doc.querySelectorAll("h1, h2, h3, h4, p, pre, code")).filter((el) => {
        return isVisible(el) && !el.closest(".monaco-editor, .ace_editor, #__quizzy_hud_host__, header, nav");
      });
      const parts = [];
      for (const b of outsideBlocks) {
        const txt = getCleanVisibleText(b, b.tagName.toLowerCase() === "pre" || b.tagName.toLowerCase() === "code");
        if (txt && txt.length >= 3 && !parts.includes(txt)) {
          parts.push(txt);
        }
      }
      problemText = parts.join("\n\n").trim();
    }

    if (!problemText && doc.body) {
      const rawBody = (doc.body.innerText || doc.body.textContent || "").trim();
      if (rawBody) {
        problemText = rawBody.replace(/^CODING PRACTICE\s*/i, "").trim();
      }
    }

    // Extract Title specifically if present
    let title = "";
    const titleEl = doc.querySelector("h1, h2, .problem-title, [class*='problem-title'], [class*='question-title']");
    if (titleEl && isVisible(titleEl)) {
      title = getCleanVisibleText(titleEl).trim();
    }

    return {
      success: true,
      subject: "Coding Practice",
      q_type: "code",
      title: title || "Coding Practice Problem",
      question: problemText || "Coding Practice Problem",
      language: detectedLanguage,
      starter_code: starterCode,
      options: [],
      optionSelectors: [],
      meta: {
        url: (typeof window !== "undefined" && window.location) ? window.location.href : "",
        timestamp: Date.now(),
        is_coding_question: true,
        language: detectedLanguage,
        starter_code: starterCode,
        coding_mode: true
      }
    };
  }

  function extractCodingQuestionFromDom(docRef) {
    return extractCodingProblem(docRef);
  }

  /**
   * Pure read-only DOM extraction function.
   * Performs ZERO mutations on the host page DOM.
   * 
   * @param {Object} customSelectors - User-specified CSS selectors.
   * @param {string} forcedQType - "auto" | "mcq" | "order" | "text" | "code"
   * @returns {Object} Extracted payload { success, subject, q_type, question, options, meta }
   */
  function extractQuizFromDom(customSelectors = {}, forcedQType = "auto") {
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) {
      return { success: false, error: "No document object available for extraction." };
    }

    const custom = customSelectors || {};
    const matchedSelectors = {};

    // 1. EXTRACT SUBJECT
    let subject = "General";
    if (custom.subjectSelector) {
      const el = doc.querySelector(custom.subjectSelector);
      if (el && getCleanVisibleText(el)) {
        subject = getCleanVisibleText(el);
        matchedSelectors.subject = custom.subjectSelector;
      }
    }
    if (subject === "General") {
      // Check for topic headers like "MCQ PRACTICE | PROBABILITY RULES AND THEOREM" (with or without space after |)
      const titleMatches = doc.querySelectorAll("h1, h2, h3, h4, .quiz-title, header, .header, nav, [class*='header'], [class*='title'], div, span, p");
      for (const el of titleMatches) {
        if (isVisible(el)) {
          const txt = getCleanVisibleText(el);
          const topicMatch = txt.match(/mcq\s*practice\s*\|\s*([^\n\r\t]+)/i) ||
                             txt.match(/(?:mcq\s*practice|practice|quiz|test|assessment)\s*[\|:\-]\s*([^\n\r\t]+)/i);
          if (topicMatch && topicMatch[1]) {
            let rawTopic = topicMatch[1].trim();
            rawTopic = rawTopic.replace(/\s*(?:score\s*:|questions?\s*attempted|practice\s*instructions|end\s*practice|id\s*:).*$/i, "");
            rawTopic = cleanText(rawTopic);
            if (rawTopic.length >= 2) {
              subject = rawTopic;
              matchedSelectors.subject = "practice-topic-header";
              break;
            }
          }
        }
      }
    }
    if (subject === "General") {
      const subjectHeuristics = [
        "[data-quiz-subject]",
        ".quiz-subject",
        ".subject-title",
        "#quiz-subject",
        ".subject-name",
        "header .quiz-title",
        ".quiz-header h2",
        "header h2"
      ];
      for (const sel of subjectHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el) && getCleanVisibleText(el)) {
          subject = getCleanVisibleText(el);
          matchedSelectors.subject = sel;
          break;
        }
      }
    }

    // Coding Practice Mode Detection (q_type: "code" on learning.ccbp.in/question/* or Monaco/Ace editor pages)
    const hasQuiz = hasQuizOptionsOutsideEditor(doc);
    const isCodingMode = (forcedQType === "code") || (!hasQuiz && forcedQType === "auto" && isProctoredCodingPage());
    if (isCodingMode) {
      const codeExtract = extractCodingQuestionFromDom(doc);
      if (codeExtract && codeExtract.success) {
        if (subject && subject !== "General") codeExtract.subject = subject;
        return codeExtract;
      }
    }

    // 2. DISCOVER CARD CONTAINER AND OPTIONS
    const quizCard = findQuizCard(doc);

    let options = [];
    let qType = forcedQType && forcedQType !== "auto" ? forcedQType : "auto";
    let isDraggableOrder = false;
    let optionElements = [];
    if (custom.optionsSelector) {
      const found = Array.from(doc.querySelectorAll(custom.optionsSelector)).filter(el => isVisible(el) && !isInsideCodeEditor(el));
      if (found.length >= 2) {
        optionElements = found;
        matchedSelectors.options = custom.optionsSelector;
      }
    }

    // React / Web App Radio Row Detection
    // Supports CSS-hidden <input type="radio"> (e.g. display:none or opacity:0) with visible label/card wrappers
    if (optionElements.length === 0) {
      const allRadios = Array.from(doc.querySelectorAll("input[type='radio']")).filter(r => !isInsideCodeEditor(r));
      const validRows = [];
      for (const r of allRadios) {
        const lbl = r.closest("label") || (r.id ? doc.querySelector(`label[for="${r.id}"]`) : null);
        const row = lbl || r.closest("[class*='option'], [class*='choice'], [class*='radio'], li, tr") || r.parentElement;
        if (isRadioOrOptionVisible(r, row)) {
          validRows.push(row || r);
        }
      }
      if (validRows.length >= 2 && validRows.length <= 10) {
        optionElements = validRows;
        matchedSelectors.options = "input[type='radio']";
      }
    }

    // React / Web App Checkbox Row Detection (Multi-select questions with several correct answers)
    let isCheckboxGroup = false;
    if (optionElements.length === 0) {
      const allCheckboxes = Array.from(doc.querySelectorAll("input[type='checkbox'], [role='checkbox']")).filter(cb => !isQuizZyInternalElement(cb) && !isInsideCodeEditor(cb));
      const validRows = [];
      for (const cb of allCheckboxes) {
        const lbl = cb.closest("label") || (cb.id ? doc.querySelector(`label[for="${cb.id}"]`) : null);
        const row = lbl || cb.closest("[class*='option'], [class*='choice'], [class*='checkbox'], li, tr") || cb.parentElement;
        if (isRadioOrOptionVisible(cb, row)) {
          validRows.push(row || cb);
        }
      }
      if (validRows.length >= 2 && validRows.length <= 10) {
        optionElements = validRows;
        matchedSelectors.options = "input[type='checkbox']";
        isCheckboxGroup = true;
      }
    }

    // Heuristics for options if not found via radio or checkbox inputs
    if (optionElements.length === 0) {
      const optionGroupHeuristics = [
        "[data-quiz-option]",
        ".quiz-option",
        ".option-item",
        "[data-rbd-draggable-id]",
        "[data-rbd-drag-handle-draggable-id]",
        "[data-rfd-draggable-id]",
        "[data-rfd-drag-handle-draggable-id]",
        "[data-drag-handle]",
        "[aria-roledescription*='sortable' i]",
        "[aria-roledescription*='drag' i]",
        ".draggable-item",
        "[draggable='true']",
        "[class*='grip' i]",
        "[class*='drag-handle' i]",
        "[class*='dragHandle' i]",
        ".sortable-item",
        "[class*='sortable-item' i]",
        "[class*='sortableItem' i]",
        "[class*='reorder' i]",
        "[role='option']",
        "[role='radio']",
        "[role='checkbox']",
        "[class*='radio-item']",
        "[class*='radioItem']",
        "[class*='checkbox-item']",
        "[class*='checkboxItem']",
        "[class*='option-item']",
        "[class*='optionItem']",
        "[class*='choice-item']",
        "[class*='choiceItem']",
        ".quiz-choice",
        ".option-card",
        "li.choice",
        ".order-item",
        ".sortable-block",
        "[role='radiogroup'] > *",
        "ul[class*='option'] > li",
        "ol[class*='option'] > li"
      ];

      for (const sel of optionGroupHeuristics) {
        const matches = Array.from(doc.querySelectorAll(sel)).filter(el => isVisible(el) && !isInsideCodeEditor(el));
        if (matches.length >= 2 && matches.length <= 10) {
          // If elements are handles/inputs/icons (e.g. grip, drag-handle, svg, radio, checkbox), resolve to row roots
          const isHandleOrInput = matches.some(m => {
            const tag = (m.tagName || "").toLowerCase();
            const cls = (m.className || "").toLowerCase();
            return tag === "input" || tag === "svg" || cls.includes("grip") || cls.includes("handle") || cls.includes("icon");
          });
          const candidateElements = isHandleOrInput
            ? deduplicateOptionElements(matches.map(m => resolveOptionRowRoot(m, matches)))
            : matches;
          if (candidateElements.length >= 2 && candidateElements.length <= 10) {
            const texts = candidateElements.map(el => getCleanVisibleText(el));
            const validTexts = texts.filter(t => t.length >= 1 && !isHeaderOrNavText(t));
            if (validTexts.length >= 2) {
              optionElements = candidateElements;
              matchedSelectors.options = sel;
              break;
            }
          }
        }
      }
    }

    // Classless styled-components option group discovery (e.g. learning.ccbp.in)
    if (optionElements.length === 0) {
      const classless = findClasslessOptionElements(quizCard || doc, doc);
      if (classless.length >= 2) {
        optionElements = classless;
        matchedSelectors.options = "classless-styled-options";
      }
    }

    // Deep Scan Fallback 1: Shadow DOM option scanning
    if (optionElements.length === 0 && doc.querySelectorAll) {
      try {
        const customHosts = Array.from(doc.querySelectorAll("*")).filter(el => el.shadowRoot && !isQuizZyInternalElement(el));
        for (const host of customHosts) {
          const sRoot = host.shadowRoot;
          if (!sRoot) continue;
          const sRadios = Array.from(sRoot.querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='option'], .option-item, .quiz-option"));
          if (sRadios.length >= 2) {
            optionElements = sRadios;
            matchedSelectors.options = "shadow-root-options";
            break;
          }
        }
      } catch (_) {}
    }

    // Deep Scan Fallback 2: Accessible same-origin iframe option scanning
    if (optionElements.length === 0 && doc.querySelectorAll) {
      try {
        const iframes = Array.from(doc.querySelectorAll("iframe"));
        for (const frame of iframes) {
          try {
            const fDoc = frame.contentDocument || (frame.contentWindow ? frame.contentWindow.document : null);
            if (fDoc && fDoc.querySelectorAll) {
              const fOptions = Array.from(fDoc.querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio'], [role='option'], .option-item, .quiz-option")).filter(isVisible);
              if (fOptions.length >= 2) {
                optionElements = fOptions;
                matchedSelectors.options = "iframe-options";
                break;
              }
            }
          } catch (_) {}
        }
      } catch (_) {}
    }

    // Deep Scan Fallback 3: Image / diagram card options (e.g. visual choices with images)
    if (optionElements.length === 0 && doc.querySelectorAll) {
      try {
        const imageCards = Array.from(doc.querySelectorAll("[class*='option'] img, [class*='choice'] img, .card img, label img, [class*='answer'] img"))
          .map(img => img.closest("label, [class*='option'], [class*='choice'], .card, div") || img.parentElement)
          .filter(el => el && isVisible(el));
        const uniqueImageCards = deduplicateOptionElements(imageCards);
        if (uniqueImageCards.length >= 2 && uniqueImageCards.length <= 10) {
          optionElements = uniqueImageCards;
          matchedSelectors.options = "image-card-options";
        }
      } catch (_) {}
    }

    // 3. EXTRACT QUESTION TEXT (Supports multi-block, code snippets, declarative prompts, ignores explanations)
    let question = "";
    if (custom.questionSelector) {
      const el = doc.querySelector(custom.questionSelector);
      if (el && isVisible(el) && !isExplanationOrFeedback(el)) {
        const txt = getCleanVisibleText(el);
        if (txt.length >= 8 && !isHeaderOrNavText(txt)) {
          question = txt;
          matchedSelectors.question = custom.questionSelector;
        }
      }
    }

    // Outermost content blocks discovery inside quiz card strictly preceding optionElements[0]
    // Fixes multi-block Assertion (A) & Reason (R) and multi-statement questions on learning.ccbp.in
    if (!question) {
      let cardContainers = (quizCard ? [quizCard] : Array.from(doc.querySelectorAll(
        "[class*='question-card'], [class*='questionCard'], [class*='questionContainer'], [class*='question-container'], [class*='quiz-card'], [class*='quizCard'], [class*='quiz-container'], [class*='quizContainer'], [class*='practice-card'], [class*='problem-card'], [class*='mcq-card'], [class*='card'], .card, main, [role='main'], form"
      ))).filter(isVisible);

      // If no card container found yet but options exist, walk up from first option to find common card
      const firstOpt = (optionElements && optionElements.length > 0) ? optionElements[0] : null;
      if (cardContainers.length === 0 && firstOpt) {
        let curr = firstOpt.parentElement;
        while (curr && curr !== doc.body && curr !== doc.documentElement) {
          if (isQuizZyInternalElement(curr)) break;
          const allDesc = Array.from(curr.querySelectorAll("*"));
          if (allDesc.indexOf(firstOpt) > 0) {
            cardContainers = [curr];
            break;
          }
          curr = curr.parentElement;
        }
      }

      for (const card of cardContainers) {
        if (isExplanationOrFeedback(card)) continue;
        if (!card || typeof card.querySelectorAll !== "function") continue;

        const allDescendants = Array.from(card.querySelectorAll("*"));
        const firstOptIndex = firstOpt ? allDescendants.indexOf(firstOpt) : -1;

        // Visual position boundary if getBoundingClientRect is available
        let firstOptTop = Infinity;
        if (firstOpt && typeof firstOpt.getBoundingClientRect === "function") {
          const r = firstOpt.getBoundingClientRect();
          if (r && (r.top !== 0 || r.bottom !== 0)) {
            firstOptTop = r.top;
          }
        }

        // Elements inside card strictly preceding firstOpt in pre-order traversal
        const precedingElements = (firstOptIndex !== -1)
          ? allDescendants.slice(0, firstOptIndex).filter(el => !el.contains(firstOpt))
          : allDescendants;

        // Filter to all visible content blocks (p, div, span, pre, code, table, li, h1-h4)
        const selectedBlocks = [];
        for (const el of precedingElements) {
          if (!isVisible(el)) continue;
          if (containsActionButtonOrFooter(el)) continue;
          if (isExplanationOrFeedback(el)) continue;

          // Check visual layout position: must appear above the first option element
          if (firstOptTop !== Infinity && typeof el.getBoundingClientRect === "function") {
            const elRect = el.getBoundingClientRect();
            if (elRect && (elRect.top !== 0 || elRect.bottom !== 0) && elRect.bottom > firstOptTop + 8) {
              continue;
            }
          }

          // If an ancestor is already selected in selectedBlocks, skip descendant to avoid duplicate text
          const hasSelectedAncestor = selectedBlocks.some(parent => parent.contains(el));
          if (hasSelectedAncestor) continue;

          const tag = (el.tagName || "").toLowerCase();
          if (tag === "button" || tag === "input" || tag === "hr" || tag === "br" || tag === "style" || tag === "script") continue;
          if (el.querySelector && el.querySelector("input[type='radio'], [role='radio'], [class*='option'], button")) continue;

          // If this element contains child blocks (p, div, span, etc.) that themselves have text,
          // prefer selecting the more granular child blocks rather than the whole container
          if (tag !== "pre" && tag !== "code" && el.querySelector && el.querySelector("p, h1, h2, h3, h4, pre, code, table, li")) {
            continue;
          }

          const isCode = tag === "pre" || tag === "code";
          const txt = getCleanVisibleText(el, isCode);
          if (txt.length >= 3 && !isHeaderOrNavText(txt)) {
            // Exclude header boilerplate
            if (!/^(?:mcq\s*practice|practice\s*instructions|end\s*practice|score\s*:|questions?\s*attempted|drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder)/i.test(txt)) {
              selectedBlocks.push(el);
            }
          }
        }

        const stemParts = [];
        for (const block of selectedBlocks) {
          const tag = (block.tagName || "").toLowerCase();
          const isCode = tag === "pre" || tag === "code";
          if (isCode) {
            const rawCode = (block.textContent || block.innerText || "");
            const cleanCode = rawCode
              .replace(/[\u200B-\u200D\uFEFF]/g, "")
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            const lines = cleanCode.split("\n");
            while (lines.length > 0 && lines[0].trim() === "") lines.shift();
            while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
            const formattedCode = lines.join("\n");
            if (formattedCode && !stemParts.includes(formattedCode)) {
              stemParts.push(formattedCode);
            }
          } else {
            const txt = getCleanVisibleText(block, false);
            if (txt.length >= 3 && !isHeaderOrNavText(txt)) {
              if (!stemParts.includes(txt) && !stemParts.some(p => p.includes(txt))) {
                stemParts.push(txt);
              }
            }
          }
        }

        if (stemParts.length > 0) {
          question = stemParts.join("\n").trim();
          matchedSelectors.question = "card-stem-multiblock";
          break;
        }
      }
    }

    if (!question) {
      const questionHeuristics = [
        "[data-quiz-question]",
        ".question-text",
        ".quiz-question",
        ".question-title",
        "#question-text",
        "[role='heading'].question",
        "[class*='question-stem']",
        "[class*='questionStem']",
        "[class*='question-body']",
        "[class*='question-text']",
        "[class*='questionText']",
        "[class*='question_text']",
        ".question-card h2",
        ".question-container h3",
        ".question-container p",
        "h2.question",
        "h3.question",
        ".card-title"
      ];
      for (const sel of questionHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el) && !isExplanationOrFeedback(el)) {
          const txt = getCleanVisibleText(el);
          if (txt.length >= 8 && !isHeaderOrNavText(txt)) {
            const nextEl = el.nextElementSibling;
            if (nextEl && (nextEl.tagName.toLowerCase() === "pre" || nextEl.tagName.toLowerCase() === "code")) {
              const rawCode = (nextEl.textContent || nextEl.innerText || "")
                .replace(/[\u200B-\u200D\uFEFF]/g, "")
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n");
              const lines = rawCode.split("\n");
              while (lines.length > 0 && lines[0].trim() === "") lines.shift();
              while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
              question = txt + "\n\n" + lines.join("\n");
            } else {
              question = txt;
            }
            matchedSelectors.question = sel;
            break;
          }
        }
      }
    }

    // Secondary fallback for question if still empty: search headings
    if (!question) {
      const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, [role='heading']")).filter(isVisible);
      for (const h of headings) {
        if (isExplanationOrFeedback(h)) continue;
        const txt = getCleanVisibleText(h);
        if (txt.length >= 12 && !isHeaderOrNavText(txt) && !/quiz|test|exam|instructions/i.test(txt)) {
          question = txt;
          matchedSelectors.question = "heading-fallback";
          break;
        }
      }
    }

    // Deduplicate option elements (strict leaf-option and button exclusion)
    optionElements = deduplicateOptionElements(optionElements);

    // Resolve each option element to its per-option row root container
    if (optionElements.length >= 2) {
      const resolvedRows = optionElements.map(el => resolveOptionRowRoot(el, optionElements));
      const uniqueRows = [];
      for (const row of resolvedRows) {
        if (!uniqueRows.includes(row)) {
          uniqueRows.push(row);
        }
      }
      if (uniqueRows.length === optionElements.length) {
        optionElements = uniqueRows;
      }
    }

    // Filter out instruction banners ("Drag and Drop to Order") or standalone slot badges
    optionElements = optionElements.filter((el) => {
      const txt = cleanText(getCleanVisibleText(el) || "");
      if (/^(?:drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder)$/i.test(txt)) {
        return false;
      }
      // Only filter single digits if el is an explicit slot/badge indicator without input controls
      if (/^[1-8]$/.test(txt)) {
        const hasInput = !!(el.querySelector && el.querySelector("input, [role='radio'], [role='checkbox']"));
        const isSlotBadge = !!(el.className && typeof el.className === "string" && /(?:slot|step|badge|index)/i.test(el.className));
        if (!hasInput && isSlotBadge) {
          return false;
        }
      }
      return true;
    });

    // Check if option elements indicate drag-and-drop / ordering
    if (optionElements.length > 0) {
      isDraggableOrder = optionElements.some((el) => {
        const isDrag = el.getAttribute && (el.getAttribute("draggable") === "true" || el.draggable === true);
        const className = String(el.className || "").toLowerCase();
        const hasDragClass = /\b(draggable|drag-item|sortable|sortable-item|order-item|grip)\b/i.test(className);
        const hasRbd = (el.hasAttribute && (el.hasAttribute("data-rbd-draggable-id") || el.hasAttribute("data-rfd-draggable-id"))) ||
          !!(el.querySelector && el.querySelector("[data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [data-rbd-drag-handle-context-id], [data-drag-handle], [class*='drag-handle'], [class*='dragHandle'], [class*='grip' i]"));
        return isDrag || hasDragClass || hasRbd;
      });

      const cardText = (quizCard ? (quizCard.innerText || quizCard.textContent || "") : (doc.body ? (doc.body.innerText || doc.body.textContent || "") : ""));
      if (/drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder|rearrange\s+the\s+following|arrange\s+the\s+following.*in\s+(?:the\s+)?correct\s+order|put\s+the\s+following.*in\s+order/i.test(cardText) ||
          /drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder|rearrange\s+the\s+following|arrange\s+the\s+following.*in\s+(?:the\s+)?correct\s+order|put\s+the\s+following.*in\s+order/i.test(question)) {
        isDraggableOrder = true;
      }

      options = optionElements.map((el) => {
        const hasCode = !!(el.querySelector && el.querySelector("pre, code")) || (el.tagName && ["pre", "code"].includes(el.tagName.toLowerCase()));
        const raw = getCleanVisibleText(el, hasCode);
        const normalized = normalizeOptionWhitespace(raw, hasCode);
        return normalized || raw;
      }).filter((t) => {
        if (!t || t.length === 0) return false;
        if (/^(?:drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder)$/i.test(t.trim())) {
          return false;
        }
        return true;
      });
    }

    // Check for free text input
    let textInputEl = null;
    if (custom.textInputSelector) {
      textInputEl = doc.querySelector(custom.textInputSelector);
    }
    if (!textInputEl) {
      const inputHeuristics = [
        "[data-quiz-input]",
        "input.quiz-input",
        "input.fill-blank",
        "textarea.quiz-input",
        "textarea[placeholder*='answer' i]",
        "textarea[placeholder*='enter' i]",
        "input[placeholder*='answer' i]",
        "input[placeholder*='enter' i]",
        ".question-container input[type='text']",
        ".question-container textarea",
        "input[type='text']:not([aria-hidden='true'])",
        "textarea:not([aria-hidden='true'])"
      ];
      for (const sel of inputHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el) && !isQuizZyInternalElement(el)) {
          textInputEl = el;
          matchedSelectors.textInput = sel;
          break;
        }
      }
    }

    // If textInputEl is clearly present (e.g. textarea with placeholder 'Enter your answer')
    // and no true radios/checkboxes/drag handles exist, disqualify spurious classless options
    if (textInputEl && isVisible(textInputEl)) {
      const ph = (textInputEl.getAttribute("placeholder") || "").toLowerCase();
      const isTextArea = textInputEl.tagName.toLowerCase() === "textarea";
      if (isTextArea || ph.includes("answer") || ph.includes("enter")) {
        const hasTrueOptions = isCheckboxGroup || matchedSelectors.options === "input[type='radio']" || isDraggableOrder;
        if (!hasTrueOptions) {
          options = [];
          optionElements = [];
        }
      }
    }

    // 4. RESOLVE QUESTION TYPE
    if (forcedQType !== "auto") {
      qType = forcedQType;
    } else {
      if (options.length === 0 && textInputEl) {
        qType = "text";
      } else if (options.length >= 2) {
        // Exclude common MCQ phrases that contain the word "order"
        const isNotOrderPhrase = /\b(not(?:\s+necessarily)?\s+in(?:\s+the)?\s+same\s+order|in\s+order\s+to|order\s+of\s+magnitude|out\s+of\s+order|first\s+order|second\s+order|order\s+of\s+(?:operations|reaction|execution))\b/i.test(question);

        // Check if options contain standard MCQ choices like "None of these", "All of the above"
        const hasMcqOnlyOption = options.some((opt) => {
          const l = String(opt || "").toLowerCase().trim();
          return l === "none of these" || l === "none of the above" || l === "all of the above" || l === "all of these" || l.startsWith("both ") || l.startsWith("neither ");
        });

        // Check if elements are radio buttons or inside a radiogroup
        const hasRadioInputs = matchedSelectors.options === "input[type='radio']" ||
          (optionElements && optionElements.some((el) => el.querySelector && el.querySelector("input[type='radio'], [role='radio']")));

        // Check for checkbox / multi-select indicators (square checkboxes)
        const hasCheckboxInputs = isCheckboxGroup || matchedSelectors.options === "input[type='checkbox']" ||
          (optionElements && optionElements.some((el) => el.querySelector && el.querySelector("input[type='checkbox'], [role='checkbox'], [class*='checkbox' i]")));
        const multiDirectiveRegex = /\b(which of the following are|select all|choose all|multiple answers|more than one|all that apply)\b/i;

        const orderDirectiveRegex = /\b(arrange|chronological|sort|first to last|earliest to latest|rank|rearrange|put\s+(?:the\s+following\s+)?in\s+order|correct\s+(?:order|sequence)|drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder)\b/i;
        const generalOrderWord = /\border\b/i.test(question) && !isNotOrderPhrase;

        const cardText = (quizCard ? (quizCard.innerText || quizCard.textContent || "") : (doc.body ? (doc.body.innerText || doc.body.textContent || "") : ""));
        const hasOrderBanner = /drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder|rearrange\s+the\s+following|arrange\s+the\s+following.*in\s+(?:the\s+)?correct\s+order|put\s+the\s+following.*in\s+order/i.test(cardText) ||
                               /drag\s+and\s+drop\s+to\s+order|drag\s+to\s+reorder|rearrange\s+the\s+following|arrange\s+the\s+following.*in\s+(?:the\s+)?correct\s+order|put\s+the\s+following.*in\s+order/i.test(question);
        const hasDragHandles = optionElements.some(el => {
          return !!(el.querySelector && el.querySelector("svg, [class*='grip' i], [class*='drag' i], [data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [data-drag-handle]"));
        });
        const hasSlotNumbers = optionElements.some(el => {
          const t = cleanText(el.innerText || el.textContent || "");
          return /^[1-8][\.\:\s]/.test(t) || !!(el.querySelector && el.querySelector("[class*='slot' i], [class*='index' i], [class*='number' i], [class*='badge' i]"));
        });

        const isTrueOrdering = (isDraggableOrder || hasOrderBanner || (hasDragHandles && hasSlotNumbers) || orderDirectiveRegex.test(question) || generalOrderWord) && !hasMcqOnlyOption && !hasRadioInputs && !hasCheckboxInputs;

        if (isTrueOrdering) {
          qType = "order";
        } else if (hasCheckboxInputs || multiDirectiveRegex.test(question)) {
          qType = "multi";
        } else {
          qType = "mcq";
        }
      } else if (textInputEl) {
        qType = "text";
      } else {
        qType = "mcq";
      }
    }

    // Clean any trailing or leading Drag and Drop to Order banner text from question stem
    if (question) {
      question = question
        .replace(/\n\s*drag\s+and\s+drop\s+to\s+order\s*$/i, "")
        .replace(/^\s*drag\s+and\s+drop\s+to\s+order\s*\n/i, "")
        .trim();
    }

    // Validation
    if (!question) {
      return {
        success: false,
        error: "Unable to detect quiz question. Please specify a Question Selector in Settings or enter it manually."
      };
    }

    if (qType in { mcq: 1, order: 1, multi: 1 } && options.length < 2) {
      if (textInputEl) {
        qType = "text";
      } else {
        return {
          success: false,
          error: `Question type is '${qType}' but only ${options.length} options were found. Please configure Options Selector in Settings.`,
          partial: { subject, q_type: qType, question, options }
        };
      }
    }

    // Complete Code Snippet extraction (scrollable/swipeable boxes, Ace, Monaco, CodeMirror, Prism, pre)
    const fullSnippet = extractFullCodeSnippets(quizCard || doc, doc) || extractSplitPaneCodeContext(quizCard, doc);
    let codeContext = "";
    if (fullSnippet && fullSnippet.trim().length > 0) {
      const trimmedCode = fullSnippet.trim();
      codeContext = trimmedCode;
      if (!question.includes(trimmedCode)) {
        question = `${question}\n\nReference Code:\n\`\`\`\n${trimmedCode}\n\`\`\`\n\n[CODE SNIPPET]:\n${trimmedCode}`;
      }
    }

    // Extract visual diagram / tree context if present
    const visualContext = extractVisualContext(quizCard || doc, doc);
    let imageData = visualContext.image_data || null;
    let imageUrl = visualContext.image_url || null;
    if (visualContext.diagram_structure && !question.includes("[EXTRACTED DIAGRAM STRUCTURE]")) {
      question = `${question}\n\n${visualContext.diagram_structure}`;
    }

    // Extract and decode image_url from [Image: ...] tag if not already set
    if (!imageUrl && question) {
      const imgMatch = question.match(/\[Image:\s*(https?:\/\/[^\s\]]+|https?%3A[^\s\]]+)\]/i);
      if (imgMatch && imgMatch[1]) {
        imageUrl = decodePotentialUrl(imgMatch[1]);
      }
    }

    const optionSelectors = (Array.isArray(optionElements) ? optionElements : []).map(el => getElementCssPath(el));
    const dragHandleSelectors = (Array.isArray(optionElements) ? optionElements : []).map(el => {
      const handle = findDragHandleInRow(el);
      return getElementCssPath(handle);
    });

    const result = {
      success: true,
      subject: subject || "General",
      q_type: qType,
      question: question,
      options: options,
      image_data: imageData,
      image_url: imageUrl,
      optionSelectors: optionSelectors,
      dragHandleSelectors: dragHandleSelectors,
      meta: {
        url: (typeof window !== "undefined" && window.location) ? window.location.href : "",
        timestamp: Date.now(),
        matched_selectors: matchedSelectors,
        options_count: options.length,
        option_selectors: optionSelectors,
        drag_handle_selectors: dragHandleSelectors,
        code_context: codeContext || undefined,
        image_data: imageData,
        image_url: imageUrl,
        has_visual_diagram: !!imageData || !!imageUrl || !!visualContext.diagram_structure,
        visual_bounding_box: visualContext.bounding_box || undefined
      }
    };

    if (typeof window !== "undefined" && Array.isArray(optionElements) && optionElements.length >= 2) {
      window.__QUIZZY_LAST_OPTION_ELEMENTS__ = optionElements;
      window.__QUIZZY_LAST_OPTIONS_TEXT__ = options;
    }

    return result;
  }

  /**
   * Opt-In DOM Highlighter.
   * NEVER runs automatically or by default.
   * ONLY runs if the user explicitly enables "Opt-In Page DOM Highlight" in the Side Panel.
   * 
   * @param {Object} payload - { remove?: boolean, selected_index?: number, customSelectors?: Object }
   */
  function applyDomHighlight(payload = {}) {
    if (typeof document === "undefined") return { success: false, error: "No document" };
    if (isProctoredCodingPage()) {
      return { success: false, skipped: true, reason: "Zero DOM mutation on coding practice routes." };
    }

    const STYLE_ID = "quizzy-optin-highlight-styles";
    const WINNER_CLASS = "quizzy-optin-winner";
    const BADGE_CLASS = "quizzy-order-target-badge";

    // 1. Remove previous highlights
    const existingStyle = document.getElementById(STYLE_ID);
    if (existingStyle) {
      existingStyle.remove();
    }
    const previousElements = document.querySelectorAll("." + WINNER_CLASS);
    previousElements.forEach((el) => {
      el.classList.remove(WINNER_CLASS);
    });
    const previousBadges = document.querySelectorAll("." + BADGE_CLASS);
    previousBadges.forEach((b) => b.remove());

    if (payload.remove) {
      return { success: true, removed: true };
    }

    // 2. Inject high-contrast non-destructive outline CSS
    const styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = `
      .${WINNER_CLASS} {
        outline: 3px solid #22C55E !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 14px rgba(34, 197, 94, 0.45) !important;
        transition: outline 0.2s ease, box-shadow 0.2s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    // 3. Highlight targeted option index if specified
    if (typeof payload.selected_index === "number" && payload.selected_index >= 0) {
      let optionElements = [];
      if (payload.customSelectors && payload.customSelectors.optionsSelector) {
        optionElements = Array.from(document.querySelectorAll(payload.customSelectors.optionsSelector)).filter(isVisible);
      }
      if (optionElements.length === 0) {
        const selectors = [
          "[data-quiz-option]",
          ".quiz-option",
          ".option-item",
          ".draggable-item",
          "[draggable='true']",
          "[role='option']",
          "[role='radio']",
          ".quiz-choice"
        ];
        for (const sel of selectors) {
          const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (matches.length > payload.selected_index) {
            optionElements = matches;
            break;
          }
        }
      }

      if (optionElements[payload.selected_index]) {
        optionElements[payload.selected_index].classList.add(WINNER_CLASS);
        return { success: true, highlighted_index: payload.selected_index };
      }
    }

    // 4. Highlight target order badges (#1, #2, #3, ...) for ordering questions
    if (Array.isArray(payload.target_order_badges) && payload.target_order_badges.length > 0) {
      const elements = Array.from(document.querySelectorAll(
        "[data-rbd-draggable-id], [data-rfd-draggable-id], .draggable-item, .sortable-item, .order-item, [role='option'], [draggable='true']"
      )).filter(isVisible);

      for (let i = 0; i < payload.target_order_badges.length; i++) {
        const targetText = payload.target_order_badges[i];
        const badgeNum = `#${i + 1}`;
        for (const el of elements) {
          const t = cleanText(stripDecorativePrefix(el.innerText || el.textContent || "")).toLowerCase();
          const cleanTgt = cleanText(stripDecorativePrefix(targetText)).toLowerCase();
          if (t === cleanTgt || (t && cleanTgt && (t.includes(cleanTgt) || cleanTgt.includes(t)))) {
            const badge = document.createElement("span");
            badge.className = BADGE_CLASS;
            badge.textContent = badgeNum;
            badge.style.cssText = "display:inline-block; margin-left:8px; padding:2px 8px; font-weight:700; font-size:12px; background:#3B82F6; color:#FFFFFF; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.3); vertical-align:middle;";
            el.appendChild(badge);
            break;
          }
        }
      }
      return { success: true, highlighted_badges: true };
    }

    return { success: true, highlighted: false };
  }

  /**
   * Authoritative client-side validation guard.
   * Ensures an extracted question has a non-empty question stem and sufficient options
   * before any solver request is dispatched to the backend.
   */
  function isValidExtractedQuestion(q) {
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

  // Export to window for Chrome extension scripting and module for Node testing
  const QuizZyExtractor = {
    isValidExtractedQuestion,
    cleanText,
    normalizeTeX,
    stripDecorativePrefix,
    isVisible,
    isRadioOrOptionVisible,
    getCleanVisibleText,
    isHeaderOrNavText,
    containsActionButtonOrFooter,
    isExplanationOrFeedback,
    findQuizCard,
    findClasslessOptionElements,
    getElementCssPath,
    deduplicateOptionElements,
    resolveOptionRowRoot,
    extractSvgGraphTopology,
    extractVisualContext,
    extractQuizFromDom,
    extractCodingQuestionFromDom,
    extractCodingProblem,
    detectCodingLanguage,
    applyDomHighlight,
    isProctoredCodingPage,
    isQuizZyInternalElement,
    isInsideCodeEditor,
    hasQuizOptionsOutsideEditor,
    extractSplitPaneCodeContext,
    extractFullCodeSnippets,
    decodePotentialUrl,
    findDragHandleInRow
  };

  if (typeof window !== "undefined") {
    window.QuizZyExtractor = QuizZyExtractor;
    window.__QuizZyExtractor = QuizZyExtractor;
  }

  const __QUIZZY_EXTRACTION_RESULT__ = (typeof document !== "undefined")
    ? extractQuizFromDom()
    : { success: false, error: "No document object available for extraction." };

  Object.assign(__QUIZZY_EXTRACTION_RESULT__, QuizZyExtractor);

  if (typeof window !== "undefined") {
    window.__QUIZZY_LAST_EXTRACTION__ = __QUIZZY_EXTRACTION_RESULT__;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = QuizZyExtractor;
  }

  return (typeof module !== "undefined" && module.exports)
    ? QuizZyExtractor
    : __QUIZZY_EXTRACTION_RESULT__;
})();
