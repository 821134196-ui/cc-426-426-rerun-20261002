import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makePublishable, expectError } from './helpers.js';
import { catalogAdapter } from '../src/adapters.js';

// ---------- 挂链唯一 ----------
test('同一场内同一商品只能有一条 active 挂链', () => {
  const { svc, session } = makeEnv();
  svc.reviewProduct('p1', 'r1', 'approved');
  const l1 = svc.createLink(session.id, 'p1', 'https://x.test/a', 8900);
  assert.equal(l1.status, 'active');
  assert.throws(
    () => svc.createLink(session.id, 'p1', 'https://x.test/b', 8900),
    expectError('LINK_EXISTS'),
  );

  // 下架后才能新建；旧链不再占用唯一名额
  svc.delistLink(l1.id, 'a1', '换链接');
  const l2 = svc.createLink(session.id, 'p1', 'https://x.test/c', 8900);
  assert.ok(l2.id !== l1.id);
});

test('DB 部分唯一索引兜底：绕过服务直接插入也会失败', () => {
  const { db, svc, session } = makeEnv();
  svc.createLink(session.id, 'p2', 'https://x.test/1', 6900);
  assert.throws(() => {
    db.prepare("INSERT INTO links(id,session_id,product_id,url,price_cents,status,created_at) VALUES ('x',?,?,?,?, 'active','t')")
      .run(session.id, 'p2', 'https://x.test/2', 6900);
  }, /UNIQUE/);
});

test('一条挂链不能绑给不同商品的排品', () => {
  const { svc, session } = makeEnv();
  svc.reviewProduct('p1', 'r1', 'approved');
  svc.reviewProduct('p2', 'r1', 'approved');
  const pick1 = svc.addPick(session.id, 'p1', { authorId: 'a1' });
  const pick2 = svc.addPick(session.id, 'p2', { authorId: 'a1' });
  const link = svc.createLink(session.id, 'p1', 'https://x.test/1', 8900);
  assert.throws(() => svc.bindLink(pick2.id, link.id), expectError('LINK_PRODUCT_MISMATCH'));
  assert.doesNotThrow(() => svc.bindLink(pick1.id, link.id));
});

// ---------- 价格校验 ----------
test('挂链价必须与商品当前价一致', () => {
  const { svc, session } = makeEnv();
  assert.throws(
    () => svc.createLink(session.id, 'p1', 'https://x.test/a', 1),
    expectError('PRICE_MISMATCH'),
  );
  assert.throws(
    () => svc.createLink(session.id, 'p1', 'https://x.test/a', -5),
    expectError('BAD_PRICE'),
  );
  assert.throws(
    () => svc.createLink(session.id, 'p1', 'not-a-url', 8900),
    expectError('BAD_URL'),
  );
});

test('商品变价后挂链检查产生 price_change 工单，且发布被拦截', () => {
  const { svc, session } = makeEnv();
  makePublishable(svc, session.id, 'p1');
  catalogAdapter.setPrice('p1', 9900); // 商家调价
  const incidents = svc.checkLinks(session.id);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].kind, 'price_change');
  // 挂链价未被自动改动（待人工核对）
  const errors = svc.validateSession(session.id);
  assert.ok(errors.some((e) => e.code === 'PRICE_MISMATCH'));
});

test('缺货检查自动下架挂链并开工单', () => {
  const { svc, session } = makeEnv();
  const { link } = makePublishable(svc, session.id, 'p2');
  catalogAdapter.setStock('p2', 0);
  const incidents = svc.checkLinks(session.id);
  assert.equal(incidents[0].kind, 'stockout');
  assert.equal(svc.getLink(link.id).status, 'delisted');
});

test('链接失效标记 dead 并解绑排品', () => {
  const { svc, session } = makeEnv();
  const { pick, link } = makePublishable(svc, session.id, 'p2');
  catalogAdapter.markLinkDead('p2', true);
  svc.checkLinks(session.id);
  assert.equal(svc.getLink(link.id).status, 'dead');
  assert.equal(svc.getPick(pick.id).link, null);
});

test('商品必须先过审才能加入排品', () => {
  const { svc, session } = makeEnv();
  assert.throws(() => svc.addPick(session.id, 'p5', { authorId: 'a1' }), expectError('NOT_APPROVED'));
  svc.reviewProduct('p5', 'r1', 'approved');
  assert.doesNotThrow(() => svc.addPick(session.id, 'p5', { authorId: 'a1' }));
});

test('违规词拦截脚本发布；商品自带违规词同样生效', () => {
  const { svc, session } = makeEnv();
  svc.reviewProduct('p6', 'r1', 'approved');
  const pick = svc.addPick(session.id, 'p6', { authorId: 'a1' });
  svc.editScript(pick.id, 'a1', '最顶级香调，国家级调香');
  assert.throws(() => svc.publishScript(pick.id), expectError('BANNED_WORD'));
  svc.editScript(pick.id, 'a1', '正常话术，无违规');
  assert.doesNotThrow(() => svc.publishScript(pick.id));
});
