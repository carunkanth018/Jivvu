using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace QuizZy
{
    class NativeHostWin
    {
        static int Main(string[] args)
        {
            try
            {
                string exeDir = AppDomain.CurrentDomain.BaseDirectory;

                // 1. Resolve Python executable (prefer pythonw.exe for windowless execution)
                string venvPython = Path.GetFullPath(Path.Combine(exeDir, @"..\.venv\Scripts\pythonw.exe"));
                if (!File.Exists(venvPython))
                {
                    venvPython = Path.GetFullPath(Path.Combine(exeDir, @".venv\Scripts\pythonw.exe"));
                }
                if (!File.Exists(venvPython))
                {
                    venvPython = Path.GetFullPath(Path.Combine(exeDir, @"Scripts\pythonw.exe"));
                }
                if (!File.Exists(venvPython))
                {
                    venvPython = Path.GetFullPath(Path.Combine(exeDir, @"..\.venv\Scripts\python.exe"));
                }
                if (!File.Exists(venvPython))
                {
                    venvPython = Path.GetFullPath(Path.Combine(exeDir, @".venv\Scripts\python.exe"));
                }
                if (!File.Exists(venvPython))
                {
                    venvPython = "pythonw.exe";
                }

                // 2. Resolve native_host.py
                string scriptPath = Path.GetFullPath(Path.Combine(exeDir, "native_host.py"));
                if (!File.Exists(scriptPath))
                {
                    scriptPath = Path.GetFullPath(Path.Combine(exeDir, @"backend\native_host.py"));
                }

                var psi = new ProcessStartInfo
                {
                    FileName = venvPython,
                    Arguments = "-u \"" + scriptPath + "\"",
                    WorkingDirectory = Path.GetDirectoryName(scriptPath),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };

                using (var proc = new Process())
                {
                    proc.StartInfo = psi;
                    proc.Start();

                    // Background thread: forward stdin from Chrome to Python process
                    var stdinThread = new Thread(() =>
                    {
                        try
                        {
                            using (var inStream = Console.OpenStandardInput())
                            {
                                byte[] buffer = new byte[8192];
                                int bytesRead;
                                while ((bytesRead = inStream.Read(buffer, 0, buffer.Length)) > 0)
                                {
                                    proc.StandardInput.BaseStream.Write(buffer, 0, bytesRead);
                                    proc.StandardInput.BaseStream.Flush();
                                }
                            }
                        }
                        catch { }
                        finally
                        {
                            try { proc.StandardInput.Close(); } catch { }
                        }
                    })
                    {
                        IsBackground = true
                    };
                    stdinThread.Start();

                    // Main thread: forward stdout from Python process to Chrome stdout
                    try
                    {
                        using (var outStream = Console.OpenStandardOutput())
                        {
                            byte[] buffer = new byte[8192];
                            int bytesRead;
                            while ((bytesRead = proc.StandardOutput.BaseStream.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                outStream.Write(buffer, 0, bytesRead);
                                outStream.Flush();
                            }
                        }
                    }
                    catch { }

                    // Wait for python process to exit (max 10s safety guard)
                    if (!proc.WaitForExit(10000))
                    {
                        try { proc.Kill(); } catch { }
                    }

                    return proc.ExitCode;
                }
            }
            catch
            {
                return 1;
            }
        }
    }
}

