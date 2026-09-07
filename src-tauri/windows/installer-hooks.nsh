; XControl NSIS 覆盖安装/卸载守卫。
; Tauri 主程序在应用内更新时会先优雅关闭 sidecar；这里处理手动运行 GitHub
; 安装包、主程序被安装器强制关闭、旧版本缺少退出钩子等兜底场景。

!macro XCONTROL_STOP_SIDECAR
  ; xcontrol-server.exe 是 XControl 独占的 sidecar 名称。/T 同时清理其子进程，
  ; /F 确保旧二进制不再占用 $INSTDIR 下的目标文件。
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM xcontrol-server.exe'
  Sleep 500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro XCONTROL_STOP_SIDECAR
  ; Go sidecar 没有 Windows 文件版本资源，强制覆盖并先删除旧文件，避免 NSIS
  ; 版本比较误保留旧 sidecar。删除失败时后续 File 指令会明确安装失败。
  SetOverwrite on
  Delete "$INSTDIR\xcontrol-server.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro XCONTROL_STOP_SIDECAR
!macroend
