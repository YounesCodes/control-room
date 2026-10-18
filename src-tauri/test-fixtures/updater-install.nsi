; An isolated test package: no registry writes, shortcuts, or application launches.
Unicode true
Name "Control Room updater test fixture"
OutFile "${OUTPUT}"
InstallDir "$TEMP\control-room-updater-test-unused"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
!include "FileFunc.nsh"

Section
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/UPDATE" $1
  IfErrors reject
  SetOutPath "$INSTDIR"
  FileOpen $1 "$INSTDIR\arguments.txt" w
  FileWrite $1 $0
  FileClose $1
  File /oname=installed.txt "${PAYLOAD}"
  Goto done
reject:
  SetErrorLevel 2
done:
SectionEnd
