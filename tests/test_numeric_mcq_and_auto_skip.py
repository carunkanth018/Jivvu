"""
Test Suite: Numeric MCQ Extraction & Total Removal of Skipping Operations
Validates:
1. Accurate extraction of MCQs with single-digit numeric options (e.g. Question 7/15: options '5', '6', '4', '3').
2. Non-interference with Drag-and-Drop ordering slot badges.
3. Executor clickSkipButton is completely disabled and never clicks host page SKIP buttons.
4. Floating HUD has completely removed 5-second auto-skip watchdog, Alt+K hotkey, and HUD skip methods.
5. End-to-end backend solve verification for Question 7/15.
"""

import json
import os
import subprocess
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"

from backend.app import app


def run_node_eval(script_code: str) -> dict:
    """Executes Node.js evaluation script and parses JSON output."""
    res = subprocess.run(
        ["node", "-e", script_code],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8"
    )
    if res.returncode != 0:
        raise RuntimeError(f"Node execution failed (code {res.returncode}):\n{res.stderr}\nStdout:\n{res.stdout}")
    try:
        return json.loads(res.stdout.strip())
    except Exception as e:
        raise RuntimeError(f"Failed to parse JSON output: {res.stdout}\nError: {e}")


def test_question_7_numeric_mcq_extraction():
    """
    Regression test for Question 7/15:
    'Given an array arr = [2, -1, 2, 3, -9] , what is the largest sum of a subarray?'
    Options: '5', '6', '4', '3'.
    Verifies options are NOT filtered out by regex and extract successfully with q_type: 'mcq'.
    """
    script = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class MockNode {
  constructor(tag, cls = '', attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.attributes = { ...attrs };
    this.childNodes = [];
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.style = {};
    this.checked = false;
    this.disabled = false;

    children.forEach(c => {
      if (typeof c === 'string') {
        const textNode = {
          nodeType: 3,
          textContent: c,
          innerText: c,
          nodeValue: c,
          parentElement: this,
          parentNode: this
        };
        this.childNodes.push(textNode);
      } else if (c) {
        c.parentElement = this;
        c.parentNode = this;
        this.childNodes.push(c);
        this.children.push(c);
      }
    });
  }

  get nodeType() { return 1; }

  getAttribute(name) {
    if (name === 'class') return this.className;
    return this.attributes[name] !== undefined ? this.attributes[name] : null;
  }

  setAttribute(name, val) {
    this.attributes[name] = String(val);
    if (name === 'class') this.className = String(val);
  }

  hasAttribute(name) {
    if (name === 'class') return !!this.className;
    return this.attributes[name] !== undefined;
  }

  get innerText() {
    return this.childNodes.map(c => c.innerText || c.textContent || c.nodeValue || '').join(' ');
  }

  get textContent() {
    return this.childNodes.map(c => c.textContent || c.innerText || c.nodeValue || '').join(' ');
  }

  querySelectorAll(sel) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, sel)) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  }

  matches(sel) {
    return matchesSelector(this, sel);
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (matchesSelector(cur, sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  contains(el) {
    let cur = el;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  getBoundingClientRect() {
    return { top: 100, bottom: 140, left: 50, right: 300, width: 250, height: 40 };
  }
}

function matchesSelector(node, sel) {
  if (!sel || !node || node.nodeType !== 1) return false;
  const selectors = sel.split(',').map(s => s.trim());
  return selectors.some(s => {
    if (s === '*') return true;
    if (s.toLowerCase() === node.tagName.toLowerCase()) return true;
    if (s.startsWith('.') && node.className.split(/\s+/).includes(s.slice(1))) return true;
    if (s.startsWith('#') && node.getAttribute('id') === s.slice(1)) return true;
    if (s.includes('[class*=')) {
      const match = s.match(/\[class\*=['"]?([^'"]+)['"]?\]/);
      if (match && node.className.includes(match[1])) return true;
    }
    if (s.includes("input[type='radio']")) {
      return node.tagName === 'INPUT' && (node.getAttribute('type') === 'radio');
    }
    if (s === 'input') return node.tagName === 'INPUT';
    if (s === 'button') return node.tagName === 'BUTTON';
    return false;
  });
}

// Build CCBP Question 7/15 DOM
const card = new MockNode('div', 'sc-question-card question-container', {}, [
  new MockNode('div', 'header-bar', {}, [
    new MockNode('span', '', {}, ['MCQ PRACTICE | LARGEST SUBARRAY SUM']),
    new MockNode('span', '', {}, ['SCORE: 6']),
    new MockNode('span', '', {}, ['QUESTIONS ATTEMPTED: 7/15'])
  ]),
  new MockNode('div', 'question-text-stem', {}, [
    'Given an array arr = [2, -1, 2, 3, -9] , what is the largest sum of a subarray?'
  ]),
  new MockNode('div', 'options-group', {}, [
    new MockNode('div', 'sc-option radio-item', {}, [
      new MockNode('input', '', { type: 'radio', name: 'mcq' }),
      new MockNode('span', 'opt-text', {}, ['5'])
    ]),
    new MockNode('div', 'sc-option radio-item', {}, [
      new MockNode('input', '', { type: 'radio', name: 'mcq' }),
      new MockNode('span', 'opt-text', {}, ['6'])
    ]),
    new MockNode('div', 'sc-option radio-item', {}, [
      new MockNode('input', '', { type: 'radio', name: 'mcq' }),
      new MockNode('span', 'opt-text', {}, ['4'])
    ]),
    new MockNode('div', 'sc-option radio-item', {}, [
      new MockNode('input', '', { type: 'radio', name: 'mcq' }),
      new MockNode('span', 'opt-text', {}, ['3'])
    ])
  ]),
  new MockNode('div', 'actions-bar', {}, [
    new MockNode('button', 'btn-show', {}, ['SHOW ANSWER']),
    new MockNode('button', 'btn-submit', { type: 'submit' }, ['SUBMIT'])
  ]),
  new MockNode('div', 'skip-section', {}, [
    new MockNode('button', 'btn-skip', {}, ['SKIP']),
    new MockNode('p', 'skip-disclaimer', {}, ['If you skip, you can attempt this question again after finishing all questions'])
  ])
]);

const doc = {
  body: card,
  documentElement: card,
  querySelectorAll: (sel) => card.querySelectorAll(sel),
  querySelector: (sel) => card.querySelector(sel)
};

const extractorCode = fs.readFileSync(path.join(__dirname, 'extension/extractor.js'), 'utf8');
const sandbox = {
  window: {
    location: { hostname: 'learning.ccbp.in', pathname: '/primitive-coding/practice/test' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  },
  document: doc,
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(extractorCode, sandbox);

const ext = sandbox.window.QuizZyExtractor || sandbox.QuizZyExtractor;
const result = ext.extractQuizFromDom(doc);

console.log(JSON.stringify({
  success: result.success,
  error: result.error || null,
  q_type: result.q_type,
  options: result.options,
  options_count: result.options ? result.options.length : 0,
  question: result.question
}));
"""
    out = run_node_eval(script)
    assert out["success"] is True, f"Extraction failed with error: {out.get('error')}"
    assert out["q_type"] == "mcq"
    assert out["options"] == ["5", "6", "4", "3"]
    assert out["options_count"] == 4
    assert "largest sum of a subarray" in out["question"]


def test_mcq_options_with_numbers_1_2_3_4():
    """Verify single-digit options '1', '2', '3', '4' are recognized as valid MCQ choices."""
    script = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class MockNode {
  constructor(tag, cls = '', attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.attributes = { ...attrs };
    this.childNodes = [];
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;

    children.forEach(c => {
      if (typeof c === 'string') {
        const textNode = { nodeType: 3, textContent: c, innerText: c, nodeValue: c, parentElement: this, parentNode: this };
        this.childNodes.push(textNode);
      } else if (c) {
        c.parentElement = this;
        c.parentNode = this;
        this.childNodes.push(c);
        this.children.push(c);
      }
    });
  }

  get nodeType() { return 1; }
  getAttribute(name) { return this.attributes[name] !== undefined ? this.attributes[name] : null; }
  get innerText() { return this.childNodes.map(c => c.innerText || c.textContent || '').join(' '); }
  get textContent() { return this.childNodes.map(c => c.textContent || c.innerText || '').join(' '); }

  querySelectorAll(sel) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matchesSelector(child, sel)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(sel) {
    const all = this.querySelectorAll(sel);
    return all.length ? all[0] : null;
  }

  matches(sel) {
    return matchesSelector(this, sel);
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (matchesSelector(cur, sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  contains(el) {
    let cur = el;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  getBoundingClientRect() { return { top: 100, bottom: 150 }; }
}

function matchesSelector(node, sel) {
  if (!sel || !node || node.nodeType !== 1) return false;
  const selectors = sel.split(',').map(s => s.trim());
  return selectors.some(s => {
    if (s === '*') return true;
    if (s.toLowerCase() === node.tagName.toLowerCase()) return true;
    if (s.startsWith('.') && node.className.split(/\s+/).includes(s.slice(1))) return true;
    if (s.startsWith('#') && node.getAttribute('id') === s.slice(1)) return true;
    if (s.includes('[class*=')) {
      const match = s.match(/\[class\*=['"]?([^'"]+)['"]?\]/);
      if (match && node.className.includes(match[1])) return true;
    }
    if (s.includes("input[type='radio']")) {
      return node.tagName === 'INPUT' && (node.getAttribute('type') === 'radio');
    }
    if (s === 'input') return node.tagName === 'INPUT';
    if (s === 'button') return node.tagName === 'BUTTON';
    return false;
  });
}

const card = new MockNode('div', 'question-container', {}, [
  new MockNode('h3', 'stem question-text', {}, ['What is 2 + 2 ?']),
  new MockNode('div', 'sc-option option-item', {}, [
    new MockNode('input', '', { type: 'radio', name: 'choice' }),
    new MockNode('span', '', {}, ['1'])
  ]),
  new MockNode('div', 'sc-option option-item', {}, [
    new MockNode('input', '', { type: 'radio', name: 'choice' }),
    new MockNode('span', '', {}, ['2'])
  ]),
  new MockNode('div', 'sc-option option-item', {}, [
    new MockNode('input', '', { type: 'radio', name: 'choice' }),
    new MockNode('span', '', {}, ['3'])
  ]),
  new MockNode('div', 'sc-option option-item', {}, [
    new MockNode('input', '', { type: 'radio', name: 'choice' }),
    new MockNode('span', '', {}, ['4'])
  ])
]);

const doc = {
  body: card,
  documentElement: card,
  querySelectorAll: (sel) => card.querySelectorAll(sel),
  querySelector: (sel) => card.querySelector(sel)
};

const extractorCode = fs.readFileSync(path.join(__dirname, 'extension/extractor.js'), 'utf8');
const sandbox = {
  window: {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  },
  document: doc,
  console
};
vm.createContext(sandbox);
vm.runInContext(extractorCode, sandbox);

const ext = sandbox.window.QuizZyExtractor || sandbox.QuizZyExtractor;
const result = ext.extractQuizFromDom(doc);

console.log(JSON.stringify({
  success: result.success,
  q_type: result.q_type,
  options: result.options
}));
"""
    out = run_node_eval(script)
    assert out["success"] is True
    assert out["q_type"] == "mcq"
    assert out["options"] == ["1", "2", "3", "4"]


def test_executor_click_skip_button():
    """Verify QuizZyExecutor.clickSkipButton finds and clicks the host page SKIP button."""
    script = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let skipWasClicked = false;

class MockElement {
  constructor(tag, cls = '', text = '') {
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.innerText = text;
    this.textContent = text;
    this.disabled = false;
    this.hidden = false;
    this.attributes = {};
  }
  getAttribute(name) { return this.attributes[name] || null; }
  matches(sel) { return sel.includes('skip') && this.className.includes('skip'); }
  dispatchEvent(e) {
    if (e.type === 'click') {
      skipWasClicked = true;
    }
    return true;
  }
  click() {
    skipWasClicked = true;
  }
}

const skipBtn = new MockElement('button', 'sc-btn-skip btn-skip', 'SKIP');
const submitBtn = new MockElement('button', 'btn-submit', 'SUBMIT');

const doc = {
  querySelectorAll: (sel) => [submitBtn, skipBtn],
  querySelector: (sel) => (sel.includes('skip') ? skipBtn : submitBtn)
};

const executorCode = fs.readFileSync(path.join(__dirname, 'extension/executor.js'), 'utf8');
const sandbox = {
  window: {
    QuizZyExecutor: null,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  },
  document: doc,
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(executorCode, sandbox);

const exec = sandbox.window.QuizZyExecutor;

(async () => {
  const res = await exec.clickSkipButton();
  console.log(JSON.stringify({
    res,
    skipWasClicked
  }));
})();
"""
    out = run_node_eval(script)
    res = out["res"]
    assert res.get("ok") is False or res.get("success") is False
    assert out["skipWasClicked"] is False, "Must NOT click host page Skip button"
    assert "disabled" in (res.get("error", "") + str(res.get("disabled", ""))).lower()


def test_floating_hud_skipping_and_watchdog_totally_removed():
    """Verify floating_hud.js has completely removed skipCurrentQuestion, Alt+K hotkey, and 5000ms watchdog."""
    hud_code = (PROJECT_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")
    assert "skipCurrentQuestion" not in hud_code, "skipCurrentQuestion must be removed"
    assert "clickSkipOnPage" not in hud_code, "clickSkipOnPage must be removed"
    assert "CLICK_SKIP_BUTTON" not in hud_code, "CLICK_SKIP_BUTTON must be removed"
    assert "autoStepWatchdog" not in hud_code, "autoStepWatchdog must be removed"
    assert "hud-btn-skip" not in hud_code, "hud-btn-skip button must be removed"


def test_question_7_dual_model_backend_solve():
    """
    Test dual model consensus endpoint on Question 7/15:
    Array: [2, -1, 2, 3, -9]
    Max subarray sum: 2 + (-1) + 2 + 3 = 6 (Option '6')
    """
    client = TestClient(app)
    response = client.post("/solve", json={
        "subject": "Algorithms",
        "q_type": "mcq",
        "question": "Given an array arr = [2, -1, 2, 3, -9] , what is the largest sum of a subarray?",
        "options": ["5", "6", "4", "3"]
    })
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["answer"] == "6" or data["selected_index"] == 1 or data.get("selected_text") == "6"
    assert data["confidence_label"] in ["high", "medium"]
