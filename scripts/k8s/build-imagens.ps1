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
        @{ Tag = 'aps-migrate:etapa3-v5'; Dockerfile = 'api-alagamento-inundacao/Dockerfile'; Target = 'migrate' },
        @{ Tag = 'aps-alagamento:etapa4-v1'; Dockerfile = 'api-alagamento-inundacao/Dockerfile'; Target = 'runtime' },
        @{ Tag = 'aps-qualidade-ar:etapa4-v1'; Dockerfile = 'api-qualidade-do-ar/Dockerfile'; Target = 'runtime' },
        @{ Tag = 'aps-transito:etapa4-v1'; Dockerfile = 'api-transito-e-transporte/Dockerfile'; Target = 'runtime' },
        @{ Tag = 'aps-worker:etapa3-v5.1'; Dockerfile = 'api-alagamento-inundacao/Dockerfile'; Target = 'worker' }
    )
    foreach ($image in $images) {
        & docker build --file $image.Dockerfile --target $image.Target --tag $image.Tag .
        if ($LASTEXITCODE -ne 0) { throw "Falha ao construir $($image.Tag)." }
    }
    Write-Output 'Imagens construidas: APIs etapa4-v1, migration etapa3-v5 e worker etapa3-v5.1. Tags do Compose preservadas.'
} finally {
    Pop-Location
}
