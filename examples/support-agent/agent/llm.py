"""模型适配层。

对应正文：第 3 章（模型能力与短板）、第 8 章（模型只输出调用意图）。

设计要点：把「推理内核」抽象成接口，主循环只依赖 `LLM.decide()`。
这样换模型、换供应商、A/B 不同提示词都不需要改动其他组件（第 10 章）。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import Settings

# ---------------------------------------------------------------------------
# 数据结构
# ---------------------------------------------------------------------------


@dataclass
class LLMResponse:
    """模型的一次决策。三种 action 与提示词里约定的 JSON 形态一一对应。"""

    thought: str = ""
    action: str = "final_answer"          # tool_call | final_answer | ask_user
    tool: str = ""
    args: dict[str, Any] = field(default_factory=dict)
    content: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    raw: str = ""

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens


class LLM(Protocol):
    name: str

    def decide(self, messages: list[dict], tool_brief: str) -> LLMResponse: ...


def estimate_tokens(text: str) -> int:
    """没有分词器时的粗略估算：中文约 1.5 字/token，其他约 4 字符/token。

    真实项目请用模型的 tokenizer 或直接读接口返回的 usage（第 14 章）。
    """
    if not text:
        return 0
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    return int(cjk / 1.5 + (len(text) - cjk) / 4) + 1


def parse_decision(raw: str) -> LLMResponse:
    """把模型输出解析成结构化决策。

    工程上必须容错：模型经常在 JSON 外裹一层解释性文字或代码块，
    直接 json.loads 会失败（第 3 章「结构化输出能力」）。
    """
    text = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    if not text.startswith("{"):
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end + 1]

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return LLMResponse(action="final_answer", content=raw, raw=raw)

    action = str(data.get("action", "final_answer"))
    if action not in {"tool_call", "final_answer", "ask_user"}:
        action = "final_answer"

    return LLMResponse(
        thought=str(data.get("thought", "")),
        action=action,
        tool=str(data.get("tool", "") or ""),
        args=dict(data.get("args") or {}),
        content=str(data.get("content", "") or ""),
        raw=raw,
    )


# ---------------------------------------------------------------------------
# 真实模型：任意 OpenAI 兼容接口（只用标准库，无需 pip install）
# ---------------------------------------------------------------------------


class OpenAICompatLLM:
    """通过 HTTP 调用 OpenAI 兼容的 /chat/completions 接口。"""

    name = "openai-compatible"

    def __init__(self, settings: Settings) -> None:
        self.s = settings

    def decide(self, messages: list[dict], tool_brief: str) -> LLMResponse:
        payload = {
            "model": self.s.model,
            "temperature": self.s.temperature,          # Agent 场景要可复现（第 3 章）
            "response_format": {"type": "json_object"},  # 结构化输出
            "messages": self._to_api_messages(messages, tool_brief),
        }
        req = urllib.request.Request(
            f"{self.s.base_url.rstrip('/')}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.s.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.s.request_timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"模型接口返回 HTTP {e.code}：{detail}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"无法连接模型接口（{self.s.base_url}）：{e.reason}") from e

        try:
            content = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"模型返回结构异常：{json.dumps(data, ensure_ascii=False)[:400]}") from e

        usage = data.get("usage") or {}
        res = parse_decision(content)
        res.raw = content
        res.input_tokens = int(usage.get("prompt_tokens") or estimate_tokens(json.dumps(messages, ensure_ascii=False)))
        res.output_tokens = int(usage.get("completion_tokens") or estimate_tokens(content))
        return res

    @staticmethod
    def _to_api_messages(messages: list[dict], tool_brief: str) -> list[dict]:
        out = []
        for m in messages:
            role = m["role"]
            if role == "system":
                out.append({"role": "system", "content": m["content"]})
            elif role == "user":
                out.append({"role": "user", "content": m["content"]})
            elif role == "assistant":
                out.append({"role": "assistant", "content": m["content"]})
            elif role == "tool":
                # 真实项目应改用原生 function calling 的 tool 角色消息（第 8 章）。
                # 这里统一转成 user 消息，以兼容只支持基础对话的模型。
                out.append({"role": "user", "content": f"[工具返回] {m['content']}"})
        out.append({"role": "system", "content": f"[可用工具]\n{tool_brief}"})
        return out


# ---------------------------------------------------------------------------
# 离线 Mock：没有 API Key 时用它把整条链路跑通
# ---------------------------------------------------------------------------


class MockLLM:
    """规则实现的模拟模型。

    它用关键词与消息历史模拟「模型大概会怎么决策」，好让你在**不花一分钱**的前提下
    观察完整的循环、工具调用、护栏与 Trace。

    它不具备泛化能力，换个问法就可能失灵 —— 这是 Mock 的固有局限。
    真实效果必须用真模型验证（第 14 章：用 Mock 测流程，用真模型测效果）。
    """

    name = "mock-rule-based"

    ORDER_RE = re.compile(r"(ORD-\d{8}-\d{4}|[A-Za-z]{2,4}\d{6,})", re.I)
    SHORT_ORDER_RE = re.compile(r"(?:\.{2,}|订单号?|尾号)\s*(\d{4})\b")

    REFUND_WORDS = ("退款", "退钱", "申请退", "帮我退", "要退")
    ORDER_WORDS = ("订单", "物流", "到哪", "发货", "签收", "快递", "运单")
    LOGISTICS_WORDS = ("物流", "到哪", "发货", "快递", "运单", "配送")
    POLICY_WORDS = ("政策", "规则", "期限", "几天", "多少天", "运费", "发票", "保修", "条件", "怎么退", "能退吗", "多久")
    HANDOFF_WORDS = ("转人工", "人工客服", "投诉", "律师", "起诉")

    def __init__(self, settings: Settings) -> None:
        self.s = settings

    # -- 对外接口 --------------------------------------------------------
    def decide(self, messages: list[dict], tool_brief: str) -> LLMResponse:
        prompt_tokens = estimate_tokens(json.dumps(messages, ensure_ascii=False) + tool_brief)
        res = self._decide(messages)
        res.input_tokens = prompt_tokens
        res.output_tokens = estimate_tokens(json.dumps(
            {"thought": res.thought, "tool": res.tool, "content": res.content}, ensure_ascii=False))
        return res

    # -- 决策主体 --------------------------------------------------------
    def _decide(self, messages: list[dict]) -> LLMResponse:
        goal = self._goal(messages)
        called = self._called_tools(messages)
        facts = self._facts(messages)
        order_id = self._resolve_order_id(messages, facts)

        # ① 明确要求人工
        if any(w in goal for w in self.HANDOFF_WORDS):
            return self._tool("transfer_to_human", reason="用户明确要求人工介入",
                              context_summary=goal,
                              thought="用户提到人工或投诉，按规则直接转人工")

        # ② 退款申请：先查订单 → 再核政策 → 最后提交（写操作）
        if any(w in goal for w in self.REFUND_WORDS):
            if order_id and "get_order" not in called:
                return self._tool("get_order", order_id=order_id,
                                  thought="用户要申请退款，先确认订单状态与签收时间")
            if "search_knowledge_base" not in called:
                return self._tool("search_knowledge_base", query="退货 期限 质量 运费 退款时效", top_k=3,
                                  thought="需要先核对退货政策与退款时效")
            if order_id and "request_refund" not in called:
                return self._tool("request_refund", order_id=order_id, reason="用户申请退款",
                                  thought="订单与政策都已确认，提交退款申请（写操作，需人工确认）")
            return self._final(self._compose(messages, "退款申请已提交，等待审核"))

        # ③ 订单 / 物流查询（提到订单号，或出现订单/物流相关词就走这条）
        if any(w in goal for w in self.ORDER_WORDS):
            if not order_id and "get_order" not in called:
                return self._ask("请问是哪一笔订单？把订单号发我（例如 ORD-20260828-0417）就能帮你查。",
                                 thought="用户提到订单但没给订单号，不能猜")
            if order_id and ("get_order" not in called or any(w in goal for w in self.LOGISTICS_WORDS)):
                if "get_order" not in called:
                    return self._tool("get_order", order_id=order_id,
                                      thought="先确认订单状态，再决定查物流还是政策")
                if "get_logistics" not in called:
                    return self._tool("get_logistics", order_id=order_id,
                                      thought="订单已确认，拉取物流轨迹")
            if "search_knowledge_base" not in called and any(w in goal for w in ("退", "换", "期限", "运费")):
                return self._tool("search_knowledge_base", query="退货 期限 质量", top_k=3,
                                  thought="结合订单信息核对相关政策")
            # 需要算天数：交给 calculator，不心算（第 3 章）
            signed = facts.get("signed_at")
            if signed and "calculator" not in called:
                return self._tool("calculator", expr=f"days_between('{signed}', '{self.s.today}')",
                                  thought="计算签收至今的天数，判断是否还在期限内")
            return self._final(self._compose(messages, None))

        # ④ 政策咨询
        if any(w in goal for w in self.POLICY_WORDS):
            if "search_knowledge_base" not in called:
                return self._tool("search_knowledge_base", query=self._query_from(goal), top_k=3,
                                  thought="这是政策类问题，必须先查知识库再回答")
            return self._final(self._compose(messages, None))

        # ⑤ 兜底：不猜
        return self._ask("我需要更多信息才能帮你。可以告诉我订单号，或者你想咨询的具体问题吗？",
                         thought="信息不足，按规则先澄清而不是猜测")

    # -- 构造响应 --------------------------------------------------------
    def _tool(self, tool: str, thought: str, **args: Any) -> LLMResponse:
        return LLMResponse(thought=thought, action="tool_call", tool=tool, args=args)

    def _final(self, content: str) -> LLMResponse:
        return LLMResponse(thought="信息已足够，可以给出结论", action="final_answer", content=content)

    def _ask(self, content: str, thought: str = "") -> LLMResponse:
        return LLMResponse(thought=thought, action="ask_user", content=content)

    # -- 从消息里读状态 --------------------------------------------------
    @staticmethod
    def _goal(messages: list[dict]) -> str:
        for m in reversed(messages):
            if m["role"] == "user" and not m["content"].startswith("[工具返回]"):
                return m["content"]
        return ""

    @staticmethod
    def _called_tools(messages: list[dict]) -> set[str]:
        called = set()
        for m in messages:
            if m["role"] != "assistant":
                continue
            try:
                data = json.loads(m["content"])
            except (json.JSONDecodeError, TypeError):
                continue
            if data.get("action") == "tool_call" and data.get("tool"):
                called.add(data["tool"])
        return called

    @staticmethod
    def _facts(messages: list[dict]) -> dict:
        """把工具返回拼成一个扁平的事实表，供 Mock 做判断。"""
        facts: dict[str, Any] = {}
        for m in messages:
            if m["role"] != "tool":
                continue
            try:
                data = json.loads(m["content"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(data, dict):
                facts.update({k: v for k, v in data.items() if k not in ("chunks",)})
        return facts

    def _resolve_order_id(self, messages: list[dict], facts: dict) -> str:
        if facts.get("order_id"):
            return str(facts["order_id"])
        for m in reversed(messages):
            if m["role"] != "user":
                continue
            hit = self.ORDER_RE.search(m["content"])
            if hit:
                return hit.group(1).upper()
            short = self.SHORT_ORDER_RE.search(m["content"])
            if short:
                return short.group(1)
        return ""

    @staticmethod
    def _query_from(goal: str) -> str:
        """从问题里抽检索关键词。真实项目里这一步由模型完成（第 13 章「查询改写」）。"""
        stop = ("请问", "一下", "怎么", "怎么样", "吗", "呢", "的", "是", "可以", "能不能", "多少")
        q = goal
        for s in stop:
            q = q.replace(s, " ")
        return " ".join(q.split())[:40] or goal[:40]

    # -- 组织答案 --------------------------------------------------------
    def _compose(self, messages: list[dict], extra: str | None) -> str:
        """把观察到的证据拼成一段回答。

        注意：这里只是**模板拼装**，不是模型生成。它演示的是「结论 + 带编号引用」的
        输出形态（第 13 章「引用可溯源」），真实回答由模型基于同样的证据生成。
        """
        kb: list[dict] = []
        order: dict | None = None
        calc = None
        for m in messages:
            if m["role"] != "tool":
                continue
            try:
                data = json.loads(m["content"])
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(data, dict) and data.get("chunks"):
                kb = data["chunks"]
            elif isinstance(data, dict) and data.get("order_id"):
                order = data
            elif isinstance(data, dict) and "result" in data:
                calc = data["result"]

        parts: list[str] = []

        if order:
            seg = (f"订单 {order['order_id']}（{order.get('item')}，{order.get('amount')} 元）"
                   f"当前状态为「{order.get('status')}」")
            if order.get("signed_at"):
                seg += f"，签收于 {order['signed_at']}"
            parts.append(seg + "。")

        if calc is not None:
            parts.append(f"签收至今已 {calc} 天。")

        if kb:
            leads = []
            for c in kb[:2]:
                lead = self._lead_line(c["text"])
                if lead:
                    leads.append(f"{lead} [{c['id']}]")
            parts.append("相关政策：" + "；".join(leads) + "。" if leads else "资料中未涵盖该问题，建议转人工确认。")
        else:
            parts.append("资料中未涵盖该问题，建议转人工确认。")

        if extra:
            parts.append(extra + "。")
        parts.append("需要我帮你转人工进一步处理吗？")
        return " ".join(parts)

    @staticmethod
    def _lead_line(text: str) -> str:
        """从块内容里挑一句最有信息量的话。

        要跳过标题行、空行、以及「适用条件：」这类纯标签行 —— 它们不含信息。
        """
        for line in text.split("\n"):
            s = line.strip()
            if not s or s.startswith("【") or s.endswith(("：", ":")):
                continue
            return s.lstrip("-•*0123456789. ").strip()
        return ""
