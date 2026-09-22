"""知识库：切分与检索。

对应正文：第 13 章（RAG）、第 16 章（客服知识库设计）。

刻意做的两件事：
1. **切分时把标题路径拼进块内容** —— 检索时能拿到更多上下文，召回准确率明显更高。
2. **强制时效过滤** —— 召回失效版本比召回不到更危险。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Chunk:
    id: str
    title: str
    version: str
    effective_from: str
    effective_to: str          # "" 表示仍然有效
    text: str                  # 含标题路径的完整块内容
    score: float = 0.0         # 检索打分，仅用于展示

    def is_valid_on(self, today: str) -> bool:
        if self.effective_from and self.effective_from > today:
            return False
        if self.effective_to and self.effective_to < today:
            return False
        return True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "version": self.version,
            "text": self.text,
            "score": self.score,
        }


# ---------------------------------------------------------------------------
# 切分
# ---------------------------------------------------------------------------

_META_RE = re.compile(r"版本\s*(?P<v>[^\s·]+)\s*·\s*生效\s*(?P<f>[^\s·]+)\s*·\s*失效\s*(?P<t>[^\s·]+)")
_HEAD_RE = re.compile(r"^##\s+(?P<id>[A-Z]+-[A-Z]+-\d+)\s*·\s*(?P<title>.+)$")


def load_chunks(path: Path) -> list[Chunk]:
    """把知识库 Markdown 切成块。

    结构约定：每个 `## KB-XXX-NNN · 标题` 是一块，紧随其后的 `> 版本 … 生效 … 失效 …`
    提供时效元数据。真实项目可换成 Markdown 解析库或直接读向量库。
    """
    text = path.read_text(encoding="utf-8")
    chunks: list[Chunk] = []
    current: dict | None = None
    buffer: list[str] = []

    def flush() -> None:
        if not current:
            return
        body = "\n".join(buffer).strip()
        # 【标题路径】让块自带上下文，检索时更准
        full = f"【{current['id']} · {current['title']}】\n{body}"
        chunks.append(Chunk(
            id=current["id"], title=current["title"],
            version=current.get("version", "-"),
            effective_from=current.get("effective_from", ""),
            effective_to=current.get("effective_to", ""),
            text=full,
        ))

    for line in text.splitlines():
        head = _HEAD_RE.match(line.strip())
        if head:
            flush()
            current = {"id": head.group("id"), "title": head.group("title").strip()}
            buffer = []
            continue
        if current is not None:
            meta = _META_RE.search(line)
            # 元数据行允许前面有空行，但一旦出现过正文就不再认它（避免误匹配正文里的「版本…生效…」）
            if meta and not any(seg.strip() for seg in buffer):
                current["version"] = meta.group("v")
                current["effective_from"] = meta.group("f")
                invalid = meta.group("t")
                current["effective_to"] = "" if invalid in ("—", "-", "无", "至今") else invalid
                continue
            buffer.append(line)
    flush()
    return chunks


# ---------------------------------------------------------------------------
# 检索
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"[a-z0-9]{2,}")


def _terms(text: str) -> set[str]:
    """把文本拆成检索项：英文词 + 中文二元组。

    这是最朴素的倒排式打分，没有语义能力。真实项目应换成嵌入模型 + 向量库，
    并叠加混合检索与重排（第 13 章）。
    """
    lowered = text.lower()
    terms = set(_TOKEN_RE.findall(lowered))
    cjk = "".join(re.findall(r"[\u4e00-\u9fff]", lowered))
    terms.update(cjk[i:i + 2] for i in range(len(cjk) - 1))
    return terms


def search(chunks: list[Chunk], query: str, top_k: int = 3, today: str = "9999-12-31") -> list[Chunk]:
    """按关键词命中打分并返回 Top-K（已做时效过滤）。"""
    valid = [c for c in chunks if c.is_valid_on(today)]
    if not query.strip():
        return []

    q_terms = _terms(query)
    if not q_terms:
        return []

    scored: list[tuple[float, Chunk]] = []
    for chunk in valid:
        title_terms = _terms(chunk.title)
        body = chunk.text.lower()
        score = 0.0
        for t in q_terms:
            if t in title_terms:
                score += 3.0          # 标题命中权重更高
            elif t in body:
                score += 1.0
        if score > 0:
            # 轻微惩罚过长的块，避免它靠"字多"刷分
            score /= (1 + len(chunk.text) / 2000)
            scored.append((score, chunk))

    scored.sort(key=lambda x: (-x[0], x[1].id))
    top = scored[:max(1, top_k)]

    # 把分数带回对象，便于在结果里展示
    for s, c in top:
        c.score = round(s, 3)
    return [c for _, c in top]
