// 进程内模拟适配器：商品、主播、价格、审核/发布回执。
// 数据不落盘，重启即恢复演示状态；审核结论单独缓存在 SQLite。

// 价格以分为单位
export const anchors = [
  { id: 'a1', name: '珊瑚酱' },
  { id: 'a2', name: '石墨小哥' },
  { id: 'a3', name: '奶油学姐' },
];

export const products = [
  {
    id: 'p1',
    name: '云朵慕斯气垫 BB 霜',
    brand: 'Coral Lab',
    priceCents: 8900,
    listPriceCents: 12900,
    stock: 320,
    image: '/assets/img/p1.svg',
    bannedWords: [],
    desc: '奶油质地，持妆 8 小时，含替换装。',
  },
  {
    id: 'p2',
    name: '黑曜陶瓷保温杯 450ml',
    brand: 'Obsidian',
    priceCents: 6900,
    listPriceCents: 9900,
    stock: 580,
    image: '/assets/img/p2.svg',
    bannedWords: [],
    desc: '316 不锈钢内胆，12 小时保温。',
  },
  {
    id: 'p3',
    name: '珊瑚色丝绒唇釉',
    brand: 'Coral Lab',
    priceCents: 5900,
    listPriceCents: 7900,
    stock: 0, // 演示缺货
    image: '/assets/img/p3.svg',
    bannedWords: [],
    desc: '显白珊瑚调，雾面不拔干。',
  },
  {
    id: 'p4',
    name: '便携榨汁杯（充电款）',
    brand: 'FreshGo',
    priceCents: 12900,
    listPriceCents: 15900,
    stock: 210,
    image: '/assets/img/p4.svg',
    bannedWords: [],
    desc: '40 秒出汁，Type-C 充电，可打冰块。',
  },
  {
    id: 'p5',
    name: '碳素纤维晴雨伞',
    brand: 'Obsidian',
    priceCents: 4900,
    listPriceCents: 8900,
    stock: 460,
    image: '/assets/img/p5.svg',
    bannedWords: [],
    desc: '仅 210g，抗六级风。',
  },
  {
    id: 'p6',
    name: '奶油香氛蜡烛礼盒',
    brand: 'Maison',
    priceCents: 9900,
    listPriceCents: 13900,
    stock: 150,
    image: '/assets/img/p6.svg',
    bannedWords: ['最顶级', '国家级'], // 演示违规词：文案里用到即拦截
    desc: '三支装，雪松/香草/无花果。',
  },
];

// 进程内可变状态：模拟平台侧的价格/库存/链接波动
const liveState = new Map(
  products.map((p) => [
    p.id,
    { priceCents: p.priceCents, stock: p.stock, linkDead: false },
  ]),
);

export const catalogAdapter = {
  list() {
    return products.map((p) => ({ ...p, ...liveState.get(p.id) }));
  },
  get(id) {
    const p = products.find((x) => x.id === id);
    return p ? { ...p, ...liveState.get(id) } : null;
  },
  // 模拟平台变价（商家调价）
  setPrice(id, priceCents) {
    const s = liveState.get(id);
    if (s) s.priceCents = priceCents;
  },
  setStock(id, stock) {
    const s = liveState.get(id);
    if (s) s.stock = stock;
  },
  markLinkDead(id, dead = true) {
    const s = liveState.get(id);
    if (s) s.linkDead = dead;
  },
  // 恢复演示初始状态（测试用）
  reset() {
    for (const p of products) {
      liveState.set(p.id, { priceCents: p.priceCents, stock: p.stock, linkDead: false });
    }
  },
  anchor(id) {
    return anchors.find((a) => a.id === id) || null;
  },
};

// 违规词库（在商品自带词之外，全局通用词）
export const GLOBAL_BANNED = ['第一', '绝无仅有', '永久'];

// ---- 审核回执适配器（进程内模拟） ----
const receiptLog = [];
let seq = 1000;

export const reviewReceiptAdapter = {
  // 提交商品资料审核，模拟平台返回回执号
  submitProductReview(productId, reviewerId, result, reason) {
    const receipt = {
      receiptNo: `AR-${++seq}`,
      targetType: 'product',
      targetId: productId,
      reviewerId,
      result,
      reason: reason || null,
      at: new Date().toISOString(),
    };
    receiptLog.push(receipt);
    return receipt;
  },
  submitScriptReview(scriptId, reviewerId, result, reason) {
    const receipt = {
      receiptNo: `SR-${++seq}`,
      targetType: 'script',
      targetId: scriptId,
      reviewerId,
      result,
      reason: reason || null,
      at: new Date().toISOString(),
    };
    receiptLog.push(receipt);
    return receipt;
  },
  log() {
    return [...receiptLog];
  },
};

// ---- 发布回执适配器（进程内模拟平台挂链上架） ----
let publishSeq = 5000;
export const publishAdapter = {
  publish(sessionId, snapshot, idempotencyKey) {
    // 模拟平台：同 key 返回同一回执（幂等）
    const hit = receiptLog.find(
      (r) => r.idempotencyKey === idempotencyKey && r.targetType === 'publish',
    );
    if (hit) return { ...hit, duplicated: true };
    const receipt = {
      receiptNo: `PB-${++publishSeq}`,
      targetType: 'publish',
      sessionId,
      picks: snapshot.picks.length,
      links: snapshot.picks.filter((p) => p.link).length,
      idempotencyKey,
      at: new Date().toISOString(),
    };
    receiptLog.push(receipt);
    return receipt;
  },
};

// ---- 挂链回调适配器（模拟平台异步回调，可乱序、可重复） ----
let cbSeq = 0;
export function makeCallback(linkId, type, payload = {}) {
  return {
    eventKey: `CB-${linkId}-${type}-${++cbSeq}`,
    linkId,
    type, // list | delist | price_change | link_dead | stockout
    payload,
    at: Date.now(),
  };
}
