import os
from pathlib import Path

try:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
except Exception:
    canvas = None
    A4 = None

root = Path(r'C:\Users\d127791\Desktop\firefox-video-downloader')
out_path = root / 'firefox-extension-install-guide.pdf'

if canvas is not None:
    c = canvas.Canvas(str(out_path), pagesize=A4)
    width, height = A4
    y = height - 50
    c.setTitle('Firefox 拡張機能の読み込み手順')
    c.setAuthor('GitHub Copilot')
    c.setFont('Helvetica-Bold', 20)
    c.drawString(50, y, 'Firefox 拡張機能の読み込み手順')
    y -= 35
    c.setFont('Helvetica', 12)
    lines = [
        '1. Firefox を起動する',
        '2. アドレスバーに about:debugging と入力して Enter',
        '3. 左側の「この Firefox」を選択する',
        '4. 「一時的なアドオンを読み込む」をクリックする',
        '5. 次のフォルダを選択する:',
        str(root),
        '6. manifest.json が含まれているフォルダを選ぶ',
        '7. 拡張機能が一覧に表示される',
        '8. 右側の「有効化」または「オン」を切り替える',
        '9. 実際のページを開いて、拡張機能のアイコンをクリックする',
        '10. 画面に動画候補が表示されたら保存を選ぶ',
        '',
        '注意事項:',
        '- この拡張は個人的な利用を前提にしている',
        '- DRM で保護された動画や HLS/DASH 分割配信には対応しない',
        '- 直接 URL の MP4 / WebM などを対象にする',
    ]
    for line in lines:
        if not line:
            y -= 18
            continue
        if y < 50:
            c.showPage()
            y = height - 50
        c.drawString(60, y, line)
        y -= 18
    c.save()
else:
    # 最小限の PDF 生成（フォールバック）
    pdf = [
        '%PDF-1.4\n',
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
        '4 0 obj\n<< /Length 384 >>\nstream\nBT\n/F1 16 Tf\n50 790 Td\n(Firefox 拡張機能の読み込み手順) Tj\n0 -24 Td\n/F1 12 Tf\n(1. Firefox を起動する) Tj\n0 -24 Td\n(2. about:debugging を開く) Tj\n0 -24 Td\n(3. 左側の 「この Firefox」 を選択) Tj\n0 -24 Td\n(4. 「一時的なアドオンを読み込む」をクリック) Tj\n0 -24 Td\n(5. manifest.json があるフォルダを選択) Tj\n0 -24 Td\n(6. 拡張機能を有効化する) Tj\nET\nendstream\nendobj\n',
        '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
        'xref\n0 6\n0000000000 65535 f \n',
    ]
    # 短い簡易 PDF を作成する
    offsets = [0]
    content = ''.join(pdf[:-1])
    # 上記の単純な PDF は本文がうまくいかないので、reportlab が使えない場合は未生成とする
    # 代わりにテキスト版の手順書も出力する
    out_path = root / 'firefox-extension-install-guide.txt'
    text = '''Firefox 拡張機能の読み込み手順\n\n1. Firefox を起動する\n2. アドレスバーに about:debugging と入力して Enter\n3. 左側の「この Firefox」を選択する\n4. 「一時的なアドオンを読み込む」をクリックする\n5. manifest.json があるフォルダを選ぶ\n6. 拡張機能が一覧に表示される\n7. 右側の「有効化」または「オン」を切り替える\n8. 実際のページを開いて、拡張機能のアイコンをクリックする\n9. 画面に動画候補が表示されたら保存を選ぶ\n\n注意事項:\n- この拡張は個人的な利用を前提にしている\n- DRM で保護された動画や HLS/DASH 分割配信には対応しない\n- 直接 URL の MP4 / WebM などを対象にする\n'''
    out_path.write_text(text, encoding='utf-8')
    print('Fallback text guide created at ' + str(out_path))
    raise SystemExit(0)

print('PDF created at ' + str(out_path))
