"""演示数据初始化：图片 / 样品照片 / 排品 / 撤品 / 回执样例。

用法：
    python -m live_room.seed            # 仅当数据库为空时初始化
    python -m live_room.seed --reset    # 清空后重建完整演示剧情
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys

from . import db as dbmod
from . import domain as D
from .adapters import ProductCatalog, catalog as default_catalog, receipts as default_receipts
from .services import LiveRoomService

ROOT = os.path.dirname(os.path.dirname(__file__))
IMG_DIR = os.path.join(ROOT, "data", "img")
SAMPLE_DIR = os.path.join(ROOT, "data", "samples")

GRAPHITE = "#22242A"
CREAM = "#F7F1E5"
CORAL = "#FF6F61"
CORAL_DARK = "#E85D50"
INK = "#2E3036"
MUTED = "#8A8478"

# ---- 矢量插画（无外链资源，固定显示在商品卡上） -------------------------

def svg_wrap(body: str, bg: str = CREAM) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" '
        f'viewBox="0 0 240 160"><rect width="240" height="160" rx="14" fill="{bg}"/>'
        f'{body}</svg>'
    )


def product_svg(pid: int) -> str:
    c, cd, g = CORAL, CORAL_DARK, GRAPHITE
    if pid == 1:  # 居家袜：三道波浪
        body = (
            f'<path d="M40 96 q20 -34 40 0 t40 0 t40 0 t40 0" fill="none" stroke="{c}" '
            f'stroke-width="10" stroke-linecap="round"/>'
            f'<path d="M40 118 q20 -34 40 0 t40 0 t40 0 t40 0" fill="none" stroke="{g}" '
            f'stroke-width="10" stroke-linecap="round" opacity="0.85"/>'
            f'<circle cx="200" cy="44" r="16" fill="{c}" opacity="0.25"/>'
        )
    elif pid == 2:  # 保温杯
        body = (
            f'<rect x="92" y="34" width="56" height="96" rx="14" fill="{g}"/>'
            f'<rect x="100" y="52" width="40" height="46" rx="8" fill="{CREAM}"/>'
            f'<rect x="104" y="24" width="32" height="14" rx="6" fill="{c}"/>'
            f'<circle cx="120" cy="116" r="6" fill="{c}"/>'
        )
    elif pid == 3:  # 香薰蜡烛
        body = (
            f'<rect x="88" y="66" width="64" height="64" rx="10" fill="{c}"/>'
            f'<rect x="104" y="40" width="4" height="28" fill="{g}"/>'
            f'<path d="M106 40 q-8 -10 0 -20 q8 10 0 20Z" fill="{g}"/>'
            f'<rect x="98" y="90" width="44" height="8" rx="4" fill="{CREAM}" opacity="0.8"/>'
        )
    elif pid == 4:  # 马克杯
        body = (
            f'<rect x="78" y="58" width="74" height="70" rx="12" fill="{c}"/>'
            f'<path d="M152 74 h16 a14 14 0 0 1 0 32 h-16" fill="none" stroke="{c}" '
            f'stroke-width="9"/>'
            f'<rect x="78" y="58" width="74" height="16" rx="8" fill="{g}"/>'
        )
    elif pid == 5:  # 运动毛巾
        body = (
            f'<rect x="52" y="46" width="136" height="46" rx="10" fill="{g}"/>'
            f'<rect x="52" y="92" width="136" height="22" rx="10" fill="{c}"/>'
            f'<line x1="70" y1="46" x2="70" y2="114" stroke="{CREAM}" stroke-width="3"/>'
            f'<line x1="170" y1="46" x2="170" y2="114" stroke="{CREAM}" stroke-width="3"/>'
        )
    elif pid == 6:  # 收纳箱
        body = (
            f'<rect x="56" y="58" width="128" height="78" rx="10" fill="none" '
            f'stroke="{g}" stroke-width="8"/>'
            f'<rect x="56" y="44" width="128" height="22" rx="8" fill="{c}"/>'
            f'<line x1="120" y1="58" x2="120" y2="136" stroke="{MUTED}" stroke-width="4"/>'
            f'<path d="M88 92 l-10 10 M152 92 l10 10" stroke="{MUTED}" stroke-width="4"/>'
        )
    elif pid == 7:  # 暖手宝
        body = (
            f'<rect x="72" y="44" width="96" height="84" rx="26" fill="{c}"/>'
            f'<rect x="92" y="64" width="56" height="44" rx="14" fill="{CREAM}"/>'
            f'<path d="M112 88 l6 6 l12 -14" fill="none" stroke="{g}" stroke-width="5"/>'
        )
    else:  # 围巾（资料待补）
        body = (
            f'<path d="M60 56 h120 v26 h-44 v52 l-16 -8 l-16 8 v-52 h-44Z" fill="{g}"/>'
            f'<rect x="60" y="62" width="120" height="6" fill="{c}"/>'
            f'<rect x="60" y="72" width="120" height="6" fill="{c}" opacity="0.6"/>'
            f'<text x="120" y="146" font-size="11" text-anchor="middle" '
            f'fill="{MUTED}" font-family="sans-serif">资料待补</text>'
        )
    return svg_wrap(body)


def sample_svg(label: str, ok: bool) -> str:
    mark_color = "#2E8B57" if ok else CORAL_DARK
    tick = (
        f'<circle cx="120" cy="80" r="30" fill="{mark_color}"/>'
        + ('<path d="M106 80 l10 10 l20 -22" fill="none" stroke="#fff" stroke-width="6"/>'
           if ok else
           '<path d="M108 68 l24 24 M132 68 l-24 24" stroke="#fff" stroke-width="6"/>')
    )
    body = (
        f'<rect x="30" y="30" width="180" height="100" rx="10" fill="#fff" '
        f'stroke="{MUTED}" stroke-width="2" stroke-dasharray="6 5"/>'
        f'{tick}'
        f'<text x="120" y="146" font-size="13" text-anchor="middle" fill="{INK}" '
        f'font-family="sans-serif">{label}</text>'
    )
    return svg_wrap(body, bg="#EFE9DC")


# ---- 初始化 -------------------------------------------------------------

PROMOS = [
    ("PROMO_V1", "开门红·立减10", "开播前 10 分钟下单立减 10 元", 10.0),
    ("PROMO_V2", "限时秒·立减20", "整点限量秒杀，立减 20 元", 20.0),
    ("PROMO_V3", "返场券·第二件半价", "返场时段第二件半价", 0.0),
]

OPERATOR = "运营-小鹿"
REVIEWER = "审核-阿岚"
AUTHOR = "编导-小晚"
SCRIPT_REVIEWER = "审核-老周"


def _reset_assets() -> None:
    os.makedirs(IMG_DIR, exist_ok=True)
    os.makedirs(SAMPLE_DIR, exist_ok=True)
    for pid in range(1, 9):
        with open(os.path.join(IMG_DIR, f"p{pid}.svg"), "w", encoding="utf-8") as f:
            f.write(product_svg(pid))
    for f in os.listdir(SAMPLE_DIR):
        os.remove(os.path.join(SAMPLE_DIR, f))
    db_path = dbmod.DEFAULT_DB_PATH
    for suffix in ("", "-wal", "-shm"):
        p = db_path + suffix
        if os.path.exists(p):
            os.remove(p)
    # 进程内适配器复位，确保价格 / 库存 / 链接状态回到演示初值
    default_catalog._reset_demo_data()
    default_receipts.reset()


def _load_base_data(conn: sqlite3.Connection, cat: ProductCatalog) -> None:
    for a in cat.list_anchors():
        conn.execute("INSERT INTO anchors(id, name, account) VALUES(?,?,?)",
                     (a.id, a.name, a.account))
    for p in cat.list_products():
        conn.execute(
            "INSERT INTO products(id, name, image, category, demo_price) VALUES(?,?,?,?,?)",
            (p.id, p.name, p.image, p.category, p.base_price))
    for code, label, desc, amount in PROMOS:
        conn.execute("INSERT INTO promos(code, label, description, discount_amount)"
                     " VALUES(?,?,?,?)", (code, label, desc, amount))
    conn.commit()


def seed(reset: bool = False) -> dict:
    if reset:
        _reset_assets()
    conn = dbmod.connect()
    dbmod.init_db(conn)
    fresh = conn.execute("SELECT COUNT(*) c FROM anchors").fetchone()["c"] == 0
    cat = default_catalog
    svc = LiveRoomService(conn, cat, default_receipts, SAMPLE_DIR)

    if not fresh and not reset:
        conn.close()
        return {"skipped": True}

    _load_base_data(conn, cat)

    summary: dict = {"withdraw": None, "receipts": [], "callbacks": []}

    # ---- 商品资料审核 ----
    for pid in (1, 2, 3, 4, 5, 6, 7):
        svc.submit_material(pid, OPERATOR)
        svc.approve_material(pid, REVIEWER)
    # 商品 8 资料不全 → 驳回（不能加入排品）
    svc.submit_material(8, OPERATOR)
    svc.reject_material(8, REVIEWER, "缺少质检报告与规格参数图，请补充后重新提交")

    # ---- 样品登记（照片存本地目录，由 register_sample 统一落盘）----
    svc.register_sample(1, "仓管-阿May", "sample_1_ok.svg",
                        sample_svg("珊瑚绒居家袜 · 样品核对一致", True).encode(),
                        note="颜色、克重与资料一致")
    # 注意：商品 7 的「样品不符」登记安排在场次 A 发布之后，避免阻断发布校验。

    # ====================================================================
    # 场次 A：已发布开播 —— 发布快照 / 回调 / 临时撤品 / 回执
    # ====================================================================
    s1 = svc.create_session("10·1 珊瑚家居夜场", 1, "2026-10-01T20:00", OPERATOR)
    plan_a = [
        # product, duration, alert, promo, 脚本
        (1, 300, 50, "PROMO_V1", "开场先介绍珊瑚绒居家袜，三双组合装，柔软不掉跟。"),
        (2, 420, 30, "PROMO_V2", "石墨黑保温杯，316 不锈钢内胆，保温 12 小时。"),
        (4, 360, 40, "PROMO_V2", "珊瑚色陶瓷马克杯，釉下彩工艺，微波炉可用。"),
        (5, 240, 60, "PROMO_V1", "速干运动毛巾，吸水量是自重四倍，健身必备。"),
        (7, 300, 20, "PROMO_V3", "迷你暖手宝，随身充电两用，返场第二件半价。"),
    ]
    item_ids_a: list[int] = []
    for pid, dur, alert, promo, script_text in plan_a:
        iid = svc.add_item(s1, pid, dur, alert, promo, OPERATOR)
        item_ids_a.append(iid)
        svc.attach_link(iid, cat.get(pid).link_url, None, OPERATOR)
        svc.edit_script(iid, AUTHOR, script_text)
        svc.submit_script(iid, AUTHOR)
        svc.review_script(iid, SCRIPT_REVIEWER, True, "通过，可以播出")

    # 发布（整场挂链校验通过）→ 发布回执
    pub = svc.publish(s1, OPERATOR)
    summary["receipts"].append(pub["receipt_no"])
    svc.start_session(s1, OPERATOR)

    # 开播后才发现商品 7 样品不符：场次 A 的发布快照已冻结不受影响，
    # 该登记会在编排中的场次 B 挂链检查里体现。
    svc.register_sample(7, "仓管-阿May", "sample_7_bad.svg",
                        sample_svg("暖手宝 · 样品容量不符", False).encode(),
                        note="样品标称 5000mAh，实测 3000mAh，与资料不符", mismatch=True)

    # 平台上架回调（乱序到达也正确处理）
    link_of = {}
    for iid in item_ids_a:
        row = conn.execute("SELECT id FROM links WHERE item_id=?", (iid,)).fetchone()
        link_of[iid] = row["id"]

    cb1 = svc.platform_callback(link_of[item_ids_a[0]], D.CB_ONLINE, "evt-1001", seq=1)
    cb2 = svc.platform_callback(link_of[item_ids_a[1]], D.CB_ONLINE, "evt-1002", seq=2)
    cb3 = svc.platform_callback(link_of[item_ids_a[2]], D.CB_ONLINE, "evt-1003", seq=3)
    cb4 = svc.platform_callback(link_of[item_ids_a[3]], D.CB_ONLINE, "evt-1004", seq=4)
    cb5 = svc.platform_callback(link_of[item_ids_a[4]], D.CB_ONLINE, "evt-1005", seq=5)

    # 已成交订单（撤品 / 重复回调都不得改变这些数字）
    svc.simulate_order(link_of[item_ids_a[0]], 3)
    svc.simulate_order(link_of[item_ids_a[1]], 1)
    svc.simulate_order(link_of[item_ids_a[2]], 2)

    # 重复回调：不重复上下架
    dup = svc.platform_callback(link_of[item_ids_a[0]], D.CB_ONLINE, "evt-1001", seq=1)
    # 乱序回调：离线 seq=4 晚于已处理 seq=5 → stale 丢弃，挂链保持上架
    stale = svc.platform_callback(link_of[item_ids_a[4]], D.CB_OFFLINE, "evt-0999", seq=4)
    summary["callbacks"] = [cb1, cb5, dup, stale]

    # 开播后修改脚本生成新版本 → 场次仍使用发布快照（草稿不能覆盖）
    svc.edit_script(item_ids_a[0], AUTHOR,
                    "【草稿·加福利】开场先介绍珊瑚绒居家袜，三双组合装，再加一双赠品。")

    # 临时撤品（第 3 项马克杯）：挂链下架，已成交订单保留
    wd = svc.withdraw_item(item_ids_a[2], OPERATOR, "品牌方临时通知库存被其他渠道锁定")
    summary["withdraw"] = wd

    # ====================================================================
    # 场次 B：编排中 —— 六类异常 / 未过审商品 / 校验失败演示
    # ====================================================================
    s2 = svc.create_session("10·2 早场（编排中）", 2, "2026-10-02T08:00", OPERATOR)
    # 缺货商品 3、链接失效商品 6 仍可排进草稿（资料已通过），发布前检查会拦截
    i3 = svc.add_item(s2, 3, 300, 20, "PROMO_V1", OPERATOR)
    svc.attach_link(i3, cat.get(3).link_url, None, OPERATOR)
    svc.edit_script(i3, AUTHOR, "奶油白香薰蜡烛，大豆蜡，安神助眠。")
    svc.submit_script(i3, AUTHOR)
    svc.review_script(i3, SCRIPT_REVIEWER, True)

    i6 = svc.add_item(s2, 6, 260, 20, "PROMO_V2", OPERATOR)
    svc.attach_link(i6, cat.get(6).link_url, None, OPERATOR)
    svc.edit_script(i6, AUTHOR, "折叠收纳箱，大号加厚，搬家整理好帮手。")
    svc.submit_script(i6, AUTHOR)
    svc.review_script(i6, SCRIPT_REVIEWER, True)

    # 商品 5：平台改价 → 挂链价与实时价不一致（价格变更处理）
    i5 = svc.add_item(s2, 5, 240, 60, "PROMO_V1", OPERATOR)
    svc.attach_link(i5, cat.get(5).link_url, None, OPERATOR)
    cat.change_price(5, 25.9)
    svc.edit_script(i5, AUTHOR, "速干运动毛巾，吸水量是自重四倍。")
    svc.submit_script(i5, AUTHOR)
    svc.review_script(i5, SCRIPT_REVIEWER, True)
    svc.refresh_issues(s2)

    # 商品 7：样品不符
    i7 = svc.add_item(s2, 7, 300, 20, "PROMO_V3", OPERATOR)
    svc.attach_link(i7, cat.get(7).link_url, None, OPERATOR)
    svc.edit_script(i7, AUTHOR, "迷你暖手宝，随身充电两用。")
    svc.submit_script(i7, AUTHOR)
    svc.review_script(i7, SCRIPT_REVIEWER, True)
    svc.refresh_issues(s2)

    # 商品 1：脚本含违规词，审核不通过
    i1 = svc.add_item(s2, 1, 300, 50, "PROMO_V1", OPERATOR)
    svc.attach_link(i1, cat.get(1).link_url, None, OPERATOR)
    svc.edit_script(i1, AUTHOR, "全网最低价的居家袜，第一好用，史低！")
    svc.submit_script(i1, AUTHOR)
    # 审核员尝试通过会被违规词拦截；保持 submitted，旁边给审核提示
    svc.refresh_issues(s2)

    summary["sessions"] = {"live": s1, "planning": s2}
    summary["items_live"] = item_ids_a
    summary["links"] = link_of
    summary["planning_items"] = {"oos": i3, "dead_link": i6, "price": i5,
                                 "sample": i7, "violation": i1}
    conn.close()
    return summary


def main() -> None:
    reset = "--reset" in sys.argv
    summary = seed(reset=reset)
    if summary.get("skipped"):
        print("数据库已有演示数据，跳过。使用 --reset 可重建。")
        return
    print("✅ 演示数据已就绪")
    print(f"  已开播场次 S{summary['sessions']['live']}：发布快照 + 上架回调 + 临时撤品")
    print(f"  编排中场次 S{summary['sessions']['planning']}：缺货/链接失效/改价/样品不符/违规词")
    print(f"  发布回执：{', '.join(summary['receipts'])}")
    print(f"  回调样例：重复={summary['callbacks'][2]['status']}，"
          f"乱序={summary['callbacks'][3]['status']}（挂链仍 {summary['callbacks'][3]['link_status']}）")
    wd = summary["withdraw"]
    print(f"  撤品样例：排品项 {wd['item_id']} → 挂链 {wd['offline']['link_status']}，"
          f"已成交订单保留")


if __name__ == "__main__":
    main()
