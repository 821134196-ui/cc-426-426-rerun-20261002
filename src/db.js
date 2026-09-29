// SQLite 存储层：场次 / 排品 / 脚本版本 / 审核 / 挂链 / 样品 / 回调幂等
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance = null;

export function openDb(path = process.env.LIVEPICK_DB || 'data/livepick.db') {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  dbInstance = db;
  return db;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// 仅供测试：在独立文件上打开全新连接
export function freshDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    anchor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    title TEXT NOT NULL,
    anchor_id TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | live | ended
    published_at TEXT,
    published_snapshot TEXT,                -- 发布快照 JSON
    created_at TEXT NOT NULL
  );

  -- 场次内的排品条目（横向时间轴一格）
  CREATE TABLE IF NOT EXISTS picks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    position INTEGER NOT NULL,              -- 商品顺序
    duration_sec INTEGER NOT NULL,          -- 讲解时长
    stock_hint INTEGER NOT NULL,            -- 库存提示（讲解时口播值）
    promo_version TEXT NOT NULL DEFAULT 'v1', -- 优惠版本
    link_id TEXT,                           -- 绑定的挂链
    status TEXT NOT NULL DEFAULT 'planned',-- planned | withdrawn
    withdrawn_reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, position)
  );

  -- 讲解脚本：一个排品条目一条工作脚本，修改即产生新版本
  CREATE TABLE IF NOT EXISTS scripts (
    id TEXT PRIMARY KEY,
    pick_id TEXT NOT NULL UNIQUE REFERENCES picks(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    current_version INTEGER NOT NULL DEFAULT 0,
    draft_content TEXT NOT NULL DEFAULT '',
    published_version INTEGER,              -- 已发布版本号；场次已开始后锁定快照
    published_content TEXT
  );

  CREATE TABLE IF NOT EXISTS script_versions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    author_id TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, version)
  );

  -- 审核记录：商品资料审核 + 脚本审核共用
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL,             -- product | script
    target_id TEXT NOT NULL,               -- 商品 id 或脚本 id
    session_id TEXT,
    reviewer_id TEXT NOT NULL,
    result TEXT NOT NULL,                  -- approved | rejected
    reason TEXT,
    created_at TEXT NOT NULL
  );

  -- 商品资料审核状态缓存（演示商品来自进程内适配器，这里只存审核结论）
  CREATE TABLE IF NOT EXISTS product_review_state (
    product_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    reviewer_id TEXT,
    reason TEXT,
    updated_at TEXT NOT NULL
  );

  -- 挂链：一个商品在一场内只能有一条有效挂链（部分唯一索引）
  CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    url TEXT NOT NULL,
    price_cents INTEGER NOT NULL,          -- 挂链价（与商品当前价校验）
    status TEXT NOT NULL DEFAULT 'active', -- active | dead | delisted
    last_seq INTEGER NOT NULL DEFAULT 0,   -- 已处理回调的最大序号（乱序保护）
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_links_alive
    ON links(session_id, product_id) WHERE status = 'active';

  -- 挂链上下架 / 回调事件（幂等：event_key 唯一）
  CREATE TABLE IF NOT EXISTS link_events (
    id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL UNIQUE,
    link_id TEXT NOT NULL,
    type TEXT NOT NULL,                     -- list | delist | price_change | link_dead | stockout
    payload TEXT,
    processed_at TEXT NOT NULL
  );

  -- 已成交订单：回调不得改变
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'paid',    -- paid | fulfilled
    created_at TEXT NOT NULL
  );

  -- 样品登记，照片保存在本地目录
  CREATE TABLE IF NOT EXISTS samples (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    session_id TEXT,
    received_at TEXT NOT NULL,
    photo_path TEXT,
    conform INTEGER NOT NULL DEFAULT 1,     -- 样品是否与挂链一致
    note TEXT,
    created_at TEXT NOT NULL
  );

  -- 商品异常工单：缺货 / 变价 / 链接失效 / 样品不符 / 违规词 / 临时撤品
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    pick_id TEXT,
    product_id TEXT NOT NULL,
    kind TEXT NOT NULL,   -- stockout | price_change | link_dead | sample_mismatch | banned_word | withdraw
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'open',   -- open | handled
    created_at TEXT NOT NULL
  );

  -- 发布回执（模拟适配器返回）
  CREATE TABLE IF NOT EXISTS publish_receipts (
    receipt_no TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `);
}
