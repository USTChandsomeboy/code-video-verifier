"""Deterministic scoring; no project imports, rendering, or model calls."""
import math
from collections import defaultdict

WEIGHTS = {'presence': .15, 'appearance': .25, 'binding': .20, 'motion': .40}
STATES = {'ok', 'missing', 'unresolved', 'unsupported'}


def number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def validate_rubric(r):
    if r.get('schema_version') != 1 or not r.get('case_id') or not r.get('version'):
        raise ValueError('rubric identity/version missing')
    objects = r.get('objects')
    if not isinstance(objects, list) or not objects or any(not isinstance(o, str) or not o for o in objects) or len(set(objects)) != len(objects):
        raise ValueError('objects must be unique nonempty IDs')
    checks = r.get('checks')
    if not isinstance(checks, list) or not checks:
        raise ValueError('no executable checks: package is still draft')
    ids = set()
    dims = set()
    used = set()
    for c in checks:
        if not isinstance(c.get('id'), str) or not c['id'] or c['id'] in ids:
            raise ValueError('invalid/duplicate check ID')
        ids.add(c['id'])
        if c.get('object_id') not in objects or c.get('dimension') not in WEIGHTS:
            raise ValueError('unknown object/dimension')
        used.add(c['object_id']); dims.add(c['dimension'])
        for key in ['weakness_id', 'description', 'measure', 'unit', 'reference']:
            if not isinstance(c.get(key), str) or not c[key]:
                raise ValueError('check missing ' + key)
        if not all(number(c.get(k)) for k in ['good', 'bad', 'weight']):
            raise ValueError('invalid threshold/weight')
        if c['good'] < 0 or c['bad'] <= c['good'] or c['weight'] <= 0:
            raise ValueError('threshold ordering/weight invalid')
        w = c.get('window_seconds')
        if not isinstance(w, list) or len(w) != 2 or not all(number(x) for x in w) or not 0 <= w[0] < w[1]:
            raise ValueError('invalid time window')
        ev = c.get('evidence', [])
        if not isinstance(ev, list) or not all(isinstance(e, dict) for e in ev) or not {'code', 'video'} <= {e.get('type') for e in ev}:
            raise ValueError('reference needs code and video evidence')
    if dims != set(WEIGHTS) or used != set(objects):
        raise ValueError('all four dimensions and declared objects need checks')


def error_score(error, good, bad):
    if not number(error) or error < 0:
        raise ValueError('error must be finite and nonnegative')
    return 100.0 if error <= good else 0.0 if error >= bad else 100.0 * (bad-error)/(bad-good)


def evaluate(rubric, observations):
    validate_rubric(rubric)
    if not isinstance(observations, list):
        raise ValueError('checks observations must be list')
    obs = {}
    expected = {c['id'] for c in rubric['checks']}
    for o in observations:
        if not isinstance(o, dict) or o.get('id') not in expected or o['id'] in obs:
            raise ValueError('unknown/duplicate observation ID')
        if o.get('status') not in STATES:
            raise ValueError('invalid observation status')
        if 'score' in o:
            raise ValueError('adapter must return error, never self-reported score')
        if o['status'] != 'ok' and not o.get('reason'):
            raise ValueError('non-ok observation needs reason')
        if o['status'] in {'ok', 'missing'} and (not isinstance(o.get('evidence'), list) or not o['evidence'] or not all(isinstance(e, dict) for e in o['evidence'])):
            raise ValueError('resolved observation needs evidence')
        if o['status'] == 'ok':
            error_score(o.get('error'), 0, 1)
        obs[o['id']] = o
    if set(obs) != expected:
        raise ValueError('missing observations; do not silently shrink denominator')
    missing_objects = {c['object_id'] for c in rubric['checks'] if obs[c['id']]['status'] == 'missing'}
    rows = []
    groups = {d: defaultdict(list) for d in WEIGHTS}
    for c in rubric['checks']:
        o = obs[c['id']]
        missing = c['object_id'] in missing_objects
        status = 'missing' if missing else o['status']
        score = 0.0 if missing else error_score(o['error'], c['good'], c['bad']) if status == 'ok' else None
        row = dict(o, object_id=c['object_id'], dimension=c['dimension'], weakness_id=c['weakness_id'], status=status, score=score,
                   missing_propagated=missing and o['status'] != 'missing')
        rows.append(row)
        groups[c['dimension']][c['object_id']].append((c['weight'], score))
    dimensions, weighted_coverage = {}, 0.0
    for dim, objects in groups.items():
        object_scores, coverages = [], []
        for entries in objects.values():
            denominator = sum(w for w, s in entries)
            coverages.append(sum(w for w, s in entries if s is not None)/denominator)
            object_scores.append(None if any(s is None for w, s in entries) else sum(w*s for w, s in entries)/denominator)
        dimensions[dim] = None if any(s is None for s in object_scores) else sum(object_scores)/len(object_scores)
        weighted_coverage += WEIGHTS[dim]*sum(coverages)/len(coverages)
    total = None if any(s is None for s in dimensions.values()) else sum(WEIGHTS[d]*s for d, s in dimensions.items())
    return {'total': total, 'dimensions': dimensions, 'weights': WEIGHTS,
            'coverage': {'resolved': sum(x['score'] is not None for x in rows), 'declared': len(rows), 'weighted': weighted_coverage},
            'checks': rows}
