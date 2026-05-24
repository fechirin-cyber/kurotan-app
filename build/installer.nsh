; installer.nsh — kurotan NSIS カスタムマクロ
; electron-builder の include: build/installer.nsh で参照される。
;
; §13.6.4 アンインストール時の挙動:
;   1. kurotanManaged: true の hooks エントリを ~/.claude/settings.json から削除
;   2. 失敗してもアンインストールを中断しない (ベストエフォート)
;
; 実行方式:
;   node.exe が PATH にある前提で install-hooks.js --uninstall を実行する。
;   配布版では app.asar.unpacked/src/installer/ に展開された JS を呼び出す。
;   (app.asar 内 JS は外部 node.exe から直接実行不可)
;
; 注意:
;   - $INSTDIR は %LOCALAPPDATA%\Programs\kurotan\ に相当する
;   - node.exe が PATH にない環境では nsExec が "error" を返す (exit code ではない)
;   - 開発環境では $INSTDIR が存在しないため実行不要 (NSIS 実行時のみ有効)
;
; customRemoveFiles マクロを定義して、ファイル削除前に hooks を削除する。
;   electron-builder の uninstaller.nsh は customRemoveFiles が定義されている場合、
;   RMDir /r $INSTDIR の代わりに customRemoveFiles を呼ぶ。
;   これにより「$INSTDIR が削除された後に install-hooks.js を呼ぼうとして失敗する」
;   問題を解消する。
;
; 注意: customRemoveFiles 内でファイル削除 (RMDir /r $INSTDIR) も担う必要がある。
;   customUnInstall マクロは削除のみの後方互換エイリアスとして残す。

; ─── hooks 削除の共通実装 ─────────────────────────────────────────
; $INSTDIR が存在する間に呼ぶこと (ファイル削除前)。
; NSIS レジスタ $R8 を node パス用一時変数として使用する。
!macro _kurotanDeleteHooks
  ; $R8 を保存してから使用する
  Push $R8
  StrCpy $R8 "node"

  ; node.exe 候補を優先順位で探す。見つかった最初の候補を使う。
  ; 1) %PROGRAMFILES%\nodejs\node.exe (システムワイドインストール)
  ; 2) %LOCALAPPDATA%\Programs\nodejs\node.exe (ユーザーインストーラ)
  ; 3) "node" のまま → PATH に委ねる
  IfFileExists "$PROGRAMFILES\nodejs\node.exe" 0 +3
    StrCpy $R8 "$PROGRAMFILES\nodejs\node.exe"
    Goto _kurotanNodeReady
  IfFileExists "$LOCALAPPDATA\Programs\nodejs\node.exe" 0 +2
    StrCpy $R8 "$LOCALAPPDATA\Programs\nodejs\node.exe"
  _kurotanNodeReady:

  DetailPrint "kurotan hooks を ~/.claude/settings.json から削除しています..."
  nsExec::ExecToLog '"$R8" "$INSTDIR\resources\app.asar.unpacked\src\installer\install-hooks.js" --uninstall'
  Pop $0

  ; $R8 を復元
  Pop $R8

  ${If} $0 == "error"
    DetailPrint "node.exe が見つかりません。hooks 削除をスキップします。"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "kurotan hooks の自動削除に失敗しました。$\n\
node.exe が見つからない可能性があります。$\n\
~/.claude/settings.json を手動で開き、$\n\
kurotanManaged: true と記載されたエントリをすべて削除してください。$\n$\n\
アンインストール自体は続行します。"
    ${EndIf}
  ${ElseIf} $0 != 0
    DetailPrint "hooks 削除中にエラーが発生しました (exit code: $0)。アンインストールは続行します。"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "kurotan hooks の自動削除に失敗しました (exit code: $0)。$\n\
~/.claude/settings.json を手動で開き、$\n\
kurotanManaged: true と記載されたエントリをすべて削除してください。$\n$\n\
アンインストール自体は続行します。"
    ${EndIf}
  ${Else}
    DetailPrint "hooks の削除が完了しました。"
  ${EndIf}
!macroend

; ─── customRemoveFiles: ファイル削除前に hooks を削除する ───
; electron-builder uninstaller.nsh はこのマクロが定義されていると、
; RMDir /r $INSTDIR の代わりにこのマクロを呼ぶ。
; hooks 削除を先に実行し、その後ファイルを削除する。
!macro customRemoveFiles
  !insertmacro _kurotanDeleteHooks
  ; ファイル削除 (electron-builder デフォルトと同等)
  RMDir /r $INSTDIR
!macroend

; ─── customUnInstall: 後方互換エイリアス (hooks 削除済みなので no-op) ────
; customRemoveFiles でファイル削除前に hooks が削除されるため、
; customUnInstall は実質何もしない (ファイルがすでに削除されている)。
; マクロ定義を残すことで electron-builder が insertmacro しても安全。
!macro customUnInstall
  ; hooks は customRemoveFiles で削除済み。何もしない。
  DetailPrint "kurotan uninstall: hooks は削除済みです。"
!macroend

; ─── _kurotanInstallHooks: インストール直後に hooks を登録する ────────────
; 案 B (二重防御): NSIS 上書きインストール時に旧版アンインストーラが
; _kurotanDeleteHooks を実行した直後、新版ファイル配置が完了した時点で
; 再度 install-hooks.js を実行して hooks を復元する。
;
; node.exe が PATH にない環境では nsExec が "error" を返す。
; その場合は Electron main の起動時 checkHooksInstalled() → auto-install (案 A) に委ねる。
; 失敗してもインストールを中断しない (ベストエフォート)。
!macro _kurotanInstallHooks
  Push $R8
  StrCpy $R8 "node"

  ; node.exe 候補を優先順位で探す (_kurotanDeleteHooks と同じロジック)
  IfFileExists "$PROGRAMFILES\nodejs\node.exe" 0 +3
    StrCpy $R8 "$PROGRAMFILES\nodejs\node.exe"
    Goto _kurotanInstallNodeReady
  IfFileExists "$LOCALAPPDATA\Programs\nodejs\node.exe" 0 +2
    StrCpy $R8 "$LOCALAPPDATA\Programs\nodejs\node.exe"
  _kurotanInstallNodeReady:

  DetailPrint "kurotan hooks を ~/.claude/settings.json に登録しています..."
  nsExec::ExecToLog '"$R8" "$INSTDIR\resources\app.asar.unpacked\src\installer\install-hooks.js"'
  Pop $0

  Pop $R8

  ${If} $0 == "error"
    DetailPrint "node.exe が見つかりません。hooks 登録をスキップします (起動時に自動登録されます)。"
  ${ElseIf} $0 != 0
    DetailPrint "hooks 登録中にエラーが発生しました (exit code: $0)。起動時に自動登録されます。"
  ${Else}
    DetailPrint "hooks の登録が完了しました。"
  ${EndIf}
!macroend

; ─── customInstall: インストール完了後に hooks を登録する ─────────────────
; electron-builder の installSection.nsh はこのマクロが定義されていると、
; ファイル配置・ショートカット作成の後にこのマクロを呼ぶ。
; NSIS 上書きインストールシーケンス:
;   1. 旧版アンインストーラ silent 実行 → customRemoveFiles → _kurotanDeleteHooks (hooks 削除)
;   2. 新版ファイル配置完了
;   3. customInstall → _kurotanInstallHooks (hooks 再登録) ← ここで復元
!macro customInstall
  !insertmacro _kurotanInstallHooks
!macroend
