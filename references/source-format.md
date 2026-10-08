# 解析与检查配置

`source_analyzer.cjs` 输出采样时刻的 JSX 树。节点包含 `tag`、`attrs`、`children`、`source`、`bindings` 和局部时间。`component` 节点记录组件调用，`element` 节点记录实际元素。文本是字符串。`{$unknown: "原因"}` 表示尚未解析的值；`{$symbolic: ...}` 保存 spring 等函数的结构及参数。

## 对象清单

`private/objects.json` 是对象数组。例如：

```json
[
  {
    "id": "answer",
    "label": "答案卡片",
    "anchor_time": 17.5,
    "selector": {"text_contains": ["答案"], "ancestor": 1}
  }
]
```

在指定时刻找到含有“答案”的最小实际元素，再取上一层实际元素作为卡片。接下来用该元素的源码位置和调用上下文跟踪各时刻。不同工程分别定位，变量名与文件组织可以不同。

选择器支持 `tags`、`text_contains`（全部包含）、`text_any`（任选一个完整文本）、`minimal`、`ancestor`、`stroke`、`dashed`、`no_filter` 和 `shape`。形状支持闭合三角形与垂直线。多个候选记录为 unresolved；未知分支可能包含目标时记录为 unsupported。新对象类型应扩展选择器并增加正反例。

## 检查清单

`private/rubric.json` 包含 `sample_times`（相对于片段起点的秒数）、对象 ID 和检查项。每个检查项除评分协议字段外，指定 `property` 和 `metric`。

| property | 含义 |
| --- | --- |
| opacity | 元素及实际祖先的有效透明度 |
| draw_progress | 根据 strokeDasharray、strokeDashoffset 求描边进度 |
| aspect_ratio | SVG 局部轮廓高宽比 |
| text | 展开后的文字，归一化空白 |
| answer_value | 答案标签后面的数值与单位，供答案卡片案例使用 |
| text_length | 正文字符数，扣除竖线光标 |
| scale_binding | 数字缩放或 spring 缩放是否随时间变化 |

| metric | 误差 |
| --- | --- |
| presence | 找到对应对象为 0；确认缺失走 missing |
| text_equal | 相同为 0，不同为 1 |
| scalar | 最后一个有效采样值之差 |
| mae | 同时刻数值差的绝对值均值 |
| binding | 两边属性是否随时间变化，不一致为 1 |
| scale_binding | 两边是否有变化的缩放绑定，不一致为 1 |
| onset | 属性首次超过阈值的时间之差 |
| relative_onset | 两个对象起点间隔之差，需要 peer_object |

`scale_binding` 对 spring 只检查绑定和时间输入变化。精确的 spring 曲线需要另行实现并验证。`aspect_ratio` 描述所选 SVG 轮廓的局部比例；完整几何、路径形状与变换链应增加专门检查。文本长度的竖线处理是示例规则，其他字符和字体场景应配置专用测量器。

`mae` 应使用能覆盖动作过程的窗口；过长静止区间会稀释动作误差。采样间隔与边界点写入清单，容差应大于采样误差。模板的 `binding` 检查只描述数值是否变化，动作曲线及方向由 motion 项进一步区分。

## 时间与数据

原作的 `composition` 记录入口、导出名、fps、width、height、durationInFrames、props 和 time_offset_seconds。复刻配置由 CLI 提供。两边采样时间按各自 fps 量化为帧，再减去嵌套 Sequence 的起点。

`reference-data/` 保存原作观测值及生成依据；评分脚本会再次校验并解析原作。每项输出保留两边源码位置、参考值、复刻值和误差，可逐项复查。

## 局部三角形与 spring 结构测量

`property: triangle_vertices` 与 `metric: triangle_geometry` 比较闭合三角形的三个顶点。每边先减去包围盒左上角，再以宽度等比例归一化；误差为最佳顶点对应下的平均欧氏距离。对应允许循环起点和逆序，polygon 与绝对 M/L/H/V/Z path 可互换。同宽高比但顶点偏斜会产生误差。此项检查局部形状，不检查画布位置或绝对大小。形状到最近 svg 间存在 transform 时返回 unsupported，需添加变换链适配器。

`property: spring_scale_parameters` 与 `metric: spring_parameters` 只读取目标或祖先中直接绑定到 `scale(${spring(...)})` 的符号参数。支持 mass、stiffness、damping、from、to、local_time_seconds、delay_seconds 和 duration_seconds。每项在 `parameter_scales` 指定正数尺度，误差取所有采样和所列参数的最大归一化差值；采样内明确静态的 scale（包括默认 scale=1）得 bad；动态非 spring 实现返回 unsupported，避免将行为等价实现硬扣分。未使用变量或兄弟元素上的 spring 不参与测量。纯平移 spring 不算缩放。

spring 参数项属于明确声明的结构检查，不表示完整视觉曲线；其他函数生成相同曲线的实现应由专用曲线测量器判定等价。此项不应被用作通用视觉相似度。复合符号 scale 和多个祖先 spring scale 暂不支持。检查参数之外的参数应在覆盖范围中列明。

当目标存在一个明确的 spring scale 时，外层数值 scale 可作为画布适配，不记为第二个 spring，也不改变结构参数得分。该结构项只检查 spring 本身，静态缩放造成的绝对尺寸差异需由布局/几何项另行评价。仅多个符号 spring scale 仍返回 unsupported。
