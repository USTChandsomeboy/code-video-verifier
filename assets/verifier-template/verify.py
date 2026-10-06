"""Compare reference and replica source using a frozen case definition."""
import argparse
import importlib.util
import json
import sys
from pathlib import Path
if sys.version_info < (3, 10):
    raise SystemExit("Python >=3.10 required")
from score_core import evaluate, validate_rubric
from source_index import digest, read_sources
from package_integrity import package_hashes, contained_file

def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)+'\n')

def run(a):
    root=Path(__file__).resolve().parent
    ref,rep,out=map(lambda p:Path(p).resolve(),[a.reference_code,a.replica_code,a.output])
    for src in [root,ref,rep]:
        if out==src or out.is_relative_to(src) or src.is_relative_to(out):
            raise ValueError('output must be separate from evaluator and source inputs')
    out.mkdir(parents=True,exist_ok=True)
    result={'status':'evaluation_error','total':None,'provisional_total':None}
    try:
        hashes={kind:{p:digest(src/p) for p in read_sources(src)} for kind,src in [('reference',ref),('replica',rep)]}
        manifest=json.loads((root/'private/input-manifest.json').read_text())
        if hashes['reference'] != manifest['source_sha256']:
            raise ValueError('reference source differs from frozen generation input')
        rubric=json.loads((root/'private/rubric.json').read_text());validate_rubric(rubric)
        for check in rubric['checks']: contained_file(root/'private',check['reference'])
        validation=json.loads((root/'private/validation.json').read_text())
        fp=root/'private/freeze.json';frozen=json.loads(fp.read_text()) if fp.exists() else {}
        integrity=bool(frozen) and frozen.get('files')==package_hashes(root) and frozen.get('rubric_version')==rubric['version']
        verified=validation.get('status')=='verified' and validation.get('rubric_version')==rubric['version'] and integrity
        kinds=set()
        for test in validation.get('tests',[]):
            if test.get('passed') is True and test.get('scope') and test.get('command'):
                contained_file(root,test['artifact']);kinds.add(test['kind'])
        verified=verified and {'self_pair','equivalent_pair','controlled_errors','real_pair'}<=kinds
        cfg=manifest['composition']
        if not isinstance(cfg,dict) or not cfg.get('entry') or not cfg.get('export'): raise ValueError('reference composition is unconfigured')
        replica_cfg=dict(cfg,entry=a.replica_entry,export=a.replica_export,time_offset_seconds=a.replica_time_offset)
        if a.replica_duration_in_frames is not None:replica_cfg['durationInFrames']=a.replica_duration_in_frames
        for key in ['fps','width','height']:
            value=getattr(a,'replica_'+key)
            if value is not None: replica_cfg[key]=value
            if not isinstance(replica_cfg.get(key),(int,float)) or replica_cfg[key]<=0: raise ValueError('invalid composition '+key)
        replica_cfg['props']=json.loads(a.replica_props) if a.replica_props else cfg.get('props',{})
        spec=importlib.util.spec_from_file_location('trusted_case_adapter',root/'case_adapter.py')
        adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
        measured=adapter.measure(ref,rep,root/'private',rubric,cfg,replica_cfg)
        scores=evaluate(rubric,measured['checks']);rows=scores.pop('checks');total=scores.pop('total')
        result.update(scores)
        result.update(case_id=rubric['case_id'],rubric_version=rubric['version'],integrity_ok=integrity,
            status='valid' if verified and total is not None else 'incomplete' if total is None else 'draft',
            total=total if verified else None,provisional_total=total if not verified else None,
            inputs={'source_sha256':hashes,'reference_composition':cfg,'replica_composition':replica_cfg},
            scope=manifest.get('evaluation_scope','Declared source checks'))
        write(out/'checks.json',rows);write(out/'matches.json',measured.get('matches',[]))
        write(out/'diagnostics.json',measured.get('diagnostics',[])+([] if verified else ['Package draft or modified: result is provisional.']))
    except Exception as exc:
        result.update(status='evaluation_error',total=None,provisional_total=None,reason=str(exc))
        for name in ['checks','matches']:write(out/(name+'.json'),[])
        write(out/'diagnostics.json',[str(exc)])
    write(out/'scores.json',result)
    print(json.dumps({k:v for k,v in result.items() if k!='inputs'},ensure_ascii=False,allow_nan=False))
    return 0 if result['status']=='valid' else 2

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--reference-code',required=True);p.add_argument('--replica-code',required=True)
    p.add_argument('--replica-entry',required=True);p.add_argument('--replica-export',required=True)
    p.add_argument('--replica-fps',type=float);p.add_argument('--replica-width',type=int);p.add_argument('--replica-height',type=int)
    p.add_argument('--replica-props',help='JSON input props')
    p.add_argument('--replica-duration-in-frames',type=int)
    p.add_argument('--replica-time-offset',type=float,default=0)
    p.add_argument('--output',required=True)
    raise SystemExit(run(p.parse_args()))
