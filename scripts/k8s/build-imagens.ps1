[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location -LiteralPath $projectRoot
try {
    $serverOs = & docker version --format '{{.Server.Os}}'
    if ($LASTEXITCODE -ne 0) { throw 'Inicie o Docker Desktop e aguarde o engine ficar pronto.' }
    if ($serverOs -ne 'linux') { throw 'Selecione Linux containers no Docker Desktop.' }

    $images = @(
        @{ Tag = 'aps-migrate:etapa3-v1'; Dockerfile = 'api-alagamento-inundacao/Dockerfile'; Target = 'migrate' },
        @{ Tag = 'aps-alagamento:etapa3-v1'; Dockerfile = 'api-alagamento-inundacao/Dockerfile'; Target = 'runtime' },
        @{ Tag = 'aps-qualidade-ar:etapa3-v1'; Dockerfile = 'api-qualidade-do-ar/Dockerfile'; Target = 'runtime' },
        @{ Tag = 'aps-transito:etapa3-v1'; Dockerfile = 'api-transito-e-transporte/Dockerfile'; Target = 'runtime' }
    )
    foreach ($image in $images) {
        & docker build --file $image.Dockerfile --target $image.Target --tag $image.Tag .
        if ($LASTEXITCODE -ne 0) { throw "Falha ao construir $($image.Tag)." }
    }
    Write-Output 'As quatro imagens da etapa 3 foram construidas. As tags do Compose foram preservadas.'
} finally {
    Pop-Location
}
