; Installer-only replacement: customWelcomePage is not used by the uninstaller.
; Keep the upstream registry and /D precedence, changing only the default root.
!macroundef setInstallModePerAllUsers
!macro setInstallModePerAllUsers
  StrCpy $installMode all
  SetShellVarContext all

  ReadRegStr $perMachineInstallationFolder HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $perMachineInstallationFolder != ""
    StrCpy $INSTDIR $perMachineInstallationFolder
  ${else}
    StrCpy $0 "$PROGRAMFILES64"
    !ifdef MENU_FILENAME
      StrCpy $0 "$0\${MENU_FILENAME}"
    !endif
    StrCpy $INSTDIR "$0\${APP_FILENAME}"
  ${endif}

  !insertmacro GetDParameter $R0
  ${If} $R0 != ""
    StrCpy $INSTDIR $R0
  ${endif}
!macroend
