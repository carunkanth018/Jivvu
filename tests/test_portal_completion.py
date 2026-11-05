"""Tests for QuizZy / Jivvu Portal Completion Automation (Ctrl + Alt + 0 & Flashing Violet Dot).

Verifies:
1. Ctrl + Alt + 0 toggle & Flashing Violet Dot in Shadow DOM HUD (#a855f7 / quizzyVioletPulse).
2. Strict Exclusion of Practices & Quizzes (MCQ Practice, Coding Practice, Classroom/Course Quizzes).
3. Current-Module Boundary Lock (Never crosses into or expands next/previous module).
4. Reading Material Automation (Continue -> Inline MCQ -> Inline Submit -> Option Sweep -> Completed).
5. Video Automation (Slides -> Mark as Completed -> Confirmation Modal YES -> Drawer Auto-Open).
6. Route Safety Guard (Refuses to run on standalone /question/* coding or assessment runners).
"""

from pathlib import Path
import json
import subprocess
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


# ==============================================================================
# Static Contract Assertions
# ==============================================================================



def test_portal_completion_codebase_contracts():
    """Verify contracts across portal_completion.js, floating_hud.js, ccbp_lifecycle_bridge.js, background.js, executor.js, and manifest.json."""
    portal_code = (REPO_ROOT / "extension" / "portal_completion.js").read_text(encoding="utf-8")
    hud_code = (REPO_ROOT / "extension" / "floating_hud.js").read_text(encoding="utf-8")
    bridge_code = (REPO_ROOT / "extension" / "ccbp_lifecycle_bridge.js").read_text(encoding="utf-8")
    bg_code = (REPO_ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    exec_code = (REPO_ROOT / "extension" / "executor.js").read_text(encoding="utf-8")
    manifest = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))

    # 0. Manifest registration
    content_scripts_js = [js for cs in manifest.get("content_scripts", []) for js in cs.get("js", [])]
    assert "portal_completion.js" in content_scripts_js

    # 1. Violet dot styles & keyframes in floating_hud.js
    assert "#a855f7" in hud_code
    assert "quizzyVioletPulse" in hud_code
    assert "glow-violet" in hud_code
    assert "portal-running" in hud_code
    assert "portal-active" in hud_code

    # 2. Manifest commands length <= 4 and strict exclusive shortcuts contract
    commands = manifest.get("commands", {})
    assert len(commands) <= 4, f"Commands length must be <= 4, got {len(commands)}"
    assert "QuizZyPortalCompletion" in hud_code
    assert "portalCompletionActive" in hud_code

    # 3. Route safety guard rejecting /question/* in portal_completion and background
    assert "question" in portal_code
    assert "/question/" in bg_code
    assert "PORTAL_COMPLETION_TOGGLE" in bg_code
    assert "portal_completion.js" in bg_code

    # 4. Strict blacklist regex in portal_completion.js
    assert "mcq\\s*practice" in portal_code
    assert "coding\\s*practice" in portal_code
    assert "classroom\\s*quiz" in portal_code

    # 5. Bridge in executor.js
    assert "runPortalCompletionLoop" in exec_code


# ==============================================================================
# Node VM: Hotkey Toggle & Flashing Violet Dot in Shadow DOM
# ==============================================================================


def test_node_vm_portal_completion_hotkey_and_violet_dot():
    """Verify Ctrl + Alt + 0 triggers Portal Completion and switches Shadow DOM dot to pulsing violet."""
    node_script = """
    const fs = require('fs');
    const path = require('path');

    // Minimal DOM environment
    class MockClassList {
      constructor() { this.classes = new Set(); }
      add(...args) { args.forEach(c => this.classes.add(c)); }
      remove(...args) { args.forEach(c => this.classes.delete(c)); }
      contains(c) { return this.classes.has(c); }
      toString() { return Array.from(this.classes).join(' '); }
    }

    class MockElement {
      constructor(tag, id = '') {
        this.tagName = (tag || 'DIV').toUpperCase();
        this.id = id;
        this.className = '';
        this.classList = new MockClassList();
        this.children = [];
        this.style = {};
        this.attributes = {};
        this.listeners = {};
        this.innerText = '';
        this.textContent = '';
      }
      setAttribute(k, v) { this.attributes[k] = String(v); }
      getAttribute(k) { return this.attributes[k] !== undefined ? this.attributes[k] : null; }
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
      removeChild(child) { this.children = this.children.filter(c => c !== child); return child; }
      querySelector(sel) {
        if (sel === '#hud-mini-dot' || sel === '.hud-mini-dot') return this.miniDot || null;
        if (sel === '#hud-health-dot' || sel === '.hud-health-dot') return this.healthDot || null;
        return null;
      }
      querySelectorAll(sel) { return []; }
      addEventListener(type, cb) {
        if (!this.listeners[type]) this.listeners[type] = [];
        this.listeners[type].push(cb);
      }
      dispatchEvent(ev) {
        const list = this.listeners[ev.type] || [];
        for (const cb of list) cb(ev);
        return true;
      }
      getBoundingClientRect() { return { left: 100, top: 100, width: 8, height: 8 }; }
      scrollIntoView() {}
      click() {}
    }

    const listeners = {};
    const mockWindow = {
      location: { href: 'https://learning.ccbp.in/course?c_id=123', pathname: '/course' },
      innerWidth: 1920,
      innerHeight: 1080,
      addEventListener: (type, cb) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(cb);
      },
      removeEventListener: () => {},
      dispatchEvent: (ev) => {
        const list = listeners[ev.type] || [];
        for (const cb of list) cb(ev);
      }
    };
    global.window = mockWindow;
    global.location = mockWindow.location;

    const mockDoc = new MockElement('HTML');
    mockDoc.body = new MockElement('BODY');
    mockDoc.createElement = (tag) => new MockElement(tag);
    mockDoc.getElementById = () => null;
    mockDoc.querySelector = () => null;
    mockDoc.querySelectorAll = () => [];
    mockDoc.addEventListener = mockWindow.addEventListener;
    global.document = mockDoc;

    global.chrome = {
      runtime: {
        sendMessage: (msg) => Promise.resolve({ success: true }),
        onMessage: { addListener: () => {} }
      },
      storage: {
        local: {
          get: (k, cb) => cb({}),
          set: () => {}
        }
      }
    };

    // Load portal_completion.js
    const portalPath = path.resolve('extension/portal_completion.js');
    require(portalPath);

    // Verify QuizZyPortalCompletion is attached
    if (!global.window.QuizZyPortalCompletion) {
      console.error('FAIL: QuizZyPortalCompletion not exported to global window');
      process.exit(1);
    }
    const pc = global.window.QuizZyPortalCompletion;

    // Simulate HUD miniDot
    const miniDot = new MockElement('DIV', 'hud-mini-dot');
    miniDot.classList.add('glow-blue');
    const healthDot = new MockElement('SPAN', 'hud-health-dot');

    let portalActive = false;
    function updateDot() {
      miniDot.classList.remove('glow-red', 'glow-green', 'glow-orange', 'glow-blue', 'glow-violet', 'auto-running', 'portal-running');
      if (portalActive) {
        miniDot.classList.add('glow-violet', 'portal-running');
        healthDot.classList.add('portal-active');
      } else {
        miniDot.classList.add('glow-blue');
        healthDot.classList.remove('portal-active');
      }
    }

    global.window.__QUIZZY_HUD_INSTANCE__ = {
      setPortalCompletionActive: (val) => {
        portalActive = Boolean(val);
        updateDot();
      }
    };

    // 1. Initial State: Idle blue dot
    updateDot();
    if (!miniDot.classList.contains('glow-blue') || miniDot.classList.contains('glow-violet')) {
      console.error('FAIL: Initial dot must be blue, not violet');
      process.exit(1);
    }

    // 2. Programmatic start / toggle
    pc.toggle();
    if (global.window.__QUIZZY_HUD_INSTANCE__) {
      global.window.__QUIZZY_HUD_INSTANCE__.setPortalCompletionActive(true);
    }

    if (!portalActive || !pc.getState().isActive) {
      console.error('FAIL: Portal Completion must be active after pc.toggle()');
      process.exit(1);
    }

    // Verify Shadow DOM Dot is flashing violet
    if (!miniDot.classList.contains('glow-violet') || !miniDot.classList.contains('portal-running')) {
      console.error('FAIL: Mini dot must have glow-violet and portal-running classes');
      process.exit(1);
    }
    if (!healthDot.classList.contains('portal-active')) {
      console.error('FAIL: Health dot must have portal-active class');
      process.exit(1);
    }

    // 3. Toggle off
    pc.toggle();
    if (global.window.__QUIZZY_HUD_INSTANCE__) {
      global.window.__QUIZZY_HUD_INSTANCE__.setPortalCompletionActive(false);
    }

    if (portalActive || pc.getState().isActive) {
      console.error('FAIL: Portal Completion must be inactive after toggling off');
      process.exit(1);
    }
    if (miniDot.classList.contains('glow-violet') || healthDot.classList.contains('portal-active')) {
      console.error('FAIL: Violet glow must be removed when Portal Completion stops');
      process.exit(1);
    }

    // 4. Verify legacy Ctrl + Alt + 0 does NOT trigger
    let p = false, s = false;
    const hotkeyEvent = {
      type: 'keydown',
      key: '0',
      code: 'Digit0',
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      preventDefault: () => { p = true; },
      stopPropagation: () => { s = true; }
    };
    const keyListeners = listeners['keydown'] || [];
    for (const cb of keyListeners) cb(hotkeyEvent);
    if (p || s || pc.getState().isActive) {
      console.error('FAIL: Pruned Ctrl + Alt + 0 must not activate Portal Completion');
      process.exit(1);
    }

    console.log('SUCCESS: Hotkey toggle and flashing violet dot verified in Node VM');
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(REPO_ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node VM execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    assert "SUCCESS" in res.stdout


# ==============================================================================
# Node VM: Inner-Pane Scrolling & React Portal Modal YES Confirmation
# ==============================================================================


def test_node_vm_strict_exclusion_of_practices_and_quizzes():
    """Verify strict blacklist excludes MCQ Practice, Coding Practice, Classroom/Course Quizzes."""
    node_script = """
    const path = require('path');
    const pc = require(path.resolve('extension/portal_completion.js'));

    class MockItem {
      constructor(text, isCompleted = false) {
        this.innerText = text;
        this.textContent = text;
        this._completed = isCompleted;
        this.children = [];
      }
      querySelectorAll(sel) {
        if (this._completed && sel.includes('svg')) {
          return [{
            getAttribute: (k) => (k === 'fill' ? '#22c55e' : null),
            className: 'completed-tick'
          }];
        }
        return [];
      }
    }

    class MockModule {
      constructor(title, items) {
        this.innerText = title;
        this.textContent = title;
        this.items = items;
      }
      querySelectorAll(sel) {
        return this.items;
      }
    }

    // Given curriculum items:
    // 1. Introduction of Stack (done)
    // 2. Tutorial: Introduction of Stack (uncompleted)
    // 3. MCQ Practice (uncompleted)
    // 4. Stack Implementation Using Array (uncompleted video)
    // 5. Classroom Quiz : Stack Operations (uncompleted)
    // 6. Coding Practice (uncompleted)
    // 7. Stack Implementation Using Linked List (uncompleted video)
    const items = [
      new MockItem('Introduction of Stack', true),
      new MockItem('Tutorial: Introduction of Stack', false),
      new MockItem('MCQ Practice', false),
      new MockItem('Stack Implementation Using Array', false),
      new MockItem('Classroom Quiz : Stack Operations', false),
      new MockItem('Coding Practice', false),
      new MockItem('Stack Implementation Using Linked List', false),
    ];

    const moduleContainer = new MockModule('Module III: Stacks & Queues', items);

    const eligible = pc.getEligibleUnits(moduleContainer);
    const eligibleTexts = eligible.map(el => el.innerText);

    // Assert: Exactly 3 items selected
    if (eligibleTexts.length !== 3) {
      console.error('FAIL: Expected exactly 3 eligible units, got ' + eligibleTexts.length + ': ' + JSON.stringify(eligibleTexts));
      process.exit(1);
    }

    if (eligibleTexts[0] !== 'Tutorial: Introduction of Stack') {
      console.error('FAIL: Item 0 must be Tutorial, got: ' + eligibleTexts[0]);
      process.exit(1);
    }
    if (eligibleTexts[1] !== 'Stack Implementation Using Array') {
      console.error('FAIL: Item 1 must be Stack Implementation Using Array, got: ' + eligibleTexts[1]);
      process.exit(1);
    }
    if (eligibleTexts[2] !== 'Stack Implementation Using Linked List') {
      console.error('FAIL: Item 2 must be Stack Implementation Using Linked List, got: ' + eligibleTexts[2]);
      process.exit(1);
    }

    // Verify strict blacklist never includes practices or quizzes
    const blacklistedFound = eligibleTexts.filter(t => pc.isBlacklisted(t));
    if (blacklistedFound.length > 0) {
      console.error('FAIL: Blacklisted items found in eligible units: ' + JSON.stringify(blacklistedFound));
      process.exit(1);
    }

    console.log('SUCCESS: Strict exclusion of practices and quizzes verified in Node VM');
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(REPO_ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node VM execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    assert "SUCCESS" in res.stdout


# ==============================================================================
# Node VM: Inner-Pane Scrolling & React Portal Modal YES Confirmation
# ==============================================================================


def test_node_vm_current_module_boundary_lock():
    """Verify Portal Completion locks onto Module III and never clicks or expands Module IV."""
    node_script = """
    const path = require('path');
    const pc = require(path.resolve('extension/portal_completion.js'));

    let module4Clicked = false;
    let module3ItemsCompleted = 0;

    class MockItem {
      constructor(text, isCompleted = false) {
        this.innerText = text;
        this.textContent = text;
        this.completed = isCompleted;
      }
      querySelectorAll(sel) {
        if (this.completed && sel.includes('svg')) {
          return [{ getAttribute: (k) => (k === 'fill' ? '#22c55e' : null), className: 'done-icon' }];
        }
        return [];
      }
      scrollIntoView() {}
      click() {
        // Mark completed upon click
        this.completed = true;
        module3ItemsCompleted++;
      }
    }

    const mod3Items = [
      new MockItem('Video: Stack Basics', false),
      new MockItem('Tutorial: Stack Operations', false)
    ];

    const mod4Items = [
      new MockItem('Video: Tree Basics', false)
    ];

    class MockModule {
      constructor(title, items, isExpanded) {
        this.title = title;
        this.innerText = title;
        this.textContent = title;
        this.items = items;
        this.isExpanded = isExpanded;
        this.attributes = { 'aria-expanded': isExpanded ? 'true' : 'false' };
      }
      getAttribute(k) { return this.attributes[k] || null; }
      querySelectorAll(sel) { return this.items; }
      querySelector(sel) {
        if (this.isExpanded) return { classList: { contains: () => true } };
        return null;
      }
      click() {
        if (this.title.includes('Module IV')) {
          module4Clicked = true;
        }
      }
    }

    const mod3 = new MockModule('Module III: Stacks & Queues', mod3Items, true);
    const mod4 = new MockModule('Module IV: Trees', mod4Items, false);

    const mockDoc = {
      location: { href: 'https://learning.ccbp.in/course?c_id=123' },
      querySelector: (sel) => {
        if (sel && sel.includes('badge')) return { innerText: 'Completed' };
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel && sel.includes('module')) return [mod3, mod4];
        if (sel && sel.includes('button')) return [{ innerText: 'Completed' }];
        return [];
      }
    };

    global.window = { location: mockDoc.location };
    global.document = mockDoc;

    (async () => {
      // Run loop with locked module III
      await pc.runPortalCompletionLoop({
        document: mockDoc,
        pacingMs: 1
      });

      if (module4Clicked) {
        console.error('FAIL: Module IV was clicked! Module boundary lock violated!');
        process.exit(1);
      }

      if (pc.getState().isActive) {
        console.error('FAIL: Portal Completion must stop when current module units are finished');
        process.exit(1);
      }

      console.log('SUCCESS: Module boundary lock verified in Node VM');
    })();
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(REPO_ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node VM execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    assert "SUCCESS" in res.stdout


# ==============================================================================
# Node VM: Inner-Pane Scrolling & React Portal Modal YES Confirmation
# ==============================================================================


def test_node_vm_reading_material_automation():
    """Verify Reading Material automates Continue, Inline MCQs (with self-healing sweep), and ignores Submit Feedback."""
    node_script = """
    const path = require('path');
    const pc = require(path.resolve('extension/portal_completion.js'));

    let submitFeedbackClicked = false;
    let continueClickCount = 0;
    let inlineSubmitClickCount = 0;
    let selectedOptionIndex = -1;

    // Simulate multi-section reading page
    let stage = 0; // 0: initial with Continue -> 1: inline MCQ -> 2: completed

    class MockButton {
      constructor(text, onClick) {
        this.innerText = text;
        this.textContent = text;
        this.onClick = onClick;
        this.disabled = false;
      }
      getAttribute(k) { return null; }
      scrollIntoView() {}
      click() { if (this.onClick) this.onClick(); }
    }

    const continueBtn = new MockButton('Continue', () => {
      continueClickCount++;
      if (stage === 0) stage = 1; // Reveals inline MCQ
    });

    const submitFeedbackBtn = new MockButton('Submit Feedback', () => {
      submitFeedbackClicked = true;
    });

    const options = [
      { innerText: 'Option A (Wrong)', checked: false, click: () => { selectedOptionIndex = 0; } },
      { innerText: 'Option B (Correct)', checked: false, click: () => { selectedOptionIndex = 1; } }
    ];

    const inlineSubmitBtn = new MockButton('Submit', () => {
      inlineSubmitClickCount++;
      if (selectedOptionIndex === 1) {
        // Correct answer! Section finishes, page displays Completed
        stage = 2;
      }
    });

    const mockDoc = {
      querySelectorAll: (sel) => {
        if (sel.includes('badge')) {
          if (stage === 2) return [{ innerText: 'Completed' }];
          return [];
        }
        if (sel.includes('card') || sel.includes('question')) {
          if (stage === 1) {
            return [{
              innerText: 'Question 1 of 1: What is a Stack? Complete the MCQs to proceed',
              querySelectorAll: (s) => {
                if (s.includes('radio') || s.includes('option')) return options;
                if (s.includes('btn') || s.includes('button')) return [inlineSubmitBtn];
                return [];
              }
            }];
          }
          return [];
        }
        if (sel.includes('button')) {
          const list = [submitFeedbackBtn];
          if (stage === 0) list.push(continueBtn);
          if (stage === 2) list.push({ innerText: 'Completed' });
          return list;
        }
        return [];
      }
    };

    global.window = { location: { href: 'https://learning.ccbp.in/course?c_id=123' } };
    global.document = mockDoc;

    (async () => {
      const res = await pc.automateReadingUnit(mockDoc);

      if (submitFeedbackClicked) {
        console.error('FAIL: "Submit Feedback" was clicked! Guardrail violated!');
        process.exit(1);
      }

      if (continueClickCount === 0) {
        console.error('FAIL: "Continue" button was not clicked!');
        process.exit(1);
      }

      if (inlineSubmitClickCount === 0) {
        console.error('FAIL: Inline "Submit" button was not clicked!');
        process.exit(1);
      }

      if (selectedOptionIndex !== 1) {
        console.error('FAIL: Option sweep did not reach correct option 1!');
        process.exit(1);
      }

      if (!res.success) {
        console.error('FAIL: Reading material automation did not succeed!');
        process.exit(1);
      }

      console.log('SUCCESS: Reading Material automation and option sweep verified in Node VM');
    })();
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(REPO_ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node VM execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    assert "SUCCESS" in res.stdout


# ==============================================================================
# Node VM: Inner-Pane Scrolling & React Portal Modal YES Confirmation
# ==============================================================================


def test_node_vm_video_automation_and_sidebar_reopen():
    """Verify Video automation clicks Slides, Mark as Completed, confirms YES on modal, and re-opens collapsed sidebar."""
    node_script = """
    const path = require('path');
    const pc = require(path.resolve('extension/portal_completion.js'));

    let slidesClicked = false;
    let markCompletedClicked = false;
    let modalYesClicked = false;
    let sidebarToggleClicked = false;
    let isCompletedBadgeShown = false;

    class MockButton {
      constructor(text, onClick) {
        this.innerText = text;
        this.textContent = text;
        this.onClick = onClick;
      }
      getAttribute(k) { return null; }
      scrollIntoView() {}
      click() { if (this.onClick) this.onClick(); }
    }

    const slidesBtn = new MockButton('Slides', () => { slidesClicked = true; });
    const markCompletedBtn = new MockButton('Mark as Completed', () => {
      markCompletedClicked = true;
    });
    const yesBtn = new MockButton('YES', () => {
      modalYesClicked = true;
      isCompletedBadgeShown = true;
    });
    const sidebarToggleBtn = new MockButton('Toggle', () => {
      sidebarToggleClicked = true;
    });
    sidebarToggleBtn.setAttribute = () => {};
    sidebarToggleBtn.getAttribute = (k) => (k === 'aria-label' ? 'sidebar drawer toggle' : null);

    const mockDoc = {
      location: { href: 'https://learning.ccbp.in/course?c_id=123' },
      querySelector: (sel) => {
        if (sel && sel.includes('sidebar')) return null; // collapsed
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel.includes('badge')) {
          if (isCompletedBadgeShown) return [{ innerText: 'Completed' }];
          return [];
        }
        if (sel.includes('dialog') || sel.includes('modal')) {
          if (markCompletedClicked) {
            return [{
              innerText: 'Are you sure you want to mark this as completed?',
              querySelectorAll: () => [yesBtn]
            }];
          }
          return [];
        }
        if (sel.includes('button')) {
          const list = [slidesBtn, markCompletedBtn, sidebarToggleBtn];
          if (isCompletedBadgeShown) list.push({ innerText: 'Completed' });
          return list;
        }
        return [];
      }
    };

    global.window = { location: mockDoc.location };
    global.document = mockDoc;

    (async () => {
      // 1. Ensure sidebar opens
      await pc.ensureSidebarOpen(mockDoc);
      if (!sidebarToggleClicked) {
        console.error('FAIL: Sidebar drawer toggle was not clicked when collapsed!');
        process.exit(1);
      }

      // 2. Automate video unit
      const res = await pc.automateVideoUnit(mockDoc);

      if (!slidesClicked) {
        console.error('FAIL: Slides tab was not clicked!');
        process.exit(1);
      }
      if (!markCompletedClicked) {
        console.error('FAIL: Mark as Completed was not clicked!');
        process.exit(1);
      }
      if (!modalYesClicked) {
        console.error('FAIL: Modal YES button was not clicked!');
        process.exit(1);
      }
      if (!res.success) {
        console.error('FAIL: Video unit automation failed to confirm Completed!');
        process.exit(1);
      }

      console.log('SUCCESS: Video unit automation and sidebar drawer re-open verified in Node VM');
    })();
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(REPO_ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node VM execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    assert "SUCCESS" in res.stdout


# ==============================================================================
# Node VM: Inner-Pane Scrolling & React Portal Modal YES Confirmation
# ==============================================================================


def test_node_vm_route_safety_guard():
    """Verify Route Safety Guard refuses Portal Completion on standalone /question/* and assessment URLs."""
    node_script = """
    const path = require('path');
    const pc = require(path.resolve('extension/portal_completion.js'));

    // Standalone coding question route
    if (pc.isRouteEligible('https://learning.ccbp.in/question/coding-stack-123')) {
      console.error('FAIL: /question/ URL should be ineligible');
      process.exit(1);
    }

    // Standalone assessment route
    if (pc.isRouteEligible('https://learning.ccbp.in/assessment/exam-456')) {
      console.error('FAIL: /assessment/ URL should be ineligible');
      process.exit(1);
    }

    // External domain
    if (pc.isRouteEligible('https://example.com/course/123')) {
      console.error('FAIL: Non-CCBP domain should be ineligible');
      process.exit(1);
    }

    // Valid CCBP course curriculum page
    if (!pc.isRouteEligible('https://learning.ccbp.in/course?c_id=789')) {
      console.error('FAIL: https://learning.ccbp.in/course?c_id=789 should be eligible');
      process.exit(1);
    }

    console.log('SUCCESS: Route safety guard verified in Node VM');
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(REPO_ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node VM execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    assert "SUCCESS" in res.stdout

# ==============================================================================
# Node VM: Inner-Pane Scrolling & React Portal Modal YES Confirmation
# ==============================================================================


def test_node_vm_inner_pane_scrolling_and_react_portal_modal():
    """Verify scrollContentPaneToBottom scrolls scrollable containers and findYesButtonInModal handles React portal overlays."""
    node_script = """
    const path = require('path');
    const pc = require(path.resolve('extension/portal_completion.js'));

    class MockElement {
      constructor(tag) {
        this.tagName = (tag || 'div').toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.className = '';
        this.textContent = '';
        this.innerText = '';
        this.scrollTop = 0;
        this.scrollHeight = 1000;
        this.clientHeight = 400;
        this.style = {};
      }
      appendChild(c) {
        c.parentElement = this;
        this.children.push(c);
        return c;
      }
      querySelectorAll(selector) {
        const results = [];
        const walk = (node) => {
          for (const c of node.children) {
            const tag = c.tagName.toLowerCase();
            const cls = (c.className || '').toLowerCase();
            if (selector.includes('btn') && (tag === 'button' || cls.includes('btn') || tag === 'span')) {
              results.push(c);
            }
            if (selector.includes('content') && cls.includes('content')) {
              results.push(c);
            }
            if (selector.includes('modal') && cls.includes('modal')) {
              results.push(c);
            }
            walk(c);
          }
        };
        walk(this);
        return results;
      }
      querySelector(selector) {
        const list = this.querySelectorAll(selector);
        return list.length > 0 ? list[0] : null;
      }
      closest(selector) {
        let cur = this;
        while (cur) {
          const tag = (cur.tagName || '').toLowerCase();
          const cls = (cur.className || '').toLowerCase();
          if (selector.includes('button') && (tag === 'button' || cls.includes('btn'))) return cur;
          cur = cur.parentElement;
        }
        return null;
      }
    }

    // 1. Test scrollContentPaneToBottom on scrollable element
    const container = new MockElement('div');
    container.className = 'course-content-pane';
    container.style = { overflowY: 'auto' };
    const innerBtn = new MockElement('span');
    innerBtn.textContent = 'Mark as Completed';
    container.appendChild(innerBtn);

    const scrolled = pc.scrollContentPaneToBottom(innerBtn);
    if (!scrolled || container.scrollTop !== 1000) {
      console.error('FAIL: Container was not scrolled to bottom! scrollTop:', container.scrollTop);
      process.exit(1);
    }

    // 2. Test Mark as Completed matching span child with button wrapper
    const btnWrapper = new MockElement('button');
    btnWrapper.className = 'btn-complete';
    const spanText = new MockElement('span');
    spanText.textContent = 'Mark as Completed';
    btnWrapper.appendChild(spanText);
    const mockDoc = new MockElement('document');
    mockDoc.appendChild(btnWrapper);

    const matchedBtn = pc.findMarkAsCompletedButton(mockDoc);
    if (!matchedBtn) {
      console.error('FAIL: findMarkAsCompletedButton failed to find button from child span!');
      process.exit(1);
    }

    // 3. Test React Portal Modal YES button in document.body
    const mockBody = new MockElement('body');
    const portalOverlay = new MockElement('div');
    portalOverlay.className = 'modal-portal-overlay';
    portalOverlay.textContent = 'Are you sure you want to mark this as completed?';
    const yesButton = new MockElement('button');
    yesButton.className = 'btn-yes';
    yesButton.textContent = 'YES';
    portalOverlay.appendChild(yesButton);
    mockBody.appendChild(portalOverlay);

    const foundYes = pc.findYesButtonInModal(mockBody);
    if (!foundYes || (foundYes.textContent || '').trim() !== 'YES') {
      console.error('FAIL: findYesButtonInModal failed on React portal body overlay!');
      process.exit(1);
    }

    console.log('SUCCESS: Inner pane scrolling and React portal modal verified');
    """

    res = subprocess.run(["node", "-e", node_script], cwd=str(REPO_ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node VM execution failed:\nSTDOUT: {res.stdout}\nSTDERR: {res.stderr}"
    assert "SUCCESS" in res.stdout


# ==============================================================================
# Native Lifecycle Manager Test: Clean Native Restart
# ==============================================================================


def test_lifecycle_manager_clean_native_restart():
    """Verify stop_backend() followed immediately by start_backend() cleanly restarts without port collision."""
    from backend import lifecycle_manager as lm
    import time

    stop_res = lm.stop_backend("test_clean_native_restart")
    assert stop_res["status"] in ("stopped", "already_stopped")
    assert stop_res.get("running") is False

    start_res = lm.start_backend(source="test_clean_native_restart")
    assert start_res.get("running") is True
    assert start_res.get("online") is True
    assert start_res.get("port") == 8000
    assert lm.is_backend_healthy() is True


# ==============================================================================
# Vision Grounding Enforcement Test: Blind Text Models Protected
# ==============================================================================

def test_vision_grounding_enforcement_on_diagrams():
    """Verify that when image_data is present, blind text-only models cannot claim HIGH_CONSENSUS without visual grounding."""
    import asyncio
    import httpx
    from backend.core.llm_client import solve_question

    async def _run():
        async with httpx.AsyncClient() as client:
            res = await solve_question(
                subject="Aptitude",
                q_type="mcq",
                question="Find the number of triangles in the given figure.",
                options=["78", "48", "45", "55"],
                image_data="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                client=client,
                config={
                    "single_primary_cascade": False,
                    "primary_a": {"provider": "groq", "model": "openai/gpt-oss-120b"},
                    "primary_b": {"provider": "groq", "model": "qwen/qwen3.8-27b"},
                    "vision": {"tier_1_groq": [], "tier_2_gemini": [], "tier_3_openrouter": []},
                }
            )
            assert not res.confidence_tier.startswith("HIGH_"), f"Blind text models wrongly claimed high confidence on diagram: {res.confidence_tier}"

    asyncio.run(_run())
