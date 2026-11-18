[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $ScratchRoot,
  [string] $SourceDateEpoch = '1776631127'
)

$ErrorActionPreference = 'Stop'
$vendorRoot = Split-Path -Parent $PSCommandPath
$scratchRoot = [IO.Path]::GetFullPath($ScratchRoot)
$nsisSource = Join-Path $scratchRoot 'nsis'
$zlibSource = Join-Path $scratchRoot 'zlib'
$venv = Join-Path $scratchRoot 'scons-venv'
$vsDevCmd = 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\Tools\VsDevCmd.bat'

if (Test-Path $scratchRoot) { throw "ScratchRoot already exists: $scratchRoot" }
if (!(Test-Path $vsDevCmd)) { throw "Visual Studio Build Tools x86 environment not found: $vsDevCmd" }

New-Item -ItemType Directory -Path $scratchRoot | Out-Null
git clone --depth 1 --branch v312 https://github.com/kichik/nsis.git $nsisSource
if ((git -C $nsisSource rev-parse HEAD).Trim() -ne 'e3f60402bcdf7be822d159b531c6e38ddf32de12') { throw 'Unexpected NSIS source commit' }
git -C $nsisSource apply (Join-Path $vendorRoot 'nsis-temp-runtime.patch')
git clone --depth 1 --branch v1.3.1 https://github.com/madler/zlib.git $zlibSource
if ((git -C $zlibSource rev-parse HEAD).Trim() -ne '51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf') { throw 'Unexpected zlib source commit' }

py -3 -m venv $venv
& (Join-Path $venv 'Scripts\python.exe') -m pip install --disable-pip-version-check 'scons==4.11.1'
if ($LASTEXITCODE) { throw 'SCons installation failed' }

function Invoke-X86Build([string] $command) {
  & $env:ComSpec /d /s /c "call `"$vsDevCmd`" -arch=x86 -host_arch=x64 >nul && $command"
  if ($LASTEXITCODE) { throw "Native build failed: $command" }
}

Invoke-X86Build "cd /d `"$zlibSource`" && nmake /f win32\Makefile.msc"
$scons = Join-Path $venv 'Scripts\scons.exe'
Invoke-X86Build "set SOURCE_DATE_EPOCH=$SourceDateEpoch && `"$scons`" -C `"$nsisSource`" ZLIB_W32=`"$zlibSource`" UNICODE=yes NSIS_MAX_STRLEN=8192 stubs"

$stubRoot = Join-Path $vendorRoot 'windows\Stubs'
$names = 'bzip2-x86-unicode','bzip2_solid-x86-unicode','lzma-x86-unicode','lzma_solid-x86-unicode','zlib-x86-unicode','zlib_solid-x86-unicode'
foreach ($name in $names) {
  $kind = if ($name.StartsWith('bzip2')) { 'bzip2' } elseif ($name.StartsWith('lzma')) { 'lzma' } else { 'zlib' }
  Copy-Item (Join-Path $nsisSource "build\urelease\stub_$name\stub_$kind.exe") (Join-Path $stubRoot $name) -Force
}

Get-FileHash (Join-Path $stubRoot '*') -Algorithm SHA256 | Select-Object Path, Hash
