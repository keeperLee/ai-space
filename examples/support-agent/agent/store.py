"""数据访问层：订单、物流、退款申请、知识库。

真实项目里这一层背后是数据库或内部 API；这里用本地 JSON 模拟，接口保持一致。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .config import Settings
from .knowledge import Chunk, load_chunks, search


class DataStore:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self._orders_raw: dict[str, Any] = json.loads(
            (settings.data_dir / "orders.json").read_text(encoding="utf-8"))
        self.chunks: list[Chunk] = load_chunks(settings.data_dir / "knowledge.md")
        # 写操作的结果落盘，这样跨进程重启也能验证幂等（真实项目落库）
        self._refund_path = settings.state_dir / "refund_requests.json"
        self.refund_requests: list[dict] = self._load_refunds()

    def _load_refunds(self) -> list[dict]:
        if self._refund_path.exists():
            try:
                return json.loads(self._refund_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        return list(self._orders_raw.get("refund_requests", []))

    # -- 订单 ------------------------------------------------------------
    def get_order(self, order_id: str) -> dict | None:
        for o in self._orders_raw["orders"]:
            if o["order_id"].lower() == order_id.strip().lower():
                return dict(o)
        return None

    def find_order_by_suffix(self, suffix: str) -> dict | None:
        """支持用户只报尾号 4 位（真实客服场景非常常见）。"""
        hits = [o for o in self._orders_raw["orders"] if o["order_id"].endswith(suffix)]
        return dict(hits[0]) if len(hits) == 1 else None

    def orders_of(self, user_id: str) -> list[dict]:
        return [dict(o) for o in self._orders_raw["orders"] if o["user_id"] == user_id]

    # -- 物流 ------------------------------------------------------------
    def get_logistics(self, tracking_no: str) -> list[dict]:
        return list(self._orders_raw["logistics"].get(tracking_no, []))

    # -- 知识库 ----------------------------------------------------------
    def search_kb(self, query: str, top_k: int = 3) -> list[Chunk]:
        return search(self.chunks, query, top_k=top_k, today=self.s.today)

    # -- 写操作 ----------------------------------------------------------
    def add_refund_request(self, request: dict) -> dict:
        self.refund_requests.append(request)
        self._refund_path.parent.mkdir(parents=True, exist_ok=True)
        self._refund_path.write_text(
            json.dumps(self.refund_requests, ensure_ascii=False, indent=2), encoding="utf-8")
        return request

    def has_refund_request(self, idempotency_key: str) -> dict | None:
        for r in self.refund_requests:
            if r.get("idempotency_key") == idempotency_key:
                return r
        return None
