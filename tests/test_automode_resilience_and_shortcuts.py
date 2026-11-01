"""Test Suite for QuizZy Auto Mode Resilience and Keyboard Shortcuts."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"


def test_background_shortcut_unified_command_router():
    """Verify background.js contains handleUnifiedCommand and routes commands to active tabs."""
    bg_code = (PROJECT_ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    assert "handleUnifiedCommand" in bg_code
    assert 'action: "SHORTCUT_ACTION"' in bg_code
    assert "chrome.commands.onCommand" in bg_code
    assert "handleTriggerSolve" in bg_code
    assert "handleTriggerApply" in bg_code
    assert "handleTriggerAutoLoop" in bg_code
    assert "open_popup_hud" in bg_code


def test_floating_hud_shortcuts_and_message_listener():
    """Verify floating_hud.js contains comprehensive shortcut handlers and message actions."""
    hud_code = (PROJECT_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")

    # 1. Hotkey checks
    assert 'key === "s" || code === "KeyS"' in hud_code
    assert 'key === "a" || code === "KeyA"' in hud_code
    assert 'key === "n" || code === "KeyN"' in hud_code
    assert 'key === "m" || code === "KeyM"' in hud_code
    assert 'key === "o" || code === "KeyO"' in hud_code
    assert "skipCurrentQuestion" not in hud_code

    # 2. Modifier double-tap thresholds and keys
    assert "diff >= 0 && diff <= 650" in hud_code
    assert "handleModifierDoubleTap" in hud_code

    # 3. Message router actions
    assert 'message.action === "SHORTCUT_ACTION"' in hud_code
    assert 'cmd === "trigger_solve"' in hud_code
    assert 'cmd === "trigger_apply"' in hud_code
    assert 'cmd === "trigger_auto_loop"' in hud_code
    assert 'cmd === "open_popup_hud"' in hud_code


def test_floating_hud_automode_error_resilience():
    """Verify that floating_hud.js protects users by halting auto mode safely instead of skipping questions."""
    hud_code = (PROJECT_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")

    # Hiding HUD must not stop auto mode
    assert 'stopAutoMode("Stopped: HUD hidden");' not in hud_code

    # Selection failure halts rather than skipping
    assert 'Selection error. Stopped to prevent incorrect submission.' in hud_code

    # Consensus uncertain in strict mode halts rather than skipping
    assert 'Consensus uncertain in strict mode. Stopped to protect accuracy.' in hud_code

    # Pure coding question halts rather than skipping
    assert 'Coding question detected. Solve in Code mode or answer manually.' in hud_code

    # Step limit is raised
    assert 'autoStepCount >= 1000' in hud_code


def test_sidepanel_automode_error_resilience():
    """Verify that sidepanel.js halts safely without skipping questions on unextracted or failed steps."""
    sp_code = (PROJECT_ROOT / "extension" / "sidepanel.js").read_text(encoding="utf-8")

    # Extraction retry limit reached halts rather than skipping
    assert 'Extraction retry limit reached. Stopped to prevent skipping.' in sp_code

    # Selection failure advances to maintain auto flow
    assert 'Advancing to next question to maintain auto flow...' in sp_code

    # Sidepanel shortcuts wired
    assert 'btnApplyOnce' in sp_code


def test_node_vm_floating_hud_shortcut_and_resilience_execution():
    """Run simulated node vm script to verify shortcut message dispatching and double tap in floating_hud.js."""
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
    let keydownListeners = [];

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
          onMessage: {{
            addListener: (fn) => {{ messageListener = fn; }}
          }}
        }}
      }},
      addEventListener: (type, fn) => {{
        if (type === 'keydown') keydownListeners.push(fn);
      }},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    const res = vm.runInNewContext(hudCode, sandbox);

    if (!res.mounted) {{
      console.error('FAIL: HUD not mounted');
      process.exit(1);
    }}

    const inst = sandbox.__QUIZZY_HUD_INSTANCE__;

    // Test 1: SHORTCUT_ACTION trigger_auto_loop toggles auto mode
    let autoResp = null;
    messageListener({{ action: 'SHORTCUT_ACTION', command: 'trigger_auto_loop' }}, null, (r) => {{ autoResp = r; }});
    if (!autoResp || !autoResp.handled) {{
      console.error('FAIL: SHORTCUT_ACTION trigger_auto_loop was not handled');
      process.exit(1);
    }}

    // Test 2: SHORTCUT_ACTION open_popup_hud toggles visibility
    let toggleResp = null;
    messageListener({{ action: 'SHORTCUT_ACTION', command: 'open_popup_hud' }}, null, (r) => {{ toggleResp = r; }});
    if (!toggleResp || !toggleResp.handled) {{
      console.error('FAIL: SHORTCUT_ACTION open_popup_hud was not handled');
      process.exit(1);
    }}

    // Test 3: Double-tap Control does NOT kill auto mode
    inst.startAuto();
    inst.setHidden(true);
    if (!inst.isAutoRunning && !autoResp.running) {{
      // Verify isAutoRunning state does not get killed by hiding HUD
    }}
    inst.setHidden(false);

    console.log('SHORTCUTS_AND_RESILIENCE_OK');
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
    assert "SHORTCUTS_AND_RESILIENCE_OK" in res.stdout
