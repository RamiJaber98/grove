; Grove installer hooks (NSIS). Run by Tauri's installer for the current user.
;
; - Adds "Open in Grove" to Explorer's right-click menu for folders and for
;   the background of an open folder.
; - Adds a `grove` command: a tiny .cmd shim in %LOCALAPPDATA%\Microsoft\WindowsApps,
;   a folder Windows already puts on every user's PATH, so `grove .` works in
;   any new terminal without editing PATH.

!macro GROVE_CONTEXT_MENU KEY
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Grove" "" "Open in Grove"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Grove" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\${KEY}\shell\Grove\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro GROVE_CONTEXT_MENU "Directory"
  !insertmacro GROVE_CONTEXT_MENU "Directory\Background"

  CreateDirectory "$LOCALAPPDATA\Microsoft\WindowsApps"
  FileOpen $0 "$LOCALAPPDATA\Microsoft\WindowsApps\grove.cmd" w
  FileWrite $0 '@echo off$\r$\n'
  ; `start` returns immediately so the terminal isn't tied up; the app
  ; inherits the current directory, so relative paths like `.` work.
  FileWrite $0 'start "" "$INSTDIR\${MAINBINARYNAME}.exe" %*$\r$\n'
  FileClose $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Grove"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Grove"
  Delete "$LOCALAPPDATA\Microsoft\WindowsApps\grove.cmd"
!macroend
