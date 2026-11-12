param([switch]$Gemini)

$ErrorActionPreference = 'Stop'
$saneiaPreviousKey = $env:GEMINI_API_KEY
Push-Location -LiteralPath $PSScriptRoot
try {
    if ($Gemini -and -not $env:GEMINI_API_KEY) {
        $saneiaSecret = Read-Host 'Chave Gemini (entrada oculta)' -AsSecureString
        if ($saneiaSecret.Length -eq 0) { throw 'Informe a chave Gemini.' }
        $saneiaPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($saneiaSecret)
        try { $env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($saneiaPointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($saneiaPointer) }
    }

    npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw 'A ponte IoT encerrou com erro.' }
} finally {
    $env:GEMINI_API_KEY = $saneiaPreviousKey
    Pop-Location
}
