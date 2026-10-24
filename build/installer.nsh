; electron-builder 26.15.3 only handles APP_64 in its all-users default path.
; This compile-time hook runs after multiUser.nsh defines the macro, but before
; assistedInstaller.nsh expands it in the install-mode page and .onInit.
!ifdef APP_ARM64
  !ifndef APP_64
    !ifndef APP_32
      !macro customWelcomePage
        !include "installer-arm64.nsh"
      !macroend
    !endif
  !endif
!endif
