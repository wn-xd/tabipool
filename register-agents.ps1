# register-agents.ps1 - Auto-add tabipool proxy as OpenAI-compatible provider to detected coding agents
param(
  [int]$Port = 0,
  [string]$BaseUrl = "",
  [string]$UserHome = ""
)

$ErrorActionPreference = "Stop"

if (-not $UserHome) {
  $UserHome = $env:USERPROFILE
}

# 1. Determine base URL
if (-not $Port) {
  $localConfig = Join-Path $PSScriptRoot "config.local.ps1"
  if (Test-Path $localConfig) {
    try {
      . $localConfig
    } catch {}
  }
  if ($PORT) {
    $Port = [int]$PORT
  } elseif ($env:PORT) {
    $Port = [int]$env:PORT
  } else {
    $Port = 8787
  }
}

if (-not $BaseUrl) {
  $BaseUrl = "http://127.0.0.1:$Port/v1"
}
$BaseUrl = $BaseUrl.TrimEnd('/')

# 2. Fetch live models from /v1/models
$models = @()
$modelsFetched = $false

try {
  $modelsUrl = "$BaseUrl/models"
  $raw = curl.exe -s --max-time 3 "$modelsUrl" 2>$null
  if (-not $raw) {
    $resp = Invoke-RestMethod -Uri $modelsUrl -TimeoutSec 3 -ErrorAction Stop
    if ($resp -and $resp.data) {
      $models = @($resp.data | ForEach-Object { $_.id } | Where-Object { $_ })
      $modelsFetched = $true
    }
  } else {
    $parsed = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if ($parsed -and $parsed.data) {
      $models = @($parsed.data | ForEach-Object { $_.id } | Where-Object { $_ })
      $modelsFetched = $true
    }
  }
} catch {
  $modelsFetched = $false
}

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "      tabipool agent registration" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  Base URL:  $BaseUrl"
if ($modelsFetched -and $models.Count -gt 0) {
  Write-Host "  Models:    $($models.Count) live model(s) discovered" -ForegroundColor Green
} else {
  Write-Host "  Models:    none discovered (proxy stopped or returned empty)" -ForegroundColor Yellow
  Write-Host "  Note:      Registering provider with placeholder configuration." -ForegroundColor Yellow
  Write-Host "             Run 'tabipool register' again after starting the service and declaring models." -ForegroundColor Yellow
}
Write-Host ""

$agentSummary = @()

# 3. opencode (CLI + desktop)
$opencodeDir = Join-Path $UserHome ".config\opencode"
$opencodeFile = Join-Path $opencodeDir "opencode.json"
$opencodeCmd = Get-Command opencode.exe, opencode.cmd, opencode -ErrorAction SilentlyContinue
$opencodeDetected = (Test-Path $opencodeFile) -or (Test-Path $opencodeDir) -or ($null -ne $opencodeCmd)

if ($opencodeDetected) {
  try {
    if (-not (Test-Path $opencodeDir)) {
      New-Item -ItemType Directory -Path $opencodeDir -Force | Out-Null
    }
    $json = $null
    if (Test-Path $opencodeFile) {
      $rawJson = Get-Content -Path $opencodeFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($rawJson -and $rawJson.Trim()) {
        $json = $rawJson | ConvertFrom-Json -ErrorAction SilentlyContinue
      }
    }
    if ($null -eq $json) {
      $json = [PSCustomObject]@{
        "`$schema" = "https://opencode.ai/config.json"
      }
    }
    if (-not ($json.PSObject.Properties['provider'])) {
      Add-Member -InputObject $json -NotePropertyName "provider" -NotePropertyValue (New-Object PSObject) -Force
    }

    $modelsObj = New-Object PSObject
    foreach ($m in $models) {
      Add-Member -InputObject $modelsObj -NotePropertyName $m -NotePropertyValue ([PSCustomObject]@{ name = $m }) -Force
    }

    $tabipoolEntry = [PSCustomObject]@{
      npm     = "@ai-sdk/openai-compatible"
      name    = "Tabipool (local pool)"
      options = [PSCustomObject]@{ baseURL = $BaseUrl }
      models  = $modelsObj
    }
    Add-Member -InputObject $json.provider -NotePropertyName "tabipool" -NotePropertyValue $tabipoolEntry -Force

    $json | ConvertTo-Json -Depth 10 | Set-Content -Path $opencodeFile -Encoding UTF8
    $agentSummary += "  [UPDATED] opencode     ($opencodeFile)"
  } catch {
    $agentSummary += "  [FAILED]  opencode     ($_)"
  }
} else {
  $agentSummary += "  [SKIPPED] opencode     (not installed - $opencodeDir not found)"
}

# 4. Prime Agent
$primeDir = Join-Path $UserHome ".prime\agent"
$primeFile = Join-Path $primeDir "models.json"
$primeCmd = Get-Command prime.exe, prime.cmd, prime -ErrorAction SilentlyContinue
$primeDetected = (Test-Path $primeFile) -or (Test-Path $primeDir) -or ($null -ne $primeCmd)

if ($primeDetected) {
  try {
    if (-not (Test-Path $primeDir)) {
      New-Item -ItemType Directory -Path $primeDir -Force | Out-Null
    }
    $pjson = $null
    if (Test-Path $primeFile) {
      $rawPrime = Get-Content -Path $primeFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($rawPrime -and $rawPrime.Trim()) {
        $pjson = $rawPrime | ConvertFrom-Json -ErrorAction SilentlyContinue
      }
    }
    if ($null -eq $pjson) {
      $pjson = [PSCustomObject]@{
        providers = (New-Object PSObject)
      }
    }

    $primeModels = @()
    foreach ($m in $models) {
      $primeModels += [PSCustomObject]@{ id = $m; name = $m }
    }

    if ($pjson.PSObject.Properties['providers'] -and ($pjson.providers -is [System.Array])) {
      $arrEntry = [PSCustomObject]@{
        id      = "tabipool"
        name    = "Tabipool (local pool)"
        baseUrl = $BaseUrl
        api     = "openai-completions"
        apiKey  = "tabipool-local"
        models  = $primeModels
      }
      $existingIdx = -1
      for ($i = 0; $i -lt $pjson.providers.Count; $i++) {
        $item = $pjson.providers[$i]
        if ($item.id -eq "tabipool" -or $item.name -like "*Tabipool*") {
          $existingIdx = $i
          break
        }
      }
      if ($existingIdx -ge 0) {
        $pjson.providers[$existingIdx] = $arrEntry
      } else {
        $pjson.providers = @($pjson.providers) + $arrEntry
      }
    } else {
      if (-not ($pjson.PSObject.Properties['providers'])) {
        Add-Member -InputObject $pjson -NotePropertyName "providers" -NotePropertyValue (New-Object PSObject) -Force
      }
      $primeEntry = [PSCustomObject]@{
        name    = "Tabipool (local pool)"
        baseUrl = $BaseUrl
        api     = "openai-completions"
        apiKey  = "tabipool-local"
        models  = $primeModels
      }
      Add-Member -InputObject $pjson.providers -NotePropertyName "tabipool" -NotePropertyValue $primeEntry -Force
    }

    $pjson | ConvertTo-Json -Depth 10 | Set-Content -Path $primeFile -Encoding UTF8
    $agentSummary += "  [UPDATED] Prime Agent  ($primeFile)"
  } catch {
    $agentSummary += "  [FAILED]  Prime Agent  ($_)"
  }
} else {
  $agentSummary += "  [SKIPPED] Prime Agent  (not installed - $primeDir not found)"
}

# 5. Continue
$continueDir = Join-Path $UserHome ".continue"
$continueFile = Join-Path $continueDir "config.yaml"
$continueDetected = Test-Path $continueDir

if ($continueDetected) {
  try {
    $fenceLines = @(
      "  # tabipool-begin"
    )
    $continueModels = if ($models.Count -gt 0) { $models | Select-Object -First 20 } else { @("default") }
    foreach ($m in $continueModels) {
      $fenceLines += "  - name: tabipool/$m"
      $fenceLines += "    provider: openai"
      $fenceLines += "    model: $m"
      $fenceLines += "    apiBase: $BaseUrl"
      $fenceLines += "    apiKey: tabipool-local"
      $fenceLines += "    roles: [chat, edit]"
    }
    $fenceLines += "  # tabipool-end"
    $fenceText = $fenceLines -join "`r`n"

    if (Test-Path $continueFile) {
      $content = Get-Content -Path $continueFile -Raw -Encoding UTF8
      # Remove any prior tabipool fence block
      $content = [regex]::Replace($content, "(?s)\r?\n?\s*# tabipool-begin.*?# tabipool-end", "")
      if ($content -match "(?m)^models:\s*$") {
        $newContent = [regex]::Replace($content, "(?m)^(models:\s*)$", "`$1`r`n$fenceText", 1)
      } else {
        $newContent = $content.TrimEnd() + "`r`n`r`nmodels:`r`n$fenceText`r`n"
      }
      Set-Content -Path $continueFile -Value $newContent -Encoding UTF8
    } else {
      $newContent = "models:`r`n$fenceText`r`n"
      Set-Content -Path $continueFile -Value $newContent -Encoding UTF8
    }
    $agentSummary += "  [UPDATED] Continue     ($continueFile)"
  } catch {
    $agentSummary += "  [FAILED]  Continue     ($_)"
  }
} else {
  $agentSummary += "  [SKIPPED] Continue     (not installed - $continueDir not found)"
}

# Print summary
Write-Host "Agent Summary:"
foreach ($line in $agentSummary) {
  if ($line -match "\[UPDATED\]") {
    Write-Host $line -ForegroundColor Green
  } elseif ($line -match "\[FAILED\]") {
    Write-Host $line -ForegroundColor Red
  } else {
    Write-Host $line -ForegroundColor Gray
  }
}

# 6. Check Aider detection and print manual configuration snippets
$aiderFile = Join-Path $UserHome ".aider.conf.yml"
$aiderCmd = Get-Command aider.exe, aider -ErrorAction SilentlyContinue
$aiderDetected = (Test-Path $aiderFile) -or ($null -ne $aiderCmd)
$sampleModel = if ($models.Count -gt 0) { $models[0] } else { "<model-id>" }

Write-Host ""
Write-Host "Manual Configuration Snippets:" -ForegroundColor Cyan
Write-Host "---------------------------------------------------------"

if ($aiderDetected) {
  Write-Host "[Aider (detected on system)]" -ForegroundColor Green
} else {
  Write-Host "[Aider]" -ForegroundColor White
}
Write-Host "  Configure aider via environment variables or CLI flags:"
Write-Host "    PowerShell:"
Write-Host "      `$env:OPENAI_API_BASE = `"$BaseUrl`""
Write-Host "      `$env:OPENAI_API_KEY  = `"tabipool-local`""
Write-Host "      aider --model openai/$sampleModel"
Write-Host "    CMD:"
Write-Host "      set OPENAI_API_BASE=$BaseUrl"
Write-Host "      set OPENAI_API_KEY=tabipool-local"
Write-Host "      aider --model openai/$sampleModel"
Write-Host ""

Write-Host "[Cline / Roo Code (VS Code Extension)]" -ForegroundColor White
Write-Host "  VS Code extension state cannot be written externally."
Write-Host "  Configure in Cline settings (gear icon -> API Provider):"
Write-Host "    API Provider: OpenAI-Compatible"
Write-Host "    Base URL:     $BaseUrl"
Write-Host "    API Key:      tabipool-local"
Write-Host "    Model ID:     $sampleModel"
Write-Host ""

Write-Host "[omp (Open Multi-Provider)]" -ForegroundColor White
Write-Host "  omp uses compile-time provider catalogs (not a user config file)."
Write-Host "  Configure custom OpenAI provider in omp:"
Write-Host "    Base URL:     $BaseUrl"
Write-Host "    API Key:      tabipool-local"
Write-Host ""

Write-Host "[Generic OpenAI-Compatible Agent]" -ForegroundColor White
Write-Host "  Base URL:       $BaseUrl"
Write-Host "  API Key:        tabipool-local"
if ($models.Count -gt 0) {
  Write-Host "  Models:         $($models -join ', ')"
} else {
  Write-Host "  Models:         (declare in tabipool or check $BaseUrl/models)"
}
Write-Host "---------------------------------------------------------"
Write-Host ""
