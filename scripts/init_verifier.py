"""Copy a private verifier package and fingerprint source/video, without executing them."""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

if sys.version_info < (3, 10):
    raise SystemExit("Python >=3.10 required; select a newer interpreter.")

TEMPLATE = Path(__file__).resolve().parents[1]/'assets/verifier-template'
sys.path.insert(0, str(TEMPLATE))
from source_index import digest, read_sources


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', required=True); p.add_argument('--video', required=True)
    p.add_argument('--out', required=True); p.add_argument('--case-id', required=True)
    p.add_argument('--entry', required=True); p.add_argument('--export', dest='export_name', required=True)
    p.add_argument('--fps', type=float, required=True); p.add_argument('--width', type=int, required=True); p.add_argument('--height', type=int, required=True)
    p.add_argument('--props', default='{}')
    p.add_argument('--duration-in-frames', type=int, required=True)
    p.add_argument('--time-offset', type=float, default=0)
    a = p.parse_args()
    src, video, out = Path(a.source).resolve(), Path(a.video).resolve(), Path(a.out).resolve()
    if out.exists():
        p.error('output already exists; refusing overwrite')
    if out.is_relative_to(src) or src.is_relative_to(out) or video.is_relative_to(out):
        p.error('output must be separate from inputs')
    if not video.is_file() or not video.stat().st_size:
        p.error('video missing or empty')
    files = read_sources(src)
    manifest = {'case_id': a.case_id, 'source_path': str(src), 'video_path': str(video),
                'video_sha256': digest(video), 'video_bytes': video.stat().st_size,
                'source_sha256': {name: digest(src/name) for name in files},
                'correspondence': 'provided_pair_not_render_verified',
                'composition': {'entry': a.entry, 'export': a.export_name, 'fps': a.fps, 'width': a.width, 'height': a.height, 'props': json.loads(a.props), 'durationInFrames': a.duration_in_frames, 'time_offset_seconds': a.time_offset}, 'clip_range_seconds': None}
    shutil.copytree(TEMPLATE, out, ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    r = json.loads((out/'private/rubric.json').read_text()); r['case_id'] = a.case_id
    for name, data in [('rubric.json', r), ('input-manifest.json', manifest)]:
        (out/'private'/name).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
    (out/'weakness-coverage.json').write_text('[]\n')
    print(json.dumps({'package': str(out), 'status': 'draft', 'source_files': len(files)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
