; Custom steps for the Windows installer (package.json build.nsis.include).

; Rexclaw is installed for the current user only, so neither installing nor
; updating asks for administrator rights. Without this the wizard opens with
; a "who should this be installed for" page, and shows it again on every
; update.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; The updater keeps a copy of the last installer (and any downloaded update)
; so the next update only downloads what changed. Nothing in that folder is
; the user's, so an uninstall removes it; their data under %APPDATA% stays.
; The folder is updaterCacheDirName in the app's app-update.yml: the package
; name plus "-updater".
;
; Not when an installer is replacing this copy (an update or a reinstall,
; both pass --updated): the installer at work may be the one in that folder.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\rexclaw-desktop-updater"
  ${endIf}
!macroend
