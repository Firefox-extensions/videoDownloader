Firefox 拡張機能 normal 版

概要
- 通常の直リンク動画を検出して、個人的な利用目的で保存できる Firefox 拡張です。
- 画面構成はシンプルで、動画候補を一覧表示してダウンロードを開始できます。
- HLS 対応版のベースとして利用している通常版です。

保存先
- C:\Users\d127791\Desktop\firefox-video-downloader\normal

含まれるファイル
- manifest.json
- background.js
- content.js
- popup.html
- popup.js
- readme.txt

動作の考え方
- video / source 要素から URL を検出して一覧に表示します。
- 100kB 未満の候補は除外し、サイズ判定不能は表示設定に応じて扱います。
- ダウンロードボタンを押すと、ブラウザの downloads API で保存を開始します。

利用条件
- 個人的な利用のみを想定しています。
- 公開や配布は行いません。
- サイト側の CORS や保護方式により取得できない場合があります。

導入方法
1. Firefox を開く
2. アドレスバーに about:debugging と入力して開く
3. 左側の 「この Firefox」 を選択する
4. 「一時的なアドオンを読み込む」をクリックする
5. normal フォルダ内の manifest.json を選択する
6. 拡張機能を有効化して利用する

補足
- このフォルダは通常版のベース実装です。
- HLS 対応版はこの normal 版をベースに作成されています。
- 手順書 PDF は作成せず、本文は readme.txt にまとめています。
