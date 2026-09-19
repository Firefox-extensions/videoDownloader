Firefox 拡張機能 HLS 版

概要
- normal 版をベースにして HLS 対応を追加した個人利用向けの Firefox 拡張です。
- UI は normal 版と同じ見た目を維持しています。
- 直リンク動画と HLS プレイリストを検出して一覧表示します。

保存先
- C:\Users\d127791\Desktop\firefox-video-downloader\HLS

含まれるファイル
- manifest.json
- background.js
- content.js
- popup.html
- popup.js
- readme.txt

動作の考え方
- 直リンク動画: video / source 要素から URL を収集して表示
- HLS: .m3u8 を含む URL を検出して HLS として区別
- HLS 保存: m3u8 を取得し、TS セグメントを収集して保存を試行

利用条件
- 個人的な利用のみを想定しています。
- 公開や配布は行いません。
- 保存可否はサイト側の CORS や保護方式に依存します。

導入方法
1. Firefox を開く
2. アドレスバーに about:debugging と入力して開く
3. 左側の 「この Firefox」 を選択する
4. 「一時的なアドオンを読み込む」をクリックする
5. HLS フォルダ内の manifest.json を選択する
6. 拡張機能を有効化して利用する

補足
- このフォルダは normal 版を流用して作成した HLS 対応版です。
- UI は normal 版と同じ構成です。
- 手順書 PDF は作成せず、本文は readme.txt にまとめています。
- 実サイト検証は行っておらず、コードと構成が整っている状態です。
