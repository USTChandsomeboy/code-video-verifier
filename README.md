# code-video-verifier

一个根据原作 Remotion 源码和视频生成自动评分器的 Codex skill。

它将原作视频中的对象、SVG 几何、文字、动效绑定和时间关系整理成隐藏检查清单，然后生成 verifier。verifier 使用同一套 TypeScript AST 静态解析器读取原作源码和复刻源码，输出分数、逐项误差、对象匹配关系和源码证据。

## 目录

- `SKILL.md`：skill 使用说明和生成流程
- `assets/verifier-template/`：verifier 模板，包括评分入口、源码解析器和比较器
- `references/`：评分契约、对象配置、验证要求和检查项模板
- `scripts/`：初始化、封存和自检脚本
- `tests/`：解析器和比较器测试

## 使用

将本目录安装为 Codex skill，例如：

```sh
ln -s /path/to/code-video-verifier ~/.codex/skills/code-video-verifier
```

在 Codex 中使用 `$code-video-verifier`，提供原作源码目录、对应视频、Composition 入口和输出目录。skill 会生成一个独立 verifier 包。

评估包的运行接口：

```sh
python verify.py \
  --reference-code /path/to/original \
  --replica-code /path/to/replica \
  --replica-entry src/Replica.tsx \
  --replica-export Replica \
  --output /path/to/result
```

评估阶段读取两份源码；提交工程不会被 import、执行或重新渲染。Node.js 18+、Python 3.10+，TypeScript 版本固定为 5.7.2。可设置 `VERIFIER_TYPESCRIPT` 指向 `typescript.js`。

## 输出

- `scores.json`：总分、四项分数、权重、覆盖率和状态
- `checks.json`：每项误差、采样值、状态和两边代码证据
- `matches.json`：原作对象与复刻对象的对应关系
- `diagnostics.json`：缺失、歧义、unknown 和不支持语法

## 测试

```sh
python scripts/selftest.py
python tests/source_compare_test.py
VERIFIER_TYPESCRIPT=/path/to/typescript/lib/typescript.js \
  node tests/source_analyzer.test.cjs
```

当前评分维度：对象完整性 15%、外观与几何 25%、动作绑定 20%、动效参数与时序 40%。
