// 演示种子：启动时若无数据则创建直播间、场次、排品、撤品、审核回执等样例。
import { writeFileSync } from 'node:fs';
import { catalogAdapter } from './adapters.js';

export function seed(svc, sampleDir) {
  if (svc.listRooms().length) return null;

  // 演示账号：a1 主播兼脚本人，r1 审核人，r2 另一审核人
  const room = svc.createRoom('珊瑚严选 1 号直播间', 'a1');
  const session = svc.createSession(
    room.id, '周三好物场 · 秋季新品', 'a1',
    new Date(Date.now() + 3600_000).toISOString(),
  );

  // 商品资料审核：p1/p2/p4/p5/p6 通过，p3 待审（且缺货）
  for (const pid of ['p1', 'p2', 'p4', 'p5', 'p6']) {
    svc.reviewProduct(pid, 'r1', 'approved', '资料齐全，图片与资质通过');
  }

  // 排品：顺序 / 讲解时长 / 库存提示 / 优惠版本
  const pick1 = svc.addPick(session.id, 'p1', { durationSec: 360, stockHint: 300, promoVersion: 'v1' });
  const pick2 = svc.addPick(session.id, 'p2', { durationSec: 420, stockHint: 500, promoVersion: 'v2' });
  const pick4 = svc.addPick(session.id, 'p4', { durationSec: 300, stockHint: 200, promoVersion: 'v1' });
  const pick5 = svc.addPick(session.id, 'p5', { durationSec: 240, stockHint: 400, promoVersion: 'v3' });
  const pick6 = svc.addPick(session.id, 'p6', { durationSec: 300, stockHint: 120, promoVersion: 'v1' });

  // 挂链（价格与当前价一致才能创建），绑到排品
  const links = {};
  for (const [pid, pick] of Object.entries({ p1: pick1, p2: pick2, p4: pick4, p5: pick5, p6: pick6 })) {
    const product = catalogAdapter.get(pid);
    links[pid] = svc.createLink(
      session.id, pid, `https://demo.shop/live/${session.id}/${pid}`, product.priceCents,
    );
    svc.bindLink(pick.id, links[pid].id);
  }

  // 讲解脚本（作者 a1），发布后由 r1 审核——非作者，合规
  svc.editScript(pick1.id, 'a1', '开场主推：云朵慕斯气垫，奶油质地持妆 8 小时，到手 89 元。', '初版');
  svc.publishScript(pick1.id);
  svc.reviewScript(pick1.id, 'r1', 'approved', '话术合规，卖点清晰');

  svc.editScript(pick2.id, 'a1', '黑曜保温杯，316 内胆 12 小时保温，晚八限时 69 元。', '初版');
  svc.publishScript(pick2.id);
  svc.reviewScript(pick2.id, 'r1', 'approved', '通过');

  svc.editScript(pick4.id, 'a1', '便携榨汁杯，40 秒出汁，今日加赠杯盖。', '初版');
  svc.publishScript(pick4.id);
  svc.reviewScript(pick4.id, 'r2', 'approved', '通过');

  svc.editScript(pick5.id, 'a1', '碳素纤维伞，仅 210g，强调轻便抗风。', '初版');
  svc.publishScript(pick5.id);
  svc.reviewScript(pick5.id, 'r2', 'approved', '通过');

  // p6 草稿含违规词（演示审核提示同步展示），不发布
  svc.editScript(pick6.id, 'a1', '香氛蜡烛礼盒，最顶级香调，国家级调香师作品。', '初版');

  // 样品登记：p1/p2 合规并写本地照片；p4 样品不符 -> 自动开工单
  writeSamplePhoto(sampleDir, 'p1.svg', '#FF6B6B');
  writeSamplePhoto(sampleDir, 'p2.svg', '#2B2B33');
  svc.registerSample({
    productId: 'p1', sessionId: session.id,
    photoPath: '/samples/p1.svg', conform: true, note: '外观与挂链一致',
  });
  svc.registerSample({
    productId: 'p2', sessionId: session.id,
    photoPath: '/samples/p2.svg', conform: true, note: '一致',
  });
  svc.registerSample({
    productId: 'p4', sessionId: session.id, conform: false,
    note: '实物颜色与挂链图不符，要求商家补样',
  });
  // 商家补样合格，样品不符工单处理完毕（演示异常闭环）
  svc.registerSample({
    productId: 'p4', sessionId: session.id, conform: true,
    note: '补样颜色与挂链一致',
  });
  const mismatch = svc.listIncidents(session.id).find((i) => i.kind === 'sample_mismatch' && i.status === 'open');
  if (mismatch) svc.handleIncident(mismatch.id);

  // 临时撤品样例：p6 撤品并自动下架挂链
  svc.withdrawPick(pick6.id, '商家临时调价，等待新优惠版本 v2', 'a1');

  // 回调幂等样例：p1 挂链先成交一笔，再收到两条相同的变价回调（只生效一次），
  // 随后恢复原价；全程已成交订单价格不变。
  const o = svc.createOrder(links.p1.id);
  const cb = { eventKey: 'demo-cb-1', linkId: links.p1.id, type: 'price_change', seq: 1, payload: { priceCents: 1 } };
  const r1 = svc.processCallback(cb);
  const r2 = svc.processCallback(cb); // 重复，不重复处理
  svc.processCallback({ eventKey: 'demo-cb-2', linkId: links.p1.id, type: 'price_change', seq: 2, payload: { priceCents: catalogAdapter.get('p1').priceCents } });
  svc.processCallback({ eventKey: 'demo-cb-3', linkId: links.p1.id, type: 'price_change', seq: 1, payload: { priceCents: 1 } }); // 乱序旧事件，丢弃

  return {
    roomId: room.id,
    sessionId: session.id,
    picks: { pick1: pick1.id, pick2: pick2.id, pick4: pick4.id, pick5: pick5.id, pick6: pick6.id },
    links,
    orderId: o.id,
    callbackOnce: r1.applied,
    callbackDuplicateIgnored: r2.duplicated,
  };
}

function writeSamplePhoto(dir, file, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="${color}"/>
  <text x="160" y="128" fill="#FBF6EC" font-family="sans-serif" font-size="22" text-anchor="middle">样品照片</text>
</svg>`;
  writeFileSync(`${dir}/${file}`, svg, 'utf8');
}
