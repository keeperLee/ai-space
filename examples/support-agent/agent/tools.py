"""工具定义与实现。

对应正文：第 8 章（工具调用）。

三条纪律：
1. **描述要写清「何时用 / 何时不要用」** —— 这是减少工具误用最有效的手段。
2. **工具内部必须再校验一次权限** —— 不能只靠提示词说「只能查自己的订单」。
3. **错误信息要能教学** —— 告诉模型下一步该怎么做，而不是抛异常栈。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:                       # 只为类型标注，避免与 runtime 形成循环导入
    from .runtime import Runtime


class ToolError(Exception):
    """工具执行失败。message 会被翻译成模型能理解的提示，而不是异常栈。"""


@dataclass
class ToolSpec:
    name: str
    description: str
    params: dict[str, str]
    required: list[str]
    fn: Callable[..., Any]
    side_effect: bool = False           # 有副作用 → 运行时据此决定是否走审批
    resource: str = "general"           # 权限判断的资源域
    action: str = "read"                # read | write


TOOLS: dict[str, ToolSpec] = {}


def tool(name: str, description: str, params: dict[str, str], required: list[str],
         side_effect: bool = False, resource: str = "general", action: str = "read"):
    def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
        TOOLS[name] = ToolSpec(name=name, description=description, params=params,
                               required=required, fn=fn, side_effect=side_effect,
                               resource=resource, action=action)
        return fn
    return deco


def tool_brief() -> str:
    """生成给模型看的工具说明。写得好不好，直接决定选得对不对。"""
    lines = []
    for t in TOOLS.values():
        ps = "；".join(f"{k}（{v}）" for k, v in t.params.items())
        mark = "【写操作，需人工确认】" if t.side_effect else ""
        lines.append(f"- {t.name}{mark}：{t.description}\n  参数：{ps}")
    return "\n".join(lines)


# ===========================================================================
# 只读工具
# ===========================================================================


@tool(
    "search_knowledge_base",
    "在客服知识库中检索政策与规则类文档片段。适用于查询退换货政策、期限、运费、退款时效、"
    "物流时效、发票、保修等规则问题，返回带编号 [KB-XXX-NNN] 的原文片段。"
    "不适用于查询具体订单状态或物流进度——那类问题请使用 get_order / get_logistics。",
    {"query": "检索关键词，建议用名词短语，例如 '退货 期限 运费'；不要写成问句",
     "top_k": "返回条数，默认 3，取值 1~5"},
    required=["query"],
    resource="knowledge", action="read",
)
def search_knowledge_base(ctx: "Runtime", query: str, top_k: int = 3) -> dict:
    if not str(query).strip():
        raise ToolError("query 不能为空。请提供检索关键词，例如 '退货 期限'。")
    try:
        top_k = int(top_k)
    except (TypeError, ValueError):
        raise ToolError(f"top_k 必须是整数，你提供的是 {top_k!r}。请传 1~5 之间的整数。")
    if not 1 <= top_k <= 5:
        raise ToolError(f"top_k 必须在 1~5 之间，你提供的是 {top_k}。请修正后重试。")

    chunks = ctx.store.search_kb(query, top_k=top_k)
    if not chunks:
        # 错误信息里给出「下一步该怎么做」，这是模型能自我修复的关键（第 8 章）
        chunks = ctx.store.search_kb(query[:4], top_k=top_k)      # 放宽一次条件
        if not chunks:
            return {"chunks": [], "hint": "未检索到相关内容。建议换用更宽泛的关键词，"
                                          "或调用 transfer_to_human 转人工确认。"}
    return {"chunks": [c.to_dict() for c in chunks]}


@tool(
    "get_order",
    "查询订单详情（商品、金额、状态、签收时间、是否在可退期限内）。"
    "返回的数据属于当前登录用户本人，工具内部已做归属校验。"
    "需要订单号；用户只记得尾号时可以传 4 位尾号。",
    {"order_id": "订单号，格式 ORD-YYYYMMDD-NNNN；或 4 位数字尾号"},
    required=["order_id"],
    resource="order", action="read",
)
def get_order(ctx: "Runtime", order_id: str) -> dict:
    key = str(order_id).strip()
    if not key:
        raise ToolError("order_id 不能为空。请向用户确认订单号，或使用 4 位尾号。")
    if not re.fullmatch(r"(ORD-\d{8}-\d{4}|[A-Za-z]{0,4}\d{4})", key, re.I):
        raise ToolError(f"订单号格式不正确：{key!r}。正确格式形如 ORD-20260828-0417，"
                        f"或直接提供 4 位尾号（如 0417）。")

    order = ctx.store.get_order(key) or ctx.store.find_order_by_suffix(key)
    if not order:
        raise ToolError(f"未找到订单 {key}。请确认订单号是否正确；"
                        f"如果用户不确定，可以请其到「我的订单」页面核对。")

    # 归属校验必须在工具内部做，不能只依赖提示词（第 15 章）
    if order["user_id"] != ctx.settings.user_id:
        raise ToolError("该订单不属于当前登录用户，无法查询。"
                        "如果用户认为订单归属有误，建议调用 transfer_to_human 转人工核实。")

    # 只把模型需要的字段返回，内部字段不外泄
    order = {k: v for k, v in order.items() if k != "user_id"}
    return order


@tool(
    "get_logistics",
    "查询订单的物流轨迹。需要先知道订单号；只看物流不要用它查政策。",
    {"order_id": "订单号，格式 ORD-YYYYMMDD-NNNN；或 4 位数字尾号"},
    required=["order_id"],
    resource="order", action="read",
)
def get_logistics(ctx: "Runtime", order_id: str) -> dict:
    order = get_order(ctx, order_id)                 # 复用归属校验，避免两处逻辑不一致
    tracking = order.get("tracking_no") or ""
    if not tracking:
        raise ToolError(f"订单 {order['order_id']} 暂无物流单号，可能还未发货。"
                        f"可以先告知用户当前订单状态为「{order.get('status')}」。")
    traces = ctx.store.get_logistics(tracking)
    if not traces:
        return {"order_id": order["order_id"], "tracking_no": tracking, "traces": [],
                "hint": "暂无物流轨迹。若超过 72 小时无更新，可引导用户申请物流异常核查。"}
    return {"order_id": order["order_id"], "carrier": order.get("carrier"),
            "tracking_no": tracking, "traces": traces}


@tool(
    "calculator",
    "执行确定性计算。凡是涉及数字或日期的运算都必须使用本工具，禁止心算。"
    "支持数学表达式，以及 days_between('日期A','日期B') 计算相隔天数。",
    {"expr": "数学表达式（如 '(500+100)*5*3'），或 days_between('2026-08-30','2026-09-20')"},
    required=["expr"],
    resource="calc", action="read",
)
def calculator(ctx: "Runtime", expr: str) -> dict:
    expr = str(expr).strip()

    m = re.fullmatch(r"days_between\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)", expr)
    if m:
        try:
            a = date.fromisoformat(m.group(1))
            b = date.fromisoformat(m.group(2))
        except ValueError:
            raise ToolError(f"日期格式必须是 YYYY-MM-DD，你提供的是 {m.group(1)!r} 与 {m.group(2)!r}。")
        return {"expr": expr, "result": abs((b - a).days), "unit": "天"}

    if not re.fullmatch(r"[-+*/(). \d]+", expr):
        raise ToolError("表达式含非法字符。只允许数字与 + - * / ( )，"
                        "或使用 days_between('YYYY-MM-DD','YYYY-MM-DD')。")
    try:
        value = eval(expr, {"__builtins__": {}}, {})          # 已限制字符集
    except ZeroDivisionError:
        raise ToolError("除数不能为 0，请检查表达式。")
    except Exception as e:                                     # noqa: BLE001
        raise ToolError(f"表达式无法求值（{e}）。请检查括号与运算符是否配对。")
    return {"expr": expr, "result": value}


# ===========================================================================
# 写操作（需要人工确认）
# ===========================================================================


@tool(
    "request_refund",
    "为订单提交退款申请。这是写操作，会创建一条退款工单，"
    "调用前必须已确认订单状态与退货政策，且已向用户复述并得到确认。"
    "同一订单同一天重复调用不会重复创建（幂等）。",
    {"order_id": "订单号，格式 ORD-YYYYMMDD-NNNN",
     "reason": "退款原因，用一句话说明"},
    required=["order_id", "reason"],
    side_effect=True, resource="order", action="write",
)
def request_refund(ctx: "Runtime", order_id: str, reason: str) -> dict:
    order = get_order(ctx, order_id)                    # 复用校验与归属检查

    # 幂等保护：重试或用户重复点击都不能产生两条工单（第 8 章）
    key = f"{ctx.settings.user_id}:{order['order_id']}:{ctx.settings.today}"
    existing = ctx.store.has_refund_request(key)
    if existing:
        return {"status": "already_submitted", "request_id": existing["request_id"],
                "note": "同一订单当天已提交过退款申请，本次未重复创建。"}

    request = ctx.store.add_refund_request({
        "request_id": f"RF{ctx.settings.today.replace('-', '')}{len(ctx.store.refund_requests) + 1:03d}",
        "idempotency_key": key,
        "order_id": order["order_id"],
        "user_id": ctx.settings.user_id,
        "reason": str(reason)[:200],
        "amount": order.get("amount"),
        "status": "待审核",
    })
    return {"status": "submitted", "request_id": request["request_id"],
            "amount": request["amount"], "expected": "入库质检通过后 3 个工作日内原路退回"}


@tool(
    "transfer_to_human",
    "把会话转交人工客服，并附上已收集的上下文。"
    "在用户情绪激烈、涉及金额超过 1000 元、提到投诉或法律、明确要求人工、"
    "或连续两轮无法推进时调用。",
    {"reason": "转人工的原因（一句话）",
     "context_summary": "已收集到的关键信息，供人工快速接手"},
    required=["reason", "context_summary"],
    side_effect=True, resource="handoff", action="write",
)
def transfer_to_human(ctx: "Runtime", reason: str, context_summary: str) -> dict:
    ticket = {
        "ticket_id": f"T{ctx.settings.today.replace('-', '')}{len(ctx.store.refund_requests) + 1:03d}",
        "reason": str(reason)[:200],
        "context": str(context_summary)[:500],
        "user": ctx.settings.user_id,
    }
    ctx.transfer_ticket = ticket
    return {"status": "transferred", **ticket,
            "note": "已创建工单，用户会在 1 个工作日内收到人工联系。"}
