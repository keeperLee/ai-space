"""配置与预算。

对应正文：第 5 章（终止条件）、第 15 章（预算护栏）、第 20 章（成本控制）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Budget:
    """四道终止闸门里的三道（目标达成由主循环判断）。

    缺任何一个都会留下失控的口子：只有步数上限，长文本工具一次就能烧掉全部预算；
    只有 token 上限，便宜但无用的调用可以无限循环。
    """

    max_steps: int = 10
    max_tokens: int = 24_000
    max_seconds: float = 60.0
    max_tool_calls: int = 12


@dataclass(frozen=True)
class Settings:
    # ---- 模型 ----
    model: str = field(default_factory=lambda: os.getenv("OPENAI_MODEL", "gpt-4o-mini"))
    base_url: str = field(default_factory=lambda: os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", "").strip())
    temperature: float = 0.0          # Agent 场景要的是可复现，不是多样性（第 3 章）
    request_timeout: float = 60.0

    # ---- 预算 ----
    budget: Budget = field(default_factory=Budget)

    # ---- 路径 ----
    data_dir: Path = ROOT / "data"
    prompts_dir: Path = ROOT / "prompts"
    state_dir: Path = ROOT / "data" / "state"

    # ---- 运行身份（真实系统里来自登录态）----
    user_id: str = "u_1024"
    user_name: str = "张明"
    user_role: str = "employee"       # employee | manager | admin

    # ---- 业务时间基准 ----
    # 工具里的日期计算以此为「今天」。显式注入而不是直接读系统时间，
    # 是为了让测试可复现（第 14 章：评估必须可重复）。
    today: str = field(default_factory=lambda: os.getenv("AGENT_TODAY") or date.today().isoformat())

    @property
    def use_mock(self) -> bool:
        """没有 API Key 时自动回落到离线 MockLLM。"""
        return not self.api_key

    def ensure_dirs(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def system_prompt(self) -> str:
        """系统提示词存在独立文件里，便于版本化与 A/B（第 9、14 章）。"""
        return (self.prompts_dir / "system.txt").read_text(encoding="utf-8")


SETTINGS = Settings()


# 单价仅用于演示成本核算的算法，不是真实报价。
# 真实项目请把价目表做成配置，并在 Trace 里记录 prompt 版本以便归因（第 14 章）。
PRICE_PER_1K = {"input": 0.00015, "output": 0.0006}


def estimate_cost(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens / 1000) * PRICE_PER_1K["input"] + (output_tokens / 1000) * PRICE_PER_1K["output"]
