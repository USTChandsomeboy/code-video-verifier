"""Deterministic comparisons of reachable JSX source observations."""
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

class Unsupported(Exception): pass
class Ambiguous(Exception): pass

def unknown(v):
    if isinstance(v,dict):
        return '$unknown' in v or v.get('kind') in {'unknown','undefined'} or any(unknown(x) for x in v.values())
    return isinstance(v,list) and any(unknown(x) for x in v)

def normalized(s): return re.sub(r'\s+','',str(s))
def text_of(n):
    if isinstance(n,str):return n
    if not isinstance(n,dict):return ''
    if n.get('kind')=='text':return n.get('text','')
    return ''.join(text_of(x) for x in n.get('children',[]))
def walk(tree,anc=()):
    if not isinstance(tree,list):tree=[tree]
    for n in tree:
        if isinstance(n,dict):
            yield n,anc
            yield from walk(n.get('children',[]),anc+(n,))
def element(n): return n.get('kind')=='element'
def loc(n):return n.get('source') or {'file':n.get('file'),'line':n.get('line')}
def ident(n,anc):
    return tuple((x.get('tag'),loc(x).get('file'),loc(x).get('start',loc(x).get('line')),str(x.get('attrs',{}).get('key',''))) for x in (*anc,n))
def structural_unknown(tree):
    return any(n.get('kind')=='unknown' or '$unknown' in n for n,a in walk(tree))
def num(x):
    if unknown(x) or isinstance(x,(dict,list,bool)):raise Unsupported('numeric property is unresolved')
    try:v=float(x)
    except (TypeError,ValueError):raise Unsupported('non-numeric property')
    if not math.isfinite(v):raise Unsupported('non-finite property')
    return v

def points(n):
    a=n.get('attrs',{});tag=n.get('tag')
    if tag=='line':return [(num(a.get('x1',0)),num(a.get('y1',0))),(num(a.get('x2',0)),num(a.get('y2',0)))]
    if tag in {'polygon','polyline'}:
        if unknown(a.get('points')):raise Unsupported('unknown SVG points')
        vals=[float(v) for v in re.findall(r'[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?',str(a.get('points','')),re.I)]
        if len(vals)%2 or len(vals)<4:raise Unsupported('invalid SVG points')
        return list(zip(vals[::2],vals[1::2]))
    if tag!='path':raise Unsupported('not a supported SVG shape')
    d=a.get('d','')
    if not isinstance(d,str) or re.search(r'[^MLHVZ\s,]',re.sub(r'[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?','',d)):raise Unsupported('SVG path requires absolute M/L/H/V/Z')
    tokens=re.findall(r'[MLHVZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?',d,re.I)
    i=0;cmd=None;x=y=0;out=[]
    while i<len(tokens):
        if re.fullmatch('[MLHVZ]',tokens[i]):cmd=tokens[i];i+=1
        if cmd=='Z':break
        try:
            if cmd in {'M','L'}:x,y=float(tokens[i]),float(tokens[i+1]);i+=2
            elif cmd=='H':x=float(tokens[i]);i+=1
            elif cmd=='V':y=float(tokens[i]);i+=1
            else:raise Unsupported('unsupported path command')
        except (ValueError,IndexError):raise Unsupported('invalid path')
        out.append((x,y))
        if cmd=='M':cmd='L'
    if len(out)>1 and out[-1]==out[0]:out.pop()
    if len(out)<2:raise Unsupported('empty path')
    return out

def accepts(n,s):
    if not element(n):return False
    if s.get('tags') and n.get('tag') not in s['tags']:return False
    txt=normalized(text_of(n))
    if s.get('text_contains') and not all(normalized(x) in txt for x in s['text_contains']):return False
    if s.get('text_any') and not any(normalized(x)==txt for x in s['text_any']):return False
    a=n.get('attrs',{})
    if s.get('stroke') and (not a.get('stroke') or a.get('stroke')=='none'):return False
    if s.get('no_filter') and a.get('filter'):return False
    if s.get('dashed') and not a.get('strokeDasharray'):return False
    shape=s.get('shape')
    if shape:
        try:p=points(n)
        except Unsupported:return False
        if shape=='vertical_line' and not (len(p)==2 and abs(p[0][0]-p[1][0])<1e-6 and abs(p[0][1]-p[1][1])>0):return False
        if shape=='triangle' and (len(set(p))!=3 or (n.get('tag')=='path' and not str(a.get('d','')).rstrip().endswith('Z'))):return False
    return True

def select(frame,s):
    candidates=[(n,a) for n,a in walk(frame['tree']) if accepts(n,s)]
    if s.get('minimal',True):
        candidates=[(n,a) for n,a in candidates if not any(accepts(child,s) for child,ca in walk(n.get('children',[])))]
    if len(candidates)>1:raise Ambiguous('multiple reachable elements match the object selector')
    if not candidates:
        if structural_unknown(frame['tree']):raise Unsupported('unresolved JSX may contain the target object')
        if s.get('shape') and any(element(n) and n.get('tag') in s.get('tags',['path','line','polygon','polyline']) and unknown(n.get('attrs',{})) for n,a in walk(frame['tree'])):
            raise Unsupported('unresolved shape properties may match the target object')
        return None
    n,a=candidates[0]
    up=s.get('ancestor',0)
    dom=[x for x in a if element(x)]
    if up:
        if len(dom)<up:raise Unsupported('requested object container is unavailable')
        n=dom[-up];a=a[:a.index(n)]
    return n,a

def prop(n,anc,name):
    nodes=[x for x in (*anc,n) if element(x)]
    if name=='opacity':
        result=1.0
        for x in nodes:
            a=x.get('attrs',{});st=a.get('style',{})
            if not isinstance(st,dict) or '$unknown' in st or unknown(st.get('__unknown_spread')) or unknown(a.get('__unknown_spread')):raise Unsupported('unresolved style/attribute spread')
            # CSS opacity overrides the SVG presentation attribute.
            v=st.get('opacity',a.get('opacity',1)) if isinstance(st,dict) else a.get('opacity',1)
            result*=num(v)
            if isinstance(st,dict) and (st.get('display')=='none' or st.get('visibility')=='hidden'):result=0
        return result
    if name=='draw_progress':
        a=n.get('attrs',{});dash=num(a.get('strokeDasharray'));offset=num(a.get('strokeDashoffset',0))
        if dash<=0:raise Unsupported('invalid stroke dash length')
        return 1-offset/dash
    if name=='aspect_ratio':
        p=points(n);w=max(x for x,y in p)-min(x for x,y in p);h=max(y for x,y in p)-min(y for x,y in p)
        if w<=0:raise Unsupported('zero-width shape')
        return h/w
    if name in {'text','answer_value','text_length'}:
        if structural_unknown(n):raise Unsupported('text contains an unresolved child')
        text=normalized(text_of(n))
        if name=='answer_value':return text.split('答案',1)[-1]
        if name=='text_length':return len(text.replace('|',''))
        return text
    if name=='scale_binding':
        numeric_scale=1.0; symbolic_frame=None
        for x in nodes:
            st=x.get('attrs',{}).get('style',{})
            if not isinstance(st,dict) or '$unknown' in st or unknown(st.get('__unknown_spread')):raise Unsupported('unknown transform container')
            transform=st.get('transform','') if isinstance(st,dict) else ''
            if unknown(transform):raise Unsupported('unknown transform')
            if isinstance(transform,dict) and '$symbolic' in transform:
                raw=json.dumps(transform,ensure_ascii=False)
                if 'scale(' in raw and 'spring' in raw:
                    parts=transform['$symbolic'].get('parts',[])
                    springs=[v['$symbolic'] for v in parts if isinstance(v,dict) and v.get('$symbolic',{}).get('kind')=='spring']
                    if len(springs)!=1:raise Unsupported('complex symbolic scale')
                    sp=springs[0]
                    if symbolic_frame is not None:raise Unsupported('multiple symbolic scales require composition support')
                    if sp.get('from',0)!=sp.get('to',1):symbolic_frame=num(sp.get('frame'))
                    continue
                if 'scale' not in raw:continue
                raise Unsupported('unsupported symbolic transform')
            if isinstance(transform,str):
                m=re.search(r'\bscale(?:X|Y)?\(([-+0-9.e]+)\)',transform)
                if m:numeric_scale*=float(m.group(1))
                elif 'scale' in transform:raise Unsupported('scale syntax requires extension')
        return symbolic_frame*numeric_scale if symbolic_frame is not None else numeric_scale
    raise Unsupported('unknown measurement property '+name)

def analyze(root,code,cfg,times):
    node=os.environ.get('VERIFIER_NODE') or shutil.which('node')
    if not node:raise ValueError('Node.js runtime not found; set VERIFIER_NODE')
    with tempfile.TemporaryDirectory(prefix='source-verifier-') as tmp:
        dest=Path(tmp)/'tree.json'
        cmd=[node,str(root/'source_analyzer.cjs'),'--source',str(code),'--entry',cfg['entry'],'--export',cfg['export'],
             '--fps',str(cfg['fps']),'--width',str(cfg['width']),'--height',str(cfg['height']),
             '--props',json.dumps(cfg.get('props',{})),'--times',json.dumps([t+cfg.get('time_offset_seconds',0) for t in times]),'--duration-in-frames',str(cfg['durationInFrames']),'--output',str(dest)]
        run=subprocess.run(cmd,capture_output=True,text=True,timeout=120)
        if run.returncode:raise ValueError('source analysis failed: '+run.stderr[-2000:])
        data=json.loads(dest.read_text())
        for frame in data['frames']:frame['time']=round(frame['time']-cfg.get('time_offset_seconds',0),8)
        if any(d.get('code')=='parse_error' for d in data.get('diagnostics',[])):raise ValueError('source contains syntax errors; analysis is incomplete')
        return data

def sampled_object(data,obj):
    anchor=min(data['frames'],key=lambda f:abs(f['time']-obj['anchor_time']))
    selected=select(anchor,obj['selector'])
    if not selected:return None
    n,anc=selected;key=ident(n,anc)
    track=[]
    for frame in data['frames']:
        matches=[(x,a) for x,a in walk(frame['tree']) if ident(x,a)==key]
        if len(matches)>1:raise Ambiguous('object tracking identity is duplicated')
        track.append({'time':frame['time'],'node':matches[0] if matches else None,'unknown':structural_unknown(frame['tree'])})
    return {'evidence':loc(n),'track':track,'text':text_of(n),'identity':list(key)}

def values(obj,check):
    result=[]
    for f in obj['track']:
        if check['window_seconds'][0]-1e-8<=f['time']<=check['window_seconds'][1]+1e-8:
            if f['node'] is None:
                if f['unknown']:raise Unsupported('object unavailable in unresolved JSX branch')
                if check['metric'] in {'binding','scale_binding'}:continue
                if check['property'] in {'opacity','scale_binding','draw_progress'}:v=0.0
                else:continue
            else:v=prop(*f['node'],check['property'])
            result.append([f['time'],v])
    if not result:raise Unsupported('no usable samples in the check window')
    return result

def error(ref,rep,check):
    a=[v for t,v in ref];b=[v for t,v in rep];kind=check['metric']
    if kind=='text_equal':return float(a[-1]!=b[-1])
    if kind=='binding':
        # A varying property must act on the selected element or an effective ancestor.
        def dynamic(vals):return max(vals)-min(vals)>check.get('variation_threshold',.01)
        return float(dynamic(a)!=dynamic(b))
    if kind=='scale_binding':return float((max(a)-min(a)>.01)!=(max(b)-min(b)>.01))
    if kind=='mae':
        if [t for t,v in ref]!=[t for t,v in rep]:raise Unsupported('inconsistent sample coverage')
        return sum(abs(x-y) for x,y in zip(a,b))/len(a)
    if kind=='scalar':return abs(a[-1]-b[-1])
    if kind=='onset':
        threshold=check.get('onset_threshold',.05)
        def onset(vs):return next((t for t,v in vs if v>threshold),None)
        x,y=onset(ref),onset(rep)
        if x is None:raise Unsupported('reference onset not covered by sampling')
        return check['bad'] if y is None else abs(x-y)
    raise Unsupported('unimplemented metric '+kind)

def binding_evidence(obj,check):
    for f in obj['track']:
        if f['node'] is not None and check['window_seconds'][0]<=f['time']<=check['window_seconds'][1]:
            n,anc=f['node'];out=[]
            for x in (*anc,n):
                if not element(x):continue
                bindings=x.get('bindings',{})
                selected={k:v for k,v in bindings.items() if k in {'style','opacity','strokeDasharray','strokeDashoffset','points','d'}}
                if selected:out.append({'source':loc(x),'bindings':selected})
            return out
    return []

def measure(reference_code,replica_code,private,rubric,reference_cfg,replica_cfg):
    root=private.parent;objects=json.loads((private/'objects.json').read_text())
    if isinstance(objects,dict):objects=objects['objects']
    times=sorted(set(rubric['sample_times']+[o['anchor_time'] for o in objects]))
    datasets={name:analyze(root,path,cfg,times) for name,path,cfg in [('reference',reference_code,reference_cfg),('replica',replica_code,replica_cfg)]}
    tracked={};matches=[];diagnostics=[]
    for side,data in datasets.items():
        diagnostics.extend([dict(d,side=side) for d in data.get('diagnostics',[])])
        for obj in objects:
            try:tracked[(side,obj['id'])]=sampled_object(data,obj)
            except (Unsupported,Ambiguous) as exc:tracked[(side,obj['id'])]=exc
    rows=[]
    for c in rubric['checks']:
        row={'id':c['id']};ref=tracked[('reference',c['object_id'])];rep=tracked[('replica',c['object_id'])]
        try:
            if isinstance(ref,Exception):raise ref
            if ref is None:raise Unsupported('reference object not found; revise case definition')
            if isinstance(rep,Exception):raise rep
            ev=[dict(ref['evidence'],type='reference_code')]
            if rep is None:
                row.update(status='missing',reason='No matching reachable JSX element at object anchor',evidence=ev+[{'type':'replica_code','entry':replica_cfg['entry'],'anchor':next(o['anchor_time'] for o in objects if o['id']==c['object_id'])}])
            else:
                ev.append(dict(rep['evidence'],type='replica_code'))
                if c['metric']=='presence':rv=pv=[];err=0.0
                else:
                    rv=values(ref,c);pv=values(rep,c)
                    if c['metric']=='relative_onset':
                        peer_ref=tracked[('reference',c['peer_object'])];peer_rep=tracked[('replica',c['peer_object'])]
                        if isinstance(peer_ref,Exception):raise peer_ref
                        if isinstance(peer_rep,Exception):raise peer_rep
                        if peer_ref is None or peer_rep is None:err=c['bad']
                        else:
                            pr=values(peer_ref,c);pp=values(peer_rep,c)
                            def onset(series):return next((t for t,v in series if v>c.get('onset_threshold',.05)),None)
                            times4=[onset(v) for v in [rv,pv,pr,pp]]
                            if any(x is None for x in times4):err=c['bad']
                            else:err=abs((times4[2]-times4[0])-(times4[3]-times4[1]))
                            row['relation']={'reference_peer_values':pr,'replica_peer_values':pp,'onset_times':times4}
                    else:err=error(rv,pv,c)
                row.update(status='ok',error=err,evidence=ev,reference_values=rv,replica_values=pv)
                if c['metric']!='presence':row['binding_evidence']={side:binding_evidence(obj,c) for side,obj in [('reference',ref),('replica',rep)]}
        except Ambiguous as exc:row.update(status='unresolved',reason=str(exc))
        except Unsupported as exc:row.update(status='unsupported',reason=str(exc))
        rows.append(row)
    for obj in objects:
        m={'object_id':obj['id'],'selector':obj['selector']}
        for side in datasets:
            v=tracked[(side,obj['id'])];m[side]={'status':'unsupported','reason':str(v)} if isinstance(v,Exception) else {'status':'missing'} if v is None else {'status':'matched','source':v['evidence'],'text':v['text']}
        matches.append(m)
    return {'checks':rows,'matches':matches,'diagnostics':diagnostics}
