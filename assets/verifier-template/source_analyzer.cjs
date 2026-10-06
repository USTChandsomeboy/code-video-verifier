#!/usr/bin/env node
'use strict';
/** Read-only TS/JSX whitelist abstract interpreter. Never imports, evals, renders,
 * or executes submitted modules. Local functions are AST bodies interpreted here.
 * Public API: analyze({source,entry,exportName,fps,times,width,height,...}).
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ts=require(process.env.VERIFIER_TYPESCRIPT || 'typescript');
const EXPECTED_TYPESCRIPT_VERSION='5.7.2';
if(ts.version!==EXPECTED_TYPESCRIPT_VERSION)throw new Error('TypeScript version mismatch: expected '+EXPECTED_TYPESCRIPT_VERSION+', got '+ts.version);
const BAD_KEYS=new Set(['__proto__','prototype','constructor','caller','callee','arguments']);
const dict=()=>Object.create(null);
const own=(o,k)=>o!=null&&Object.prototype.hasOwnProperty.call(o,k);
class Fn {constructor(node,env,name){this.node=node;this.env=env;this.name=name||'';}}
class Builtin {constructor(name){this.name=name;}}
class Symbolic {constructor(kind,fields,source){this.kind=kind;this.fields=fields;this.source=source;}}
class Unknown {constructor(reason,source,details){this.reason=reason;this.source=source;this.details=details;}}
class Env {
 constructor(parent=null){this.parent=parent;this.bindings=new Map();}
 define(name,value,origin){this.bindings.set(name,{value,origin});}
 lookup(name){return this.bindings.has(name)?this.bindings.get(name):this.parent?.lookup(name);}
 assign(name,value,origin){if(this.bindings.has(name)){this.bindings.set(name,{value,origin});return true;}return this.parent?this.parent.assign(name,value,origin):false;}
}
const isUnknown=v=>v instanceof Unknown;
function publicValue(value,seen=new Set(),depth=0){
 if(value===undefined)return {kind:'undefined'};
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number')return Number.isFinite(value)?value:{kind:'number',value:String(value)};
 if(value instanceof Symbolic)return {$symbolic:{kind:value.kind,...publicValue(value.fields,seen,depth+1),source:value.source}};
 if(isUnknown(value))return {$unknown:value.reason,source:value.source,...(value.details?{details:publicValue(value.details,seen,depth+1)}:{})};
 if(value instanceof Fn)return {kind:'function',name:value.name,source:location(value.node)};
 if(value instanceof Builtin)return {kind:'builtin',name:value.name};
 if(depth>70)return {kind:'unknown',reason:'serialization depth bound'};
 if(seen.has(value))return {kind:'unknown',reason:'cyclic abstract value'};
 seen.add(value);let out;
 if(Array.isArray(value))out=value.map(v=>publicValue(v,seen,depth+1));
 else{out={};for(const k of Object.keys(value||{})){if(k==='children'&&!value.kind)continue;if(!BAD_KEYS.has(k))out[k]=publicValue(value[k],seen,depth+1);}}
 seen.delete(value);return out;
}
function location(node){
 if(!node)return null;const sf=node.getSourceFile();const start=node.getStart(sf);const p=sf.getLineAndCharacterOfPosition(start);const text=node.getText(sf);
 return {file:sf.__relativePath||sf.fileName,line:p.line+1,column:p.character+1,start,end:node.end,expression:text.slice(0,1800),truncated:text.length>1800};
}
class Analyzer {
 constructor(options){
  this.root=fs.realpathSync(options.source);this.options=options;
  this.config={fps:Number(options.fps||30),width:Number(options.width||1280),height:Number(options.height||720),durationInFrames:Number(options.durationInFrames||780)};
  this.modules=new Map();this.diagnostics=[];this.diagnosticKeys=new Map();this.totalBytes=0;
  this.steps=0;this.depth=0;this.global=new Env();this.ctx=null;
  this.maxSteps=options.maxSteps||300000;this.maxLoop=options.maxLoop||10000;this.maxDepth=options.maxDepth||100;
  for(const name of ['Math','Object','Array','Number','String','Boolean','parseFloat','parseInt'])this.global.define(name,new Builtin(name),{kind:'trusted_whitelist',name});
  this.global.define('undefined',undefined,{kind:'constant'});this.global.define('Infinity',Infinity,{kind:'constant'});this.global.define('NaN',NaN,{kind:'constant'});
 }
 diagnostic(code,message,node,extra={}){
  const src=location(node);const key=JSON.stringify([code,message,src?.file,src?.start]);
  if(this.diagnosticKeys.has(key)){const d=this.diagnosticKeys.get(key);d.occurrences++;d.last_time=this.ctx?.time??null;return;}
  const d={code,message,source:src,occurrences:1,first_time:this.ctx?.time??null,last_time:this.ctx?.time??null,...extra};this.diagnosticKeys.set(key,d);this.diagnostics.push(d);
 }
 unknown(reason,node,details){this.diagnostic('unsupported',reason,node);return new Unknown(reason,location(node),details);}
 tick(node){if(++this.steps>this.maxSteps)throw new Error('AST step budget exceeded');}
 resolve(spec,from){
  if(!spec.startsWith('.')&&!path.isAbsolute(spec))return null;
  const base=path.resolve(path.dirname(from),spec);const tries=[base,...['.tsx','.ts','.jsx','.js','.mjs','.cjs','.json'].map(x=>base+x),...['index.tsx','index.ts','index.jsx','index.js'].map(x=>path.join(base,x))];
  for(const p of tries){
   if(!fs.existsSync(p)||!fs.statSync(p).isFile())continue;
   const real=fs.realpathSync(p);if(real!==this.root&&!real.startsWith(this.root+path.sep))throw new Error('Local import escapes supplied source root: '+spec);
   if(fs.statSync(real).size>5_000_000)throw new Error('Individual source file exceeds 5MB');return real;
  }
  return null;
 }
 module(file){
  file=fs.realpathSync(file);if(file!==this.root&&!file.startsWith(this.root+path.sep))throw new Error('Entry is outside source root');
  if(this.modules.has(file))return this.modules.get(file);
  if(this.modules.size>=2000)throw new Error('Source module limit exceeded');
  const source=fs.readFileSync(file,'utf8');this.totalBytes+=Buffer.byteLength(source);if(this.totalBytes>25_000_000)throw new Error('Source byte limit exceeded');
  const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:file.endsWith('.jsx')?ts.ScriptKind.JSX:ts.ScriptKind.TS);sf.__relativePath=path.relative(this.root,file).split(path.sep).join('/');
  const m={file,sf,source,env:new Env(this.global),exports:new Map(),status:'loading'};this.modules.set(file,m);
  if(file.endsWith('.json')){try{m.exports.set('default',JSON.parse(source));m.status='loaded';return m;}catch{m.exports.set('default',this.unknown('Malformed JSON module',sf));return m;}}
  for(const d of sf.parseDiagnostics||[])this.diagnostic('parse_error',ts.flattenDiagnosticMessageText(d.messageText,' '),sf,{offset:d.start});
  // Function declarations are hoisted to permit local helpers and mutual references.
  for(const s of sf.statements)if(ts.isFunctionDeclaration(s)&&s.name)m.env.define(s.name.text,new Fn(s,m.env,s.name.text),{kind:'declaration',source:location(s)});
  for(const s of sf.statements){
   if(ts.isImportDeclaration(s)){this.importDecl(s,m);continue;}
   if(ts.isExportDeclaration(s))continue;
   if(ts.isExportAssignment(s)){m.exports.set('default',this.expr(s.expression,m.env,this.ctx));continue;}
   if(ts.isInterfaceDeclaration(s)||ts.isTypeAliasDeclaration(s)||ts.isEmptyStatement(s))continue;
   if(ts.isVariableStatement(s)||ts.isFunctionDeclaration(s)){this.statement(s,m.env,this.ctx);if(s.modifiers?.some(x=>x.kind===ts.SyntaxKind.ExportKeyword)){
    if(ts.isVariableStatement(s))for(const d of s.declarationList.declarations)for(const name of this.names(d.name))m.exports.set(name,m.env.lookup(name)?.value);
    else if(s.name)m.exports.set(s.modifiers.some(x=>x.kind===ts.SyntaxKind.DefaultKeyword)?'default':s.name.text,m.env.lookup(s.name.text)?.value);
    else if(ts.isFunctionDeclaration(s)&&s.modifiers.some(x=>x.kind===ts.SyntaxKind.DefaultKeyword))m.exports.set('default',new Fn(s,m.env,'default'));
   }continue;}
   // Top-level effects are neither run nor silently trusted.
   if(ts.isExpressionStatement(s))this.diagnostic('ignored_top_level_effect','Top-level expression is not executed',s);
   else this.diagnostic('unsupported','Unsupported top-level statement '+ts.SyntaxKind[s.kind],s);
  }
  for(const s of sf.statements)if(ts.isExportDeclaration(s)){
   const remote=s.moduleSpecifier?this.loadImport(s.moduleSpecifier.text,m.file,s):null;
   if(s.exportClause&&ts.isNamedExports(s.exportClause))for(const e of s.exportClause.elements){const name=e.propertyName?.text||e.name.text;m.exports.set(e.name.text,remote?this.exportValue(remote,name,e):m.env.lookup(name)?.value);}
   else if(remote&&remote.exports)for(const [k,v] of remote.exports)if(k!=='default')m.exports.set(k,v);
  }
  m.status='loaded';return m;
 }
 loadImport(spec,from,node){
  if(spec==='remotion'||spec==='react'||spec==='react/jsx-runtime')return {external:spec,exports:null};
  let found;try{found=this.resolve(spec,from);}catch(e){return {unknown:this.unknown(e.message,node)}}
  if(found)return this.module(found);
  return {unknown:new Unknown('Unresolved or untrusted external import: '+spec,location(node)),external:spec};
 }
 exportValue(m,name,node){
  if(m.unknown)return m.unknown;
  if(m.external){
   const names=m.external==='remotion'?['useCurrentFrame','useVideoConfig','interpolate','spring','Easing','AbsoluteFill','Sequence','Series','Composition','Img','Video','OffthreadVideo','Audio','staticFile','interpolateColors']:['default','Fragment','createElement','memo','forwardRef'];
   if(names.includes(name))return new Builtin(m.external+':'+name);
   return this.unknown('Unsupported external export '+m.external+':'+name,node);
  }
  if(m.exports.has(name))return m.exports.get(name);
  const value=m.env.lookup(name);if(m.status==='loading'&&value)return value.value;
  return this.unknown('Missing local export '+name,node);
 }
 importDecl(s,m){
  const spec=s.moduleSpecifier.text;if(!s.importClause){this.diagnostic('ignored_side_effect_import','Side-effect import is not executed: '+spec,s);return;}
  if(s.importClause.isTypeOnly)return;
  const target=this.loadImport(spec,m.file,s);const c=s.importClause;
  if(c.name)m.env.define(c.name.text,this.exportValue(target,'default',s),{kind:'import',module:spec,export:'default',source:location(s)});
  if(c.namedBindings){if(ts.isNamedImports(c.namedBindings))for(const e of c.namedBindings.elements){if(e.isTypeOnly)continue;const name=e.propertyName?.text||e.name.text;m.env.define(e.name.text,this.exportValue(target,name,e),{kind:'import',module:spec,export:name,source:location(e)});}
   else if(ts.isNamespaceImport(c.namedBindings)){const o=dict();if(target.external)o.__namespace=target.external;else if(target.exports)for(const[k,v]of target.exports)o[k]=v;m.env.define(c.namedBindings.name.text,o,{kind:'namespace_import',module:spec,source:location(s)});}}
 }
 names(p){if(ts.isIdentifier(p))return[p.text];if(ts.isObjectBindingPattern(p)||ts.isArrayBindingPattern(p))return p.elements.flatMap(e=>ts.isOmittedExpression(e)?[]:this.names(e.name));return[];}
 binding(name,value,env,origin,ctx){
  if(ts.isIdentifier(name)){env.define(name.text,value,origin);return;}
  if(ts.isObjectBindingPattern(name)){
   const used=new Set();for(const e of name.elements){
    if(e.dotDotDotToken){const rem=dict();if(value&&typeof value==='object'&&!isUnknown(value))for(const k of Object.keys(value))if(!used.has(k)&&!BAD_KEYS.has(k))rem[k]=value[k];this.binding(e.name,isUnknown(value)?value:rem,env,{kind:'destructure_rest',parent:origin},ctx);continue;}
    const key=e.propertyName?this.propertyName(e.propertyName,env,ctx):ts.isIdentifier(e.name)?e.name.text:null;used.add(key);
    let v=this.property(value,key,e);const defaultUsed=v===undefined&&!!e.initializer;if(defaultUsed)v=this.expr(e.initializer,env,ctx);
    this.binding(e.name,v,env,{kind:'property_binding',property:key,parent:origin,default_used:defaultUsed,...(defaultUsed?{default_source:location(e.initializer)}:{})},ctx);
   }return;
  }
  if(ts.isArrayBindingPattern(name)){let i=0;for(const e of name.elements){if(ts.isOmittedExpression(e)){i++;continue;}let v=e.dotDotDotToken?Array.isArray(value)?value.slice(i):this.unknown('Array rest of unknown value',e):this.property(value,i,e);if(v===undefined&&e.initializer)v=this.expr(e.initializer,env,ctx);this.binding(e.name,v,env,{kind:'index_binding',index:i,parent:origin},ctx);i++;}return;}
  this.unknown('Unsupported binding pattern',name);
 }
 compactOrigin(origin,depth=0){
  if(!origin||depth>2)return origin?{kind:origin.kind,source:origin.source?.source||origin.source||null}:null;
  const out={};for(const k of ['kind','property','index','module','export','default_used','default_source','call_source'])if(origin[k]!==undefined)out[k]=origin[k];
  if(origin.source){out.source=origin.source.kind?this.compactOrigin(origin.source,depth+1):origin.source;}
  if(origin.parent)out.parent=this.compactOrigin(origin.parent,depth+1);
  if(origin.bindings)out.bindings=Object.fromEntries(Object.entries(origin.bindings).map(([k,v])=>[k,{kind:v.kind,property:v.property,source:v.source}]));
  if(origin.dependencies&&depth<1)out.dependencies=origin.dependencies.map(x=>({identifier:x.identifier,origin:this.compactOrigin(x.origin,depth+1)}));
  return out;
 }
 dependencies(node,env){
  const out=[];const seen=new Set();const visit=n=>{if(ts.isIdentifier(n)&&!seen.has(n.text)){
   const p=n.parent;if((ts.isPropertyAccessExpression(p)&&p.name===n)||(ts.isPropertyAssignment(p)&&p.name===n))return;
   const b=env.lookup(n.text);if(b){seen.add(n.text);out.push({identifier:n.text,origin:this.compactOrigin(b.origin)});}}
   ts.forEachChild(n,visit);};visit(node);return out;
 }
 propertyName(n,env,ctx){if(ts.isIdentifier(n)||ts.isStringLiteral(n)||ts.isNumericLiteral(n))return n.text;if(ts.isComputedPropertyName(n))return this.expr(n.expression,env,ctx);return this.unknown('Unsupported property name',n);}
 property(obj,key,node){
  if(isUnknown(obj)||isUnknown(key))return this.unknown('Property access on unknown value',node,{object:obj,key});
  if(BAD_KEYS.has(String(key)))return this.unknown('Prototype/introspection property is forbidden',node);
  if(obj instanceof Builtin){if(obj.name==='Math'&&['PI','E','LN2','LN10','LOG2E','LOG10E','SQRT1_2','SQRT2'].includes(String(key)))return Math[key];return new Builtin(obj.name+'.'+String(key));}
  if(obj?.__namespace)return new Builtin(obj.__namespace+':'+String(key));
  if(typeof obj==='string'||Array.isArray(obj)){if(key==='length')return obj.length;if(/^\d+$/.test(String(key)))return obj[Number(key)];return undefined;}
  if(obj===null||obj===undefined)return this.unknown('Property access on null or undefined',node);
  if(obj instanceof Fn)return this.unknown('Function object introspection is forbidden',node);
  if(own(obj,key))return obj[key];if(own(obj,'__unknown_spread'))return this.unknown('Property may come from unknown object spread',node,{key,spread:obj.__unknown_spread});return undefined;
 }
 expr(n,env,ctx){
  if(!n)return undefined;this.tick(n);
  if(ts.isParenthesizedExpression(n)||ts.isAsExpression(n)||ts.isTypeAssertionExpression(n)||ts.isNonNullExpression(n)||ts.isSatisfiesExpression(n))return this.expr(n.expression,env,ctx);
  if(ts.isNumericLiteral(n))return Number(n.text);
  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;
  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;
  if(ts.isIdentifier(n)){const b=env.lookup(n.text);return b?b.value:this.unknown('Unbound identifier '+n.text,n);}
  if(ts.isArrowFunction(n)||ts.isFunctionExpression(n))return new Fn(n,env,n.name?.text);
  if(ts.isObjectLiteralExpression(n)){const o=dict();for(const p of n.properties){
   if(ts.isSpreadAssignment(p)){const v=this.expr(p.expression,env,ctx);if(isUnknown(v)){for(const key of Object.keys(o))o[key]=this.unknown('Later unknown spread may override property '+key,p,{spread:v});o.__unknown_spread=v;continue;}if(v&&typeof v==='object'&&!(v instanceof Fn)&&!(v instanceof Builtin))for(const k of Object.keys(v))if(!BAD_KEYS.has(k))o[k]=v[k];else{}continue;}
   if(ts.isPropertyAssignment(p)){const k=this.propertyName(p.name,env,ctx);if(isUnknown(k)){o.__unknown_property=k;continue;}if(BAD_KEYS.has(String(k))){this.unknown('Forbidden object key',p);continue;}o[k]=this.expr(p.initializer,env,ctx);continue;}
   if(ts.isShorthandPropertyAssignment(p)){o[p.name.text]=this.expr(p.name,env,ctx);continue;}
   if(ts.isMethodDeclaration(p)){const k=this.propertyName(p.name,env,ctx);if(!BAD_KEYS.has(String(k)))o[k]=new Fn(p,env,String(k));continue;}
   o.__unknown_member=this.unknown('Unsupported object member',p);
  }return o;}
  if(ts.isArrayLiteralExpression(n)){const out=[];for(const e of n.elements){if(ts.isSpreadElement(e)){const a=this.expr(e.expression,env,ctx);if(Array.isArray(a))out.push(...a);else out.push(this.unknown('Array spread is not statically an array',e));}else out.push(ts.isOmittedExpression(e)?undefined:this.expr(e,env,ctx));if(out.length>this.maxLoop)return this.unknown('Array size bound exceeded',n);}return out;}
  if(ts.isTemplateExpression(n)){let s=n.head.text;const parts=[n.head.text];let symbolic=false;for(const x of n.templateSpans){const v=this.expr(x.expression,env,ctx);if(isUnknown(v)||v instanceof Fn||v instanceof Builtin)return this.unknown('Template expression has nonconcrete substitution',n,{value:v});if(v instanceof Symbolic)symbolic=true;parts.push(v,x.literal.text);s+=String(v)+x.literal.text;}return symbolic?new Symbolic('template',{parts},location(n)):s;}
  if(ts.isPropertyAccessExpression(n))return this.property(this.expr(n.expression,env,ctx),n.name.text,n);
  if(ts.isElementAccessExpression(n))return this.property(this.expr(n.expression,env,ctx),this.expr(n.argumentExpression,env,ctx),n);
  if(ts.isConditionalExpression(n)){const c=this.expr(n.condition,env,ctx);if(isUnknown(c)||c instanceof Symbolic)return this.unknown('Unknown conditional predicate',n,{predicate:c});return this.expr(c?n.whenTrue:n.whenFalse,env,ctx);}
  if(ts.isBinaryExpression(n))return this.binary(n,env,ctx);
  if(ts.isPrefixUnaryExpression(n)||ts.isPostfixUnaryExpression(n)){
   const v=this.expr(n.operand,env,ctx);if(isUnknown(v))return v;if(v instanceof Symbolic)return new Symbolic('unary',{operator:ts.SyntaxKind[n.operator],value:v},location(n));
   switch(n.operator){case ts.SyntaxKind.ExclamationToken:return !v;case ts.SyntaxKind.MinusToken:return -v;case ts.SyntaxKind.PlusToken:return +v;case ts.SyntaxKind.TildeToken:return ~v;case ts.SyntaxKind.PlusPlusToken:case ts.SyntaxKind.MinusMinusToken:{const z=v+(n.operator===ts.SyntaxKind.PlusPlusToken?1:-1);this.assign(n.operand,z,env,ctx,n);return ts.isPostfixUnaryExpression(n)?v:z;}}
  }
  if(ts.isTypeOfExpression(n)){const v=this.expr(n.expression,env,ctx);if(isUnknown(v))return v;return v instanceof Fn||v instanceof Builtin?'function':typeof v;}
  if(ts.isVoidExpression(n)){this.diagnostic('ignored_void','void expression is not executed',n);return undefined;}
  if(ts.isCallExpression(n))return this.call(n,env,ctx);
  if(ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n)||ts.isJsxFragment(n))return this.jsx(n,env,ctx);
  if(ts.isJsxExpression(n))return this.expr(n.expression,env,ctx);
  return this.unknown('Unsupported expression '+ts.SyntaxKind[n.kind],n);
 }
 assign(target,v,env,ctx,node){
  if(ts.isIdentifier(target)){if(!env.assign(target.text,v,{kind:'assignment',source:location(node),dependencies:this.dependencies(node,env)}))return this.unknown('Assignment to unbound identifier',target);return v;}
  if(ts.isPropertyAccessExpression(target)||ts.isElementAccessExpression(target)){
   const o=this.expr(target.expression,env,ctx),k=ts.isPropertyAccessExpression(target)?target.name.text:this.expr(target.argumentExpression,env,ctx);
   if(o&&typeof o==='object'&&!isUnknown(o)&&!(o instanceof Fn)&&!(o instanceof Builtin)&&!BAD_KEYS.has(String(k))){o[k]=v;return v;}
  }return this.unknown('Unsupported assignment target',target);
 }
 binary(n,env,ctx){
  const k=n.operatorToken.kind;if(k===ts.SyntaxKind.EqualsToken)return this.assign(n.left,this.expr(n.right,env,ctx),env,ctx,n);
  const l=this.expr(n.left,env,ctx);
  if(k===ts.SyntaxKind.AmpersandAmpersandToken){if(isUnknown(l))return l;if(l instanceof Symbolic)return this.unknown('Symbolic logical predicate',n);return l?this.expr(n.right,env,ctx):l;}
  if(k===ts.SyntaxKind.BarBarToken){if(isUnknown(l))return l;if(l instanceof Symbolic)return this.unknown('Symbolic logical predicate',n);return l?l:this.expr(n.right,env,ctx);}
  if(k===ts.SyntaxKind.QuestionQuestionToken){if(isUnknown(l))return l;return l??this.expr(n.right,env,ctx);}
  const r=this.expr(n.right,env,ctx);if(isUnknown(l)||isUnknown(r))return this.unknown('Binary operand is unknown',n,{left:l,right:r});if(l instanceof Symbolic||r instanceof Symbolic)return new Symbolic('binary',{operator:n.operatorToken.getText(),left:l,right:r},location(n));let v;
  switch(k){
   case ts.SyntaxKind.PlusToken:case ts.SyntaxKind.PlusEqualsToken:v=l+r;break;
   case ts.SyntaxKind.MinusToken:case ts.SyntaxKind.MinusEqualsToken:v=l-r;break;
   case ts.SyntaxKind.AsteriskToken:case ts.SyntaxKind.AsteriskEqualsToken:v=l*r;break;
   case ts.SyntaxKind.SlashToken:case ts.SyntaxKind.SlashEqualsToken:v=l/r;break;
   case ts.SyntaxKind.PercentToken:case ts.SyntaxKind.PercentEqualsToken:v=l%r;break;
   case ts.SyntaxKind.AsteriskAsteriskToken:v=l**r;break;
   case ts.SyntaxKind.LessThanToken:v=l<r;break;case ts.SyntaxKind.LessThanEqualsToken:v=l<=r;break;
   case ts.SyntaxKind.GreaterThanToken:v=l>r;break;case ts.SyntaxKind.GreaterThanEqualsToken:v=l>=r;break;
   case ts.SyntaxKind.EqualsEqualsEqualsToken:v=l===r;break;case ts.SyntaxKind.ExclamationEqualsEqualsToken:v=l!==r;break;
   case ts.SyntaxKind.EqualsEqualsToken:v=l==r;break;case ts.SyntaxKind.ExclamationEqualsToken:v=l!=r;break;
   case ts.SyntaxKind.BarToken:v=l|r;break;case ts.SyntaxKind.AmpersandToken:v=l&r;break;case ts.SyntaxKind.CaretToken:v=l^r;break;
   case ts.SyntaxKind.LessThanLessThanToken:v=l<<r;break;case ts.SyntaxKind.GreaterThanGreaterThanToken:v=l>>r;break;case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:v=l>>>r;break;
   case ts.SyntaxKind.CommaToken:v=r;break;
   default:return this.unknown('Unsupported binary operator '+ts.SyntaxKind[k],n);
  }
  if([ts.SyntaxKind.PlusEqualsToken,ts.SyntaxKind.MinusEqualsToken,ts.SyntaxKind.AsteriskEqualsToken,ts.SyntaxKind.SlashEqualsToken,ts.SyntaxKind.PercentEqualsToken].includes(k))return this.assign(n.left,v,env,ctx,n);
  return v;
 }
 statement(s,env,ctx){
  this.tick(s);
  if(ts.isVariableStatement(s)){for(const d of s.declarationList.declarations){const v=d.initializer?this.expr(d.initializer,env,ctx):undefined;this.binding(d.name,v,env,{kind:'declaration',source:location(d),dependencies:d.initializer?this.dependencies(d.initializer,env):[]},ctx);}return null;}
  if(ts.isFunctionDeclaration(s)){if(s.name)env.define(s.name.text,new Fn(s,env,s.name.text),{kind:'function_declaration',source:location(s)});return null;}
  if(ts.isReturnStatement(s))return {control:'return',value:this.expr(s.expression,env,ctx)};
  if(ts.isBlock(s)){const scope=new Env(env);for(const item of s.statements){const v=this.statement(item,scope,ctx);if(v)return v;}return null;}
  if(ts.isIfStatement(s)){const c=this.expr(s.expression,env,ctx);if(isUnknown(c)||c instanceof Symbolic)return {control:'return',value:this.unknown('Unknown if predicate',s,{predicate:c})};return this.statement(c?s.thenStatement:s.elseStatement||ts.factory.createEmptyStatement(),env,ctx);}
  if(ts.isExpressionStatement(s)){this.expr(s.expression,env,ctx);return null;}
  if(ts.isEmptyStatement(s)||ts.isTypeAliasDeclaration(s)||ts.isInterfaceDeclaration(s))return null;
  if(ts.isBreakStatement(s))return{control:'break'};if(ts.isContinueStatement(s))return{control:'continue'};
  if(ts.isForStatement(s)){
   const scope=new Env(env);if(s.initializer){if(ts.isVariableDeclarationList(s.initializer))for(const d of s.initializer.declarations)this.binding(d.name,this.expr(d.initializer,scope,ctx),scope,{kind:'loop_binding',source:location(d)},ctx);else this.expr(s.initializer,scope,ctx);}
   for(let i=0;i<this.maxLoop;i++){const c=s.condition?this.expr(s.condition,scope,ctx):true;if(isUnknown(c))return{control:'return',value:c};if(!c)return null;const r=this.statement(s.statement,scope,ctx);if(r?.control==='return')return r;if(r?.control==='break')return null;if(s.incrementor)this.expr(s.incrementor,scope,ctx);}return{control:'return',value:this.unknown('Loop iteration bound exceeded',s)};
  }
  if(ts.isForOfStatement(s)){
   const arr=this.expr(s.expression,env,ctx);if(!Array.isArray(arr)||arr.length>this.maxLoop)return{control:'return',value:this.unknown('for-of requires bounded concrete array',s)};
   for(const value of arr){const scope=new Env(env);if(ts.isVariableDeclarationList(s.initializer))this.binding(s.initializer.declarations[0].name,value,scope,{kind:'for_of',source:location(s.initializer)},ctx);else this.assign(s.initializer,value,scope,ctx,s);
    const r=this.statement(s.statement,scope,ctx);if(r?.control==='return')return r;if(r?.control==='break')break;}return null;
  }
  return {control:'return',value:this.unknown('Unsupported statement '+ts.SyntaxKind[s.kind],s)};
 }
 invoke(fn,args,ctx,node,origins=[]){
  if(isUnknown(fn))return this.unknown('Call target is unknown',node,{target:fn});
  if(fn instanceof Builtin)return this.builtin(fn.name,args,ctx,node);
  if(!(fn instanceof Fn))return this.unknown('Call target is not a whitelisted function',node);
  if(++this.depth>this.maxDepth){this.depth--;return this.unknown('Call-depth bound exceeded',node);}
  try{
   const env=new Env(fn.env);let i=0;
   for(const p of fn.node.parameters||[]){let v=p.dotDotDotToken?args.slice(i):args[i];const defaultUsed=v===undefined&&!!p.initializer;if(defaultUsed)v=this.expr(p.initializer,env,ctx);this.binding(p.name,v,env,{kind:'argument',index:i,call_source:location(node),source:origins[i]||null,default_used:defaultUsed,...(defaultUsed?{default_source:location(p.initializer)}:{})},ctx);i++;}
   if(!fn.node.body)return this.unknown('Function has no body',fn.node);
   if(ts.isBlock(fn.node.body)){for(const s of fn.node.body.statements){const r=this.statement(s,env,ctx);if(r?.control==='return')return r.value;if(r)return this.unknown('Invalid function control flow',s);}return undefined;}
   return this.expr(fn.node.body,env,ctx);
  }finally{this.depth--;}
 }
 call(n,env,ctx){
  const args=[];for(const x of n.arguments){if(ts.isSpreadElement(x)){const v=this.expr(x.expression,env,ctx);if(!Array.isArray(v))return this.unknown('Call spread is unknown',x);args.push(...v);}else args.push(this.expr(x,env,ctx));}
  const origins=n.arguments.map(x=>({source:location(x),dependencies:this.dependencies(x,env)}));
  if(ts.isPropertyAccessExpression(n.expression)||ts.isElementAccessExpression(n.expression)){
   const target=n.expression;const o=this.expr(target.expression,env,ctx);const name=ts.isPropertyAccessExpression(target)?target.name.text:this.expr(target.argumentExpression,env,ctx);
   if(isUnknown(o))return this.unknown('Method receiver is unknown',n,{receiver:o});
   if(BAD_KEYS.has(String(name)))return this.unknown('Introspection call is forbidden',n);
   if(o instanceof Builtin)return this.invoke(new Builtin(o.name+'.'+name),args,ctx,n,origins);
   if(o?.__namespace)return this.invoke(new Builtin(o.__namespace+':'+name),args,ctx,n,origins);
   if(Array.isArray(o))return this.arrayMethod(o,name,args,ctx,n);
   if(typeof o==='string')return this.stringMethod(o,name,args,n);
   if(typeof o==='number'&&name==='toFixed'&&Number.isInteger(args[0]??0)&&(args[0]??0)>=0&&(args[0]??0)<=20)return o.toFixed(args[0]);
   return this.invoke(this.property(o,name,n),args,ctx,n,origins);
  }
  return this.invoke(this.expr(n.expression,env,ctx),args,ctx,n,origins);
 }
 arrayMethod(a,name,args,ctx,n){
  if(args.some(isUnknown))return this.unknown('Array method has unknown argument',n);
  if(a.length>this.maxLoop)return this.unknown('Array size bound exceeded',n);
  switch(name){
   case 'map':return a.map((v,i)=>this.invoke(args[0],[v,i,a],ctx,n,[{kind:'array_element',index:i,source:location(n.expression.expression)}]));
   case 'flatMap':return a.flatMap((v,i)=>{const x=this.invoke(args[0],[v,i,a],ctx,n);return Array.isArray(x)?x:[x]});
   case 'filter':{const out=[];for(let i=0;i<a.length;i++){const v=this.invoke(args[0],[a[i],i,a],ctx,n);if(isUnknown(v)||v instanceof Symbolic)return this.unknown('Unknown filter predicate',n);if(v)out.push(a[i]);}return out;}
   case 'reduce':{let i=args.length>1?0:1;let out=args.length>1?args[1]:a[0];for(;i<a.length;i++)out=this.invoke(args[0],[out,a[i],i,a],ctx,n);return out;}
   case 'slice':return a.slice(args[0],args[1]);case 'concat':return a.concat(...args);case 'join':return a.join(args[0]);
   case 'includes':return a.includes(args[0],args[1]);case 'indexOf':return a.indexOf(args[0],args[1]);
   case 'push':if(a.length+args.length>this.maxLoop)return this.unknown('Array size bound exceeded',n);return a.push(...args);
   case 'reverse':return a.reverse();case 'flat':return a.flat(Math.min(10,args[0]??1));
   case 'every':case 'some':{const vals=a.map((v,i)=>this.invoke(args[0],[v,i,a],ctx,n));if(vals.some(x=>isUnknown(x)||x instanceof Symbolic))return this.unknown('Unknown array predicate',n);return name==='every'?vals.every(Boolean):vals.some(Boolean);}
   default:return this.unknown('Array method not in whitelist: '+name,n);
  }
 }
 stringMethod(s,name,args,n){
  if(args.some(isUnknown))return this.unknown('String method argument is unknown',n);
  switch(name){case 'slice':return s.slice(args[0],args[1]);case 'substring':return s.substring(args[0],args[1]);case 'substr':return s.substr(args[0],args[1]);case 'toUpperCase':return s.toUpperCase();case 'toLowerCase':return s.toLowerCase();case 'trim':return s.trim();case 'split':if(args[0]===undefined||typeof args[0]==='string')return s.split(args[0],Math.min(args[1]??this.maxLoop,this.maxLoop));break;case 'includes':return s.includes(args[0],args[1]);case 'startsWith':return s.startsWith(args[0],args[1]);case 'endsWith':return s.endsWith(args[0],args[1]);case 'charAt':return s.charAt(args[0]);case 'repeat':if(Number.isInteger(args[0])&&args[0]>=0&&s.length*args[0]<1e6)return s.repeat(args[0]);break;}
  return this.unknown('String method not in whitelist: '+name,n);
 }
 builtin(name,args,ctx,n){
  if(name==='remotion:useCurrentFrame')return ctx?.frame??this.unknown('Frame hook outside render context',n);
  if(name==='remotion:useVideoConfig')return {...this.config};
  if(name==='remotion:staticFile')return 'public/'+String(args[0]);
  if(['react:memo','react:forwardRef'].includes(name))return args[0];
  if(name==='remotion:interpolate')return this.interpolate(args,ctx,n);
  if(name==='remotion:spring')return this.spring(args[0]||{},ctx,n);
  if(name==='Math.PI')return Math.PI;
  if(name.startsWith('Math.')){
   const key=name.slice(5);const allowed=['abs','acos','acosh','asin','asinh','atan','atan2','atanh','cbrt','ceil','cos','cosh','exp','expm1','floor','fround','hypot','log','log10','log1p','log2','max','min','pow','round','sign','sin','sinh','sqrt','tan','tanh','trunc'];
   if(allowed.includes(key)){if(args.some(isUnknown))return this.unknown('Math argument is unknown',n);if(args.some(x=>x instanceof Symbolic))return new Symbolic('call',{callee:name,arguments:args},location(n));if(args.some(x=>typeof x!=='number'))return this.unknown('Math requires numeric arguments',n);return Math[key](...args);}
   return this.unknown('Math property not in whitelist: '+key,n);
  }
  if(name==='Object.keys'||name==='Object.values'||name==='Object.entries'){
   if(!args[0]||typeof args[0]!=='object'||isUnknown(args[0]))return this.unknown('Object enumeration requires concrete object',n);
   if(own(args[0],'__unknown_spread'))return this.unknown('Object enumeration depends on unknown spread',n);
   const keys=Object.keys(args[0]).filter(x=>!BAD_KEYS.has(x));return name==='Object.keys'?keys:name==='Object.values'?keys.map(k=>args[0][k]):keys.map(k=>[k,args[0][k]]);
  }
  if(name==='Object.assign'){const o=dict();for(const a of args){if(isUnknown(a))return a;if(a&&typeof a==='object')for(const k of Object.keys(a))if(!BAD_KEYS.has(k))o[k]=a[k];}return o;}
  if(name==='Array.from'){
   const v=args[0];let arr;if(Array.isArray(v))arr=v.slice();else if(typeof v==='string')arr=[...v];else if(v&&Number.isInteger(v.length)&&v.length>=0&&v.length<=this.maxLoop)arr=Array.from({length:v.length},()=>undefined);else return this.unknown('Array.from requires bounded concrete source',n);
   return args[1]?arr.map((x,i)=>this.invoke(args[1],[x,i],ctx,n)):arr;
  }
  if(name==='Array.isArray')return Array.isArray(args[0]);
  if(['Number','String','Boolean','parseFloat','parseInt','Number.isFinite','Number.isInteger'].includes(name)){
   if(args.some(isUnknown))return this.unknown('Conversion argument unknown',n);
   if(name==='Number')return Number(args[0]);if(name==='String')return String(args[0]);if(name==='Boolean')return Boolean(args[0]);if(name==='parseFloat')return parseFloat(args[0]);if(name==='parseInt')return parseInt(args[0],args[1]);if(name==='Number.isFinite')return Number.isFinite(args[0]);return Number.isInteger(args[0]);
  }
  if(name.startsWith('remotion:Easing.'))return this.easing(name.slice('remotion:Easing.'.length),args,ctx,n);
  return this.unknown('Builtin not implemented: '+name,n);
 }
 easing(name,args,ctx,n){
  const t=args[0];if(isUnknown(t))return t;
  if(name==='linear')return t;
  if(name==='quad')return t*t;if(name==='cubic')return t*t*t;if(name==='sin')return 1-Math.cos(t*Math.PI/2);if(name==='circle')return 1-Math.sqrt(1-t*t);
  return this.unknown('Easing variant not implemented: '+name,n);
 }
 interpolate(args,ctx,n){
  const [v,input,output,opts={}]=args;
  if(isUnknown(v)||!Array.isArray(input)||!Array.isArray(output)||input.length<2||input.length!==output.length||[...input,...output].some(x=>typeof x!=='number'))return this.unknown('interpolate requires concrete numeric ranges',n);
  if(input.some((x,i)=>i>0&&x<=input[i-1]))return this.unknown('interpolate input range must increase',n);
  let x=v;if(x<input[0]){if(opts.extrapolateLeft==='clamp')x=input[0];if(opts.extrapolateLeft==='identity')return v;if(opts.extrapolateLeft==='wrap')return this.unknown('interpolate wrap not implemented',n);}
  if(x>input.at(-1)){if(opts.extrapolateRight==='clamp')x=input.at(-1);if(opts.extrapolateRight==='identity')return v;if(opts.extrapolateRight==='wrap')return this.unknown('interpolate wrap not implemented',n);}
  let i=input.findIndex((b,j)=>j<input.length-1&&x<=input[j+1]);if(i<0)i=input.length-2;
  let p=(x-input[i])/(input[i+1]-input[i]);if(opts.easing)p=this.invoke(opts.easing,[p],ctx,n);if(isUnknown(p))return p;
  return output[i]+(output[i+1]-output[i])*p;
 }
 spring(opts,ctx,n){
  if(!opts||isUnknown(opts))return this.unknown('Unknown spring options',n);
  const cfg=opts.config||{};const frame=opts.frame??ctx?.frame;const fps=opts.fps??this.config.fps;const mass=cfg.mass??1,stiffness=cfg.stiffness??100,damping=cfg.damping??10;
  const from=opts.from??0,to=opts.to??1,delay=opts.delay??0;
  if([frame,fps,mass,stiffness,damping,from,to,delay].some(x=>typeof x!=='number'||!Number.isFinite(x))||fps<=0||mass<=0||stiffness<=0||damping<0)return this.unknown('Invalid or unknown spring parameters',n);
  const fields={...opts,frame,fps,from,to,delay,config:{mass,stiffness,damping,...cfg},exact:false,evaluation:'symbolic_only'};
  ctx?.approximateCalls?.push({kind:'spring',source:location(n),options:publicValue(fields),symbolic:true});
  this.diagnostic('symbolic','spring retained symbolically; no numeric spring approximation used',n);
  return new Symbolic('spring',fields,location(n));
 }
 jsx(n,env,ctx){
  if(ts.isJsxFragment(n))return {kind:'fragment',tag:'Fragment',attrs:{},bindings:{},children:this.jsxChildren(n.children,env,ctx),source:location(n),time:this.timeInfo(ctx)};
  const opening=ts.isJsxElement(n)?n.openingElement:n;const tag=opening.tagName.getText();const props=dict(),bindings=dict();
  for(const a of opening.attributes.properties){
   if(ts.isJsxSpreadAttribute(a)){const v=this.expr(a.expression,env,ctx);if(isUnknown(v)){for(const key of Object.keys(props))props[key]=this.unknown('Later unknown JSX spread may override attribute '+key,a,{spread:v});props.__unknown_spread=v;bindings.__unknown_spread={source:location(a),dependencies:this.dependencies(a.expression,env)};}else if(v&&typeof v==='object')for(const k of Object.keys(v)){if(BAD_KEYS.has(k))continue;props[k]=v[k];bindings[k]={kind:'spread_attribute',source:location(a.expression),property:k,dependencies:this.dependencies(a.expression,env)};}continue;}
   const k=a.name.getText();if(!a.initializer)props[k]=true;else if(ts.isStringLiteral(a.initializer))props[k]=a.initializer.text;else props[k]=this.expr(a.initializer.expression,env,ctx);
   bindings[k]={kind:'attribute',source:location(a.initializer||a),dependencies:this.dependencies(a.initializer||a,env)};
  }
  const childNodes=ts.isJsxElement(n)?n.children:[];const target=/^[a-z]/.test(tag)?null:this.tagValue(opening.tagName,env,ctx);
  const builtinName=target instanceof Builtin?target.name:null;
  if(builtinName==='remotion:Sequence'){
   const from=props.from??0,duration=props.durationInFrames??Infinity;
   if(typeof from!=='number'||typeof duration!=='number'||!ctx)return this.unknown('Sequence timing is not concrete',n);
   const local=ctx.frame-from,active=local>=0&&local<duration;
   const childCtx={...ctx,frame:local,sequenceOffset:ctx.sequenceOffset+from};
   return {kind:'sequence',tag,attrs:props,bindings,active,children:active?this.jsxChildren(childNodes,env,childCtx):[],source:location(n),time:this.timeInfo(childCtx)};
  }
  const children=this.jsxChildren(childNodes,env,ctx);if(children.length)props.children=children;
  if(target instanceof Fn){const origin={kind:'component_props',source:location(opening),bindings};const tree=this.invoke(target,[props],ctx,opening,[origin]);
   return {kind:'component',tag,definition:location(target.node),attrs:props,bindings,children:this.normalizeChildren(tree,n,ctx),source:location(n),time:this.timeInfo(ctx)};
  }
  if(builtinName==='react:Fragment')return{kind:'fragment',tag,attrs:props,bindings,children,source:location(n),time:this.timeInfo(ctx)};
  if(builtinName==='remotion:AbsoluteFill')props.style={position:'absolute',top:0,left:0,right:0,bottom:0,width:'100%',height:'100%',display:'flex',...(props.style||{})};
  if(target&&!(target instanceof Builtin)){this.diagnostic('unsupported','Unresolved JSX component '+tag,n);return {kind:'unknown',tag,reason:'Unresolved component',value:target,attrs:props,bindings,children,source:location(n),time:this.timeInfo(ctx)};}
  if(builtinName&&!['remotion:AbsoluteFill','remotion:Img','remotion:Video','remotion:OffthreadVideo','remotion:Audio'].includes(builtinName)){
   this.diagnostic('unsupported','Unsupported JSX builtin '+builtinName,n);return{kind:'unknown',tag,reason:'Unsupported JSX builtin',attrs:props,bindings,children,source:location(n),time:this.timeInfo(ctx)};
  }
  return {kind:'element',tag,attrs:props,bindings,children,source:location(n),time:this.timeInfo(ctx),...(builtinName?{builtin:builtinName}:{})};
 }
 tagValue(n,env,ctx){if(ts.isIdentifier(n))return this.expr(n,env,ctx);if(ts.isPropertyAccessExpression(n))return this.expr(n,env,ctx);return this.unknown('Unsupported JSX tag expression',n);}
 timeInfo(ctx){return ctx?{global_seconds:ctx.time,global_frame:ctx.globalFrame,local_frame:ctx.frame,sequence_offset:ctx.sequenceOffset,fps:this.config.fps}:null;}
 normalizeChildren(value,node,ctx){
  if(value===undefined||value===null||typeof value==='boolean')return[];
  if(Array.isArray(value))return value.flatMap(v=>this.normalizeChildren(v,node,ctx));
  if(typeof value==='string'||typeof value==='number')return[{kind:'text',text:String(value),source:location(node),time:this.timeInfo(ctx)}];
  if(isUnknown(value))return[{kind:'unknown',reason:value.reason,source:value.source,details:value.details||null,time:this.timeInfo(ctx)}];
  if(value&&['element','component','sequence','fragment','unknown','text'].includes(value.kind))return[value];
  return[{kind:'unknown',reason:'Non-renderable abstract child',value,source:location(node),time:this.timeInfo(ctx)}];
 }
 jsxChildren(nodes,env,ctx){const out=[];for(const n of nodes){
   if(ts.isJsxText(n)){const text=this.jsxText(n.text);if(text)out.push({kind:'text',text,source:location(n),time:this.timeInfo(ctx)});}
   else if(ts.isJsxExpression(n)){if(n.expression)out.push(...this.normalizeChildren(this.expr(n.expression,env,ctx),n,ctx));}
   else out.push(...this.normalizeChildren(this.expr(n,env,ctx),n,ctx));
  }return out;}
 jsxText(text){const lines=text.replace(/\r/g,'').split('\n');return lines.map((s,i)=>{let t=s.replace(/\t/g,' ');if(i>0)t=t.replace(/^ +/,'');if(i<lines.length-1)t=t.replace(/ +$/,'');return t;}).filter(Boolean).join(' ');}
 run(){
  const entry=this.resolve('./'+this.options.entry,path.join(this.root,'__root__.js'));if(!entry)throw new Error('Entry file not found');
  const m=this.module(entry);const target=this.exportValue(m,this.options.exportName||this.options.export||'default',m.sf);
  const frames=[];for(const time of this.options.times){
   if(typeof time!=='number'||!Number.isFinite(time)||time<0)throw new Error('times must contain finite nonnegative seconds');
   this.steps=0;this.ctx={time,globalFrame:Math.round(time*this.config.fps),frame:Math.round(time*this.config.fps),sequenceOffset:0,approximateCalls:[]};
   let result;try{result=this.invoke(target,[this.options.props||{}],this.ctx,m.sf,[{kind:'entry_props'}]);}catch(e){result=this.unknown('Analysis resource/runtime guard: '+e.message,m.sf);}
   frames.push({time,frame:this.ctx.globalFrame,tree:this.normalizeChildren(result,m.sf,this.ctx),approximate_calls:this.ctx.approximateCalls,steps:this.steps});
  }
  return publicValue({schema_version:1,analysis_mode:'whitelist_ast_interpretation_no_submitted_execution',entry:this.options.entry,export:this.options.exportName||this.options.export||'default',config:this.config,frames,diagnostics:this.diagnostics,
   unsupported_count:this.diagnostics.filter(x=>x.code==='unsupported'||x.code==='parse_error').length,
   approximate_count:this.diagnostics.filter(x=>x.code==='approximation').length,
   symbolic_count:this.diagnostics.filter(x=>x.code==='symbolic').length,
   source_files:[...this.modules.values()].map(m=>({path:m.sf.__relativePath,sha256:crypto.createHash('sha256').update(m.source).digest('hex'),bytes:Buffer.byteLength(m.source)})),
   limitations:['No DOM/CSS layout engine; attrs are source-level values, not rendered bounding boxes.','Spring calls and expressions depending on them remain symbolic; no spring numeric approximation is used.','Unsupported syntax/imports propagate unknown; no arbitrary source module, getter, external package or I/O executes.','Inputs are only source files. No video or raster image is read.']});
 }
}
function normalizePublic(value){
 if(Array.isArray(value))return value.map(normalizePublic);
 if(!value||typeof value!=='object')return value;
 if(value.kind==='text')return value.text;
 const out={};for(const[k,v]of Object.entries(value)){if(k==='children'&&value.attrs===v)continue;out[k]=normalizePublic(v);}
 if(value.kind==='unknown')out.$unknown=value.reason||'unknown JSX';
 if(['element','component','sequence','fragment','unknown'].includes(value.kind)){out.file=value.source?.file||null;out.line=value.source?.line||null;if(out.attrs)delete out.attrs.children;}
 return out;
}
function analyze(options){if(!Array.isArray(options.times)||options.times.length>1000)throw new Error('times must be an array of <=1000 seconds');return normalizePublic(new Analyzer(options).run());}
function main(argv){const opts={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--'))throw new Error('Expected named option');opts[argv[i].slice(2)]=argv[++i];}
 if(!opts.source||!opts.entry||!opts.export||!opts.times||!opts.output)throw new Error('Usage: node source_analyzer.cjs --source DIR --entry REL --export NAME --fps 30 --times "[0,1]" --output FILE');
 const result=analyze({source:opts.source,entry:opts.entry,exportName:opts.export,fps:Number(opts.fps||30),times:JSON.parse(opts.times),width:opts.width?Number(opts.width):undefined,height:opts.height?Number(opts.height):undefined,durationInFrames:opts['duration-in-frames']?Number(opts['duration-in-frames']):undefined,props:opts.props?JSON.parse(opts.props):{}});
 fs.mkdirSync(path.dirname(path.resolve(opts.output)),{recursive:true});fs.writeFileSync(opts.output,JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify({output:path.resolve(opts.output),frames:result.frames.length,unsupported_count:result.unsupported_count,approximate_count:result.approximate_count,source_files:result.source_files.length})+'\n');
}
module.exports={analyze,Analyzer};
if(require.main===module){try{main(process.argv.slice(2));}catch(e){process.stderr.write(e.stack+'\n');process.exitCode=1;}}
