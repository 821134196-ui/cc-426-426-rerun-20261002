"""核心领域服务：审核、脚本版本、场次排品、挂链、样品、回调、发布快照。

设计要点：
* 商品 / 主播 / 实时价来自进程内适配器 ``catalog``；脚本与版本等存 SQLite。
* 场次 ``planning`` 可编排；``publish`` 冻结整场快照；``live`` 后脚本草稿
  仍可继续生成新版本，但场次继续读取发布快照，草稿无法覆盖。
* 挂链整场唯一；发布前校验价格 / 库存 / 链接健康 / 脚本审核 / 异常项。
* 回调以 event_id 幂等、seq 判乱序；重复回调不重复上下架、不改已成交订单。
"""
from __future__ import annotations

import json
import os
import sqlite3
from typing import Any, Optional

from . import domain as D
from .adapters import ProductCatalog, ReceiptAdapter
from .db import insert, now, query_all, query_one, transaction

PRICE_TOLERANCE = 0.01


class LiveRoomService:
    def __init__(
        self,
        conn: sqlite3.Connection,
        catalog: ProductCatalog,
        receipts: ReceiptAdapter,
        sample_dir: str,
    ):
        self.conn = conn
        self.catalog = catalog
        self.receipts = receipts
        self.sample_dir = sample_dir
        os.makedirs(sample_dir, exist_ok=True)

    # ================================================================
    # 基础工具
    # ================================================================
    def log(self, action: str, ref_type: str, ref_id: Any, operator: str, detail: dict | None = None) -> None:
        insert(
            self.conn,
            "INSERT INTO audit_logs(action, ref_type, ref_id, operator, detail, created_at)"
            " VALUES(?,?,?,?,?,?)",
            (action, ref_type, ref_id, operator, json.dumps(detail or {}, ensure_ascii=False), now()),
        )

    def _session(self, session_id: int) -> sqlite3.Row:
        row = query_one(self.conn, "SELECT * FROM sessions WHERE id=?", (session_id,))
        if row is None:
            raise D.NotFound(f"场次 {session_id}")
        return row

    def _item(self, item_id: int) -> sqlite3.Row:
        row = query_one(self.conn, "SELECT * FROM session_items WHERE id=?", (item_id,))
        if row is None:
            raise D.NotFound(f"排品项 {item_id}")
        return row

    def _require_status(self, session_id: int, *statuses: str) -> sqlite3.Row:
        s = self._session(session_id)
        if s["status"] not in statuses:
            raise D.ConflictState(f"场次当前为「{s['status']}」，该操作要求状态：{ '、'.join(statuses) }")
        return s

    def _promo(self, code: str) -> sqlite3.Row:
        row = query_one(self.conn, "SELECT * FROM promos WHERE code=?", (code,))
        if row is None:
            raise D.ValidationFailed(f"优惠版本 {code} 不存在")
        return row

    # ================================================================
    # 商品资料审核（必须通过才能排品）
    # ================================================================
    def material_status(self, product_id: int) -> dict | None:
        row = query_one(
            self.conn,
            "SELECT * FROM material_reviews WHERE product_id=? ORDER BY id DESC LIMIT 1",
            (product_id,),
        )
        return dict(row) if row else None

    def submit_material(self, product_id: int, operator: str) -> dict:
        self.catalog.get(product_id)  # 商品存在性
        cur = self.material_status(product_id)
        if cur and cur["status"] in (D.REVIEW_PENDING, D.REVIEW_APPROVED):
            raise D.ConflictState(f"商品资料当前为「{cur['status']}」，无需重复提交")
        rid = insert(
            self.conn,
            "INSERT INTO material_reviews(product_id, status, submitted_by, created_at)"
            " VALUES(?,?,?,?)",
            (product_id, D.REVIEW_PENDING, operator, now()),
        )
        self.log(D.ACT_MATERIAL_SUBMIT, "product", product_id, operator, {"review_id": rid})
        self.conn.commit()
        return self.material_status(product_id)  # type: ignore[return-value]

    def approve_material(self, product_id: int, reviewer: str) -> dict:
        cur = self.material_status(product_id)
        if not cur or cur["status"] != D.REVIEW_PENDING:
            raise D.ConflictState("商品资料不在待审核状态")
        product = self.catalog.get(product_id)
        if not product.material_complete:
            raise D.ValidationFailed("商品资料不完整（缺少规格/资质图），不能通过")
        self.conn.execute(
            "UPDATE material_reviews SET status=?, reviewer=?, reviewed_at=? WHERE id=?",
            (D.REVIEW_APPROVED, reviewer, now(), cur["id"]),
        )
        self.log(D.ACT_MATERIAL_APPROVE, "product", product_id, reviewer, {"review_id": cur["id"]})
        self.conn.commit()
        receipt = self.receipts.send(
            session_id=0,
            detail={"type": "material_review", "product_id": product_id, "result": "approved",
                    "reviewer": reviewer},
        )
        self.log(D.ACT_PUBLISH_RECEIPT, "product", product_id, reviewer,
                 {"receipt_no": receipt.receipt_no, "channel": receipt.channel})
        self.conn.commit()
        return self.material_status(product_id)  # type: ignore[return-value]

    def reject_material(self, product_id: int, reviewer: str, reason: str) -> dict:
        if not reason.strip():
            raise D.ValidationFailed("驳回必须填写原因")
        cur = self.material_status(product_id)
        if not cur or cur["status"] != D.REVIEW_PENDING:
            raise D.ConflictState("商品资料不在待审核状态")
        self.conn.execute(
            "UPDATE material_reviews SET status=?, reviewer=?, reason=?, reviewed_at=? WHERE id=?",
            (D.REVIEW_REJECTED, reviewer, reason, now(), cur["id"]),
        )
        self.log(D.ACT_MATERIAL_REJECT, "product", product_id, reviewer,
                 {"review_id": cur["id"], "reason": reason})
        self.conn.commit()
        receipt = self.receipts.send(
            session_id=0,
            detail={"type": "material_review", "product_id": product_id, "result": "rejected",
                    "reviewer": reviewer, "reason": reason},
            ok=False,
        )
        self.log(D.ACT_PUBLISH_RECEIPT, "product", product_id, reviewer,
                 {"receipt_no": receipt.receipt_no})
        self.conn.commit()
        return self.material_status(product_id)  # type: ignore[return-value]

    def _require_approved_material(self, product_id: int) -> None:
        m = self.material_status(product_id)
        if not m or m["status"] != D.REVIEW_APPROVED:
            raise D.ValidationFailed(f"商品 {product_id} 尚未通过资料审核，不能加入排品")

    # ================================================================
    # 场次
    # ================================================================
    def create_session(self, title: str, anchor_id: int, starts_at: str, operator: str) -> int:
        self.catalog.get_anchor(anchor_id)
        if not title.strip():
            raise D.ValidationFailed("场标题不能为空")
        sid = insert(
            self.conn,
            "INSERT INTO sessions(title, anchor_id, starts_at, status, created_at)"
            " VALUES(?,?,?,?,?)",
            (title.strip(), anchor_id, starts_at, D.SESSION_PLANNING, now()),
        )
        self.log("session_create", "session", sid, operator, {"title": title})
        self.conn.commit()
        return sid

    def list_sessions(self) -> list[dict]:
        rows = query_all(
            self.conn,
            """SELECT s.*, a.name AS anchor_name FROM sessions s
               JOIN anchors a ON a.id = s.anchor_id ORDER BY s.id DESC""",
        )
        return [dict(r) for r in rows]

    # ================================================================
    # 排品（仅 planning 可改）
    # ================================================================
    def add_item(
        self, session_id: int, product_id: int, duration_sec: int,
        stock_alert: int, promo_code: str, operator: str,
    ) -> int:
        self._require_status(session_id, D.SESSION_PLANNING)
        self._require_approved_material(product_id)
        self._promo(promo_code)
        if duration_sec <= 0:
            raise D.ValidationFailed("讲解时长必须大于 0")
        if stock_alert < 0:
            raise D.ValidationFailed("库存提示阈值不能为负")
        dup = query_one(
            self.conn,
            "SELECT 1 FROM session_items WHERE session_id=? AND product_id=? AND withdrawn=0",
            (session_id, product_id),
        )
        if dup:
            raise D.ConflictState(f"商品 {product_id} 已在本场排品中")
        pos_row = query_one(
            self.conn,
            "SELECT COALESCE(MAX(position),0)+1 AS p FROM session_items WHERE session_id=?",
            (session_id,),
        )
        iid = insert(
            self.conn,
            """INSERT INTO session_items
               (session_id, product_id, position, duration_sec, stock_alert, promo_version, created_at)
               VALUES(?,?,?,?,?,?,?)""",
            (session_id, product_id, pos_row["p"], int(duration_sec), int(stock_alert),
             promo_code, now()),
        )
        self.log("item_add", "item", iid, operator,
                 {"session_id": session_id, "product_id": product_id, "position": pos_row["p"]})
        self.conn.commit()
        return iid

    def update_item(self, item_id: int, operator: str, **fields: Any) -> None:
        item = self._item(item_id)
        self._require_status(item["session_id"], D.SESSION_PLANNING)
        allowed = {"duration_sec", "stock_alert", "promo_version"}
        sets, params = [], []
        for k, v in fields.items():
            if k not in allowed or v is None:
                continue
            if k == "promo_version":
                self._promo(str(v))
            if k in ("duration_sec", "stock_alert") and int(v) <= 0 and k == "duration_sec":
                raise D.ValidationFailed("讲解时长必须大于 0")
            sets.append(f"{k}=?")
            params.append(v)
        if not sets:
            return
        params.extend([item_id])
        self.conn.execute(f"UPDATE session_items SET {', '.join(sets)} WHERE id=?", params)
        self.log("item_update", "item", item_id, operator, fields)
        self.conn.commit()

    def reorder_items(self, session_id: int, ordered_item_ids: list[int], operator: str) -> None:
        self._require_status(session_id, D.SESSION_PLANNING)
        existing = {r["id"] for r in query_all(
            self.conn, "SELECT id FROM session_items WHERE session_id=?", (session_id,))}
        if set(ordered_item_ids) != existing:
            raise D.ValidationFailed("排序参数必须恰好包含本场全部排品项")
        with transaction(self.conn):
            for pos, iid in enumerate(ordered_item_ids, start=1):
                self.conn.execute(
                    "UPDATE session_items SET position=? WHERE id=? AND session_id=?",
                    (pos, iid, session_id),
                )
            self.log("item_reorder", "session", session_id, operator, {"order": ordered_item_ids})

    def _set_issue(self, item_id: int, issue: str, note: str) -> None:
        self.conn.execute(
            "UPDATE session_items SET issue=?, issue_note=? WHERE id=?",
            (issue, note, item_id),
        )

    def resolve_issue(self, item_id: int, operator: str, note: str = "已处理") -> None:
        item = self._item(item_id)
        if item["withdrawn"]:
            raise D.ConflictState("撤品项不可恢复，请重新排品")
        with transaction(self.conn):
            self._set_issue(item_id, D.ISSUE_NONE, note)
            self.log("issue_resolve", "item", item_id, operator, {"note": note})

    def withdraw_item(self, item_id: int, operator: str, note: str) -> dict:
        """临时撤品：挂链下架（走幂等下架），排品卡保留但置灰。"""
        item = self._item(item_id)
        if item["withdrawn"]:
            raise D.ConflictState("该排品项已撤品")
        if self._session(item["session_id"])["status"] == D.SESSION_ENDED:
            raise D.ConflictState("场次已结束")
        link = query_one(self.conn, "SELECT * FROM links WHERE item_id=?", (item_id,))
        receipt_info: dict = {}
        with transaction(self.conn):
            self.conn.execute(
                "UPDATE session_items SET withdrawn=1, issue=?, issue_note=? WHERE id=?",
                (D.ISSUE_WITHDRAW, note, item_id),
            )
            if link and link["status"] == D.LINK_LIVE:
                # 撤品触发下架，合成幂等事件，不影响已成交订单
                res = self._apply_callback(
                    link["id"], D.CB_OFFLINE, f"wd-{item_id}-{link['id']}", seq=10_000_000 + item_id,
                    operator=operator, force=True,
                )
                receipt_info["offline"] = res
            self.log(D.ACT_WITHDRAW, "item", item_id, operator, {"note": note})
        return {"item_id": item_id, "note": note, **receipt_info}

    # ================================================================
    # 讲解脚本与版本
    # ================================================================
    def _get_script(self, item_id: int) -> sqlite3.Row | None:
        return query_one(self.conn, "SELECT * FROM scripts WHERE item_id=?", (item_id,))

    def _latest_version(self, script_id: int) -> sqlite3.Row:
        row = query_one(
            self.conn,
            "SELECT * FROM script_versions WHERE script_id=? ORDER BY version DESC LIMIT 1",
            (script_id,),
        )
        if row is None:
            raise D.NotFound("脚本版本")
        return row

    def script_overview(self, item_id: int) -> dict:
        item = self._item(item_id)
        sc = self._get_script(item_id)
        if not sc:
            return {"item_id": item_id, "script": None, "versions": []}
        latest = self._latest_version(sc["id"])
        approved = None
        if sc["approved_version"]:
            approved = query_one(
                self.conn, "SELECT * FROM script_versions WHERE script_id=? AND version=?",
                (sc["id"], sc["approved_version"]),
            )
        return {
            "item_id": item_id,
            "script": dict(sc),
            "latest": dict(latest),
            "approved": dict(approved) if approved else None,
            "latest_violations": [h.word for h in D.scan_banned_words(latest["content"])],
            "versions": [dict(v) for v in query_all(
                self.conn,
                "SELECT id, version, status, author, reviewer, review_note, created_at, reviewed_at"
                " FROM script_versions WHERE script_id=? ORDER BY version DESC",
                (sc["id"],))],
            "session_id": item["session_id"],
        }

    def edit_script(self, item_id: int, author: str, content: str, operator: str | None = None) -> dict:
        """修改脚本 → 生成新的草稿版本。作者以首版为准（审核权限依据）。"""
        item = self._item(item_id)
        if item["withdrawn"]:
            raise D.ConflictState("已撤品项不能修改脚本")
        operator = operator or author
        sc = self._get_script(item_id)
        with transaction(self.conn):
            if sc is None:
                sid = insert(
                    self.conn,
                    "INSERT INTO scripts(item_id, current_version, author, created_at)"
                    " VALUES(?,1,?,?)",
                    (item_id, author, now()),
                )
                insert(
                    self.conn,
                    """INSERT INTO script_versions(script_id, version, content, status, author, created_at)
                       VALUES(?,1,?,?,?,?)""",
                    (sid, content, D.SCRIPT_DRAFT, author, now()),
                )
                self.log("script_create", "script", sid, operator, {"item_id": item_id})
            else:
                latest = self._latest_version(sc["id"])
                if latest["status"] == D.SCRIPT_SUBMITTED:
                    raise D.ConflictState("脚本已送审，请等待审核结果后再修改")
                if latest["content"] == content:
                    raise D.ConflictState("内容无变化，未生成新版本")
                new_ver = latest["version"] + 1
                insert(
                    self.conn,
                    """INSERT INTO script_versions(script_id, version, content, status, author, created_at)
                       VALUES(?,?,?,?,?,?)""",
                    (sc["id"], new_ver, content, D.SCRIPT_DRAFT, sc["author"], now()),
                )
                self.conn.execute(
                    "UPDATE scripts SET current_version=? WHERE id=?", (new_ver, sc["id"]))
                sid = sc["id"]
                self.log("script_edit", "script", sid, operator, {"version": new_ver})
        self.conn.commit()
        return self.script_overview(item_id)

    def submit_script(self, item_id: int, operator: str) -> dict:
        sc = self._get_script(item_id)
        if not sc:
            raise D.ConflictState("脚本还未创建")
        latest = self._latest_version(sc["id"])
        if latest["status"] not in (D.SCRIPT_DRAFT, D.SCRIPT_REJECTED):
            raise D.ConflictState(f"当前版本状态为「{latest['status']}」，不能送审")
        hits = D.scan_banned_words(latest["content"])
        with transaction(self.conn):
            self.conn.execute(
                "UPDATE script_versions SET status=? WHERE id=?",
                (D.SCRIPT_SUBMITTED, latest["id"]),
            )
            self.log(D.ACT_SCRIPT_SUBMIT, "script", sc["id"], operator,
                     {"version": latest["version"], "violations": [h.word for h in hits]})
            if hits:
                self._set_issue(item_id, D.ISSUE_VIOLATION,
                                "脚本疑似含违规词：" + "、".join(sorted({h.word for h in hits})))
        self.conn.commit()
        return self.script_overview(item_id)

    def review_script(
        self, item_id: int, reviewer: str, approve: bool, note: str = "",
    ) -> dict:
        """审核脚本。审核人不能是脚本作者；通过时不得含违规词。"""
        item = self._item(item_id)
        sc = self._get_script(item_id)
        if not sc:
            raise D.ConflictState("脚本还未创建")
        latest = self._latest_version(sc["id"])
        if latest["status"] != D.SCRIPT_SUBMITTED:
            raise D.ConflictState("脚本不在待审核状态")
        if reviewer == sc["author"]:
            raise D.PermissionDenied("审核人不能审核自己编写的脚本")
        with transaction(self.conn):
            if approve:
                hits = D.scan_banned_words(latest["content"])
                if hits:
                    raise D.ValidationFailed(
                        "脚本含违规词，不能通过：" + "、".join(sorted({h.word for h in hits})))
                self.conn.execute(
                    "UPDATE script_versions SET status=?, reviewer=?, review_note=?, reviewed_at=?"
                    " WHERE id=?",
                    (D.SCRIPT_APPROVED, reviewer, note, now(), latest["id"]),
                )
                self.conn.execute(
                    "UPDATE scripts SET approved_version=? WHERE id=?",
                    (latest["version"], sc["id"]),
                )
                self.log(D.ACT_SCRIPT_APPROVE, "script", sc["id"], reviewer,
                         {"version": latest["version"]})
                if item["issue"] == D.ISSUE_VIOLATION:
                    self._set_issue(item_id, D.ISSUE_NONE, "违规词已处理，脚本通过")
            else:
                if not note.strip():
                    raise D.ValidationFailed("驳回必须填写意见")
                self.conn.execute(
                    "UPDATE script_versions SET status=?, reviewer=?, review_note=?, reviewed_at=?"
                    " WHERE id=?",
                    (D.SCRIPT_REJECTED, reviewer, note, now(), latest["id"]),
                )
                self.log(D.ACT_SCRIPT_REJECT, "script", sc["id"], reviewer,
                         {"version": latest["version"], "note": note})
        self.conn.commit()
        return self.script_overview(item_id)

    # ================================================================
    # 挂链
    # ================================================================
    def attach_link(self, item_id: int, url: str, listed_price: float | None, operator: str) -> int:
        item = self._item(item_id)
        self._require_status(item["session_id"], D.SESSION_PLANNING)
        url = url.strip()
        if not url:
            raise D.ValidationFailed("挂链 URL 不能为空")
        product = self.catalog.get(item["product_id"])
        price = product.current_price if listed_price is None else float(listed_price)
        # 整场挂链唯一：同场不能重复 URL
        dup = query_one(
            self.conn,
            """SELECT l.id FROM links l
               JOIN session_items i ON i.id = l.item_id
               WHERE i.session_id=? AND l.url=? AND l.item_id<>?""",
            (item["session_id"], url, item_id),
        )
        if dup:
            raise D.ConflictState(f"该挂链已在本场使用（排品项 {dup['id']}），挂链必须唯一")
        existing = query_one(self.conn, "SELECT id FROM links WHERE item_id=?", (item_id,))
        if existing:
            raise D.ConflictState("该排品项已存在挂链")
        with transaction(self.conn):
            lid = insert(
                self.conn,
                """INSERT INTO links(item_id, url, listed_price, status)
                   VALUES(?,?,?,?)""",
                (item_id, url, round(price, 2), D.LINK_DRAFT),
            )
            # 挂链价格必须与平台实时价一致
            if abs(price - product.current_price) > PRICE_TOLERANCE:
                self._set_issue(item_id, D.ISSUE_PRICE,
                                f"挂链价 {price:.2f} 与实时价 {product.current_price:.2f} 不一致")
            self.log("link_attach", "link", lid, operator, {"url": url, "price": price})
        self.conn.commit()
        return lid

    def sync_link_price(self, item_id: int, operator: str) -> dict:
        """价格变更处理：以平台实时价重校挂链价。"""
        item = self._item(item_id)
        product = self.catalog.get(item["product_id"])
        link = query_one(self.conn, "SELECT * FROM links WHERE item_id=?", (item_id,))
        if not link:
            raise D.ValidationFailed("该排品项尚无挂链")
        with transaction(self.conn):
            self.conn.execute(
                "UPDATE links SET listed_price=? WHERE id=?",
                (product.current_price, link["id"]),
            )
            if item["issue"] == D.ISSUE_PRICE:
                self._set_issue(item_id, D.ISSUE_NONE, f"价格已同步为 {product.current_price:.2f}")
            self.log("link_price_sync", "link", link["id"], operator,
                     {"price": product.current_price})
        self.conn.commit()
        return {"item_id": item_id, "listed_price": product.current_price}

    def refresh_issues(self, session_id: int, operator: str = "system") -> list[dict]:
        """对照进程内商品适配器扫描六类异常，分别落标记。返回新发现的问题清单。"""
        self._session(session_id)
        found: list[dict] = []
        alerts: list[dict] = []
        items = query_all(
            self.conn, "SELECT * FROM session_items WHERE session_id=? ORDER BY position",
            (session_id,),
        )
        with transaction(self.conn):
            for item in items:
                if item["withdrawn"]:
                    continue
                product = self.catalog.get(item["product_id"])
                link = query_one(self.conn, "SELECT * FROM links WHERE item_id=?", (item["id"],))

                def mark(kind: str, note: str) -> None:
                    if item["issue"] != kind:
                        self._set_issue(item["id"], kind, note)
                        found.append({"item_id": item["id"], "issue": kind, "note": note})

                # 1) 缺货（0 件阻断并自动下架）/ 低于阈值只做库存提示
                if product.stock <= 0:
                    mark(D.ISSUE_OOS, f"实时库存为 0（提示阈值 {item['stock_alert']}）")
                    if link and link["status"] == D.LINK_LIVE:
                        self._apply_callback(link["id"], D.CB_OFFLINE,
                                             f"oos-{item['id']}", seq=20_000_000 + item["id"],
                                             operator=operator, force=True)
                    continue
                if product.stock <= item["stock_alert"] and item["issue"] != D.ISSUE_OOS:
                    alerts.append({"item_id": item["id"], "kind": "stock_alert",
                                   "note": f"库存 {product.stock}，已低于提示阈值 "
                                           f"{item['stock_alert']}"})
                # 2) 链接失效
                if not product.link_ok:
                    mark(D.ISSUE_DEAD_LINK, "平台返回挂链不可用（404/已下架）")
                    if link and link["status"] == D.LINK_LIVE:
                        self._apply_callback(link["id"], D.CB_OFFLINE,
                                             f"dead-{item['id']}", seq=30_000_000 + item["id"],
                                             operator=operator, force=True)
                    continue
                # 3) 价格变更
                if link and abs(link["listed_price"] - product.current_price) > PRICE_TOLERANCE:
                    mark(D.ISSUE_PRICE,
                         f"挂链价 {link['listed_price']:.2f} 已变更为 {product.current_price:.2f}")
                    continue
                # 4) 样品不符（看该商品最近一条样品登记）
                sample = query_one(
                    self.conn,
                    "SELECT * FROM samples WHERE product_id=? ORDER BY id DESC LIMIT 1",
                    (item["product_id"],),
                )
                if sample and sample["match_status"] == "mismatch":
                    mark(D.ISSUE_SAMPLE, sample["note"] or "样品与商品资料不符")
                    continue
                # 5) 违规词（看待审/最新脚本）
                sc = self._get_script(item["id"])
                if sc:
                    latest = self._latest_version(sc["id"])
                    if D.scan_banned_words(latest["content"]):
                        mark(D.ISSUE_VIOLATION, "讲解脚本含违规词")
                        continue
        self.conn.commit()
        return {"issues": found, "alerts": alerts}

    def check_session_links(self, session_id: int) -> dict:
        """发布前整场挂链校验（也供页面挂链检查面板使用）。"""
        self._session(session_id)
        items = query_all(
            self.conn, "SELECT * FROM session_items WHERE session_id=? ORDER BY position",
            (session_id,),
        )
        errors: list[str] = []
        warnings: list[str] = []
        cards: list[dict] = []
        seen_urls: dict[str, int] = {}
        for item in items:
            if item["withdrawn"]:
                cards.append({"item_id": item["id"], "withdrawn": True, "errors": [],
                              "warnings": []})
                continue
            product = self.catalog.get(item["product_id"])
            link = query_one(self.conn, "SELECT * FROM links WHERE item_id=?", (item["id"],))
            errs: list[str] = []
            warns: list[str] = []
            m = self.material_status(item["product_id"])
            if not m or m["status"] != D.REVIEW_APPROVED:
                errs.append("资料未通过审核")
            if link is None:
                errs.append("缺少挂链")
            else:
                if link["url"] in seen_urls:
                    errs.append(f"挂链与第 {seen_urls[link['url']]} 项重复")
                else:
                    seen_urls[link["url"]] = item["position"]
                if abs(link["listed_price"] - product.current_price) > PRICE_TOLERANCE:
                    errs.append(f"价格不一致：挂链 {link['listed_price']:.2f} / 实时 "
                                f"{product.current_price:.2f}")
                if not product.link_ok:
                    errs.append("挂链已失效")
                if product.stock <= 0:
                    errs.append("商品缺货")
                elif product.stock <= item["stock_alert"]:
                    warns.append(f"库存预警：剩余 {product.stock}（阈值 {item['stock_alert']}）")
            sc = self._get_script(item["id"])
            if not sc or not sc["approved_version"]:
                errs.append("讲解脚本未通过审核")
            if item["issue"] == D.ISSUE_SAMPLE:
                # 缺货 / 失效 / 改价 / 违规词已有对应硬错误；样品不符在此补充
                errs.append(f"样品不符：{item['issue_note']}")
            errors.extend(errs)
            warnings.extend(f"第 {item['position']} 项「{product.name}」：{w}" for w in warns)
            cards.append({
                "item_id": item["id"], "position": item["position"],
                "product_id": item["product_id"], "product_name": product.name,
                "image": product.image, "stock": product.stock,
                "stock_alert": item["stock_alert"],
                "link": dict(link) if link else None,
                "issue": item["issue"], "issue_note": item["issue_note"],
                "errors": errs, "warnings": warns,
            })
        active = [c for c in cards if not c.get("withdrawn")]
        if not active:
            errors.append("场次没有可播的排品项")
        return {"ok": not errors, "errors": errors, "warnings": warnings, "items": cards}

    # ================================================================
    # 样品登记（照片存本地目录）
    # ================================================================
    def register_sample(
        self, product_id: int, operator: str, filename: str,
        photo_bytes: bytes, note: str = "", mismatch: bool = False,
        item_id: int | None = None,
    ) -> dict:
        self.catalog.get(product_id)
        safe = os.path.basename(filename).replace("..", "_")
        rel = f"sample_{product_id}_{len(os.listdir(self.sample_dir)) + 1}_{safe}"
        path = os.path.join(self.sample_dir, rel)
        with open(path, "wb") as f:
            f.write(photo_bytes)
        status = "mismatch" if mismatch else "ok"
        with transaction(self.conn):
            sid = insert(
                self.conn,
                """INSERT INTO samples(product_id, item_id, received_by, photo_path, note,
                                       match_status, created_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (product_id, item_id, operator, f"/samples/{rel}",
                 note, status, now()),
            )
            self.log("sample_register", "sample", sid, operator,
                     {"product_id": product_id, "status": status, "photo": f"/samples/{rel}"})
            if mismatch and item_id:
                item = self._item(item_id)
                if not item["withdrawn"]:
                    self._set_issue(item_id, D.ISSUE_SAMPLE, note or "样品与资料不符")
        self.conn.commit()
        row = query_one(self.conn, "SELECT * FROM samples WHERE id=?", (sid,))
        return dict(row)  # type: ignore[arg-type]

    def list_samples(self, product_id: int | None = None) -> list[dict]:
        if product_id is None:
            rows = query_all(self.conn, "SELECT * FROM samples ORDER BY id DESC")
        else:
            rows = query_all(
                self.conn, "SELECT * FROM samples WHERE product_id=? ORDER BY id DESC",
                (product_id,))
        return [dict(r) for r in rows]

    # ================================================================
    # 发布：整场校验 + 快照 + 回执
    # ================================================================
    def _build_snapshot(self, session_id: int) -> dict:
        items = query_all(
            self.conn, "SELECT * FROM session_items WHERE session_id=? ORDER BY position",
            (session_id,),
        )
        payload_items = []
        for item in items:
            product = self.catalog.get(item["product_id"])
            link = query_one(self.conn, "SELECT * FROM links WHERE item_id=?", (item["id"],))
            sc = self._get_script(item["id"])
            approved = None
            if sc and sc["approved_version"]:
                approved = query_one(
                    self.conn,
                    "SELECT * FROM script_versions WHERE script_id=? AND version=?",
                    (sc["id"], sc["approved_version"]),
                )
            promo = query_one(self.conn, "SELECT * FROM promos WHERE code=?",
                              (item["promo_version"],))
            payload_items.append({
                "item_id": item["id"],
                "position": item["position"],
                "withdrawn": bool(item["withdrawn"]),
                "product": {
                    "id": product.id, "name": product.name, "image": product.image,
                    "category": product.category,
                },
                "duration_sec": item["duration_sec"],
                "stock_alert": item["stock_alert"],
                "stock_at_publish": product.stock,
                "promo": dict(promo) if promo else None,
                "link": None if link is None else {
                    "url": link["url"], "listed_price": link["listed_price"],
                    "status": link["status"],
                },
                "script": None if approved is None else {
                    "version": approved["version"], "content": approved["content"],
                    "author": approved["author"], "reviewer": approved["reviewer"],
                },
            })
        versions = sorted({i["script"]["version"] for i in payload_items if i["script"]})
        return {"frozen_at": now(), "script_versions": versions, "items": payload_items}

    def publish(self, session_id: int, operator: str, force: bool = False) -> dict:
        self._require_status(session_id, D.SESSION_PLANNING)
        report = self.check_session_links(session_id)
        if not report["ok"] and not force:
            err = D.ValidationFailed("发布前整场挂链校验未通过")
            err.details = report["errors"]  # type: ignore[attr-defined]
            raise err
        with transaction(self.conn):
            payload = self._build_snapshot(session_id)
            snap_ver = max(payload["script_versions"], default=0)
            self.conn.execute(
                "INSERT INTO session_snapshots(session_id, payload, version, created_at)"
                " VALUES(?,?,?,?)",
                (session_id, json.dumps(payload, ensure_ascii=False), snap_ver, now()),
            )
            self.conn.execute(
                "UPDATE sessions SET status=?, published_at=? WHERE id=?",
                (D.SESSION_PUBLISHED, now(), session_id),
            )
            self.log(D.ACT_PUBLISH, "session", session_id, operator,
                     {"items": len(payload["items"]), "forced": force,
                      "errors_ignored": report["errors"] if force else []})
        self.conn.commit()
        receipt = self.receipts.send(session_id, {
            "type": "session_publish", "items": len(payload["items"]),
            "script_versions": payload["script_versions"], "forced": force,
            "errors_ignored": report["errors"] if force else [],
        })
        self.log(D.ACT_PUBLISH_RECEIPT, "session", session_id, operator,
                 {"receipt_no": receipt.receipt_no, "channel": receipt.channel})
        self.conn.commit()
        return {"session_id": session_id, "snapshot": payload,
                "receipt_no": receipt.receipt_no, "channel": receipt.channel}

    def start_session(self, session_id: int, operator: str) -> None:
        self._require_status(session_id, D.SESSION_PUBLISHED)
        with transaction(self.conn):
            self.conn.execute(
                "UPDATE sessions SET status=?, started_at=? WHERE id=?",
                (D.SESSION_LIVE, now(), session_id),
            )
            self.log("session_start", "session", session_id, operator, {})
        self.conn.commit()

    def end_session(self, session_id: int, operator: str) -> None:
        self._require_status(session_id, D.SESSION_LIVE)
        with transaction(self.conn):
            self.conn.execute(
                "UPDATE sessions SET status=?, ended_at=? WHERE id=?",
                (D.SESSION_ENDED, now(), session_id),
            )
            self.log("session_end", "session", session_id, operator, {})
        self.conn.commit()

    def get_snapshot(self, session_id: int) -> dict | None:
        row = query_one(
            self.conn, "SELECT payload FROM session_snapshots WHERE session_id=?",
            (session_id,),
        )
        return json.loads(row["payload"]) if row else None

    # ================================================================
    # 时间轴（planning 读草稿，live/ended 读发布快照）
    # ================================================================
    def timeline(self, session_id: int) -> dict:
        session = dict(self._session(session_id))
        anchor = self.catalog.get_anchor(session["anchor_id"])
        session["anchor_name"] = anchor.name
        if session["status"] in (D.SESSION_LIVE, D.SESSION_ENDED):
            snap = self.get_snapshot(session_id)
            # 快照冻结脚本 / 价格 / 顺序；叠加实时运行态（撤品 / 挂链上下架 / 成交 / 异常）
            for card in snap["items"]:
                live_item = query_one(
                    self.conn, "SELECT * FROM session_items WHERE id=?", (card["item_id"],))
                live_link = query_one(
                    self.conn, "SELECT * FROM links WHERE item_id=?", (card["item_id"],))
                card["withdrawn"] = bool(live_item["withdrawn"])
                card["issue"] = live_item["issue"]
                card["issue_note"] = live_item["issue_note"]
                card["position"] = live_item["position"]
                card["stock_live"] = self.catalog.get(card["product"]["id"]).stock
                if live_link and card["link"]:
                    card["link"]["status"] = live_link["status"]
                    card["link"]["order_count"] = live_link["order_count"]
                    card["link"]["id"] = live_link["id"]
            return {"session": session, "mode": "snapshot", "timeline": snap}
        items = query_all(
            self.conn, "SELECT * FROM session_items WHERE session_id=? ORDER BY position",
            (session_id,),
        )
        cards = []
        for item in items:
            product = self.catalog.get(item["product_id"])
            link = query_one(self.conn, "SELECT * FROM links WHERE item_id=?", (item["id"],))
            sc = self._get_script(item["id"])
            ov = self.script_overview(item["id"]) if sc else None
            cards.append({
                "item_id": item["id"], "position": item["position"],
                "withdrawn": bool(item["withdrawn"]),
                "duration_sec": item["duration_sec"],
                "stock_alert": item["stock_alert"], "promo_version": item["promo_version"],
                "issue": item["issue"], "issue_note": item["issue_note"],
                "product": self.catalog.as_dict(product.id),
                "link": dict(link) if link else None,
                "script": None if ov is None else {
                    "current_version": ov["script"]["current_version"],
                    "approved_version": ov["script"]["approved_version"],
                    "latest_status": ov["latest"]["status"],
                    "author": ov["script"]["author"],
                    "violations": ov["latest_violations"],
                },
            })
        return {"session": session, "mode": "draft", "timeline": {"items": cards}}

    # ================================================================
    # 平台回调：幂等 + 乱序
    # ================================================================
    def _apply_callback(
        self, link_id: int, event_type: str, event_id: str, seq: int,
        operator: str = "platform", force: bool = False,
    ) -> dict:
        if event_type not in (D.CB_ONLINE, D.CB_OFFLINE):
            raise D.ValidationFailed("未知回调事件")
        link_row = query_one(self.conn, "SELECT * FROM links WHERE id=?", (link_id,))
        if link_row is None:
            raise D.NotFound(f"挂链 {link_id}")

        # 1) 幂等：同一 event_id 只处理一次
        existing = query_one(self.conn, "SELECT * FROM callbacks WHERE event_id=?", (event_id,))
        if existing is not None:
            self.log("callback_duplicate", "link", link_id, operator,
                     {"event_id": event_id})
            self.conn.commit()
            return {"status": "duplicate", "event_id": event_id,
                    "link_status": link_row["status"], "changed": False}

        # 2) 乱序：seq 小于该链已处理的最大序号 → 过期丢弃
        max_seq = query_one(
            self.conn,
            "SELECT COALESCE(MAX(seq),-1) AS s FROM callbacks WHERE link_id=? AND status='processed'",
            (link_id,),
        )["s"]
        if seq <= max_seq and not force:
            insert(
                self.conn,
                """INSERT INTO callbacks(event_id, link_id, event_type, seq, status, created_at, processed_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (event_id, link_id, event_type, seq, "stale", now(), now()),
            )
            self.log("callback_stale", "link", link_id, operator,
                     {"event_id": event_id, "seq": seq, "max_seq": max_seq})
            self.conn.commit()
            return {"status": "stale", "event_id": event_id, "seq": seq,
                    "max_seq": max_seq, "link_status": link_row["status"], "changed": False}

        changed = False
        note = ""
        if event_type == D.CB_ONLINE:
            if link_row["status"] != D.LINK_LIVE:
                self.conn.execute(
                    "UPDATE links SET status=?, online_event_id=?, listed_at=COALESCE(listed_at,?) "
                    "WHERE id=?",
                    (D.LINK_LIVE, event_id, now(), link_id),
                )
                changed = True
            else:
                note = "已在上架状态，重复上架不产生效果"
        else:
            if link_row["status"] != D.LINK_TAKEN_DOWN:
                # 下架只改状态，绝不清空 order_count（不改变已成交订单）
                self.conn.execute(
                    "UPDATE links SET status=?, offline_event_id=?, taken_down_at=? WHERE id=?",
                    (D.LINK_TAKEN_DOWN, event_id, now(), link_id),
                )
                changed = True
            else:
                note = "已在下架状态，重复下架不产生效果"

        insert(
            self.conn,
            """INSERT INTO callbacks(event_id, link_id, event_type, seq, status, created_at, processed_at)
               VALUES(?,?,?,?,?,?,?)""",
            (event_id, link_id, event_type, seq, "processed", now(), now()),
        )
        self.log("callback_processed", "link", link_id, operator,
                 {"event_id": event_id, "seq": seq, "event_type": event_type,
                  "changed": changed, "note": note})
        self.conn.commit()
        new_status = D.LINK_LIVE if event_type == D.CB_ONLINE else D.LINK_TAKEN_DOWN
        return {"status": "processed", "event_id": event_id, "seq": seq,
                "link_status": new_status, "changed": changed, "note": note}

    def platform_callback(self, link_id: int, event_type: str, event_id: str, seq: int) -> dict:
        return self._apply_callback(link_id, event_type, event_id, seq)

    def simulate_order(self, link_id: int, qty: int = 1) -> dict:
        """演示成交：只有 live 挂链可成交；后续下架不影响该数字。"""
        link = query_one(self.conn, "SELECT * FROM links WHERE id=?", (link_id,))
        if link is None:
            raise D.NotFound(f"挂链 {link_id}")
        if link["status"] != D.LINK_LIVE:
            raise D.ConflictState("挂链未上架，不能成交")
        self.conn.execute(
            "UPDATE links SET order_count=order_count+? WHERE id=?", (qty, link_id))
        self.conn.commit()
        row = query_one(self.conn, "SELECT order_count FROM links WHERE id=?", (link_id,))
        return {"link_id": link_id, "order_count": row["order_count"]}

    # ================================================================
    # 查询杂项
    # ================================================================
    def list_audit_logs(self, limit: int = 50) -> list[dict]:
        rows = query_all(
            self.conn, "SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", (int(limit),))
        return [dict(r) for r in rows]

    def list_receipts(self, session_id: int | None = None) -> list[dict]:
        rs = self.receipts.all() if session_id is None else self.receipts.list_for_session(session_id)
        return [r.__dict__ for r in rs]
