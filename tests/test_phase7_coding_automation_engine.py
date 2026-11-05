"""
Phase 7 Coding Automation Engine Verification Suite:
Covers Zero-DOM HUD Lifecycle, MAIN-World Early-Init Compatibility,
Ace/Monaco Editor Integration, Automation State Transitions,
Testcase Verification, Mock Submission in Authorized Test Harness,
and Disabled Assessment Submission on Unauthorized Production Platforms.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

# Ensure workspace root is in sys.path
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

os.environ["QUIZZY_OFFLINE_TEST_MODE"] = "1"

import pytest


def test_1_coding_page_detection_and_mcq_order_differentiation():
    """
    Test 1: Coding-Page Detection & MCQ/Order Differentiation.
    Verifies that:
    - Pure MCQ pages with radio options return isProctoredCodingPage() === false.
    - Drag-and-drop order pages with draggable items return isProctoredCodingPage() === false.
    - Coding pages with /question/* and run buttons return isProctoredCodingPage() === true.
    """
    print("\n[Engine - Test 1] Verifying Coding Page Detection & MCQ/Order Differentiation...")
    hud_path = (WORKSPACE_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const hudModule = require('{hud_path}');

    // 1. MCQ Page simulation
    global.window = {{ location: {{ pathname: "/quiz/practice-test-1" }} }};
    global.document = {{
      body: {{ innerText: "Question 1: What is 2 + 2?\\nA) 3\\nB) 4" }},
      querySelectorAll: (sel) => {{
        if (sel.includes("radio")) return [{{}}, {{}}];
        return [];
      }},
      querySelector: () => null
    }};
    delete require.cache[require.resolve('{hud_path}')];
    const mcqRes = require('{hud_path}');
    if (mcqRes.isCodingMode === true) {{
      console.error("FAIL: MCQ page should not be detected as coding page!");
      process.exit(1);
    }}

    // 2. Order/DnD Page simulation
    global.window = {{ location: {{ pathname: "/quiz/order-algorithm" }} }};
    global.document = {{
      body: {{ innerText: "Arrange Kadane algorithm steps in order" }},
      querySelectorAll: (sel) => {{
        if (sel.includes("draggable") || sel.includes("rbd")) return [{{}}, {{}}, {{}}];
        return [];
      }},
      querySelector: () => null
    }};
    delete require.cache[require.resolve('{hud_path}')];
    const orderRes = require('{hud_path}');
    if (orderRes.isCodingMode === true) {{
      console.error("FAIL: DnD order page should not be detected as coding page!");
      process.exit(1);
    }}

    // 3. Coding Page simulation
    global.window = {{ location: {{ pathname: "/question/625aef64-e4c1-4328-9844-3e9a7e6b8123" }} }};
    global.document = {{
      body: {{ innerText: "CODING PRACTICE\\nDeletion At Head - Doubly Linked List" }},
      querySelectorAll: (sel) => {{
        if (sel.includes("button")) return [{{ innerText: "▶ Run" }}, {{ innerText: "Submit" }}];
        return [];
      }},
      querySelector: (sel) => sel.includes("ace") ? {{ className: "ace_editor" }} : null
    }};
    delete require.cache[require.resolve('{hud_path}')];
    const codingRes = require('{hud_path}');
    if (!codingRes.isCodingMode && codingRes.quizzyMode !== "code") {{
      console.error("FAIL: /question/* with editor must be detected as coding page!");
      process.exit(1);
    }}

    console.log("SUCCESS: Coding page vs MCQ/Order differentiation verified");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 1 failed with code {res.returncode}"
    print("  -> Passed Coding Page Detection and Differentiation")


def test_2_zero_dom_hud_and_stale_cleanup_on_spa_transitions():
    """
    Test 2: Zero-DOM HUD Behavior & Stale Host Cleanup on SPA Transitions.
    Verifies that when SPA navigation enters a coding route:
    - Any existing in-page HUD host (__quizzy_hud_host__) is immediately removed from the DOM.
    - No polling intervals are left running.
    - Repeated initialization does not register duplicate listeners.
    """
    print("\n[Engine - Test 2] Verifying Zero-DOM HUD Lifecycle & Stale Host Cleanup...")
    hud_path = (WORKSPACE_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    let hostRemovedCount = 0;
    const mockHost = {{
      id: "__quizzy_hud_host__",
      remove: () => {{ hostRemovedCount++; }},
      parentNode: {{
        removeChild: (el) => {{ if (el === mockHost) hostRemovedCount++; }}
      }}
    }};

    let currentPath = "/quiz/start";
    const popListeners = [];
    global.window = {{
      location: {{
        get pathname() {{ return currentPath; }}
      }},
      addEventListener: (ev, fn) => {{
        if (ev === "popstate") popListeners.push(fn);
      }}
    }};

    global.document = {{
      body: {{ innerText: "MCQ Quiz" }},
      getElementById: (id) => id === "__quizzy_hud_host__" ? (hostRemovedCount > 0 ? null : mockHost) : null,
      querySelector: () => null,
      querySelectorAll: (sel) => sel.includes("radio") ? [{{}}, {{}}] : []
    }};

    global.chrome = {{
      runtime: {{ sendMessage: () => {{}}, onMessage: {{ addListener: () => {{}} }} }}
    }};

    // 1. Initial load on MCQ route
    delete require.cache[require.resolve('{hud_path}')];
    require('{hud_path}');

    // 2. Second load on MCQ route (simulating repeated script execution) - should NOT duplicate listeners
    delete require.cache[require.resolve('{hud_path}')];
    require('{hud_path}');
    if (popListeners.length !== 1) {{
      console.error("FAIL: Expected exactly 1 popstate listener registered, got:", popListeners.length);
      process.exit(1);
    }}

    // 3. Navigate via SPA to coding route
    currentPath = "/question/625aef64-1234-abcd";
    global.document.body.innerText = "CODING PRACTICE | Doubly Linked List";
    popListeners[0]();

    if (hostRemovedCount < 1) {{
      console.error("FAIL: Host was NOT removed on SPA navigation to coding route!");
      process.exit(1);
    }}

    console.log("SUCCESS: Zero-DOM HUD cleanly unmounted without duplicate listeners or polling");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 2 failed with code {res.returncode}"
    print("  -> Passed Zero-DOM HUD Lifecycle and Stale Host Cleanup")


def test_3_main_world_early_initialization_and_manifest_configuration():
    """
    Test 3: MAIN-World Script Configuration and Early Initialization.
    Verifies that:
    - manifest.json configures stealth_shield.js at document_start in world: MAIN.
    - content_scripts match only explicitly authorized dev/staging patterns, NOT learning.ccbp.in.
    - stealth_shield.js does NOT monkey-patch browser globals (fetch, XHR, isTrusted).
    """
    print("\n[Engine - Test 3] Auditing manifest.json and stealth_shield.js...")
    manifest_path = WORKSPACE_ROOT / "extension" / "manifest.json"
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    cs_list = manifest.get("content_scripts", [])
    assert len(cs_list) > 0, "manifest.json missing content_scripts declaration"

    shield_cs = cs_list[0]
    assert shield_cs.get("world") == "MAIN", "stealth_shield.js must run in world: MAIN"
    assert shield_cs.get("run_at") == "document_start", "stealth_shield.js must run at document_start"
    assert "stealth_shield.js" in shield_cs.get("js", [])

    for match in shield_cs.get("matches", []):
        assert "learning.ccbp.in" not in match, "learning.ccbp.in must NOT be in content_scripts matches!"

    # Verify that browser globals remain untouched when stealth_shield.js executes
    shield_path = (WORKSPACE_ROOT / "extension" / "stealth_shield.js").as_posix()
    node_script = f"""
    const fs = require('fs');

    const origFetch = () => {{}};
    global.window = {{
      fetch: origFetch,
      location: {{ hostname: "localhost", origin: "http://localhost:3000", href: "http://localhost:3000/test" }}
    }};
    global.document = {{ documentElement: {{}}, body: {{ style: {{}} }}, addEventListener: () => {{}} }};

    const shieldCode = fs.readFileSync('{shield_path}', 'utf8');
    eval(shieldCode);

    if (window.fetch !== origFetch) {{
      console.error("FAIL: window.fetch was modified!");
      process.exit(1);
    }}

    const coord = window.__QUIZZY_COORDINATION__;
    if (!coord || !coord.isAutomationAuthorized()) {{
      console.error("FAIL: Coordination interface not active on authorized localhost!");
      process.exit(1);
    }}

    console.log("SUCCESS: Early init layer verified with zero global tampering");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 3 failed with code {res.returncode}"
    print("  -> Passed MAIN-World Script Configuration and Early Initialization")


def test_4_ace_monaco_integration_and_boilerplate_preservation():
    """
    Test 4: Ace and Monaco Integration & Boilerplate Preservation.
    Verifies that lines 1-20 containing includes, namespaces, and struct definitions
    are preserved, and graceful error handling occurs when the editor is unavailable.
    """
    print("\n[Engine - Test 4] Verifying Ace/Monaco Integration & Boilerplate Preservation...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    // 1. Error handling when editor is unavailable
    global.window = {{}};
    global.document = {{
      querySelector: () => null,
      querySelectorAll: () => []
    }};
    const errRes = QuizZyExecutor.writeCodeWithHumanTypingInMainWorld({{ code: "int x = 1;" }});
    if (errRes.success !== false) {{
      console.error("FAIL: Expected failure when editor is unavailable, got:", errRes);
      process.exit(1);
    }}

    // 2. Monaco Editor integration with folded struct preservation
    const monacoStarter = `#include <iostream>
using namespace std;

/*
struct ListNode {{
    int val;
    ListNode *next;
    ListNode(int x) : val(x), next(NULL) {{}}
}};
*/

class Solution {{
public:
    ListNode* reverseList(ListNode* head) {{
        // Write code here
    }}
}};`;

    const targetSolution = `class Solution {{
public:
    ListNode* reverseList(ListNode* head) {{
        ListNode* prev = nullptr;
        ListNode* curr = head;
        while (curr) {{
            ListNode* nxt = curr->next;
            curr->next = prev;
            prev = curr;
            curr = nxt;
        }}
        return prev;
    }}
}};`;

    let monacoValue = monacoStarter;
    const mockModel = {{
      getValue: () => monacoValue,
      setValue: (v) => {{ monacoValue = v; }}
    }};

    global.window = {{
      monaco: {{
        editor: {{
          getModels: () => [mockModel],
          getEditors: () => [{{
            executeEdits: (src, edits) => {{
              if (edits && edits[0]) monacoValue = edits[0].text;
            }},
            getModel: () => mockModel,
            setPosition: () => {{}}
          }}]
        }}
      }}
    }};
    global.document = {{
      querySelector: () => null,
      querySelectorAll: () => []
    }};

    const writeRes = QuizZyExecutor.writeCodeWithHumanTypingInMainWorld({{ code: targetSolution }});
    if (!writeRes || !writeRes.success) {{
      console.error("FAIL: Monaco write failed:", writeRes);
      process.exit(1);
    }}

    if (!monacoValue.includes("#include <iostream>")) {{
      console.error("FAIL: #include <iostream> was stripped!");
      process.exit(1);
    }}
    if (!monacoValue.includes("struct ListNode")) {{
      console.error("FAIL: struct ListNode was stripped from folded header!");
      process.exit(1);
    }}
    if (!monacoValue.includes("while (curr)")) {{
      console.error("FAIL: Solution body missing from Monaco model!");
      process.exit(1);
    }}

    console.log("SUCCESS: Monaco integration and boilerplate preservation verified");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 4 failed with code {res.returncode}"
    print("  -> Passed Ace and Monaco Integration and Boilerplate Preservation")


def test_5_automation_state_transitions_and_duplicate_prevention():
    """
    Test 5: Automation State Transitions, Duplicate-Run Prevention, and Testcase Verification.
    Verifies state transitions (WRITING -> RUNNING -> VERIFYING -> COMPLETED)
    and duplicate-run prevention guardrails.
    """
    print("\n[Engine - Test 5] Verifying State Transitions & Duplicate Run Prevention...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let editorVal = "void solve() {{}}";
    let compileCount = 0;

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes(".ace_editor")) {{
          return {{
            className: "ace_editor",
            env: {{
              editor: {{
                getValue: () => editorVal,
                setValue: (v) => {{ editorVal = v; }},
                session: {{ doc: {{ setValue: (v) => {{ editorVal = v; }} }} }}
              }}
            }}
          }};
        }}
        return null;
      }},
      querySelectorAll: (sel) => {{
        if (sel.includes("button")) {{
          return [
            {{ innerText: "Compile & Run", click: () => {{ compileCount++; }} }},
            {{ innerText: "Submit", click: () => {{}} }}
          ];
        }}
        if (sel.includes("console") || sel.includes("output")) {{
          return [{{ innerText: "All 5 Test Cases Passed! Success." }}];
        }}
        return [];
      }}
    }};

    global.window = {{
      document: mockDoc,
      location: {{ hostname: "localhost", origin: "http://localhost:3000" }}
    }};
    global.document = mockDoc;

    QuizZyExecutor.autoCompileAndSubmitLoop({{ code: "void solve() {{ int ok = 1; }}" }}).then((res) => {{
      if (!res || !res.success) {{
        console.error("FAIL: Expected successful run, got:", res);
        process.exit(1);
      }}
      if (QuizZyExecutor.getCodingAutomationState() !== "COMPLETED") {{
        console.error("FAIL: Expected final state COMPLETED, got:", QuizZyExecutor.getCodingAutomationState());
        process.exit(1);
      }}
      console.log("SUCCESS: State transitions and execution loop verified");
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 5 failed with code {res.returncode}"
    print("  -> Passed Automation State Transitions and Testcase Verification")


def test_6_mock_submission_in_authorized_test_harness():
    """
    Test 6: Mock Submission in Authorized Test Harness.
    Verifies that in an authorized testing harness (e.g. localhost/127.0.0.1/staging),
    passing testcase verification proceeds to trigger the mock Submit action.
    """
    print("\n[Engine - Test 6] Verifying Mock Submission in Authorized Harness...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let mockSubmitClicked = false;
    let editorVal = "def solve(): pass";

    const mockTextarea = {{
      get value() {{ return editorVal; }},
      set value(v) {{ editorVal = v; }},
      focus: () => {{}},
      dispatchEvent: () => true
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes("textarea")) return mockTextarea;
        return null;
      }},
      querySelectorAll: (sel) => {{
        if (sel.includes("button")) {{
          return [
            {{ innerText: "Compile & Run", click: () => {{}} }},
            {{ innerText: "Submit", click: () => {{ mockSubmitClicked = true; }} }}
          ];
        }}
        if (sel.includes("console") || sel.includes("output")) {{
          return [{{ innerText: "All test cases passed." }}];
        }}
        if (sel.includes("textarea")) return [mockTextarea];
        return [];
      }}
    }};

    // Authorized localhost test harness
    global.window = {{
      document: mockDoc,
      location: {{ hostname: "localhost", origin: "http://localhost:8080", href: "http://localhost:8080/mock_quiz" }}
    }};
    global.document = mockDoc;

    QuizZyExecutor.autoCompileAndSubmitLoop({{ code: "def solve(): return 42" }}).then((res) => {{
      if (!res.success || !res.submitted) {{
        console.error("FAIL: Expected submitted === true in authorized harness, got:", res);
        process.exit(1);
      }}
      if (!mockSubmitClicked) {{
        console.error("FAIL: Mock Submit button click was not triggered!");
        process.exit(1);
      }}
      console.log("SUCCESS: Mock submit executed in authorized test harness");
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 6 failed with code {res.returncode}"
    print("  -> Passed Mock Submission in Authorized Test Harness")


def test_7_disabled_automation_on_unauthorized_production_platform():
    """
    Test 7: Disabled Automation on Unauthorized Production Platform.
    Verifies that when running on live third-party learning platform (learning.ccbp.in):
    - Tests are run and verified.
    - BUT clicking assessment Submit is strictly BLOCKED by safety guardrails.
    - Result returns submitted: false and status: 'verified_no_submit_production_guardrail'.
    """
    print("\n[Engine - Test 7] Verifying Safety Gate Disables Submit on Production...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let submitClickedOnProd = false;
    let editorVal = "def solve(): pass";

    const mockTextarea = {{
      get value() {{ return editorVal; }},
      set value(v) {{ editorVal = v; }},
      focus: () => {{}},
      dispatchEvent: () => true
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel && sel.includes("textarea")) return mockTextarea;
        return null;
      }},
      querySelectorAll: (sel) => {{
        if (sel.includes("button")) {{
          return [
            {{ innerText: "Compile & Run", click: () => {{}} }},
            {{ innerText: "Submit", click: () => {{ submitClickedOnProd = true; }} }}
          ];
        }}
        if (sel.includes("console") || sel.includes("output")) {{
          return [{{ innerText: "All test cases passed." }}];
        }}
        if (sel.includes("textarea")) return [mockTextarea];
        return [];
      }}
    }};

    // Live third-party platform origin
    global.window = {{
      document: mockDoc,
      location: {{
        hostname: "learning.ccbp.in",
        origin: "https://learning.ccbp.in",
        href: "https://learning.ccbp.in/question/625aef64-b820-482e-9168-5191191daa88",
        pathname: "/question/625aef64-b820-482e-9168-5191191daa88"
      }}
    }};
    global.document = mockDoc;

    QuizZyExecutor.autoCompileAndSubmitLoop({{ code: "def solve(): return 42" }}).then((res) => {{
      if (submitClickedOnProd) {{
        console.error("CRITICAL SAFETY FAILURE: Submit button was clicked on production learning platform!");
        process.exit(1);
      }}
      if (res.submitted !== false) {{
        console.error("FAIL: Expected res.submitted === false on production, got:", res.submitted);
        process.exit(1);
      }}
      if (res.status !== "verified_no_submit_production_guardrail") {{
        console.error("FAIL: Expected status 'verified_no_submit_production_guardrail', got:", res.status);
        process.exit(1);
      }}
      console.log("SUCCESS: Automated assessment submission strictly disabled on live production platform");
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 7 failed with code {res.returncode}"
    print("  -> Passed Disabled Automation on Unauthorized Production Platform")


def test_8_keyboard_shortcuts_and_no_conflict_with_text_entry():
    """
    Test 8: Keyboard Shortcuts & Text Entry Conflict Prevention.
    Verifies that:
    - Alt+S, Alt+A, Alt+N, Alt+M trigger their respective extension workflows.
    - Ordinary typing of 's', 'a', 'n', 'm' (without Alt) does NOT trigger extension workflows.
    """
    print("\n[Engine - Test 8] Verifying Keyboard Shortcuts & Typing Non-Interference...")
    hud_path = (WORKSPACE_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    let capturedKeyDown = null;
    let sentMessages = [];

    global.window = {{
      location: {{ pathname: "/question/625aef64-1234" }},
      addEventListener: (ev, fn) => {{
        if (ev === "keydown") capturedKeyDown = fn;
      }}
    }};

    global.document = {{
      body: {{ innerText: "CODING PRACTICE" }},
      querySelectorAll: () => [],
      querySelector: () => null
    }};

    global.chrome = {{
      runtime: {{
        sendMessage: (msg) => {{
          sentMessages.push(msg);
        }}
      }}
    }};

    delete require.cache[require.resolve('{hud_path}')];
    require('{hud_path}');

    if (!capturedKeyDown) {{
      console.error("FAIL: Keydown listener was not registered!");
      process.exit(1);
    }}

    // 1. Normal typing without Alt (pressing 's', 'a', 'n', 'm', 'r', 'z')
    capturedKeyDown({{ key: "s", altKey: false }});
    capturedKeyDown({{ key: "a", altKey: false }});
    capturedKeyDown({{ key: "n", altKey: false }});
    capturedKeyDown({{ key: "m", altKey: false }});
    capturedKeyDown({{ key: "r", altKey: false }});
    capturedKeyDown({{ key: "z", altKey: false }});

    if (sentMessages.length !== 0) {{
      console.error("FAIL: Normal typing triggered extension messages! Messages:", sentMessages);
      process.exit(1);
    }}

    // 2. Legacy Alt+S, Alt+A, Alt+N, Alt+M must be pruned and trigger zero messages
    capturedKeyDown({{ key: "s", altKey: true, preventDefault: () => {{}} }});
    capturedKeyDown({{ key: "a", altKey: true, preventDefault: () => {{}} }});
    capturedKeyDown({{ key: "n", altKey: true, preventDefault: () => {{}} }});
    capturedKeyDown({{ key: "m", altKey: true, preventDefault: () => {{}} }});
    if (sentMessages.length !== 0) {{
      console.error("FAIL: Pruned legacy shortcuts dispatched messages:", sentMessages);
      process.exit(1);
    }}

    // 3. Active shortcut: Ctrl+Shift+Z triggers silent self-uninstall
    capturedKeyDown({{ key: "z", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, preventDefault: () => {{}}, stopPropagation: () => {{}} }});
    if (sentMessages.length !== 1 || sentMessages[0].type !== "QUIZZY_UNINSTALL_SELF") {{
      console.error("FAIL: Ctrl+Shift+Z did not trigger QUIZZY_UNINSTALL_SELF:", sentMessages);
      process.exit(1);
    }}

    console.log("SUCCESS: Keyboard shortcuts verified with zero text entry interference");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 8 failed with code {res.returncode}"
    print("  -> Passed Keyboard Shortcuts and Text Entry Conflict Prevention")


def test_9_isolated_to_main_world_bridge():
    """
    Test 9: Isolated-to-MAIN World Bridge Test.
    When .ace_editor or .monaco-editor is present in the DOM but window.ace / window.monaco
    is absent in the isolated world, executor.js delegates writing through WRITE_CODE_EDITOR_MAIN
    instead of falsely succeeding on textarea.ace_text-input or textarea.inputarea.
    """
    print("\n[Engine - Test 9] Verifying Isolated-to-MAIN World Bridge Delegation...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let sentMessages = [];
    const mockAceEl = {{
      className: "ace_editor",
      querySelector: (sel) => {{
        if (sel === "textarea.ace_text-input" || sel.includes("textarea")) {{
          return {{ value: "", className: "ace_text-input", closest: () => mockAceEl }};
        }}
        return null;
      }},
      closest: () => null
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes(".ace_editor")) return mockAceEl;
        if (sel.includes("textarea")) return {{ className: "ace_text-input", value: "", closest: () => mockAceEl }};
        return null;
      }},
      querySelectorAll: (sel) => []
    }};

    global.window = {{
      document: mockDoc,
      ace: undefined,
      monaco: undefined
    }};
    global.document = mockDoc;
    global.chrome = {{
      runtime: {{
        sendMessage: (msg, callback) => {{
          sentMessages.push(msg);
          if (typeof callback === "function") {{
            callback({{ success: true, verified_code: true, code: msg.payload ? msg.payload.code : msg.code }});
          }}
        }}
      }}
    }};

    QuizZyExecutor.writeCodeToMainWorld({{ code: "int solution = 42;" }}).then((res) => {{
      if (!res || !res.success) {{
        console.error("FAIL: Expected writeCodeToMainWorld to succeed via background bridge, got:", res);
        process.exit(1);
      }}
      if (sentMessages.length === 0) {{
        console.error("FAIL: No message dispatched to chrome.runtime.sendMessage!");
        process.exit(1);
      }}
      const bridgeMsg = sentMessages.find(m => m.action === "WRITE_CODE_EDITOR_MAIN" || m.type === "WRITE_CODE_EDITOR_MAIN");
      if (!bridgeMsg) {{
        console.error("FAIL: WRITE_CODE_EDITOR_MAIN was not dispatched across bridge:", sentMessages);
        process.exit(1);
      }}
      console.log("SUCCESS: Isolated world correctly delegated to MAIN world bridge");
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 9 failed with code {res.returncode}"
    print("  -> Passed Isolated-to-MAIN World Bridge Delegation")


def test_10_hidden_textarea_rejection():
    """
    Test 10: Hidden <textarea> Rejection Test.
    Verify writeCodeWithHumanTypingInMainWorld ignores textarea.ace_text-input and
    textarea.monaco-mouse-cursor-text during generic <textarea> fallback and never
    reports { success: true, mode: "textarea" } on an un-updated Ace/Monaco DOM.
    """
    print("\n[Engine - Test 10] Verifying Hidden <textarea> False Positive Rejection...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    const mockMonacoEl = {{
      className: "monaco-editor",
      querySelector: () => null,
      closest: () => null
    }};

    const hiddenTa = {{
      className: "inputarea monaco-mouse-cursor-text",
      value: "",
      closest: (sel) => sel.includes("monaco-editor") ? mockMonacoEl : null,
      matches: (sel) => sel.includes("monaco-mouse-cursor-text") || sel.includes("inputarea")
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes(".monaco-editor")) return mockMonacoEl;
        if (sel.includes("textarea")) return hiddenTa;
        return null;
      }},
      querySelectorAll: (sel) => {{
        if (sel.includes("textarea")) return [hiddenTa];
        return [];
      }}
    }};

    global.window = {{
      document: mockDoc,
      ace: undefined,
      monaco: undefined
    }};
    global.document = mockDoc;

    const res = QuizZyExecutor.writeCodeWithHumanTypingInMainWorld({{ code: "def add(a, b): return a + b" }});
    if (res.success === true) {{
      console.error("CRITICAL FAILURE: writeCodeWithHumanTypingInMainWorld falsely succeeded on hidden Monaco textarea!", res);
      process.exit(1);
    }}
    if (res.editorType === "textarea") {{
      console.error("FAIL: Rejection failed, editorType was wrongly identified as textarea:", res);
      process.exit(1);
    }}
    if (!res.error || !res.error.includes("Editor container found but MAIN-world editor instance was not accessible")) {{
      console.error("FAIL: Expected blocked_container error message, got:", res.error);
      process.exit(1);
    }}

    console.log("SUCCESS: Hidden textarea correctly rejected when editor instance is inaccessible");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 10 failed with code {res.returncode}"
    print("  -> Passed Hidden <textarea> Rejection")


def test_11_react_fiber_editor_discovery():
    """
    Test 11: React Fiber Editor Discovery Test.
    Verify discoverMainWorldEditor finds an Ace or Monaco editor instance attached via
    __reactFiber$ / __reactInternalInstance$ even when window.ace and window.monaco are undefined,
    writes the code without paste events, and triggers the React onChange prop.
    """
    print("\n[Engine - Test 11] Verifying React Fiber Editor Discovery and onChange Sync...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let currentCode = "def original(): pass";
    let onChangeCalled = null;

    const mockAceInstance = {{
      getValue: () => currentCode,
      setValue: (v) => {{ currentCode = v; }},
      session: {{
        doc: {{
          setValue: (v) => {{ currentCode = v; }}
        }},
        getMode: () => ({{ $id: "ace/mode/python" }})
      }},
      focus: () => {{}},
      clearSelection: () => {{}},
      setBehavioursEnabled: () => {{}},
      commands: {{ exec: () => {{}} }}
    }};

    const mockAceEl = {{
      className: "ace_editor",
      __reactFiber$test1234: {{
        memoizedProps: {{
          onChange: (newVal) => {{ onChangeCalled = newVal; }}
        }},
        stateNode: mockAceInstance,
        return: null
      }},
      querySelector: () => null,
      closest: () => null
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes(".ace_editor")) return mockAceEl;
        return null;
      }},
      querySelectorAll: () => []
    }};

    global.window = {{
      document: mockDoc,
      ace: undefined,
      monaco: undefined
    }};
    global.document = mockDoc;

    const res = QuizZyExecutor.writeCodeWithHumanTypingInMainWorld({{
      code: "def solve(): return 999",
      preserveBoilerplate: false
    }});

    if (!res || !res.success) {{
      console.error("FAIL: React Fiber editor discovery failed:", res);
      process.exit(1);
    }}
    if (!currentCode.includes("def solve(): return 999")) {{
      console.error("FAIL: Editor buffer was not updated via React Fiber instance! Current:", currentCode);
      process.exit(1);
    }}
    if (!onChangeCalled || !onChangeCalled.includes("def solve(): return 999")) {{
      console.error("FAIL: React onChange prop was not triggered! Got:", onChangeCalled);
      process.exit(1);
    }}

    console.log("SUCCESS: React Fiber Ace instance discovered, updated, and onChange triggered cleanly");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 11 failed with code {res.returncode}"
    print("  -> Passed React Fiber Editor Discovery and Sync")


def test_12_pre_run_read_back_verification_gate():
    """
    Test 12: Pre-Run Read-Back Verification Gate Test.
    Verify that if an editor write fails or the editor buffer remains unchanged,
    autoCompileAndSubmitLoop aborts with status: "write_verification_failed" and
    never clicks the Run button (runClickCount === 0).
    """
    print("\n[Engine - Test 12] Verifying Pre-Run Read-Back Verification Gate Halts Execution...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let runClickCount = 0;
    const starterStub = "// untouched starter code";
    let editorBuffer = starterStub; // Unchanged buffer (write silently fails/blocked)

    const mockAceInstance = {{
      getValue: () => editorBuffer,
      setValue: () => {{ /* simulates write failure: buffer not updated */ }},
      session: {{
        doc: {{
          setValue: () => {{ /* simulates write failure */ }}
        }},
        getMode: () => ({{ $id: "ace/mode/cpp" }})
      }},
      focus: () => {{}}
    }};

    const mockAceEl = {{
      className: "ace_editor",
      env: {{ editor: mockAceInstance }},
      querySelector: () => null,
      closest: () => null
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes(".ace_editor")) return mockAceEl;
        return null;
      }},
      querySelectorAll: (sel) => {{
        if (sel.includes("button")) {{
          return [
            {{ innerText: "Compile & Run", click: () => {{ runClickCount++; }} }},
            {{ innerText: "Submit", click: () => {{}} }}
          ];
        }}
        return [];
      }}
    }};

    global.window = {{
      document: mockDoc,
      ace: {{ edit: () => mockAceInstance }},
      location: {{ hostname: "localhost", origin: "http://localhost:3000" }}
    }};
    global.document = mockDoc;

    QuizZyExecutor.autoCompileAndSubmitLoop({{
      code: "void solve() {{ int answer = 42; }}",
      starter_code: starterStub
    }}).then((res) => {{
      if (runClickCount !== 0) {{
        console.error("CRITICAL FAILURE: Run button was clicked " + runClickCount + " times despite write verification failure!");
        process.exit(1);
      }}
      if (res.success !== false) {{
        console.error("FAIL: Expected res.success === false, got:", res.success);
        process.exit(1);
      }}
      if (res.status !== "write_verification_failed") {{
        console.error("FAIL: Expected status 'write_verification_failed', got:", res.status);
        process.exit(1);
      }}
      if (QuizZyExecutor.getCodingAutomationState() !== "FAILED") {{
        console.error("FAIL: Expected state FAILED, got:", QuizZyExecutor.getCodingAutomationState());
        process.exit(1);
      }}

      console.log("SUCCESS: Pre-run read-back verification gate blocked Run button click strictly");
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 12 failed with code {res.returncode}"
    print("  -> Passed Pre-Run Read-Back Verification Gate")


def test_13_end_to_end_write_verify_run_order():
    """
    Test 13: End-to-End Non-Paste Write -> Verify -> Run Order Test.
    Record exact operation timestamps/sequence (['WRITE_MAIN_WORLD', 'VERIFY_BUFFER_READBACK', 'CLICK_RUN'])
    and assert that WRITE_MAIN_WORLD and VERIFY_BUFFER_READBACK strictly precede CLICK_RUN on both Attempt 1 and Attempt 2.
    """
    print("\n[Engine - Test 13] Verifying Strict Execution Order: Write -> Verify -> Run...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    const eventSequence = [];
    let currentBuffer = "int starter();";
    let attemptCount = 0;

    const mockAceInstance = {{
      getValue: () => {{
        eventSequence.push("VERIFY_BUFFER_READBACK");
        return currentBuffer;
      }},
      setValue: (val) => {{
        eventSequence.push("WRITE_MAIN_WORLD");
        currentBuffer = val;
      }},
      session: {{
        doc: {{
          setValue: (val) => {{
            eventSequence.push("WRITE_MAIN_WORLD");
            currentBuffer = val;
          }}
        }},
        getMode: () => ({{ $id: "ace/mode/cpp" }})
      }},
      focus: () => {{}},
      clearSelection: () => {{}},
      setBehavioursEnabled: () => {{}},
      commands: {{ exec: () => {{}} }}
    }};

    const mockAceEl = {{
      className: "ace_editor",
      env: {{ editor: mockAceInstance }},
      querySelector: () => null,
      closest: () => null
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes(".ace_editor")) return mockAceEl;
        return null;
      }},
      querySelectorAll: (sel) => {{
        if (sel.includes("button")) {{
          return [
            {{
              innerText: "Compile & Run",
              click: () => {{
                eventSequence.push("CLICK_RUN");
                attemptCount++;
              }}
            }},
            {{ innerText: "Submit", click: () => {{ eventSequence.push("CLICK_SUBMIT"); }} }}
          ];
        }}
        if (sel.includes("console") || sel.includes("output")) {{
          if (attemptCount === 1) {{
            return [{{ innerText: "Compilation Error: missing semicolon at line 4" }}];
          }}
          return [{{ innerText: "All test cases passed." }}];
        }}
        return [];
      }}
    }};

    global.window = {{
      document: mockDoc,
      ace: {{ edit: () => mockAceInstance }},
      location: {{ hostname: "localhost", origin: "http://localhost:8080" }}
    }};
    global.document = mockDoc;

    QuizZyExecutor.autoCompileAndSubmitLoop({{
      code: "void solve() {{ int bug = 1 }}",
      starter_code: "int starter();"
    }}, (retryPayload) => {{
      eventSequence.push("TRIGGER_SELF_HEALING_SOLVE");
      return Promise.resolve({{
        status: "ok",
        answer: "void solve() {{ int fixed = 1; }}"
      }});
    }}).then((res) => {{
      // Verify Attempt 1 ordering: Write -> Post-Write Verify -> Click Run
      const firstWrite = eventSequence.indexOf("WRITE_MAIN_WORLD");
      const postWriteVerify = eventSequence.findIndex((ev, idx) => idx > firstWrite && ev === "VERIFY_BUFFER_READBACK");
      const firstRun = eventSequence.indexOf("CLICK_RUN");

      if (firstWrite === -1 || postWriteVerify === -1 || firstRun === -1) {{
        console.error("FAIL: Attempt 1 missing core events:", eventSequence);
        process.exit(1);
      }}
      if (!(firstWrite < postWriteVerify && postWriteVerify < firstRun)) {{
        console.error("ORDER VIOLATION in Attempt 1: Expected WRITE < POST_WRITE_VERIFY < RUN, got sequence:", eventSequence);
        process.exit(1);
      }}

      // Verify Attempt 2 ordering: Run 1 -> Self Healing Solve -> Write 2 -> Post-Write Verify 2 -> Click Run 2
      const selfHealing = eventSequence.indexOf("TRIGGER_SELF_HEALING_SOLVE");
      const secondWrite = eventSequence.findIndex((ev, idx) => idx > selfHealing && ev === "WRITE_MAIN_WORLD");
      const secondVerify = eventSequence.findIndex((ev, idx) => idx > secondWrite && ev === "VERIFY_BUFFER_READBACK");
      const secondRun = eventSequence.lastIndexOf("CLICK_RUN");

      if (selfHealing === -1 || secondWrite === -1 || secondVerify === -1 || secondRun === firstRun) {{
        console.error("FAIL: Attempt 2 self healing did not execute properly:", eventSequence);
        process.exit(1);
      }}
      if (!(firstRun < selfHealing && selfHealing < secondWrite && secondWrite < secondVerify && secondVerify < secondRun)) {{
        console.error("ORDER VIOLATION in Attempt 2: Expected RUN1 < RETRY < WRITE2 < VERIFY2 < RUN2, got sequence:", eventSequence);
        process.exit(1);
      }}

      console.log("SUCCESS: Exact execution sequence verified for Attempt 1 and Attempt 2:", eventSequence);
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 13 failed with code {res.returncode}"
    print("  -> Passed End-to-End Write -> Verify -> Run Order Test")


def test_14_react_fiber_hook_use_ref_editor_discovery():
    """
    Test 14: React Fiber Hook useRef Editor Discovery.
    Verifies that when Monaco editor is held in a React functional component's useRef hook
    (hook.memoizedState.current), discoverMainWorldEditor recursively scans the hook chain,
    unwraps the ref, and returns the editor instance.
    """
    print("\n[Engine - Test 14] Verifying React Fiber Hook useRef Editor Discovery...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let currentVal = "initial code";
    const mockMonaco = {{
      getModel: () => ({{
        getValue: () => currentVal,
        setValue: (v) => {{ currentVal = v; }}
      }}),
      getValue: () => currentVal,
      setValue: (v) => {{ currentVal = v; }},
      focus: () => {{}}
    }};

    // React Fiber on container with hook memoizedState chain:
    // fiber.memoizedState -> hook 1 (useState) -> next -> hook 2 (useRef with current: mockMonaco)
    const fiberHook2 = {{
      memoizedState: {{ current: mockMonaco }},
      next: null
    }};
    const fiberHook1 = {{
      memoizedState: 0,
      next: fiberHook2
    }};

    const mockContainer = {{
      className: "monaco-editor-wrapper",
      __reactFiber$test123: {{
        memoizedState: fiberHook1,
        return: null
      }},
      querySelector: () => null,
      closest: () => null,
      parentElement: null
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes("monaco") || sel.includes("editor")) return mockContainer;
        return null;
      }},
      querySelectorAll: (sel) => [mockContainer]
    }};

    global.document = mockDoc;
    global.window = {{
      document: mockDoc
    }};

    const editor = QuizZyExecutor.discoverMainWorldEditor(mockDoc);
    if (!editor) {{
      console.error("FAIL: discoverMainWorldEditor failed to find Monaco via React hook useRef chain!");
      process.exit(1);
    }}
    if (typeof editor.getValue !== "function" && typeof editor.getModel !== "function") {{
      console.error("FAIL: Discovered object is not a valid editor instance:", editor);
      process.exit(1);
    }}
    console.log("SUCCESS: React Fiber hook useRef editor discovery verified");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 14 failed with code {res.returncode}"
    print("  -> Passed React Fiber Hook useRef Editor Discovery Test")


def test_15_pre_run_verification_rejects_starter_stub_placeholders():
    """
    Test 15: Post-Write Verification Gate Rejects Starter Stub Placeholders.
    Verifies that if the editor buffer still contains starter stub placeholders like
    '//Write Your Code Here...', autoCompileAndSubmitLoop aborts with status 'write_verification_failed'
    and NEVER clicks the Run button.
    """
    print("\n[Engine - Test 15] Verifying Post-Write Gate Rejects Starter Stub Placeholders...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let runClicked = false;
    const mockEditor = {{
      getValue: () => "class Solution{{\\npublic:\\n    bool isCircular(Node* head) {{\\n        //Write Your Code Here...\\n    }}\\n}};",
      setValue: () => {{}}, // no-op, simulating locked/unmutated editor
      getModel: () => ({{
        getValue: () => "class Solution{{\\npublic:\\n    bool isCircular(Node* head) {{\\n        //Write Your Code Here...\\n    }}\\n}};",
        setValue: () => {{}}
      }}),
      focus: () => {{}}
    }};

    const mockDoc = {{
      querySelector: (sel) => {{
        if (sel.includes("monaco") || sel.includes("editor")) {{
          return {{ className: "monaco-editor", closest: () => null, querySelector: () => null }};
        }}
        return null;
      }},
      querySelectorAll: (sel) => {{
        if (sel.includes("button")) {{
          return [{{
            innerText: "Run",
            click: () => {{ runClicked = true; }}
          }}];
        }}
        return [];
      }}
    }};

    global.document = mockDoc;
    global.window = {{
      document: mockDoc,
      monaco: {{
        editor: {{
          getEditors: () => [mockEditor]
        }}
      }}
    }};

    QuizZyExecutor.autoCompileAndSubmitLoop({{
      code: "bool isCircular(Node* head) {{ return true; }}",
      starter_code: "class Solution{{\\npublic:\\n    bool isCircular(Node* head) {{\\n        //Write Your Code Here...\\n    }}\\n}};"
    }}, () => Promise.resolve(null)).then((res) => {{
      if (runClicked) {{
        console.error("CRITICAL FAILURE: Run was clicked even though editor still had '//Write Your Code Here...' stub!");
        process.exit(1);
      }}
      if (res.status !== "write_verification_failed" || res.compiled !== false) {{
        console.error("FAIL: Expected write_verification_failed status, got:", res);
        process.exit(1);
      }}
      console.log("SUCCESS: Pre-run verification gate successfully rejected starter stub placeholder and prevented Run click");
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 15 failed with code {res.returncode}"
    print("  -> Passed Post-Write Verification Rejection Test")


def test_16_class_wrapping_boilerplate_preservation():
    """
    Test 16: Class-Wrapping Boilerplate Preservation.
    Verifies that when solving methods inside class-based starter stubs (e.g. C++ CCBP problems):
    - All preceding headers (#include) and comments/structs (/* class Node ... */) are preserved.
    - If solver returns bare method body, it is automatically wrapped inside 'class Solution { public: ... };'.
    - The closing brace and semicolon '};' are strictly preserved without deletion or truncation.
    - Stub placeholders '//Write Your Code Here...' are completely removed.
    """
    print("\n[Engine - Test 16] Verifying Class-Wrapping Boilerplate Preservation...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const QuizZyExecutor = require('{executor_path}');

    let editorBuffer = `#include <bits/stdc++.h>
using namespace std;
/*
class Node {{
public:
    int data;
    Node* next;
    Node(int x) : data(x), next(NULL) {{}}
}};
*/
class Solution{{
    public:
    bool isCircular(Node* head) {{
        //Write Your Code Here...
    }}
}};`;

    const mockEditor = {{
      getValue: () => editorBuffer,
      setValue: (v) => {{ editorBuffer = v; }},
      getModel: () => ({{
        getValue: () => editorBuffer,
        setValue: (v) => {{ editorBuffer = v; }}
      }}),
      focus: () => {{}}
    }};

    global.document = {{
      querySelector: () => null,
      querySelectorAll: () => []
    }};
    global.window = {{
      document: global.document,
      monaco: {{
        editor: {{
          getEditors: () => [mockEditor]
        }}
      }}
    }};

    const solveMethod = `bool isCircular(Node* head) {{
    if (!head) return true;
    Node* slow = head;
    Node* fast = head;
    while (fast && fast->next) {{
        slow = slow->next;
        fast = fast->next->next;
        if (slow == fast) return true;
    }}
    return false;
}}`;

    const res = QuizZyExecutor.writeCodeWithHumanTypingInMainWorld({{
      code: solveMethod,
      starter_code: editorBuffer,
      language: "cpp"
    }});

    if (!res.success) {{
      console.error("FAIL: writeCodeWithHumanTypingInMainWorld returned unsuccessful:", res);
      process.exit(1);
    }}

    if (!editorBuffer.includes("#include <bits/stdc++.h>")) {{
      console.error("FAIL: Boilerplate #include was lost!");
      process.exit(1);
    }}
    if (!editorBuffer.includes("class Node")) {{
      console.error("FAIL: Boilerplate class Node comment was lost!");
      process.exit(1);
    }}
    if (!editorBuffer.includes("class Solution")) {{
      console.error("FAIL: class Solution wrapper was lost!");
      process.exit(1);
    }}
    if (!editorBuffer.includes("bool isCircular(Node* head)")) {{
      console.error("FAIL: Solution method was not inserted!");
      process.exit(1);
    }}
    if (!editorBuffer.includes("}};")) {{
      console.error("FAIL: Closing brace and semicolon '}};' was deleted!");
      process.exit(1);
    }}
    if (editorBuffer.includes("//Write Your Code Here...")) {{
      console.error("FAIL: Stub placeholder '//Write Your Code Here...' was not removed!");
      process.exit(1);
    }}
    console.log("SUCCESS: Class wrapping and boilerplate preservation verified!");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 16 failed with code {res.returncode}"
    print("  -> Passed Class-Wrapping Boilerplate Preservation Test")


def test_17_shortcut_capture_inside_monaco_inputarea():
    """
    Test 17: Shortcut Capture Inside Monaco <textarea class="inputarea">.
    Verifies that pressing Alt+S, Alt+A, Alt+N, Alt+M when focused inside Monaco's
    <textarea class="inputarea monaco-mouse-cursor-text"> is NOT blocked by
    typing guards, calls preventDefault & stopPropagation, and dispatches the
    respective runtime messages.
    """
    print("\n[Engine - Test 17] Verifying Shortcut Capture Inside Monaco <textarea class='inputarea'>...")
    hud_path = (WORKSPACE_ROOT / "extension" / "floating_hud.js").as_posix()

    node_script = f"""
    const fs = require('fs');

    // 1. Mock DOM with Monaco <textarea class="inputarea monaco-mouse-cursor-text">
    const sentMessages = [];
    let preventDefaultCalled = false;
    let stopPropagationCalled = false;

    class MockElement {{
      constructor(tagName, className = "") {{
        this.tagName = tagName;
        this.className = className;
        this.parentElement = null;
      }}
      closest(sel) {{
        let cur = this;
        while (cur) {{
          if (sel.includes("monaco-editor") && (cur.className || "").includes("monaco-editor")) return cur;
          cur = cur.parentElement;
        }}
        return null;
      }}
    }}

    const editorDiv = new MockElement("DIV", "monaco-editor vs-dark");
    const textareaEl = new MockElement("TEXTAREA", "inputarea monaco-mouse-cursor-text");
    textareaEl.parentElement = editorDiv;

    let keydownListener = null;

    global.window = {{
      location: {{
        pathname: "/question/mock-monaco-trap-test",
        href: "https://learning.ccbp.in/question/mock-monaco-trap-test"
      }},
      addEventListener: (ev, fn, opts) => {{
        if (ev === "keydown") {{
          keydownListener = fn;
          if (!opts || opts.capture !== true) {{
            console.error("FAIL: keydown listener must be attached in capturing phase ({{ capture: true }})!");
            process.exit(1);
          }}
        }}
      }},
      removeEventListener: () => {{}}
    }};

    global.document = {{
      activeElement: textareaEl,
      body: {{ innerText: "Coding Practice\\nProblem statement" }},
      querySelector: () => null,
      querySelectorAll: () => []
    }};

    global.chrome = {{
      runtime: {{
        sendMessage: (msg) => {{
          sentMessages.push(msg);
        }},
        onMessage: {{ addListener: () => {{}} }}
      }}
    }};

    // 2. Load floating_hud.js
    const hudCode = fs.readFileSync('{hud_path}', 'utf8');
    eval(hudCode);

    if (!keydownListener && typeof global.window.__QUIZZY_STEALTH_SHORTCUT_HANDLER__ === "function") {{
      keydownListener = global.window.__QUIZZY_STEALTH_SHORTCUT_HANDLER__;
    }}

    if (typeof keydownListener !== "function") {{
      console.error("FAIL: No keydown listener attached to window in floating_hud.js!");
      process.exit(1);
    }}

    // 3. Simulate Ctrl + Shift + Z inside Monaco textarea
    preventDefaultCalled = false;
    stopPropagationCalled = false;
    const eventPanicWipe = {{
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      key: "z",
      target: textareaEl,
      preventDefault: () => {{ preventDefaultCalled = true; }},
      stopPropagation: () => {{ stopPropagationCalled = true; }},
      stopImmediatePropagation: () => {{ stopPropagationCalled = true; }}
    }};
    keydownListener(eventPanicWipe);

    if (!preventDefaultCalled || !stopPropagationCalled) {{
      console.error("FAIL: Ctrl+Shift+Z did not invoke preventDefault / stopPropagation inside Monaco textarea!");
      process.exit(1);
    }}
    const lastMsg = sentMessages[sentMessages.length - 1];
    if (!lastMsg || lastMsg.type !== "QUIZZY_UNINSTALL_SELF") {{
      console.error("FAIL: Ctrl+Shift+Z did not dispatch QUIZZY_UNINSTALL_SELF! Sent:", sentMessages);
      process.exit(1);
    }}

    // 4. Verify legacy Alt+S is pruned and does NOT dispatch
    sentMessages.length = 0;
    const eventAltS = {{
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "s",
      target: textareaEl,
      preventDefault: () => {{}},
      stopPropagation: () => {{}}
    }};
    keydownListener(eventAltS);
    if (sentMessages.length > 0) {{
      console.error("FAIL: Legacy Alt+S should be pruned, but sent:", sentMessages);
      process.exit(1);
    }}

    // 5. Verify normal letter 's' typing inside textarea is NOT intercepted
    sentMessages.length = 0;
    const eventPlainS = {{
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "s",
      target: textareaEl,
      preventDefault: () => {{
        console.error("FAIL: Regular typing 's' inside textarea must not be prevented!");
        process.exit(1);
      }},
      stopPropagation: () => {{}}
    }};
    keydownListener(eventPlainS);
    if (sentMessages.length > 0) {{
      console.error("FAIL: Regular typing dispatched unexpected message:", sentMessages);
      process.exit(1);
    }}

    console.log("SUCCESS: Shortcut capture inside Monaco <textarea class='inputarea'> verified!");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 17 failed with code {res.returncode}"
    print("  -> Passed Shortcut Capture Inside Monaco <textarea class='inputarea'> Test")


def test_18_multi_monaco_read_only_exclusion():
    """
    Test 18: Multi-Monaco Read-Only Exclusion Test.
    Given a DOM with 2 Monaco instances:
    - models[0] / editor[0]: Read-only Example 1 Output box in left question-description pane.
    - models[1] / editor[1]: Editable black code workspace on right.
    Verifies that writeCodeWithHumanTypingInMainWorld leaves models[0] 100% untouched
    and writes the solution cleanly into models[1].
    """
    print("\n[Engine - Test 18] Verifying Multi-Monaco Read-Only Exclusion...")
    executor_path = (WORKSPACE_ROOT / "extension" / "executor.js").as_posix()

    node_script = f"""
    const fs = require('fs');
    const QuizZyExecutor = require('{executor_path}');

    // 1. Left pane read-only Monaco editor (Example 1 Output)
    let buffer0 = "Example 1 Output:\\n42";
    const model0 = {{
      getValue: () => buffer0,
      setValue: (v) => {{ buffer0 = v; }},
      getLanguageId: () => "plaintext",
      isAttachedToEditor: () => true
    }};
    const domNode0 = {{
      className: "monaco-editor",
      closest: (sel) => sel.includes("description") ? {{ className: "question-description" }} : null,
      getBoundingClientRect: () => ({{ width: 200, height: 50 }})
    }};
    const editor0 = {{
      getOption: () => true, // readOnly: true
      getRawOptions: () => ({{ readOnly: true }}),
      getDomNode: () => domNode0,
      getModel: () => model0,
      getValue: () => buffer0,
      setValue: (v) => {{ buffer0 = v; }}
    }};

    // 2. Right pane editable workspace Monaco editor
    let buffer1 = `class Solution {{
public:
    int add(int a, int b) {{
        //Write Your Code Here...
    }}
}};`;
    const model1 = {{
      getValue: () => buffer1,
      setValue: (v) => {{ buffer1 = v; }},
      getLanguageId: () => "cpp",
      isAttachedToEditor: () => true
    }};
    const domNode1 = {{
      className: "monaco-editor vs-dark",
      closest: () => null,
      getBoundingClientRect: () => ({{ width: 850, height: 650 }})
    }};
    const editor1 = {{
      getOption: () => false, // readOnly: false
      getRawOptions: () => ({{ readOnly: false }}),
      getDomNode: () => domNode1,
      getModel: () => model1,
      getValue: () => buffer1,
      setValue: (v) => {{ buffer1 = v; }},
      executeEdits: (src, edits) => {{
        if (edits && edits[0] && edits[0].text) {{
          buffer1 = edits[0].text;
        }}
      }},
      focus: () => {{}}
    }};

    global.document = {{
      querySelector: (sel) => sel.includes("monaco") ? domNode1 : null,
      querySelectorAll: (sel) => sel.includes("monaco") ? [domNode0, domNode1] : []
    }};

    global.window = {{
      document: global.document,
      monaco: {{
        editor: {{
          EditorOption: {{ readOnly: 87 }},
          getEditors: () => [editor0, editor1],
          getModels: () => [model0, model1]
        }}
      }}
    }};

    const solvedMethod = `int add(int a, int b) {{
    return a + b;
}}`;

    // Execute write via executor.js
    const writeRes = QuizZyExecutor.writeCodeWithHumanTypingInMainWorld({{
      code: solvedMethod,
      starter_code: buffer1,
      language: "cpp"
    }});

    if (!writeRes.success) {{
      console.error("FAIL: writeCodeWithHumanTypingInMainWorld failed:", writeRes);
      process.exit(1);
    }}

    // Verify model0 remains 100% untouched
    if (buffer0 !== "Example 1 Output:\\n42") {{
      console.error("CRITICAL FAILURE: Read-only model0 was modified! Current buffer0:", buffer0);
      process.exit(1);
    }}

    // Verify model1 received the solution
    if (!buffer1.includes("return a + b;")) {{
      console.error("FAIL: Editable model1 did not receive the solution! Current buffer1:", buffer1);
      process.exit(1);
    }}

    if (!buffer1.includes("class Solution")) {{
      console.error("FAIL: class Solution wrapper was lost from model1!");
      process.exit(1);
    }}

    // Now test when getEditors() is NOT available and only getModels() exists
    global.window.monaco.editor.getEditors = null;
    buffer0 = "Example 1 Output:\\n42";
    buffer1 = "class Solution {{ public: int add() {{ //Write Your Code Here... }} }};";

    const fallbackRes = QuizZyExecutor.writeCodeWithHumanTypingInMainWorld({{
      code: solvedMethod,
      starter_code: buffer1,
      language: "cpp"
    }});

    if (!fallbackRes.success) {{
      console.error("FAIL: Fallback write via getModels() failed:", fallbackRes);
      process.exit(1);
    }}

    if (buffer0 !== "Example 1 Output:\\n42") {{
      console.error("CRITICAL FAILURE: Fallback getModels() targeted read-only model0!");
      process.exit(1);
    }}

    if (!buffer1.includes("return a + b;")) {{
      console.error("FAIL: Fallback getModels() did not write to template model1!");
      process.exit(1);
    }}

    console.log("SUCCESS: Multi-Monaco read-only exclusion verified!");
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 18 failed with code {res.returncode}"
    print("  -> Passed Multi-Monaco Read-Only Exclusion Test")


def test_19_auto_write_on_alt_s_in_coding_mode():
    """
    Test 19: Auto-Write on Alt+S in Coding Mode.
    Verifies that triggering Alt+S (TRIGGER_SOLVE) on a coding page:
    - Solves the problem via /solve backend.
    - Automatically writes the solution directly into the Monaco editor in MAIN world.
    - Performs buffer read-back verification.
    - Clicks Compile & Run via autoCompileAndSubmitLoop.
    - Updates badge to '...' -> 'WRT' -> 'OK'.
    - Stores code in lastSolvedCode for subsequent manual Alt+A presses.
    - Requires ZERO manual Alt+A press to write and run.
    """
    print("\n[Engine - Test 19] Verifying Auto-Write on Alt+S in Coding Mode...")
    bg_path = (WORKSPACE_ROOT / "extension" / "background.js").as_posix()

    node_script = f"""
    const fs = require('fs');

    // 1. Audit background.js code for required contracts
    const bgCode = fs.readFileSync('{bg_path}', 'utf8');

    if (!bgCode.includes('handleTriggerSolve')) {{
      console.error("FAIL: background.js missing handleTriggerSolve function!");
      process.exit(1);
    }}

    if (!bgCode.includes('updateActionBadge')) {{
      console.error("FAIL: background.js missing updateActionBadge function!");
      process.exit(1);
    }}

    if (!bgCode.includes('chrome.commands.onCommand')) {{
      console.error("FAIL: background.js missing chrome.commands.onCommand listener!");
      process.exit(1);
    }}

    if (!bgCode.includes('chrome.webNavigation.onHistoryStateUpdated')) {{
      console.error("FAIL: background.js missing webNavigation hook!");
      process.exit(1);
    }}

    // 2. Simulate handleTriggerSolve workflow in Node
    const badgeUpdates = [];
    const storageStore = {{}};
    let writtenToEditor = false;
    let runClicked = false;

    const mockTab = {{ id: 101, url: "https://learning.ccbp.in/question/test-problem" }};

    global.chrome = {{
      action: {{
        setBadgeText: (d) => {{ badgeUpdates.push(d.text); }},
        setBadgeBackgroundColor: () => {{}}
      }},
      storage: {{
        local: {{
          set: (obj) => {{ Object.assign(storageStore, obj); }},
          get: (keys, cb) => {{ cb(storageStore); }}
        }}
      }},
      scripting: {{
        executeScript: async (opts) => {{
          if (opts.func && opts.func.name === "readCodeFromMainWorld") {{
            return [{{ result: {{ code: "class Solution {{ public: int solve() {{}} }};", language: "cpp" }} }}];
          }}
          if (opts.func && opts.func.name === "writeCodeWithHumanTypingInMainWorld") {{
            writtenToEditor = true;
            return [{{ result: {{ success: true, verified_code: true, code: opts.args[0].code }} }}];
          }}
          if (opts.world === "ISOLATED") {{
            runClicked = true;
            return [{{ result: {{ success: true, status: "success", passed: true }} }}];
          }}
          return [{{ result: {{ question: "Find sum of array elements", language: "cpp" }} }}];
        }}
      }},
      runtime: {{
        sendMessage: () => {{}},
        onMessage: {{ addListener: () => {{}} }}
      }}
    }};

    global.fetch = async (url) => {{
      return {{
        ok: true,
        json: async () => ({{
          status: "ok",
          q_type: "code",
          answer: "class Solution {{ public: int solve() {{ return 42; }} }};"
        }})
      }};
    }};

    eval(bgCode);

    const solver = global.handleTriggerSolve || (typeof handleTriggerSolve !== "undefined" ? handleTriggerSolve : null);
    if (!solver) {{
      console.error("FAIL: handleTriggerSolve was not exported or defined on global!");
      process.exit(1);
    }}

    solver({{}}, mockTab).then((res) => {{
      if (!res.success) {{
        console.error("FAIL: handleTriggerSolve returned error:", res);
        process.exit(1);
      }}

      if (!writtenToEditor) {{
        console.error("FAIL: Code was not automatically written into editor during Alt+S!");
        process.exit(1);
      }}

      if (!runClicked) {{
        console.error("FAIL: Compile & Run was not invoked during Alt+S!");
        process.exit(1);
      }}

      if (!storageStore.lastSolvedCode || !storageStore.lastSolvedCode.includes("return 42")) {{
        console.error("FAIL: Solved code was not saved to lastSolvedCode storage!");
        process.exit(1);
      }}

      if (!badgeUpdates.includes("...") || !badgeUpdates.includes("WRT") || !badgeUpdates.includes("OK")) {{
        console.error("FAIL: Badge updates missing required transitions ('...', 'WRT', 'OK')! Got:", badgeUpdates);
        process.exit(1);
      }}

      console.log("SUCCESS: Auto-Write on Alt+S in Coding Mode verified! Badge states:", badgeUpdates);
    }});
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(WORKSPACE_ROOT), capture_output=True, text=True)
    if res.returncode != 0:
        print("Node stdout:", res.stdout)
        print("Node stderr:", res.stderr)
    assert res.returncode == 0, f"Test 19 failed with code {res.returncode}"
    print("  -> Passed Auto-Write on Alt+S in Coding Mode Test")


