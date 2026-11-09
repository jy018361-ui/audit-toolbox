"""Read-only worker acceptance for SpreadsheetML exports; sample data stays local."""
import argparse
import csv
import datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET


def run(exe, output, method, params):
    name = method.replace('.', '-')
    request = dict(jobId=name, method=method, params=params,
                   cancelPath=str(output / (name + '.cancel')),
                   pausePath=str(output / (name + '.pause')))
    process = subprocess.run([str(exe), '--rust-table-worker'],
                             input=json.dumps(request) + '\n', capture_output=True,
                             text=True, encoding='utf-8', timeout=180,
                             creationflags=0x08000000)
    events = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
    terminal = [e for e in events if e['phase'] in ('failed', 'completed', 'cancelled')]
    if process.returncode or not terminal or terminal[-1]['phase'] != 'completed':
        raise RuntimeError(f'{method}: {terminal[-1] if terminal else process.stderr}')
    return terminal[-1]['result']


def compare_csv(sample, output):
    ns = 'urn:schemas-microsoft-com:office:spreadsheet'
    tag = '{' + ns + '}'
    root = ET.parse(sample).getroot()
    sheet = root.find(tag + 'Worksheet')
    expected = []
    for row in sheet.findall(tag + 'Table/' + tag + 'Row'):
        cells = []
        for cell in row.findall(tag + 'Cell'):
            column = int(cell.get(tag + 'Index', len(cells) + 1))
            cells.extend([('String', '')] * (column - len(cells)))
            data = cell.find(tag + 'Data')
            value = ''.join(data.itertext()) if data is not None else ''
            kind = data.get(tag + 'Type', 'String') if data is not None else 'String'
            cells[column - 1] = (kind, value)
            cells.extend([('String', '')] * int(cell.get(tag + 'MergeAcross', 0)))
        if any(value for _, value in cells):
            expected.append(cells)
    with output.open(encoding='utf-8-sig', newline='') as source:
        actual = list(csv.reader(source))
    assert len(expected) == len(actual), (len(expected), len(actual))
    compared = 0
    for number, (wanted, row) in enumerate(zip(expected, actual), 1):
        row = row[1:]  # Existing merger adds the source file as the first column.
        width = max(len(row), len(wanted))
        for col in range(width):
            kind, value = wanted[col] if col < len(wanted) else ('String', '')
            saved = row[col] if col < len(row) else ''
            if kind == 'Number':
                equal = Decimal(value) == Decimal(saved)
            elif kind == 'DateTime':
                equal = datetime.datetime.fromisoformat(value).strftime('%Y-%m-%d %H:%M:%S') == saved
            elif kind == 'Boolean':
                equal = saved == ('true' if value in ('1', 'true') else 'false')
            else:
                equal = value == saved
            if not equal:
                # Report coordinates only, keeping source accounting data out of logs.
                raise AssertionError(f'Cell differs at output row {number}, column {col + 1}')
            compared += 1
    return dict(rows=len(actual), comparedCells=compared)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', type=Path, required=True)
    parser.add_argument('--sample', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    exe, sample = args.exe.resolve(strict=True), args.sample.resolve(strict=True)
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    before = hashlib.sha256(sample.read_bytes()).hexdigest()
    common = dict(inputPath=str(sample), headerRow=0)
    results = {}
    for method in ['kanzhang.inspect', 'kanzhang.mark_inspect', 'ts.inspect']:
        source = dict(common)
        if method == 'ts.inspect':
            source['headerRow'] = results['kanzhang.inspect']['headerRow']
        result = run(exe, output, method, source)
        results[method] = {key: result.get(key) for key in ['selectedSheet', 'headerRow', 'dimensions']}
    merged = output / 'sample.csv'
    run(exe, output, 'excel_merger.merge', dict(inputPaths=[str(sample)],
        outputPath=str(merged), outputFormat='csv', outputMode='one_sheet',
        direction='vertical', sheetAction='default', addHyperlinks=False))
    results['mergeRoundtrip'] = compare_csv(sample, merged)
    assert hashlib.sha256(sample.read_bytes()).hexdigest() == before
    results['sourceUnchanged'] = True
    (output / 'summary.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
