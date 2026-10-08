"""Behavioral tests of common engine/CLI; not validation of a real-video verifier."""
import copy
import json
import math
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
TEMPLATE = SKILL/'assets/verifier-template'
sys.path.insert(0, str(TEMPLATE))
from score_core import evaluate, error_score, validate_rubric
from source_index import read_sources


def rubric():
    checks = []
    for d in ['presence', 'appearance', 'binding', 'motion']:
        checks.append({'id': 'box.'+d, 'object_id': 'box', 'dimension': d,
                       'weakness_id': 'W02', 'description': d, 'window_seconds': [0, 1],
                       'measure': 'test_error', 'unit': 'normalized', 'good': 0, 'bad': 1, 'weight': 1,
                       'reference': 'reference-data/box.json',
                       'evidence': [{'type': 'code', 'path': 'src.tsx', 'line': 1}, {'type': 'video', 'seconds': 0}]})
    return {'schema_version': 1, 'case_id': 'engine-fixture', 'version': '1', 'objects': ['box'], 'checks': checks}


def observations(r, error=0):
    return [{'id': c['id'], 'status': 'ok', 'error': error, 'evidence': [{'type': 'fixture'}]} for c in r['checks']]


class EngineTests(unittest.TestCase):
    def test_perfect_and_monotonic(self):
        r = rubric()
        self.assertEqual(evaluate(r, observations(r))['total'], 100)
        totals = [evaluate(r, observations(r, e))['total'] for e in [0, .1, .5, 1, 2]]
        self.assertEqual(totals, sorted(totals, reverse=True))
        self.assertAlmostEqual(error_score(.08, .02, .15), 53.846153846)

    def test_fixed_weight_example(self):
        r = rubric(); o = observations(r)
        for x,e in zip(o,[.05,.2,.4,.3]): x['error'] = e
        self.assertAlmostEqual(evaluate(r,o)['total'], 74.25)

    def test_missing_propagates(self):
        r=rubric();o=observations(r)
        o[0].update(status='missing', reason='confirmed object absent')
        result=evaluate(r,o)
        self.assertEqual(result['total'],0)
        self.assertEqual(result['coverage']['weighted'],1)

    def test_unresolved_not_zero_or_renormalized(self):
        r=rubric();o=observations(r)
        o[3]={'id':o[3]['id'],'status':'unresolved','reason':'ambiguous matching'}
        result=evaluate(r,o)
        self.assertIsNone(result['total']);self.assertIsNone(result['dimensions']['motion'])
        self.assertAlmostEqual(result['coverage']['weighted'],.6)

    def test_bad_observations_rejected(self):
        r=rubric()
        for bad in [float('nan'),float('inf'),-1,True]:
            with self.assertRaises(ValueError):evaluate(r,observations(r,bad))
        o=observations(r)
        for variant in [o[:-1],o+[o[0]]]:
            with self.assertRaises(ValueError):evaluate(r,variant)
        o[0]['score']=100
        with self.assertRaises(ValueError):evaluate(r,o)

    def test_duplicate_and_invalid_rubric(self):
        for key,value in [('bad',0),('weight',0),('good',float('nan'))]:
            r=rubric();r['checks'][0][key]=value
            with self.assertRaises(ValueError):validate_rubric(r)
        r=rubric();r['checks'].append(r['checks'][0])
        with self.assertRaises(ValueError):validate_rubric(r)

    def test_object_balancing(self):
        r=rubric();r['objects'].append('second')
        second=copy.deepcopy(r['checks'][3]);second.update(id='second.motion',object_id='second')
        r['checks'].append(second);o=observations(r);o[-1]['error']=1
        before=evaluate(r,o)['dimensions']['motion']
        for i in range(10):
            c=copy.deepcopy(r['checks'][3]);c['id']='box.extra'+str(i);r['checks'].append(c)
            o.append({'id':c['id'],'status':'ok','error':0,'evidence':[{'type':'fixture'}]})
        self.assertEqual(before,50);self.assertEqual(evaluate(r,o)['dimensions']['motion'],50)

    def test_unknown_check_does_not_erase_known_failures(self):
        r=rubric();o=observations(r)
        o[0].update(error=1)
        o[3]={'id':o[3]['id'],'status':'unsupported','reason':'external CSS'}
        result=evaluate(r,o)
        self.assertIsNone(result['total'])
        self.assertEqual(result['dimensions']['presence'],0)
        self.assertAlmostEqual(result['coverage']['weighted'],.6)

    def test_missing_object_keeps_denominator(self):
        r=rubric();r['objects'].append('second')
        for c in list(r['checks']):
            twin=copy.deepcopy(c);twin.update(id=c['id'].replace('box','second'),object_id='second');r['checks'].append(twin)
        o=observations(r);o[4].update(status='missing',reason='target deleted')
        result=evaluate(r,o)
        self.assertEqual(result['total'],50)
        self.assertEqual(result['coverage']['resolved'],8)

    def test_no_source_execution(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);(root/'src.tsx').write_text('throw new Error("DO NOT RUN");')
            (root/'node_modules').mkdir();(root/'node_modules/x.tsx').write_text('ignored')
            self.assertEqual(list(read_sources(root)),['src.tsx'])


class CliTests(unittest.TestCase):
    def test_draft_integrity_and_unimplemented_adapter(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);src=root/'src';src.mkdir();(src/'index.tsx').write_text('throw new Error("not executed");')
            video=root/'video.bin';video.write_bytes(b'not a video: engine-only fixture')
            package=root/'package'
            cmd=[sys.executable,str(SKILL/'scripts/init_verifier.py'),'--source',str(src),'--video',str(video),'--out',str(package),'--case-id','fixture','--entry','index.tsx','--export','default','--fps','30','--width','640','--height','360','--duration-in-frames','30']
            subprocess.run(cmd,check=True,capture_output=True)
            r=rubric();(package/'private/rubric.json').write_text(json.dumps(r))
            (package/'private/reference-data/box.json').write_text('{}')
            (package/'private/validation.json').write_text(json.dumps({'status':'draft','rubric_version':'1','tests':[]}))
            # Unimplemented adapter must not give a passing score.
            args=[sys.executable,str(package/'verify.py'),'--reference-code',str(src),'--replica-code',str(src),'--replica-entry','index.tsx','--replica-export','default','--output',str(root/'result')]
            run=subprocess.run(args,capture_output=True,text=True)
            self.assertEqual(run.returncode,2)
            result=json.loads((root/'result/scores.json').read_text())
            self.assertIsNone(result['total']);self.assertEqual(result['status'],'evaluation_error')
            # Synthetic trusted adapter tests CLI plumbing, not video semantics.
            adapter='def measure(reference_code,replica_code,private_dir,rubric,reference_cfg,replica_cfg):\n    return {"checks": [{"id": c["id"], "status":"ok", "error":0, "evidence":[{"type":"synthetic engine fixture"}]} for c in rubric["checks"]]}\n'
            (package/'case_adapter.py').write_text(adapter)
            subprocess.run([sys.executable,str(SKILL/'scripts/seal_verifier.py'),'--package',str(package)],check=True,capture_output=True)
            subprocess.run(args,capture_output=True)
            result=json.loads((root/'result/scores.json').read_text())
            self.assertIsNone(result['total']);self.assertEqual(result['provisional_total'],100);self.assertTrue(result['integrity_ok'])
            (package/'private/reference-data/box.json').write_text('{"changed":true}')
            subprocess.run(args,capture_output=True)
            result=json.loads((root/'result/scores.json').read_text());self.assertFalse(result['integrity_ok'])
            self.assertEqual(result['status'],'evaluation_error');self.assertIsNone(result['provisional_total'])
            # Changed reference fingerprint is rejected.
            (src/'scores.json').write_text('{"total":999}')
            subprocess.run(args,capture_output=True)
            result=json.loads((root/'result/scores.json').read_text());self.assertEqual(result['status'],'evaluation_error')
            # Claiming verified without the required records cannot be sealed.
            (package/'private/validation.json').write_text(json.dumps({'status':'verified','rubric_version':'1','tests':[]}))
            run=subprocess.run([sys.executable,str(SKILL/'scripts/seal_verifier.py'),'--package',str(package)],capture_output=True)
            self.assertNotEqual(run.returncode,0)


if __name__=='__main__':
    unittest.main(verbosity=2)
