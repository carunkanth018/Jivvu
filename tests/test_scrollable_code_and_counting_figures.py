"""
Unit & Integration Tests for:
1. Split-Pane Scrollable/Swipeable Code Extraction & Normalization
2. Diagram Discovery & Counting Figures Geometric Combinatorics Grounding & Collision-Proof Cache Keys
"""

import json
import os
import subprocess
import sys
from pathlib import Path
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"

from backend.cache import compute_cache_key, get_cached_solution, cache_solution, init_db
from backend.core.normalizer import normalize_mcq_answer, normalize_code_snippet
from backend.core.prompts import SOLVER_SYSTEM_PROMPT
from backend.schemas import SolveResponse


def test_counting_figures_prompt_geometric_formulas_grounding():
    """Verify that SOLVER_SYSTEM_PROMPT includes explicit counting figures formulas and lookup table."""
    assert "COUNTING FIGURES & GEOMETRIC DIAGRAM DIRECTIVE" in SOLVER_SYSTEM_PROMPT
    assert "n=5 -> 48" in SOLVER_SYSTEM_PROMPT
    assert "n=6 -> 78" in SOLVER_SYSTEM_PROMPT
    assert "floor(n * (n + 2) * (2n + 1) / 8)" in SOLVER_SYSTEM_PROMPT
    assert "(n * (n + 1) / 2) * H" in SOLVER_SYSTEM_PROMPT
    assert "2 * k" in SOLVER_SYSTEM_PROMPT
    assert "min(M,N)" in SOLVER_SYSTEM_PROMPT


def test_collision_proof_image_cache_keys():
    """Verify compute_cache_key produces distinct hashes for identical text with different image_data or image_url."""
    question = "Find the number of triangles in the given figure."
    options = ["78", "48", "45", "55"]

    key_text_only = compute_cache_key("General", "mcq", question, options)

    img1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    img2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

    key_img1 = compute_cache_key("General", "mcq", question, options, image_data=img1)
    key_img2 = compute_cache_key("General", "mcq", question, options, image_data=img2)

    url1 = "https://assets.ccbp.in/frontend/content/react-js/triangles-figure-1.png"
    url2 = "https://assets.ccbp.in/frontend/content/react-js/triangles-figure-2.png"

    key_url1 = compute_cache_key("General", "mcq", question, options, image_url=url1)
    key_url2 = compute_cache_key("General", "mcq", question, options, image_url=url2)

    # Every visual variant must produce a strictly distinct cache key!
    assert key_text_only != key_img1
    assert key_img1 != key_img2
    assert key_url1 != key_url2
    assert key_img1 != key_url1


def test_cache_solution_and_lookup_with_image_data(tmp_path):
    """Verify that cached solutions for diagram questions correctly roundtrip and isolate by image_data."""
    test_db = str(tmp_path / "test_diagram_cache.db")
    init_db(test_db)

    question = "Find the number of triangles in the given figure."
    options = ["78", "48", "45", "55"]
    img_triangle_5 = "data:image/png;base64,TRIANGLE_N_5_BASE64_DATA"
    img_triangle_6 = "data:image/png;base64,TRIANGLE_N_6_BASE64_DATA"

    # Cache answer for n=5 figure -> 48 (Option B)
    res5 = SolveResponse(
        status="ok",
        q_type="mcq",
        answer="B",
        selected_index=1,
        selected_text="48",
        reason="Symmetrically subdivided triangle with n=5 base segments -> 48 triangles.",
        confidence_tier="HIGH_VISION_SOLVER",
        confidence_label="high",
        confidence_score=1.0,
        auto_eligible=True,
        cache_hit=False,
        latency_ms=10.0,
    )
    cached_ok = cache_solution("General", "mcq", question, options, res5, db_path=test_db, image_data=img_triangle_5)
    assert cached_ok is True

    # Lookup with img_triangle_5 -> Hit with answer 48
    hit5 = get_cached_solution("General", "mcq", question, options, db_path=test_db, image_data=img_triangle_5)
    assert hit5 is not None
    assert hit5["answer"] == "B"
    assert hit5["selected_text"] == "48"

    # Lookup with img_triangle_6 -> Miss (never poisoned by n=5 answer!)
    miss6 = get_cached_solution("General", "mcq", question, options, db_path=test_db, image_data=img_triangle_6)
    assert miss6 is None


def test_code_snippet_normalization_and_option_matching():
    """Verify normalize_code_snippet strips badges, line numbers, and whitespace."""
    raw_option_with_gutters = """SQL
1 SELECT * FROM book
2 WHERE book_id = ${bookId};"""

    normalized = normalize_code_snippet(raw_option_with_gutters)
    assert "sql" not in normalized
    assert "1 " not in normalized
    assert "2 " not in normalized
    assert "select * from book where book_id = ${bookid};" in normalized

    options = [
        "SELECT * FROM book WHERE book_id = ${bookId};",
        "SELECT book_id FROM book;",
        "UPDATE book SET title = 'test';",
        "DELETE FROM book WHERE book_id = 1;"
    ]

    # Model returns raw code without option letter -> successfully maps to Option A (index 0)
    ans = normalize_mcq_answer("SELECT * FROM book WHERE book_id = ${bookId};", options)
    assert ans.canonical_key == "A"
    assert ans.selected_index == 0


def test_split_pane_scrollable_code_and_counting_figures_node_runtime():
    """Execute Node.js runtime test verifying split-pane code extraction and counting figures diagram discovery."""
    extractor_path = (PROJECT_ROOT / "extension" / "extractor.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    // Minimal Mock DOM Node
    class MockNode {{
      constructor(tagOrText, isText = false) {{
        if (isText) {{
          this.nodeType = 3;
          this.nodeValue = String(tagOrText);
          this.childNodes = [];
        }} else {{
          this.nodeType = 1;
          this.tagName = String(tagOrText).toUpperCase();
          this.className = "";
          this.attributes = {{}};
          this.childNodes = [];
          this.style = {{}};
        }}
        this.parentElement = null;
      }}

      get children() {{
        return this.childNodes.filter(c => c.nodeType === 1);
      }}

      get textContent() {{
        if (this.nodeType === 3) return this.nodeValue;
        return this.childNodes.map(c => c.textContent).join("");
      }}

      set textContent(v) {{
        this.childNodes = [new MockNode(v, true)];
      }}

      get innerText() {{
        return this.textContent;
      }}

      getAttribute(k) {{
        return this.attributes[k] || null;
      }}

      setAttribute(k, v) {{
        this.attributes[k] = String(v);
      }}

      hasAttribute(k) {{
        return k in this.attributes;
      }}

      appendChild(c) {{
        this.childNodes.push(c);
        c.parentElement = this;
        return c;
      }}

      remove() {{
        if (this.parentElement) {{
          const idx = this.parentElement.childNodes.indexOf(this);
          if (idx !== -1) {{
            this.parentElement.childNodes.splice(idx, 1);
          }}
          this.parentElement = null;
        }}
      }}

      cloneNode(deep = true) {{
        const copy = new MockNode(this.nodeType === 3 ? this.nodeValue : this.tagName, this.nodeType === 3);
        copy.className = this.className;
        copy.attributes = Object.assign({{}}, this.attributes);
        copy.style = Object.assign({{}}, this.style);
        if (deep) {{
          for (const ch of this.childNodes) {{
            copy.appendChild(ch.cloneNode(true));
          }}
        }}
        return copy;
      }}

      contains(other) {{
        if (!other) return false;
        if (this === other) return true;
        let p = other.parentElement;
        while (p) {{
          if (p === this) return true;
          p = p.parentElement;
        }}
        return false;
      }}

      closest(sel) {{
        let p = this;
        while (p) {{
          if (p._matchesSel(sel)) return p;
          p = p.parentElement;
        }}
        return null;
      }}

      _matchesSingleSel(s) {{
        s = s.trim();
        if (!s) return false;

        // Handle child combinator: A > B
        if (s.includes(" > ")) {{
          const parts = s.split(" > ");
          const last = parts[parts.length - 1].trim();
          if (!this._matchesSingleSel(last)) return false;
          if (!this.parentElement) return false;
          const rest = parts.slice(0, -1).join(" > ");
          return this.parentElement._matchesSingleSel(rest);
        }}

        // Handle descendant combinator: A B
        if (s.includes(" ")) {{
          const parts = s.split(/\\s+/);
          const last = parts[parts.length - 1];
          if (!this._matchesSingleSel(last)) return false;
          let p = this.parentElement;
          const rest = parts.slice(0, -1).join(" ");
          while (p) {{
            if (p._matchesSingleSel(rest)) return true;
            p = p.parentElement;
          }}
          return false;
        }}

        // Tag + attribute e.g. input[type='radio']
        if (s.includes("[") && !s.startsWith("[")) {{
          const tagPart = s.slice(0, s.indexOf("[")).trim();
          const attrPart = s.slice(s.indexOf("[")).trim();
          return this._matchesSingleSel(tagPart) && this._matchesSingleSel(attrPart);
        }}

        s = s.toLowerCase();
        if (s.includes(":not(")) {{
          s = s.slice(0, s.indexOf(":not(")).trim();
        }}
        if (s === "*") return true;
        if (s.startsWith(".")) {{
          const target = s.slice(1);
          const cls = (this.className || "").toLowerCase();
          return cls.split(/\\s+/).includes(target) || cls.includes(target);
        }}
        if (s.startsWith("[class*=")) {{
          const target = s.slice(9, -2).toLowerCase();
          return (this.className || "").toLowerCase().includes(target);
        }}
        if (s.startsWith("[role=")) {{
          const target = s.slice(7, -2).toLowerCase();
          return (this.getAttribute("role") || "").toLowerCase() === target;
        }}
        if (s.startsWith("[type=")) {{
          const target = s.slice(7, -2).toLowerCase();
          return (this.getAttribute("type") || "").toLowerCase() === target;
        }}
        if (s.startsWith("[aria-hidden=")) {{
          const target = s.slice(14, -2).toLowerCase();
          return (this.getAttribute("aria-hidden") || "").toLowerCase() === target;
        }}
        if (s.startsWith("[") && s.endsWith("]")) {{
          const inner = s.slice(1, -1);
          if (inner.includes("=")) {{
            const [k, v] = inner.split("=");
            const val = v.replace(/['"]/g, "").trim().toLowerCase();
            return (this.getAttribute(k.trim()) || "").toLowerCase() === val;
          }}
          return this.hasAttribute(inner.trim());
        }}
        return this.tagName.toLowerCase() === s;
      }}

      _matchesSel(sel) {{
        if (this.nodeType !== 1) return false;
        const parts = sel.split(",");
        for (let p of parts) {{
          p = p.trim();
          if (p && this._matchesSingleSel(p)) return true;
        }}
        return false;
      }}

      querySelectorAll(sel) {{
        const out = [];
        const walk = (n) => {{
          if (n.nodeType === 1 && n !== this && n._matchesSel(sel)) {{
            out.push(n);
          }}
          for (const c of n.childNodes) walk(c);
        }};
        walk(this);
        return out;
      }}

      querySelector(sel) {{
        const all = this.querySelectorAll(sel);
        return all.length > 0 ? all[0] : null;
      }}

      getBoundingClientRect() {{
        return {{
          top: this._top || 100,
          left: this._left || 100,
          right: (this._left || 100) + (this._width || 200),
          bottom: (this._top || 100) + (this._height || 100),
          width: this._width || 200,
          height: this._height || 100
        }};
      }}
    }}

    // Construct Split-Pane Code Question DOM:
    // Left Pane: PRACTICE INSTRUCTIONS, Prompt text, and line-numbered JAVASCRIPT code block
    // Right Pane: 4 SQL Options with line numbers and SQL badges
    const doc = new MockNode("document");
    const body = new MockNode("body");
    doc.body = body;
    doc.documentElement = doc;
    doc.appendChild(body);

    const splitRoot = new MockNode("div");
    splitRoot.className = "split-view-container";
    body.appendChild(splitRoot);

    // Left Pane
    const leftPane = new MockNode("div");
    leftPane.className = "left-pane";
    leftPane._left = 50;
    leftPane._top = 50;
    leftPane._width = 400;
    leftPane._height = 600;
    splitRoot.appendChild(leftPane);

    const instrHeader = new MockNode("h3");
    instrHeader.textContent = "PRACTICE INSTRUCTIONS";
    leftPane.appendChild(instrHeader);

    const promptP = new MockNode("p");
    promptP.textContent = "Write an API to get a book by book_id from the database using SQL and Express.";
    leftPane.appendChild(promptP);

    // Code container in left pane with JAVASCRIPT badge and line numbers
    const codeCard = new MockNode("div");
    codeCard.className = "code-container";
    leftPane.appendChild(codeCard);

    const jsBadge = new MockNode("span");
    jsBadge.className = "badge";
    jsBadge.textContent = "JAVASCRIPT";
    codeCard.appendChild(jsBadge);

    const copyBtn = new MockNode("button");
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    codeCard.appendChild(copyBtn);

    const preStem = new MockNode("pre");
    preStem.className = "react-syntax-highlighter";
    codeCard.appendChild(preStem);

    const lineNum1 = new MockNode("span");
    lineNum1.className = "react-syntax-highlighter-line-number";
    lineNum1.textContent = "1";
    preStem.appendChild(lineNum1);

    const codeSpan1 = new MockNode("span");
    codeSpan1.textContent = "app.get('/books/:bookId/', async (request, response) => {{";
    preStem.appendChild(codeSpan1);

    const lineNum2 = new MockNode("span");
    lineNum2.className = "react-syntax-highlighter-line-number";
    lineNum2.textContent = "2";
    preStem.appendChild(lineNum2);

    const codeSpan2 = new MockNode("span");
    codeSpan2.textContent = "  const {{ bookId }} = request.params;";
    preStem.appendChild(codeSpan2);

    // Right Pane
    const rightPane = new MockNode("div");
    rightPane.className = "right-pane";
    rightPane._left = 500;
    rightPane._top = 50;
    rightPane._width = 400;
    rightPane._height = 600;
    splitRoot.appendChild(rightPane);

    const optionsContainer = new MockNode("div");
    optionsContainer.className = "quiz-options-container";
    rightPane.appendChild(optionsContainer);

    const optTexts = [
      "SELECT * FROM book WHERE book_id = ${{bookId}};",
      "SELECT book_id FROM book;",
      "UPDATE book SET book_id = ${{bookId}};",
      "DELETE FROM book WHERE book_id = ${{bookId}};"
    ];

    const optLetters = ["A", "B", "C", "D"];
    for (let i = 0; i < 4; i++) {{
      const optRow = new MockNode("div");
      optRow.className = "option-card choice-item";
      optRow._left = 520;
      optRow._top = 100 + i * 80;
      optRow._width = 360;
      optRow._height = 60;

      const badge = new MockNode("span");
      badge.className = "option-badge";
      badge.textContent = optLetters[i];
      optRow.appendChild(badge);

      const sqlBadge = new MockNode("span");
      sqlBadge.className = "badge";
      sqlBadge.textContent = "SQL";
      optRow.appendChild(sqlBadge);

      const preOpt = new MockNode("pre");
      preOpt.className = "code-block";
      const gLine = new MockNode("span");
      gLine.className = "line-number";
      gLine.textContent = "1";
      preOpt.appendChild(gLine);
      const codeText = new MockNode("code");
      codeText.textContent = optTexts[i];
      preOpt.appendChild(codeText);
      optRow.appendChild(preOpt);

      optionsContainer.appendChild(optRow);
    }}

    // Load extractor.js into vm
    const extractorCode = fs.readFileSync('{extractor_path}', 'utf8');
    const sandbox = {{
      window: {{}},
      document: doc,
      XMLSerializer: class {{
        serializeToString(node) {{ return "<svg></svg>"; }}
      }},
      console: console
    }};
    vm.createContext(sandbox);
    vm.runInContext(extractorCode, sandbox);

    const extractor = sandbox.QuizZyExtractor || sandbox.window.QuizZyExtractor;
    if (!extractor) {{
      throw new Error("QuizZyExtractor not exported on window/sandbox!");
    }}

    // 1. Test extractCleanCodeFromClonedNode
    const cleanStem = extractor.extractCleanCodeFromClonedNode(codeCard, false);
    if (!cleanStem.includes("app.get('/books/:bookId/'") || cleanStem.includes("JAVASCRIPT") || cleanStem.includes("Copy")) {{
      throw new Error("extractCleanCodeFromClonedNode failed on stem code card: " + cleanStem);
    }}

    // 2. Test extractQuizFromDom on Split-Pane
    const extracted = extractor.extractQuizFromDom();
    if (!extracted.success) {{
      throw new Error("extractQuizFromDom failed on split-pane structure: " + JSON.stringify(extracted));
    }}

    if (!extracted.question.includes("Write an API to get a book by book_id")) {{
      throw new Error("Question text did not capture left-pane stem text! Got: " + extracted.question);
    }}

    if (extracted.options.length !== 4) {{
      throw new Error("Options count mismatch! Expected 4, got: " + extracted.options.length);
    }}

    for (let i = 0; i < 4; i++) {{
      const opt = extracted.options[i];
      if (opt.includes("SQL") || opt.startsWith("A.") || opt.startsWith("B.") || /^\\s*1\\s+/.test(opt)) {{
        throw new Error("Option " + i + " contains residual badge or line number: " + opt);
      }}
      if (!opt.includes(optTexts[i])) {{
        throw new Error("Option " + i + " text mismatch! Got: " + opt + ", expected: " + optTexts[i]);
      }}
    }}

    // 3. Test Counting Figures Diagram Discovery
    const diagDoc = new MockNode("document");
    const diagBody = new MockNode("body");
    diagDoc.body = diagBody;
    diagDoc.documentElement = diagDoc;
    diagDoc.appendChild(diagBody);

    const diagSplit = new MockNode("div");
    diagSplit.className = "practice-split-container";
    diagBody.appendChild(diagSplit);

    const diagLeft = new MockNode("div");
    diagLeft.className = "left-pane";
    diagSplit.appendChild(diagLeft);

    const diagHeader = new MockNode("h3");
    diagHeader.textContent = "PRACTICE INSTRUCTIONS";
    diagLeft.appendChild(diagHeader);

    const diagPrompt = new MockNode("p");
    diagPrompt.textContent = "Find the number of triangles in the given figure.";
    diagLeft.appendChild(diagPrompt);

    const diagImg = new MockNode("img");
    diagImg.className = "diagram-image";
    diagImg.setAttribute("src", "https://assets.ccbp.in/frontend/content/react-js/triangles-n5.png");
    diagImg._width = 240;
    diagImg._height = 200;
    diagLeft.appendChild(diagImg);

    const diagRight = new MockNode("div");
    diagRight.className = "right-pane";
    diagSplit.appendChild(diagRight);

    const diagOpts = ["78", "48", "45", "55"];
    for (let i = 0; i < 4; i++) {{
      const row = new MockNode("div");
      row.className = "option-card";
      row.textContent = diagOpts[i];
      diagRight.appendChild(row);
    }}

    const diagSandbox = {{
      window: {{ devicePixelRatio: 2 }},
      document: diagDoc,
      XMLSerializer: class {{
        serializeToString(node) {{ return "<svg></svg>"; }}
      }},
      console: console
    }};
    vm.createContext(diagSandbox);
    vm.runInContext(extractorCode, diagSandbox);

    const diagExtractor = diagSandbox.QuizZyExtractor || diagSandbox.window.QuizZyExtractor;
    const diagExtracted = diagExtractor.extractQuizFromDom();

    if (!diagExtracted.success) {{
      throw new Error("Diagram question extraction failed!");
    }}

    if (!diagExtracted.image_url || !diagExtracted.image_url.includes("triangles-n5.png")) {{
      throw new Error("Diagram image_url not discovered! Got: " + diagExtracted.image_url);
    }}

    if (!diagExtracted.image_bbox || diagExtracted.image_bbox.width < 36) {{
      throw new Error("Diagram image_bbox missing or invalid! Got: " + JSON.stringify(diagExtracted.image_bbox));
    }}

    console.log("SPLIT_PANE_AND_DIAGRAM_OK");
    process.exit(0);
    """

    res = subprocess.run(
        ["node", "-e", node_script],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT)
    )
    assert res.returncode == 0, f"Node script failed:\nstdout: {res.stdout}\nstderr: {res.stderr}"
    assert "SPLIT_PANE_AND_DIAGRAM_OK" in res.stdout


def test_table_and_flex_syntax_highlighter_token_spacing_node_runtime():
    """Verify table and flex syntax highlighter parsing, gutter stripping, token spacing, and option card preservation."""
    node_script = """
    const fs = require("fs");
    const vm = require("vm");
    const extractorCode = fs.readFileSync("extension/extractor.js", "utf8");

    class MockNode {
      constructor(tag) {
        this.tagName = (tag || "div").toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = "";
        this._text = "";
        this.attributes = {};
      }
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this.children.map(c => c.textContent).join("");
      }
      set textContent(v) {
        this._text = String(v);
      }
      get innerText() { return this.textContent; }
      setAttribute(k, v) { this.attributes[k] = String(v); }
      getAttribute(k) { return this.attributes[k] || null; }
      appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        return c;
      }
      remove() {
        if (this.parentNode) {
          this.parentNode.children = this.parentNode.children.filter(x => x !== this);
          this.parentNode = null;
        }
      }
      cloneNode(deep = true) {
        const copy = new MockNode(this.tagName.toLowerCase());
        copy.className = this.className;
        copy._text = this._text;
        copy.attributes = Object.assign({}, this.attributes);
        if (deep) {
          copy.children = this.children.map(c => {
            const childCopy = c.cloneNode(true);
            childCopy.parentNode = copy;
            return childCopy;
          });
        }
        return copy;
      }
      querySelectorAll(selector) {
        const results = [];
        const match = (node) => {
          const tag = node.tagName.toLowerCase();
          const cls = (node.className || "").toLowerCase();

          if (selector === "tr" && tag === "tr") return true;
          if (selector === "td" && tag === "td") return true;
          if (selector === "span" && tag === "span") return true;
          if (selector.includes(".linenumber") && cls.includes("linenumber")) return true;
          if (selector.includes("[aria-hidden='true']") && node.getAttribute("aria-hidden") === "true") return true;
          if (selector === "button" && tag === "button") return true;
          if (selector.includes("tr, td, code, pre") && (tag === "tr" || tag === "td" || tag === "code" || tag === "pre")) return true;
          if (selector.includes("react-syntax-highlighter-line") && cls.includes("react-syntax-highlighter-line")) return true;
          return false;
        };

        const walk = (node) => {
          for (const c of node.children) {
            if (match(c)) results.push(c);
            walk(c);
          }
        };
        walk(this);
        return results;
      }
      querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length > 0 ? all[0] : null;
      }
      getBoundingClientRect() {
        return { top: 100, left: 50, right: 250, bottom: 200, width: 200, height: 100 };
      }
    }

    // Setup Mock sandbox
    const sandbox = {
      window: { devicePixelRatio: 1 },
      document: new MockNode("document"),
      console: console
    };
    vm.createContext(sandbox);
    vm.runInContext(extractorCode, sandbox);

    const extractor = sandbox.QuizZyExtractor || sandbox.window.QuizZyExtractor;

    // 1. Test 2-Column Table Syntax Highlighter
    const tableContainer = new MockNode("div");
    const table = new MockNode("table");
    tableContainer.appendChild(table);

    const tr1 = new MockNode("tr");
    const tdGutter1 = new MockNode("td");
    tdGutter1.textContent = "1";
    tdGutter1.className = "gutter";
    const tdCode1 = new MockNode("td");
    const spanConst = new MockNode("span");
    spanConst.textContent = "const";
    const spanExpress = new MockNode("span");
    spanExpress.textContent = "express";
    const spanRest = new MockNode("span");
    spanRest.textContent = " = require('express');";
    tdCode1.appendChild(spanConst);
    tdCode1.appendChild(spanExpress);
    tdCode1.appendChild(spanRest);
    tr1.appendChild(tdGutter1);
    tr1.appendChild(tdCode1);
    table.appendChild(tr1);

    const cleanedTableCode = extractor.extractCleanCodeFromClonedNode(tableContainer, false);
    if (!cleanedTableCode.includes("const express")) {
      throw new Error("Tokens were glued or gutter not stripped! Got: " + cleanedTableCode);
    }
    if (cleanedTableCode.startsWith("1") || cleanedTableCode.includes("1const")) {
      throw new Error("Table gutter line number leaked into code! Got: " + cleanedTableCode);
    }

    // 2. Test Flex-Based Line Number Highlighter
    const flexContainer = new MockNode("div");
    const line1 = new MockNode("div");
    line1.className = "react-syntax-highlighter-line";
    const numSpan = new MockNode("span");
    numSpan.className = "linenumber";
    numSpan.textContent = "1";
    const codeSpanA = new MockNode("span");
    codeSpanA.textContent = "SELECT";
    const codeSpanB = new MockNode("span");
    codeSpanB.textContent = "*";
    const codeSpanC = new MockNode("span");
    codeSpanC.textContent = "FROM";
    const codeSpanD = new MockNode("span");
    codeSpanD.textContent = "users;";
    line1.appendChild(numSpan);
    line1.appendChild(codeSpanA);
    line1.appendChild(codeSpanB);
    line1.appendChild(codeSpanC);
    line1.appendChild(codeSpanD);
    flexContainer.appendChild(line1);

    const cleanedFlexCode = extractor.extractCleanCodeFromClonedNode(flexContainer, false);
    if (cleanedFlexCode.startsWith("1") || cleanedFlexCode.includes("1SELECT")) {
      throw new Error("Flex line number leaked into code! Got: " + cleanedFlexCode);
    }

    console.log("SYNTAX_HIGHLIGHTER_AND_TOKENS_OK");
    process.exit(0);
    """

    res = subprocess.run(
        ["node", "-e", node_script],
        capture_output=True,
        text=True,
        cwd=str(PROJECT_ROOT)
    )
    assert res.returncode == 0, f"Node script failed:\nstdout: {res.stdout}\nstderr: {res.stderr}"
    assert "SYNTAX_HIGHLIGHTER_AND_TOKENS_OK" in res.stdout
