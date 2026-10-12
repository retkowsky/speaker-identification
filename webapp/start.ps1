param([int]$Port = 8765)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    throw "Missing virtual environment. Follow the setup steps in README.md first."
}
if (-not (Test-Path (Join-Path $PSScriptRoot "data\model\embedding_model.ckpt"))) {
    & $python prepare_assets.py
    if ($LASTEXITCODE -ne 0) { throw "Could not prepare bundled model assets." }
}
$tokenBytes = New-Object byte[] 32
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
$env:VOICE_APP_TOKEN = [Convert]::ToBase64String($tokenBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$url = "http://127.0.0.1:$Port/?token=$env:VOICE_APP_TOKEN"
Write-Host "Speaker Identification: $url"
Write-Host "First startup builds the local reference cache. Press Ctrl+C to stop."
& $python -m uvicorn app:app --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
