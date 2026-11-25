# warm2api — one-shot installer for Windows
#
#   irm https://raw.githubusercontent.com/dumbzombies/warm2api/main/install.ps1 | iex
#
# Installs Bun when missing, fetches the repo, compiles the proxy into one
# self-contained .exe and puts `warm2api` on PATH. No Node, no package registry,
# no service manager, no administrator rights.
#
# Env (set before running to override):
#   WARM2API_HOME   checkout/build location   (default %LOCALAPPDATA%\warm2api)
#   WARM2API_BIN    install directory         (default %USERPROFILE%\.local\bin)
#   WARM2API_REF    git ref to build          (default main)
#   WARM2API_REPO   owner/name               (default dumbzombies/warm2api)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = if ($env:WARM2API_REPO) { $env:WARM2API_REPO } else { 'dumbzombies/warm2api' }
$Ref = if ($env:WARM2API_REF) { $env:WARM2API_REF } else { 'main' }
$HomeDir = if ($env:WARM2API_HOME) { $env:WARM2API_HOME } else { Join-Path $env:LOCALAPPDATA 'warm2api' }
$BinDir = if ($env:WARM2API_BIN) { $env:WARM2API_BIN } else { Join-Path $env:USERPROFILE '.local\bin' }
$Exe = Join-Path $BinDir 'warm2api.exe'

function Say($message) { Write-Host "warm2api: $message" -ForegroundColor Cyan }
function Fail($message) { Write-Host "warm2api: ERROR: $message" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- bun
function Ensure-Bun {
    $bun = Get-Command bun -ErrorAction SilentlyContinue
    if ($bun) { Say "bun $(& bun --version) already installed"; return }
    Say 'installing bun to %USERPROFILE%\.bun'
    & powershell -NoProfile -Command 'irm bun.sh/install.ps1 | iex'
    if ($LASTEXITCODE -ne 0) { Fail 'bun install failed' }
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Fail 'bun still not on PATH after install' }
}

# ---------------------------------------------------------------- source
function Get-Source {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Fail 'git is required on Windows. Install it from https://git-scm.com/download/win and re-run.'
    }
    $gitDir = Join-Path $HomeDir '.git'
    if (Test-Path $gitDir) {
        Say "updating checkout in $HomeDir"
        & git -C $HomeDir fetch --depth 1 origin $Ref
        if ($LASTEXITCODE -ne 0) { Fail 'git fetch failed' }
        & git -C $HomeDir checkout -q FETCH_HEAD
        if ($LASTEXITCODE -ne 0) { Fail 'git checkout failed' }
        return
    }
    Say "cloning $Repo ($Ref) into $HomeDir"
    if (Test-Path $HomeDir) { Remove-Item -Recurse -Force $HomeDir }
    New-Item -ItemType Directory -Force (Split-Path $HomeDir) | Out-Null
    & git clone --depth 1 --branch $Ref "https://github.com/$Repo.git" $HomeDir
    if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
}

Say "installing into $HomeDir, command in $BinDir"
Ensure-Bun
Get-Source

Say 'compiling the proxy (this takes a few seconds)'
New-Item -ItemType Directory -Force $BinDir | Out-Null
Push-Location $HomeDir
try {
    & bun build --compile --target=bun .\src\main.ts --outfile=$Exe
    if ($LASTEXITCODE -ne 0) { Fail 'compile failed' }
} finally {
    Pop-Location
}
if (-not (Test-Path $Exe)) { Fail "expected $Exe to exist after compiling" }

# ---------------------------------------------------------------- PATH
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$entries = @()
if ($userPath) { $entries = $userPath -split ';' | Where-Object { $_ } }
if ($entries -notcontains $BinDir) {
    $next = (@($entries) + $BinDir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $next, 'User')
    Say "added $BinDir to your PATH (open a new terminal to pick it up)"
}
$env:PATH = "$BinDir;$env:PATH"

& $Exe version | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'installed binary does not run' }

@"

warm2api is installed: $Exe

  warm2api start        # run in the background
  warm2api status       # health, URL, dashboard link
  warm2api add          # approve a Warm account
  warm2api stop         # stop it
  warm2api --help       # everything else

Data (database, API key, logs): $(if ($env:WARM2API_DATA) { $env:WARM2API_DATA } else { Join-Path $env:USERPROFILE '.warm2api' })
"@ | Write-Host
