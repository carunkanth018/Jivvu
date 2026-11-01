"""Tests for Floating HUD Redirect Suppression, Ctrl Toggle, Double-Click Z to Dot, and Shift Auto Mode."""

import os
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"


def test_hud_redirect_and_interaction_contracts():
    """Verify background.js and floating_hud.js contracts for redirect suppression and shortcuts."""
    bg_code = (PROJECT_ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    hud_code = (PROJECT_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")

    # 1. Background does not auto-show on navigation
    assert "injectAndToggleFloatingHud(tabId, false, false)" in bg_code
    assert "injectAndToggleFloatingHud(details.tabId, false, false)" in bg_code
    assert 'chrome.tabs.sendMessage(tabId, { action: "HIDE_FLOATING_HUD_COMMAND" })' in bg_code

    # 2. Floating HUD handles HIDE_FLOATING_HUD_COMMAND and SPA redirect hide
    assert 'message.action === "HIDE_FLOATING_HUD_COMMAND"' in hud_code
    assert "hud-logo-z" in hud_code

    # 3. Solo tap timer mechanism for Ctrl and Shift
    assert "singleTapTimers" in hud_code
    assert "executeModifierAction" in hud_code


def test_node_vm_hud_interaction_shortcuts():
    """Execute full Node.js runtime tests for Ctrl toggle, Z to dot, Shift to auto, and reversing actions."""
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
      click() {{ if (this.listeners && this.listeners['click']) this.listeners['click'](); }}
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
        const tagRegex = /<!--[\\s\\S]*?-->|<(\\/)?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
        const stack = [this];
        let match;
        while ((match = tagRegex.exec(html)) !== null) {{
          if (match[0].startsWith("<!--")) continue;
          if (match[4]) {{
            const txt = match[4].trim();
            if (txt) stack[stack.length - 1].appendChild(new MockNode(txt, true));
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
          if (sel.startsWith('.') && c.classList && c.classList.contains(sel.slice(1))) return c;
          const found = c.querySelector ? c.querySelector(sel) : null;
          if (found) return found;
        }}
        return null;
      }}
      querySelectorAll(sel) {{
        let res = [];
        for (const c of this.children) {{
          if (sel.startsWith('.') && c.classList && c.classList.contains(sel.slice(1))) res.push(c);
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
        if (!ms || ms <= 300) {{
          fn();
        }}
        return 1;
      }},
      clearTimeout: () => {{}},
      innerWidth: 1920,
      innerHeight: 1080,
      fetch: () => Promise.resolve({{ json: () => Promise.resolve({{ status: "ok" }}) }}),
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
        windowListeners[type] = fn;
      }},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    const hudInstance = vm.runInNewContext(hudCode, sandbox);

    // 1. Verify HIDE_FLOATING_HUD_COMMAND on redirect hides HUD
    messageListener({{ action: 'HIDE_FLOATING_HUD_COMMAND' }});
    if (!hudInstance.isHidden()) {{
      console.error('FAIL: HIDE_FLOATING_HUD_COMMAND should hide the HUD');
      process.exit(1);
    }}

    // 2. Pressing Ctrl unhides / makes the floating bar appear
    windowListeners['keydown']({{ key: 'Control', code: 'ControlLeft' }});
    windowListeners['keyup']({{ key: 'Control', code: 'ControlLeft' }});
    if (hudInstance.isHidden()) {{
      console.error('FAIL: Pressing Ctrl should make the floating bar appear');
      process.exit(1);
    }}
    if (hudInstance.isMinimized()) {{
      console.error('FAIL: Floating bar should be expanded, not dot, when appearing via Ctrl');
      process.exit(1);
    }}

    // 2b. Pressing Ctrl again reverses the action (hides it)
    windowListeners['keydown']({{ key: 'Control', code: 'ControlLeft' }});
    windowListeners['keyup']({{ key: 'Control', code: 'ControlLeft' }});
    if (!hudInstance.isHidden()) {{
      console.error('FAIL: Pressing Ctrl again should reverse the action (hide HUD)');
      process.exit(1);
    }}

    // Unhide to test Z and Shift
    hudInstance.setHidden(false);

    // 3. Double-clicking Z button converts it to a dot
    const logoZ = hudInstance.shadow.querySelector('#hud-logo-z');
    if (!logoZ) {{
      console.error('FAIL: #hud-logo-z missing in shadow DOM');
      process.exit(1);
    }}
    hudInstance.setMinimized(true);
    if (!hudInstance.isMinimized()) {{
      console.error('FAIL: Converting to dot failed');
      process.exit(1);
    }}

    // 3b. Clicking the dot reverses the action (converts dot back to floating bar)
    const miniDot = hudInstance.shadow.querySelector('#hud-mini-dot');
    hudInstance.setMinimized(false);
    if (hudInstance.isMinimized()) {{
      console.error('FAIL: Converting dot back to bar failed');
      process.exit(1);
    }}

    // 4. Shift enables auto mode
    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});
    if (!hudInstance.isAutoRunning) {{
      console.error('FAIL: Solo Shift key did not enable auto mode');
      process.exit(1);
    }}

    // 4b. Pressing Shift again reverses the action (stops auto mode)
    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});
    if (hudInstance.isAutoRunning) {{
      console.error('FAIL: Pressing Shift again did not reverse auto mode');
      process.exit(1);
    }}

    console.log('HUD_INTERACTION_SHORTCUTS_OK');
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
    assert "HUD_INTERACTION_SHORTCUTS_OK" in res.stdout


def test_ccbp_ctrl_and_shift_everywhere():
    """Verify that anywhere on learning.ccbp.in (including /question/* coding pages),
    clicking/tapping Ctrl makes the dot visible, and clicking/tapping Shift switches auto mode."""
    hud_path = (PROJECT_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(...args) {{ for (const a of args) this.classes.add(a); }}
      remove(...args) {{ for (const a of args) this.classes.delete(a); }}
      contains(c) {{ return this.classes.has(c); }}
      toggle(c) {{
        if (this.classes.has(c)) {{ this.classes.delete(c); return false; }}
        this.classes.add(c); return true;
      }}
    }}

    class MockNode {{
      constructor(tag = 'div') {{
        this.nodeType = 1;
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {{}};
        this.style = {{}};
        this.classList = new MockClassList();
        this.shadowRoot = null;
        this.id = '';
      }}
      set className(val) {{
        this._className = val;
        if (val) val.split(' ').forEach(c => c && this.classList.add(c));
      }}
      get className() {{ return this._className || ''; }}
      addEventListener(type, fn) {{ this.listeners = this.listeners || {{}}; this.listeners[type] = fn; }}
      removeEventListener() {{}}
      click() {{ if (this.listeners && this.listeners['click']) this.listeners['click'](); }}
      setAttribute(k, v) {{ this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }}
      getAttribute(k) {{ return this.attributes[k] || null; }}
      appendChild(node) {{ this.children.push(node); node.parentNode = this; return node; }}
      removeChild(node) {{
        const idx = this.children.indexOf(node);
        if (idx !== -1) this.children.splice(idx, 1);
        return node;
      }}
      remove() {{ if (this.parentNode) this.parentNode.removeChild(this); }}
      attachShadow() {{
        this.shadowRoot = new MockNode('#shadow');
        this.shadowRoot.querySelector = (sel) => this.shadowRoot.find(sel);
        this.shadowRoot.getElementById = (id) => this.shadowRoot.find('#' + id);
        return this.shadowRoot;
      }}
      set innerHTML(html) {{
        this.children = [];
        this.childNodes = this.children;
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
      find(sel) {{
        for (const c of this.children) {{
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
          if (c.find) {{
            const found = c.find(sel);
            if (found) return found;
          }}
        }}
        return null;
      }}
      querySelector(sel) {{ return this.find(sel); }}
      getElementById(id) {{ return this.find('#' + id); }}
      querySelectorAll() {{ return []; }}
    }}

    const mockDoc = new MockNode('#document');
    mockDoc.documentElement = new MockNode('html');
    mockDoc.body = new MockNode('body');
    mockDoc.appendChild(mockDoc.documentElement);
    mockDoc.documentElement.appendChild(mockDoc.body);
    mockDoc.createElement = (tag) => new MockNode(tag);
    mockDoc.getElementById = (id) => mockDoc.find('#' + id);

    const windowListeners = {{}};
    const sentMessages = [];

    const sandbox = {{
      document: mockDoc,
      window: null,
      navigator: {{ userAgent: 'Chrome' }},
      location: {{ pathname: '/question/625aef64-b820-482e-9168-5191191daa88', hostname: 'learning.ccbp.in' }},
      history: {{ pushState: () => {{}}, replaceState: () => {{}} }},
      Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
      setInterval: () => 0,
      clearInterval: () => {{}},
      setTimeout: (fn) => {{ if (typeof fn === 'function') fn(); return 1; }},
      clearTimeout: () => {{}},
      innerWidth: 1920,
      innerHeight: 1080,
      fetch: () => Promise.resolve({{ json: () => Promise.resolve({{ status: "ok" }}) }}),
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
            if (msg && msg.action !== "TRIGGER_CODING_AUTO_LOOP" && cb) cb({{ success: true }});
          }},
          onMessage: {{ addListener: () => {{}} }}
        }}
      }},
      addEventListener: (type, fn) => {{ windowListeners[type] = fn; }},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    const hudExport = vm.runInNewContext(hudCode, sandbox);

    if (!hudExport.codingMode || hudExport.quizzyMode !== "code") {{
      console.error("FAIL: Expected codingMode on /question/* route");
      process.exit(1);
    }}

    const inst = sandbox.__QUIZZY_HUD_INSTANCE__;
    if (!inst) {{
      console.error("FAIL: __QUIZZY_HUD_INSTANCE__ missing in coding mode");
      process.exit(1);
    }}

    // Initially unmounted on coding routes
    if (mockDoc.getElementById("__quizzy_hud_host__")) {{
      console.error("FAIL: Host should not be in DOM initially on coding route");
      process.exit(1);
    }}

    // 1. Tapping Ctrl on learning.ccbp.in coding route must mount and make dot visible!
    windowListeners['keydown']({{ key: 'Control', code: 'ControlLeft' }});
    windowListeners['keyup']({{ key: 'Control', code: 'ControlLeft' }});

    const host = mockDoc.getElementById("__quizzy_hud_host__");
    if (!host) {{
      console.error("FAIL: Pressing Ctrl did not mount the dot HUD host on coding route!");
      process.exit(1);
    }}
    if (inst.isHidden()) {{
      console.error("FAIL: Pressing Ctrl did not make the dot visible on coding route!");
      process.exit(1);
    }}

    // 2. Pressing Ctrl again toggles dot visibility
    windowListeners['keydown']({{ key: 'Control', code: 'ControlLeft' }});
    windowListeners['keyup']({{ key: 'Control', code: 'ControlLeft' }});
    if (!inst.isHidden()) {{
      console.error("FAIL: Pressing Ctrl second time did not toggle dot to hidden!");
      process.exit(1);
    }}

    // 3. Tapping Shift switches to auto mode and makes dot visible
    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});

    if (inst.isHidden()) {{
      console.error("FAIL: Pressing Shift did not make the dot visible!");
      process.exit(1);
    }}
    if (!inst.isAutoRunning) {{
      console.error("FAIL: Pressing Shift did not switch to auto mode on coding route!");
      process.exit(1);
    }}
    const hasAutoLoop = sentMessages.some(m => m.action === "TRIGGER_CODING_AUTO_LOOP");
    if (!hasAutoLoop) {{
      console.error("FAIL: Pressing Shift did not send TRIGGER_CODING_AUTO_LOOP!");
      process.exit(1);
    }}

    // 4. Pressing Shift again stops auto mode
    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});
    if (inst.isAutoRunning) {{
      console.error("FAIL: Pressing Shift again did not switch off auto mode!");
      process.exit(1);
    }}

    // 5. Typing combos (Ctrl+C, Shift+A) does NOT toggle dot or auto mode
    windowListeners['keydown']({{ key: 'Control', code: 'ControlLeft' }});
    windowListeners['keydown']({{ key: 'c', code: 'KeyC' }});
    windowListeners['keyup']({{ key: 'c', code: 'KeyC' }});
    windowListeners['keyup']({{ key: 'Control', code: 'ControlLeft' }});

    // Dot was visible (since Shift unhid it) - combo Ctrl+C should not have toggled it!
    if (inst.isHidden()) {{
      console.error("FAIL: Ctrl+C combo incorrectly toggled dot visibility!");
      process.exit(1);
    }}

    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keydown']({{ key: 'a', code: 'KeyA' }});
    windowListeners['keyup']({{ key: 'a', code: 'KeyA' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});

    if (inst.isAutoRunning) {{
      console.error("FAIL: Shift+A combo incorrectly toggled auto mode!");
      process.exit(1);
    }}

    // 6. Dot click starts and stops auto mode cleanly
    inst.isBackendOnline = true;
    inst.miniDot.click();
    if (!inst.isAutoRunning) {{
      console.error("FAIL: Dot click did not start auto mode!");
      process.exit(1);
    }}
    inst.miniDot.click();
    if (inst.isAutoRunning) {{
      console.error("FAIL: Second dot click did not stop auto mode!");
      process.exit(1);
    }}

    // 7. Normal mouse click on page with Shift held (e.g. text selection) does NOT trigger auto mode
    windowListeners['pointerdown']({{ shiftKey: true, ctrlKey: false, altKey: false, metaKey: false }});
    if (inst.isAutoRunning) {{
      console.error("FAIL: Mouse pointerdown with Shift held incorrectly triggered auto mode!");
      process.exit(1);
    }}

    // 8. Shift press 3 starts auto mode, Shift press 4 stops auto mode (repeated toggling works 100%)
    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});
    if (!inst.isAutoRunning) {{
      console.error("FAIL: Third Shift press did not start auto mode!");
      process.exit(1);
    }}
    windowListeners['keydown']({{ key: 'Shift', code: 'ShiftLeft' }});
    windowListeners['keyup']({{ key: 'Shift', code: 'ShiftLeft' }});
    if (inst.isAutoRunning) {{
      console.error("FAIL: Fourth Shift press did not stop auto mode!");
      process.exit(1);
    }}

    console.log("CCBP_CTRL_AND_SHIFT_EVERYWHERE_OK");
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
    assert "CCBP_CTRL_AND_SHIFT_EVERYWHERE_OK" in res.stdout


def test_view_solve_select_submit_pipeline_and_no_unselected_submit():
    """Verify that QuizZy strictly enforces the View -> Solve -> Select -> Submit pipeline,
    never clicking Submit when no option is selected, and never blindly re-clicking stale options."""
    executor_path = (PROJECT_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(c) {{ this.classes.add(c); }}
      remove(c) {{ this.classes.delete(c); }}
      contains(c) {{ return this.classes.has(c); }}
    }}

    class MockNode {{
      constructor(tag, cls = "") {{
        this.tagName = tag.toUpperCase();
        this.nodeType = 1;
        this.className = cls;
        this.classList = new MockClassList();
        if (cls) cls.split(/\\s+/).forEach(c => c && this.classList.add(c));
        this.attributes = {{}};
        this.style = {{}};
        this.childNodes = [];
        this.children = [];
        this.parentElement = null;
        this.listeners = {{}};
        this.innerText = "";
        this.textContent = "";
        this.disabled = false;
        this.value = "";
        this.checked = false;
        this.type = "";
      }}
      get firstElementChild() {{ return this.children[0] || null; }}
      get lastElementChild() {{ return this.children[this.children.length - 1] || null; }}
      get ownerDocument() {{ return doc; }}
      setAttribute(k, v) {{ this.attributes[k] = String(v); }}
      getAttribute(k) {{ return this.attributes[k] !== undefined ? this.attributes[k] : null; }}
      appendChild(child) {{
        child.parentElement = this;
        this.childNodes.push(child);
        this.children.push(child);
        return child;
      }}
      addEventListener(ev, fn) {{
        if (!this.listeners[ev]) this.listeners[ev] = [];
        this.listeners[ev].push(fn);
      }}
      click() {{
        this.dispatchEvent({{ type: "click" }});
      }}
      dispatchEvent(e) {{
        const evType = e.type || e;
        const list = this.listeners[evType] || [];
        list.forEach(fn => fn(e));
        return true;
      }}
      querySelector(sel) {{
        return this.querySelectorAll(sel)[0] || null;
      }}
      querySelectorAll(sel) {{
        function querySingle(node, s) {{
          const res = [];
          function walk(n) {{
            for (const ch of n.children) {{
              if (matches(ch, s.trim())) res.push(ch);
              walk(ch);
            }}
          }}
          walk(node);
          return res;
        }}
        function matches(node, s) {{
          if (s.includes(".")) {{
            const parts = s.split(".");
            const tagPart = parts[0];
            const clsPart = parts[1];
            if (tagPart && node.tagName.toLowerCase() !== tagPart.toLowerCase()) return false;
            return node.classList.contains(clsPart);
          }}
          if (s.startsWith("#")) {{
            return node.getAttribute("id") === s.slice(1);
          }}
          if (s.startsWith("input[")) {{
            if (node.tagName !== "INPUT") return false;
            if (s.includes(":checked") && !node.checked) return false;
            return true;
          }}
          if (s === "button" || s === "BUTTON") {{
            return node.tagName === "BUTTON";
          }}
          return node.tagName.toLowerCase() === s.toLowerCase();
        }}
        if (sel.includes(",")) {{
          const parts = sel.split(",");
          const combined = [];
          for (const p of parts) {{
            querySingle(this, p).forEach(ch => {{ if (!combined.includes(ch)) combined.push(ch); }});
          }}
          return combined;
        }}
        return querySingle(this, sel);
      }}
      contains(node) {{
        let curr = node;
        while (curr) {{
          if (curr === this) return true;
          curr = curr.parentElement;
        }}
        return false;
      }}
    }}

    function el(tag, cls, text) {{
      const n = new MockNode(tag, cls);
      if (text) {{
        n.innerText = text;
        n.textContent = text;
      }}
      return n;
    }}

    const doc = new MockNode("html");
    const body = el("body", "");
    doc.appendChild(body);
    doc.body = body;

    const stem = el("div", "sc-question-stem", "What is 2 + 2?");
    body.appendChild(stem);

    const optContainer = el("div", "options-container");
    const opt0 = el("label", "option-item", "3");
    const r0 = el("input", "radio"); r0.type = "radio"; r0.name = "q"; opt0.appendChild(r0);
    const opt1 = el("label", "option-item", "4");
    const r1 = el("input", "radio"); r1.type = "radio"; r1.name = "q"; opt1.appendChild(r1);
    const opt2 = el("label", "option-item", "5");
    const r2 = el("input", "radio"); r2.type = "radio"; r2.name = "q"; opt2.appendChild(r2);
    const opt3 = el("label", "option-item", "6");
    const r3 = el("input", "radio"); r3.type = "radio"; r3.name = "q"; opt3.appendChild(r3);
    optContainer.appendChild(opt0);
    optContainer.appendChild(opt1);
    optContainer.appendChild(opt2);
    optContainer.appendChild(opt3);
    body.appendChild(optContainer);

    let submitClickCount = 0;
    const submitBtn = el("button", "btn-submit", "SUBMIT");
    submitBtn.addEventListener("click", () => {{
      submitClickCount++;
    }});
    body.appendChild(submitBtn);

    const MockEvent = function(t) {{ this.type = t; }};
    const MockMouseEvent = function(t) {{ this.type = t; }};
    const sandbox = {{
      document: doc,
      window: {{
        document: doc,
        getComputedStyle: () => ({{ display: "block", visibility: "visible", opacity: "1" }}),
        Event: MockEvent,
        MouseEvent: MockMouseEvent
      }},
      Event: MockEvent,
      MouseEvent: MockMouseEvent,
      setTimeout,
      clearTimeout,
      Promise,
      console,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Set,
      RegExp
    }};

    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);

    const executorCode = fs.readFileSync('{executor_path}', 'utf8');
    const executor = vm.runInContext(executorCode, sandbox);

    (async () => {{
      // 1. Calling clickNextButton() when NO option is selected MUST be blocked!
      const unselectedRes = await executor.clickNextButton();
      if (unselectedRes.ok !== false || !unselectedRes.error || !unselectedRes.error.includes("NO_OPTION_SELECTED")) {{
        console.error("FAIL: Expected clickNextButton to reject with NO_OPTION_SELECTED, got:", unselectedRes);
        process.exit(1);
      }}
      if (submitClickCount !== 0) {{
        console.error("FAIL: Submit button was clicked when no option was selected!");
        process.exit(1);
      }}

      // 2. Select option 1 ("4")
      function markSelected() {{
        r1.checked = true;
        opt1.classList.add("selected");
        opt1.setAttribute("data-state", "checked");
      }}
      opt1.addEventListener("click", markSelected);
      r1.addEventListener("click", markSelected);
      const selectRes = executor.executeAction({{
        q_type: "mcq",
        selected_index: 1,
        targetText: "4"
      }});
      if (!selectRes || !selectRes.success || !selectRes.selected) {{
        console.error("FAIL: executeAction failed:", selectRes);
        process.exit(1);
      }}

      // 3. Now clickNextButton() must click Submit and proceed!
      // Add Next Question button after submit click
      submitBtn.addEventListener("click", () => {{
        setTimeout(() => {{
          const nextBtn = el("button", "btn-next", "Next Question");
          body.appendChild(nextBtn);
        }}, 80);
      }});

      const nextRes = await executor.clickNextButton();
      if (!nextRes || !nextRes.ok || nextRes.step !== "submit_then_next") {{
        console.error("FAIL: Expected submit_then_next after selecting option, got:", nextRes);
        process.exit(1);
      }}
      if (submitClickCount !== 1) {{
        console.error("FAIL: Expected submitClickCount === 1, got:", submitClickCount);
        process.exit(1);
      }}

      console.log("PIPELINE_VIEW_SOLVE_SELECT_SUBMIT_OK");
    }})().catch(err => {{
      console.error("Test threw error:", err);
      process.exit(1);
    }});
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
    assert "PIPELINE_VIEW_SOLVE_SELECT_SUBMIT_OK" in res.stdout


def test_flawless_ctrl_toggle_wherever_i_am_and_shift_automation():
    """Verify 100% flawless behavior:
    1. Ctrl toggles dot: 1st press makes it appear wherever cursor is, 2nd press hides it.
    2. Shift toggles auto mode: 1st press starts, 2nd press stops.
    3. Clicking the dot toggles auto mode: 1st click starts, 2nd click stops.
    4. Shift+Click toggles auto mode and Ctrl+Click toggles dot without modifier release bounce.
    5. Typing combos (Ctrl+C, Shift+A) does not accidentally toggle dot or auto mode.
    6. Both coding routes and quiz routes behave identically.
    """
    hud_path = (PROJECT_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(...args) {{ for (const a of args) this.classes.add(a); }}
      remove(...args) {{ for (const a of args) this.classes.delete(a); }}
      contains(c) {{ return this.classes.has(c); }}
      toggle(c) {{
        if (this.classes.has(c)) {{ this.classes.delete(c); return false; }}
        this.classes.add(c); return true;
      }}
    }}

    class MockNode {{
      constructor(tag = 'div') {{
        this.nodeType = 1;
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {{}};
        this.style = {{}};
        this.classList = new MockClassList();
        this.shadowRoot = null;
        this.id = '';
      }}
      set className(val) {{
        this._className = val;
        if (val) val.split(' ').forEach(c => c && this.classList.add(c));
      }}
      get className() {{ return this._className || ''; }}
      addEventListener(type, fn) {{
        this.listeners = this.listeners || {{}};
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(fn);
      }}
      removeEventListener() {{}}
      setAttribute(k, v) {{ this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }}
      getAttribute(k) {{ return this.attributes[k] || null; }}
      appendChild(node) {{ this.children.push(node); node.parentNode = this; return node; }}
      removeChild(node) {{
        const idx = this.children.indexOf(node);
        if (idx !== -1) this.children.splice(idx, 1);
        return node;
      }}
      remove() {{ if (this.parentNode) this.parentNode.removeChild(this); }}
      attachShadow() {{
        this.shadowRoot = new MockNode('#shadow');
        this.shadowRoot.querySelector = (sel) => this.shadowRoot.find(sel);
        this.shadowRoot.getElementById = (id) => this.shadowRoot.find('#' + id);
        return this.shadowRoot;
      }}
      set innerHTML(html) {{
        this.children = [];
        this.childNodes = this.children;
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
      find(sel) {{
        for (const c of this.children) {{
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
          if (c.find) {{
            const found = c.find(sel);
            if (found) return found;
          }}
        }}
        return null;
      }}
      querySelector(sel) {{ return this.find(sel); }}
      getElementById(id) {{ return this.find('#' + id); }}
      querySelectorAll() {{ return []; }}
      click() {{
        if (this.listeners && this.listeners['click']) {{
          for (const fn of this.listeners['click']) fn({{ stopPropagation: () => {{}} }});
        }}
      }}
    }}

    function createSandbox(pathname = '/question/code-practice-uuid') {{
      const mockDoc = new MockNode('#document');
      mockDoc.documentElement = new MockNode('html');
      mockDoc.body = new MockNode('body');
      mockDoc.appendChild(mockDoc.documentElement);
      mockDoc.documentElement.appendChild(mockDoc.body);
      mockDoc.createElement = (tag) => new MockNode(tag);
      mockDoc.getElementById = (id) => mockDoc.find('#' + id);

      const windowListeners = {{}};
      const docListeners = {{}};
      const sentMessages = [];

      const addListener = (targetMap, type, fn) => {{
        targetMap[type] = targetMap[type] || [];
        targetMap[type].push(fn);
      }};

      const dispatch = (targetMap, type, evt) => {{
        const fns = targetMap[type] || [];
        for (const fn of fns) fn(evt);
      }};

      const sandbox = {{
        document: mockDoc,
        window: null,
        navigator: {{ userAgent: 'Chrome' }},
        location: {{ pathname, hostname: 'learning.ccbp.in' }},
        history: {{ pushState: () => {{}}, replaceState: () => {{}} }},
        Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
        setInterval: () => 0,
        clearInterval: () => {{}},
        setTimeout: (fn, ms) => {{ if (!ms || ms <= 200) {{ if (typeof fn === 'function') fn(); }} return 1; }},
        clearTimeout: () => {{}},
        innerWidth: 1920,
        innerHeight: 1080,
        fetch: () => Promise.resolve({{ json: () => Promise.resolve({{ status: "ok" }}) }}),
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
              if (msg && msg.action === "CHECK_HEALTH") {{
                const online = sandbox.isMockBackendOnline !== false;
                if (cb) cb({{ success: online, data: online ? {{ status: "ok" }} : null }});
              }} else if (msg && msg.action === "START_BACKEND") {{
                sandbox.isMockBackendOnline = true;
                if (cb) cb({{ success: true, status: "started" }});
              }} else if (msg && msg.action !== "TRIGGER_CODING_AUTO_LOOP" && cb) {{
                cb({{ success: true, data: {{ status: "ok" }} }});
              }}
            }},
            onMessage: {{ addListener: () => {{}} }}
          }}
        }},
        addEventListener: (type, fn) => addListener(windowListeners, type, fn),
        removeEventListener: () => {{}}
      }};
      mockDoc.addEventListener = (type, fn) => addListener(docListeners, type, fn);
      sandbox.window = sandbox;

      return {{
        sandbox,
        mockDoc,
        sentMessages,
        dispatchWindow: (t, e) => dispatch(windowListeners, t, e),
        dispatchDoc: (t, e) => dispatch(docListeners, t, e),
        dispatchDomCapture: (t, e) => {{
          dispatch(windowListeners, t, e);
          dispatch(docListeners, t, e);
        }}
      }};
    }}

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');

    // =========================================================================
    // PART 1: CODING ROUTE VERIFICATION
    // =========================================================================
    {{
      const env = createSandbox('/question/sample-problem');
      const hudExport = vm.runInNewContext(hudCode, env.sandbox);
      const inst = env.sandbox.__QUIZZY_HUD_INSTANCE__;
      if (!inst) throw new Error("Missing __QUIZZY_HUD_INSTANCE__ on coding route");
      inst.isBackendOnline = true;

      // Verify initially unmounted
      if (inst.isVisible()) throw new Error("Coding dot should not be visible before Ctrl press");

      // Pointermove to (350, 220) must NOT move the dot (no cursor following)
      env.dispatchWindow('pointermove', {{ clientX: 350, clientY: 220 }});

      // Press 1 of Ctrl: makes it appear at corner (1895px, 1055px)
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});

      if (!inst.isVisible() || inst.isHidden()) throw new Error("Pressing Ctrl should make the dot appear");
      const wrapper1 = inst.wrapper;
      if (!wrapper1) throw new Error("Wrapper missing after Ctrl press");
      if (wrapper1.style.left !== '1895px' || wrapper1.style.top !== '1055px') {{
        throw new Error(`Dot was not positioned at corner! Expected left: 1895px, top: 1055px; got ${{wrapper1.style.left}}, ${{wrapper1.style.top}}`);
      }}

      // Pointermove to new location (800, 600) must NOT move the dot
      env.dispatchWindow('pointermove', {{ clientX: 800, clientY: 600 }});
      if (wrapper1.style.left !== '1895px' || wrapper1.style.top !== '1055px') {{
        throw new Error("Dot followed the cursor instead of staying at the corner!");
      }}

      // Press 2 of Ctrl: hides it
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (inst.isVisible() || !inst.isHidden()) throw new Error("Second Ctrl press did not hide the dot");

      // Press 3 of Ctrl: makes it appear at corner again
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (!inst.isVisible() || inst.isHidden()) throw new Error("Third Ctrl press should show dot again");
      if (wrapper1.style.left !== '1895px' || wrapper1.style.top !== '1055px') {{
        throw new Error(`Dot did not appear at corner! Expected 1895px, 1055px; got ${{wrapper1.style.left}}, ${{wrapper1.style.top}}`);
      }}

      // If user drags the dot away to (500, 400), pressing Ctrl MUST reset it back to corner and hide it
      wrapper1.style.left = '500px';
      wrapper1.style.top = '400px';
      // Press 4 of Ctrl: resets position to corner and hides it
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (wrapper1.style.left !== '1895px' || wrapper1.style.top !== '1055px') {{
        throw new Error(`Pressing Ctrl failed to reset dot to corner! Got ${{wrapper1.style.left}}, ${{wrapper1.style.top}}`);
      }}
      if (inst.isVisible()) throw new Error("Fourth Ctrl press did not hide the dot");

      // Press 1 of Shift: starts auto mode and makes dot visible
      env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
      if (!inst.isAutoRunning) throw new Error("First Shift press did not start auto mode");
      if (!inst.isVisible()) throw new Error("First Shift press did not make dot visible");

      // Press 2 of Shift: stops auto mode
      env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
      if (inst.isAutoRunning) throw new Error("Second Shift press did not stop auto mode");

      // Dot click 1: starts auto mode
      inst.miniDot.click();
      if (!inst.isAutoRunning) throw new Error("First click on dot did not start auto mode");

      // Dot click 2: stops auto mode
      inst.miniDot.click();
      if (inst.isAutoRunning) throw new Error("Second click on dot did not stop auto mode");

      // Normal pointerdown with Shift held does NOT start auto mode on page (no interference with selection)
      env.dispatchWindow('pointerdown', {{ shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, clientX: 500, clientY: 400 }});
      if (inst.isAutoRunning) throw new Error("Pointerdown with Shift held should not start auto mode on page");

      // Shift press 3 starts auto mode, Shift press 4 stops auto mode (flawless multi-toggle)
      env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
      if (!inst.isAutoRunning) throw new Error("Third Shift press did not start auto mode");

      env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
      if (inst.isAutoRunning) throw new Error("Fourth Shift press did not stop auto mode");

      // Combos: Ctrl+C does not toggle dot
      const wasVis = inst.isVisible();
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keydown', {{ key: 'c', code: 'KeyC' }});
      env.dispatchWindow('keyup', {{ key: 'c', code: 'KeyC' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (inst.isVisible() !== wasVis) throw new Error("Ctrl+C combo should not toggle dot visibility");

      // Combos: Shift+A does not toggle auto mode
      env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
      env.dispatchWindow('keydown', {{ key: 'a', code: 'KeyA' }});
      env.dispatchWindow('keyup', {{ key: 'a', code: 'KeyA' }});
      env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
      if (inst.isAutoRunning) throw new Error("Shift+A combo should not toggle auto mode");

      // Dual-dispatch DOM capture propagation: event passing from window to document toggles dot exactly once
      const stateBefore = inst.isVisible();
      const domEventDown = {{ key: 'Control', code: 'ControlLeft' }};
      const domEventUp = {{ key: 'Control', code: 'ControlLeft' }};
      env.dispatchDomCapture('keydown', domEventDown);
      env.dispatchDomCapture('keyup', domEventUp);
      if (inst.isVisible() === stateBefore) throw new Error("DOM capture dispatch failed to toggle visibility");

      const domEventDown2 = {{ key: 'Control', code: 'ControlLeft' }};
      const domEventUp2 = {{ key: 'Control', code: 'ControlLeft' }};
      env.dispatchDomCapture('keydown', domEventDown2);
      env.dispatchDomCapture('keyup', domEventUp2);
      if (inst.isVisible() !== stateBefore) throw new Error("Second DOM capture dispatch failed to toggle visibility back");
    }}

    // =========================================================================
    // PART 2: GENERAL / MCQ ROUTE VERIFICATION
    // =========================================================================
    {{
      const env = createSandbox('/practice/mcq-quiz');
      const hudInstance = vm.runInNewContext(hudCode, env.sandbox);

      // Start hidden
      hudInstance.setHidden(true);
      if (hudInstance.isVisible()) throw new Error("Expected HUD to be hidden initially");

      // Pointermove to (520, 310) must NOT move the dot (no cursor following)
      env.dispatchWindow('pointermove', {{ clientX: 520, clientY: 310 }});

      // Press 1 of Ctrl: makes it appear at the corner (1895px, 1055px)
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (hudInstance.isHidden()) throw new Error("Pressing Ctrl should unhide dot on MCQ route");
      const wrap = hudInstance.wrapper;
      if (wrap.style.left !== '1895px' || wrap.style.top !== '1055px') {{
        throw new Error(`MCQ dot was not positioned at corner! Expected 1895px, 1055px; got ${{wrap.style.left}}, ${{wrap.style.top}}`);
      }}

      // Pointermove to (150, 200) - dot must stay at corner, NOT follow cursor
      env.dispatchWindow('pointermove', {{ clientX: 150, clientY: 200 }});
      if (wrap.style.left !== '1895px' || wrap.style.top !== '1055px') {{
        throw new Error("Dot followed the cursor instead of staying at the corner!");
      }}

      // Press 2 of Ctrl: hides it
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (!hudInstance.isHidden()) throw new Error("Second Ctrl press should hide dot on MCQ route");

      // Press 3 of Ctrl: makes it appear at the corner again
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (hudInstance.isHidden()) throw new Error("Third Ctrl press should show dot at corner");
      if (wrap.style.left !== '1895px' || wrap.style.top !== '1055px') {{
        throw new Error(`MCQ dot did not appear at corner! Expected 1895px, 1055px; got ${{wrap.style.left}}, ${{wrap.style.top}}`);
      }}

      // Press 1 of Shift: starts auto mode
      env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
      if (!hudInstance.isAutoRunning) throw new Error("Shift press did not start auto mode on MCQ route");

      // Press 2 of Shift: stops auto mode
      env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
      if (hudInstance.isAutoRunning) throw new Error("Second Shift press did not stop auto mode on MCQ route");

      // Dot click: start and stop
      const miniDot = hudInstance.miniDot || hudInstance.shadow.querySelector('#hud-mini-dot');
      miniDot.click();
      if (!hudInstance.isAutoRunning) throw new Error("Clicking dot did not start auto mode on MCQ route");
      miniDot.click();
      if (hudInstance.isAutoRunning) throw new Error("Second click on dot did not stop auto mode on MCQ route");
    }}

    // =========================================================================
    // PART 3: VERIFY DOT IS POSITIONED AT CORNER & RESETS ON CTRL & STARTS BACKEND
    // =========================================================================
    {{
      const env = createSandbox('/practice/mcq-quiz');
      const hudInstance = vm.runInNewContext(hudCode, env.sandbox);
      const wrap = hudInstance.wrapper;

      // 1. Initial / unhidden position is corner coordinates (1895px, 1055px)
      hudInstance.setHidden(false);
      hudInstance.show();
      if (wrap.style.left !== '1895px' || wrap.style.top !== '1055px') {{
        throw new Error(`Expected dot at corner (1895px, 1055px); got ${{wrap.style.left}}, ${{wrap.style.top}}`);
      }}

      // 2. Moving pointer to (400, 300) does NOT move the dot (no cursor following)
      env.dispatchWindow('pointermove', {{ clientX: 400, clientY: 300 }});
      if (wrap.style.left !== '1895px' || wrap.style.top !== '1055px') {{
        throw new Error(`Dot incorrectly followed pointer! Got ${{wrap.style.left}}, ${{wrap.style.top}}`);
      }}

      // 3. If user dragged dot to (400, 300), pressing Ctrl MUST reset it back to corner
      wrap.style.left = '400px';
      wrap.style.top = '300px';
      env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
      env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
      if (wrap.style.left !== '1895px' || wrap.style.top !== '1055px') {{
        throw new Error(`Pressing Ctrl failed to reset dot to corner! Got ${{wrap.style.left}}, ${{wrap.style.top}}`);
      }}

      // 4. Clicking the dot when offline starts the backend
      const miniDot = hudInstance.miniDot || hudInstance.shadow.querySelector('#hud-mini-dot');
      env.sandbox.isMockBackendOnline = false;
      hudInstance.checkHealth();
      miniDot.click();
      const hasStartBackend = env.sentMessages.some(m => m.action === 'START_BACKEND');
      if (!hasStartBackend) {{
        throw new Error('Clicking offline dot did not send START_BACKEND!');
      }}
    }}

    console.log("FLAWLESS_CTRL_AND_SHIFT_TOGGLE_TEST_PASSED");
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
    assert "FLAWLESS_CTRL_AND_SHIFT_TOGGLE_TEST_PASSED" in res.stdout


def test_spa_navigation_shift_switches_auto_mode_and_ctrl_toggles_dot():
    """Verify that after SPA navigation (pushState from quiz/dashboard to coding question):
    1. Clicking/tapping Shift reliably switches to auto mode.
    2. Clicking/tapping Shift again reliably stops auto mode.
    3. Clicking/tapping Ctrl resets position to the corner and toggles dot visibility.
    4. Offline red dot click triggers backend auto-start.
    """
    hud_path = (PROJECT_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(...args) {{ for (const a of args) this.classes.add(a); }}
      remove(...args) {{ for (const a of args) this.classes.delete(a); }}
      contains(c) {{ return this.classes.has(c); }}
      toggle(c) {{
        if (this.classes.has(c)) {{ this.classes.delete(c); return false; }}
        this.classes.add(c); return true;
      }}
    }}

    class MockNode {{
      constructor(tag = 'div') {{
        this.nodeType = 1;
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {{}};
        this.style = {{}};
        this.classList = new MockClassList();
        this.shadowRoot = null;
        this.id = '';
      }}
      set className(val) {{
        this._className = val;
        if (val) val.split(' ').forEach(c => c && this.classList.add(c));
      }}
      get className() {{ return this._className || ''; }}
      addEventListener(type, fn) {{ this.listeners = this.listeners || {{}}; this.listeners[type] = fn; }}
      removeEventListener() {{}}
      click() {{ if (this.listeners && this.listeners['click']) this.listeners['click'](); }}
      setAttribute(k, v) {{ this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }}
      getAttribute(k) {{ return this.attributes[k] || null; }}
      appendChild(node) {{ this.children.push(node); node.parentNode = this; return node; }}
      removeChild(node) {{
        const idx = this.children.indexOf(node);
        if (idx !== -1) this.children.splice(idx, 1);
        return node;
      }}
      remove() {{ if (this.parentNode) this.parentNode.removeChild(this); }}
      attachShadow() {{
        this.shadowRoot = new MockNode('#shadow');
        this.shadowRoot.querySelector = (sel) => this.shadowRoot.find(sel);
        this.shadowRoot.getElementById = (id) => this.shadowRoot.find('#' + id);
        return this.shadowRoot;
      }}
      find(sel) {{
        for (const c of this.children) {{
          if (sel.startsWith('#') && c.id === sel.slice(1)) return c;
          if (sel.startsWith('.') && c.classList.contains(sel.slice(1))) return c;
          if (c.find) {{
            const found = c.find(sel);
            if (found) return found;
          }}
        }}
        return null;
      }}
      querySelector(sel) {{ return this.find(sel); }}
      getElementById(id) {{ return this.find('#' + id); }}
      querySelectorAll() {{ return []; }}
    }}

    function createSandbox(initialPath = '/practice/mcq-quiz') {{
      const mockDoc = new MockNode('#document');
      mockDoc.documentElement = new MockNode('html');
      mockDoc.body = new MockNode('body');
      mockDoc.appendChild(mockDoc.documentElement);
      mockDoc.documentElement.appendChild(mockDoc.body);
      mockDoc.createElement = (tag) => new MockNode(tag);
      mockDoc.getElementById = (id) => mockDoc.find('#' + id);

      const windowListeners = {{}};
      const sentMessages = [];

      const addListener = (type, fn) => {{
        windowListeners[type] = windowListeners[type] || [];
        windowListeners[type].push(fn);
      }};

      const dispatch = (type, evt) => {{
        const fns = windowListeners[type] || [];
        for (const fn of fns) fn(evt);
      }};

      const sandbox = {{
        document: mockDoc,
        window: null,
        navigator: {{ userAgent: 'Chrome' }},
        location: {{ pathname: initialPath, hostname: 'learning.ccbp.in' }},
        history: {{ pushState: () => {{}}, replaceState: () => {{}} }},
        Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
        setInterval: () => 0,
        clearInterval: () => {{}},
        setTimeout: (fn) => {{ if (typeof fn === 'function') fn(); return 1; }},
        clearTimeout: () => {{}},
        innerWidth: 1920,
        innerHeight: 1080,
        fetch: () => Promise.resolve({{ json: () => Promise.resolve({{ status: "ok" }}) }}),
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
              if (msg && msg.action === "CHECK_HEALTH") {{
                const online = sandbox.isMockBackendOnline !== false;
                if (cb) cb({{ success: online, data: online ? {{ status: "ok" }} : null }});
              }} else if (msg && msg.action === "START_BACKEND") {{
                sandbox.isMockBackendOnline = true;
                if (cb) cb({{ success: true, status: "started" }});
              }} else if (msg && msg.action !== "TRIGGER_CODING_AUTO_LOOP" && cb) {{
                cb({{ success: true, data: {{ status: "ok" }} }});
              }}
            }},
            onMessage: {{ addListener: () => {{}} }}
          }}
        }},
        addEventListener: (type, fn) => addListener(type, fn),
        removeEventListener: () => {{}}
      }};
      sandbox.window = sandbox;

      return {{
        sandbox,
        mockDoc,
        sentMessages,
        dispatchWindow: (t, e) => dispatch(t, e)
      }};
    }}

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    const env = createSandbox('/practice/mcq-quiz');
    const hudExport = vm.runInNewContext(hudCode, env.sandbox);

    // Initial state: MCQ page
    if (env.sandbox.location.pathname !== '/practice/mcq-quiz') {{
      throw new Error("Initial path should be /practice/mcq-quiz");
    }}

    // Simulate SPA navigation to coding question via pushState
    env.sandbox.location.pathname = '/question/625aef64-b820-482e-9168-5191191daa88';
    env.sandbox.history.pushState({{}}, '', '/question/625aef64-b820-482e-9168-5191191daa88');

    // 1. Tapping Shift after SPA navigation must switch to auto mode!
    env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
    env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});

    const activeInst = env.sandbox.__QUIZZY_HUD_INSTANCE__;
    if (!activeInst) {{
      throw new Error("Missing __QUIZZY_HUD_INSTANCE__ after SPA navigation!");
    }}
    if (!activeInst.isAutoRunning) {{
      throw new Error("Shift after SPA navigation failed to switch to auto mode!");
    }}
    if (!activeInst.isVisible()) {{
      throw new Error("Shift after SPA navigation failed to make dot visible!");
    }}
    if (activeInst.wrapper.style.left !== '1895px' || activeInst.wrapper.style.top !== '1055px') {{
      throw new Error("Dot after Shift was not positioned at corner! Got: " + activeInst.wrapper.style.left);
    }}

    // 2. Tapping Shift again stops auto mode
    env.dispatchWindow('keydown', {{ key: 'Shift', code: 'ShiftLeft' }});
    env.dispatchWindow('keyup', {{ key: 'Shift', code: 'ShiftLeft' }});
    if (activeInst.isAutoRunning) {{
      throw new Error("Second Shift did not stop auto mode!");
    }}

    // 3. Tapping Ctrl resets to corner and toggles dot
    // Dot is currently visible -> Ctrl should hide it
    env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
    env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
    if (activeInst.isVisible()) {{
      throw new Error("Ctrl should hide dot when visible");
    }}

    // Ctrl again should make dot appear at corner
    env.dispatchWindow('keydown', {{ key: 'Control', code: 'ControlLeft' }});
    env.dispatchWindow('keyup', {{ key: 'Control', code: 'ControlLeft' }});
    if (!activeInst.isVisible()) {{
      throw new Error("Second Ctrl should show dot");
    }}
    if (activeInst.wrapper.style.left !== '1895px' || activeInst.wrapper.style.top !== '1055px') {{
      throw new Error("Dot was not at corner after Ctrl toggle!");
    }}

    // 4. Dot click starts auto mode, second click stops auto mode
    activeInst.miniDot.click();
    if (!activeInst.isAutoRunning) {{
      throw new Error("Clicking dot did not start auto mode!");
    }}
    activeInst.miniDot.click();
    if (activeInst.isAutoRunning) {{
      throw new Error("Second click on dot did not stop auto mode!");
    }}

    // 5. Offline red dot click starts backend
    env.sandbox.isMockBackendOnline = false;
    activeInst.checkHealth();
    activeInst.miniDot.click();
    const hasStartBackend = env.sentMessages.some(m => m.action === 'START_BACKEND');
    if (!hasStartBackend) {{
      throw new Error("Clicking offline dot did not send START_BACKEND!");
    }}

    console.log("SPA_NAVIGATION_SHIFT_AUTO_MODE_TEST_PASSED");
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
    assert "SPA_NAVIGATION_SHIFT_AUTO_MODE_TEST_PASSED" in res.stdout
