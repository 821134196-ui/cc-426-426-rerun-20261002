"""领域常量、错误类型与纯函数工具。"""
from __future__ import annotations

from dataclasses import dataclass

# ---- 状态枚举 -----------------------------------------------------------

# 商品资料审核状态
REVIEW_PENDING = "pending"        # 待审核
REVIEW_APPROVED = "approved"      # 资料通过（可排品）
REVIEW_REJECTED = "rejected"      # 资料驳回
REVIEW_REVOKED = "revoked"        # 通过后被撤销（缺货 / 违规 / 样品不符 / 临时撤品）

# 脚本版本状态
SCRIPT_DRAFT = "draft"
SCRIPT_SUBMITTED = "submitted"    # 送审
SCRIPT_APPROVED = "approved"
SCRIPT_REJECTED = "rejected"

# 挂链 / 上下架状态
LINK_DRAFT = "draft"
LINK_LIVE = "live"               # 已上架
LINK_TAKEN_DOWN = "taken_down"   # 已下架（撤品等）
LINK_DEAD = "dead"               # 链接失效

# 场次状态
SESSION_PLANNING = "planning"    # 编排中（草稿可覆盖）
SESSION_PUBLISHED = "published"  # 已发布（快照冻结）
SESSION_LIVE = "live"            # 已开始（继续使用发布快照）
SESSION_ENDED = "ended"

# 排品项异常处理类型
ISSUE_NONE = "none"
ISSUE_OOS = "oos"                # 商品缺货
ISSUE_PRICE = "price"            # 价格变更
ISSUE_DEAD_LINK = "dead_link"    # 链接失效
ISSUE_SAMPLE = "sample"          # 样品不符
ISSUE_VIOLATION = "violation"    # 违规词
ISSUE_WITHDRAW = "withdraw"      # 临时撤品

# 审核记录动作
ACT_MATERIAL_SUBMIT = "material_submit"
ACT_MATERIAL_APPROVE = "material_approve"
ACT_MATERIAL_REJECT = "material_reject"
ACT_SCRIPT_SUBMIT = "script_submit"
ACT_SCRIPT_APPROVE = "script_approve"
ACT_SCRIPT_REJECT = "script_reject"
ACT_PUBLISH = "publish"
ACT_WITHDRAW = "withdraw"
ACT_PUBLISH_RECEIPT = "publish_receipt"

# 回调事件
CB_ONLINE = "online"
CB_OFFLINE = "offline"

# ---- 违规词 -------------------------------------------------------------
# 演示用广告法违禁/极限词表
BANNED_WORDS = [
    "最", "第一", "国家级", "顶级", "极品", "万能", "绝对", "100%",
    "特效", "根治", "包治", "秒杀全网", "史低", "零风险",
]


@dataclass(frozen=True)
class ViolationHit:
    word: str
    index: int


def scan_banned_words(text: str) -> list[ViolationHit]:
    """扫描违规词，返回全部命中（按位置排序）。"""
    hits: list[ViolationHit] = []
    for w in BANNED_WORDS:
        start = 0
        while True:
            i = text.find(w, start)
            if i < 0:
                break
            hits.append(ViolationHit(w, i))
            start = i + len(w)
    hits.sort(key=lambda h: h.index)
    return hits


# ---- 错误 ---------------------------------------------------------------

class DomainError(Exception):
    """业务规则错误，message 可直接展示给用户。"""

    def __init__(self, message: str, code: str = "domain_error"):
        super().__init__(message)
        self.code = code


class NotFound(DomainError):
    def __init__(self, what: str):
        super().__init__(f"{what}不存在", "not_found")


class ConflictState(DomainError):
    def __init__(self, message: str):
        super().__init__(message, "conflict_state")


class ValidationFailed(DomainError):
    def __init__(self, message: str):
        super().__init__(message, "validation_failed")


class PermissionDenied(DomainError):
    def __init__(self, message: str = "无权执行该操作"):
        super().__init__(message, "permission_denied")
