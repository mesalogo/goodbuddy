---
name: product-evidence
version: 1.0.0
description: |
  建立和维护产品市场材料的事实与证据清单，统一产品版本、功能状态、技术参数、
  术语、适用边界和可公开主张。用于开始任何产品介绍、投标参数、PPT、技术方案、
  白皮书或案例材料之前，也用于跨产物一致性核验。
allowed-tools:
  - Read
  - Grep
  - Glob
  - Execute
compatibility: Python 3.9+，校验脚本不依赖第三方包
---

# 产品事实与证据

所有产品市场产物都必须从同一份 `product-evidence.json` 取事实。缺少依据时标记
待核验，不允许由 Agent 补造参数、客户结果、认证、兼容性或竞争结论。

`<skill-dir>` 指本 `SKILL.md` 所在目录。

## 建立清单

```bash
cp "<skill-dir>/templates/product-evidence.example.json" ./product-evidence.json
```

逐项填写：

- `product`：产品名称、版本、类别、定位、成熟度和目标读者。
- `terminology`：统一术语、定义和禁用旧称。
- `features`：功能 ID、用户动作、结果、状态、版本范围和证据。
- `parameters`：参数值、单位、测试条件、适用版本、公开级别和证据。
- `claims`：允许对外使用的事实、目标或比较主张及适用产物。
- `use_cases`：角色、问题、工作流、人工复核点和已有结果。
- `differentiators`：比较对象、比较范围和支持证据。
- `limitations`：部署条件、依赖、适用边界和必要人工复核。
- `evidence`：来源、定位、核验日期、责任人和公开级别。
- `prohibited_claims`：不得出现在任何材料中的绝对化或未经批准表述。

## 事实分级

- `released`：当前版本已提供，必须有可定位证据。
- `beta`：可试用但存在范围限制，正文必须同时说明限制。
- `planned`：仅可用将来时或规划表述，不得写成现有能力。
- `deprecated`：不得作为当前卖点。

证据公开级别：

- `public`：可进入公开网站、彩页和公开演示。
- `restricted`：只在授权客户或受控投标材料中使用。
- `internal`：只用于内部判断，不能原样写入外发产物。

## 校验

先探测可用的 Python 3 解释器：Windows 优先使用 `python`，macOS/Linux
优先使用 `python3`。下文 `<python>` 表示探测成功的解释器命令。

```bash
<python> "<skill-dir>/scripts/validate_evidence.py" ./product-evidence.json
<python> "<skill-dir>/scripts/validate_evidence.py" ./product-evidence.json --json
<python> "<skill-dir>/scripts/validate_evidence.py" ./product-evidence.json \
  --strict --channel public
```

结构错误、重复 ID、失效引用、无证据的已批准事实主张、非法状态或疑似密钥参数
必须阻断。缺证据、占位符和待核验项在普通模式下告警，在 `--strict` 下阻断。

`--channel` 按目标渠道核对公开级别：已批准且带 `allowed_outputs` 的主张，其
引用证据的 `disclosure` 不得低于渠道要求。对外产物必须以 `--strict` 加目标
渠道运行通过后才能进入下游技能。

## 给下游技能的输入

调用任何产品产物技能时，同时提供：

1. 已通过校验的 `product-evidence.json`。
2. 目标受众、使用场景、发布渠道和保密级别。
3. 本次产物允许引用的证据范围。
4. 截止日期、页数或篇幅、格式和品牌要求。

下游产物中的每个数字、兼容性、认证、客户效果和比较结论都应能追溯到清单 ID。

## 完成标准

清单结构校验通过；公开级别与使用渠道匹配；所有现有功能、参数和批准主张有
证据；规划能力、限制和人工复核要求没有被省略；不含密钥、客户隐私或私有地址。
