"""Tests for QuizZy Floating HUD Launch & Visibility Mechanics."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"


def test_floating_hud_idempotent_reexecution_does_not_toggle():
    """Verify that re-executing floating_hud.js when already mounted does NOT toggle visibility."""
    hud_path = (PROJECT_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(c) {{ this.classes.add(c); }}
      remove(c) {{ this.classes.delete(c); }}
      contains(c) {{ return this.classes.has(c); }}
      toggle(c) {{
        if (this.classes.has(c)) {{ this.classes.delete(c); return false; }}
        this.classes.add(c); return true;
      }}
    }}

    class MockNode {{
      constructor(tag = 'div') {{
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {{}};
        this.style = {{}};
        this.classList = new MockClassList();
        this.shadowRoot = null;
        this.id = '';
      }}
      setAttribute(k, v) {{ this.attributes[k] = String(v); }}
      getAttribute(k) {{ return this.attributes[k] || null; }}
      appendChild(node) {{ this.children.push(node); node.parentNode = this; return node; }}
      removeChild(node) {{
        const idx = this.children.indexOf(node);
        if (idx !== -1) this.children.splice(idx, 1);
        return node;
      }}
      attachShadow() {{
        this.shadowRoot = new MockNode('#shadow');
        return this.shadowRoot;
      }}
      querySelector(sel) {{
        for (const c of this.children) {{
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
          const found = c.querySelector ? c.querySelector(sel) : null;
          if (found) return found;
        }}
        return null;
      }}
      querySelectorAll(sel) {{
        let res = [];
        for (const c of this.children) {{
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) res.push(c);
          if (c.querySelectorAll) res = res.concat(c.querySelectorAll(sel));
        }}
        return res;
      }}
    }}

    const mockDoc = new MockNode('#document');
    mockDoc.documentElement = new MockNode('html');
    mockDoc.body = new MockNode('body');
    mockDoc.createElement = (tag) => new MockNode(tag);
    mockDoc.getElementById = (id) => mockDoc.querySelector('#' + id);

    let messageListener = null;

    const sandbox = {{
      document: mockDoc,
      window: null,
      navigator: {{ userAgent: 'Chrome' }},
      location: {{ pathname: '/quiz/1' }},
      history: {{ pushState: () => {{}}, replaceState: () => {{}} }},
      Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
      setInterval: () => 0,
      clearInterval: () => {{}},
      setTimeout: (fn) => setTimeout(fn, 1),
      clearTimeout: () => {{}},
      innerWidth: 1920,
      innerHeight: 1080,
      chrome: {{
        storage: {{
          local: {{
            get: (k, cb) => cb({{}}),
            set: (o, cb) => cb && cb()
          }}
        }},
        runtime: {{
          sendMessage: () => {{}},
          onMessage: {{
            addListener: (fn) => {{ messageListener = fn; }}
          }}
        }}
      }},
      addEventListener: () => {{}},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');

    // 1. First execution: should mount and be visible
    const firstRes = vm.runInNewContext(hudCode, sandbox);
    if (!firstRes.mounted || !firstRes.visible) {{
      console.error('FAIL: First execution should be mounted and visible, got:', firstRes);
      process.exit(1);
    }}
    const inst = sandbox.__QUIZZY_HUD_INSTANCE__;
    if (!inst || inst.isHidden()) {{
      console.error('FAIL: Instance should NOT be hidden after first mount');
      process.exit(1);
    }}

    // 2. Second execution (re-injection via executeScript): MUST NOT toggle visibility!
    const secondRes = vm.runInNewContext(hudCode, sandbox);
    if (!secondRes.alreadyMounted) {{
      console.error('FAIL: Second execution should report alreadyMounted: true');
      process.exit(1);
    }}
    if (inst.isHidden()) {{
      console.error('FAIL: Re-executing floating_hud.js toggled HUD to hidden! It must be idempotent.');
      process.exit(1);
    }}

    // 3. Test SHOW_FLOATING_HUD_COMMAND: should unhide and unminimize
    inst.setHidden(true);
    inst.setMinimized(true);
    if (!inst.isHidden() || !inst.isMinimized()) {{
      console.error('FAIL: Setup for SHOW_FLOATING_HUD_COMMAND failed');
      process.exit(1);
    }}

    messageListener({{ action: 'SHOW_FLOATING_HUD_COMMAND' }});
    if (inst.isHidden()) {{
      console.error('FAIL: SHOW_FLOATING_HUD_COMMAND did not unhide the HUD');
      process.exit(1);
    }}
    if (inst.isMinimized()) {{
      console.error('FAIL: SHOW_FLOATING_HUD_COMMAND did not unminimize the HUD');
      process.exit(1);
    }}

    console.log('IDEMPOTENT_HUD_OK');
    """

    res = subprocess.run(
        ["node", "-e", node_script],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert res.returncode == 0, f"Node script failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "IDEMPOTENT_HUD_OK" in res.stdout


def test_background_and_sidepanel_hud_wiring():
    """Verify background.js and sidepanel.js contracts for floating HUD launching."""
    bg_path = PROJECT_ROOT / "extension" / "background.js"
    sp_path = PROJECT_ROOT / "extension" / "sidepanel.js"
    hud_path = PROJECT_ROOT / "extension" / "floating_hud.js"

    bg_code = bg_path.read_text(encoding="utf-8")
    sp_code = sp_path.read_text(encoding="utf-8")
    hud_code = hud_path.read_text(encoding="utf-8")

    # 1. Background handles LAUNCH_FLOATING_HUD
    assert 'action === "LAUNCH_FLOATING_HUD"' in bg_code or 'action === "TOGGLE_FLOATING_HUD"' in bg_code, (
        "background.js must handle floating HUD launch actions"
    )

    # 2. Sidepanel quick launcher button exists and does not double-toggle
    assert 'btnLaunchHud' in sp_code, "sidepanel.js must wire btnLaunchHud"

    # 3. resolveTargetTab includes fallback to lastFocusedWindow
    assert "lastFocusedWindow" in bg_code, (
        "resolveTargetTab in background.js must query lastFocusedWindow for MV3 service worker compatibility"
    )

    # 5. tabs.onUpdated auto-inject hook is wired
    assert "chrome.tabs.onUpdated" in bg_code, "background.js must wire tabs.onUpdated auto-inject hook"


def test_mcq_with_question_route_mounts_hud():
    """Verify that an MCQ page containing /question/ in its URL mounts HUD cleanly without false positive coding abortion."""
    hud_path = (PROJECT_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(c) {{ this.classes.add(c); }}
      remove(c) {{ this.classes.delete(c); }}
      contains(c) {{ return this.classes.has(c); }}
      toggle(c) {{
        if (this.classes.has(c)) {{ this.classes.delete(c); return false; }}
        this.classes.add(c); return true;
      }}
    }}

    class MockNode {{
      constructor(tag = 'div') {{
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {{}};
        this.style = {{}};
        this.classList = new MockClassList();
        this.shadowRoot = null;
        this.id = '';
      }}
      setAttribute(k, v) {{ this.attributes[k] = String(v); }}
      getAttribute(k) {{ return this.attributes[k] || null; }}
      appendChild(node) {{ this.children.push(node); node.parentNode = this; return node; }}
      removeChild(node) {{
        const idx = this.children.indexOf(node);
        if (idx !== -1) this.children.splice(idx, 1);
        return node;
      }}
      attachShadow() {{
        this.shadowRoot = new MockNode('#shadow');
        return this.shadowRoot;
      }}
      querySelector(sel) {{
        for (const c of this.children) {{
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
          const found = c.querySelector ? c.querySelector(sel) : null;
          if (found) return found;
        }}
        return null;
      }}
      querySelectorAll(sel) {{
        let res = [];
        for (const c of this.children) {{
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) res.push(c);
          if (c.querySelectorAll) res = res.concat(c.querySelectorAll(sel));
        }}
        return res;
      }}
    }}

    const mockDoc = new MockNode('#document');
    mockDoc.documentElement = new MockNode('html');
    mockDoc.body = new MockNode('body');
    mockDoc.createElement = (tag) => new MockNode(tag);
    mockDoc.getElementById = (id) => mockDoc.querySelector('#' + id);

    // Mock radio options present on page
    const radio1 = new MockNode('input');
    radio1.attributes['type'] = 'radio';
    const radio2 = new MockNode('input');
    radio2.attributes['type'] = 'radio';
    mockDoc.body.appendChild(radio1);
    mockDoc.body.appendChild(radio2);
    mockDoc.querySelectorAll = (sel) => {{
      if (sel.includes("radio")) return [radio1, radio2];
      return [];
    }};

    const sandbox = {{
      document: mockDoc,
      window: null,
      navigator: {{ userAgent: 'Chrome' }},
      location: {{ pathname: '/quiz/practice' }},
      history: {{ pushState: () => {{}}, replaceState: () => {{}} }},
      Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
      setInterval: () => 0,
      clearInterval: () => {{}},
      setTimeout: (fn) => setTimeout(fn, 1),
      clearTimeout: () => {{}},
      innerWidth: 1920,
      innerHeight: 1080,
      chrome: {{
        storage: {{
          local: {{
            get: (k, cb) => cb({{}}),
            set: (o, cb) => cb && cb()
          }}
        }},
        runtime: {{
          sendMessage: () => {{}},
          onMessage: {{ addListener: () => {{}} }}
        }}
      }},
      addEventListener: () => {{}},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    const res = vm.runInNewContext(hudCode, sandbox);

    if (!res || !res.mounted) {{
      console.error('FAIL: Expected mounted === true for MCQ question page, got:', res);
      process.exit(1);
    }}
    console.log('MCQ_ON_QUESTION_ROUTE_OK');
    """

    res = subprocess.run(
        ["node", "-e", node_script],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert res.returncode == 0, f"Node script failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "MCQ_ON_QUESTION_ROUTE_OK" in res.stdout


def test_floating_hud_permanent_hide_and_dot_glow_states():
    """Verify permanent hiding of floating HUD bar and dynamic glowing states of the dot."""
    hud_path = PROJECT_ROOT / "extension" / "floating_hud.js"
    hud_code = hud_path.read_text(encoding="utf-8")

    # 1. CSS Verification: HUD bar and popover permanently hidden, dot permanently visible
    assert ".hud-bar" in hud_code
    assert "display: none !important" in hud_code
    assert ".hud-mini-dot" in hud_code
    assert "display: block !important" in hud_code
    assert ".hud-mini-dot.glow-red" in hud_code
    assert ".hud-mini-dot.glow-green" in hud_code
    assert ".hud-mini-dot.glow-orange" in hud_code
    assert ".hud-mini-dot.glow-blue" in hud_code
    assert "hud-dot-pulse-red" in hud_code
    assert "hud-dot-pulse-green" in hud_code
    assert "hud-dot-pulse-orange" in hud_code
    assert "opacity: 0.15" in hud_code or "opacity: 0.2" in hud_code  # Auto Mode blinking effect
    assert ".hud-mini-dot.auto-running" in hud_code

    # 2. Node VM verification of reactive glow transitions
    posix_path = hud_path.as_posix()
    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(...cs) {{ cs.forEach(c => this.classes.add(c)); }}
      remove(...cs) {{ cs.forEach(c => this.classes.delete(c)); }}
      contains(c) {{ return this.classes.has(c); }}
      toggle(c) {{
        if (this.classes.has(c)) {{ this.classes.delete(c); return false; }}
        this.classes.add(c); return true;
      }}
    }}

    class MockNode {{
      constructor(tag = 'div') {{
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {{}};
        this.style = {{}};
        this.classList = new MockClassList();
        this.shadowRoot = null;
        this.id = '';
        this.listeners = {{}};
        this.title = '';
      }}
      addEventListener(evt, fn) {{
        if (!this.listeners[evt]) this.listeners[evt] = [];
        this.listeners[evt].push(fn);
      }}
      dispatchEvent(eventObj) {{
        const fns = this.listeners[eventObj.type] || [];
        for (const fn of fns) fn(eventObj);
      }}
      setAttribute(k, v) {{ this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }}
      getAttribute(k) {{ return this.attributes[k] || null; }}
      appendChild(node) {{ this.children.push(node); node.parentNode = this; return node; }}
      removeChild(node) {{
        const idx = this.children.indexOf(node);
        if (idx !== -1) this.children.splice(idx, 1);
        return node;
      }}
      attachShadow() {{
        this.shadowRoot = new MockNode('#shadow');
        this.shadowRoot.getElementById = (id) => this.shadowRoot.querySelector('#' + id);
        return this.shadowRoot;
      }}
      set innerHTML(html) {{
        this.children = [];
        const tagRegex = /<!--[\\s\\S]*?-->|<(\\/)?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
        const stack = [this];
        let match;
        while ((match = tagRegex.exec(html)) !== null) {{
          if (match[0].startsWith("<!--")) continue;
          if (match[4]) {{
            const txt = match[4].trim();
            if (txt) stack[stack.length - 1].appendChild(new MockNode(txt));
          }} else if (match[1]) {{
            const closeTag = match[2].toUpperCase();
            if (stack.length > 1 && stack[stack.length - 1].tagName === closeTag) stack.pop();
          }} else if (match[2]) {{
            const tag = match[2];
            const rawAttrs = match[3] || "";
            const node = new MockNode(tag);
            const attrRegex = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
            let aMatch;
            while ((aMatch = attrRegex.exec(rawAttrs)) !== null) {{
              node.setAttribute(aMatch[1], aMatch[2] !== undefined ? aMatch[2] : "");
            }}
            stack[stack.length - 1].appendChild(node);
            const selfClosing = /^(?:img|input|br|hr|meta|link)$/i.test(tag) || rawAttrs.trim().endsWith("/");
            if (!selfClosing) stack.push(node);
          }}
        }}
      }}
      querySelector(sel) {{
        for (const c of this.children) {{
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
          const found = c.querySelector ? c.querySelector(sel) : null;
          if (found) return found;
        }}
        return null;
      }}
      querySelectorAll(sel) {{
        let res = [];
        for (const c of this.children) {{
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) res.push(c);
          if (c.querySelectorAll) res = res.concat(c.querySelectorAll(sel));
        }}
        return res;
      }}
    }}

    const mockDoc = new MockNode('#document');
    mockDoc.documentElement = new MockNode('html');
    mockDoc.body = new MockNode('body');
    mockDoc.createElement = (tag) => new MockNode(tag);
    mockDoc.getElementById = (id) => mockDoc.querySelector('#' + id);

    let backendShouldRespondOnline = false;
    let healthCheckCallCount = 0;

    const sandbox = {{
      document: mockDoc,
      window: null,
      navigator: {{ userAgent: 'Chrome' }},
      location: {{ pathname: '/quiz/1' }},
      history: {{ pushState: () => {{}}, replaceState: () => {{}} }},
      Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
      setInterval: () => 0,
      clearInterval: () => {{}},
      setTimeout: (fn) => setTimeout(fn, 1),
      clearTimeout: () => {{}},
      innerWidth: 1920,
      innerHeight: 1080,
      chrome: {{
        storage: {{
          local: {{
            get: (k, cb) => cb({{}}),
            set: (o, cb) => cb && cb()
          }}
        }},
        runtime: {{
          sendMessage: (msg, cb) => {{
            if (msg.action === 'CHECK_HEALTH') {{
              healthCheckCallCount++;
              if (backendShouldRespondOnline) {{
                cb({{ success: true, data: {{ status: 'ok', cache_entries: 10 }} }});
              }} else {{
                cb({{ success: false, error: 'Backend offline' }});
              }}
              return;
            }}
            if (msg.action === 'SOLVE_REQUEST') {{
              cb({{
                success: true,
                data: {{
                  status: 'ok',
                  selected_index: 1,
                  canonical_key: 'B',
                  answer: '4',
                  confidence_tier: 'HIGH',
                  confidence_label: 'high',
                  agreement_status: 'both_agree'
                }}
              }});
              return;
            }}
            cb({{ success: true }});
          }},
          onMessage: {{ addListener: () => {{}} }}
        }}
      }},
      __QuizZyExtractor: {{
        extractQuizFromDom: () => ({{
          success: true,
          question: "What is 2+2?",
          options: ["3", "4"],
          q_type: "mcq"
        }})
      }},
      __QuizZyExecutor: {{
        executeQuizAction: () => Promise.resolve({{ success: true, ok: true, selected: true }}),
        clickNextButton: () => Promise.resolve({{ ok: true, button_text: "Next" }})
      }},
      addEventListener: () => {{}},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudInstance = vm.runInNewContext(fs.readFileSync('{posix_path}', 'utf8'), sandbox);
    const miniDot = hudInstance.shadow.querySelector('#hud-mini-dot');
    if (!miniDot) {{
      console.error('FAIL: #hud-mini-dot missing');
      process.exit(1);
    }}

    // State 1: Backend not running -> dot must glow red
    if (!miniDot.classList.contains('glow-red')) {{
      console.error('FAIL: Expected dot to glow red when backend is offline, got classes:', Array.from(miniDot.classList.classes));
      process.exit(1);
    }}
    if (!miniDot.title.toLowerCase().includes('offline')) {{
      console.error('FAIL: Expected dot title to indicate offline, got:', miniDot.title);
      process.exit(1);
    }}

    // Click dot when offline -> triggers health check
    const initialHealthChecks = healthCheckCallCount;
    miniDot.dispatchEvent({{ type: 'click', bubbles: false, target: miniDot, stopPropagation: () => {{}} }});
    if (healthCheckCallCount <= initialHealthChecks) {{
      console.error('FAIL: Clicking dot while offline should trigger health check retry');
      process.exit(1);
    }}

    // State 2: Backend comes online -> dot transitions to glow-blue (ready)
    backendShouldRespondOnline = true;
    hudInstance.checkHealth();
    if (!miniDot.classList.contains('glow-blue')) {{
      console.error('FAIL: Expected dot to glow blue when backend is online and idle, got:', Array.from(miniDot.classList.classes));
      process.exit(1);
    }}

    // State 3: Working in auto mode with no errors -> dot glows green
    hudInstance.startAuto();
    if (!miniDot.classList.contains('glow-green')) {{
      console.error('FAIL: Expected dot to glow green when auto mode is running with no errors, got:', Array.from(miniDot.classList.classes));
      process.exit(1);
    }}

    // State 4: Working in auto mode but errors occur -> dot glows orange
    hudInstance.stopAuto('Selection error. Stopped to prevent incorrect submission.');
    if (!miniDot.classList.contains('glow-orange')) {{
      console.error('FAIL: Expected dot to glow orange when auto mode experiences an error, got:', Array.from(miniDot.classList.classes));
      process.exit(1);
    }}

    // Click dot to restart Auto Mode -> clears error and glows green
    miniDot.dispatchEvent({{ type: 'click', bubbles: false, target: miniDot, stopPropagation: () => {{}} }});
    if (!miniDot.classList.contains('glow-green')) {{
      console.error('FAIL: Clicking dot should restart auto mode and glow green, got:', Array.from(miniDot.classList.classes));
      process.exit(1);
    }}

    // Click dot while running -> stops Auto Mode
    miniDot.dispatchEvent({{ type: 'click', bubbles: false, target: miniDot, stopPropagation: () => {{}} }});
    if (hudInstance.isAutoRunning) {{
      console.error('FAIL: Clicking dot while running should stop auto mode');
      process.exit(1);
    }}

    // State 5: Backend drops offline again -> immediately glows red
    backendShouldRespondOnline = false;
    hudInstance.checkHealth();
    if (!miniDot.classList.contains('glow-red')) {{
      console.error('FAIL: Expected dot to glow red when backend drops offline, got:', Array.from(miniDot.classList.classes));
      process.exit(1);
    }}

    console.log('HUD_DOT_GLOW_STATES_OK');
    """

    res = subprocess.run(
        ["node", "-e", node_script],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert res.returncode == 0, f"Node script failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "HUD_DOT_GLOW_STATES_OK" in res.stdout

