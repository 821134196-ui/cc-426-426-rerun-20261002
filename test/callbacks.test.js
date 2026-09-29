import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makePublishable, expectError } from './helpers.js';
import { catalogAdapter } from '../src/adapters.js';

// ---------- 回调乱序 / 重复 / 订单保护 ----------
test('重复回调只处理一次，不重复上下架', () => {
  const { svc, session } = makeEnv();
  const { link } = makePublishable(svc, session.id, 'p2');

  const delist = { eventKey: 'k-1', linkId: link.id, type: 'delist', seq: 1 };
  const r1 = svc.processCallback(delist);
  assert.equal(r1.applied, true);
  assert.equal(svc.getLink(link.id).status, 'delisted');

  // 完全相同的回调（平台重试）
  const r2 = svc.processCallback(delist);
  assert.equal(r2.duplicated, true);
  // 重复后状态不变，事件只有一条
  assert.equal(svc.getLink(link.id).status, 'delisted');
  assert.equal(svc.listEvents(link.id).length, 1);

  // 重复 list 也不能把已下架链接重新上架（同 eventKey）
  const r3 = svc.processCallback({ eventKey: 'k-1', linkId: link.id, type: 'list', seq: 1 });
  assert.equal(r3.duplicated, true);
  assert.equal(svc.getLink(link.id).status, 'delisted');
});

test('乱序回调：旧序号事件被丢弃，最终态以新事件为准', () => {
  const { svc, session } = makeEnv();
  const { link } = makePublishable(svc, session.id, 'p2');

  // 先发 seq=3 变价，再乱序到达 seq=2 的下架
  const rNew = svc.processCallback({
    eventKey: 'k-new', linkId: link.id, type: 'price_change', seq: 3, payload: { priceCents: 5900 },
  });
  assert.equal(rNew.applied, true);
  const rStale = svc.processCallback({
    eventKey: 'k-old', linkId: link.id, type: 'delist', seq: 2,
  });
  assert.equal(rStale.stale, true);
  assert.equal(svc.getLink(link.id).status, 'active');
  assert.equal(svc.getLink(link.id).price_cents, 5900);

  // seq=4 正常下架生效
  const r4 = svc.processCallback({ eventKey: 'k-4', linkId: link.id, type: 'delist', seq: 4 });
  assert.equal(r4.applied, true);
  assert.equal(svc.getLink(link.id).status, 'delisted');
});

test('回调变价不改变已成交订单价格；下架后旧订单仍保留', () => {
  const { svc, session } = makeEnv();
  const { link } = makePublishable(svc, session.id, 'p1');
  const dealPrice = catalogAdapter.get('p1').priceCents;

  const order = svc.createOrder(link.id);
  assert.equal(order.price_cents, dealPrice);

  // 平台多次变价回调（含重复）
  svc.processCallback({ eventKey: 'pc-1', linkId: link.id, type: 'price_change', seq: 1, payload: { priceCents: 1 } });
  svc.processCallback({ eventKey: 'pc-1', linkId: link.id, type: 'price_change', seq: 1, payload: { priceCents: 1 } });
  svc.processCallback({ eventKey: 'pc-2', linkId: link.id, type: 'price_change', seq: 2, payload: { priceCents: 19900 } });
  // 随后下架
  svc.processCallback({ eventKey: 'dl-1', linkId: link.id, type: 'delist', seq: 3 });

  const orders = svc.listOrders(link.id);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].price_cents, dealPrice, '成交价快照不变');
  assert.equal(orders[0].status, 'paid');
});

test('缺货/失效回调都会下架并解绑排品，且只生效一次', () => {
  const { svc, session } = makeEnv();
  const { pick, link } = makePublishable(svc, session.id, 'p5');
  const cb = { eventKey: 'so-1', linkId: link.id, type: 'stockout', seq: 1 };
  svc.processCallback(cb);
  svc.processCallback(cb); // 重复
  assert.equal(svc.getLink(link.id).status, 'delisted');
  assert.equal(svc.getPick(pick.id).link, null);
  assert.equal(svc.listEvents(link.id).length, 1);
});

// ---------- 审核权限 ----------
test('审核人不能审核自己编写的脚本（作者与历史编辑者均拦截）', () => {
  const { svc, session } = makeEnv();
  svc.reviewProduct('p1', 'r2', 'approved');
  const pick = svc.addPick(session.id, 'p1', { authorId: 'a1' });
  svc.editScript(pick.id, 'a1', '主播写的话术');

  // 作者自审
  assert.throws(() => svc.reviewScript(pick.id, 'a1', 'approved'), expectError('SELF_REVIEW_FORBIDDEN'));
  // 其他审核人可以审
  assert.doesNotThrow(() => svc.reviewScript(pick.id, 'r1', 'approved'));

  // r1 接手改过一版后，r1 也不能再审
  svc.editScript(pick.id, 'r1', '审核人帮忙改的一版');
  assert.throws(() => svc.reviewScript(pick.id, 'r1', 'approved'), expectError('SELF_REVIEW_FORBIDDEN'));
  // r2 未参与编写，可审
  assert.doesNotThrow(() => svc.reviewScript(pick.id, 'r2', 'approved'));
});

test('空脚本不能审核也不能发布', () => {
  const { svc, session } = makeEnv();
  svc.reviewProduct('p2', 'r1', 'approved');
  const pick = svc.addPick(session.id, 'p2', { authorId: 'a1' });
  assert.throws(() => svc.reviewScript(pick.id, 'r1', 'approved'), expectError('EMPTY_SCRIPT'));
  assert.throws(() => svc.publishScript(pick.id), expectError('EMPTY_SCRIPT'));
});

// ---------- 撤品与发布校验 ----------
test('临时撤品自动下架挂链，发布快照不含撤品', () => {
  const { svc, session } = makeEnv();
  const a = makePublishable(svc, session.id, 'p1');
  const b = makePublishable(svc, session.id, 'p2');
  svc.withdrawPick(b.pick.id, '商家临时调价', 'a1');
  assert.equal(svc.getLink(b.link.id).status, 'delisted');

  const errors = svc.validateSession(session.id);
  assert.equal(errors.length, 0);
  const { snapshot } = svc.publishSession(session.id);
  assert.deepEqual(snapshot.picks.map((p) => p.product.id), ['p1']);
  assert.ok(a.pick.id);
});

test('发布前整场校验：缺挂链/脚本未发布/未过审逐项拦截', () => {
  const { svc, session } = makeEnv();
  // p1 完整可发布
  makePublishable(svc, session.id, 'p1');
  // p2 只排品，不挂链不发脚本
  svc.reviewProduct('p2', 'r1', 'approved');
  const bad = svc.addPick(session.id, 'p2', { authorId: 'a1' });

  const codes = svc.validateSession(session.id).map((e) => e.code);
  assert.ok(codes.includes('NO_LINK'));
  assert.ok(codes.includes('SCRIPT_NOT_PUBLISHED'));
  assert.throws(() => svc.publishSession(session.id), expectError('PUBLISH_BLOCKED'));
  assert.ok(bad.id);
});

test('发布幂等：同一场次重复发布返回同一回执号', () => {
  const { svc, session } = makeEnv();
  makePublishable(svc, session.id, 'p5');
  const r1 = svc.publishSession(session.id);
  const r2 = svc.publishSession(session.id);
  assert.equal(r2.receipt.receiptNo, r1.receipt.receiptNo);
});
