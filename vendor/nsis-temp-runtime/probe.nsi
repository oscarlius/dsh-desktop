Unicode true
SilentInstall silent
RequestExecutionLevel user
SetCompressor zlib
OutFile "nsis-temp-runtime-probe.exe"

Section
  ReadEnvStr $1 "TMP"
  FileOpen $0 "$EXEDIR\nsis-temp-runtime-install-marker.txt" w
  FileWrite $0 "$TEMP|$1"
  FileClose $0
  WriteUninstaller "$EXEDIR\nsis-temp-runtime-uninstall.exe"
SectionEnd

Section "Uninstall"
  ReadEnvStr $1 "TMP"
  FileOpen $0 "$TEMP\nsis-temp-runtime-uninstall-marker.txt" w
  FileWrite $0 "$TEMP|$1"
  FileClose $0
SectionEnd
