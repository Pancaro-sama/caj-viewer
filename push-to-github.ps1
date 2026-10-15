# push-to-github.ps1 -- push the caj-viewer repo to GitHub.
#
# WHY THIS SCRIPT EXISTS (read me):
#   This machine's Windows TLS stack (Schannel) is broken and fails with
#   SEC_E_NO_CREDENTIALS (0x8009030E), so git / curl / Invoke-WebRequest cannot
#   reach ANY https site. The fix is to make git use its OpenSSL backend together
#   with a PEM exported from the Windows root certificate store.
#   The repo-local .git/config already carries those two settings
#   (http.sslBackend=openssl, http.sslCAInfo=.git/system-ca.pem), so a plain
#   `git push` normally just works. This script additionally:
#     1) recreates the CA PEM if it is missing (e.g. after moving/reinstalling);
#     2) rewrites the settings with an absolute path, in case a relative path
#        stops resolving from a different working directory;
#     3) runs a read-only connectivity self-check so failures are explained.
#
# USAGE (in PowerShell, after cd into this directory):
#   .\push-to-github.ps1
# With another remote:
#   .\push-to-github.ps1 -Remote https://github.com/<user>/<repo>.git
#
# Note: this file is intentionally pure ASCII. Windows PowerShell 5.1 reads
# BOM-less files as ANSI (GBK here), which corrupts non-ASCII text and can even
# break parsing. Keep it ASCII-only.

param(
  [string]$Remote = 'https://github.com/Pancaro-sama/caj-viewer.git',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'

function Write-Info([string]$m) { Write-Host $m }
function Stop-Fail([string]$m) { Write-Host $m -ForegroundColor Red; exit 1 }

$repo = $PSScriptRoot
Set-Location $repo

# --- 1. basic checks ---------------------------------------------------------
if (-not (Test-Path (Join-Path $repo '.git'))) { Stop-Fail 'Not a git repository (no .git directory here).' }

$ca = Join-Path $repo '.git\system-ca.pem'
if (-not (Test-Path $ca)) {
  Write-Info ('CA bundle missing at ' + $ca)
  Write-Info 'Re-exporting from the Windows root certificate store...'
  New-Item -ItemType Directory -Force (Split-Path $ca) | Out-Null
  $count = node --use-system-ca -e "const fs=require('fs'),tls=require('tls');const l=tls.getCACertificates('system');fs.writeFileSync(process.argv[1],l.join('\n')+'\n');console.log(l.length)" $ca
  if (-not (Test-Path $ca)) { Stop-Fail 'CA export failed. Is node available (node --version)?' }
  Write-Info ('      exported ' + $count + ' root certificates')
}

# --- 2. force OpenSSL backend + this CA --------------------------------------
& git config http.sslBackend openssl
& git config http.sslCAInfo $ca

Write-Info ('repo   : ' + $repo)
Write-Info ('branch : ' + (& git branch --show-current))
Write-Info ('remote : ' + $Remote)
Write-Info ('tls    : http.sslBackend=' + (& git config --get http.sslBackend) + '  sslCAInfo=' + (& git config --get http.sslCAInfo))

# --- 3. read-only connectivity self-check ------------------------------------
$env:GIT_TERMINAL_PROMPT = '0'
Write-Info ''
Write-Info '[1/3] Checking HTTPS connectivity to GitHub (public repo, read-only)...'
$probe = & git ls-remote --heads https://github.com/git/git 2>&1
if ($LASTEXITCODE -ne 0) {
  $probe | ForEach-Object { Write-Info ('      ' + $_) }
  Stop-Fail 'Cannot reach GitHub. If you see schannel / SEC_E_NO_CREDENTIALS, git ignored the OpenSSL settings above.'
}
Write-Info ('      OK, got ' + $probe.Count + ' refs')

# --- 4. make sure origin points at the right place ---------------------------
Write-Info ''
Write-Info '[2/3] Configuring remote origin...'
if ((& git remote) -contains 'origin') { & git remote set-url origin $Remote } else { & git remote add origin $Remote }
Write-Info ('      origin -> ' + (& git remote get-url origin))

# --- 5. push -----------------------------------------------------------------
Write-Info ''
Write-Info ('[3/3] Pushing to origin/' + $Branch + ' ...')
Write-Info '      The first push opens a GitHub login window (browser authorization).'
Write-Info '      If the repository does not exist yet, create an EMPTY one first at'
Write-Info '      https://github.com/new -- name it caj-viewer, tick nothing'
Write-Info '      (no README / .gitignore / LICENSE), then re-run this script.'
Write-Info ''
& git push -u origin $Branch
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'Push failed. Common causes:' -ForegroundColor Red
  Write-Host '  1) remote repository does not exist  -> create an empty repo at https://github.com/new'
  Write-Host '  2) wrong user or repo name           -> re-run with -Remote https://github.com/<user>/<repo>.git'
  Write-Host '  3) login prompt was cancelled        -> re-run this script and finish the browser login'
  Write-Host ('  4) remote already has commits        -> git pull --rebase origin ' + $Branch + ', then re-run')
  exit 1
}

Write-Info ''
Write-Info ('Done. Repository: ' + ($Remote -replace '\.git$',''))
