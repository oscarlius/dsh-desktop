# DSH NEXT NSIS temporary-directory runtime

This directory supplies only the six Unicode NSIS 3.12 executable-header
stubs used by the electron-builder `nsis@1.2.1` bundle. The compiler, NSIS
plugins, `elevate.exe`, and bundle layout remain upstream.

The native header runs before installer headers and `.onInit`. If the inherited
`TEMP`/`TMP` cannot create a file, it creates and probes
`%LOCALAPPDATA%\DSH-NEXT-InstallerTemp`, then updates only the current process and
its children to use that validated directory. If that also fails, upstream
Windows Temp and Low-IL fallbacks remain unchanged. No ACL, integrity label, or
permanent environment setting is changed.

`build-repro.ps1` fetches pinned official sources into a caller-provided
scratch directory, applies the patch, and builds the six binaries. It requires
Visual Studio Build Tools with the x86 C++ tools and a local Python 3 runtime;
it installs SCons only inside the supplied scratch venv. `test-native-runtime.ps1`
compiles a silent marker installer using an isolated copy of the official
bundle and verifies both a normal Temp path and file-valued `TEMP`/`TMP`.

Do not copy these stubs into the shared electron-builder cache. Packaging must
copy the official bundle to an isolated directory and overlay `stubs/` there.
