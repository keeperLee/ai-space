# 智能客服 Agent · 完整可运行示例

这是《Agent 学习平台》[第 22 章 · 完整项目](https://keeperlee.github.io/agent-learning-platform/#/chapter/c22) 的配套代码。

**零第三方依赖**（只用 Python 标准库），**没有 API Key 也能完整跑通**。

```bash
cd examples/support-agent

python run.py                                  # 交互式对话（离线 Mock 模型）
python run.py --once "订单 ...0417 能退吗"       # 单次提问
python run.py --trace                          # 打印完整调用链
python -m unittest discover -s tests -v        # 跑测试
```

设置 API Key 后自动切换为真实模型：

```bash
export OPENAI_API_KEY=sk-xxx
export OPENAI_MODEL=gpt-4o-mini          # 可选
export OPENAI_BASE_URL=https://...        # 可选，兼容任意 OpenAI 协议的服务
python run.py --once "..."
```

---

## 为什么要有这个项目

前面的章节给了原理和片段，这个项目把它们**组装成一个能跑的完整系统**，可以逐层对照阅读。

| 文件 | 对应章节 | 说明 |
| --- | --- | --- |
| `agent/loop.py` | [第 5 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c05) | 主循环：感知 → 规划 → 行动 → 反思，含预算与无进展检测 |
| `agent/llm.py` | [第 3 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c03) | 模型适配层：MockLLM 与真实模型可无缝切换 |
| `agent/tools.py` | [第 8 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c08) | 工具注册、Schema 校验、错误翻译、幂等键 |
| `agent/knowledge.py` | [第 13 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c13) | 知识库切分与检索（含标题路径、版本过滤） |
| `agent/memory.py` | [第 7 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c07) | 会话记忆（结构化状态）+ 长期记忆（用户偏好） |
| `agent/guard.py` | [第 15 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c15) | 输入 / 动作 / 输出三道护栏 |
| `agent/trace.py` | [第 14 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c14) | 全链路记录、成本核算、可回放 |
| `prompts/system.txt` | [第 9 章](https://keeperlee.github.io/agent-learning-platform/#/chapter/c09) | 提示词独立文件，便于版本化与 A/B |

---

## 目录结构

```
support-agent/
├── run.py                  # CLI 入口（交互式 / 单次 / 打印 Trace）
├── agent/
│   ├── config.py           # 配置与预算
│   ├── llm.py              # 模型适配层（Mock + OpenAI 兼容）
│   ├── tools.py            # 工具注册与执行
│   ├── knowledge.py        # 知识库检索
│   ├── memory.py           # 会话记忆与长期记忆
│   ├── guard.py            # 三道护栏
│   ├── trace.py            # 调用链记录
│   └── loop.py             # 主循环
├── prompts/system.txt      # 系统提示词
├── data/
│   ├── knowledge.md        # 知识库（退换货 / 物流 / 发票 / 保修）
│   ├── orders.json         # 模拟订单与物流数据
│   └── state/              # 运行期产物：长期记忆与 Trace（自动创建）
└── tests/test_agent.py     # 零成本单元测试（全部基于 MockLLM）
```

---

## 关于 MockLLM

没有 API Key 时，`agent/llm.py` 会启用 `MockLLM`。

**它是一个规则实现的模拟器，用关键词与消息历史模拟「模型大概会怎么决策」**，目的是让你在没有账号、不花钱的情况下完整观察：

- 主循环怎么迭代、什么时候终止
- 工具怎么被选中、参数怎么校验、错误怎么回灌
- 护栏怎么拦截、Trace 长什么样

它**不是真实模型**，不具备泛化能力 —— 换个问法就可能失灵。要看真实效果，请配置 API Key 切到真模型。

> 这也是一个工程上的通用做法：**用 Mock 测流程，用真模型测效果**。
> 前者免费且可复现，后者贵且有随机性，两者职责不同（见第 14 章）。

---

## 示例对话

```
你 > 订单 20260828-0417 的蓝牙耳机想退货，还在期限内吗

[第 1 轮] 思考：用户询问退货期限，需要先确认订单状态和签收时间
         行动：get_order(order_id="20260828-0417")
         观察：{"order_id": "...0417", "item": "蓝牙耳机", "status": "已签收",
                "signed_at": "2026-08-30", "amount": 299.0, "category": "普通商品"}

[第 2 轮] 思考：普通商品 7 天可退，需要确认政策细节
         行动：search_knowledge_base(query="退货 期限 普通商品", top_k=3)
         观察：命中 2 条 · KB-RETURN-001 · KB-RETURN-004

[第 3 轮] 判断：签收日 2026-08-30，距今 21 天，已超出 7 天期限 → 终止循环

客服 > 订单 ...0417（蓝牙耳机，299 元）于 2026-08-30 签收，距今已 21 天，
       超出普通商品 7 天无理由退货期限。若属质量问题，可在 15 天内申请，
       需要附带质检报告 [KB-RETURN-003]。要我帮你转人工进一步处理吗？

────────────────────────────────────────
本次任务：3 步 · 2 次模型调用 · 2 次工具调用 · 约 1,840 tokens
```

---

## 被刻意保留的设计取舍

这个项目是教学材料，有几处**故意为之**的简化，阅读时请注意：

| 简化 | 真实项目应该怎么做 |
| --- | --- |
| 检索用字符 bigram 打分，不是向量 | 换成嵌入模型 + 向量库，并按第 13 章做混合检索与重排 |
| Trace 落 JSON 文件 | 接入 OpenTelemetry / Langfuse 等平台 |
| 长期记忆存本地 JSON | 用数据库，并做好租户隔离 |
| 护栏用正则匹配注入特征 | 正则只能挡低级攻击，真实防护要靠权限收敛与动作审批 |
| 无并发 | 生产环境要处理并发、限流与超时传播 |

**它们被简化的是「实现」，不是「结构」** —— 目录划分、接口设计、护栏位置、Trace 字段都是可以照搬到生产的。

---

## 验证

```bash
python -m unittest discover -s tests -v
```

覆盖：知识库检索、工具参数校验、注入拦截、PII 脱敏、高风险动作审批、预算中止、无进展检测。
