[CmdletBinding()]
param(
  [string]$BaseUrl = "https://app.zellinkstudio.com"
)

$ErrorActionPreference = "Stop"

function Convert-SecureStringToPlainText([System.Security.SecureString]$Value) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$secretPath = Join-Path $repositoryRoot ".secrets\production-bootstrap"
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
  throw "Bootstrap secret file not found: $secretPath. Retrieve the secret through your approved secret storage."
}

$setupSecret = [System.IO.File]::ReadAllText($secretPath).Trim()
if ($setupSecret.Length -lt 32) {
  throw "Bootstrap secret file is empty or too short."
}

$email = (Read-Host "Super-admin email address").Trim()
$displayName = (Read-Host "Super-admin display name").Trim()
$securePassword = Read-Host "Choose an initial password (12+ characters)" -AsSecureString
$securePasswordConfirmation = Read-Host "Confirm the initial password" -AsSecureString

if ($securePassword.Length -lt 12) {
  throw "The initial password must be at least 12 characters."
}

$password = Convert-SecureStringToPlainText $securePassword
$passwordConfirmation = Convert-SecureStringToPlainText $securePasswordConfirmation
if ($password -cne $passwordConfirmation) {
  throw "The password entries did not match."
}

$body = @{
  email       = $email
  displayName = $displayName
  password    = $password
} | ConvertTo-Json -Compress

try {
  $uri = "$($BaseUrl.TrimEnd('/'))/api/auth/bootstrap"
  $result = Invoke-RestMethod -Method Post -Uri $uri `
    -Headers @{ "X-Setup-Secret" = $setupSecret } `
    -ContentType "application/json" `
    -Body $body

  if (-not $result.authenticated -or $result.actor.globalRole -ne "super_admin") {
    throw "The server response did not confirm super-admin creation."
  }

  Write-Host "Created the first super-admin account for $($result.actor.email)."
  Write-Host "Sign in at $($BaseUrl.TrimEnd('/')) with that email and the password you entered."
  Write-Host "After verifying sign-in, remove BOOTSTRAP_SECRET from the Worker and delete the local secret file."
} catch {
  $detail = $_.ErrorDetails.Message
  if ([string]::IsNullOrWhiteSpace($detail)) {
    throw "Bootstrap failed: $($_.Exception.Message)"
  }
  throw "Bootstrap failed: $detail"
} finally {
  $setupSecret = $null
  $password = $null
  $passwordConfirmation = $null
  $body = $null
  $securePassword.Dispose()
  $securePasswordConfirmation.Dispose()
}
