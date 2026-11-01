"""
Tests for Red Dot Backend Launcher & Native Messaging Bridge.
Verifies that:
1. extension/manifest.json includes "nativeMessaging" in permissions.
2. native_host/com.quizzy.launcher.json exists, is valid JSON, and points to launcher.bat.
3. Windows registry has HKCU NativeMessagingHosts entry for com.quizzy.launcher.
4. launcher.bat accepts 4-byte length prefix native messages and replies with 4-byte length prefix JSON.
5. Clicking the red dot triggers START_BACKEND and transitions from glow-red to glow-blue upon connection.
"""

import sys
import json
import struct
import subprocess
from pathlib import Path
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def test_manifest_native_messaging_permission():
    manifest_path = PROJECT_ROOT / "extension" / "manifest.json"
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    permissions = manifest.get("permissions", [])
    assert "nativeMessaging" in permissions, "manifest.json missing 'nativeMessaging' permission!"


def test_native_host_manifest_and_registry():
    host_json_path = PROJECT_ROOT / "native_host" / "com.quizzy.launcher.json"
    assert host_json_path.is_file(), "com.quizzy.launcher.json missing!"

    with open(host_json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data.get("name") == "com.quizzy.launcher"
    assert data.get("type") == "stdio"
    assert "path" in data and Path(data["path"]).name == "launcher.bat"
    assert "allowed_origins" in data and len(data["allowed_origins"]) > 0

    if sys.platform == "win32":
        import winreg

        reg_path = r"Software\Google\Chrome\NativeMessagingHosts\com.quizzy.launcher"
        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, reg_path)
            val, _ = winreg.QueryValueEx(key, "")
            winreg.CloseKey(key)
            assert str(val).lower() == str(host_json_path).lower(), f"Registry points to {val}, expected {host_json_path}"
        except FileNotFoundError:
            pytest.fail(f"Registry key HKCU\\{reg_path} is not registered!")


def test_native_host_stdio_communication():
    """Verify that launcher.bat processes binary stdio native messages correctly."""
    bat_path = PROJECT_ROOT / "native_host" / "launcher.bat"
    assert bat_path.is_file(), "launcher.bat missing!"

    # Simulate Chrome sending CHECK_HEALTH
    payload = json.dumps({"action": "CHECK_HEALTH"}).encode("utf-8")
    header = struct.pack("<I", len(payload))
    input_bytes = header + payload

    proc = subprocess.run(
        [str(bat_path)],
        input=input_bytes,
        capture_output=True,
        shell=True,
        cwd=str(PROJECT_ROOT),
    )

    assert proc.returncode == 0, f"launcher.bat failed with code {proc.returncode}. Stderr: {proc.stderr}"
    stdout = proc.stdout
    assert len(stdout) >= 4, f"Output too short: {stdout}"
    resp_len = struct.unpack("<I", stdout[:4])[0]
    resp_body = stdout[4 : 4 + resp_len].decode("utf-8")
    resp_data = json.loads(resp_body)

    assert resp_data.get("success") is True, f"Native host returned failure: {resp_data}"
    assert "port" in resp_data and resp_data["port"] == 8000


def test_red_dot_click_starts_backend_in_node():
    """Verify that clicking the red dot when backend is offline sends START_BACKEND and transitions to glow-blue."""
    hud_path = (PROJECT_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    class MockClassList {{
      constructor() {{ this.classes = new Set(); }}
      add(...args) {{ for (const a of args) this.classes.add(a); }}
      remove(...args) {{ for (const a of args) this.classes.delete(a); }}
      contains(c) {{ return this.classes.has(c); }}
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
            const rawAttrs = match[3] || '';
            const node = new MockNode(tag);
            const idM = rawAttrs.match(/id=['"]([^'"]+)['"]/);
            if (idM) node.id = idM[1];
            const clsM = rawAttrs.match(/class=['"]([^'"]+)['"]/);
            if (clsM) node.className = clsM[1];
            stack[stack.length - 1].appendChild(node);
            const isSelf = ['br', 'hr', 'img', 'input'].includes(tag.toLowerCase()) || rawAttrs.trim().endsWith('/');
            if (!isSelf) stack.push(node);
          }}
        }}
      }}
      find(selector) {{
        if (selector.startsWith('#')) {{
          const id = selector.slice(1);
          if (this.id === id) return this;
          for (const c of this.children) {{
            const res = c.find(selector);
            if (res) return res;
          }}
        }} else if (selector.startsWith('.')) {{
          const cls = selector.slice(1);
          if (this.classList.contains(cls)) return this;
          for (const c of this.children) {{
            const res = c.find(selector);
            if (res) return res;
          }}
        }}
        return null;
      }}
      querySelector(s) {{ return this.find(s); }}
      querySelectorAll() {{ return []; }}
      getBoundingClientRect() {{ return {{ left: 100, top: 100, right: 110, bottom: 110, width: 10, height: 10 }}; }}
      click() {{
        if (this.listeners && this.listeners['click']) {{
          for (const fn of this.listeners['click']) fn({{ stopPropagation: () => {{}} }});
        }}
      }}
    }}

    const sentMessages = [];
    let backendOnline = false;

    const mockDoc = new MockNode('document');
    mockDoc.documentElement = new MockNode('html');
    mockDoc.body = new MockNode('body');
    mockDoc.appendChild(mockDoc.documentElement);
    mockDoc.documentElement.appendChild(mockDoc.body);
    mockDoc.createElement = (tag) => new MockNode(tag);
    mockDoc.getElementById = (id) => mockDoc.find('#' + id);

    const windowListeners = {{}};
    const sandbox = {{
      document: mockDoc,
      window: null,
      location: {{ pathname: '/practice/quiz', hostname: 'learning.ccbp.in' }},
      Date, String, Number, Boolean, Array, Object, Set, RegExp, console,
      setInterval: (fn, ms) => {{ if (typeof fn === 'function') fn(); return 1; }},
      clearInterval: () => {{}},
      setTimeout: (fn, ms) => {{ if (typeof fn === 'function') fn(); return 1; }},
      clearTimeout: () => {{}},
      innerWidth: 1920,
      innerHeight: 1080,
      fetch: () => Promise.resolve({{ json: () => Promise.resolve({{ status: backendOnline ? "ok" : "offline" }}) }}),
      chrome: {{
        storage: {{ local: {{ get: (k, cb) => cb({{}}), set: (o, cb) => cb && cb() }} }},
        runtime: {{
          sendMessage: (msg, cb) => {{
            sentMessages.push(msg);
            if (msg.action === 'CHECK_HEALTH') {{
              if (cb) cb({{ success: backendOnline, data: backendOnline ? {{ status: "ok" }} : null }});
            }} else if (msg.action === 'START_BACKEND') {{
              backendOnline = true; // Simulating successful backend launch
              if (cb) cb({{ success: true, status: 'started' }});
            }} else {{
              if (cb) cb({{ success: true }});
            }}
          }},
          onMessage: {{ addListener: () => {{}} }}
        }}
      }},
      addEventListener: (type, fn) => {{ windowListeners[type] = windowListeners[type] || []; windowListeners[type].push(fn); }},
      removeEventListener: () => {{}}
    }};
    sandbox.window = sandbox;

    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    const hudInstance = vm.runInNewContext(hudCode, sandbox);

    const miniDot = hudInstance.miniDot || hudInstance.shadow.querySelector('#hud-mini-dot');
    if (!miniDot) throw new Error("Mini dot missing in shadow root");

    // 1. Initial state: backendOnline is false -> dot is red
    hudInstance.checkHealth();
    if (!miniDot.classList.contains('glow-red')) {{
      throw new Error("Dot should glow red when backend is offline");
    }}
    if (!miniDot.title.toLowerCase().includes('start backend')) {{
      throw new Error(`Dot title should prompt to start backend, got: ${{miniDot.title}}`);
    }}

    // 2. Click on the red dot -> triggers START_BACKEND
    miniDot.click();

    const startMsg = sentMessages.find(m => m.action === 'START_BACKEND');
    if (!startMsg) throw new Error("Clicking red dot did not send START_BACKEND message!");

    // 3. Since mock backend started, next health check brings it to glow-blue (ready)
    hudInstance.checkHealth();
    if (!miniDot.classList.contains('glow-blue')) {{
      throw new Error("Dot did not transition to glow-blue after backend started!");
    }}

    console.log("RED_DOT_START_BACKEND_TEST_PASSED");
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

