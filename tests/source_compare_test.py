"""Comparator regression tests. Override VERIFIER_COMPARE_PATH to test a copy."""
import importlib.util,os,unittest
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
if __name__=='__main__':unittest.main()
