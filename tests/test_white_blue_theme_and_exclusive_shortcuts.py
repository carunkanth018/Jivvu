"""Tests for Strict White & Blue UI Theme, Mutual Exclusivity, and Global Shortcut Routing."""

import os
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"


def test_strict_white_and_blue_color_palette():
    """Verify that only white and blue colors appear in sidepanel.css, sidepanel.js, and floating_hud.js."""
    css_code = (PROJECT_ROOT / "extension" / "sidepanel.css").read_text(encoding="utf-8")
    hud_code = (PROJECT_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")
    sp_code = (PROJECT_ROOT / "extension" / "sidepanel.js").read_text(encoding="utf-8")

    # Extract HUD_STYLES block from floating_hud.js
    hud_styles_match = re.search(r"const HUD_STYLES = `([\s\S]*?)`;", hud_code)
    assert hud_styles_match is not None, "HUD_STYLES block not found in floating_hud.js"
    hud_styles = hud_styles_match.group(1)

    # Disallowed non-white/blue color tokens (green, red, amber, orange, yellow, purple)
    forbidden_colors = [
        # Greens
        r"#22C55E", r"#10B981", r"#16A34A", r"#34D399", r"#4ADE80", r"#86EFAC",
        r"rgba\(\s*34,\s*197,\s*94", r"rgba\(\s*16,\s*185,\s*129",
        # Reds
        r"#EF4444", r"#DC2626", r"#F87171", r"#FCA5A5",
        r"rgba\(\s*239,\s*68,\s*68",
        # Ambers / Oranges / Yellows
        r"#F59E0B", r"#FBBF24", r"#FB923C", r"#D97706",
        r"rgba\(\s*245,\s*158,\s*11", r"rgba\(\s*249,\s*115,\s*22",
        # Purples / Indigos
        r"#8B5CF6", r"#7C3AED", r"#6D28D9", r"#C084FC", r"#A855F7", r"#818CF8",
        r"rgba\(\s*168,\s*85,\s*247", r"rgba\(\s*99,\s*102,\s*241"
    ]

    # Strip dot glow indicator rules which are required by user specification for dot status
    hud_styles_bar_only = re.sub(r"\.hud-(?:mini-dot\.glow-(?:red|green|orange|violet)|health-dot\.portal-active)[\s\S]*?\}", "", hud_styles)
    hud_styles_bar_only = re.sub(r"@keyframes (?:hud-dot-pulse-(?:red|green|orange)|quizzyVioletPulse)[\s\S]*?\}\s*\}", "", hud_styles_bar_only)

    for pattern in forbidden_colors:
        assert not re.search(pattern, css_code, re.IGNORECASE), f"Found forbidden non-white/blue color {pattern} in sidepanel.css"
        assert not re.search(pattern, hud_styles_bar_only, re.IGNORECASE), f"Found forbidden non-white/blue color {pattern} in floating_hud.js (outside status dot indicators)"

    # Verify showAlert in sidepanel.js uses white & blue styles
    assert "rgba(239, 68, 68" not in sp_code
    assert "rgba(34, 197, 94" not in sp_code
    assert "rgba(37, 99, 235" in sp_code
    assert "rgba(96, 165, 250" in sp_code


def test_mutual_exclusivity_contracts():
    """Verify mutual exclusivity contracts: only one can be open at a time."""
    bg_code = (PROJECT_ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    hud_code = (PROJECT_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")
    sp_code = (PROJECT_ROOT / "extension" / "sidepanel.js").read_text(encoding="utf-8")

    # 1. Background monitors side panel open/closed lifecycle via port
    assert "quizzy-sidepanel-port" in bg_code
    assert "isSidePanelOpen" in bg_code
    assert "SIDEPANEL_STATE_CHANGED" in bg_code
    assert "HIDE_FLOATING_HUD_COMMAND" in bg_code
    assert "CLOSE_SIDEPANEL_COMMAND" in bg_code

    # 2. Sidepanel establishes port connection and handles close command
    assert "quizzy-sidepanel-port" in sp_code
    assert "CLOSE_SIDEPANEL_COMMAND" in sp_code
    assert "window.close()" in sp_code

    # 3. Floating HUD tracks sidepanel state, hides when sidepanel opens, and closes sidepanel when HUD opens
    assert "isSidePanelOpen" in hud_code
    assert "SIDEPANEL_STATE_CHANGED" in hud_code
    assert "CLOSE_SIDEPANEL" in hud_code


def test_shortcut_routing_and_everywhere_operation_contracts():
    """Verify shortcut parity and routing everywhere (floating HUD vs side panel)."""
    hud_code = (PROJECT_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")
    sp_code = (PROJECT_ROOT / "extension" / "sidepanel.js").read_text(encoding="utf-8")
    bg_code = (PROJECT_ROOT / "extension" / "background.js").read_text(encoding="utf-8")

    # Background routes shortcuts to sidepanel when sidepanel is open
    assert "FORWARD_SHORTCUT_TO_SIDEPANEL" in bg_code

    # Floating HUD forwards shortcuts to sidepanel when isSidePanelOpen is true
    assert "FORWARD_SHORTCUT_TO_SIDEPANEL" in hud_code

    # Sidepanel receives forwarded shortcuts and has solo Shift toggle
    assert "FORWARD_SHORTCUT_TO_SIDEPANEL" in sp_code
    assert "shiftDownSp" in sp_code
    assert "shiftComboUsedSp" in sp_code


def test_node_vm_exclusive_shortcuts_execution():
    """Execute Node VM simulated runtime tests verifying mutual exclusivity and shortcut routing."""
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
      constructor(tag = 'div', isText = false) {{
        if (isText) {{
          this.nodeType = 3;
          this.nodeValue = String(tag);
          this.children = [];
          this.childNodes = this.children;
        }} else {{
          this.nodeType = 1;
          this.tagName = tag.toUpperCase();
          this.children = [];
          this.childNodes = this.children;
          this.attributes = {{}};
          this.style = {{}};
          this.classList = new MockClassList();
          this.shadowRoot = null;
          this.id = '';
        }}
      }}
      addEventListener(type, fn) {{ this.listeners = this.listeners || {{}}; this.listeners[type] = fn; }}
      removeEventListener() {{}}
      setAttribute(k, v) {{ this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }}
      getAttribute(k) {{ return this.attributes[k] || null; }}
      appendChild(node) {{ this.children.push(node); node.parentNode = this; node.parentElement = this; return node; }}
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
        this.childNodes = this.children;
      }}
      querySelector(sel) {{ return new MockNode('div'); }}
      querySelectorAll(sel) {{ return []; }}
    }}

    const mockDoc = new MockNode('#document');
    mockDoc.documentElement = new MockNode('html');
    mockDoc.body = new MockNode('body');
    mockDoc.createElement = (tag) => new MockNode(tag);
    mockDoc.getElementById = (id) => new MockNode(id);

    let sentMessages = [];
    let messageListener = null;
    const windowListeners = {{}};

    const sandbox = {{
      document: mockDoc,
      window: null,
      navigator: {{ userAgent: 'Chrome' }},
      location: {{ pathname: '/quiz/1' }},
      history: {{ pushState: () => {{}}, replaceState: () => {{}} }},
      Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
      setInterval: () => 0,
      clearInterval: () => {{}},
      setTimeout: (fn, ms) => {{
        if (!ms || ms <= 300) fn();
        return 1;
      }},
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
            sentMessages.push(msg);
            if (cb) cb({{ success: true }});
          }},
          onMessage: {{
            addListener: (fn) => {{ messageListener = fn; }}
          }}
        }}
      }},
      addEventListener: (type, fn) => {{ windowListeners[type] = fn; }},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    const hudInstance = vm.runInNewContext(hudCode, sandbox);

    // 1. Initial State: Side panel closed, HUD operates locally
    if (hudInstance.isSidePanelOpen) {{
      console.error('FAIL: Initial isSidePanelOpen should be false');
      process.exit(1);
    }}

    // 2. When side panel opens, message arrives: HUD hides and sets isSidePanelOpen = true
    messageListener({{ action: 'SIDEPANEL_STATE_CHANGED', isOpen: true }});
    if (!hudInstance.isSidePanelOpen) {{
      console.error('FAIL: isSidePanelOpen should be true after SIDEPANEL_STATE_CHANGED');
      process.exit(1);
    }}
    if (!hudInstance.isHidden()) {{
      console.error('FAIL: Floating HUD should be hidden when side panel is open');
      process.exit(1);
    }}

    // 3. Shortcuts pressed on web page while side panel is open -> forward to side panel!
    sentMessages = [];
    windowListeners['keydown']({{ altKey: true, key: 's', code: 'KeyS' }});
    const forwardedSolve = sentMessages.find(m => m.action === 'FORWARD_SHORTCUT_TO_SIDEPANEL' && m.command === 'trigger_solve');
    if (!forwardedSolve) {{
      console.error('FAIL: Alt+S did not forward to side panel when side panel is open');
      process.exit(1);
    }}

    // 3b. Shift key pressed while side panel is open -> forward auto mode to side panel!
    sentMessages = [];
    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});
    const forwardedAuto = sentMessages.find(m => m.action === 'FORWARD_SHORTCUT_TO_SIDEPANEL' && m.command === 'trigger_auto');
    if (!forwardedAuto) {{
      console.error('FAIL: Shift key did not forward auto command to side panel');
      process.exit(1);
    }}

    // 4. Ctrl key pressed while side panel is open -> closes side panel and reveals floating HUD!
    sentMessages = [];
    windowListeners['keydown']({{ key: 'Control', code: 'ControlLeft' }});
    windowListeners['keyup']({{ key: 'Control', code: 'ControlLeft' }});
    const closeSidePanelMsg = sentMessages.find(m => m.action === 'CLOSE_SIDEPANEL');
    if (!closeSidePanelMsg) {{
      console.error('FAIL: Ctrl did not send CLOSE_SIDEPANEL command');
      process.exit(1);
    }}
    if (hudInstance.isHidden()) {{
      console.error('FAIL: Floating HUD should become visible when opened via Ctrl');
      process.exit(1);
    }}

    console.log('EXCLUSIVE_SHORTCUTS_TEST_OK');
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
    assert "EXCLUSIVE_SHORTCUTS_TEST_OK" in res.stdout

