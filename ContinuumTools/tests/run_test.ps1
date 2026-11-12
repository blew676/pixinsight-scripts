# Runs one headless test script in a fresh PixInsight instance (development only).
#   .\run_test.ps1 test_core.js C:\some\output\dir
param(
   [Parameter(Mandatory = $true)][string]$Test,
   [Parameter(Mandatory = $true)][string]$OutDir
)
$pi = "C:\Program Files\PixInsight\bin\PixInsight.exe"
$script = (Join-Path $PSScriptRoot $Test) -replace '\\', '/'
$out = $OutDir -replace '\\', '/'
New-Item -ItemType Directory -Force $OutDir | Out-Null
$t = Get-Date
$p = Start-Process -FilePath $pi -ArgumentList @("-n", "--automation-mode", "--force-exit", "-r=`"$script,$out`"") -PassThru -Wait
"exit=$($p.ExitCode) secs=$([int]((Get-Date) - $t).TotalSeconds)"
$name = [System.IO.Path]::GetFileNameWithoutExtension($Test) -replace '^test_', ''
$log = Join-Path $OutDir "$($name)_log.txt"
if (Test-Path $log) { Get-Content $log } else { "no log written: $log" }
