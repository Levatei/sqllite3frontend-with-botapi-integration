﻿# migrate.ps1 - перенос и развёртывание MBA-Garant на Windows.
#
# Подкоманды:
#   check            Проверить окружение (Node, node:sqlite, .env, БД)
#   export [tag]     Упаковать КОД + СОСТОЯНИЕ (БД, .env, whitelist, медиа) в migrate-out\*.zip
#                    Второй аргумент - метка версии: export zip v2 -> mba-garant-v2-*.zip
#   deploy           Установить зависимости и собрать (npm ci + npm run build)
#   serve            Запустить веб-консоль (next start)
#   bot              Запустить Telegram-бота
#   doctor           Проверить, что веб отвечает
#   install-service  Прописать автозапуск: -Method Task (по умолчанию) или -Method Nssm
#
# Адрес и порт веб-консоли берутся из .env (WEB_HOST/WEB_PORT). Параметры
# -BindHost/-Port перекрывают значения из .env.
#
# Примеры:
#   powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 check
#   powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 export zip v2
#   powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 deploy
#   powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 serve
#   powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 bot
#   powershell -ExecutionPolicy Bypass -File scripts\migrate.ps1 install-service -Method Nssm

[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1)][string]$Format = 'zip',
  [ValidateSet('Task', 'Nssm')][string]$Method = 'Task',
  [string]$BindHost = '',
  [int]$Port = 0,
  [string]$OutDir,
  [string]$Tag = ''
)

$ErrorActionPreference = 'Stop'
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $script:Root
if (-not $OutDir) { $OutDir = Join-Path $script:Root 'migrate-out' }

$MinNodeMajor = 24

# ------------------------------- вывод -------------------------------
function Write-Log  { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Message) Write-Host "[ok] $Message" -ForegroundColor Green }
function Write-Warn2 { param([string]$Message) Write-Host "[!] $Message" -ForegroundColor Yellow }
function Fail       { param([string]$Message) Write-Host "[x] $Message" -ForegroundColor Red; exit 1 }

# Get-EnvValue KEY [DEFAULT] - значение из .env (последнее вхождение) или DEFAULT.
function Get-EnvValue {
  param([string]$Key, [string]$Default = '')
  $file = Join-Path $script:Root '.env'
  if (-not (Test-Path -LiteralPath $file)) { return $Default }
  $pattern = "^\s*$([regex]::Escape($Key))\s*="
  $line = Get-Content -LiteralPath $file -ErrorAction SilentlyContinue |
    Where-Object { $_ -match $pattern } | Select-Object -Last 1
  if (-not $line) { return $Default }
  $val = ($line -replace $pattern, '').Trim()
  $val = $val.Trim([char]'"').Trim([char]"'")
  if ([string]::IsNullOrWhiteSpace($val)) { return $Default }
  return $val
}

# Приоритет: параметр > .env > значение по умолчанию
if (-not $BindHost) { $BindHost = Get-EnvValue 'WEB_HOST' (Get-EnvValue 'HOST' '127.0.0.1') }
if ($Port -le 0) {
  $portRaw = Get-EnvValue 'WEB_PORT' (Get-EnvValue 'PORT' '3000')
  $portNum = 0
  if ([int]::TryParse($portRaw, [ref]$portNum) -and $portNum -gt 0) { $Port = $portNum }
  else { Write-Warn2 "Некорректный порт в .env ('$portRaw') - использую 3000"; $Port = 3000 }
}

function Show-Usage {
  foreach ($line in (Get-Content -LiteralPath $PSCommandPath)) {
    if ($line -notmatch '^\s*#') { break }
    ($line -replace '^#\s?', '')
  }
}

# ------------------------------- хелперы -------------------------------
function Invoke-NodeScript {
  param([string]$Script, [string[]]$Arguments = @(), [switch]$PassThru)
  $tmp = Join-Path $env:TEMP ('mba-node-' + [guid]::NewGuid().ToString('N') + '.js')
  [System.IO.File]::WriteAllText($tmp, $Script, (New-Object System.Text.UTF8Encoding($false)))
  try {
    if ($PassThru) { & node $tmp @Arguments } else { & node $tmp @Arguments | Out-Null }
    return $LASTEXITCODE
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Assert-Node {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'Node.js не найден. Установите: winget install OpenJS.NodeJS.LTS (см. REQUIREMENTS.md)'
  }
  $ver = (& node -p 'process.versions.node').Trim()
  $major = [int]($ver.Split('.')[0])
  if ($major -lt $MinNodeMajor) {
    Write-Warn2 "Node v$ver < $MinNodeMajor - рекомендуется Node $MinNodeMajor+ (для node:sqlite)"
  }
  $code = Invoke-NodeScript -Script "new (require('node:sqlite').Database)(':memory:');"
  if ($code -ne 0) {
    Fail 'node:sqlite недоступен. Нужен Node 24+ (на 22.x - флаг --experimental-sqlite)'
  }
  return $ver
}

function Get-Databases {
  $dirs = @($script:Root, (Join-Path $script:Root 'databases'))
  foreach ($d in $dirs) {
    if (Test-Path -LiteralPath $d) {
      Get-ChildItem -LiteralPath $d -File -Filter '*.db' -ErrorAction SilentlyContinue
    }
  }
}

function Get-RelPath {
  param([string]$FullPath)
  return $FullPath.Substring($script:Root.Length).TrimStart('\', '/')
}

function Invoke-DbSnapshot {
  param([string]$Source, [string]$Destination)
  $parent = Split-Path -Parent $Destination
  if ($parent -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  $js = @'
const { Database } = require('node:sqlite');
const src = process.argv[2];
const dst = process.argv[3];
const db = new Database(src, { readOnly: true });
db.exec("VACUUM INTO '" + dst.replace(/'/g, "''") + "'");
db.close();
'@
  $code = Invoke-NodeScript -Script $js -Arguments @($Source, $Destination)
  if ($code -ne 0) { Fail "Не удалось снять снимок БД: $Source" }
}

# ------------------------------- check -------------------------------
function Invoke-Check {
  Write-Log 'Проверка окружения'
  $ver = Assert-Node
  Write-Ok "Node v$ver"

  if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
    Write-Ok "npm $((& npm -v).Trim())"
  } else {
    Fail 'npm не найден (идёт в комплекте с Node.js)'
  }

  if (Test-Path -LiteralPath (Join-Path $script:Root '.env')) { Write-Ok '.env найден' }
  else { Write-Warn2 '.env отсутствует - скопируйте .env.example в .env и заполните' }

  if (Test-Path -LiteralPath (Join-Path $script:Root 'whitelist.json')) { Write-Ok 'whitelist.json найден' }
  else { Write-Warn2 'whitelist.json отсутствует - скопируйте whitelist.example.json' }

  $dbs = @(Get-Databases)
  if ($dbs.Count -gt 0) {
    Write-Ok 'Найдены базы данных:'
    $dbs | ForEach-Object { Write-Host "     $(Get-RelPath $_.FullName)" }
  } else {
    Write-Warn2 'Базы данных не найдены. Положите *.db в корень проекта.'
  }

  $reg = Join-Path $script:Root 'dblist.json'
  if (Test-Path -LiteralPath $reg) {
    $active = try { (Get-Content -LiteralPath $reg -Raw | ConvertFrom-Json).active } catch { '?' }
    Write-Ok "dblist.json найден (активная БД: $active)"
  } else {
    Write-Warn2 'dblist.json отсутствует - будет создан по умолчанию (mba_data.db)'
  }

  if (Test-Path -LiteralPath (Join-Path $script:Root 'bot\storage')) { Write-Ok 'bot\storage на месте' }
  else { Write-Warn2 'bot\storage отсутствует - медиафайлы не найдутся' }

  Write-Ok "Веб-консоль: http://${BindHost}:${Port}"

  if (Get-Command tailscale -ErrorAction SilentlyContinue) {
    Write-Ok 'tailscale найден (проверьте: tailscale status)'
  } else {
    Write-Warn2 'Tailscale не установлен (опционально)'
  }
}

# ------------------------------- export -------------------------------
function Invoke-Export {
  param([string]$Fmt = 'zip')
  if ($Fmt -ne 'zip') { Write-Warn2 'На Windows поддерживается только zip - использую zip.' }
  $null = Assert-Node

  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
  $suffix = ''
  if ($Tag) { $suffix = "-$Tag" }
  $name = "mba-garant$suffix-$stamp"
  if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  }
  $stage = Join-Path $OutDir $name
  if (Test-Path -LiteralPath $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  Write-Log "Собираю пакет переноса в $stage"

  # 1. Код и конфиги, кроме состояния и артефактов
  if (-not (Get-Command robocopy -ErrorAction SilentlyContinue)) {
    Fail 'robocopy не найден (нужен Windows Vista+). Скопируйте проект вручную.'
  }
  & robocopy $script:Root $stage /E /NFL /NDL /NJH /NJS /NP `
    /XD node_modules .next .git logs migrate-out .vercel `
    /XF *.db *.db-wal *.db-shm *.tsbuildinfo *.zip *.tgz *.tar.gz | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "robocopy завершился с ошибкой (код $LASTEXITCODE)" }

  # 2. Консистентные снимки баз (VACUUM INTO, без WAL-обломков)
  foreach ($db in @(Get-Databases)) {
    $rel = Get-RelPath $db.FullName
    Write-Log "  снимок БД: $rel"
    Invoke-DbSnapshot -Source $db.FullName -Destination (Join-Path $stage $rel)
  }

  # 3. Архив (ZipFile включает и скрытые файлы вроде .env)
  $archive = Join-Path $OutDir "$name.zip"
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  Remove-Item -Recurse -Force $stage

  Write-Ok "Готово: $archive"
  Write-Host ''
  Write-Host 'Содержимое включает СЕКРЕТЫ (.env, whitelist.json) и БД - передавайте приватно.'
  Write-Host 'Передача по Tailscale:  tailscale file cp "<архив>" <target>:'
}

# ------------------------------- deploy -------------------------------
function Invoke-Deploy {
  $null = Assert-Node
  if (-not (Test-Path -LiteralPath (Join-Path $script:Root '.env'))) {
    Copy-Item (Join-Path $script:Root '.env.example') (Join-Path $script:Root '.env')
    Write-Warn2 '.env создан из примера - заполните его!'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'whitelist.json'))) {
    Copy-Item (Join-Path $script:Root 'whitelist.example.json') (Join-Path $script:Root 'whitelist.json')
    Write-Warn2 'whitelist.json создан из примера - впишите chat_id'
  }

  Write-Log 'Устанавливаю зависимости (npm ci)'
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci завершился с ошибкой' }

  Write-Log 'Сборка (npm run build)'
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { Fail 'сборка завершилась с ошибкой' }

  Write-Ok 'Развёртывание завершено. Запуск: .\scripts\migrate.ps1 serve'
}

# ------------------------------- serve / bot -------------------------------
function Invoke-Serve {
  $null = Assert-Node
  Write-Log "Запуск веб-консоли на http://${BindHost}:${Port}"
  & npm.cmd start -- -H $BindHost -p $Port
}

function Invoke-Bot {
  $null = Assert-Node
  Write-Log 'Запуск Telegram-бота'
  & npm.cmd run bot
}

# ------------------------------- doctor -------------------------------
function Invoke-Doctor {
  $base = "http://${BindHost}:${Port}"
  Write-Log "Проверка $base"
  foreach ($p in @('/', '/api/tables')) {
    try {
      $r = Invoke-WebRequest -Uri "$base$p" -UseBasicParsing -TimeoutSec 10
      Write-Host ("  {0,-14} -> {1}" -f $p, $r.StatusCode)
    } catch {
      Write-Host ("  {0,-14} -> ошибка: {1}" -f $p, $_.Exception.Message)
    }
  }
}

# --------------------------- install-service ---------------------------
function Invoke-InstallService {
  $null = Assert-Node
  $node = (Get-Command node).Source
  $nextBin = Join-Path $script:Root 'node_modules\next\dist\bin\next'
  $tsxBin = Join-Path $script:Root 'node_modules\tsx\dist\cli.mjs'
  $botEntry = Join-Path $script:Root 'bot\index.ts'

  if (-not (Test-Path -LiteralPath $nextBin)) { Fail 'Сначала выполните deploy (нет node_modules)' }

  if ($Method -eq 'Nssm') {
    if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
      Fail 'nssm не найден. Установите: winget install nssm'
    }
    & nssm install 'MBA-Garant-Web' $node "$nextBin start -H $BindHost -p $Port"
    & nssm set 'MBA-Garant-Web' AppDirectory $script:Root
    & nssm set 'MBA-Garant-Web' Start SERVICE_AUTO_START
    & nssm install 'MBA-Garant-Bot' $node "$tsxBin $botEntry"
    & nssm set 'MBA-Garant-Bot' AppDirectory $script:Root
    & nssm set 'MBA-Garant-Bot' Start SERVICE_AUTO_START
    Write-Ok 'Службы созданы (реальный сервис с автостартом).'
    Write-Host 'Запуск:  nssm start MBA-Garant-Web ; nssm start MBA-Garant-Bot'
    return
  }

  # Task Scheduler
  $webArgs = "`"$nextBin`" start -H $BindHost -p $Port"
  $botArgs = "`"$tsxBin`" `"$botEntry`""

  try {
    $actionW = New-ScheduledTaskAction -Execute $node -Argument $webArgs -WorkingDirectory $script:Root
    $actionB = New-ScheduledTaskAction -Execute $node -Argument $botArgs -WorkingDirectory $script:Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName 'MBA-Garant Web' -Action $actionW -Trigger $trigger `
      -Settings $settings -Description 'MBA-Garant web console' -Force | Out-Null
    Register-ScheduledTask -TaskName 'MBA-Garant Bot' -Action $actionB -Trigger $trigger `
      -Settings $settings -Description 'MBA-Garant Telegram bot' -Force | Out-Null
  } catch {
    Fail "Не удалось создать задачи. Запустите PowerShell от имени администратора. Детали: $($_.Exception.Message)"
  }

  Write-Ok "Задачи созданы (автозапуск при входе; http://${BindHost}:${Port})."
  Write-Host "Запустить сейчас:   Start-ScheduledTask -TaskName 'MBA-Garant Web'"
  Write-Host "Остановить:         Stop-ScheduledTask  -TaskName 'MBA-Garant Web'"
  Write-Host 'Полноценную службу без окна консоли даёт: install-service -Method Nssm'
}

# ------------------------------- диспетчер -------------------------------
switch ($Command.ToLower()) {
  'check'           { Invoke-Check }
  'export'          { Invoke-Export -Fmt $Format }
  'deploy'          { Invoke-Deploy }
  'serve'           { Invoke-Serve }
  'bot'             { Invoke-Bot }
  'doctor'          { Invoke-Doctor }
  'install-service' { Invoke-InstallService }
  default           { Show-Usage }
}
