# MyDegreePlan local launcher (Windows).   mdp <command>     (see README.md)
#   start [-Build]   generate secrets on first run, start everything, open the browser
#   stop             stop the app (your data is kept)
#   backup           stop, snapshot all data into .\backups, start again
#   restore <file>   replace all data with a snapshot made by `backup`
#   reset-password <email>
#   wipe             PERMANENTLY delete all data
#   package          (maintainer) build + save images into mydegreeplan-images.tar
#   update [apply]   (maintainer/diagnostic) check for, or install, an update. Students use the
#                    Update button inside the app instead.
#   logs | init
param(
    [Parameter(Position = 0)][string]$Command = 'start',
    [Parameter(Position = 1)][string]$Arg1,
    [switch]$Build
)

# 'Continue', not 'Stop': in Windows PowerShell 5.1 a native command that writes to
# stderr (e.g. `docker inspect` on a container that doesn't exist yet) would abort
# the script under 'Stop'. Every docker call below checks $LASTEXITCODE itself.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$EnvFile = Join-Path $PSScriptRoot '.env'
$Volume  = 'mdp_db_data'
$StateVolume = 'mdp_update_state'
$ActiveFile  = Join-Path $PSScriptRoot '.mdp-active-compose.yml'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Docker Desktop's usual install locations. MDP_DOCKER_DESKTOP overrides (used by the tests).
function Find-DockerDesktop {
    if ($env:MDP_DOCKER_DESKTOP) { return $env:MDP_DOCKER_DESKTOP }
    foreach ($p in @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe", "$env:LOCALAPPDATA\Programs\Docker\Docker\Docker Desktop.exe")) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

# -Start: if Docker is installed but not running, launch Docker Desktop and wait for it
# (`start` only; other commands have nothing to do when Docker is off).
function Test-Docker([switch]$Start) {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Fail 'Docker is not installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop), start it, and run this again.'
    }
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
    if ($Start) {
        $exe = Find-DockerDesktop
        if ($exe -and (Test-Path $exe)) {
            Write-Host 'Docker Desktop is not running. Starting it (this can take a minute or two)...'
            Start-Process $exe
            $wait = if ($env:MDP_DOCKER_WAIT) { [int]$env:MDP_DOCKER_WAIT } else { 180 }
            $deadline = (Get-Date).AddSeconds($wait)
            while ((Get-Date) -lt $deadline) {
                Start-Sleep -Seconds 3
                docker info *> $null
                if ($LASTEXITCODE -eq 0) { Write-Host 'Docker is ready.'; return }
            }
            Fail 'Docker Desktop was started but is not ready yet. Wait until it says "running", then open MyDegreePlan again.'
        }
    }
    Fail 'Docker is installed but not running. Start Docker Desktop, wait until it says "running", then try again.'
}

# ── which compose file is current ────────────────────────────────────────────
# A bundle ships docker-compose.yml for the version it was built from. When the in-app
# updater installs a newer release it keeps that release's compose file in the
# mdp_update_state volume. Starting from the shipped file after that would quietly
# downgrade the app, so every compose call goes through Dc, which prefers the volume's copy.
# `start -Build` is the developer path and always uses the repo's own docker-compose.yml.
$script:ComposeResolved = $false
$script:ComposeArgs = @()
function Resolve-Compose {
    if ($script:ComposeResolved) { return }
    $script:ComposeResolved = $true
    if ($Build) { return }
    docker volume inspect $StateVolume *> $null
    if ($LASTEXITCODE -ne 0) { return }                  # never updated: use the shipped file
    # Any local updater image can read the volume. (A `docker image ls --filter reference=`
    # glob is not used: `*` does not match `/`, so it misses registry-qualified names.)
    $img = docker image ls --format '{{.ID}} {{.Repository}}' | Where-Object { $_ -match ' \S*updater$' } | ForEach-Object { ($_ -split ' ')[0] } | Select-Object -First 1
    if (-not $img) {
        # Not on disk any more: fall back to the updater image the shipped compose names (docker run pulls it).
        $m = Select-String -Path (Join-Path $PSScriptRoot 'docker-compose.yml') -Pattern '^  updater:\s*$' -Context 0, 12 | Select-Object -First 1
        if ($m) { $line = $m.Context.PostContext | Where-Object { $_ -match '^\s+image:\s*(\S+)' } | Select-Object -First 1; if ($line -match 'image:\s*(\S+)') { $img = $Matches[1] } }
    }
    if (-not $img) { Fail 'An update has been installed but the updater image could not be found. Refusing to start an older version by mistake.' }
    $text = docker run --rm -v "${StateVolume}:/s:ro" --entrypoint cat $img /s/current/docker-compose.yml 2>$null
    $rc = $LASTEXITCODE
    if ($rc -eq 0) {
        [IO.File]::WriteAllText($ActiveFile, (($text -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
        $script:ComposeArgs = @('-f', $ActiveFile, '--project-directory', $PSScriptRoot)
    } elseif ($rc -ne 1) {
        # 1 = "no such file" (no update applied yet). Anything else means we could not tell.
        Fail 'Could not read the installed update state. Refusing to start an older version by mistake. Check that Docker is healthy and try again.'
    }
}
function Dc { Resolve-Compose; docker compose @script:ComposeArgs @args }

# ── secrets ──────────────────────────────────────────────────────────────────
function ConvertTo-B64Url([byte[]]$bytes) {
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function New-Secret([int]$bytes) {
    $b = New-Object byte[] $bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($b); $rng.Dispose()
    ConvertTo-B64Url $b
}
function New-Jwt([string]$role, [string]$secret) {
    $iat = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $exp = $iat + 315360000   # 10 years; these are API keys, not login sessions
    $hdr = ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
    $pl  = ConvertTo-B64Url ([Text.Encoding]::UTF8.GetBytes("{`"role`":`"$role`",`"iss`":`"supabase`",`"iat`":$iat,`"exp`":$exp}"))
    $hmac = New-Object Security.Cryptography.HMACSHA256
    $hmac.Key = [Text.Encoding]::UTF8.GetBytes($secret)
    $sig = ConvertTo-B64Url ($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$hdr.$pl")))
    $hmac.Dispose()
    "$hdr.$pl.$sig"
}
function Initialize-EnvFile {
    if (Test-Path $EnvFile) { return }
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        docker volume inspect $Volume *> $null
        if ($LASTEXITCODE -eq 0) {
            Fail ".env is missing but a database already exists. A new .env would not match it. Restore the original .env (or run 'mdp wipe' to start over)."
        }
    }
    $jwt = New-Secret 48
    $text = @(
        '# Generated by mdp. Keep this file private and keep it with your data: it holds the',
        '# database password and signing key. Deleting it makes existing data unreadable.',
        "POSTGRES_PASSWORD=$(New-Secret 24)",
        "JWT_SECRET=$jwt",
        "ANON_KEY=$(New-Jwt 'anon' $jwt)",
        "SERVICE_ROLE_KEY=$(New-Jwt 'service_role' $jwt)",
        'MDP_PORT=8080',
        ''
    ) -join "`n"
    # UTF-8 *without* BOM: a BOM would corrupt the first key for docker compose.
    [IO.File]::WriteAllText($EnvFile, $text, (New-Object Text.UTF8Encoding $false))
    Write-Host 'Created .env with fresh secrets for this computer.'
}
function Get-Port {
    $m = Select-String -Path $EnvFile -Pattern '^MDP_PORT=(\d+)' | Select-Object -First 1
    if ($m) { $m.Matches[0].Groups[1].Value } else { '8080' }
}

# ── commands ─────────────────────────────────────────────────────────────────
$ImageTar = Join-Path $PSScriptRoot 'mydegreeplan-images.tar'
$Images   = @('mydegreeplan/web:local', 'mydegreeplan/setup:local', 'mydegreeplan/db:local', 'mydegreeplan/updater:local',
              'supabase/gotrue:v2.196.0', 'postgrest/postgrest:v14.17')

# Student bundles ship the images as a tar so nothing has to be built or downloaded.
function Import-Images {
    if (-not (Test-Path $ImageTar)) { return }
    docker image inspect $Images[0] *> $null
    if ($LASTEXITCODE -eq 0) { return }
    Write-Host 'Loading bundled images (one-time, may take a minute)...'
    docker load -i $ImageTar
    if ($LASTEXITCODE -ne 0) { Fail 'Could not load mydegreeplan-images.tar.' }
}

# Maintainer only (needs the full MDP checkout): build everything and save it for hand-off.
function New-Package {
    Test-Docker
    docker compose build; if ($LASTEXITCODE -ne 0) { Fail 'Build failed.' }
    docker compose pull --ignore-buildable; if ($LASTEXITCODE -ne 0) { Fail 'Pulling base images failed.' }
    docker save -o $ImageTar @Images; if ($LASTEXITCODE -ne 0) { Fail 'docker save failed.' }
    Write-Host "Wrote $ImageTar. Zip it with docker-compose.yml, db\, mdp.cmd, mdp.ps1, mdp.sh and README.md (NOT .env or backups)." -ForegroundColor Green
}

# The updater needs to know the compose file the app was started from, so it can put the
# old version back if an update fails. Best effort: an update refuses to run without it.
function Save-LaunchedCompose {
    if ($Build) { return }
    $file = if ($script:ComposeArgs.Count) { $ActiveFile } else { Join-Path $PSScriptRoot 'docker-compose.yml' }
    docker cp $file 'mdp-updater:/state/launched.yml' *> $null
}

# One-click re-entry: a Desktop shortcut to this launcher (which also starts Docker if needed).
# Created on the first successful start, and repointed if it targets a different folder (the
# install was moved, reinstalled or unzipped elsewhere). A shortcut of that name that does not
# point at an mdp.cmd is someone else's and is left alone. Never fails `start`
# (MDP_NO_SHORTCUT=1 skips it, MDP_SHORTCUT_DIR redirects it for tests).
function New-DesktopShortcut {
    if ($env:MDP_NO_SHORTCUT) { return }
    try {
        $dir = if ($env:MDP_SHORTCUT_DIR) { $env:MDP_SHORTCUT_DIR } else { [Environment]::GetFolderPath('Desktop') }
        if (-not $dir -or -not (Test-Path $dir)) { return }
        $path = Join-Path $dir 'MyDegreePlan.lnk'
        $target = Join-Path $PSScriptRoot 'mdp.cmd'
        $existed = Test-Path $path
        $sh = New-Object -ComObject WScript.Shell
        $lnk = $sh.CreateShortcut($path)   # loads the existing file when there is one
        if ($existed) {
            if ((Split-Path $lnk.TargetPath -Leaf) -ine 'mdp.cmd') { return }   # not ours
            if ($lnk.TargetPath -ieq $target) { return }                        # already right
        }
        $lnk.TargetPath = $target
        $lnk.WorkingDirectory = $PSScriptRoot
        $lnk.Description = 'Open MyDegreePlan'
        $lnk.WindowStyle = 7   # minimized: the console closes by itself once the app is open
        $lnk.Save()
        if ($existed) { Write-Host 'Pointed your "MyDegreePlan" Desktop shortcut at this folder.' -ForegroundColor Green }
        else { Write-Host 'Added a "MyDegreePlan" shortcut to your Desktop. Double-click it any time to open the app.' -ForegroundColor Green }
    } catch { }
}

function Start-Stack {
    Test-Docker -Start
    Initialize-EnvFile
    Import-Images
    Write-Host 'Starting MyDegreePlan (the first run downloads/builds images and can take several minutes)...'
    $flags = @('up', '-d'); if ($Build) { $flags += '--build' }
    Dc @flags
    if ($LASTEXITCODE -ne 0) {
        Dc logs --tail 40 migrate auth rest web
        Fail 'Startup failed; the last log lines are above.'
    }
    Save-LaunchedCompose
    Write-Host 'Loading the course catalog...'
    $deadline = (Get-Date).AddMinutes(4)
    while ($true) {
        $s = docker inspect -f '{{.State.Status}}|{{.State.ExitCode}}' mdp-seed 2>$null
        if ($s -eq 'exited|0') { break }
        if ($s -like 'exited|*') { Dc logs --tail 40 seed; Fail 'Loading the course catalog failed.' }
        if ((Get-Date) -gt $deadline) { Fail 'Timed out loading the course catalog. Check: mdp logs' }
        Start-Sleep -Seconds 2
    }
    $url = "http://localhost:$(Get-Port)"
    Write-Host "MyDegreePlan is running at $url  (only this computer can reach it)" -ForegroundColor Green
    New-DesktopShortcut
    if (-not $env:MDP_NO_BROWSER) { Start-Process $url }
}

function Stop-Stack { Test-Docker; Dc down; Write-Host 'Stopped. Your data is kept.' }

function Backup-Data {
    Test-Docker
    if (-not (Test-Path $EnvFile)) { Fail 'Nothing to back up yet (no .env).' }
    $dir = Join-Path $PSScriptRoot 'backups'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $name = 'mdp-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Write-Host 'Stopping the app for a consistent snapshot...'
    Dc down
    docker run --rm -v "${Volume}:/data:ro" -v "${dir}:/backup" alpine tar czf "/backup/$name.tar.gz" -C /data .
    if ($LASTEXITCODE -ne 0) { Fail 'Backup failed.' }
    Copy-Item $EnvFile (Join-Path $dir "$name.env")
    Write-Host "Backup written: backups\$name.tar.gz (+ $name.env)" -ForegroundColor Green
    Write-Host 'These files contain everything in the plan, unencrypted. Store them somewhere private.'
    Start-Stack
}

function Restore-Data {
    Test-Docker
    if (-not $Arg1 -or -not (Test-Path $Arg1)) { Fail 'Usage: mdp restore <path to a .tar.gz made by mdp backup>' }
    $file = (Resolve-Path $Arg1).Path
    $envBackup = $file -replace '\.tar\.gz$', '.env'
    if ((Read-Host 'This REPLACES all current data with the backup. Type RESTORE to continue') -ne 'RESTORE') { Fail 'Cancelled.' }
    Dc down
    docker volume rm -f $Volume | Out-Null
    docker volume create $Volume | Out-Null
    docker run --rm -v "${Volume}:/data" -v "$(Split-Path $file):/backup:ro" alpine tar xzf "/backup/$(Split-Path $file -Leaf)" -C /data
    if ($LASTEXITCODE -ne 0) { Fail 'Restore failed.' }
    if (Test-Path $envBackup) {
        if (Test-Path $EnvFile) { Copy-Item $EnvFile "$EnvFile.bak" -Force }
        Copy-Item $envBackup $EnvFile -Force
        Write-Host 'Restored the matching .env as well.'
    } else {
        Write-Host "No $([IO.Path]::GetFileName($envBackup)) next to the backup; keeping the current .env. If the passwords differ, copy the original .env back." -ForegroundColor Yellow
    }
    Start-Stack
}

function Reset-Password {
    Test-Docker
    if (-not $Arg1) { Fail 'Usage: mdp reset-password <email>' }
    $sec = Read-Host 'New password (min 8 characters)' -AsSecureString
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    if ($pw.Length -lt 8) { Fail 'Password must be at least 8 characters.' }
    $q = { param($s) $s.Replace("'", "''") }
    $sql = "UPDATE auth.users SET encrypted_password = extensions.crypt('$(& $q $pw)', extensions.gen_salt('bf')) WHERE lower(email) = lower('$(& $q $Arg1)');"
    $OutputEncoding = New-Object Text.UTF8Encoding $false   # so non-ASCII passwords survive the pipe
    $sql | Dc exec -T db psql -U postgres -d postgres -q -t -A -f - | Out-Null
    $n = "SELECT count(*) FROM auth.users WHERE lower(email) = lower('$(& $q $Arg1)');" | Dc exec -T db psql -U postgres -d postgres -q -t -A -f -
    if ("$n".Trim() -eq '0') { Fail 'No account with that email.' }
    Write-Host 'Password updated.' -ForegroundColor Green
}

# Talks to the updater over its container-only listener (no login needed: `docker exec`
# already means full Docker access).
function Invoke-Update {
    Test-Docker
    $sub = if ($Arg1 -eq 'apply') { 'apply' } else { 'check' }
    $json = docker exec mdp-updater node src/main.js cli $sub
    if ($LASTEXITCODE -ne 0) { Write-Host $json; Fail 'The updater did not accept that. Is the app running? (mdp start)' }
    $s = ($json -join "`n") | ConvertFrom-Json   # 5.1 wants one string, not a line array
    Write-Host "State: $($s.state)   running: $($s.current.version)   latest: $(if ($s.latest) { $s.latest.version } else { 'unknown' })"
    if ($s.error) { Write-Host "Last check error: $($s.error)" -ForegroundColor Yellow }
    if ($s.lastResult) { Write-Host "Last update: $($s.lastResult.message)"; if ($s.lastResult.detail) { Write-Host "  detail: $($s.lastResult.detail)" } }
    if ($sub -eq 'check' -and $s.updateAvailable) { Write-Host "An update is available. Run: mdp update apply" -ForegroundColor Green }
}

function Wipe-Data {
    Test-Docker
    if ((Read-Host 'This PERMANENTLY deletes every plan and account on this computer. Type DELETE to continue') -ne 'DELETE') { Fail 'Cancelled.' }
    Dc down -v
    Write-Host 'All data deleted.'
}

switch ($Command) {
    'start'          { Start-Stack }
    'stop'           { Stop-Stack }
    'backup'         { Backup-Data }
    'restore'        { Restore-Data }
    'reset-password' { Reset-Password }
    'wipe'           { Wipe-Data }
    'update'         { Invoke-Update }
    'package'        { New-Package }
    'logs'           { Test-Docker; Dc logs --tail 100 }
    'init'           { Initialize-EnvFile }
    default          { Fail "Unknown command '$Command'. Commands: start, stop, backup, restore, reset-password, wipe, update, package, logs" }
}
