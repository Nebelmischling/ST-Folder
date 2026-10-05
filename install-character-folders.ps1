#Requires -Version 5.1
<#
.SYNOPSIS
    Installiert die Extension "Character Folders" in eine vorhandene SillyTavern-Installation.

.DESCRIPTION
    Kopiert den Ordner character-folders nach <SillyTavern>/data/<Handle>/extensions/.
    Standardmäßig wird der Handle automatisch erkannt, wenn genau ein Benutzerverzeichnis
    existiert. Es werden nur Dateien der Extension kopiert, nichts am SillyTavern-Code geändert.

.EXAMPLE
    pwsh -File .\install-character-folders.ps1 -SillyTavernPath 'D:\SillyTavern'

.EXAMPLE
    # Global für alle Benutzer (nur sinnvoll, wenn du Admin bist)
    pwsh -File .\install-character-folders.ps1 -SillyTavernPath 'D:\SillyTavern' -Global
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SillyTavernPath,

    [string]$Handle,

    [switch]$Global,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'character-folders'
if (-not (Test-Path $source)) {
    throw "Quellordner nicht gefunden: $source"
}

$stRoot = (Resolve-Path $SillyTavernPath).Path
if (-not (Test-Path (Join-Path $stRoot 'server.js'))) {
    throw "'$stRoot' sieht nicht wie eine SillyTavern-Installation aus (server.js fehlt)."
}

if ($Global) {
    $destination = Join-Path $stRoot 'public\scripts\extensions\third-party\character-folders'
}
else {
    $dataRoot = Join-Path $stRoot 'data'
    if (-not (Test-Path $dataRoot)) {
        throw "Kein data-Verzeichnis unter '$stRoot' gefunden. Starte SillyTavern einmal, damit es angelegt wird."
    }

    if (-not $Handle) {
        # @(...) forces an array, otherwise a single handle would be indexed as a string in PowerShell 5.1.
        $handles = @(Get-ChildItem $dataRoot -Directory | Where-Object { $_.Name -ne '_uploads' } | Select-Object -ExpandProperty Name)
        if ($handles.Count -eq 0) {
            throw "Kein Benutzerverzeichnis unter '$dataRoot' gefunden. Starte SillyTavern einmal oder gib -Handle an."
        }
        if ($handles.Count -gt 1) {
            throw "Mehrere Benutzerverzeichnisse gefunden ($($handles -join ', ')). Bitte -Handle angeben."
        }
        $Handle = $handles[0]
    }

    $destination = Join-Path $dataRoot (Join-Path $Handle 'extensions\character-folders')
}

if (Test-Path $destination) {
    $resolvedDestination = (Resolve-Path $destination).Path
    if ($resolvedDestination -eq (Resolve-Path $source).Path) {
        throw "Quelle und Ziel sind identisch ($resolvedDestination). Dieses Skript ist fuer eine andere SillyTavern-Installation gedacht."
    }
    if (-not $Force) {
        throw "Zielordner existiert bereits: $destination. Nutze -Force zum Aktualisieren."
    }
    Remove-Item $destination -Recurse -Force
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item (Join-Path $source '*') -Destination $destination -Recurse -Force

Write-Host "Character Folders installiert nach:" -ForegroundColor Green
Write-Host "  $destination"
Write-Host ''
Write-Host 'Naechste Schritte:'
Write-Host '  1) SillyTavern neu starten (oder Seite mit Strg+F5 neu laden).'
Write-Host '  2) Im Character Management links das Panel "Folders" oeffnen.'
Write-Host '  3) Optional: Panel -> "..." -> "Create folders from tags" fuer den Einstieg.'
Write-Host ''
if ($Global) {
    Write-Host 'Hinweis: global installierte Extensions werden nur fuer Administratoren geladen.' -ForegroundColor Yellow
}
