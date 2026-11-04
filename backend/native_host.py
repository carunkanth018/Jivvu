"""
QuizZy Automatic Backend Lifecycle Manager Native Messaging Host.
Provides Chrome / Edge extensions with a native stdio bridge to start,
stop, monitor, and heartbeat the QuizZy FastAPI backend server on 127.0.0.1:8000.
"""

from __future__ import annotations

import json
import logging
import os
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from backend import lifecycle_manager

logger = logging.getLogger("quizzy.native_host")

HOST_NAME = "com.quizzy.lifecycle"


def read_native_message(stream: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    """Read a length-prefixed JSON message from stdin or stream (Native Messaging format)."""
    try:
        in_stream = stream if stream is not None else getattr(sys.stdin, "buffer", sys.stdin)
        raw_length = in_stream.read(4)
        if not raw_length or len(raw_length) < 4:
            return None
        message_length = struct.unpack("<I", raw_length)[0]
        if message_length == 0 or message_length > 10 * 1024 * 1024:
            return None
        raw_data = in_stream.read(message_length)
        if len(raw_data) < message_length:
            return None
        return json.loads(raw_data.decode("utf-8"))
    except Exception as exc:
        logger.warning("Error reading native message: %s", exc)
        return None


def send_native_message(data: Dict[str, Any], stream: Optional[Any] = None) -> None:
    """Send a length-prefixed JSON message to stdout or stream (Native Messaging format)."""
    try:
        out_stream = stream if stream is not None else getattr(sys.stdout, "buffer", sys.stdout)
        encoded = json.dumps(data).encode("utf-8")
        out_stream.write(struct.pack("<I", len(encoded)))
        out_stream.write(encoded)
        out_stream.flush()
    except Exception as exc:
        logger.warning("Error sending native message: %s", exc)


def handle_message(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Process incoming command and return response payload."""
    action = (msg.get("action") or msg.get("command") or "").strip().upper()

    if action in ("START_BACKEND", "START", "LAUNCH"):
        # Ensure dashboard daemon on 8765 is also running
        try:
            from backend.cli import is_dashboard_online, start_daemon
            if not is_dashboard_online(port=8765):
                start_daemon(port=8765)
        except Exception:
            pass

        source = msg.get("source", "native_host")
        result = lifecycle_manager.start_backend(source=source)
        return {
            "success": bool(result.get("online")),
            "status": result.get("status"),
            "online": result.get("online", False),
            "port": result.get("port", 8000),
            "pid": result.get("pid"),
            "source": result.get("started_by"),
        }

    elif action in ("STOP_BACKEND", "STOP", "KILL", "SHUTDOWN"):
        source = msg.get("source", "native_host")
        result = lifecycle_manager.stop_backend(source=source)
        return {
            "success": result.get("status") in ("stopped", "already_stopped"),
            "status": result.get("status"),
            "online": False,
            "port": 8000,
            "killed_pids": result.get("killed_pids", []),
        }

    elif action in ("HEARTBEAT", "LEASE_RENEW"):
        active_tabs = int(msg.get("active_tabs", 1))
        state = lifecycle_manager.record_heartbeat(active_tabs=active_tabs)
        return {
            "success": True,
            "status": "heartbeat_recorded",
            "active_tabs": state.get("active_ccbp_tabs", active_tabs),
            "online": lifecycle_manager.is_backend_healthy(),
            "timestamp": state.get("last_heartbeat"),
        }

    elif action in ("STATUS", "CHECK_HEALTH", "CHECK"):
        healthy = lifecycle_manager.is_backend_healthy()
        state = lifecycle_manager.get_state()
        return {
            "success": True,
            "online": healthy,
            "port": 8000,
            "active_tabs": state.get("active_ccbp_tabs", 0),
            "started_by": state.get("started_by"),
            "state": state,
        }

    elif action == "PING":
        return {
            "success": True,
            "pong": True,
            "timestamp": time.time(),
        }

    else:
        return {
            "success": False,
            "error": f"Unknown action: {action}",
        }


def get_default_origins() -> List[str]:
    """Return all known extension IDs for unpackaged (UTF-16LE & UTF-8) and packaged extensions."""
    import hashlib

    def compute_chrome_id(byte_data: bytes) -> str:
        digest = hashlib.sha256(byte_data).digest()
        return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0x0F)) for b in digest[:16])

    origins_set = set()

    # 1. Base manifest key ID
    origins_set.add("fmddjogdlehkodcjihmmmbdblhkmjhia")

    # 2. Canonical and variant repository paths
    path_variants = [
        str(REPO_ROOT / "extension"),
        str(REPO_ROOT / "extension").lower(),
        str(REPO_ROOT / "extension").replace("\\", "/"),
        str(REPO_ROOT / "extension").replace("\\", "/").lower(),
        r"C:\Users\jassh\Jev\extension",
        r"c:\Users\jassh\Jev\extension",
        "C:/Users/jassh/Jev/extension",
        "c:/Users/jassh/Jev/extension",
        r"C:\Users\jassh\QuizZy\extension",
        r"c:\Users\jassh\QuizZy\extension",
        "C:/Users/jassh/QuizZy/extension",
        "c:/Users/jassh/QuizZy/extension",
        r"C:\Users\jassh\Projects\QuizZy\QuizZy\extension",
        r"c:\Users\jassh\Projects\QuizZy\QuizZy\extension",
        "C:/Users/jassh/Projects/QuizZy/QuizZy/extension",
        "c:/Users/jassh/Projects/QuizZy/QuizZy/extension",
    ]

    for p in path_variants:
        # Chrome on Windows computes IDs via UTF-16LE SHA-256
        origins_set.add(compute_chrome_id(p.encode("utf-16le")))
        origins_set.add(compute_chrome_id(p.encode("utf-8")))

    # 3. Dynamic scan of Chrome & Edge User Data Preferences & Secure Preferences across all profiles
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        for browser in [r"Google\Chrome\User Data", r"Microsoft\Edge\User Data"]:
            browser_dir = Path(local_app_data) / browser
            if browser_dir.is_dir():
                pref_candidates = list(browser_dir.glob("*/Secure Preferences")) + list(browser_dir.glob("*/Preferences"))
                for pref_file in pref_candidates:
                    if pref_file.is_file():
                        try:
                            pref_data = json.loads(pref_file.read_text(encoding="utf-8", errors="ignore"))
                            exts = pref_data.get("extensions", {}).get("settings", {})
                            for ext_id, ext_meta in exts.items():
                                ext_path = str(ext_meta.get("path", "")).lower()
                                ext_name = str(ext_meta.get("manifest", {}).get("name", "")).lower()
                                if any(k in ext_path for k in ["quizzy", "jev", "jivvu"]) or any(k in ext_name for k in ["quizzy", "quiz assistant", "jivvu"]):
                                    origins_set.add(ext_id)
                        except Exception:
                            pass

    return [f"chrome-extension://{oid.strip('/')}/" for oid in sorted(origins_set) if oid]


def register_host(extra_origins: Optional[List[str]] = None) -> bool:
    """Register native messaging hosts (com.quizzy.lifecycle and com.quizzy.launcher) in registry and write manifests."""
    if sys.platform != "win32":
        print("[WARN] Native messaging registry is only supported on Windows.")
        return False

    import winreg

    backend_dir = REPO_ROOT / "backend"
    backend_dir.mkdir(parents=True, exist_ok=True)
    json_path = backend_dir / f"{HOST_NAME}.json"

    # 1. Resolve host executable path (prefer compiled windowless native_host_win.exe)
    exe_path = backend_dir / "native_host_win.exe"
    if exe_path.is_file():
        target_path = str(exe_path)
    else:
        python_exe = REPO_ROOT / ".venv" / "Scripts" / "pythonw.exe"
        if not python_exe.is_file():
            python_exe = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
        if not python_exe.is_file():
            python_exe = Path(sys.executable)
        target_path = str(python_exe)

    # 2. Build allowed origins
    origins = get_default_origins()
    if extra_origins:
        for ext in extra_origins:
            clean = ext.strip()
            if not clean:
                continue
            if not clean.startswith("chrome-extension://"):
                clean = f"chrome-extension://{clean.strip('/')}/"
            if clean not in origins:
                origins.append(clean)
    manifest_data = {
        "name": HOST_NAME,
        "description": "QuizZy Automatic Backend Lifecycle Manager Native Messaging Host",
        "path": target_path,
        "type": "stdio",
        "allowed_origins": origins,
    }
    json_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")

    # 4. Synchronize native_host/com.quizzy.launcher.json for backward compatibility
    legacy_dir = REPO_ROOT / "native_host"
    if legacy_dir.is_dir():
        legacy_manifest_path = legacy_dir / "com.quizzy.launcher.json"
        legacy_data = {
            "name": "com.quizzy.launcher",
            "description": "QuizZy Local Backend Launcher Native Messaging Host",
            "path": target_path,
            "type": "stdio",
            "allowed_origins": origins,
        }
        legacy_manifest_path.write_text(json.dumps(legacy_data, indent=2), encoding="utf-8")

    # 5. Register both hosts in Windows Registry (HKCU)
    hosts_to_register = [
        (HOST_NAME, json_path),
        ("com.quizzy.launcher", REPO_ROOT / "native_host" / "com.quizzy.launcher.json"),
    ]

    reg_targets = [
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
    ]
    all_ok = True
    for hname, hmanifest in hosts_to_register:
        if not hmanifest.is_file():
            continue
        for reg_path in reg_targets:
            full_key_path = f"{reg_path}\\{hname}"
            try:
                key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, full_key_path)
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(hmanifest))
                winreg.CloseKey(key)
                print(f"[OK] Registered: HKCU\\{full_key_path} -> {hmanifest}")
            except Exception as e:
                print(f"[ERROR] Failed to register HKCU\\{full_key_path}: {e}")
                all_ok = False

    return all_ok


def main() -> None:
    if len(sys.argv) > 1:
        arg = sys.argv[1].lower()
        if arg in ("--register", "-r", "register"):
            extra = sys.argv[2:] if len(sys.argv) > 2 else None
            register_host(extra)
            return
        elif arg in ("--start", "-s", "start"):
            res = handle_message({"action": "START_BACKEND"})
            print(json.dumps(res, indent=2))
            return
        elif arg in ("--stop", "-k", "stop", "kill"):
            res = handle_message({"action": "STOP_BACKEND"})
            print(json.dumps(res, indent=2))
            return
        elif arg in ("--status", "--check", "-c", "status", "check"):
            res = handle_message({"action": "STATUS"})
            print(json.dumps(res, indent=2))
            return
        elif arg in ("--ping", "-p", "ping"):
            res = handle_message({"action": "PING"})
            print(json.dumps(res, indent=2))
            return

    # Standard stdio native messaging loop (one-shot per Chrome sendNativeMessage invocation)
    while True:
        try:
            msg = read_native_message()
            if msg is None:
                break
            resp = handle_message(msg)
            send_native_message(resp)
            # Chrome sendNativeMessage sends a single message per invocation; exit after response
            break
        except Exception as e:
            send_native_message({"success": False, "error": str(e)})
            break


if __name__ == "__main__":
    main()
