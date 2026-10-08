"""Comparator regression tests. Override VERIFIER_COMPARE_PATH to test a copy."""
import importlib.util,os,unittest,json,tempfile
from unittest.mock import patch
from pathlib import Path
p=Path(os.environ.get('VERIFIER_COMPARE_PATH',str(Path(__file__).resolve().parents[1]/'assets/verifier-template/source_compare.py')))
s=importlib.util.spec_from_file_location('comparison_under_test',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def node(tag,attrs,children=None):return {'kind':'element','tag':tag,'attrs':attrs,'children':children or [],'source':{'file':'case.tsx','line':1,'start':1}}
class SourceCompareRegression(unittest.TestCase):
 def test_absolute_triangle_path(self):
  self.assertEqual(m.points(node('path',{'d':'M150 280H282L216 200Z'})),[(150,280),(282,280),(216,200)])
 def test_unknown_geometry_is_not_missing(self):
  with self.assertRaises(m.Unsupported):m.select({'tree':[node('path',{'d':{'$unknown':'call result'},'stroke':'red','strokeDasharray':100})]},{'tags':['path'],'shape':'triangle','stroke':True})
 def test_unrelated_unknown_color_does_not_block_opacity(self):
  self.assertEqual(m.prop(node('div',{'style':{'opacity':.5,'color':{'$unknown':'external palette'}}}),(),'opacity'),.5)
 def test_static_scale_plus_scene_exit_is_not_dynamic(self):
  check={'property':'scale_binding','metric':'scale_binding','window_seconds':[9,18]}
  def obj(values):return {'track':[{'time':t,'node':None if v is None else (node('div',{'style':{'transform':f'scale({v})'}}),()),'unknown':False} for t,v in values]}
  ref=m.values(obj([(9,0),(10,.5),(18,None)]),check);rep=m.values(obj([(9,1),(10,1),(18,None)]),check)
  self.assertEqual(m.error(ref,rep,check),1)
 def test_symbolic_translate_ancestor_does_not_block_child_scale(self):
  ancestor=node('div',{'style':{'transform':{'$symbolic':{'kind':'template','parts':['translateY(',{'$symbolic':{'kind':'spring','frame':10,'from':16,'to':0}},'px)']}}}})
  self.assertEqual(m.prop(node('div',{'style':{'transform':'scale(0.9)'}}),(ancestor,),'scale_binding'),.9)
 def test_open_right_angle_is_not_triangle(self):
  self.assertFalse(m.accepts(node('path',{'d':'M209 280V273H216','stroke':'red'}),{'shape':'triangle','stroke':True}))
 def test_unknown_stroke_is_not_a_confirmed_identity(self):
  with self.assertRaises(m.Unsupported):m.select({'tree':[node('line',{'x1':0,'x2':0,'y1':0,'y2':10,'stroke':{'$unknown':'palette'}})]},{'shape':'vertical_line','stroke':True})
 def test_unknown_branch_cannot_hide_second_candidate(self):
  with self.assertRaises(m.Unsupported):m.select({'tree':[node('div',{},['answer']),{'kind':'unknown','reason':'condition'}]},{'text_any':['answer']})
 def test_single_sample_does_not_prove_binding(self):
  with self.assertRaises(m.Unsupported):m.error([[0,1]],[[0,1]],{'metric':'binding'})
 def test_late_mount_is_tracked_as_timing_not_object_missing(self):
  target=node('div',{},['answer'])
  data={'frames':[{'time':0,'tree':[]},{'time':1,'tree':[target]}]}
  obj=m.sampled_object(data,{'anchor_time':0,'selector':{'text_any':['answer']}})
  self.assertIsNotNone(obj)
  vals=m.values(obj,{'window_seconds':[0,1],'metric':'onset','property':'opacity'})
  self.assertEqual(vals,[[0,0.0],[1,1.0]])
 def test_late_mount_with_different_identities_is_ambiguous(self):
  first=node('div',{},['answer']);second=node('div',{},['answer']);second['source']['start']=2
  with self.assertRaises(m.Ambiguous):m.sampled_object({'frames':[{'time':0,'tree':[]},{'time':1,'tree':[first]},{'time':2,'tree':[second]}]},{'anchor_time':0,'selector':{'text_any':['answer']}})
 def test_reference_without_relative_onset_is_unsupported(self):
  def frame(t):
   a=node('div',{'style':{'opacity':0}},['main']);b=node('div',{'style':{'opacity':0}},['peer']);b['source']['start']=2
   return {'time':t,'tree':[a,b]}
  data={'frames':[frame(0),frame(1)]}
  with tempfile.TemporaryDirectory() as directory:
   private=Path(directory)/'private';private.mkdir()
   (private/'objects.json').write_text(json.dumps([{'id':name,'anchor_time':0,'selector':{'text_any':[name]}} for name in ['main','peer']]))
   rubric={'sample_times':[0,1],'checks':[{'id':'relative','object_id':'main','peer_object':'peer','metric':'relative_onset','property':'opacity','window_seconds':[0,1],'bad':1}]}
   with patch.object(m,'analyze',return_value=data):
    result=m.measure(Path('original'),Path('replica'),private,rubric,{'entry':'x'},{'entry':'x'})
   self.assertEqual(result['checks'][0]['status'],'unsupported')
   self.assertIn('reference relative onset',result['checks'][0]['reason'])
 def test_triangle_vertices_equal_across_path_polygon_reordering(self):
  shapes=[node('polygon',{'points':'0,10 10,10 5,0'}),node('path',{'d':'M10 0L0 20H20Z'}),node('polygon',{'points':'10,10 0,10 5,0'})]
  pts=[m.prop(n,(),'triangle_vertices') for n in shapes]
  for p in pts[1:]:self.assertEqual(m.error([[0,pts[0]]],[[0,p]],{'metric':'triangle_geometry'}),0)
 def test_equal_aspect_wrong_apex_is_detected(self):
  ref=node('polygon',{'points':'0,10 10,10 5,0'});bad=node('polygon',{'points':'0,10 10,10 9,0'})
  self.assertEqual(m.prop(ref,(),'aspect_ratio'),m.prop(bad,(),'aspect_ratio'))
  self.assertGreater(m.error([[0,m.prop(ref,(),'triangle_vertices')]],[[0,m.prop(bad,(),'triangle_vertices')]],{'metric':'triangle_geometry'}),.1)
 def test_triangle_transform_is_not_silently_ignored(self):
  with self.assertRaises(m.Unsupported):m.prop(node('polygon',{'points':'0,10 10,10 5,0','transform':'skewX(20)'}),(),'triangle_vertices')
 def test_spring_parameters_track_bound_object_and_ancestor(self):
  def spring(damping=10):return {'$symbolic':{'kind':'template','parts':['scale(',{'$symbolic':{'kind':'spring','fps':30,'frame':20,'from':.85,'to':1,'durationInFrames':22,'config':{'mass':1,'stiffness':100,'damping':damping}}},')']}}
  obj=node('div',{'style':{'transform':spring()}});wrong=node('div',{'style':{'transform':spring(40)}});other=node('div',{})
  ref=m.prop(obj,(),'spring_scale_parameters');rep=m.prop(wrong,(),'spring_scale_parameters')
  check={'metric':'spring_parameters','bad':1,'parameter_scales':{'damping':10,'duration_seconds':1}}
  self.assertEqual(m.error([[0,ref]],[[0,ref]],check),0)
  self.assertEqual(m.error([[0,ref]],[[0,rep]],check),3)
  self.assertEqual(m.prop(other,(obj,),'spring_scale_parameters'),ref)
  self.assertEqual(m.error([[0,ref]],[[0,m.prop(other,(),'spring_scale_parameters')]],check),1)
 def test_static_scale_ancestor_does_not_conflict_with_spring(self):
  sp={'$symbolic':{'kind':'template','parts':['scale(',{'$symbolic':{'kind':'spring','fps':30,'frame':20,'from':.85,'to':1,'durationInFrames':22,'config':{'mass':1,'stiffness':100,'damping':10}}},')']}}
  ancestor=node('div',{'style':{'transform':'scale(.5)'}});child=node('div',{'style':{'transform':sp}})
  self.assertEqual(m.prop(child,(ancestor,),'spring_scale_parameters')['damping'],10.0)
 def test_translate_spring_does_not_count_as_scale_parameters(self):
  transform={'$symbolic':{'kind':'template','parts':['translateY(',{'$symbolic':{'kind':'spring','frame':5}},'px)']}}
  self.assertEqual(m.prop(node('div',{'style':{'transform':transform}}),(),'spring_scale_parameters'),{'kind':'non_spring','scale':1.0})
 def test_multiple_svg_subpaths_are_not_a_triangle(self):
  with self.assertRaises(m.Unsupported):m.points(node('path',{'d':'M0 10L10 10L5 0Z M-999 -999L999 -999L999 999L-999 999Z'}))
 def test_static_scale_without_spring_is_bad_but_dynamic_non_spring_unknown(self):
  def spring():return {'$symbolic':{'kind':'template','parts':['scale(',{'$symbolic':{'kind':'spring','fps':30,'frame':20,'from':.85,'to':1,'durationInFrames':22,'config':{'mass':1,'stiffness':100,'damping':10}}},')']}}
  ref=m.prop(node('div',{'style':{'transform':spring()}}),(),'spring_scale_parameters')
  static=m.prop(node('div',{'style':{'transform':'scale(1)'}}),(),'spring_scale_parameters')
  self.assertEqual(static.get('kind'),'non_spring')
  self.assertEqual(m.error([[0,ref]],[[0,static]],{'metric':'spring_parameters','bad':1,'parameter_scales':{'mass':1}}),1)
  moving=[m.prop(node('div',{'style':{'transform':f'scale({v})'}}),(),'spring_scale_parameters') for v in [.85,.9,1]]
  with self.assertRaises(m.Unsupported):m.error([[t,ref] for t in range(3)],list(enumerate(moving)),{'metric':'spring_parameters','bad':1,'parameter_scales':{'mass':1}})
  dynamic={'$symbolic':{'kind':'call','callee':'interpolate'}}
  with self.assertRaises(m.Unsupported):m.prop(node('div',{'style':{'transform':dynamic}}),(),'spring_scale_parameters')
if __name__=='__main__':unittest.main()
