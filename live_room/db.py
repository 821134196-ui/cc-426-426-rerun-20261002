"""SQLite 连接、建表与小型查询辅助。

脚本与版本、场次快照、挂链、审核记录全部持久化到 SQLite；
商品 / 主播 / 价格来自进程内模拟适配器（见 adapters.py）。
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterator

DEFAULT_DB_PATH = os.environ.get(
    "LIVE_ROOM_DB", os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "live_room.db")
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS anchors (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    account     TEXT NOT NULL UNIQUE
);

-- 商品主数据由模拟适配器提供，这里只缓存排品需要的快照字段
CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    image       TEXT NOT NULL,
    category    TEXT NOT NULL,
    demo_price  REAL NOT NULL
);

-- 商品资料审核单（一个商品一条有效单）
CREATE TABLE IF NOT EXISTS material_reviews (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    submitted_by    TEXT NOT NULL,          -- 提交人（脚本作者之外的资料角色）
    reviewer        TEXT,
    reason          TEXT,
    created_at      TEXT NOT NULL,
    reviewed_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    anchor_id   INTEGER NOT NULL REFERENCES anchors(id),
    starts_at   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'planning',   -- planning/published/live/ended
    created_at  TEXT NOT NULL,
    published_at TEXT,
    started_at  TEXT,
    ended_at    TEXT
);

-- 场次发布快照：发布时冻结的整场排品 JSON
CREATE TABLE IF NOT EXISTS session_snapshots (
    session_id  INTEGER PRIMARY KEY REFERENCES sessions(id),
    payload     TEXT NOT NULL,                  -- JSON: 排品项 + 脚本版本号 + 价格
    version     INTEGER NOT NULL,               -- 快照内的脚本大版本
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions(id),
    product_id      INTEGER NOT NULL,
    position        INTEGER NOT NULL,           -- 横向时间轴顺序
    duration_sec    INTEGER NOT NULL,           -- 讲解时长
    stock_alert     INTEGER NOT NULL,           -- 库存提示阈值
    promo_version   TEXT NOT NULL,              -- 优惠版本
    script_id       INTEGER REFERENCES scripts(id),
    issue           TEXT NOT NULL DEFAULT 'none',
    issue_note      TEXT,
    withdrawn       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    UNIQUE(session_id, position)
);

-- 挂链：一个排品项至多一条有效挂链（partial unique index）
CREATE TABLE IF NOT EXISTS links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL REFERENCES session_items(id),
    url             TEXT NOT NULL,
    listed_price    REAL NOT NULL,              -- 挂链价格（发布/上架校验）
    status          TEXT NOT NULL DEFAULT 'draft',  -- draft/live/taken_down/dead
    online_event_id TEXT,                       -- 幂等键：上架回调
    offline_event_id TEXT,                      -- 幂等键：下架回调
    listed_at       TEXT,
    taken_down_at   TEXT,
    order_count     INTEGER NOT NULL DEFAULT 0  -- 已成交订单数（演示）
);
-- 每个排品项至多一条挂链记录（撤品后也不重复创建）
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_item ON links(item_id);
-- 同一 URL 在同一场次内只能挂一次（服务层校验，索引辅助去重排查）
CREATE INDEX IF NOT EXISTS idx_links_url ON links(url);

-- 优惠规则 / 版本（演示数据）
CREATE TABLE IF NOT EXISTS promos (
    code            TEXT PRIMARY KEY,           -- 场次排品上记录的优惠版本
    label           TEXT NOT NULL,
    description     TEXT NOT NULL,
    discount_amount REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scripts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL REFERENCES session_items(id),
    current_version INTEGER NOT NULL DEFAULT 1,
    approved_version INTEGER,                   -- 最近一次审核通过的版本（快照取它）
    author          TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(item_id)
);

CREATE TABLE IF NOT EXISTS script_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id       INTEGER NOT NULL REFERENCES scripts(id),
    version         INTEGER NOT NULL,
    content         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft',  -- draft/submitted/approved/rejected
    author          TEXT NOT NULL,
    reviewer        TEXT,
    review_note     TEXT,
    created_at      TEXT NOT NULL,
    reviewed_at     TEXT,
    UNIQUE(script_id, version)
);

-- 样品：本地目录保存照片
CREATE TABLE IF NOT EXISTS samples (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL,
    item_id         INTEGER REFERENCES session_items(id),
    received_by     TEXT NOT NULL,
    photo_path      TEXT NOT NULL,
    note            TEXT,
    match_status    TEXT NOT NULL DEFAULT 'ok',  -- ok/mismatch
    created_at      TEXT NOT NULL
);

-- 审核/操作流水
CREATE TABLE IF NOT EXISTS audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    ref_type    TEXT NOT NULL,          -- product/script/session/link/item
    ref_id      INTEGER,
    operator    TEXT NOT NULL,
    detail      TEXT,                   -- JSON
    created_at  TEXT NOT NULL
);

-- 外部回调台账：幂等去重 + 乱序判定
CREATE TABLE IF NOT EXISTS callbacks (
    event_id    TEXT PRIMARY KEY,       -- 平台回调事件 ID（幂等键）
    link_id     INTEGER NOT NULL REFERENCES links(id),
    event_type  TEXT NOT NULL,          -- online/offline
    seq         INTEGER NOT NULL,       -- 平台单调序号（用于乱序判定）
    status      TEXT NOT NULL,          -- processed/duplicate/stale
    created_at  TEXT NOT NULL,
    processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_callbacks_link ON callbacks(link_id);
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def connect(db_path: str | None = None) -> sqlite3.Connection:
    path = db_path or DEFAULT_DB_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def query_one(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> sqlite3.Row | None:
    return conn.execute(sql, params).fetchone()


def query_all(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    return conn.execute(sql, params).fetchall()


def insert(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> int:
    cur = conn.execute(sql, params)
    return int(cur.lastrowid)


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None
