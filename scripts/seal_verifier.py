"""Structural validation + integrity seal. Does not certify semantic test truth."""
import argparse
import json
import sys
from pathlib import Path

if sys.version_info < (3, 10):
    raise SystemExit("Python >=3.10 required; select a newer interpreter.")

TEMPLATE = Path(__file__).resolve().parents[1]/'assets/verifier-template'
sys.path.insert(0, str(TEMPLATE))
from score_core import validate_rubric
from package_integrity import package_hashes, contained_file


def main():
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--package', required=True)
    root = Path(p.parse_args().package).resolve()
    r = json.loads((root/'private/rubric.json').read_text()); validate_rubric(r)
    for c in r['checks']:
        contained_file(root/'private', c['reference'])
    for name in ['case_adapter.py', 'source_analyzer.cjs', 'source_compare.py', 'verify.py', 'README.md', 'private/objects.json', 'private/input-manifest.json', 'weakness-coverage.json']:
        contained_file(root, name)
    v = json.loads((root/'private/validation.json').read_text())
    if v.get('status') not in {'draft', 'verified'} or v.get('rubric_version') != r['version']:
        raise ValueError('invalid validation state/version')
    kinds = set()
    for t in v.get('tests', []):
        if t.get('passed') is True:
            if not t.get('scope') or not t.get('command'):
                raise ValueError('test needs scope/command')
            contained_file(root, t['artifact']); kinds.add(t['kind'])
    required = {'self_pair', 'equivalent_pair', 'controlled_errors', 'real_pair'}
    if v['status'] == 'verified' and not required <= kinds:
        raise ValueError('verified requires self/equivalent/controlled/real pair records')
    frozen = {'schema_version': 1, 'rubric_version': r['version'], 'files': package_hashes(root)}
    (root/'private/freeze.json').write_text(json.dumps(frozen, indent=2)+'\n')
    print(json.dumps({'status': v['status'], 'files': len(frozen['files']), 'note': 'Integrity seal is not semantic proof.'}))

if __name__ == '__main__':
    main()
