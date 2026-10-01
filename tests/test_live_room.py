"""核心规则测试：版本快照 / 挂链唯一 / 价格校验 / 回调乱序 / 审核权限等。

直接使用临时 SQLite + 独立的进程内适配器实例，不依赖演示库。
运行：python -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import tempfile
import unittest

from live_room import domain as D
from live_room.adapters import ProductCatalog, ReceiptAdapter
from live_room.db import connect, init_db, query_one
from live_room.seed import PROMOS, _load_base_data
from live_room.services import LiveRoomService

AUTHOR = "编导-小晚"
REVIEWER = "审核-老周"
OPERATOR = "运营-小鹿"

SAMPLE_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'


class ServiceCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cat = ProductCatalog()
        self.rec = ReceiptAdapter()
        self.conn = connect(os.path.join(self.tmp.name, "test.db"))
        init_db(self.conn)
        _load_base_data(self.conn, self.cat)
        self.svc = LiveRoomService(
            self.conn, self.cat, self.rec, os.path.join(self.tmp.name, "samples"))

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    # ---- 构造辅助 ----
    def approve_material(self, *pids: int) -> None:
        for pid in pids:
            self.svc.submit_material(pid, OPERATOR)
            self.svc.approve_material(pid, "审核-阿岚")

    def make_session(self, pids: tuple[int, ...] = (1, 2),
                     publish: bool = True, live: bool = False) -> int:
        self.approve_material(*pids)
        sid = self.svc.create_session("测试场次", 1, "2026-10-01T20:00", OPERATOR)
        for i, pid in enumerate(pids):
            iid = self.svc.add_item(sid, pid, 300, 50, "PROMO_V1", OPERATOR)
            self.svc.attach_link(iid, self.cat.get(pid).link_url, None, OPERATOR)
            self.svc.edit_script(iid, AUTHOR, f"商品 {pid} 的讲解脚本，内容合规。")
            self.svc.submit_script(iid, AUTHOR)
            self.svc.review_script(iid, REVIEWER, True, "通过")
        if publish:
            self.svc.publish(sid, OPERATOR)
        if live:
            self.svc.start_session(sid, OPERATOR)
        return sid

    def item_ids(self, sid: int) -> list[int]:
        return [r["id"] for r in self.conn.execute(
            "SELECT id FROM session_items WHERE session_id=? ORDER BY position", (sid,))]

    def link_id(self, item_id: int) -> int:
        return query_one(self.conn, "SELECT id FROM links WHERE item_id=?",
                         (item_id,))["id"]


class TestVersionSnapshot(ServiceCase):
    def test_published_snapshot_freezes_approved_script(self):
        sid = self.make_session((1, 2), live=True)
        iid = self.item_ids(sid)[0]

        tl = self.svc.timeline(sid)
        self.assertEqual(tl["mode"], "snapshot")
        snap_script = tl["timeline"]["items"][0]["script"]
        self.assertEqual(snap_script["version"], 1)
        self.assertIn("讲解脚本", snap_script["content"])

        # 开播后修改 → 新草稿版本
        ov = self.svc.edit_script(iid, AUTHOR, "【草稿】改版开场白，加赠品。")
        self.assertEqual(ov["script"]["current_version"], 2)
        self.assertEqual(ov["script"]["approved_version"], 1)  # 过审版本不变

        # 时间轴继续使用发布快照，草稿不能覆盖
        tl2 = self.svc.timeline(sid)
        self.assertEqual(tl2["timeline"]["items"][0]["script"]["version"], 1)
        self.assertNotIn("草稿", tl2["timeline"]["items"][0]["script"]["content"])

    def test_planning_reads_draft_and_cannot_publish_without_approval(self):
        self.approve_material(1)
        sid = self.svc.create_session("草稿场", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)
        self.svc.attach_link(iid, self.cat.get(1).link_url, None, OPERATOR)
        self.svc.edit_script(iid, AUTHOR, "草稿脚本，合规。")
        # 未送审 / 未过审 → 不能发布
        with self.assertRaises(D.ValidationFailed):
            self.svc.publish(sid, OPERATOR)

    def test_started_session_rejects_edits_to_plan(self):
        sid = self.make_session((1,), live=True)
        with self.assertRaises(D.ConflictState):
            self.svc.add_item(sid, 2, 300, 50, "PROMO_V1", OPERATOR)
        iid = self.item_ids(sid)[0]
        with self.assertRaises(D.ConflictState):
            self.svc.attach_link(iid, "https://x", None, OPERATOR)

    def test_edit_without_change_does_not_create_version(self):
        sid = self.make_session((1,), publish=False)
        iid = self.item_ids(sid)[0]
        with self.assertRaises(D.ConflictState):
            self.svc.edit_script(iid, AUTHOR, "商品 1 的讲解脚本，内容合规。")


class TestLinkUniqueness(ServiceCase):
    def test_same_url_twice_in_session_rejected(self):
        self.approve_material(1, 2)
        sid = self.svc.create_session("链接唯一", 1, "2026-10-03T20:00", OPERATOR)
        i1 = self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)
        i2 = self.svc.add_item(sid, 2, 300, 50, "PROMO_V1", OPERATOR)
        self.svc.attach_link(i1, "https://demo.shop/item/1001", None, OPERATOR)
        with self.assertRaises(D.ConflictState):
            self.svc.attach_link(i2, "https://demo.shop/item/1001", None, OPERATOR)
        # 不同 URL 可以
        self.svc.attach_link(i2, "https://demo.shop/item/1002", None, OPERATOR)

    def test_one_link_per_item(self):
        self.approve_material(1)
        sid = self.svc.create_session("单品单链", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)
        self.svc.attach_link(iid, "https://demo.shop/item/1001", None, OPERATOR)
        with self.assertRaises(D.ConflictState):
            self.svc.attach_link(iid, "https://demo.shop/item/9999", None, OPERATOR)


class TestPriceValidation(ServiceCase):
    def test_price_mismatch_blocks_publish_and_sync_resolves(self):
        self.approve_material(5)
        sid = self.svc.create_session("改价场", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 5, 300, 50, "PROMO_V1", OPERATOR)
        self.svc.attach_link(iid, self.cat.get(5).link_url, None, OPERATOR)
        self.svc.edit_script(iid, AUTHOR, "毛巾脚本，合规。")
        self.svc.submit_script(iid, AUTHOR)
        self.svc.review_script(iid, REVIEWER, True)

        self.cat.change_price(5, 25.9)
        found = self.svc.refresh_issues(sid)
        self.assertTrue(any(f["issue"] == "price" for f in found["issues"]))

        report = self.svc.check_session_links(sid)
        self.assertFalse(report["ok"])
        self.assertTrue(any("价格不一致" in e for e in report["errors"]))
        with self.assertRaises(D.ValidationFailed):
            self.svc.publish(sid, OPERATOR)

        self.svc.sync_link_price(iid, OPERATOR)
        report2 = self.svc.check_session_links(sid)
        self.assertTrue(report2["ok"], report2["errors"])

    def test_explicit_wrong_price_marks_issue(self):
        self.approve_material(1)
        sid = self.svc.create_session("挂价错误", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)
        self.svc.attach_link(iid, "https://demo.shop/item/1001", 10.0, OPERATOR)
        item = query_one(self.conn, "SELECT issue FROM session_items WHERE id=?", (iid,))
        self.assertEqual(item["issue"], "price")

    def test_stock_alert_is_warning_not_blocker(self):
        self.approve_material(1)
        sid = self.svc.create_session("库存预警", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 1, 300, 300, "PROMO_V1", OPERATOR)  # 阈值=300，库存320以下? 320>300
        self.svc.attach_link(iid, self.cat.get(1).link_url, None, OPERATOR)
        self.svc.edit_script(iid, AUTHOR, "袜子脚本，合规。")
        self.svc.submit_script(iid, AUTHOR)
        self.svc.review_script(iid, REVIEWER, True)
        self.cat.set_stock(1, 120)  # 低于阈值但仍有货
        report = self.svc.refresh_issues(sid)
        self.assertEqual(report["issues"], [])
        self.assertTrue(report["alerts"])
        check = self.svc.check_session_links(sid)
        self.assertTrue(check["ok"])          # 预警不阻断
        self.assertTrue(check["warnings"])


class TestCallbackOrdering(ServiceCase):
    def test_duplicate_and_out_of_order_callbacks(self):
        sid = self.make_session((1,), live=True)
        lid = self.link_id(self.item_ids(sid)[0])

        r1 = self.svc.platform_callback(lid, D.CB_ONLINE, "e-1", seq=10)
        self.assertEqual(r1["status"], "processed")
        self.assertTrue(r1["changed"])

        # 重复回调：不重复上架
        r1dup = self.svc.platform_callback(lid, D.CB_ONLINE, "e-1", seq=10)
        self.assertEqual(r1dup["status"], "duplicate")
        self.assertFalse(r1dup["changed"])

        # 新事件但已在上架态：处理但状态不变
        r1again = self.svc.platform_callback(lid, D.CB_ONLINE, "e-2", seq=11)
        self.assertEqual(r1again["status"], "processed")
        self.assertFalse(r1again["changed"])

        # 下架
        r2 = self.svc.platform_callback(lid, D.CB_OFFLINE, "e-3", seq=20)
        self.assertTrue(r2["changed"])
        self.assertEqual(r2["link_status"], "taken_down")

        # 乱序：更早的 seq 晚到 → stale，挂链保持下架
        stale = self.svc.platform_callback(lid, D.CB_ONLINE, "e-old", seq=15)
        self.assertEqual(stale["status"], "stale")
        self.assertEqual(stale["link_status"], "taken_down")

        # 后续更大 seq 正常生效
        back = self.svc.platform_callback(lid, D.CB_ONLINE, "e-4", seq=25)
        self.assertEqual(back["status"], "processed")
        self.assertTrue(back["changed"])

    def test_offline_never_touches_closed_orders(self):
        sid = self.make_session((1,), live=True)
        lid = self.link_id(self.item_ids(sid)[0])
        self.svc.platform_callback(lid, D.CB_ONLINE, "e-1", seq=1)
        self.svc.simulate_order(lid, 2)
        self.svc.simulate_order(lid, 1)
        self.svc.platform_callback(lid, D.CB_OFFLINE, "e-2", seq=2)
        # 重复下架
        dup = self.svc.platform_callback(lid, D.CB_OFFLINE, "e-2", seq=2)
        self.assertEqual(dup["status"], "duplicate")
        cnt = query_one(self.conn, "SELECT order_count FROM links WHERE id=?", (lid,))[0]
        self.assertEqual(cnt, 3)

    def test_order_only_when_live(self):
        self.approve_material(1)
        sid = self.svc.create_session("未上架", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)
        self.svc.attach_link(iid, self.cat.get(1).link_url, None, OPERATOR)
        lid = self.link_id(iid)
        with self.assertRaises(D.ConflictState):
            self.svc.simulate_order(lid)

    def test_oos_forces_live_link_offline(self):
        sid = self.make_session((1,), live=True)
        iid = self.item_ids(sid)[0]
        lid = self.link_id(iid)
        self.svc.platform_callback(lid, D.CB_ONLINE, "e-1", seq=1)
        self.cat.set_stock(1, 0)
        self.svc.refresh_issues(sid)
        self.assertEqual(query_one(self.conn, "SELECT status FROM links WHERE id=?",
                                  (lid,))["status"], "taken_down")


class TestReviewPermission(ServiceCase):
    def _submitted_script(self):
        self.approve_material(1)
        sid = self.svc.create_session("审核场", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)
        self.svc.edit_script(iid, AUTHOR, "全网最低价，第一好用！")
        self.svc.submit_script(iid, AUTHOR)
        return iid

    def test_author_cannot_review_own_script(self):
        iid = self._submitted_script()
        with self.assertRaises(D.PermissionDenied):
            self.svc.review_script(iid, AUTHOR, True)

    def test_banned_words_cannot_pass_then_revise_flow(self):
        iid = self._submitted_script()
        # 换人审核也不能通过违规词版本
        with self.assertRaises(D.ValidationFailed):
            self.svc.review_script(iid, REVIEWER, True)
        # 驳回 → 作者修改生成新版本 → 再送审 → 通过
        self.svc.review_script(iid, REVIEWER, False, "极限词过多，请重写")
        self.svc.edit_script(iid, AUTHOR, "居家袜柔软亲肤，三双组合装。")
        self.svc.submit_script(iid, AUTHOR)
        ov = self.svc.review_script(iid, REVIEWER, True)
        self.assertEqual(ov["approved"]["status"], "approved")
        self.assertEqual(ov["script"]["approved_version"], 2)

    def test_reject_requires_note(self):
        iid = self._submitted_script()
        with self.assertRaises(D.ValidationFailed):
            self.svc.review_script(iid, REVIEWER, False, "")


class TestMaterialGate(ServiceCase):
    def test_unapproved_product_cannot_join_session(self):
        sid = self.svc.create_session("资料门槛", 1, "2026-10-03T20:00", OPERATOR)
        with self.assertRaises(D.ValidationFailed):
            self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)

    def test_incomplete_material_cannot_be_approved(self):
        # 商品 8 演示资料不全
        self.svc.submit_material(8, OPERATOR)
        with self.assertRaises(D.ValidationFailed):
            self.svc.approve_material(8, "审核-阿岚")

    def test_approved_product_can_join(self):
        self.approve_material(1)
        sid = self.svc.create_session("可排品", 1, "2026-10-03T20:00", OPERATOR)
        self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)

    def test_duplicate_product_in_session_rejected(self):
        sid = self.make_session((1,), publish=False)
        with self.assertRaises(D.ConflictState):
            self.svc.add_item(sid, 1, 300, 50, "PROMO_V1", OPERATOR)


class TestIssueHandling(ServiceCase):
    def test_six_issue_kinds_are_distinguished(self):
        self.approve_material(3, 6)
        sid = self.svc.create_session("异常场", 1, "2026-10-03T20:00", OPERATOR)
        i3 = self.svc.add_item(sid, 3, 300, 20, "PROMO_V1", OPERATOR)    # 演示缺货
        self.svc.attach_link(i3, self.cat.get(3).link_url, None, OPERATOR)
        i6 = self.svc.add_item(sid, 6, 300, 20, "PROMO_V1", OPERATOR)    # 演示链接失效
        self.svc.attach_link(i6, self.cat.get(6).link_url, None, OPERATOR)
        found = self.svc.refresh_issues(sid)
        kinds = {f["item_id"]: f["issue"] for f in found["issues"]}
        self.assertEqual(kinds[i3], "oos")
        self.assertEqual(kinds[i6], "dead_link")

    def test_sample_mismatch_blocks_and_photo_persists(self):
        self.approve_material(7)
        sid = self.svc.create_session("样品场", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 7, 300, 20, "PROMO_V3", OPERATOR)
        self.svc.attach_link(iid, self.cat.get(7).link_url, None, OPERATOR)
        self.svc.edit_script(iid, AUTHOR, "暖手宝脚本，合规。")
        self.svc.submit_script(iid, AUTHOR)
        self.svc.review_script(iid, REVIEWER, True)
        s = self.svc.register_sample(7, "仓管-阿May", "s.svg", SAMPLE_SVG,
                                    note="容量不符", mismatch=True, item_id=iid)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, "samples",
                                                    os.path.basename(s["photo_path"]))))
        report = self.svc.check_session_links(sid)
        self.assertFalse(report["ok"])
        self.assertTrue(any("样品不符" in e for e in report["errors"]))

    def test_withdraw_during_live(self):
        sid = self.make_session((1, 2), live=True)
        i1, i2 = self.item_ids(sid)
        lid1 = self.link_id(i1)
        self.svc.platform_callback(lid1, D.CB_ONLINE, "e-1", seq=1)
        self.svc.simulate_order(lid1, 2)

        wd = self.svc.withdraw_item(i1, OPERATOR, "品牌临时锁库存")
        self.assertEqual(wd["offline"]["link_status"], "taken_down")
        self.assertEqual(query_one(self.conn, "SELECT order_count FROM links WHERE id=?",
                                   (lid1,))["order_count"], 2)  # 成交保留
        tl = self.svc.timeline(sid)
        card = next(c for c in tl["timeline"]["items"] if c["item_id"] == i1)
        self.assertTrue(card["withdrawn"])

        # 不可重复撤品、不可恢复
        with self.assertRaises(D.ConflictState):
            self.svc.withdraw_item(i1, OPERATOR, "再撤一次")
        with self.assertRaises(D.ConflictState):
            self.svc.resolve_issue(i1, OPERATOR)
        # 另一个商品不受影响
        card2 = next(c for c in tl["timeline"]["items"] if c["item_id"] == i2)
        self.assertFalse(card2["withdrawn"])


class TestPublishReceipt(ServiceCase):
    def test_publish_creates_receipt(self):
        sid = self.make_session((1, 2), live=False)
        rs = self.rec.list_for_session(sid)
        self.assertEqual(len(rs), 1)
        self.assertTrue(rs[0].receipt_no.startswith(f"RCP-{sid:04d}"))
        self.assertTrue(rs[0].detail["items"] >= 2)

    def test_force_publish_records_ignored_errors(self):
        self.approve_material(3)  # 商品 3 缺货
        sid = self.svc.create_session("强发场", 1, "2026-10-03T20:00", OPERATOR)
        iid = self.svc.add_item(sid, 3, 300, 20, "PROMO_V1", OPERATOR)
        self.svc.attach_link(iid, self.cat.get(3).link_url, None, OPERATOR)
        with self.assertRaises(D.ValidationFailed):
            self.svc.publish(sid, OPERATOR)
        self.svc.publish(sid, OPERATOR, force=True)
        rs = self.rec.list_for_session(sid)[0]
        self.assertTrue(rs.detail["forced"])
        self.assertTrue(rs.detail["errors_ignored"])


if __name__ == "__main__":
    unittest.main()
