"""三道护栏：输入 / 动作 / 输出。

对应正文：第 15 章（安全护栏）。

设计立场：**默认拒绝（fail-closed）**。护栏本身出错时宁可拦下，也不放行。
所有拦截都要留痕（交给 trace 记录），否则线上出了问题无从复盘。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .config import Settings

# 说明：这里的注入特征只是演示。正则只能挡住低级攻击，
# 真正的防护要靠「外部内容标记为数据 + 动作双人确认 + 最小权限」三板斧（第 15 章）。

_INJECTION_PATTERNS = [
    r"忽略.{0,8}(之前|以上|前面|先前|所有).{0,8}(指令|规则|设定|提示|要求)",
    r"ignore\s+(all\s+)?(previous|above|prior)\s+instructions",
    # 「打印提示词」的语序不固定，两个方向都要覆盖
    r"(打印|输出|显示|重复|复述|发给我|告诉我|贴出来).{0,10}(系统提示词|系统提示|提示词|prompt|预设指令)",
    r"(系统提示词|系统提示|提示词|prompt).{0,10}(打印|输出|显示|重复|复述|发给我|贴出来|是什么)",
    r"(你现在是|假装你是|扮演).{0,6}(没有|不受|无须).{0,6}(限制|约束)",
    r"(开发者模式|调试模式|dan\s*模式|越狱模式)",
    r"repeat\s+(your\s+)?(system\s+)?prompt",
]

_BULK_PATTERNS = [
    r"所有(用户|客户|会员)的",
    r"全部(用户|客户|会员)",
    r"(导出|下载|列出|拉取).{0,8}(全部|所有|全量)",
    r"(手机号|身份证|银行卡|邮箱)列表",
]

_HIGH_RISK_WORDS = ("清空", "删除", "drop", "truncate", "批量", "群发", "转账")

_PII_PATTERNS = [
    (re.compile(r"(?<!\d)(\d{17}[\dXx])(?!\d)"), lambda m: m.group(1)[:4] + "*" * 11 + m.group(1)[-3:]),
    (re.compile(r"(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)"), lambda m: f"{m.group(1)}****{m.group(3)}"),
    (re.compile(r"(?<!\d)(\d{16,19})(?!\d)"), lambda m: m.group(1)[:4] + "*" * (len(m.group(1)) - 7) + m.group(1)[-3:]),
]

_INTERNAL_TERMS = ("analytics_readonly", "orders 表", "生产库", "SELECT ")


@dataclass
class GuardResult:
    allowed: bool
    rule: str = ""
    message: str = ""              # 给用户看的话术
    masked: str = ""               # 输出脱敏后的文本


@dataclass
class Guard:
    settings: Settings
    events: list[dict] = field(default_factory=list)

    # -- 输入护栏 --------------------------------------------------------
    def check_input(self, text: str) -> GuardResult:
        for pat in _INJECTION_PATTERNS:
            if re.search(pat, text, re.I):
                return self._block("injection_detected", text,
                                   "我不能执行这类指令。如果你有具体的订单或售后问题，我很乐意帮你处理。")

        for pat in _BULK_PATTERNS:
            if re.search(pat, text, re.I):
                return self._block("bulk_export_attempt", text,
                                   "出于隐私保护，我不能查询或导出他人的信息。如果你需要自己的订单数据，我可以帮你查。")

        if any(w in text for w in _HIGH_RISK_WORDS) and self.settings.user_role != "admin":
            return self._block("high_risk_intent", text,
                               "这个操作风险较高，我无法直接执行。可以帮你转人工，由人工核实后处理。")

        return GuardResult(allowed=True)

    # -- 动作护栏 --------------------------------------------------------
    def check_action(self, tool: str, resource: str, action: str, args: dict) -> GuardResult:
        """权限判断必须基于「用户 + 资源 + 动作」三维组合，任何一维缺失都会留漏洞。"""
        user = self.settings.user_id

        if tool == "get_order" or tool == "request_refund" or tool == "get_logistics":
            order_id = str(args.get("order_id", ""))
            # 归属校验交给工具内部做（工具能拿到完整订单对象），
            # 这里先挡掉明显的越权表达
            if not order_id:
                return GuardResult(allowed=False, rule="missing_resource",
                                   message="缺少订单号，无法确认数据归属。")

        if action == "write" and self.settings.user_role != "admin":
            # 高危动作一律转审批，不让模型自己决定（fail-closed）
            return GuardResult(allowed=False, rule="require_approval",
                               message=f"「{tool}」属于写操作，需要人工确认后才能继续。")

        self.events.append({"kind": "action_checked", "tool": tool, "resource": resource,
                            "action": action, "user": user})
        return GuardResult(allowed=True)

    # -- 输出护栏 --------------------------------------------------------
    def sanitize_output(self, text: str) -> GuardResult:
        masked = text
        hit = False
        for pat, repl in _PII_PATTERNS:
            masked, n = pat.subn(repl, masked)
            hit = hit or n > 0
        for term in _INTERNAL_TERMS:
            if term in masked:
                masked = masked.replace(term, "内部系统")
                hit = True
        if hit:
            self.events.append({"kind": "output_masked"})
        return GuardResult(allowed=True, rule="output_masked" if hit else "", masked=masked)

    # -- 内部 ------------------------------------------------------------
    def _block(self, rule: str, raw: str, message: str) -> GuardResult:
        # 审计只存摘要，不存原文（隐私考虑）
        self.events.append({"kind": "input_blocked", "rule": rule, "digest": str(hash(raw))[:12]})
        return GuardResult(allowed=False, rule=rule, message=message)
