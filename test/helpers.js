import { freshDb } from '../src/db.js';
import { createServices } from '../src/services.js';
import { catalogAdapter } from '../src/adapters.js';

// 每个用例：独立内存库 + 商品适配器复位
export function makeEnv() {
  catalogAdapter.reset();
  const db = freshDb(':memory:');
  const svc = createServices(db);
  const room = svc.createRoom('测试直播间', 'a1');
  const session = svc.createSession(
    room.id, '测试场次', 'a1',
    new Date(Date.now() + 3600_000).toISOString(),
  );
  return { db, svc, room, session };
}

// 让商品可排品：过审 + 挂链 + 脚本发布 + 脚本审核通过
export function makePublishable(svc, sessionId, productId, { reviewer = 'r1', author = 'a1' } = {}) {
  svc.reviewProduct(productId, reviewer, 'approved');
  const pick = svc.addPick(sessionId, productId, { authorId: author });
  const product = catalogAdapter.get(productId);
  const link = svc.createLink(sessionId, productId, `https://x.test/${productId}`, product.priceCents);
  svc.bindLink(pick.id, link.id);
  svc.editScript(pick.id, author, `讲解 ${productId} 的合规话术。`);
  svc.publishScript(pick.id);
  svc.reviewScript(pick.id, reviewer, 'approved');
  return { pick, link };
}

export function expectError(code) {
  return (e) => {
    if (!e || e.code !== code) {
      throw new Error(`期望错误 ${code}，实际：${e?.code} ${e?.message}`);
    }
    return true;
  };
}
