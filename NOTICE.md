# NOTICE — kurotan サードパーティ権利表記

本ソフトウェア (kurotan) は、以下の第三者ソフトウェアおよびアセットを利用または同梱しています。各第三者の権利は、それぞれの原権利者に帰属します。

本ファイルは概要を示すものであり、完全な依存ツリーおよびライセンス全文は、ビルド時に生成される `build/license/third-party-licenses.json` を参照してください。

---

## 1. ランタイム / フレームワーク

| 名称 | 用途 | ライセンス | 権利者 |
|---|---|---|---|
| Electron 33 | デスクトップアプリケーションフレームワーク | MIT License | OpenJS Foundation および Electron 各コントリビューター |
| Node.js | JavaScript ランタイム (Electron 同梱) | MIT License および各コンポーネントの個別ライセンス | OpenJS Foundation および Node.js 各コントリビューター |
| Chromium | レンダリングエンジン (Electron 同梱) | BSD-3-Clause および各コンポーネントの個別ライセンス | The Chromium Authors |

## 2. npm 依存ライブラリ

| 名称 | 用途 | ライセンス | 権利者 |
|---|---|---|---|
| koffi | Win32 API ネイティブ呼び出し | MIT License | Niels Martignène および koffi 各コントリビューター |

完全な依存一覧 (推移的依存を含む) は、配布物に同梱の `build/license/third-party-licenses.json` を参照してください。
配布版でのファイル配置先: `%LOCALAPPDATA%\Programs\kurotan\resources\build\license\third-party-licenses.json`

## 3. 画像アセット / カラーパレット

| 名称 | 用途 | ライセンス | 権利者 |
|---|---|---|---|
| Catppuccin パレット | UI 配色テーマ | MIT License | Catppuccin Org |

Catppuccin に関する詳細: https://github.com/catppuccin/catppuccin

## 4. 連携先サービス

| 名称 | 連携内容 | 権利者 |
|---|---|---|
| Anthropic Claude Code | permission hook 経由の許可/拒否連携 | Anthropic, PBC |

**重要**: 本ソフトウェア (kurotan) は、**Anthropic, PBC の公式製品ではありません (Unofficial / Fan-made)**。Anthropic Claude Code 用の **非公式ファンアプリ** であり、Anthropic, PBC とは資本関係・業務提携関係・ライセンス契約関係にありません。

「Anthropic」「Claude」「Claude Code」の名称・商標は Anthropic, PBC に帰属します。本ソフトウェアにおける当該名称の使用は、連携対象を識別するための名目的言及であり、Anthropic, PBC による承認・推奨を意味するものではありません。

本ソフトウェアに含まれるキャラクター (くろたん) の意匠は、Anthropic Claude Code の起動画面に登場するピクセルマスコットからシルエット・配色・世界観を継承した **ファンアート** として制作されたものです。Anthropic, PBC の商標・キャラクター IP・ロゴ・ワードマークそのものを直接埋め込むことはしていません。

**配布停止条項**: Anthropic, PBC または同社の正当な権利承継者から、本ソフトウェアの配布停止・意匠調整・名称変更等の申し入れがあった場合、提供者は速やかにこれに応じます。詳細は同梱の `EULA.md` 第5条を参照してください。

**非商用配布**: 本ソフトウェアは **非商用 (Non-commercial) / 無料配布 / 個人利用のみ** で提供されます。販売・有償配布・広告組込・課金機能の付加は禁止されています。詳細は同梱の `EULA.md` 第1条を参照してください。

## 5. その他

本ソフトウェアのソースコード本体 (kurotan 本体および kurotan-notify bridge) は、MIT License で提供されます。詳細は同梱の `LICENSE` ファイルを参照してください。

配布物としての利用条件 (再配布の可否、無保証、Claude Code 設定変更の同意等) は、同梱の `EULA.md` ファイルを参照してください。

---

## サードパーティ依存ライセンスの完全表記

配布版インストーラに同梱される `build/license/third-party-licenses.json` および `build/license/EULA.txt` に、`npm-license-checker --production --json` 出力に基づくサードパーティ依存ライブラリのライセンス情報を収録しています。ソース版で動作確認する際は `npm run prebuild` で再生成されます。
