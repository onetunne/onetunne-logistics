<#
.SYNOPSIS
  Встановлення універсального помічника Claude на Windows 10/11.
.DESCRIPTION
  Ставить безкоштовні інструменти (winget/uv/npm), інструменти помічника (mtk, llm-local, захист),
  визначає залізо ПК, підбирає локальні моделі і розгортає глобальну конфігурацію Claude (~/.claude).
  Перед кожним етапом питає підтвердження; нічого не видаляє; існуючі налаштування зберігає (злиття + резервна копія).
.PARAMETER Mode
  Minimal | Recommended (за замовчуванням) | Full
.PARAMETER DryRun
  Лише показати план. Нічого не встановлювати й не змінювати.
.PARAMETER Yes
  Не питати підтвердження.
.PARAMETER SkipModels
  Не завантажувати локальні моделі Ollama.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [ValidateSet('Minimal', 'Recommended', 'Full')]
    [string]$Mode = 'Recommended',
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$SkipModels
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$IsWin = ($env:OS -eq 'Windows_NT')
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$AssistantHome = Join-Path $HomeDir '.claude-assistant'
$Catalog = Get-Content -Raw -Encoding UTF8 (Join-Path $Root 'config\components.json') | ConvertFrom-Json
$Results = New-Object System.Collections.ArrayList
$script:Transcript = $false

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }
function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Get-Prop($Obj, [string]$Name) {
    if ($null -ne $Obj -and $Obj.PSObject.Properties[$Name]) { return $Obj.$Name }
    return $null
}
function Confirm-Step([string]$Question) {
    if ($Yes -or $DryRun) { return $true }
    $a = Read-Host "$Question [Enter = так / n = ні]"
    return ($a -eq '' -or $a -match '^(т|так|t|y|yes)$')
}
function Test-Cmd([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
function Update-SessionPath {
    if (-not $IsWin) { return }
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $extra = @((Join-Path $HomeDir '.local\bin'), (Join-Path $env:APPDATA 'npm'))
    $env:Path = (@($machine, $user) + $extra | Where-Object { $_ }) -join ';'
}
function Add-Result([string]$Name, [string]$Status, [string]$Note = '') {
    [void]$Results.Add([pscustomobject]@{ Name = $Name; Status = $Status; Note = $Note })
}
function Invoke-Native([string]$File, [string[]]$Arguments) {
    if ($DryRun) { Say ("  (план) $File " + ($Arguments -join ' ')) 'DarkGray'; return 0 }
    & $File @Arguments | Out-Host   # output to the console, not into the function's return value
    return $LASTEXITCODE
}

function Install-Component($C) {
    $id = $C.id; $name = $C.name
    $check = Get-Prop $C 'check'
    $winget = Get-Prop $C 'winget'
    if ($check -and (Test-Cmd $check)) { Say "  ✓ $name — вже є"; Add-Result $name 'вже було'; return }
    if ($winget) {
        if ($IsWin -and -not $check) {
            & winget list --id $winget -e --accept-source-agreements *> $null
            if ($LASTEXITCODE -eq 0) { Say "  ✓ $name — вже є"; Add-Result $name 'вже було'; return }
        }
        Say "  → $name ($winget)"
        $code = Invoke-Native 'winget' @('install', '--id', $winget, '-e', '--accept-package-agreements', '--accept-source-agreements', '--silent', '--disable-interactivity')
        # -1978335189 = вже актуально, -1978335135 = вже встановлено
        if ($code -eq 0 -or $code -eq -1978335189 -or $code -eq -1978335135) { Add-Result $name ($(if ($DryRun) { 'план' } else { 'встановлено' })) }
        else { Add-Result $name 'ПОМИЛКА' "winget код $code — встановіть вручну"; Say "  ! $name не встановлено (код $code)" 'Yellow' }
        Update-SessionPath
        return
    }
    $uvTool = Get-Prop $C 'uv_tool'
    if ($uvTool) {
        Say "  → $name (uv tool install $uvTool)"
        $code = Invoke-Native 'uv' @('tool', 'install', '--python', '3.12', $uvTool)
        if ($code -eq 0) { Add-Result $name ($(if ($DryRun) { 'план' } else { 'встановлено' })) } else { Add-Result $name 'ПОМИЛКА' "uv код $code" }
        return
    }
    $npm = Get-Prop $C 'npm_global'
    if ($npm) {
        if (-not $DryRun -and -not (Test-Cmd 'npm')) { Add-Result $name 'пропущено' 'немає Node.js'; return }
        Say "  → $name (npm install -g $npm)"
        $code = Invoke-Native 'npm' @('install', '-g', $npm)
        $post = Get-Prop $C 'post'
        if ($code -eq 0 -and $post) {
            Update-SessionPath
            $parts = $post -split ' '
            [void](Invoke-Native $parts[0] ([string[]]($parts | Select-Object -Skip 1)))
        }
        if ($code -eq 0) { Add-Result $name ($(if ($DryRun) { 'план' } else { 'встановлено' })) } else { Add-Result $name 'ПОМИЛКА' "npm код $code" }
        return
    }
}

# ------------------------------------------------------------------ старт
Say ''
Say 'Універсальний помічник Claude — встановлення' 'White'
Say "Режим: $Mode$(if ($DryRun) { '  [СУХИЙ ПРОГІН — нічого не змінюється]' })" 'White'
Say "Папка пакета: $Root"
if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Join-Path $AssistantHome 'logs') | Out-Null
    $log = Join-Path $AssistantHome ("logs\install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    try { Start-Transcript -Path $log | Out-Null; $script:Transcript = $true } catch { }
}

Step 'Перевірка системи'
if ($IsWin) {
    $os = [Environment]::OSVersion.Version
    Say "  Windows $($os.Major).$($os.Minor) build $($os.Build)"
    if ($os.Build -lt 17763) { Say '  ! Потрібна Windows 10 версії 1809 або новіша.' 'Red'; exit 1 }
    if (-not (Test-Cmd 'winget')) {
        Say '  ! Немає winget. Встановіть «App Installer» з Microsoft Store і запустіть знову.' 'Red'
        Start-Process 'ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1' -ErrorAction SilentlyContinue
        exit 1
    }
    $drive = Get-PSDrive -Name ($HomeDir.Substring(0, 1)) -ErrorAction SilentlyContinue
    if ($drive) { Say ("  Вільно на диску {0}: {1:N0} ГБ" -f $drive.Name, ($drive.Free / 1GB)) }
} else {
    Say '  Не Windows: перевіряю лише логіку сценарію (для macOS/Linux використовуйте uv і assistant-setup напряму).' 'Yellow'
}

$ids = @($Catalog.profiles.$($Mode.ToLower()))
$components = @($Catalog.components | Where-Object { $ids -contains $_.id })
Step "План ($($components.Count) компонентів)"
foreach ($c in $components) { Say ("  • {0,-55} [{1}] {2}" -f $c.name, $c.tier, (Get-Prop $c 'why')) }
Say '  Нічого платного не встановлюється. Ollama-моделі — лише якщо ПК потягне (спитаю окремо).'
if (-not (Confirm-Step 'Продовжити встановлення?')) { Say 'Скасовано.'; exit 0 }

Step 'Базові інструменти'
foreach ($c in $components) {
    if ($c.id -in @('claude-code', 'assistant-tools', 'ollama', 'auto-editor', 'playwright-cli')) { continue }
    Install-Component $c
}
Update-SessionPath

Step 'Claude Code (офіційний інсталятор Anthropic)'
if (Test-Cmd 'claude') { Say '  ✓ вже встановлено'; Add-Result 'Claude Code (CLI)' 'вже було' }
elseif (Confirm-Step 'Встановити Claude Code (irm https://claude.ai/install.ps1 | iex)?') {
    if ($DryRun) { Say '  (план) irm https://claude.ai/install.ps1 | iex' 'DarkGray'; Add-Result 'Claude Code (CLI)' 'план' }
    else {
        try { Invoke-RestMethod 'https://claude.ai/install.ps1' | Invoke-Expression; Add-Result 'Claude Code (CLI)' 'встановлено' }
        catch { Add-Result 'Claude Code (CLI)' 'ПОМИЛКА' $_.Exception.Message }
        Update-SessionPath
    }
}

Step 'Інструменти помічника (mtk, llm-local, захист, Whisper)'
$uvArgs = @('tool', 'install', '--python', '3.12', '--editable', (Join-Path $Root 'tools'), '--with', 'faster-whisper', '--reinstall')
$nvidia = $false
if ($IsWin) {
    try { $nvidia = [bool](Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' }) } catch { }
}
if ($nvidia) {
    Say '  Знайдено відеокарту NVIDIA: додаю бібліотеки CUDA для швидкої транскрипції (~1–1.5 ГБ).'
    $uvArgs += @('--with', 'nvidia-cublas-cu12', '--with', 'nvidia-cudnn-cu12>=9,<10')
}
if (-not $DryRun -and -not (Test-Cmd 'uv')) { Say '  ! uv не знайдено — перезапустіть install.cmd у новому вікні.' 'Red'; exit 1 }
$code = Invoke-Native 'uv' $uvArgs
if ($code -ne 0) { Say "  ! Помилка встановлення інструментів (код $code)" 'Red'; exit 1 }
[void](Invoke-Native 'uv' @('tool', 'update-shell'))
Update-SessionPath
Add-Result 'Інструменти помічника' ($(if ($DryRun) { 'план' } else { 'встановлено' }))

Step 'Визначення заліза і план локальних моделей'
$setup = 'assistant-setup'
[void](Invoke-Native $setup @('detect'))
[void](Invoke-Native $setup @('plan'))
$planPath = Join-Path $AssistantHome 'plan.json'
$tier = 'none'
if (Test-Path $planPath) { $tier = (Get-Content -Raw -Encoding UTF8 $planPath | ConvertFrom-Json).llm.tier }

$extras = @($components | Where-Object { $_.id -in @('auto-editor', 'playwright-cli') })
if ($extras.Count -gt 0) {
    Step 'Додаткові інструменти'
    foreach ($c in $extras) { Install-Component $c }
}

$ollama = @($components | Where-Object { $_.id -eq 'ollama' })
if ($ollama.Count -gt 0) {
    Step 'Локальні моделі (Ollama)'
    if ($tier -eq 'none' -and -not $DryRun) { Say '  Для цього ПК локальні моделі не рекомендовані — пропускаю (Claude працює без них).'; Add-Result 'Ollama' 'пропущено' 'слабке залізо' }
    elseif (Confirm-Step 'Встановити Ollama (безкоштовно, працює лише на цьому ПК)?') {
        Install-Component $ollama[0]
        if (-not $SkipModels -and (Confirm-Step 'Завантажити рекомендовані моделі зараз (кілька ГБ)?')) {
            [void](Invoke-Native $setup @('models', '--pull'))
        } else { [void](Invoke-Native $setup @('models')) }
    }
}

Step 'Глобальна конфігурація Claude (~/.claude)'
[void](Invoke-Native $setup @('deploy', '--dry-run'))
if (Confirm-Step 'Застосувати ці зміни? (попередні файли буде збережено в резервну копію)') {
    $code = Invoke-Native $setup @('deploy')
    Add-Result 'Конфігурація Claude' ($(if ($code -eq 0) { $(if ($DryRun) { 'план' } else { 'розгорнуто' }) } else { 'ПОМИЛКА' }))
}

Step 'Перевірка'
[void](Invoke-Native $setup @('doctor'))

Step 'Підсумок'
foreach ($r in $Results) { Say ("  {0,-34} {1} {2}" -f $r.Name, $r.Status, $r.Note) }
Step 'Що зробити вручну (2–5 хвилин)'
foreach ($m in $Catalog.manual) {
    if ($m.tier -like 'необов*') { continue }
    Say "  • $($m.name): $($m.steps)"
}
Say ''
Say 'Готово. Відкрийте НОВЕ вікно термінала (щоб оновився PATH) і запустіть: claude' 'Green'
Say "Журнал встановлення: $AssistantHome\logs" 'DarkGray'
if ($script:Transcript) { try { Stop-Transcript | Out-Null } catch { } }
