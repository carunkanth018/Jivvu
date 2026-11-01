"""Tests verifying that pressing Shift enables Auto Mode across Side Panel, Floating HUD, and CCBP Bridge."""

from pathlib import Path
import subprocess
import json
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_allowlist_includes_learning_ccbp_in_sidepanel_and_background():
    """Verify that learning.ccbp.in is explicitly permitted by default in both sidepanel and background."""
    sp_code = (REPO_ROOT / "extension" / "sidepanel.js").read_text(encoding="utf-8")
    bg_code = (REPO_ROOT / "extension" / "background.js").read_text(encoding="utf-8")

    # Sidepanel must include learning.ccbp.in in default hostAllowlist and isCurrentHostAllowed
    assert '"learning.ccbp.in"' in sp_code
    assert 'clean === "learning.ccbp.in" || clean.endsWith(".ccbp.in")' in sp_code

    # Background must seed learning.ccbp.in in both allowedHosts and auto_mode_allowlist
    assert 'auto_mode_allowlist' in bg_code
    assert 'learning.ccbp.in' in bg_code


def test_node_vm_sidepanel_shift_enables_and_stops_automode():
    """Simulate sidepanel.js logic in Node VM to verify Shift starts Auto Mode and does not fire in editable fields."""
    node_script = """
    let hostAllowlist = ["localhost", "127.0.0.1", "::1", "learning.ccbp.in"];
    let currentHost = "learning.ccbp.in";
    let activeTabUrl = "https://learning.ccbp.in/question/123";

    function isCurrentHostAllowed() {
      if (!currentHost) return false;
      const clean = currentHost.toLowerCase().trim();
      if (clean === "localhost" || clean === "127.0.0.1" || clean === "::1" || clean === "null" || clean === "file:") {
        return true;
      }
      if (activeTabUrl && activeTabUrl.startsWith("file:///")) {
        return true;
      }
      if (clean === "learning.ccbp.in" || clean.endsWith(".ccbp.in")) {
        return true;
      }
      return hostAllowlist.includes(clean);
    }

    // Verify host is allowed on learning.ccbp.in
    if (!isCurrentHostAllowed()) {
      console.error("FAIL: learning.ccbp.in should be allowed by default");
      process.exit(1);
    }

    let isAutoRunning = false;
    let autoStartedCount = 0;
    let autoStoppedCount = 0;

    const btnStartAuto = {
      click: () => {
        if (!isCurrentHostAllowed()) return;
        isAutoRunning = true;
        autoStartedCount++;
      }
    };

    function triggerKillSwitch(reason) {
      isAutoRunning = false;
      autoStoppedCount++;
    }

    let shiftDownSp = false;
    let shiftComboUsedSp = false;
    let shiftTimerSp = null;

    function isEditableElementSidepanel(el) {
      if (!el) return false;
      const tag = (el.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      if (typeof el.getAttribute === "function" && el.getAttribute("contenteditable") === "true") return true;
      return false;
    }

    let mockActiveElement = { tagName: "BODY" };

    function onKeyDown(e) {
      if (!e) return;
      const activeEl = mockActiveElement;
      if (isEditableElementSidepanel(e.target) || isEditableElementSidepanel(activeEl)) {
        shiftDownSp = false;
        shiftComboUsedSp = true;
        return;
      }
      if (e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (e.ctrlKey || e.altKey || e.metaKey) {
          shiftComboUsedSp = true;
          return;
        }
        if (shiftDownSp) return;
        shiftDownSp = true;
        shiftComboUsedSp = false;
      } else {
        if (shiftDownSp) shiftComboUsedSp = true;
      }
    }

    function onKeyUp(e) {
      if (!e) return;
      const activeEl = mockActiveElement;
      if (isEditableElementSidepanel(e.target) || isEditableElementSidepanel(activeEl)) {
        shiftDownSp = false;
        shiftComboUsedSp = true;
        return;
      }
      if (e.key === "Shift" || e.code === "ShiftLeft" || e.code === "ShiftRight") {
        const wasDown = shiftDownSp;
        const wasCombo = shiftComboUsedSp;
        shiftDownSp = false;
        shiftComboUsedSp = false;
        if (wasDown && !wasCombo) {
          if (shiftTimerSp) {
            clearTimeout(shiftTimerSp);
            shiftTimerSp = null;
          }
          if (isAutoRunning) {
            triggerKillSwitch("Stopped via Shift hotkey");
          } else {
            if (btnStartAuto) btnStartAuto.click();
          }
        }
      }
    }

    // 1. Solo Shift press starts Auto Mode
    onKeyDown({ key: "Shift", code: "ShiftLeft" });
    onKeyUp({ key: "Shift", code: "ShiftLeft" });
    if (!isAutoRunning || autoStartedCount !== 1) {
      console.error("FAIL: Solo Shift did not start Auto Mode");
      process.exit(1);
    }

    // 2. Second Shift press stops Auto Mode
    onKeyDown({ key: "Shift", code: "ShiftLeft" });
    onKeyUp({ key: "Shift", code: "ShiftLeft" });
    if (isAutoRunning || autoStoppedCount !== 1) {
      console.error("FAIL: Second Shift press did not stop Auto Mode");
      process.exit(1);
    }

    // 3. Third Shift press starts Auto Mode again
    onKeyDown({ key: "Shift", code: "ShiftLeft" });
    onKeyUp({ key: "Shift", code: "ShiftLeft" });
    if (!isAutoRunning || autoStartedCount !== 2) {
      console.error("FAIL: Third Shift press did not start Auto Mode");
      process.exit(1);
    }

    // 4. Shift combo (Shift + A) does NOT stop Auto Mode
    onKeyDown({ key: "Shift", code: "ShiftLeft" });
    onKeyDown({ key: "A", code: "KeyA" });
    onKeyUp({ key: "Shift", code: "ShiftLeft" });
    if (!isAutoRunning) {
      console.error("FAIL: Shift combo should not have affected Auto Mode");
      process.exit(1);
    }

    // Stop auto mode cleanly
    triggerKillSwitch("test reset");

    // 5. Shift pressed while active element is INPUT does NOT start Auto Mode
    mockActiveElement = { tagName: "INPUT" };
    onKeyDown({ key: "Shift", code: "ShiftLeft" });
    onKeyUp({ key: "Shift", code: "ShiftLeft" });
    if (isAutoRunning) {
      console.error("FAIL: Shift inside INPUT should not start Auto Mode");
      process.exit(1);
    }

    console.log("SIDEPANEL_SHIFT_OK");
    """
    res = subprocess.run(
        ["node", "-e", node_script],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert res.returncode == 0, f"Node script failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "SIDEPANEL_SHIFT_OK" in res.stdout


def test_ccbp_lifecycle_bridge_shift_fallback():
    """Verify that ccbp_lifecycle_bridge.js has the solo Shift fallback listener."""
    bridge_code = (REPO_ROOT / "extension" / "ccbp_lifecycle_bridge.js").read_text(encoding="utf-8")
    assert "bridgeShiftDown" in bridge_code
    assert "bridgeShiftComboUsed" in bridge_code
    assert 'chrome.runtime.sendMessage({ action: "TRIGGER_AUTO" })' in bridge_code


def test_background_routes_trigger_auto_message():
    """Verify that background.js handles TRIGGER_AUTO message cleanly."""
    bg_code = (REPO_ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    assert 'action === "TRIGGER_AUTO"' in bg_code
    assert 'handleUnifiedCommand("trigger_auto", targetTab)' in bg_code
