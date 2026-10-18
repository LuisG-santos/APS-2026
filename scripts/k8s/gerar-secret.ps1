[CmdletBinding()]
param(
    [string]$EnvFile,
    [string]$OutputFile,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $EnvFile) { $EnvFile = Join-Path $projectRoot '.env.k8s' }
if (-not $OutputFile) { $OutputFile = Join-Path $projectRoot 'k8s/02-secret.local.yaml' }
$EnvFile = [System.IO.Path]::GetFullPath($EnvFile)
$OutputFile = [System.IO.Path]::GetFullPath($OutputFile)

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw 'Copie .env.k8s.example para .env.k8s e defina POSTGRES_PASSWORD antes de gerar o Secret.'
}
if ((Test-Path -LiteralPath $OutputFile) -and -not $Force) {
    throw 'O Secret local ja existe. Reutilize-o; para substituir o arquivo conscientemente, use -Force.'
}

$settings = @{}
foreach ($line in [System.IO.File]::ReadAllLines($EnvFile, [System.Text.Encoding]::UTF8)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { throw 'Linha invalida no .env.k8s. Use CHAVE=valor.' }
    $key = $trimmed.Substring(0, $separator).Trim()
    if ($key -notin @('POSTGRES_USER', 'POSTGRES_PASSWORD')) {
        throw "Chave nao reconhecida no .env.k8s: $key"
    }
    if ($settings.ContainsKey($key)) { throw "Chave repetida no .env.k8s: $key" }
    $value = $trimmed.Substring($separator + 1).Trim()
    if ($value.Length -ge 2 -and (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
    )) { $value = $value.Substring(1, $value.Length - 2) }
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Valor obrigatorio no .env.k8s: $key" }
    $settings[$key] = $value
}
foreach ($key in @('POSTGRES_USER', 'POSTGRES_PASSWORD')) {
    if (-not $settings.ContainsKey($key)) { throw "Defina $key no .env.k8s." }
}
if ($settings.POSTGRES_PASSWORD -in @('defina-uma-senha', 'change-me', 'SUBSTITUA_LOCALMENTE')) {
    throw 'Substitua a senha de exemplo no .env.k8s.'
}

function ConvertTo-Base64([string]$Value) {
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Value))
}

$userEncoded = [Uri]::EscapeDataString($settings.POSTGRES_USER)
$passwordEncoded = [Uri]::EscapeDataString($settings.POSTGRES_PASSWORD)
$databaseUrl = 'postgresql://{0}:{1}@banco:5432/aps?connection_limit=5&pool_timeout=3&connect_timeout=2' -f $userEncoded, $passwordEncoded
$secret = [ordered]@{
    apiVersion = 'v1'
    kind = 'Secret'
    metadata = [ordered]@{ name = 'aps-db'; namespace = 'aps' }
    type = 'Opaque'
    data = [ordered]@{
        POSTGRES_USER = ConvertTo-Base64 $settings.POSTGRES_USER
        POSTGRES_PASSWORD = ConvertTo-Base64 $settings.POSTGRES_PASSWORD
        DATABASE_URL = ConvertTo-Base64 $databaseUrl
    }
}

[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($OutputFile)) | Out-Null
# JSON tambem e YAML valido e dispensa modulos extras no PowerShell.
[System.IO.File]::WriteAllText($OutputFile, ($secret | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
Write-Output "Secret gravado em $OutputFile. As credenciais nao foram exibidas."
