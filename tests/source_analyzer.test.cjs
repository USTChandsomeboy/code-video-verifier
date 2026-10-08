'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {analyze}=require('../assets/verifier-template/source_analyzer.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ast-verifier-test-'));
const put=(p,s)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),s)};
const walk=nodes=>nodes.flatMap(n=>typeof n==='object'&&n!==null?[n,...walk(n.children||[])]:[]);
const text=nodes=>nodes.map(n=>typeof n==='string'?n:text(n.children||[])).join('');
const run=(entry,times=[0],extra={})=>analyze({source:root,entry,exportName:'Main',fps:30,times,...extra});
const tests=[];function test(name,f){try{f();tests.push({name,passed:true});process.stdout.write('PASS '+name+'\n');}catch(e){tests.push({name,passed:false,error:e.stack});process.stderr.write('FAIL '+name+'\n'+e.stack+'\n');process.exitCode=1;}}
put('child.tsx',`import {useCurrentFrame as clock, useVideoConfig} from 'remotion';
export const Child=({label='default',value=7,...rest}:{label?:string,value?:number})=>{const frame=clock(); const {fps}=useVideoConfig();let amount;if(frame>=15){amount=frame/fps;}else{amount=0;}return <span data-frame={frame} data-fps={fps} data-amount={amount} {...rest}>{label}:{value}</span>};`);
put('main.tsx',`import {Sequence as Seq,AbsoluteFill as Fill,interpolate as lerp} from 'remotion';import {Child as Local} from './child';
const values=['a','b'];export const Main=()=> <Fill><Seq from={30} durationInFrames={60}>{values.map((s,i)=><Local key={i} label={s} value={i} data-i={i}/>)}</Seq><Local style={{opacity:lerp(1,[0,2],[0,1],{extrapolateRight:'clamp'})}}/></Fill>`);
test('local import aliases, default props, spread props, array.map and Sequence-local frame',()=>{
 const r=run('main.tsx',[0,1.5,3]);assert.equal(r.unsupported_count,0);const zero=walk(r.frames[0].tree);assert.equal(zero.find(n=>n.kind==='sequence').active,false);assert.equal(text(r.frames[0].tree),'default:7');
 const spans=walk(r.frames[1].tree).filter(n=>n.tag==='span');assert.equal(spans.length,3);assert.equal(spans[0].attrs['data-frame'],15);assert.equal(spans[0].attrs['data-amount'],.5);assert.equal(spans[2].attrs['data-frame'],45);assert.equal(spans[2].attrs.style.opacity,.5);assert.equal(text(r.frames[1].tree),'a:0b:1default:7');assert.equal(walk(r.frames[2].tree).find(n=>n.kind==='sequence').active,false);
 assert.ok(spans[0].file.endsWith('child.tsx'));assert.ok(spans[0].line);assert.ok(spans[0].bindings['data-frame'].dependencies.some(x=>x.identifier==='frame'));
});
put('nested.tsx',`import {Sequence,useCurrentFrame} from 'remotion';const Child=()=> <b data-frame={useCurrentFrame()}/>;export const Main=()=> <Sequence from={30}><Sequence from={15}><Child/></Sequence></Sequence>`);
test('nested Sequence offsets accumulate while frame is local',()=>{const r=run('nested.tsx',[2]);const b=walk(r.frames[0].tree).find(x=>x.tag==='b');assert.equal(b.attrs['data-frame'],15);assert.equal(b.time.sequence_offset,45);});
put('expr.tsx',`import {useCurrentFrame,interpolate,spring} from 'remotion';const twice=(x:number)=>x*2;export const Main=()=>{const f=useCurrentFrame();const x=interpolate(f,[0,30,60],[0,10,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});const p=spring({frame:f,fps:30,from:10,to:0,durationInFrames:20});return <div style={{opacity:twice(x)/20,transform:\`translateY(\u0024{p}px)\`}} data-hypot={Math.hypot(3,4)} data-pi={Math.PI}>{['abc','def'].map((s,i)=>s.slice(0,i+1))}{f<30?'early':'late'}</div>}`);
test('Math helpers, conditional branches, template strings and symbolic spring',()=>{const r=run('expr.tsx',[0,.5,1]);assert.equal(r.unsupported_count,0);assert.equal(r.approximate_count,0);const d=r.frames[1].tree[0];assert.equal(d.attrs.style.opacity,.5);assert.equal(d.attrs['data-hypot'],5);assert.equal(d.attrs['data-pi'],Math.PI);assert.equal(d.attrs.style.transform.$symbolic.kind,'template');assert.equal(d.attrs.style.transform.$symbolic.parts[1].$symbolic.kind,'spring');assert.equal(d.attrs.style.transform.$symbolic.parts[1].$symbolic.frame,15);assert.equal(text(r.frames[2].tree),'adelate');});
put('unknown.tsx',`import {spring,useCurrentFrame} from 'remotion';export const Main=()=>{const v=missing();return <><div title={v}>known</div>{v?<b>maybe</b>:<i>other</i>}{spring({frame:useCurrentFrame(),fps:30})?<u>ambiguous</u>:null}</>}`);
test('unknown attributes and branches remain explicit and do not erase known siblings',()=>{const r=run('unknown.tsx');assert.ok(r.unsupported_count>=2);const nodes=walk(r.frames[0].tree);assert.ok(nodes.find(x=>x.tag==='div').attrs.title.$unknown);assert.equal(text(r.frames[0].tree),'known');assert.ok(nodes.some(x=>x.$unknown));assert.equal(nodes.filter(x=>x.tag==='b'||x.tag==='i'||x.tag==='u').length,0);});
const marker=path.join(root,'MUST_NOT_EXIST');
put('unsafe.tsx',`import fs from 'node:fs';globalThis.compromised=true;fs.writeFileSync(${JSON.stringify(marker)},'bad');export const Main=()=>{const x=Function('return process')();const y=fs.readFileSync('/etc/passwd');return <div x={x} y={y}/>}`);
test('top-level effects, external imports, Function and I/O are never executed',()=>{const r=run('unsafe.tsx');assert.equal(fs.existsSync(marker),false);assert.equal(globalThis.compromised,undefined);assert.ok(r.unsupported_count>0);assert.ok(r.frames[0].tree[0].attrs.x.$unknown);assert.ok(r.frames[0].tree[0].attrs.y.$unknown);assert.ok(r.diagnostics.some(x=>x.code==='ignored_top_level_effect'));});
put('escape.tsx',`import x from '../outside';export const Main=()=> <div value={x}/>`);
test('missing/outside imports cannot resolve arbitrary files',()=>{const r=run('escape.tsx');assert.ok(r.frames[0].tree[0].attrs.value.$unknown);});
put('loops.tsx',`export const Main=()=>{const out=[];for(let i=0;i<3;i++){out.push(<b key={i}>{i}</b>);}return <>{out}{Array.from({length:2},(_,i)=><i>{i}</i>)}</>}`);
test('bounded interpreted for loops and Array.from callbacks',()=>{const r=run('loops.tsx');assert.equal(r.unsupported_count,0);assert.equal(text(r.frames[0].tree),'01201');});
put('recursion.tsx',`const bad=()=>bad();export const Main=()=> <div>{bad()}</div>`);
test('recursive submitted AST is bounded and reported as unknown',()=>{const r=run('recursion.tsx',[0],{maxDepth:12});assert.ok(r.unsupported_count>0);assert.ok(walk(r.frames[0].tree).some(n=>n.$unknown));});
put('unknown-spread.tsx',`export const Main=()=>{const u=missing();const before={opacity:.5,...u};const after={...u,opacity:.5};const absent={...u};return <div a={before.opacity} b={after.opacity} c={absent.opacity??1} d={Object.keys(absent)}><i opacity={.8} {...u}/><b {...u} opacity={.7}/></div>}`);
test('unknown spread invalidates overwritten/missing properties without invalidating later explicit properties',()=>{const r=run('unknown-spread.tsx');const d=r.frames[0].tree[0];assert.ok(d.attrs.a.$unknown);assert.equal(d.attrs.b,.5);assert.ok(d.attrs.c.$unknown);assert.ok(d.attrs.d.$unknown);assert.ok(d.children[0].attrs.opacity.$unknown);assert.equal(d.children[1].attrs.opacity,.7);});
put('unknown-array.tsx',`import {spring} from 'remotion';export const Main=()=>{const x=missing();const a=[1,2,3].slice(x);const b=[1].includes(x);const c=[1,2].filter(()=>spring({frame:1,fps:30}));return <div a={a} b={b} c={c}/>}`);
test('unknown array arguments and symbolic predicates never coerce to concrete passing values',()=>{const r=run('unknown-array.tsx');const attrs=r.frames[0].tree[0].attrs;assert.ok(attrs.a.$unknown);assert.ok(attrs.b.$unknown);assert.ok(attrs.c.$unknown);});
put('wrapped-sequence.tsx',`import {Sequence as Seq,useCurrentFrame as frame} from 'remotion';
const Clip=({children})=><Seq from={30}>{children}</Seq>;
const Child=({parentFrame})=><span local={frame()} parent={parentFrame}/>;
export const Main=()=>{const f=frame();return <Clip><Child parentFrame={f}/></Clip>};`);
test('wrapper children render with Sequence-local hooks while parent expressions retain parent frame',()=>{
 const r=run('wrapped-sequence.tsx',[0,1.5]);assert.equal(r.unsupported_count,0);
 assert.equal(walk(r.frames[0].tree).some(n=>n.tag==='span'),false);
 const span=walk(r.frames[1].tree).find(n=>n.tag==='span');assert.equal(span.attrs.local,15);assert.equal(span.attrs.parent,45);assert.equal(span.time.sequence_offset,30);
});
put('element-props.tsx',`import {Sequence,useCurrentFrame} from 'remotion';
const Child=()=> <i frame={useCurrentFrame()}/>;const Holder=({content})=> <Sequence from={15}>{content}</Sequence>;
export const Main=()=> <Holder content={<Child/>}/>;`);
test('JSX passed through an arbitrary prop receives the eventual render context',()=>{
 const r=run('element-props.tsx',[1]);assert.equal(r.unsupported_count,0);assert.equal(walk(r.frames[0].tree).find(n=>n.tag==='i').attrs.frame,15);
});
put('unknown-interpolation.tsx',`import {interpolate,spring} from 'remotion';export const Main=()=>{const u=missing();const p=spring({frame:15,fps:30});return <div a={interpolate(15,[0,30],[0,1],u)} b={interpolate(15,[0,30],[0,1],{easing:u})} c={Number(p)} d={Boolean(p)} e={Array.isArray(u)} f={interpolate(p,[0,1],[0,1])}/>}`);
test('unknown interpolate options and symbolic conversions cannot manufacture concrete motion',()=>{
 const attrs=run('unknown-interpolation.tsx').frames[0].tree[0].attrs;for(const key of ['a','b','c','d','e','f'])assert.ok(attrs[key].$unknown,key);
});
put('unknown-computed.tsx',`export const Main=()=>{const k=missing();const a={opacity:.5,[k]:0};const b={[k]:0,opacity:.5};return <div a={a.opacity} b={b.opacity} c={b.color??'red'} d={Object.keys(b)}/>}`);
test('unknown computed keys invalidate earlier properties and missing-key defaults',()=>{
 const attrs=run('unknown-computed.tsx').frames[0].tree[0].attrs;assert.ok(attrs.a.$unknown);assert.equal(attrs.b,.5);assert.ok(attrs.c.$unknown);assert.ok(attrs.d.$unknown);
});
const report={tests,passed:tests.filter(t=>t.passed).length,total:tests.length,node:process.version,typescript:require(process.env.VERIFIER_TYPESCRIPT||'typescript').version};fs.writeFileSync(path.join(__dirname,'source-analyzer-test-results.json'),JSON.stringify(report,null,2)+'\n');
fs.rmSync(root,{recursive:true,force:true});
