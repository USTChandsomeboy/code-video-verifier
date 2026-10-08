---
name: code-video-verifier
description: 根据原作 Remotion 源码和视频，生成比较原作与复刻源码的自动评分脚本、隐藏检查清单和标准数据。检查实际组件中的对象、SVG 几何、动效绑定及时间参数，输出分数和源码证据。
---

# Code + Video Verifier

使用原作源码和视频确定评分内容，交付一个自动读取原作、复刻两份源码的 verifier。视频帮助确认对象、场景和动作含义；脚本从组件入口解析两份源码，比较对象及其属性随时间的变化。

## 输入与交付

生成输入：原作源码目录、对应视频、Composition 入口与导出名、fps、总帧数、画布尺寸、输入 props、视频的裁切起点和时长、输出目录。首先从工程配置读取这些信息；只询问仍缺失的必需项。

交付：评分脚本、隐藏对象清单、检查规则、原作文件指纹、标准观测值、校准记录和使用说明。原作文件和标准答案由评估端保管；复刻任务提供参考视频。

## 生成步骤

1. 阅读 [生成流程](references/generation.md)、[评分规则](references/contract.md) 和 [验证要求](references/validation.md)。用 `scripts/init_verifier.py` 初始化评估包。
2. 阅读原作入口、组件与相关素材，并查看视频中的关键状态。记录对象身份、SVG 形状、文字、父子关系、属性绑定、开始时间和持续时间。用 [案例检查库](references/weaknesses.json) 辅助选择适用项目。
3. 填写 `private/input-manifest.json` 的入口、fps、尺寸、props 和裁切范围。生成 `private/objects.json`、`private/rubric.json`、`weakness-coverage.json`。每项写清：比较谁、比较什么、单位、容差、分值权重及原作代码/视频证据。
4. 按 [解析与检查配置](references/source-format.md) 设置测量。用同一份 `source_analyzer.cjs` 解析原作和复刻。分析器从指定入口展开本地组件、props、条件分支和有界数组，沿属性依赖计算采样时刻的值。保留文件、行号和表达式证据。白名单之外的表达式记录为 unknown。
5. 配置 `case_adapter.py` 的对象选择与测量逻辑。优先用内容、几何和上下文确定身份，再检查该对象及祖先上的属性。先确认对应关系，再比较数值。对象缺失、歧义和无法解析分别记录。
6. 用原作生成标准观测值，校准检查项和容差。支持 SVG 的等价几何表达、变量改名和简单组件拆分。评分针对属性行为及几何；实现方式不同仍可能等价。
7. 运行原作自对照、等价改写、定向修改和真实复刻四组测试。定向修改覆盖对象删除、未使用文字、绑定错对象、动画冻结、时序偏移和无法解析的表达式。保存每次命令和完整结果。自对照 100 仅证明两份相同输入得到一致结果；每类被计分的能力还需一个会扣分的错误样例和一个保持得分的等价样例。
8. 生成验证报告，填写 `private/validation.json`，用 `scripts/seal_verifier.py` 封存。检查结果中的证据、覆盖率及失败原因。交付已验证范围与剩余限制。

## 评分接口

```sh
python verify.py --reference-code /data/original \
  --replica-code /data/replica --replica-entry src/Replica.tsx \
  --replica-export Replica --output /results/case-001
```

两边的 Composition 配置分别记录：原作取隐藏清单，复刻通过参数提供。输出 `scores.json`、`checks.json`、`matches.json` 和 `diagnostics.json`。分数为 0–100，附四项分数与检查覆盖率；无法解析的检查保留空值和原因。

## 工具与范围

Python 3.10+、Node.js 18+、评估包固定版本的 TypeScript。`source_analyzer.cjs` 使用 AST 白名单解释规则。模板覆盖常见 JSX、内联样式、局部时间、插值及基础 SVG；扩展新语法或新形状时同时添加正反例测试。

运行 `python scripts/selftest.py` 检验评分规则，运行评估包中的解析器测试与专用案例测试。源码观测值描述已支持表达式的行为；浏览器排版、外部 CSS、字体及复杂渲染另列覆盖范围。

模板测试：`node tests/source_analyzer.test.cjs` 和 `python tests/source_compare_test.py`。解析器依赖位于评估包，或由 `VERIFIER_TYPESCRIPT` 指定。

批量生成或接入 Harbor 时，阅读 [批量与 Harbor 接口](references/harbor.md)。分别记录任务结构、源码检查覆盖、校准、容器运行结果。视频以哈希和位置引用；生成包保持可追溯的原作版本。
