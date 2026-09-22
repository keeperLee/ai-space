"""记忆：会话记忆（结构化状态）+ 长期记忆（用户偏好）。

对应正文：第 7 章（记忆机制）、第 9 章（上下文压缩）。

关键设计：**会话记忆存的是结构化状态，不是聊天原文**。
50 轮对话原文可能上万 token，结构化状态只要几百 —— 而且不会随对话漂移。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# facts 只接受「有工具结果支撑」的条目；模型自己的推测另放 hypotheses。
# 一旦未经验证的结论混进 facts，后续所有推理都会建立在它之上，且无法自查（第 7 章）。


@dataclass
class SessionMemory:
    goal: str
    facts: list[str] = field(default_factory=list)
    hypotheses: list[str] = field(default_factory=list)
    resolved_refs: dict[str, str] = field(default_factory=dict)   # 指代消解结果
    done: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)

    def add_fact(self, text: str) -> None:
        if text and text not in self.facts:
            self.facts.append(text)

    def resolve(self, phrase: str, value: str) -> None:
        """把「我这个」「那单」这类指代绑定到具体对象。

        不做这件事，后续每一轮都要重新追问用户（第 16 章的常见坑）。
        """
        self.resolved_refs[phrase] = value

    def to_context_block(self, max_facts: int = 8) -> str:
        """压成一小段文本注入上下文，放在靠后位置以利用位置效应（第 3、9 章）。"""
        lines = [f"【原始目标】{self.goal}"]
        if self.facts:
            lines.append("【已确认事实】" + "；".join(self.facts[-max_facts:]))
        if self.resolved_refs:
            lines.append("【指代指向】" + "；".join(f"{k} = {v}" for k, v in self.resolved_refs.items()))
        if self.open_questions:
            lines.append("【待解决】" + "；".join(self.open_questions))
        return "\n".join(lines)


@dataclass
class LongTermMemory:
    """跨会话的用户偏好。

    真实的写入策略应该更谨慎（什么时候写、写什么、怎么遗忘，见第 7 章），
    这里只演示最小可用版本：显式表达 + 去重 + 追加而非覆盖。
    """

    path: Path

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

    def recall(self, user_id: str, limit: int = 5) -> list[str]:
        items = self._load().get(user_id, [])
        return [it["text"] for it in items[-limit:]]

    def remember(self, user_id: str, text: str, source: str = "user") -> bool:
        data = self._load()
        items = data.setdefault(user_id, [])
        if any(it["text"] == text for it in items):
            return False
        items.append({"text": text, "source": source})
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return True
