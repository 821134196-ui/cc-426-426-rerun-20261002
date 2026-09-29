// 领域服务：所有业务规则集中在此，HTTP 层与测试共用。
import {
  catalogAdapter,
  reviewReceiptAdapter,
  publishAdapter,
  GLOBAL_BANNED,
} from './adapters.js';
import { randomUUID } from 'node:crypto';

const id = (p) => `${p}_${randomUUID().slice(0, 8)}`;
const now = () => new Date().toISOString();

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createServices(db) {
  // ---------- 直播间 / 场次 ----------
  function createRoom(name, anchorId) {
    const room = { id: id('room'), name, anchor_id: anchorId, created_at: now() };
    db.prepare('INSERT INTO rooms VALUES (?,?,?,?)').run(
      room.id, room.name, room.anchor_id, room.created_at,
    );
    return room;
  }

  function listRooms() {
    return db.prepare('SELECT * FROM rooms ORDER BY created_at').all();
  }

  function createSession(roomId, title, anchorId, startsAt) {
    const s = {
      id: id('ses'), room_id: roomId, title, anchor_id: anchorId,
      starts_at: startsAt, status: 'draft', published_at: null,
      published_snapshot: null, created_at: now(),
    };
    db.prepare(
      'INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(s.id, s.room_id, s.title, s.anchor_id, s.starts_at, s.status,
      s.published_at, s.published_snapshot, s.created_at);
    return getSession(s.id);
  }

  function getSession(sessionId) {
    return db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  }

  function listSessions() {
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY starts_at').all();
    return sessions.map((s) => ({ ...s, picks: listPicks(s.id) }));
  }

  // ---------- 商品资料审核 ----------
  function reviewProduct(productId, reviewerId, result, reason) {
    const product = catalogAdapter.get(productId);
    if (!product) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在');
    if (!['approved', 'rejected'].includes(result))
      throw new DomainError('BAD_RESULT', '审核结果非法');
    const row = {
      id: id('rev'), target_type: 'product', target_id: productId,
      session_id: null, reviewer_id: reviewerId, result, reason: reason || null,
      created_at: now(),
    };
    db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?)').run(
      row.id, row.target_type, row.target_id, row.session_id,
      row.reviewer_id, row.result, row.reason, row.created_at,
    );
    db.prepare(
      `INSERT INTO product_review_state(product_id,status,reviewer_id,reason,updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(product_id) DO UPDATE SET
         status=excluded.status, reviewer_id=excluded.reviewer_id,
         reason=excluded.reason, updated_at=excluded.updated_at`,
    ).run(productId, result, reviewerId, reason || null, now());
    return { review: row, receipt: reviewReceiptAdapter.submitProductReview(productId, reviewerId, result, reason) };
  }

  function productReviewState(productId) {
    return db.prepare('SELECT * FROM product_review_state WHERE product_id=?')
      .get(productId) || { product_id: productId, status: 'pending' };
  }

  // ---------- 排品 ----------
  function listPicks(sessionId) {
    const picks = db.prepare(
      'SELECT * FROM picks WHERE session_id=? ORDER BY position',
    ).all(sessionId);
    return picks.map((p) => ({
      ...p,
      product: catalogAdapter.get(p.product_id),
      review: productReviewState(p.product_id),
      link: p.link_id ? getLink(p.link_id) : null,
      script: getScript(p.id),
    }));
  }

  // 商品必须先通过资料审核才能加入排品
  function addPick(sessionId, productId, opts = {}) {
    const session = mustSession(sessionId);
    if (session.status !== 'draft')
      throw new DomainError('SESSION_LOCKED', '场次已开始或结束，排品已锁定');
    const state = productReviewState(productId);
    if (state.status !== 'approved')
      throw new DomainError('NOT_APPROVED', '商品资料未通过审核，不能加入排品');
    const dup = db.prepare(
      "SELECT id FROM picks WHERE session_id=? AND product_id=? AND status='planned'",
    ).get(sessionId, productId);
    if (dup) throw new DomainError('DUPLICATE_PICK', '该商品已在本场排品中');

    const max = db.prepare(
      'SELECT COALESCE(MAX(position),0) AS m FROM picks WHERE session_id=?',
    ).get(sessionId).m;
    const pick = {
      id: id('pick'), session_id: sessionId, product_id: productId,
      position: max + 1, duration_sec: opts.durationSec ?? 300,
      stock_hint: opts.stockHint ?? catalogAdapter.get(productId).stock,
      promo_version: opts.promoVersion || 'v1', link_id: null,
      status: 'planned', withdrawn_reason: null, created_at: now(),
    };
    db.prepare('INSERT INTO picks VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
      pick.id, pick.session_id, pick.product_id, pick.position,
      pick.duration_sec, pick.stock_hint, pick.promo_version, pick.link_id,
      pick.status, pick.withdrawn_reason, pick.created_at,
    );
    // 建排品即建空脚本，作者取传入或默认主播
    db.prepare('INSERT INTO scripts(id,pick_id,author_id,current_version,draft_content,published_version,published_content) VALUES (?,?,?,?,?,?,?)')
      .run(id('scr'), pick.id, opts.authorId || session.anchor_id, 0, '', null, null);
    return getPick(pick.id);
  }

  function getPick(pickId) {
    const p = db.prepare('SELECT * FROM picks WHERE id=?').get(pickId);
    if (!p) return null;
    return {
      ...p,
      product: catalogAdapter.get(p.product_id),
      review: productReviewState(p.product_id),
      link: p.link_id ? getLink(p.link_id) : null,
      script: getScript(p.id),
    };
  }

  function mustPick(pickId) {
    const p = getPick(pickId);
    if (!p) throw new DomainError('PICK_NOT_FOUND', '排品不存在');
    return p;
  }

  function updatePick(pickId, patch = {}) {
    const p = mustPick(pickId);
    const session = mustSession(p.session_id);
    if (session.status !== 'draft')
      throw new DomainError('SESSION_LOCKED', '场次已开始，不能修改排品');
    db.prepare(
      'UPDATE picks SET duration_sec=?, stock_hint=?, promo_version=? WHERE id=?',
    ).run(
      patch.durationSec ?? p.duration_sec,
      patch.stockHint ?? p.stock_hint,
      patch.promoVersion || p.promo_version,
      pickId,
    );
    return getPick(pickId);
  }

  function reorderPicks(sessionId, orderedIds) {
    const session = mustSession(sessionId);
    if (session.status !== 'draft')
      throw new DomainError('SESSION_LOCKED', '场次已开始，顺序已锁定');
    const stmt = db.prepare('UPDATE picks SET position=? WHERE id=? AND session_id=?');
    orderedIds.forEach((pickId, i) => stmt.run(i + 1, pickId, sessionId));
    return listPicks(sessionId);
  }

  // 临时撤品：仅草稿期可撤；进行中场次走 delist 回调流程
  function withdrawPick(pickId, reason, operatorId) {
    const p = mustPick(pickId);
    const session = mustSession(p.session_id);
    if (session.status === 'ended')
      throw new DomainError('SESSION_ENDED', '场次已结束');
    db.prepare("UPDATE picks SET status='withdrawn', withdrawn_reason=? WHERE id=?")
      .run(reason || '临时撤品', pickId);
    if (p.link_id) delistLink(p.link_id, operatorId, `撤品：${reason || ''}`);
    logIncident({
      sessionId: p.session_id, pickId: pickId, productId: p.product_id,
      kind: 'withdraw', detail: reason || '临时撤品',
    });
    return getPick(pickId);
  }

  // ---------- 讲解脚本与版本 ----------
  function getScript(pickId) {
    const s = db.prepare('SELECT * FROM scripts WHERE pick_id=?').get(pickId);
    if (!s) return null;
    const versions = db.prepare(
      'SELECT id,version,content,author_id,note,created_at FROM script_versions WHERE script_id=? ORDER BY version',
    ).all(s.id);
    return { ...s, versions };
  }

  function mustScriptByPick(pickId) {
    const s = getScript(pickId);
    if (!s) throw new DomainError('SCRIPT_NOT_FOUND', '脚本不存在');
    return s;
  }

  // 修改脚本即生成新版本；不触碰已发布版本
  function editScript(pickId, authorId, content, note) {
    const script = mustScriptByPick(pickId);
    const next = script.current_version + 1;
    db.prepare(
      'INSERT INTO script_versions VALUES (?,?,?,?,?,?,?)',
    ).run(id('sv'), script.id, next, content, authorId, note || null, now());
    db.prepare(
      'UPDATE scripts SET current_version=?, draft_content=? WHERE id=?',
    ).run(next, content, script.id);
    return getScript(pickId);
  }

  function scanBanned(content, productId) {
    const product = catalogAdapter.get(productId);
    const words = [
      ...GLOBAL_BANNED,
      ...(product ? product.bannedWords : []),
    ];
    return words.filter((w) => content.includes(w));
  }

  // 发布脚本：校验违规词
  function publishScript(pickId) {
    const pick = mustPick(pickId);
    const script = mustScriptByPick(pickId);
    if (script.current_version === 0)
      throw new DomainError('EMPTY_SCRIPT', '脚本还没有内容');
    const hits = scanBanned(script.draft_content, pick.product_id);
    if (hits.length)
      throw new DomainError('BANNED_WORD', `命中违规词：${hits.join('、')}`);
    db.prepare(
      'UPDATE scripts SET published_version=current_version, published_content=draft_content WHERE id=?',
    ).run(script.id);
    return getScript(pickId);
  }

  // 脚本审核：审核人不能审核自己编写（含历史编辑版本）的脚本
  function reviewScript(pickId, reviewerId, result, reason) {
    const script = mustScriptByPick(pickId);
    const own = script.author_id === reviewerId
      || script.versions.some((v) => v.author_id === reviewerId);
    if (own)
      throw new DomainError('SELF_REVIEW_FORBIDDEN', '不能审核自己编写的脚本');
    if (script.current_version === 0)
      throw new DomainError('EMPTY_SCRIPT', '脚本还没有内容');
    if (!['approved', 'rejected'].includes(result))
      throw new DomainError('BAD_RESULT', '审核结果非法');
    const row = {
      id: id('rev'), target_type: 'script', target_id: script.id,
      session_id: null, reviewer_id: reviewerId, result,
      reason: reason || null, created_at: now(),
    };
    db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?,?,?,?)').run(
      row.id, row.target_type, row.target_id, row.session_id,
      row.reviewer_id, row.result, row.reason, row.created_at,
    );
    return { review: row, receipt: reviewReceiptAdapter.submitScriptReview(script.id, reviewerId, result, reason) };
  }

  function latestScriptReview(scriptId) {
    return db.prepare(
      'SELECT * FROM reviews WHERE target_type=\'script\' AND target_id=? ORDER BY created_at DESC LIMIT 1',
    ).get(scriptId) || null;
  }

  // ---------- 挂链 ----------
  function getLink(linkId) {
    return db.prepare('SELECT * FROM links WHERE id=?').get(linkId) || null;
  }

  function listLinks(sessionId) {
    return db.prepare('SELECT * FROM links WHERE session_id=? ORDER BY created_at')
      .all(sessionId);
  }

  // 挂链唯一：同一场内同一商品只能有一条 active 挂链（DB 部分唯一索引兜底）
  // 价格校验：挂链价必须与商品当前价一致
  function createLink(sessionId, productId, url, priceCents) {
    mustSession(sessionId);
    const product = catalogAdapter.get(productId);
    if (!product) throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在');
    if (!/^https?:\/\/.+/.test(url))
      throw new DomainError('BAD_URL', '挂链地址无效');
    const price = Number(priceCents);
    if (!Number.isInteger(price) || price <= 0)
      throw new DomainError('BAD_PRICE', '挂链价格非法');
    if (price !== product.priceCents)
      throw new DomainError(
        'PRICE_MISMATCH',
        `挂链价 ${price} 与当前商品价 ${product.priceCents} 不一致`,
      );
    const exists = db.prepare(
      "SELECT id FROM links WHERE session_id=? AND product_id=? AND status='active'",
    ).get(sessionId, productId);
    if (exists) throw new DomainError('LINK_EXISTS', '该商品在本场已有有效挂链');
    const link = {
      id: id('link'), session_id: sessionId, product_id: productId,
      url, price_cents: price, status: 'active', created_at: now(),
    };
    try {
      db.prepare(
        'INSERT INTO links(id,session_id,product_id,url,price_cents,status,created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        link.id, link.session_id, link.product_id, link.url,
        link.price_cents, link.status, link.created_at,
      );
    } catch (e) {
      if (String(e.message).includes('UNIQUE'))
        throw new DomainError('LINK_EXISTS', '该商品在本场已有有效挂链');
      throw e;
    }
    return link;
  }

  function bindLink(pickId, linkId) {
    const pick = mustPick(pickId);
    const link = getLink(linkId);
    if (!link || link.session_id !== pick.session_id)
      throw new DomainError('LINK_NOT_FOUND', '挂链不存在或不属于本场');
    if (link.product_id !== pick.product_id)
      throw new DomainError('LINK_PRODUCT_MISMATCH', '挂链商品与排品不一致');
    db.prepare('UPDATE picks SET link_id=? WHERE id=?').run(linkId, pickId);
    return getPick(pickId);
  }

  function listLinkInternal(linkId) {
    return db.prepare('SELECT * FROM links WHERE id=?').get(linkId);
  }

  function delistLink(linkId, operatorId, reason) {
    const link = listLinkInternal(linkId);
    if (!link || link.status !== 'active') return link;
    db.prepare("UPDATE links SET status='delisted' WHERE id=?").run(linkId);
    db.prepare('INSERT INTO link_events(event_key,id,link_id,type,payload,processed_at) VALUES (?,?,?,?,?,?)')
      .run(`manual-delist-${linkId}-${Date.now()}`, id('evt'), linkId, 'delist',
        JSON.stringify({ operatorId, reason }), now());
    db.prepare("UPDATE picks SET link_id=NULL WHERE link_id=?").run(linkId);
    return listLinkInternal(linkId);
  }

  // 挂链检查：缺货 / 变价 / 链接失效 分别记录不同工单
  function checkLinks(sessionId) {
    mustSession(sessionId);
    const found = [];
    for (const link of listLinks(sessionId)) {
      if (link.status !== 'active') continue;
      const product = catalogAdapter.get(link.product_id);
      if (product.linkDead) {
        db.prepare("UPDATE links SET status='dead' WHERE id=?").run(link.id);
        db.prepare("UPDATE picks SET link_id=NULL WHERE link_id=?").run(link.id);
        found.push(logIncident({
          sessionId, productId: link.product_id, kind: 'link_dead',
          detail: `挂链 ${link.id} 已失效`,
        }));
        continue;
      }
      if (product.stock <= 0) {
        db.prepare("UPDATE links SET status='delisted' WHERE id=?").run(link.id);
        db.prepare("UPDATE picks SET link_id=NULL WHERE link_id=?").run(link.id);
        found.push(logIncident({
          sessionId, productId: link.product_id, kind: 'stockout',
          detail: `商品 ${product.name} 缺货，已自动下架挂链`,
        }));
        continue;
      }
      if (link.price_cents !== product.priceCents) {
        found.push(logIncident({
          sessionId, productId: link.product_id, kind: 'price_change',
          detail: `挂链价 ${link.price_cents} → 当前价 ${product.priceCents}，待确认`,
        }));
      }
    }
    return found;
  }

  function logIncident({ sessionId = null, pickId = null, productId, kind, detail }) {
    const row = {
      id: id('inc'), session_id: sessionId, pick_id: pickId,
      product_id: productId, kind, detail, status: 'open', created_at: now(),
    };
    db.prepare('INSERT INTO incidents VALUES (?,?,?,?,?,?,?,?)').run(
      row.id, row.session_id, row.pick_id, row.product_id, row.kind,
      row.detail, row.status, row.created_at,
    );
    return row;
  }

  function listIncidents(sessionId = null) {
    return sessionId
      ? db.prepare('SELECT * FROM incidents WHERE session_id=? ORDER BY created_at DESC').all(sessionId)
      : db.prepare('SELECT * FROM incidents ORDER BY created_at DESC').all();
  }

  function handleIncident(incidentId) {
    db.prepare("UPDATE incidents SET status='handled' WHERE id=?").run(incidentId);
    return db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentId);
  }

  // ---------- 样品 ----------
  function registerSample({ productId, sessionId = null, photoPath = null, conform, note }) {
    if (!catalogAdapter.get(productId))
      throw new DomainError('PRODUCT_NOT_FOUND', '商品不存在');
    const row = {
      id: id('smp'), product_id: productId, session_id: sessionId,
      received_at: now(), photo_path: photoPath, conform: conform ? 1 : 0,
      note: note || null, created_at: now(),
    };
    db.prepare('INSERT INTO samples VALUES (?,?,?,?,?,?,?,?)').run(
      row.id, row.product_id, row.session_id, row.received_at,
      row.photo_path, row.conform, row.note, row.created_at,
    );
    if (!conform) {
      logIncident({
        sessionId, productId, kind: 'sample_mismatch',
        detail: note || '样品与挂链资料不符',
      });
    }
    return row;
  }

  function listSamples(sessionId = null) {
    return sessionId
      ? db.prepare('SELECT * FROM samples WHERE session_id=? ORDER BY created_at DESC').all(sessionId)
      : db.prepare('SELECT * FROM samples ORDER BY created_at DESC').all();
  }

  // ---------- 发布前整场挂链校验 + 快照 ----------
  function validateSession(sessionId) {
    const session = mustSession(sessionId);
    const errors = [];
    const picks = listPicks(sessionId).filter((p) => p.status === 'planned');
    if (picks.length === 0)
      errors.push({ code: 'EMPTY', message: '本场没有可发布的排品' });
    for (const p of picks) {
      const where = `「${p.product.name}」#${p.position}`;
      if (p.review.status !== 'approved')
        errors.push({ code: 'NOT_APPROVED', pickId: p.id, message: `${where} 商品资料未过审` });
      if (!p.link)
        errors.push({ code: 'NO_LINK', pickId: p.id, message: `${where} 缺少挂链` });
      else if (p.link.status !== 'active')
        errors.push({ code: 'LINK_DEAD', pickId: p.id, message: `${where} 挂链${p.link.status === 'dead' ? '已失效' : '已下架'}` });
      else if (p.link.price_cents !== p.product.priceCents)
        errors.push({ code: 'PRICE_MISMATCH', pickId: p.id, message: `${where} 挂链价与当前价不一致` });
      const badSample = db.prepare(
        `SELECT i.id FROM incidents i
         WHERE i.product_id=? AND i.kind='sample_mismatch' AND i.status='open' LIMIT 1`,
      ).get(p.product_id);
      if (badSample)
        errors.push({ code: 'SAMPLE_MISMATCH', pickId: p.id, message: `${where} 样品不符未处理` });
      const s = p.script;
      if (!s || s.published_version == null)
        errors.push({ code: 'SCRIPT_NOT_PUBLISHED', pickId: p.id, message: `${where} 讲解脚本未发布` });
      else {
        const hits = scanBanned(s.published_content, p.product_id);
        if (hits.length)
          errors.push({ code: 'BANNED_WORD', pickId: p.id, message: `${where} 脚本命中违规词：${hits.join('、')}` });
        const rev = latestScriptReview(s.id);
        if (!rev || rev.result !== 'approved')
          errors.push({ code: 'SCRIPT_NOT_APPROVED', pickId: p.id, message: `${where} 脚本未审核通过` });
      }
    }
    // 挂链唯一性：同一链接不得绑给多个排品
    const seen = new Map();
    for (const p of picks) {
      if (!p.link) continue;
      if (seen.has(p.link.id))
        errors.push({ code: 'LINK_REUSED', message: `挂链 ${p.link.id} 被重复绑定` });
      seen.set(p.link.id, p.id);
    }
    return errors;
  }

  function buildSnapshot(session) {
    const picks = listPicks(session.id)
      .filter((p) => p.status === 'planned')
      .map((p) => ({
        pickId: p.id,
        position: p.position,
        durationSec: p.duration_sec,
        stockHint: p.stock_hint,
        promoVersion: p.promo_version,
        product: {
          id: p.product_id,
          name: p.product.name,
          brand: p.product.brand,
          image: p.product.image,
          priceCents: p.product.priceCents,
        },
        link: p.link && {
          id: p.link.id,
          url: p.link.url,
          priceCents: p.link.price_cents,
        },
        script: p.script && {
          publishedVersion: p.script.published_version,
          content: p.script.published_content,
        },
      }));
    return {
      sessionId: session.id,
      title: session.title,
      anchorId: session.anchor_id,
      startsAt: session.starts_at,
      builtAt: now(),
      picks,
    };
  }

  // 发布：校验整场挂链 -> 生成快照 -> 模拟适配器回执
  function publishSession(sessionId) {
    const session = mustSession(sessionId);
    if (session.status === 'live')
      throw new DomainError('ALREADY_LIVE', '场次已开始，继续使用发布快照，草稿不能覆盖');
    if (session.status === 'ended')
      throw new DomainError('SESSION_ENDED', '场次已结束');
    const errors = validateSession(sessionId);
    if (errors.length) throw new DomainError('PUBLISH_BLOCKED', JSON.stringify(errors));
    const snapshot = buildSnapshot(session);
    const receipt = publishAdapter.publish(sessionId, snapshot, `publish-${sessionId}`);
    db.prepare(
      'UPDATE sessions SET published_at=?, published_snapshot=? WHERE id=?',
    ).run(now(), JSON.stringify(snapshot), sessionId);
    db.prepare('INSERT OR IGNORE INTO publish_receipts VALUES (?,?,?,?)')
      .run(receipt.receiptNo, sessionId, JSON.stringify(snapshot), now());
    return { snapshot, receipt };
  }

  // 开场：锁定快照。开场后任何草稿修改都不影响进行中的场次
  function startSession(sessionId) {
    const session = mustSession(sessionId);
    if (!session.published_snapshot)
      throw new DomainError('NOT_PUBLISHED', '场次未发布，不能开始');
    db.prepare("UPDATE sessions SET status='live' WHERE id=?").run(sessionId);
    return getSession(sessionId);
  }

  function endSession(sessionId) {
    db.prepare("UPDATE sessions SET status='ended' WHERE id=?").run(sessionId);
    return getSession(sessionId);
  }

  function publishedSnapshot(sessionId) {
    const s = mustSession(sessionId);
    return s.published_snapshot ? JSON.parse(s.published_snapshot) : null;
  }

  // ---------- 订单（成交价快照，回调不得改价） ----------
  function createOrder(linkId) {
    const link = listLinkInternal(linkId);
    if (!link || link.status !== 'active')
      throw new DomainError('LINK_NOT_ACTIVE', '挂链不可下单');
    const order = {
      id: id('ord'), link_id: linkId, product_id: link.product_id,
      price_cents: link.price_cents, status: 'paid', created_at: now(),
    };
    db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)').run(
      order.id, order.link_id, order.product_id, order.price_cents,
      order.status, order.created_at,
    );
    return order;
  }

  function listOrders(linkId = null) {
    return linkId
      ? db.prepare('SELECT * FROM orders WHERE link_id=?').all(linkId)
      : db.prepare('SELECT * FROM orders ORDER BY created_at').all();
  }

  // ---------- 平台回调：幂等 + 乱序保护，不动已成交订单 ----------
  function processCallback(cb) {
    const link = listLinkInternal(cb.linkId);
    if (!link) throw new DomainError('LINK_NOT_FOUND', '挂链不存在');

    // 1) 重复回调：同一 event_key 只处理一次
    const seen = db.prepare('SELECT id FROM link_events WHERE event_key=?')
      .get(cb.eventKey);
    if (seen) return { duplicated: true, link: listLinkInternal(cb.linkId) };

    // 2) 乱序：按平台单调 seq，旧于已处理序号的事件丢弃
    const lastSeq = link.last_seq ?? 0;
    if (typeof cb.seq === 'number' && cb.seq < lastSeq) {
      return { stale: true, link };
    }

    let applied = false;
    switch (cb.type) {
      case 'list':
        if (link.status !== 'active') {
          db.prepare("UPDATE links SET status='active', last_seq=? WHERE id=?")
            .run(cb.seq ?? link.last_seq, link.id);
          applied = true;
        }
        break;
      case 'delist':
        if (link.status === 'active') {
          db.prepare("UPDATE links SET status='delisted', last_seq=? WHERE id=?")
            .run(cb.seq ?? link.last_seq, link.id);
          db.prepare("UPDATE picks SET link_id=NULL WHERE link_id=?").run(link.id);
          applied = true;
        }
        break;
      case 'price_change': {
        // 只改挂链当前价；已成交订单价格不动
        const newPrice = cb.payload?.priceCents;
        if (Number.isInteger(newPrice) && newPrice > 0
          && newPrice !== link.price_cents) {
          db.prepare('UPDATE links SET price_cents=?, last_seq=? WHERE id=?')
            .run(newPrice, cb.seq ?? link.last_seq, link.id);
          applied = true;
        }
        break;
      }
      case 'link_dead':
        if (link.status === 'active') {
          db.prepare("UPDATE links SET status='dead', last_seq=? WHERE id=?")
            .run(cb.seq ?? link.last_seq, link.id);
          db.prepare("UPDATE picks SET link_id=NULL WHERE link_id=?").run(link.id);
          applied = true;
        }
        break;
      case 'stockout':
        if (link.status === 'active') {
          db.prepare("UPDATE links SET status='delisted', last_seq=? WHERE id=?")
            .run(cb.seq ?? link.last_seq, link.id);
          db.prepare("UPDATE picks SET link_id=NULL WHERE link_id=?").run(link.id);
          applied = true;
        }
        break;
      default:
        throw new DomainError('BAD_EVENT', `未知回调类型 ${cb.type}`);
    }
    db.prepare('INSERT INTO link_events VALUES (?,?,?,?,?,?)')
      .run(id('evt'), cb.eventKey, cb.linkId, cb.type,
        JSON.stringify(cb.payload || {}), now());
    return { applied, duplicated: false, stale: false, link: listLinkInternal(cb.linkId) };
  }

  function listEvents(linkId = null) {
    return linkId
      ? db.prepare('SELECT * FROM link_events WHERE link_id=? ORDER BY processed_at').all(linkId)
      : db.prepare('SELECT * FROM link_events ORDER BY processed_at').all();
  }

  function mustSession(sessionId) {
    const s = getSession(sessionId);
    if (!s) throw new DomainError('SESSION_NOT_FOUND', '场次不存在');
    return s;
  }

  return {
    createRoom, listRooms,
    createSession, getSession, listSessions, startSession, endSession,
    publishedSnapshot,
    reviewProduct, productReviewState,
    addPick, getPick, listPicks, updatePick, reorderPicks, withdrawPick,
    editScript, publishScript, reviewScript, getScript, scanBanned,
    createLink, getLink, bindLink, listLinks, delistLink, checkLinks,
    listIncidents, handleIncident,
    registerSample, listSamples,
    validateSession, publishSession,
    createOrder, listOrders, processCallback, listEvents,
  };
}
