"""调用链记录。

对应正文：第 14 章（可观测性）。

必须记录的字段一个都不能少，否则线上出问题时无法定位：
goal / 每步决策 / tokens / 耗时 / 错误 / prompt 版本。
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import estimate_cost


@dataclass
class Step:
    index: int
    kind: str                       # llm_call | tool_call | guard | human
    name: str = ""
    thought: str = ""
    args: dict[str, Any] = field(default_factory=dict)
    ok: bool = True
    result_digest: str = ""
    error: str = ""
    latency_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    prompt_hash: str = ""

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v not in ("", {}, 0, None) or k in ("index", "kind", "ok")}


@dataclass
class Trace:
    run_id: str
    goal: str
    user_id: str
    prompt_hash: str = ""
    model: str = ""
    started_at: float = field(default_factory=time.time)
    ended_at: float = 0.0
    steps: list[Step] = field(default_factory=list)
    status: str = "running"         # completed | failed | blocked | timeout | budget_exceeded
    final_answer: str = ""
    save_dir: Path | None = None    # 由主循环注入，决定 Trace 落到哪里

    # -- 记录 ------------------------------------------------------------
    def add(self, kind: str, **kw: Any) -> Step:
        step = Step(index=len(self.steps) + 1, kind=kind, **kw)
        self.steps.append(step)
        return step

    def bump(self, step: Step, latency_ms: int, **kw: Any) -> None:
        step.latency_ms = latency_ms
        for k, v in kw.items():
            setattr(step, k, v)

    # -- 汇总 ------------------------------------------------------------
    @property
    def llm_calls(self) -> int:
        return sum(1 for s in self.steps if s.kind == "llm_call")

    @property
    def tool_calls(self) -> int:
        return sum(1 for s in self.steps if s.kind == "tool_call")

    @property
    def input_tokens(self) -> int:
        return sum(s.input_tokens for s in self.steps)

    @property
    def output_tokens(self) -> int:
        return sum(s.output_tokens for s in self.steps)

    @property
    def elapsed(self) -> float:
        return (self.ended_at or time.time()) - self.started_at

    @property
    def cost(self) -> float:
        return estimate_cost(self.input_tokens, self.output_tokens)

    def summary(self) -> str:
        return (f"本次任务：{self.tool_calls} 次工具调用 · {self.llm_calls} 次模型调用 · "
                f"约 {self.input_tokens + self.output_tokens:,} tokens · "
                f"${self.cost:.4f} · {self.elapsed:.1f}s")

    def to_dict(self) -> dict:
        return {
            "run_id": self.run_id,
            "user_id": self.user_id,
            "goal": self.goal,
            "status": self.status,
            "model": self.model,
            "prompt_hash": self.prompt_hash,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "elapsed_s": round(self.elapsed, 3),
            "llm_calls": self.llm_calls,
            "tool_calls": self.tool_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": round(self.cost, 6),
            "final_answer": self.final_answer,
            "steps": [s.to_dict() for s in self.steps],
        }

    def save(self, directory: Path | None = None) -> Path | None:
        target = directory or self.save_dir
        if target is None:
            return None
        target.mkdir(parents=True, exist_ok=True)
        path = target / f"{self.run_id}.json"
        path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        return path


def hash_prompt(text: str) -> str:
    """提示词指纹。没有它，就无法回答「这次效果变差是不是因为改了提示词」。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def digest(value: Any, limit: int = 60) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = text.replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + "…"
