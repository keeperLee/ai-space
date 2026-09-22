"""执行环境（Runtime）。

对应正文：第 10 章（执行环境是 Agent 从脚本走向系统的标志）、第 15 章（动作护栏）。

所有「脏活」都收在这里，主循环因此可以保持干净：
schema 校验 → 权限校验 → 人工审批 → 调用 → 错误翻译 → 审计留痕。

**模型给的参数永远不可信，这里是唯一拦截点。**
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import Settings
from .guard import Guard
from .memory import LongTermMemory, SessionMemory
from .store import DataStore
from .tools import TOOLS, ToolError
from .trace import Trace, digest


@dataclass
class Runtime:
    settings: Settings
    store: DataStore
    guard: Guard
    session: SessionMemory
    ltm: LongTermMemory
    trace: Trace

    # 人工审批回调：返回 True 表示批准执行写操作。
    # 生产环境应接审批工单系统；这里交互式 CLI 会直接问用户，测试里注入桩函数。
    approve: Callable[[str, dict[str, Any]], bool] | None = None
    transfer_ticket: dict[str, Any] | None = None
    audit: list[dict[str, Any]] = field(default_factory=list)

    # -- 对外：唯一的执行入口 --------------------------------------------
    def execute(self, tool_name: str, args: dict[str, Any]) -> tuple[bool, str]:
        started = time.perf_counter()

        # ① 工具是否存在
        spec = TOOLS.get(tool_name)
        if spec is None:
            return self._fail(tool_name, args, started,
                              f"[工具错误] 不存在名为 {tool_name} 的工具。"
                              f"可用工具：{', '.join(TOOLS)}。请从中选择。")

        # ② 参数校验（类型与范围由工具自己再查一遍）
        problem = self._validate_args(spec, args)
        if problem:
            return self._fail(tool_name, args, started, problem)

        # ③ 动作护栏：权限 + 高危动作审批
        verdict = self.guard.check_action(spec.name, spec.resource, spec.action, args)
        if not verdict.allowed:
            if verdict.rule == "require_approval":
                approved = bool(self.approve and self.approve(spec.name, args))
                self._audit("approval", tool=spec.name, approved=approved, args=args)
                if not approved:
                    return self._fail(
                        tool_name, args, started,
                        f"[待人工确认] 「{spec.name}」是写操作，当前未获得人工批准，因此没有执行。"
                        f"请向用户说明需要人工确认，或改用只读方式先提供信息。",
                        rule=verdict.rule)
            else:
                self._audit("action_blocked", tool=spec.name, rule=verdict.rule, args=args)
                return self._fail(tool_name, args, started,
                                  f"[动作被拦截] {verdict.message} 请向用户说明原因，不要重试。",
                                  rule=verdict.rule)

        # ④ 执行
        try:
            result = spec.fn(self, **args)
            payload = json.dumps(result, ensure_ascii=False) if not isinstance(result, str) else result
            self._step(tool_name, args, started, ok=True, result=result)
            return True, payload
        except ToolError as e:
            # 工具主动抛出的「可教学错误」——原样回灌给模型，它据此自我修正
            return self._fail(tool_name, args, started, f"[工具错误] {e}")
        except Exception as e:                                    # noqa: BLE001
            # 未预期的异常不能把堆栈丢给模型，但要写进 Trace 供人排查
            self._audit("tool_crash", tool=spec.name, error=repr(e))
            return self._fail(tool_name, args, started,
                              f"[工具异常] 执行 {spec.name} 时发生内部错误，"
                              f"请改用其他方式获取信息，并向用户说明暂时无法完成。")

    # -- 内部 ------------------------------------------------------------
    def _validate_args(self, spec, args: dict[str, Any]) -> str:
        if not isinstance(args, dict):
            return f"[参数错误] args 必须是对象，你提供的是 {type(args).__name__}。"
        missing = [k for k in spec.required if k not in args or args[k] in (None, "")]
        if missing:
            return (f"[参数错误] 缺少必需参数 {missing}。{spec.name} 的参数要求："
                    f"{spec.params}。请补齐后重试。")
        unknown = [k for k in args if k not in spec.params]
        if unknown:
            return (f"[参数错误] 出现未知参数 {unknown}。{spec.name} 只接受 "
                    f"{list(spec.params)}，请去掉多余字段后重试。")
        return ""

    def _fail(self, tool_name: str, args: dict, started: float, message: str, rule: str = "") -> tuple[bool, str]:
        self._step(tool_name, args, started, ok=False, error=message, rule=rule)
        return False, message

    def _step(self, tool_name: str, args: dict, started: float, *,
              ok: bool, result: Any = None, error: str = "", rule: str = "") -> None:
        latency = int((time.perf_counter() - started) * 1000)
        self.trace.add(
            "tool_call", name=tool_name, args=args, ok=ok,
            latency_ms=latency,
            result_digest=digest(result) if ok else "",
            error=error if not ok else "",
            prompt_hash=rule if rule else "",
        )

    def _audit(self, kind: str, **kw: Any) -> None:
        self.audit.append({"kind": kind, "at": time.time(), **kw})
