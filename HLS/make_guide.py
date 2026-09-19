from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

root = Path(r"C:\Users\d127791\Desktop\firefox-video-downloader\HLS")
font_path = r"C:\Windows\Fonts\meiryo.ttc"
if not Path(font_path).exists():
    candidates = [
        r"C:\Windows\Fonts\YuGothM.ttc",
        r"C:\Windows\Fonts\msgothic.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            font_path = candidate
            break

pdfmetrics.registerFont(TTFont('Meiryo', font_path))

out = root / 'firefox-extension-install-guide.pdf'
text = [
    'Firefox 拡張機能の導入手順',
    '',
    '1. Firefox を起動する',
    '   1) 表示された画面で URL 欄に about:debugging を入力して Enter します。',
    '   2) 左側の「この Firefox」を選択します。',
    '   3) 「一時的なアドオンを読み込む」を押します。',
    '',
    '2. 拡張機能を読み込む',
    '   1) HLS フォルダ内の manifest.json を選択します。',
    '   2) Firefox が拡張機能を読み込みます。',
    '   3) 追加されたアドオンを有効化して使います。',
    '',
    '3. 使用方法',
    '   1) 動画が埋め込まれたページを開く',
    '   2) 右上の拡張機能アイコンを開く',
    '   3) 動画候補の一覧が表示される',
    '   4) 直リンクは「ダウンロード」、HLS は「HLS 保存」を選ぶ',
    '',
    '4. 注意事項',
    '   - CORS 制限がある場合、m3u8 の取得に失敗することがあります。',
    '   - 一部の動画は DRM や暗号化により保存できません。',
    '   - 事前に個人的な利用目的で使用してください。',
    '',
    '5. 補足',
    '   この HLS 版は normal 版をベースにしており、UI は normal 版と同じレイアウトで構成しています。',
    '   HLS のみの検出と保存処理を追加した状態です。',
]

c = canvas.Canvas(str(out), pagesize=A4)
c.setTitle('Firefox 拡張機能導入手順')
c.setAuthor('Personal Use Extension')
c.setFont('Meiryo', 18)
y = 790
for line in text:
    c.drawString(50, y, line)
    y -= 22
    if y < 60:
        c.showPage()
        y = 790

c.save()
print(f'PDF generated: {out}')
