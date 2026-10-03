#!/usr/bin/env python3
"""Fetch a discovered Verdant study version and a reproducible HTTP receipt."""
import argparse
import hashlib
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ORIGIN = 'https://api.verdant-ai.com'


def canonical(value):
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError('Nonfinite JSON number')
        return int(value) if value.is_integer() else value
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    return value


def content_digest(dataset, rows):
    content = {'metadata': dataset['metadata'], 'observations': [
        {k: v for k, v in row.items() if k not in ('environment', 'dataset_version_id')}
        for row in sorted(rows, key=lambda r: r['id'])]}
    encoded = json.dumps(canonical(content), sort_keys=True, ensure_ascii=True,
                         allow_nan=False, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


def fetch(version, log, page_size=8):
    def get(path):
        url = ORIGIN + path
        for attempt in range(3):
            started = time.monotonic()
            entry = {'url': url, 'at_utc': datetime.now(timezone.utc).isoformat()}
            try:
                with urllib.request.urlopen(url, timeout=45) as response:
                    raw = response.read(1_000_001)
                    entry.update(status=response.status, bytes=len(raw),
                                 sha256=hashlib.sha256(raw).hexdigest())
                if len(raw) > 1_000_000:
                    raise ValueError('Response exceeds service bound')
                return json.loads(raw)
            except urllib.error.HTTPError as error:
                raw = error.read(1_000_001)
                entry.update(status=error.code, bytes=len(raw))
                if error.code not in (429, 502, 503, 504) or attempt == 2:
                    raise
            except urllib.error.URLError as error:
                entry.update(status=None, error=str(error.reason))
                if attempt == 2:
                    raise
            finally:
                entry['seconds'] = round(time.monotonic() - started, 6)
                log.append(entry)
            time.sleep(2 ** attempt)

    path = '/api/v1/datasets/' + urllib.parse.quote(version, safe='')
    dataset = get(path)['dataset']
    if dataset['id'] != version:
        raise ValueError('Metadata version mismatch')
    rows, identities, cursors = [], set(), set()
    cursor = None
    while True:
        params = {'limit': page_size}
        if cursor is not None:
            params['after'] = cursor
        try:
            page = get(path + '/observations?' + urllib.parse.urlencode(params))
        except urllib.error.HTTPError as error:
            if error.code != 413 or page_size == 1:
                raise
            page_size = max(1, page_size // 2)
            continue
        if page['datasetVersion'] != version:
            raise ValueError('Page version mismatch')
        for row in page['observations']:
            if row['id'] in identities or row['dataset_version_id'] != version:
                raise ValueError('Duplicate row or mixed version')
            identities.add(row['id'])
            rows.append(row)
        cursor = page['nextCursor']
        if cursor is None:
            break
        if not cursor or cursor in cursors or not page['observations']:
            raise ValueError('Pagination did not advance')
        cursors.add(cursor)
    if len(rows) != dataset['metadata']['observation_count']:
        raise ValueError('Incomplete observation cohort')
    if content_digest(dataset, rows) != dataset['content_sha256']:
        raise ValueError('Dataset content hash mismatch')
    return {'dataset': dataset, 'observations': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', help='Immutable ID discovered from the live catalog')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    receipt = args.output.with_suffix(args.output.suffix + '.http.json')
    if args.output.exists() or receipt.exists():
        parser.error('Use a new output path; existing run artifacts are preserved')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    log = []
    try:
        result = fetch(args.version, log)
        args.output.write_text(json.dumps(result, allow_nan=False) + '\n')
        print(json.dumps({'status': 'verified', 'version': args.version,
                          'observations': len(result['observations']),
                          'output': str(args.output)}))
    finally:
        receipt.write_text(json.dumps(log, indent=2) + '\n')


if __name__ == '__main__':
    main()
