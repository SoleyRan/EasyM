"""Read-only PDF evaluation: extract/check content and render every page.

Run with the bundled Python; pass --poppler with the pdftoppm executable.
Generated PDFs and contact sheets stay in ignored test-results/.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

from pypdf import PdfReader
from PIL import Image, ImageDraw

args = argparse.ArgumentParser()
args.add_argument('--poppler', required=True)
options = args.parse_args()
root = Path('test-results/pdf-engines')
generation = json.loads((root / 'generation.json').read_text(encoding='utf8'))
assert generation['passed'], generation.get('failure')
results = []
for run in generation['runs']:
    name = run['filename']
    pdf = PdfReader(root / name)
    texts = [page.extract_text() or '' for page in pdf.pages]
    text = '\n'.join(texts)
    fonts = {}
    for page in pdf.pages:
        for item in page['/Resources'].get('/Font', {}).values():
            font = item.get_object()
            descendants = font.get('/DescendantFonts', [])
            descriptor = font.get('/FontDescriptor')
            if descendants:
                descriptor = descendants[0].get_object().get('/FontDescriptor')
            descriptor = descriptor.get_object() if descriptor else {}
            font_name = str(font.get('/BaseFont'))
            fonts[font_name] = {'subtype': str(font.get('/Subtype')), 'embedded': any(key in descriptor for key in ['/FontFile', '/FontFile2', '/FontFile3']), 'subsetName': bool(re.match(r'^/[A-Z]{6}\+', font_name))}
    record = {**run, 'pages': len(pdf.pages), 'pageSizePt': [float(pdf.pages[0].mediabox.width), float(pdf.pages[0].mediabox.height)], 'blankTextPages': [i + 1 for i, body in enumerate(texts) if not body.strip()], 'fonts': fonts}
    unsafe_actions = []
    for page in pdf.pages:
        for annotation in page.get('/Annots', []):
            action = annotation.get_object().get('/A')
            if not action:
                continue
            action = action.get_object()
            uri = str(action.get('/URI', ''))
            if action.get('/S') in ['/JavaScript', '/Launch', '/GoToR'] or re.match(r'^(javascript|file|data):', uri, re.I):
                unsafe_actions.append(str(action))
    record['unsafeAnnotationActions'] = unsafe_actions
    assert not unsafe_actions, (name, unsafe_actions)
    if run['fixture'] == 'stress':
        record['rowIdsFound'] = len(set(re.findall(r'ROW-\d{3}', text)))
        record['codeIdsFound'] = len(set(re.findall(r'CODE-\d{3}', text)))
        normalized = re.sub(r'\s', '', text)
        record['missingSentinels'] = [marker for marker in ['LONG-BEGIN', 'LONG-END', 'FINAL-SENTINEL', '中文结束', '标题-12'] if marker not in normalized]
        record['tableHeaderPages'] = [i + 1 for i, body in enumerate(texts) if 'ROW-ID' in body]
        record['headingsAtPageEnd'] = [i + 1 for i, body in enumerate(texts) if body.strip() and body.strip().splitlines()[-1].startswith(('标题-', '跨页表格', '长代码', '大图片', '结束标题'))]
    record['emojiInExtractedText'] = {emoji: emoji in text for emoji in ['🙂', '🚀', '✅']}
    (root / (name + '.txt')).write_text(text, encoding='utf8')
    prefix = root / 'rendered' / name.removesuffix('.pdf')
    prefix.parent.mkdir(exist_ok=True)
    subprocess.run([options.poppler, '-scale-to', '800', '-png', str(root / name), str(prefix)], check=True, capture_output=True)
    pages = sorted(prefix.parent.glob(prefix.name + '-*.png'), key=lambda path: int(path.stem.rsplit('-', 1)[1]))
    record['renderedPages'] = len(pages)
    record['visuallyBlankPages'] = []
    for i, path in enumerate(pages):
        pixels = Image.open(path).convert('L').histogram()
        if sum(pixels[:245]) / sum(pixels) < 0.0001:
            record['visuallyBlankPages'].append(i + 1)
    assert len(pages) == len(pdf.pages)
    # At most 12 pages per sheet, legible at full resolution via view_image.
    record['contactSheets'] = []
    for start in range(0, len(pages), 12):
        subset = pages[start:start + 12]
        sheet = Image.new('RGB', (4 * 420, ((len(subset) + 3) // 4) * 620), '#d8d8d8')
        draw = ImageDraw.Draw(sheet)
        for n, path in enumerate(subset):
            image = Image.open(path).convert('RGB')
            image.thumbnail((410, 585))
            x, y = (n % 4) * 420, (n // 4) * 620
            sheet.paste(image, (x + 5, y + 25))
            draw.text((x + 7, y + 5), f'{name} p{start + n + 1}', fill='black')
        sheet_path = root / f'{name}.sheet-{start // 12 + 1}.png'
        sheet.save(sheet_path)
        record['contactSheets'].append(str(sheet_path))
    results.append(record)
(root / 'inspection.json').write_text(json.dumps({'results': results}, indent=2, ensure_ascii=False) + '\n', encoding='utf8')
print(json.dumps([{key: run.get(key) for key in ['engine', 'fixture', 'format', 'pages', 'rowIdsFound', 'codeIdsFound', 'missingSentinels', 'blankTextPages']} for run in results], ensure_ascii=False, indent=2))
