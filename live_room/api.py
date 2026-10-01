"""HTTP API：基于标准库 http.server，零依赖。

所有 POST 接收 / 返回 JSON。样品照片上传用 JSON + base64。
操作者通过请求头 X-Operator 传入（演示），缺省为「运营-小鹿」。
"""
from __future__ import annotations

import base64
import json
import os
import re
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from . import domain as D
from .adapters import catalog, receipts
from .db import connect, init_db, query_all
from .services import LiveRoomService

ROOT = os.path.dirname(os.path.dirname(__file__))
WEB_DIR = os.path.join(os.path.dirname(__file__), "web")
IMG_DIR = os.path.join(ROOT, "data", "img")
SAMPLE_DIR = os.path.join(ROOT, "data", "samples")

DEFAULT_OPERATOR = "运营-小鹿"


def build_service() -> LiveRoomService:
    conn = connect()
    init_db(conn)
    return LiveRoomService(conn, catalog, receipts, SAMPLE_DIR)


# 简单的 (method, path-regex) -> handler
class Router:
    def __init__(self) -> None:
        self.routes: list[tuple[str, re.Pattern, object]] = []

    def add(self, method: str, pattern: str):
        rx = re.compile("^" + pattern + "$")

        def deco(fn):
            self.routes.append((method, rx, fn))
            return fn
        return deco

    def match(self, method: str, path: str):
        for m, rx, fn in self.routes:
            if m != method:
                continue
            mat = rx.match(path)
            if mat:
                return fn, mat.groupdict()
        return None, None


router = Router()


# ---- 产品 / 主播 / 优惠 ----
@router.add("GET", r"/api/meta")
def _meta(svc, p, body):
    from .db import query_all as qa
    return {
        "banned_words": list(D.BANNED_WORDS),
        "promos": [dict(r) for r in qa(svc.conn, "SELECT * FROM promos")],
        "anchors": [a.__dict__ for a in catalog.list_anchors()],
    }


@router.add("GET", r"/api/products")
def _products(svc, p, body):
    return {"products": [p_.__dict__ for p_ in catalog.list_products()],
            "anchors": [a.__dict__ for a in catalog.list_anchors()],
            "promos": [dict(r) for r in query_all(svc.conn, "SELECT * FROM promos")]}


@router.add("GET", r"/api/products/(?P<pid>\d+)")
def _product(svc, p, body):
    prod = catalog.as_dict(int(p["pid"]))
    prod["material"] = svc.material_status(int(p["pid"]))
    prod["samples"] = svc.list_samples(int(p["pid"]))
    return prod


@router.add("POST", r"/api/products/(?P<pid>\d+)/material/(?P<act>submit|approve|reject)")
def _material(svc, p, body):
    pid = int(p["pid"])
    op = body.get("operator") or DEFAULT_OPERATOR
    if p["act"] == "submit":
        return svc.submit_material(pid, op)
    if p["act"] == "approve":
        return svc.approve_material(pid, body.get("reviewer", "审核-阿岚"))
    return svc.reject_material(pid, body.get("reviewer", "审核-阿岚"),
                               body.get("reason", ""))


@router.add("POST", r"/api/products/(?P<pid>\d+)/sample")
def _sample(svc, p, body):
    pid = int(p["pid"])
    raw = base64.b64decode(body["photo_base64"])
    return svc.register_sample(
        pid, body.get("operator") or "仓管-阿May", body.get("filename", "sample.svg"),
        raw, note=body.get("note", ""), mismatch=bool(body.get("mismatch")),
        item_id=body.get("item_id"),
    )


@router.add("GET", r"/api/samples")
def _samples_all(svc, p, body):
    return {"samples": svc.list_samples(None)}


@router.add("POST", r"/api/demo/(?P<kind>price|stock|link)")
def _demo(svc, p, body):
    pid = int(body["product_id"])
    if p["kind"] == "price":
        return catalog.change_price(pid, float(body["price"])).__dict__
    if p["kind"] == "stock":
        return catalog.set_stock(pid, int(body["stock"])).__dict__
    return catalog.set_link_ok(pid, bool(body["ok"])).__dict__


# ---- 场次 ----
@router.add("GET", r"/api/sessions")
def _sessions(svc, p, body):
    return {"sessions": svc.list_sessions()}


@router.add("POST", r"/api/sessions")
def _create_session(svc, p, body):
    sid = svc.create_session(
        body["title"], int(body["anchor_id"]), body["starts_at"],
        body.get("operator") or DEFAULT_OPERATOR)
    return {"id": sid}


@router.add("GET", r"/api/sessions/(?P<sid>\d+)/timeline")
def _timeline(svc, p, body):
    return svc.timeline(int(p["sid"]))


@router.add("GET", r"/api/sessions/(?P<sid>\d+)/check")
def _check(svc, p, body):
    return svc.check_session_links(int(p["sid"]))


@router.add("POST", r"/api/sessions/(?P<sid>\d+)/refresh")
def _refresh(svc, p, body):
    return svc.refresh_issues(int(p["sid"]), body.get("operator", "system"))


@router.add("POST", r"/api/sessions/(?P<sid>\d+)/publish")
def _publish(svc, p, body):
    return svc.publish(int(p["sid"]), body.get("operator") or DEFAULT_OPERATOR,
                       force=bool(body.get("force")))


@router.add("POST", r"/api/sessions/(?P<sid>\d+)/(?P<act>start|end)")
def _lifecycle(svc, p, body):
    sid = int(p["sid"])
    op = body.get("operator") or DEFAULT_OPERATOR
    (svc.start_session if p["act"] == "start" else svc.end_session)(sid, op)
    return {"ok": True}


@router.add("POST", r"/api/sessions/(?P<sid>\d+)/items")
def _add_item(svc, p, body):
    iid = svc.add_item(
        int(p["sid"]), int(body["product_id"]), int(body["duration_sec"]),
        int(body["stock_alert"]), body["promo_version"],
        body.get("operator") or DEFAULT_OPERATOR)
    if body.get("url"):
        svc.attach_link(iid, body["url"], body.get("listed_price"),
                        body.get("operator") or DEFAULT_OPERATOR)
    return {"id": iid}


@router.add("POST", r"/api/sessions/(?P<sid>\d+)/reorder")
def _reorder(svc, p, body):
    svc.reorder_items(int(p["sid"]), [int(x) for x in body["order"]],
                      body.get("operator") or DEFAULT_OPERATOR)
    return {"ok": True}


# ---- 排品项 ----
@router.add("POST", r"/api/items/(?P<iid>\d+)/update")
def _update_item(svc, p, body):
    fields = {k: body[k] for k in ("duration_sec", "stock_alert", "promo_version")
              if k in body}
    svc.update_item(int(p["iid"]), body.get("operator") or DEFAULT_OPERATOR, **fields)
    return {"ok": True}


@router.add("POST", r"/api/items/(?P<iid>\d+)/withdraw")
def _withdraw(svc, p, body):
    return svc.withdraw_item(int(p["iid"]), body.get("operator") or DEFAULT_OPERATOR,
                             body.get("note", "临时撤品"))


@router.add("POST", r"/api/items/(?P<iid>\d+)/resolve")
def _resolve(svc, p, body):
    svc.resolve_issue(int(p["iid"]), body.get("operator") or DEFAULT_OPERATOR,
                      body.get("note", "已处理"))
    return {"ok": True}


# ---- 脚本 ----
@router.add("GET", r"/api/items/(?P<iid>\d+)/script")
def _script_get(svc, p, body):
    return svc.script_overview(int(p["iid"]))


@router.add("POST", r"/api/items/(?P<iid>\d+)/script/edit")
def _script_edit(svc, p, body):
    return svc.edit_script(int(p["iid"]), body.get("author", "编导-小晚"),
                           body["content"], body.get("operator"))


@router.add("POST", r"/api/items/(?P<iid>\d+)/script/submit")
def _script_submit(svc, p, body):
    return svc.submit_script(int(p["iid"]), body.get("operator") or "编导-小晚")


@router.add("POST", r"/api/items/(?P<iid>\d+)/script/review")
def _script_review(svc, p, body):
    return svc.review_script(int(p["iid"]), body["reviewer"],
                             bool(body["approve"]), body.get("note", ""))


# ---- 挂链 / 回调 ----
@router.add("POST", r"/api/items/(?P<iid>\d+)/link")
def _attach(svc, p, body):
    lid = svc.attach_link(int(p["iid"]), body["url"],
                          body.get("listed_price"), body.get("operator") or DEFAULT_OPERATOR)
    return {"id": lid}


@router.add("POST", r"/api/items/(?P<iid>\d+)/link/sync")
def _sync(svc, p, body):
    return svc.sync_link_price(int(p["iid"]), body.get("operator") or DEFAULT_OPERATOR)


@router.add("POST", r"/api/links/(?P<lid>\d+)/callback")
def _callback(svc, p, body):
    return svc.platform_callback(int(p["lid"]), body["event_type"],
                                 body["event_id"], int(body["seq"]))


@router.add("POST", r"/api/links/(?P<lid>\d+)/order")
def _order(svc, p, body):
    return svc.simulate_order(int(p["lid"]), int(body.get("qty", 1)))


# ---- 回执 / 流水 ----
@router.add("GET", r"/api/receipts")
def _receipts(svc, p, body):
    return {"receipts": svc.list_receipts()}


@router.add("GET", r"/api/audit")
def _audit(svc, p, body):
    return {"logs": svc.list_audit_logs(80)}


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "LiveRoomDemo/1.0"

    def log_message(self, fmt, *args):  # 安静一点
        pass

    def _send_json(self, obj, status: int = 200) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            raise D.ValidationFailed("请求体不是合法 JSON")

    def _serve_file(self, fs_path: str, ctype: str) -> bool:
        if not os.path.isfile(fs_path):
            return False
        with open(fs_path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)
        return True

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        fn, params = router.match("GET", path)
        if fn:
            return self._dispatch(fn, params, {})
        # 静态资源
        if path == "/" or path == "/index.html":
            if self._serve_file(os.path.join(WEB_DIR, "index.html"),
                                "text/html; charset=utf-8"):
                return
        static_map = [
            ("/static/app.js", os.path.join(WEB_DIR, "app.js"), "text/javascript; charset=utf-8"),
            ("/static/app.css", os.path.join(WEB_DIR, "app.css"), "text/css; charset=utf-8"),
        ]
        for url, fpath, ctype in static_map:
            if path == url:
                if self._serve_file(fpath, ctype):
                    return
        if path.startswith("/static/img/"):
            name = os.path.basename(path)
            if self._serve_file(os.path.join(IMG_DIR, name), "image/svg+xml"):
                return
        if path.startswith("/samples/"):
            name = os.path.basename(path)
            if self._serve_file(os.path.join(SAMPLE_DIR, name), "image/svg+xml"):
                return
        self._send_json({"error": "not found", "path": path}, 404)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        fn, params = router.match("POST", path)
        if not fn:
            self._send_json({"error": "not found", "path": path}, 404)
            return
        try:
            body = self._read_body()
        except D.ValidationFailed as e:
            self._send_json({"error": str(e), "code": e.code}, 400)
            return
        self._dispatch(fn, params, body)

    def _dispatch(self, fn, params, body) -> None:
        svc = build_service()
        try:
            result = fn(svc, params, body)
            self._send_json(result if result is not None else {"ok": True})
        except D.PermissionDenied as e:
            self._send_json({"error": str(e), "code": e.code}, 403)
        except D.ValidationFailed as e:
            self._send_json({"error": str(e), "code": e.code,
                             "details": getattr(e, "details", None)}, 422)
        except D.ConflictState as e:
            self._send_json({"error": str(e), "code": e.code}, 409)
        except D.NotFound as e:
            self._send_json({"error": str(e), "code": e.code}, 404)
        except KeyError as e:
            self._send_json({"error": f"演示资源不存在: {e}"}, 404)
        finally:
            svc.conn.close()
