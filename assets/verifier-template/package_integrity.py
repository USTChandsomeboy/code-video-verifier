import hashlib
from pathlib import Path

SKIP = {'__pycache__', '.venv', '.git', 'node_modules'}


def package_hashes(root):
    root = Path(root).resolve()
    result = {}
    for p in sorted(root.rglob('*')):
        rel = p.relative_to(root)
        if any(x in SKIP for x in rel.parts) or str(rel) == 'private/freeze.json':
            continue
        if p.is_symlink():
            raise ValueError('package must be self-contained; symlinks not allowed')
        if p.is_file():
            result[rel.as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result


def contained_file(root, rel):
    p = (Path(root)/rel).resolve()
    if not p.is_relative_to(Path(root).resolve()) or not p.is_file():
        raise ValueError('missing/outside package file: ' + str(rel))
    return p
