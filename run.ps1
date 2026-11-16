# Run with PIN loaded from the local .env file by enrollment-performance.js.
# The FIDO2 PIN is never passed as a command line argument or typed at a prompt.
param(
    [switch]$FreshLogin,
    [switch]$ManualPin
)
$ErrorActionPreference = 'Stop'
$exitCode = 1
Push-Location $PSScriptRoot
try {
    $nodeArguments = @('enrollment-performance.js')
    if ($FreshLogin) { $nodeArguments += '--fresh-login' }
    if ($ManualPin) { $nodeArguments += '--manual-pin' }
    & node @nodeArguments
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
