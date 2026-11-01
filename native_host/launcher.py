"""
QuizZy Native Messaging Host & Backend Launcher.
Provides Chrome / Edge extensions with a native bridge to launch and monitor
the local QuizZy FastAPI backend server on 127.0.0.1:8000.
"""

import sys
import os
import json
import struct
import socket
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
HOST_NAME = "com.quizzy.launcher"
PORT = 8000


def _hidden_subprocess_kwargs() -> dict:
    if sys.platform != "win32":
        return {}
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 0  # SW_HIDE
    return {
        "startupinfo": si,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
        "stdin": subprocess.DEVNULL,
    }


def find_python_exe() -> Path:
    candidates = [
        PROJECT_ROOT / ".venv" / "Scripts" / "pythonw.exe",
        PROJECT_ROOT / ".venv" / "Scripts" / "python.exe",
        PROJECT_ROOT.parent / ".venv" / "Scripts" / "pythonw.exe",
        PROJECT_ROOT.parent / ".venv" / "Scripts" / "python.exe",
        Path(sys.executable),
    ]
    for c in candidates:
        if c.is_file():
            return c
    return Path(sys.executable)


def is_port_open(port: int = PORT) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.4)
            return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False


def start_backend() -> dict:
    try:
        from backend import lifecycle_manager
        res = lifecycle_manager.start_backend(source="native_launcher")
        return {
            "success": bool(res.get("online")),
            "status": res.get("status"),
            "port": res.get("port", PORT),
            "pid": res.get("pid"),
        }
    except Exception:
        pass

    if is_port_open(PORT):
        return {"success": True, "status": "already_running", "port": PORT}

    python_exe = find_python_exe()
    if not python_exe.is_file():
        return {
            "success": False,
            "error": f"Python executable not found. Looked in {PROJECT_ROOT / '.venv'}",
            "port": PORT,
        }

    cmd = [
        str(python_exe),
        "-m",
        "uvicorn",
        "backend.app:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(PORT),
        "--log-level",
        "warning",
    ]

    try:
        kwargs = _hidden_subprocess_kwargs()
        creationflags = kwargs.get("creationflags", 0)
        if sys.platform == "win32":
            creationflags |= subprocess.CREATE_NEW_PROCESS_GROUP
        startupinfo = kwargs.get("startupinfo")

        proc = subprocess.Popen(
            cmd,
            cwd=str(PROJECT_ROOT),
            startupinfo=startupinfo,
            creationflags=creationflags,
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        return {
            "success": True,
            "status": "started",
            "pid": proc.pid,
            "port": PORT,
            "python": str(python_exe),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": f"Failed to spawn backend process: {exc}",
            "port": PORT,
        }


def get_pids_on_port(port: int = PORT) -> list[int]:
    """Find process IDs listening on the target port."""
    pids = []
    try:
        kwargs = _hidden_subprocess_kwargs()
        res = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            check=False,
            **kwargs,
        )
        for line in res.stdout.splitlines():
            parts = line.strip().split()
            if len(parts) >= 5 and "LISTENING" in parts:
                local_addr = parts[1]
                if f":{port}" in local_addr:
                    try:
                        pid = int(parts[-1])
                        if pid > 4 and pid not in pids:
                            pids.append(pid)
                    except ValueError:
                        pass
    except Exception:
        pass
    return pids


def is_safe_to_kill(pid: int) -> bool:
    """Ensure process is a known python/uvicorn runtime before terminating."""
    if pid <= 4:
        return False
    try:
        kwargs = _hidden_subprocess_kwargs()
        res = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            check=False,
            **kwargs,
        )
        out = res.stdout.lower()
        allowed = ("python", "pythonw", "uvicorn")
        for a in allowed:
            if a in out:
                return True
        return False
    except Exception:
        return False


def stop_backend() -> dict:
    """Stop the QuizZy backend server and free port 8000."""
    try:
        from backend import lifecycle_manager
        res = lifecycle_manager.stop_backend(source="native_launcher")
        return {
            "success": res.get("status") in ("stopped", "already_stopped"),
            "status": res.get("status"),
            "port": res.get("port", PORT),
        }
    except Exception:
        pass

    if not is_port_open(PORT):
        return {"success": True, "status": "already_stopped", "port": PORT}

    # 1. Attempt graceful HTTP shutdown via /shutdown endpoint
    try:
        import urllib.request
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/shutdown",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            pass
    except Exception:
        pass

    import time
    for _ in range(10):
        if not is_port_open(PORT):
            return {"success": True, "status": "stopped", "port": PORT, "method": "graceful"}
        time.sleep(0.15)

    # 2. Terminate dev runtime processes listening on port 8000
    pids = get_pids_on_port(PORT)
    killed = []
    kwargs = _hidden_subprocess_kwargs()
    for pid in pids:
        if is_safe_to_kill(pid):
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(pid)],
                    capture_output=True,
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    **kwargs,
                )
                killed.append(pid)
            except Exception:
                pass

    time.sleep(0.3)
    if not is_port_open(PORT):
        return {"success": True, "status": "stopped", "port": PORT, "killed_pids": killed}
    else:
        return {
            "success": False,
            "error": f"Failed to stop backend; port {PORT} is still occupied.",
            "port": PORT,
            "pids": pids,
        }


def read_native_message() -> dict | None:
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    message_length = struct.unpack("<I", raw_length)[0]
    if message_length == 0 or message_length > 10 * 1024 * 1024:
        return None
    raw_data = sys.stdin.buffer.read(message_length)
    if len(raw_data) < message_length:
        return None
    return json.loads(raw_data.decode("utf-8"))


def send_native_message(data: dict) -> None:
    encoded = json.dumps(data).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def register_host(extra_origins: list[str] | None = None) -> None:
    import winreg

    host_dir = PROJECT_ROOT / "native_host"
    host_dir.mkdir(parents=True, exist_ok=True)
    bat_path = host_dir / "launcher.bat"
    json_path = host_dir / f"{HOST_NAME}.json"

    # 1. Prefer compiled silent GUI executable
    exe_path = PROJECT_ROOT / "backend" / "native_host_win.exe"
    target_path = str(exe_path if exe_path.is_file() else bat_path)

    # 2. Base allowed origins for Chrome extensions
    origins = [
        "chrome-extension://fmddjogdlehkodcjihmmmbdblhkmjhia/",  # Fixed RSA key ID
        "chrome-extension://bjikoeoffpkkpnnibajmnggfbaaaoohb/",  # c:\Users\jassh\Jev\extension
        "chrome-extension://ddkailojfnnmpcfbkdagbnkbkobmblci/",  # C:\Users\jassh\Jev\extension
        "chrome-extension://gkigdfciojdildpclenimfhpdchegmdf/",  # c:/Users/jassh/Jev/extension
        "chrome-extension://pphlghdmicddcjaedbgpfaldhnkiocbn/",  # C:/Users/jassh/Jev/extension
        "chrome-extension://akcloplbnlpmdmdgmaamgpppnignejia/",  # c:\Users\jassh\Projects\QuizZy\QuizZy\extension
        "chrome-extension://loggaoojnpbaholmopcagahakgbcjlpe/",  # C:\Users\jassh\Projects\QuizZy\QuizZy\extension
    ]
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
        "description": "QuizZy Local Backend Launcher Native Messaging Host",
        "path": str(target_path),
        "type": "stdio",
        "allowed_origins": origins,
    }
    json_path.write_text(json.dumps(manifest_data, indent=2), encoding="utf-8")

    # 3. Register in Windows Registry under Current User (Chrome and Edge)
    reg_targets = [
        r"Software\Google\Chrome\NativeMessagingHosts",
        r"Software\Microsoft\Edge\NativeMessagingHosts",
    ]
    for reg_path in reg_targets:
        full_key_path = f"{reg_path}\\{HOST_NAME}"
        try:
            key = winreg.CreateKey(winreg.HKEY_CURRENT_USER, full_key_path)
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(json_path))
            winreg.CloseKey(key)
            print(f"[OK] Registered: HKCU\\{full_key_path} -> {json_path}")
        except Exception as e:
            print(f"[ERROR] Failed to register HKCU\\{full_key_path}: {e}")

    print(f"\nQuizZy Native Messaging Host registered successfully!")
    print(f"Manifest JSON: {json_path}")
    print(f"Launcher BAT : {bat_path}")


def main():
    if len(sys.argv) > 1:
        arg = sys.argv[1].lower()
        if arg in ("--register", "-r", "register"):
            extra = sys.argv[2:] if len(sys.argv) > 2 else None
            register_host(extra)
            return
        elif arg in ("--start", "-s", "start"):
            res = start_backend()
            print(json.dumps(res, indent=2))
            return
        elif arg in ("--stop", "-k", "stop", "kill"):
            res = stop_backend()
            print(json.dumps(res, indent=2))
            return
        elif arg in ("--check", "-c", "check"):
            open_status = is_port_open(PORT)
            print(json.dumps({"running": open_status, "port": PORT}, indent=2))
            return
        elif arg in ("--test", "-t", "test"):
            res = start_backend()
            print("[TEST OUTPUT]", json.dumps(res, indent=2))
            return

    # Standard stdio native messaging loop
    while True:
        try:
            msg = read_native_message()
            if msg is None:
                break
            action = msg.get("action") or msg.get("command") or ""
            action = action.upper()

            if action in ("START_BACKEND", "START", "LAUNCH"):
                resp = start_backend()
            elif action in ("STOP_BACKEND", "STOP", "KILL", "SHUTDOWN"):
                resp = stop_backend()
            elif action in ("HEARTBEAT", "LEASE_RENEW"):
                try:
                    from backend import lifecycle_manager
                    state = lifecycle_manager.record_heartbeat(active_tabs=int(msg.get("active_tabs", 1)))
                    resp = {"success": True, "status": "heartbeat_recorded", "active_tabs": state.get("active_ccbp_tabs", 1)}
                except Exception as exc:
                    resp = {"success": False, "error": str(exc)}
            elif action in ("CHECK_HEALTH", "CHECK", "STATUS"):
                resp = {"success": True, "running": is_port_open(PORT), "port": PORT}
            elif action == "PING":
                resp = {"success": True, "pong": True}
            else:
                resp = {"success": False, "error": f"Unknown action: {action}"}

            send_native_message(resp)
            # Chrome sendNativeMessage sends a single message per invocation; exit after response
            break
        except Exception as e:
            send_native_message({"success": False, "error": str(e)})
            break


if __name__ == "__main__":
    main()

