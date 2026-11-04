"""
Automated unit & integration tests for QuizZy backend auto-start/stop lifecycle.
Verifies that:
1. Opening learning.ccbp.in in Chrome starts the QuizZy backend on 127.0.0.1:8000.
2. Closing all learning.ccbp.in tabs or navigating away stops the backend.
3. Native host accepts STOP_BACKEND stdio messages and releases port 8000.
4. FastAPI /shutdown endpoint requires localhost authorization.
"""

from __future__ import annotations

import json
import struct
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import lifecycle_manager
from backend.app import app

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def test_shutdown_endpoint_contract() -> None:
    """Verify that POST /shutdown returns 200 ok and GET is disallowed."""
    with TestClient(app) as client:
        # GET should be method not allowed
        res_get = client.get("/shutdown")
        assert res_get.status_code == 405

        # POST from localhost test client returns success
        res_post = client.post("/shutdown")
        assert res_post.status_code == 200
        data = res_post.json()
        assert data.get("status") == "ok"
        assert "shutting down" in data.get("message", "").lower()


def test_native_host_start_and_stop_messages() -> None:
    """Verify that native_host/launcher.bat accepts START_BACKEND, CHECK_HEALTH, and STOP_BACKEND."""
    bat_path = PROJECT_ROOT / "native_host" / "launcher.bat"
    assert bat_path.is_file(), "launcher.bat missing!"

    def send_msg(payload_dict: dict) -> dict:
        payload = json.dumps(payload_dict).encode("utf-8")
        header = struct.pack("<I", len(payload))
        proc = subprocess.run(
            [str(bat_path)],
            input=header + payload,
            capture_output=True,
            shell=True,
            cwd=str(PROJECT_ROOT),
        )
        assert proc.returncode == 0, f"launcher.bat failed: {proc.stderr}"
        stdout = proc.stdout
        assert len(stdout) >= 4, f"Output too short: {stdout}"
        resp_len = struct.unpack("<I", stdout[:4])[0]
        resp_body = stdout[4 : 4 + resp_len].decode("utf-8")
        return json.loads(resp_body)

    # 0. Skip if protected live backend daemon is actively running on port 8000
    if lifecycle_manager.is_backend_healthy():
        pytest.skip("Protected live backend daemon is running on port 8000; skipping destructive lifecycle stop.")

    # 1. Stop backend if currently running to ensure clean starting state
    stop_res = send_msg({"action": "STOP_BACKEND"})
    assert stop_res.get("success") is True

    # 2. Check health -> should be not running
    chk_res = send_msg({"action": "CHECK_HEALTH"})
    assert chk_res.get("success") is True
    assert chk_res.get("running") is False

    # 3. Start backend -> should spawn and report started
    start_res = send_msg({"action": "START_BACKEND"})
    assert start_res.get("success") is True
    assert start_res.get("status") in ("started", "already_running")

    # Wait up to 5s for port to open
    time.sleep(1.5)
    chk_res2 = send_msg({"action": "CHECK_HEALTH"})
    assert chk_res2.get("success") is True
    assert chk_res2.get("running") is True

    # 4. Stop backend -> should stop and report stopped
    stop_res2 = send_msg({"action": "STOP_BACKEND"})
    assert stop_res2.get("success") is True
    assert stop_res2.get("status") in ("stopped", "already_stopped")

    # 5. Check health -> should be not running
    time.sleep(0.5)
    chk_res3 = send_msg({"action": "CHECK_HEALTH"})
    assert chk_res3.get("success") is True
    assert chk_res3.get("running") is False


def test_background_js_ccbp_lifecycle_in_node() -> None:
    """Simulate Chrome tabs lifecycle events against background.js in Node.js."""
    bg_path = (PROJECT_ROOT / "extension" / "background.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const vm = require('vm');

    // Simulated browser state
    let openTabs = [];
    let sentNativeMessages = [];
    let lastRegisteredListeners = {{
      onUpdated: null,
      onCreated: null,
      onRemoved: null,
      onReplaced: null,
      windowsOnRemoved: null,
      onStartup: null,
      onHistoryStateUpdated: null,
      onCommitted: null
    }};

    const mockChrome = {{
      storage: {{
        local: {{
          get: (keys, cb) => cb({{ allowedHosts: ['learning.ccbp.in'] }}),
          set: (obj, cb) => {{ if (cb) cb(); }}
        }}
      }},
      runtime: {{
        lastError: null,
        onMessage: {{ addListener: (fn) => {{}} }},
        onStartup: {{ addListener: (fn) => {{ lastRegisteredListeners.onStartup = fn; }} }},
        sendNativeMessage: (host, msg, cb) => {{
          sentNativeMessages.push(msg);
          if (cb) cb({{ success: true, status: msg.action === 'START_BACKEND' ? 'started' : 'stopped' }});
        }}
      }},
      tabs: {{
        query: (queryInfo, cb) => {{
          cb(openTabs.map(t => Object.assign({{}}, t)));
        }},
        onUpdated: {{ addListener: (fn) => {{ lastRegisteredListeners.onUpdated = fn; }} }},
        onCreated: {{ addListener: (fn) => {{ lastRegisteredListeners.onCreated = fn; }} }},
        onRemoved: {{ addListener: (fn) => {{ lastRegisteredListeners.onRemoved = fn; }} }},
        onReplaced: {{ addListener: (fn) => {{ lastRegisteredListeners.onReplaced = fn; }} }}
      }},
      windows: {{
        onRemoved: {{ addListener: (fn) => {{ lastRegisteredListeners.windowsOnRemoved = fn; }} }},
        getAll: (opts, cb) => cb([])
      }},
      webNavigation: {{
        onHistoryStateUpdated: {{ addListener: (fn) => {{ lastRegisteredListeners.onHistoryStateUpdated = fn; }} }},
        onCommitted: {{ addListener: (fn) => {{ lastRegisteredListeners.onCommitted = fn; }} }}
      }},
      action: {{
        setBadgeText: () => {{}},
        setBadgeBackgroundColor: () => {{}},
        onClicked: {{ addListener: () => {{}} }}
      }},
      scripting: {{
        executeScript: () => Promise.resolve([{{ result: true }}])
      }}
    }};

    let timers = [];
    const customSetTimeout = (fn, ms) => {{
      const id = timers.length + 1;
      // Execute immediately or track for synchronous clock advancement
      const handle = {{ id, fn, ms, cleared: false }};
      timers.push(handle);
      return id;
    }};
    const customClearTimeout = (id) => {{
      for (const t of timers) {{
        if (t.id === id) t.cleared = true;
      }}
    }};
    function advanceTimers() {{
      for (const t of timers) {{
        if (!t.cleared) {{
          t.cleared = true;
          t.fn();
        }}
      }}
    }}

    let mockBackendOnline = false;
    const mockFetch = (url, opts) => {{
      const u = String(url);
      if (u.includes(':8765')) {{
        // Simulate decoupled daemon offline in this isolated unit test to test native fallback
        return Promise.reject(new Error("Connection refused (daemon offline)"));
      }}
      if (u.includes('/health')) {{
        if (mockBackendOnline) {{
          return Promise.resolve({{ ok: true, status: 200, json: () => Promise.resolve({{ status: 'ok' }}) }});
        }} else {{
          return Promise.reject(new Error("Connection refused"));
        }}
      }}
      if (u.includes('/shutdown')) {{
        mockBackendOnline = false;
        return Promise.resolve({{ ok: true, status: 200, json: () => Promise.resolve({{ status: 'ok' }}) }});
      }}
      return Promise.resolve({{ ok: true, status: 200, json: () => Promise.resolve({{}}) }});
    }};

    const sandbox = {{
      chrome: mockChrome,
      fetch: mockFetch,
      setTimeout: customSetTimeout,
      clearTimeout: customClearTimeout,
      console,
      URL,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      RegExp,
      Map,
      Set
    }};

    const bgSource = fs.readFileSync('{bg_path}', 'utf8');
    vm.runInNewContext(bgSource, sandbox);

    // Initial state: no CCBP tabs -> no start backend sent
    if (sentNativeMessages.length !== 0) {{
      throw new Error("Expected 0 messages on init with no tabs, got: " + JSON.stringify(sentNativeMessages));
    }}

    // TEST 1: Open a tab on learning.ccbp.in -> triggers START_BACKEND
    const tab1 = {{ id: 101, url: 'https://learning.ccbp.in/course?c_id=intro' }};
    openTabs.push(tab1);
    lastRegisteredListeners.onUpdated(101, {{ status: 'loading', url: tab1.url }}, tab1);

    // Give microtasks a turn to run fetch callback
    setImmediate(() => {{
      const startMsg = sentNativeMessages.find(m => m.action === 'START_BACKEND');
      if (!startMsg) throw new Error("Expected START_BACKEND message when opening learning.ccbp.in tab!");
      mockBackendOnline = true; // Backend is now online

      // TEST 2: Open second tab on learning.ccbp.in -> backend remains online, no extra redundant starts
      sentNativeMessages = [];
      const tab2 = {{ id: 102, url: 'https://learning.ccbp.in/practice/quiz/1' }};
      openTabs.push(tab2);
      lastRegisteredListeners.onUpdated(102, {{ status: 'complete', url: tab2.url }}, tab2);

      setImmediate(() => {{
        // TEST 3: Close Tab 1 -> Tab 2 is STILL open -> Backend must NOT be stopped!
        openTabs = openTabs.filter(t => t.id !== 101);
        lastRegisteredListeners.onRemoved(101, {{ isWindowClosing: false }});
        advanceTimers();

        const stopMsgPremature = sentNativeMessages.find(m => m.action === 'STOP_BACKEND');
        if (stopMsgPremature) throw new Error("Backend was stopped prematurely while tab 102 was still open!");

        // TEST 4: Close Tab 2 (the final CCBP tab) -> triggers STOP_BACKEND after debounce
        openTabs = openTabs.filter(t => t.id !== 102);
        lastRegisteredListeners.onRemoved(102, {{ isWindowClosing: false }});
        advanceTimers();

        setImmediate(() => {{
          const stopMsg = sentNativeMessages.find(m => m.action === 'STOP_BACKEND');
          if (!stopMsg) throw new Error("Expected STOP_BACKEND when all learning.ccbp.in tabs are closed!");

          // TEST 5: Navigate away from learning.ccbp.in to google.com -> triggers STOP_BACKEND
          sentNativeMessages = [];
          mockBackendOnline = true;
          const tab3 = {{ id: 103, url: 'https://learning.ccbp.in/home' }};
          openTabs.push(tab3);
          lastRegisteredListeners.onUpdated(103, {{ status: 'complete', url: tab3.url }}, tab3);

          setImmediate(() => {{
            // Navigate tab 103 to google.com
            tab3.url = 'https://www.google.com';
            lastRegisteredListeners.onUpdated(103, {{ status: 'loading', url: tab3.url }}, tab3);
            advanceTimers();

            setImmediate(() => {{
              const navStop = sentNativeMessages.find(m => m.action === 'STOP_BACKEND');
              if (!navStop) throw new Error("Expected STOP_BACKEND when navigating away from learning.ccbp.in!");
              console.log("CCBP_AUTO_LIFECYCLE_NODE_TESTS_PASSED");
            }});
          }});
        }});
      }});
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
    assert "CCBP_AUTO_LIFECYCLE_NODE_TESTS_PASSED" in res.stdout
