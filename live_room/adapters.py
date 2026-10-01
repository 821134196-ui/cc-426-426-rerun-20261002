"""进程内模拟适配器。

* ProductCatalog —— 演示商品、主播、实时价格、库存、挂链健康（不持久化，重启复位）。
* ReceiptAdapter —— 商品 / 审核发布回执，进程内保存。
真实环境中这些应替换为商品中心、交易平台与消息回执的 HTTP/RPC 客户端。
"""
from __future__ import annotations

import itertools
import threading
from dataclasses import dataclass, field, asdict
from typing import Optional

from .db import now


@dataclass
class DemoProduct:
    id: int
    name: str
    image: str                 # /static/img/...
    category: str
    base_price: float          # 基准价（演示）
    current_price: float       # 平台实时价（可能被改价）
    stock: int                 # 实时库存，0 = 缺货
    link_url: str
    link_ok: bool = True       # 挂链是否有效（可被置为失效）
    # 资料完备性：资料审核要检查的字段
    material_complete: bool = True


@dataclass
class DemoAnchor:
    id: int
    name: str
    account: str


@dataclass
class PublishReceipt:
    receipt_no: str
    session_id: int
    channel: str               # 回执通道（模拟）
    ok: bool
    detail: dict
    created_at: str
    returned_at: Optional[str] = None   # 平台回执返回时间


class ProductCatalog:
    """进程内商品 / 主播 / 价格模拟。线程安全单例式使用。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._products: dict[int, DemoProduct] = {}
        self._anchors: dict[int, DemoAnchor] = {}
        self._reset_demo_data()

    def _reset_demo_data(self) -> None:
        anchors = [
            DemoAnchor(1, "珊瑚小晚", "wanwan@demo"),
            DemoAnchor(2, "石墨阿诚", "acheng@demo"),
            DemoAnchor(3, "奶油可颂", "kesong@demo"),
        ]
        products = [
            DemoProduct(1, "珊瑚绒居家袜 3 双装", "/static/img/p1.svg", "服饰",
                        39.9, 39.9, 320, "https://demo.shop/item/1001"),
            DemoProduct(2, "石墨黑保温杯 500ml", "/static/img/p2.svg", "家居",
                        89.0, 89.0, 150, "https://demo.shop/item/1002"),
            DemoProduct(3, "奶油白香薰蜡烛", "/static/img/p3.svg", "家居",
                        69.0, 69.0, 0, "https://demo.shop/item/1003"),  # 演示缺货
            DemoProduct(4, "珊瑚色陶瓷马克杯", "/static/img/p4.svg", "餐厨",
                        49.0, 49.0, 210, "https://demo.shop/item/1004"),
            DemoProduct(5, "速干运动毛巾", "/static/img/p5.svg", "运动",
                        29.9, 29.9, 480, "https://demo.shop/item/1005"),
            DemoProduct(6, "折叠收纳箱 大号", "/static/img/p6.svg", "家居",
                        59.0, 59.0, 96, "https://demo.shop/item/1006",
                        link_ok=False),  # 演示链接失效
            DemoProduct(7, "暖手宝充电迷你款", "/static/img/p7.svg", "数码",
                99.0, 99.0, 60, "https://demo.shop/item/1007"),
            DemoProduct(8, "资料待补：保暖围巾", "/static/img/p8.svg", "服饰",
                        79.0, 79.0, 130, "https://demo.shop/item/1008",
                        material_complete=False),  # 演示资料不全，审核应驳回
        ]
        self._anchors = {a.id: a for a in anchors}
        self._products = {p.id: p for p in products}

    # ---- 商品 ----
    def get(self, product_id: int) -> DemoProduct:
        with self._lock:
            if product_id not in self._products:
                raise KeyError(product_id)
            return self._products[product_id]

    def list_products(self) -> list[DemoProduct]:
        with self._lock:
            return list(self._products.values())

    def list_anchors(self) -> list[DemoAnchor]:
        with self._lock:
            return list(self._anchors.values())

    def get_anchor(self, anchor_id: int) -> DemoAnchor:
        with self._lock:
            if anchor_id not in self._anchors:
                raise KeyError(anchor_id)
            return self._anchors[anchor_id]

    # ---- 运营干预：改价 / 缺货 / 补货 / 链接失效恢复 ----
    def change_price(self, product_id: int, new_price: float) -> DemoProduct:
        with self._lock:
            p = self.get(product_id)
            p.current_price = round(float(new_price), 2)
            return p

    def set_stock(self, product_id: int, stock: int) -> DemoProduct:
        with self._lock:
            p = self.get(product_id)
            p.stock = max(0, int(stock))
            return p

    def set_link_ok(self, product_id: int, ok: bool) -> DemoProduct:
        with self._lock:
            p = self.get(product_id)
            p.link_ok = ok
            return p

    def as_dict(self, product_id: int) -> dict:
        return asdict(self.get(product_id))


class ReceiptAdapter:
    """发布 / 审核回执的进程内模拟适配器。"""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._lock = threading.RLock()
        self._seq = itertools.count(1)
        self._receipts: list[PublishReceipt] = []

    def send(
        self, session_id: int, detail: dict, ok: bool = True,
        channel: str = "demo-trade-gateway",
    ) -> PublishReceipt:
        with self._lock:
            no = f"RCP-{session_id:04d}-{next(self._seq):05d}"
            r = PublishReceipt(
                receipt_no=no, session_id=session_id, channel=channel,
                ok=ok, detail=detail, created_at=now(),
            )
            self._receipts.append(r)
            return r

    def ack(self, receipt_no: str) -> PublishReceipt | None:
        """模拟平台异步返回回执。"""
        with self._lock:
            for r in self._receipts:
                if r.receipt_no == receipt_no:
                    r.returned_at = now()
                    return r
        return None

    def list_for_session(self, session_id: int) -> list[PublishReceipt]:
        with self._lock:
            return [r for r in self._receipts if r.session_id == session_id]

    def all(self) -> list[PublishReceipt]:
        with self._lock:
            return list(self._receipts)


# 进程内单例（演示与本地服务共用；测试可自行 new）
catalog = ProductCatalog()
receipts = ReceiptAdapter()
