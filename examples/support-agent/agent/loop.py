"""主循环：感知 → 规划 → 行动 → 反思。

对应正文：第 5 章（主循环与四道终止闸门）、第 9 章（上下文组装）、第 15 章（预算护栏）。

四道闸门缺一不可：
  目标达成 / 步数上限 / token 上限 / 时间上限
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any, Callable

from .config import Budget, Settings
from .guard import Guard
from .llm import LLM, LLMResponse
from .memory import LongTermMemory, SessionMemory
from .runtime import Runtime
from .store import DataStore
from .tools import tool_brief
from .trace import Trace, hash_prompt


def create_runtime(goal: str, settings: Settings, approve=None,
                   store: DataStore | None = None) -> Runtime:
    """组装一次运行所需的全部组件。

    依赖是显式注入的（而不是到处 import 全局单例），测试与真实运行可以用同一套代码，
    只是替换其中的 store 或 approve 回调（第 14 章：可测性是设计出来的）。
    """
    settings.ensure_dirs()
    trace = Trace(run_id=f"run_{int(time.time() * 1000):x}", goal=goal, user_id=settings.user_id)
    trace.save_dir = settings.state_dir / "traces"
    return Runtime(
        settings=settings,
        store=store or DataStore(settings),
        guard=Guard(settings),
        session=SessionMemory(goal=goal),
        ltm=LongTermMemory(settings.state_dir / "longterm.json"),
        trace=trace,
        approve=approve,
    )


@dataclass
class AgentResult:
    ok: bool
    status: str                 # completed | need_clarification | budget_exceeded | failed
    answer: str
    trace: Trace
    reason: str = ""            # 未完成时的原因

    def __str__(self) -> str:
        return self.answer


def _fingerprint(res: LLMResponse) -> str:
    raw = json.dumps([res.tool, res.args], sort_keys=True, ensure_ascii=False)
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


def _summarize_observation(tool: str, payload: str) -> str:
    """把工具结果压成一条「事实」，写入会话记忆。

    只保留有工具结果支撑的结论 —— 模型的推测绝不进 facts（第 7 章）。
    """
    try:
        data = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return f"{tool} 返回：{payload[:120]}"

    if isinstance(data, dict) and data.get("chunks"):
        ids = "、".join(c["id"] for c in data["chunks"][:3])
        return f"知识库命中：{ids}"
    if isinstance(data, dict) and data.get("order_id"):
        return f"订单 {data['order_id']}：{data.get('status')}，签收 {data.get('signed_at') or '未签收'}"
    if isinstance(data, dict) and "result" in data:
        return f"计算 {data.get('expr')} = {data['result']}"
    if isinstance(data, dict) and data.get("request_id"):
        return f"退款申请 {data['request_id']}（{data.get('status')}）"
    if isinstance(data, dict) and data.get("ticket_id"):
        return f"已转人工，工单 {data['ticket_id']}"
    return f"{tool} 执行完成"


def check_budget(trace: Trace, budget: Budget, steps: int) -> str:
    if steps >= budget.max_steps:
        return f"已达到最大步数（{budget.max_steps}）"
    if trace.tool_calls >= budget.max_tool_calls:
        return f"已达到最大工具调用次数（{budget.max_tool_calls}）"
    if trace.input_tokens + trace.output_tokens >= budget.max_tokens:
        return f"已超出 token 预算（{budget.max_tokens:,}）"
    if trace.elapsed >= budget.max_seconds:
        return f"已超出时间预算（{budget.max_seconds:.0f}s）"
    return ""


def run_agent(goal: str, llm: LLM, settings: Settings, runtime: Runtime | None = None,
              budget: Budget | None = None, save_trace: bool = True,
              on_event: Callable[[str, dict], None] | None = None) -> AgentResult:
    """对外入口。`on_event` 把过程实时吐给调用方（CLI / 日志 / Tracing 平台）。

    观测回调抛错不能影响主流程 —— 这是生产系统的基本要求。
    """
    result = _agent_loop(goal, llm, settings, runtime, budget, save_trace, on_event)
    if on_event:
        try:
            on_event("final", {"ok": result.ok, "status": result.status, "answer": result.answer})
        except Exception:                                      # noqa: BLE001
            pass
    return result


def _agent_loop(goal: str, llm: LLM, settings: Settings, runtime: Runtime | None = None,
                budget: Budget | None = None, save_trace: bool = True,
                on_event: Callable[[str, dict], None] | None = None) -> AgentResult:
    budget = budget or settings.budget
    runtime = runtime or create_runtime(goal, settings)
    session = runtime.session
    trace = runtime.trace
    guard = runtime.guard
    system_prompt = settings.system_prompt()

    def emit(kind: str, **payload: Any) -> None:
        if on_event:
            try:
                on_event(kind, payload)
            except Exception:                                  # noqa: BLE001
                pass

    trace.prompt_hash = hash_prompt(system_prompt)      # 提示词指纹，用于归因（第 14 章）
    trace.model = llm.name

    # ---- 输入护栏：在模型看到之前拦下 ----
    verdict = guard.check_input(goal)
    if not verdict.allowed:
        trace.add("guard", name="input", ok=False, error=verdict.rule)
        emit("guard", rule=verdict.rule, message=verdict.message)
        return _finish(trace, False, "blocked", verdict.message,
                       f"输入被护栏拦截：{verdict.rule}", save_trace)

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    messages.append({"role": "user", "content": goal})

    steps = 0
    repeats = 0
    last_fp = ""

    while True:
        # ---- 反思：预算闸门 ----
        reason = check_budget(trace, budget, steps)
        if reason:
            return _finish(trace, False, "budget_exceeded",
                           f"很抱歉，本次处理没有在预算内完成（{reason}）。"
                           f"已确认的信息：{'；'.join(session.facts) or '暂无'}。"
                           f"建议转人工继续处理。",
                           reason, save_trace)

        # ---- 感知：把目标与事实锚定在上下文末尾（第 9 章位置效应）----
        context_block = session.to_context_block()
        messages.append({"role": "system", "content": context_block})

        # ---- 规划：结构化决策 ----
        started = time.perf_counter()
        try:
            res = llm.decide(messages, tool_brief())
        except RuntimeError as e:
            trace.add("llm_call", ok=False, error=str(e))
            return _finish(trace, False, "failed", f"模型调用失败：{e}", str(e), save_trace)

        latency = int((time.perf_counter() - started) * 1000)
        trace.add("llm_call", name=res.action, thought=res.thought, latency_ms=latency,
                  input_tokens=res.input_tokens, output_tokens=res.output_tokens,
                  result_digest=res.tool or "")
        emit("llm", step=steps + 1, thought=res.thought, action=res.action,
             tool=res.tool, args=res.args, tokens=res.tokens, latency_ms=latency)

        messages.append({"role": "assistant", "content": json.dumps(
            {"thought": res.thought, "action": res.action, "tool": res.tool,
             "args": res.args, "content": res.content}, ensure_ascii=False)})

        # ---- 终止：目标达成 / 需要澄清 ----
        if res.action == "final_answer":
            answer = guard.sanitize_output(res.content).masked       # 输出护栏
            return _finish(trace, True, "completed", answer, "", save_trace)

        if res.action == "ask_user":
            return _finish(trace, True, "need_clarification", res.content, "", save_trace)

        if res.action != "tool_call" or not res.tool:
            messages.append({"role": "user", "content":
                             "[系统提示] 你的输出不符合约定。action 只能是 "
                             "tool_call / final_answer / ask_user，且 tool_call 必须给出 tool 名称。"
                             "请重新输出合法的 JSON。"})
            steps += 1
            continue

        # ---- 无进展检测：原地打转就换策略，再不听就中止 ----
        fp = _fingerprint(res)
        if fp == last_fp:
            repeats += 1
        else:
            repeats = 0
        last_fp = fp

        if repeats >= 1:
            messages.append({"role": "user", "content":
                             "[系统提示] 你已重复执行相同动作且没有获得新信息。"
                             "请改变策略：换工具、换参数，或基于现有信息直接回答。"})
        if repeats >= 2:
            return _finish(trace, False, "failed",
                           f"任务未能完成：连续重复同一动作且无进展。已确认的信息："
                           f"{'；'.join(session.facts) or '暂无'}。建议转人工处理。",
                           "no_progress", save_trace)

        # ---- 行动：唯一的执行入口，内部完成校验/权限/审批/审计 ----
        ok, payload = runtime.execute(res.tool, res.args)
        messages.append({"role": "tool", "content": payload})
        emit("tool", step=steps + 1, name=res.tool, ok=ok, payload=payload)

        if ok:
            fact = _summarize_observation(res.tool, payload)
            session.add_fact(fact)
            session.done.append(res.tool)
            # 指代消解结果写进会话记忆，避免下一轮重新追问（第 16 章）
            if res.tool == "get_order":
                try:
                    oid = json.loads(payload).get("order_id")
                    if oid:
                        session.resolve("该订单", oid)
                except (json.JSONDecodeError, TypeError):
                    pass
        steps += 1


def _finish(trace: Trace, ok: bool, status: str, answer: str, reason: str,
            save: bool) -> AgentResult:
    trace.status = status
    trace.ended_at = time.time()
    trace.final_answer = answer
    if save and trace.save_dir:
        try:
            trace.save()
        except OSError:
            pass
    return AgentResult(ok=ok, status=status, answer=answer, trace=trace, reason=reason)
