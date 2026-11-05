"""Verification Suite for Silent Self-Uninstall ('Panic Wipe') on Ctrl + Shift + Z."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def test_manifest_panic_wipe_command():
    """Verify manifest commands include quizzy-uninstall-self on Ctrl+Shift+Z and no management permission."""
    manifest_path = PROJECT_ROOT / "extension" / "manifest.json"
    assert manifest_path.exists(), "extension/manifest.json not found"

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # 1. No management permission
    permissions = manifest.get("permissions", [])
    assert "management" not in permissions, (
        "Strict rule violation: 'management' permission must NOT be declared in manifest.json"
    )

    # 2. Command registered with Ctrl+Shift+Z
    commands = manifest.get("commands", {})
    assert "quizzy-uninstall-self" in commands, "quizzy-uninstall-self missing from manifest.json commands"
    cmd = commands["quizzy-uninstall-self"]
    assert cmd.get("suggested_key", {}).get("default") == "Ctrl+Shift+Z", (
        f"Expected Ctrl+Shift+Z, got {cmd.get('suggested_key', {}).get('default')}"
    )


def test_background_self_uninstall_contract():
    """Verify background.js contains self-destruct & uninstall logic without permission bypass."""
    bg_path = PROJECT_ROOT / "extension" / "background.js"
    assert bg_path.exists(), "extension/background.js not found"
    bg_text = bg_path.read_text(encoding="utf-8")

    # 1. Routine definitions
    assert "async function handleSelfUninstall()" in bg_text
    assert "chrome.management.uninstallSelf({ showConfirmDialog: false })" in bg_text
    assert "chrome.tabs.sendMessage" in bg_text
    assert "QUIZZY_SELF_DESTRUCT_DOM" in bg_text
    assert "chrome.storage.local.clear" in bg_text
    assert "/shutdown" in bg_text
    assert "STOP_BACKEND" in bg_text

    # 2. Command routing
    assert 'command === "quizzy-uninstall-self"' in bg_text
    assert "QUIZZY_UNINSTALL_SELF" in bg_text

    # 3. Exported
    assert "handleSelfUninstall" in bg_text


def test_content_scripts_panic_wipe_shortcut_listeners():
    """Verify floating_hud.js, ccbp_lifecycle_bridge.js, sidepanel.js, executor.js, and portal_completion.js handle Ctrl+Shift+Z."""
    files_to_check = {
        "extension/floating_hud.js": ["QUIZZY_SELF_DESTRUCT_DOM", "QUIZZY_UNINSTALL_SELF", "selfDestructDom"],
        "extension/ccbp_lifecycle_bridge.js": ["QUIZZY_SELF_DESTRUCT_DOM", "QUIZZY_UNINSTALL_SELF"],
        "extension/sidepanel.js": ["QUIZZY_UNINSTALL_SELF", "KeyZ"],
        "extension/portal_completion.js": ["QUIZZY_SELF_DESTRUCT_DOM", "QUIZZY_UNINSTALL_SELF"],
        "extension/executor.js": ["QUIZZY_UNINSTALL_SELF", "KeyZ"],
    }

    for rel_path, required_strings in files_to_check.items():
        file_path = PROJECT_ROOT / rel_path
        assert file_path.exists(), f"{rel_path} does not exist"
        content = file_path.read_text(encoding="utf-8")
        for req in required_strings:
            assert req in content, f"Missing '{req}' in {rel_path}"


def test_node_execution_handle_self_uninstall():
    """Execute handleSelfUninstall in Node.js environment with mock chrome APIs to verify sequence."""
    bg_path = PROJECT_ROOT / "extension" / "background.js"
    js_test_script = f"""
    const fs = require('fs');

    let uninstalled = false;
    let confirmDialogOption = null;
    let storageCleared = false;
    let sentMessages = [];
    let tabsQueried = false;

    global.chrome = {{
      runtime: {{
        lastError: null,
        onMessage: {{ addListener: () => {{}} }},
        onInstalled: {{ addListener: () => {{}} }},
        sendNativeMessage: (host, msg, cb) => {{ if (cb) cb(); }}
      }},
      management: {{
        uninstallSelf: (options) => {{
          uninstalled = true;
          confirmDialogOption = options ? options.showConfirmDialog : null;
          return Promise.resolve();
        }}
      }},
      storage: {{
        local: {{
          get: (keys, cb) => {{ if (cb) cb({{}}); }},
          set: (items, cb) => {{ if (cb) cb(); }},
          clear: (cb) => {{
            storageCleared = true;
            if (cb) cb();
          }}
        }}
      }},
      tabs: {{
        query: (queryInfo, cb) => {{
          tabsQueried = true;
          cb([{{ id: 101, url: "https://example.com" }}, {{ id: 102, url: "https://example.org" }}]);
        }},
        sendMessage: (tabId, msg, cb) => {{
          sentMessages.push({{ tabId, msg }});
          if (cb) cb();
        }}
      }},
      commands: {{
        onCommand: {{ addListener: () => {{}} }}
      }}
    }};

    global.fetch = () => Promise.reject("offline mock");

    const bgCode = fs.readFileSync({json.dumps(str(bg_path))}, 'utf8');
    const mod = {{ exports: {{}} }};
    const fn = new Function('module', 'exports', 'globalThis', bgCode);
    fn(mod, mod.exports, global);

    const handleSelfUninstall = mod.exports.handleSelfUninstall || global.handleSelfUninstall;
    if (typeof handleSelfUninstall !== 'function') {{
      console.error("handleSelfUninstall not exported as function");
      process.exit(1);
    }}

    handleSelfUninstall().then((result) => {{
      const success = (
        uninstalled === true &&
        confirmDialogOption === false &&
        storageCleared === true &&
        tabsQueried === true &&
        sentMessages.length === 2 &&
        sentMessages[0].msg.type === "QUIZZY_SELF_DESTRUCT_DOM" &&
        result.success === true
      );
      if (success) {{
        process.exit(0);
      }} else {{
        console.error("Self uninstall assertions failed:", {{
          uninstalled, confirmDialogOption, storageCleared, tabsQueried, sentMessages, result
        }});
        process.exit(2);
      }}
    }}).catch(err => {{
      console.error("Error during execution:", err);
      process.exit(3);
    }});
    """

    res = subprocess.run([sys.executable, "-c", f"""
import subprocess
r = subprocess.run(["node", "-e", {repr(js_test_script)}], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout)
    print(r.stderr)
    exit(r.returncode)
"""], capture_output=True, text=True)

    assert res.returncode == 0, f"Node.js mock test failed: {res.stdout}\n{res.stderr}"


def test_node_execution_dom_self_destruct():
    """Execute window.__QUIZZY_SELF_DESTRUCT_DOM__ in mock DOM environment to verify complete scrub."""
    hud_path = PROJECT_ROOT / "extension" / "floating_hud.js"
    js_test_script = f"""
    const fs = require('fs');

    const elements = new Map();
    const listeners = [];

    global.window = {{
      addEventListener: (type, handler) => listeners.push({{ type, handler }}),
      removeEventListener: (type, handler) => {{
        const idx = listeners.findIndex(l => l.type === type && l.handler === handler);
        if (idx !== -1) listeners.splice(idx, 1);
      }},
      location: {{ href: "https://learning.ccbp.in/course", pathname: "/course" }}
    }};

    global.document = {{
      createElement: (tag) => ({{
        id: "",
        style: {{}},
        setAttribute: () => {{}},
        appendChild: () => {{}},
        parentNode: null
      }}),
      getElementById: (id) => elements.get(id) || null,
      querySelectorAll: (sel) => [],
      addEventListener: (type, handler) => listeners.push({{ type, handler }}),
      removeEventListener: (type, handler) => {{
        const idx = listeners.findIndex(l => l.type === type && l.handler === handler);
        if (idx !== -1) listeners.splice(idx, 1);
      }},
      body: {{ innerText: "", appendChild: () => {{}} }},
      documentElement: {{ appendChild: () => {{}} }}
    }};

    global.chrome = {{
      runtime: {{
        sendMessage: () => {{}},
        onMessage: {{ addListener: () => {{}} }},
        lastError: null
      }}
    }};

    // Setup fake host and style elements in DOM
    const fakeShadow = {{
      appendChild: () => {{}},
      querySelector: () => null,
      replaceChildren: () => {{}}
    }};
    const fakeHost = {{
      id: "__quizzy_hud_host__",
      shadowRoot: fakeShadow,
      attachShadow: () => fakeShadow,
      parentNode: {{
        removeChild: (el) => {{ elements.delete("__quizzy_hud_host__"); }}
      }}
    }};
    elements.set("__quizzy_hud_host__", fakeHost);

    const hudCode = fs.readFileSync({json.dumps(str(hud_path))}, 'utf8');
    const mod = {{ exports: {{}} }};
    const fn = new Function('module', 'exports', 'globalThis', hudCode);
    fn(mod, mod.exports, global);

    if (typeof global.window.__QUIZZY_SELF_DESTRUCT_DOM__ !== 'function') {{
      console.error("__QUIZZY_SELF_DESTRUCT_DOM__ not attached to window");
      process.exit(1);
    }}

    // Trigger self destruct
    global.window.__QUIZZY_SELF_DESTRUCT_DOM__();

    // Verify host removed from DOM
    if (elements.has("__quizzy_hud_host__")) {{
      console.error("DOM scrub failed: __quizzy_hud_host__ still present");
      process.exit(2);
    }}

    process.exit(0);
    """

    res = subprocess.run([sys.executable, "-c", f"""
import subprocess
r = subprocess.run(["node", "-e", {repr(js_test_script)}], capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout)
    print(r.stderr)
    exit(r.returncode)
"""], capture_output=True, text=True)

    assert res.returncode == 0, f"Node.js DOM scrub test failed: {res.stdout}\n{res.stderr}"
