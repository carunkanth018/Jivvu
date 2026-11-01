"""QuizZy global CLI launcher module."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VENV_PYTHON = REPO_ROOT / ".venv" / "Scripts" / "pythonw.exe"
if not DEFAULT_VENV_PYTHON.is_file():
    DEFAULT_VENV_PYTHON = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
VENV_PYTHON = DEFAULT_VENV_PYTHON


def get_python_executable(prefer_gui: bool = True) -> str:
    """Resolve pythonw.exe (for windowless background execution) or python.exe."""
    if prefer_gui:
        pythonw = REPO_ROOT / ".venv" / "Scripts" / "pythonw.exe"
        if pythonw.is_file():
            return str(pythonw.resolve())
    if DEFAULT_VENV_PYTHON.is_file():
        return str(DEFAULT_VENV_PYTHON.resolve())
    python_exe = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
    if python_exe.is_file():
        return str(python_exe.resolve())
    return sys.executable


def find_chrome_executable() -> Optional[str]:
    """Locate Google Chrome executable across standard Windows installation paths."""
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates.append(os.path.join(local_app_data, r"Google\Chrome\Application\chrome.exe"))

    program_files = os.environ.get("PROGRAMFILES")
    if program_files:
        candidates.append(os.path.join(program_files, r"Google\Chrome\Application\chrome.exe"))

    program_files_x86 = os.environ.get("PROGRAMFILES(X86)")
    if program_files_x86:
        candidates.append(os.path.join(program_files_x86, r"Google\Chrome\Application\chrome.exe"))

    for path in candidates:
        if path and os.path.isfile(path):
            return path

    which_chrome = shutil.which("chrome") or shutil.which("google-chrome")
    if which_chrome and os.path.isfile(which_chrome):
        return which_chrome

    return None


def is_dashboard_online(host: str | int = "127.0.0.1", port: int = 8765, timeout: float = 1.0) -> bool:
    """Check if the dashboard server is already online and responding to ping."""
    if isinstance(host, int):
        actual_port = host
        actual_host = "127.0.0.1"
    else:
        actual_host = host
        actual_port = port
    url = f"http://{actual_host}:{actual_port}/api/dashboard/ping"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "QuizZy-CLI"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def wait_for_dashboard_ready(
    host: str = "127.0.0.1", port: int = 8765, max_seconds: float = 5.0
) -> bool:
    """Poll dashboard server readiness endpoint until responding or timeout."""
    start_time = time.time()
    while time.time() - start_time < max_seconds:
        if is_dashboard_online(host=host, port=port, timeout=0.5):
            return True
        time.sleep(0.2)
    return False


def launch_dashboard(
    host: str = "127.0.0.1",
    port: int = 8765,
    no_browser: bool = False,
    dry_run: bool = False,
) -> int:
    """
    Launch the QuizZy Observability Dashboard in Google Chrome.
    Spawns backend.dashboard_server as a detached background process if not already running.
    """
    url = f"http://{host}:{port}"

    if dry_run:
        print(f"[QuizZy CLI] Dry run: Dashboard target is {url} (no background process or browser spawned).")
        return 0

    # 1. Start decoupled dashboard server if not running
    if not is_dashboard_online(host=host, port=port):
        daemon_code = start_daemon(port=port, host=host)
        if daemon_code != 0:
            print(f"[QuizZy CLI] Warning: Dashboard server did not respond at {url} within 6 seconds.", file=sys.stderr)

    # 3. Open in Google Chrome
    if not no_browser:
        chrome_exe = find_chrome_executable()
        if chrome_exe:
            try:
                subprocess.Popen([chrome_exe, url])
            except Exception:
                webbrowser.open(url)
        else:
            # Fallback to default browser
            webbrowser.open(url)

    print(f"QuizZy Dashboard launched in Chrome -> {url}")
    return 0


def register_windows_startup(port: int = 8765) -> bool:
    """Register QuizZy lifecycle daemon in Windows HKCU Run key for silent auto-start on login."""
    if sys.platform != "win32":
        return False
    try:
        import winreg
        pythonw_exe = VENV_PYTHON.with_name("pythonw.exe")
        exe_path = pythonw_exe if pythonw_exe.is_file() else VENV_PYTHON
        cli_py = REPO_ROOT / "backend" / "cli.py"
        cmd_str = f'"{exe_path}" "{cli_py}" daemon --foreground --port {port}'
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, "QuizZyLifecycleDaemon", 0, winreg.REG_SZ, cmd_str)
        return True
    except Exception as exc:
        print(f"[QuizZy Daemon] Windows startup registration failed: {exc}")
        return False


def run_daemon_foreground(host: str = "127.0.0.1", port: int = 8765) -> int:
    """Run dashboard_server uvicorn application directly in-process with silent logging."""
    import uvicorn

    daemon_log_path = REPO_ROOT / "backend" / "daemon.log"
    try:
        if sys.stdout is None or not hasattr(sys.stdout, "write"):
            sys.stdout = open(daemon_log_path, "a", encoding="utf-8", buffering=1)
        if sys.stderr is None or not hasattr(sys.stderr, "write"):
            sys.stderr = open(daemon_log_path, "a", encoding="utf-8", buffering=1)
    except Exception:
        pass

    try:
        uvicorn.run(
            "backend.dashboard_server:app",
            host=host,
            port=port,
            log_level="warning",
            log_config=None,
            use_colors=False,
        )
        return 0
    except Exception as exc:
        if sys.stderr and hasattr(sys.stderr, "write"):
            print(f"[QuizZy Daemon] Error in foreground daemon: {exc}", file=sys.stderr)
        return 1


def spawn_detached_daemon(cmd_list: List[str], cwd: Path) -> bool:
    """Spawn a detached daemon process that survives parent exit on Windows with zero visible windows."""
    if sys.platform == "win32":
        try:
            cmd_line = subprocess.list2cmdline(cmd_list).replace("'", "''")
            ps_script = (
                f"$si = New-CimInstance -ClassName Win32_ProcessStartup -Property @{{ ShowWindow = [uint16]0 }} -ClientOnly; "
                f"$proc = Invoke-CimMethod -ClassName Win32_Process -MethodName Create "
                f"-Arguments @{{ CommandLine = '{cmd_line}'; CurrentDirectory = '{cwd.resolve()}'; ProcessStartupInformation = $si }}; "
                f"if ($proc.ReturnValue -eq 0) {{ exit 0 }} else {{ exit 1 }}"
            )
            res = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
                cwd=str(cwd),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
                check=False,
            )
            if res.returncode == 0:
                return True
        except Exception:
            pass

    from backend.lifecycle_manager import _hidden_subprocess_kwargs
    hidden_kwargs = _hidden_subprocess_kwargs()
    creationflags = hidden_kwargs.get("creationflags", 0)
    if sys.platform == "win32":
        creationflags |= subprocess.CREATE_NEW_PROCESS_GROUP
        if hasattr(subprocess, "DETACHED_PROCESS"):
            creationflags |= subprocess.DETACHED_PROCESS
    startupinfo = hidden_kwargs.get("startupinfo")

    daemon_log_path = cwd / "backend" / "daemon.log"
    daemon_log_file = open(daemon_log_path, "a", encoding="utf-8", buffering=1)

    try:
        subprocess.Popen(
            cmd_list,
            cwd=str(cwd),
            stdin=subprocess.DEVNULL,
            stdout=daemon_log_file,
            stderr=daemon_log_file,
            startupinfo=startupinfo,
            creationflags=creationflags,
            close_fds=True,
        )
        return True
    except Exception:
        daemon_log_file.close()
        return False


def start_daemon(port: int = 8765, host: str = "127.0.0.1") -> int:
    """Ensure the silent lifecycle daemon on port 8765 is running and registered for auto-start."""
    register_windows_startup(port=port)
    if is_dashboard_online(host=host, port=port):
        print(f"[QuizZy Daemon] Lifecycle daemon is already active on http://{host}:{port}")
        return 0

    python_exe = str(get_python_executable(prefer_gui=True))
    cmd = [
        python_exe,
        "-m",
        "backend.cli",
        "daemon",
        "--foreground",
        "--host",
        host,
        "--port",
        str(port),
    ]

    if not spawn_detached_daemon(cmd, cwd=REPO_ROOT):
        print(f"[QuizZy Daemon] Failed to spawn daemon process")
        return 1

    if wait_for_dashboard_ready(host=host, port=port, max_seconds=6.0):
        print(f"[QuizZy Daemon] Lifecycle daemon online at http://{host}:{port}")
        return 0
    else:
        print(f"[QuizZy Daemon] Daemon spawned but failed to respond on http://{host}:{port}")
        return 1


def create_desktop_shortcut(app_name: str = "Jev") -> Optional[Path]:
    """Create a Windows desktop shortcut for the dashboard named Jev.lnk with custom icon."""
    if sys.platform != "win32":
        return None

    ico_path = REPO_ROOT / "backend" / "static" / "dashboard" / "jev.ico"
    pythonw_exe = VENV_PYTHON.with_name("pythonw.exe")
    exe_path = pythonw_exe if pythonw_exe.is_file() else VENV_PYTHON
    cli_py = REPO_ROOT / "backend" / "cli.py"

    user_profile = Path(os.environ.get("USERPROFILE", "C:\\Users\\Default"))
    candidates = [
        user_profile / "OneDrive" / "Desktop",
        user_profile / "Desktop",
    ]
    created = []
    for d in candidates:
        if d.is_dir():
            shortcut_path = d / f"{app_name}.lnk"
            ps_script = f"""
            $wsh = New-Object -ComObject WScript.Shell
            $sc = $wsh.CreateShortcut('{str(shortcut_path)}')
            $sc.TargetPath = '{str(exe_path)}'
            $sc.Arguments = '"{str(cli_py)}" dashboard'
            $sc.WorkingDirectory = '{str(REPO_ROOT)}'
            $sc.IconLocation = '{str(ico_path)},0'
            $sc.Description = '{app_name} - QuizZy Observability Dashboard'
            $sc.WindowStyle = 1
            $sc.Save()
            """
            res = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps_script],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000),
                check=False,
            )
            if res.returncode == 0:
                created.append(shortcut_path)

    return created[0] if created else None


def build_parser() -> argparse.ArgumentParser:
    """Construct CLI argument parser for quizzy commands."""
    parser = argparse.ArgumentParser(
        prog="quizzy",
        description="QuizZy Assistant & Observability CLI",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # Subcommand: dashboard
    dash_parser = subparsers.add_parser(
        "dashboard",
        help="Launch the QuizZy Observability Dashboard in Google Chrome",
    )
    dash_parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port for the dashboard server (default: 8765)",
    )
    dash_parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host for the dashboard server (default: 127.0.0.1)",
    )
    dash_parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Start dashboard server without launching Chrome",
    )
    dash_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simulate launch and verify CLI parameters without opening server or browser",
    )

    # Subcommand: daemon
    daemon_parser = subparsers.add_parser(
        "daemon",
        help="Start the background lifecycle daemon and register for silent Windows login auto-start",
    )
    daemon_parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port for the daemon (default: 8765)",
    )
    daemon_parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host for the daemon (default: 127.0.0.1)",
    )
    daemon_parser.add_argument(
        "--foreground",
        action="store_true",
        help="Run the dashboard daemon directly in-process (used by Windows startup and daemon worker)",
    )

    # Subcommand: shortcut
    shortcut_parser = subparsers.add_parser(
        "shortcut",
        help="Create or refresh desktop shortcut for QuizZy Dashboard (Jev)",
    )
    shortcut_parser.add_argument(
        "--name",
        type=str,
        default="Jev",
        help="App name for the shortcut (default: Jev)",
    )

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    """Entry point for the quizzy CLI."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "dashboard":
        return launch_dashboard(
            host=args.host,
            port=args.port,
            no_browser=args.no_browser,
            dry_run=args.dry_run,
        )

    if args.command == "daemon":
        if getattr(args, "foreground", False):
            return run_daemon_foreground(
                host=args.host,
                port=args.port,
            )
        return start_daemon(
            host=args.host,
            port=args.port,
        )

    if args.command == "shortcut":
        res = create_desktop_shortcut(app_name=args.name)
        if res:
            print(f"[QuizZy CLI] Desktop shortcut created: {res}")
            return 0
        else:
            print(f"[QuizZy CLI] Failed to create desktop shortcut", file=sys.stderr)
            return 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())

