; electron-builder 26.15.3 only handles APP_64 in its all-users default path.
; This compile-time hook runs after multiUser.nsh defines the macro, but before
; assistedInstaller.nsh expands it in the install-mode page and .onInit.
; Released clients also pass /S. Restore visible progress for their update path.
!macro customInit
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    SetSilent normal
  ${EndIf}
!macroend

!macro customInstallMode
  ${If} ${isUpdated}
  ${AndIf} ${isForceRun}
    ${If} $hasPerUserInstallation == "1"
    ${AndIf} $hasPerMachineInstallation == "0"
      StrCpy $isForceCurrentInstall "1"
    ${ElseIf} $hasPerMachineInstallation == "1"
    ${AndIf} $hasPerUserInstallation == "0"
      StrCpy $isForceMachineInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

; Keep the normal first-install finish page. An application-requested update
; skips it only after the install section has completed, then starts the app.
!macro customFinishPage
  Function StartApp
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function GoodBuddyUpdateFinish
    ${If} ${isUpdated}
    ${AndIf} ${isForceRun}
      Call StartApp
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE GoodBuddyUpdateFinish
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend

!ifdef APP_ARM64
  !ifndef APP_64
    !ifndef APP_32
      !macro customWelcomePage
        !include "installer-arm64.nsh"
      !macroend
    !endif
  !endif
!endif
