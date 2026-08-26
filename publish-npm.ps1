# Publish cadet-token-saver to npm using a granular access token.
#
# The token file (~/.npm_token) must contain ONLY the token, created at
# https://www.npmjs.com/settings/<user>/tokens with "Publish" permission and
# "Bypass 2FA" enabled. The token is used inline and never persisted to npm
# config or any repo file.
$ErrorActionPreference = "Stop"

$tokenPath = Join-Path $HOME ".npm_token"
if (-not (Test-Path $tokenPath)) {
    Write-Error "No npm token found at $tokenPath. Create a granular access token at https://www.npmjs.com/settings/<user>/tokens (Publish permission, Bypass 2FA) and save it to $tokenPath."
    exit 1
}
$token = (Get-Content $tokenPath -Raw).Trim()
if ([string]::IsNullOrEmpty($token)) {
    Write-Error "npm token file at $tokenPath is empty."
    exit 1
}

# Normalize LF line endings so the bin shebang works on Unix (Windows git can
# otherwise check files out with CRLF).
$dist = Join-Path $PSScriptRoot "dist"
if (Test-Path $dist) {
    Get-ChildItem $dist -Recurse -File | ForEach-Object {
        $content = [System.IO.File]::ReadAllText($_.FullName)
        $content = $content -replace "`r`n", "`n"
        [System.IO.File]::WriteAllText($_.FullName, $content)
    }
}

try {
    npm run prepublishOnly
    if ($LASTEXITCODE -ne 0) { throw "prepublishOnly failed" }
    npm whoami --//registry.npmjs.org/:_authToken=$token
    if ($LASTEXITCODE -ne 0) { throw "npm authentication failed" }
    npm publish --//registry.npmjs.org/:_authToken=$token
    if ($LASTEXITCODE -ne 0) { throw "npm publish failed" }
}
finally {
    npm config delete "//registry.npmjs.org/:_authToken" 2>$null
}
