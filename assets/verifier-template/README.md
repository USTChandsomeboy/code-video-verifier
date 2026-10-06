# 源码自动评分器

评估输入为原作源码与复刻源码。脚本从组件入口解析对象、属性和时间变化，输出 0–100 分及源码证据。

环境：Python 3.10+、Node.js 18+。在评估包目录运行 `npm ci --ignore-scripts` 安装固定的 TypeScript 解析器。也可设置 `VERIFIER_TYPESCRIPT` 指向已安装的同版本 typescript.js。

```sh
python verify.py --reference-code /data/original --replica-code /data/replica \
  --replica-entry src/Replica.tsx --replica-export Replica \
  --replica-fps 30 --replica-width 640 --replica-height 360 \
  --output /results/case-001
```

使用裁切视频时，在原作配置中记录 `time_offset_seconds`；复刻默认从 0 秒开始，必要时通过 `--replica-time-offset` 指定。Composition 总帧数用 `durationInFrames` 记录，复刻通过 `--replica-duration-in-frames` 覆盖。

原作配置和检查清单位于 `private/`。复刻 fps、宽高与 props 应使用提交工程声明的实际值；缺省取原作配置，使用前应核对。入口相对源码目录。

结果：`scores.json` 为分数与覆盖率，`checks.json` 为每项误差和证据，`matches.json` 为对象对应关系，`diagnostics.json` 为解析及覆盖限制。尚未完成验证的包给出 provisional_total；未能计算的检查给出原因。

测量规则和容差在生成期确定，运行时固定。源码分数覆盖已列出的对象与属性；详细支持范围见隐藏检查清单和验证报告。
