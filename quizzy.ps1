$ErrorActionPreference = 'Continue'
$repoRoot = $PSScriptRoot
$env:PYTHONPATH = "$repoRoot;$env:PYTHONPATH"
& "$repoRoot\.venv\Scripts\python.exe" -m backend.cli @args
exit $LASTEXITCODE

