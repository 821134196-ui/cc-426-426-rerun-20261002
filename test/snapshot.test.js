import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makePublishable, expectError } from './helpers.js';
import { catalogAdapter } from '../src/adapters.js';

// ---------- 版本快照 ----------
test('脚本修改生成版本，发布后产生不可变快照', () => {
  const { svc, session } = makeEnv();
  svc.reviewProduct('p1', 'r1', 'approved');
  const pick = svc.addPick(session.id, 'p1', { authorId: 'a1' });

  const v1 = svc.editScript(pick.id, 'a1', '第一版话术');
  assert.equal(v1.current_version, 1);
  const v2 = svc.editScript(pick.id, 'a1', '第二版话术', '加优惠');
  assert.equal(v2.current_version, 2);
  assert.equal(v2.versions.length, 2);

  const published = svc.publishScript(pick.id);
  assert.equal(published.published_version, 2);
  assert.equal(published.published_content, '第二版话术');
});

test('已开始场次继续使用发布快照，草稿修改不能覆盖', () => {
  const { svc, session } = makeEnv();
  const { pick } = makePublishable(svc, session.id, 'p1');

  const { snapshot } = svc.publishSession(session.id);
  assert.equal(snapshot.picks[0].script.content, '讲解 p1 的合规话术。');
  svc.startSession(session.id);

  // 开场后：排品锁定，脚本仍可迭代草稿，但快照不变
  assert.throws(
    () => svc.addPick(session.id, null) || svc.updatePick(pick.id, { durationSec: 10 }),
    expectError('SESSION_LOCKED'),
  );
  svc.editScript(pick.id, 'a1', '开场后才写的新草稿，不应出现在直播中');
  const liveSnapshot = svc.publishedSnapshot(session.id);
  assert.equal(liveSnapshot.picks[0].script.content, '讲解 p1 的合规话术。');
  assert.equal(liveSnapshot.picks[0].script.publishedVersion, 1);

  // 直播中再次发布会被拒绝
  assert.throws(() => svc.publishSession(session.id), expectError('ALREADY_LIVE'));
});

test('发布快照冻结当时价格，之后商品变价不影响快照', () => {
  const { svc, session } = makeEnv();
  makePublishable(svc, session.id, 'p2');
  svc.publishSession(session.id);
  const before = svc.publishedSnapshot(session.id).picks[0].product.priceCents;

  catalogAdapter.setPrice('p2', before + 1000);
  const snap = svc.publishedSnapshot(session.id);
  assert.equal(snap.picks[0].product.priceCents, before);
});
