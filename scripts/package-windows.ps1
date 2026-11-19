# SLAB DSP for Windows, as the release download: the helper with the Swift and Visual C++ runtimes
# it needs beside it, zipped. Then it is started from the zip's contents alone, with nothing else on
# the path, and asked for its status, so a runtime left out fails here rather than on someone's PC.
#
#   pwsh scripts/package-windows.ps1 [-Out release]
param([string]$Out = "release")
$ErrorActionPreference = "Stop"

$version = (Select-String -Path dsp/Sources/SLABDSPWin/main.swift -Pattern '^let slabVersion = "(.+)"$').Matches[0].Groups[1].Value
if (-not $version) { throw "no slabVersion in dsp/Sources/SLABDSPWin/main.swift" }
Write-Host "SLAB DSP for Windows $version"

swift build -c release --package-path dsp --product SLABDSP
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$bin = (swift build -c release --package-path dsp --show-bin-path).Trim()

$stage = Join-Path ([IO.Path]::GetTempPath()) "slab-package\SLAB DSP"
Remove-Item -Recurse -Force (Split-Path $stage) -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $bin "SLABDSP.exe") (Join-Path $stage "SLAB DSP.exe")

# The Swift runtime it was built against: the folder on the path that holds swiftCore.dll.
$runtime = $env:PATH -split ';' | Where-Object { $_ -and (Test-Path (Join-Path $_ "swiftCore.dll")) } | Select-Object -First 1
if (-not $runtime) { throw "no Swift runtime on the path" }
Write-Host "Swift runtime: $runtime"
Copy-Item (Join-Path $runtime "*.dll") $stage

# The Visual C++ runtime the C++ parts link against, for PCs without the redistributable installed.
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -property installationPath
$crt = Get-ChildItem (Join-Path $vs "VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT") -Directory | Sort-Object FullName | Select-Object -Last 1
if (-not $crt) { throw "no Visual C++ runtime under $vs" }
Write-Host "Visual C++ runtime: $($crt.FullName)"
foreach ($dll in "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll") {
    Copy-Item (Join-Path $crt.FullName $dll) $stage
}

@"
SLAB DSP $version for Windows
=============================

Run "SLAB DSP.exe". Its waveform appears in the notification area by the clock; its menu has
Start at Login.

It plays Spotify through SLAB's moods, pads and chops. It needs Windows 10 version 2004 or newer,
or Windows 11, and the SLAB extension in Spotify (Spicetify).

While it plays, it turns Spotify's own output down in the volume mixer and plays its version
instead. Quitting it from its menu gives Spotify its volume back.

This build isn't signed, so the first time Windows may say it protected your PC: choose
"More info", then "Run anyway".

Its log: %LOCALAPPDATA%\SLAB\dsp.log
"@ | Set-Content -Encoding utf8 (Join-Path $stage "README.txt")

# Started from the folder alone: no Swift or Visual Studio on the path.
$path = $env:PATH
$env:PATH = "$env:SystemRoot\system32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$helper = Start-Process -FilePath (Join-Path $stage "SLAB DSP.exe") -ArgumentList "--seconds", "10", "--port", "47899" -PassThru
$env:PATH = $path
$status = $null
for ($i = 0; $i -lt 20 -and -not $status; $i++) {
    Start-Sleep -Milliseconds 400
    try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:47899/status" -TimeoutSec 2 } catch {}
}
if (-not $status) {
    Stop-Process -Id $helper.Id -ErrorAction SilentlyContinue
    $log = Join-Path $env:LOCALAPPDATA "SLAB\dsp.log"
    if (Test-Path $log) { Get-Content $log -Tail 20 }
    throw "SLAB DSP didn't answer on its control port"
}
Write-Host "status: $($status | ConvertTo-Json -Compress)"
if ($status.service -ne "slab-dsp" -or $status.platform -ne "windows" -or $status.version -ne $version) {
    throw "unexpected status"
}
if (-not ($status.features -contains "jump")) { throw "no jump in features" }
if (-not $helper.WaitForExit(20000)) {
    Stop-Process -Id $helper.Id
    throw "SLAB DSP didn't quit when its time was up"
}

New-Item -ItemType Directory -Force $Out | Out-Null
$zip = Join-Path $Out "SLAB-DSP-Windows-$version.zip"
Compress-Archive -Path $stage -DestinationPath $zip -Force
Get-ChildItem $stage | Sort-Object Length -Descending | Format-Table Name, Length
Write-Host "$zip, $([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB"
