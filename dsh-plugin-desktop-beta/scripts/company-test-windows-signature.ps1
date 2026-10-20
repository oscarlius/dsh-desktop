param([Parameter(Mandatory = $true)][string]$Path)
$signature = Get-AuthenticodeSignature -LiteralPath $Path
[pscustomobject]@{
  status = [string]$signature.Status
  statusMessage = [string]$signature.StatusMessage
  signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { [string]$signature.SignerCertificate.Subject }
} | ConvertTo-Json -Compress
