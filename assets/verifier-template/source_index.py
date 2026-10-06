"""Read source evidence, NEVER import/eval source. Not a semantic binding detector."""
import hashlib
from pathlib import Path

EXTENSIONS = {'.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.css', '.svg', '.json'}
SKIP = {'node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.venv'}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_sources(root, max_files=5000, max_bytes=50_000_000):
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError('source directory missing')
    result, total = {}, 0
    def visit(folder):
        nonlocal total
        for p in sorted(folder.iterdir()):
            if p.is_symlink() or p.name in SKIP:
                continue
            if p.is_dir():
                visit(p)
            elif p.suffix.lower() in EXTENSIONS:
                total += p.stat().st_size
                if len(result) >= max_files or total > max_bytes:
                    raise ValueError('source resource limit exceeded')
                result[str(p.relative_to(root))] = p.read_text(encoding='utf-8')
    visit(root)
    if not result:
        raise ValueError('no supported source files')
    return result


def literal_locations(files, text):
    """Candidate locations only. Presence is NOT proof of binding or visible content."""
    return [{'path': p, 'line': i, 'snippet': line[:300]} for p, src in files.items()
            for i, line in enumerate(src.splitlines(), 1) if text in line]
