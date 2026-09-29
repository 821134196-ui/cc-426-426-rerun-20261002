// 单命令启动：node src/server.js [--demo] [--port 4000] [--reset]
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { openDb, closeDb } from './db.js';
import { createServices, DomainError } from './services.js';
import { catalogAdapter, anchors, reviewReceiptAdapter } from './adapters.js';
import { seed } from './seed.js';
import { writeProductImages } from './assets.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const DATA = join(ROOT, 'data');
const SAMPLE_DIR = join(DATA, 'samples');

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 4000;
const RESET = args.includes('--reset');

const db = openDb();
const svc = createServices(db);
mkdir(SAMPLE_DIR, { recursive: true });
writeProductImages(join(PUBLIC, 'assets', 'img'));

if (RESET) {
  db.exec(`DELETE FROM rooms; DELETE FROM sessions; DELETE FROM picks; DELETE FROM scripts;
    DELETE FROM script_versions; DELETE FROM reviews; DELETE FROM product_review_state;
    DELETE FROM links; DELETE FROM link_events; DELETE FROM orders; DELETE FROM samples;
    DELETE FROM incidents; DELETE FROM publish_receipts;`);
}
const seedInfo = seed(svc, SAMPLE_DIR);
if (seedInfo) console.log('已创建演示样例：排品 / 撤品 / 审核回执（--reset 可重建）');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body)
    ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(buf);
}
send.json = (res, status, obj) => send(res, status, JSON.stringify(obj));

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// ---------- API 路由 ----------
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });

route('GET', /^\/api\/state$/, async (req, res) => {
  const sessions = svc.listSessions().map((s) => ({
    ...s,
    snapshot: s.published_snapshot ? JSON.parse(s.published_snapshot) : null,
    published_snapshot: undefined,
  }));
  send.json(res, 200, {
    anchors,
    rooms: svc.listRooms(),
    sessions,
    products: catalogAdapter.list(),
    reviewStates: Object.fromEntries(
      catalogAdapter.list().map((p) => [p.id, svc.productReviewState(p.id)]),
    ),
    incidents: svc.listIncidents(),
    samples: svc.listSamples(),
    receipts: reviewReceiptAdapter.log(),
    events: svc.listEvents(),
    orders: svc.listOrders(),
  });
});

route('POST', /^\/api\/sessions$/, async (req, res) => {
  const b = await readBody(req);
  const room = svc.createRoom(b.roomName || '新直播间', b.anchorId || 'a1');
  const s = svc.createSession(room.id, b.title || '未命名场次', b.anchorId || room.anchor_id,
    b.startsAt || new Date(Date.now() + 3600_000).toISOString());
  send.json(res, 201, s);
});

route('POST', /^\/api\/products\/([^/]+)\/review$/, async (req, res, m) => {
  const b = await readBody(req);
  const out = svc.reviewProduct(m[1], b.reviewerId || 'r1', b.result, b.reason);
  send.json(res, 200, out);
});

route('POST', /^\/api\/sessions\/([^/]+)\/picks$/, async (req, res, m) => {
  const b = await readBody(req);
  send.json(res, 201, svc.addPick(m[1], b.productId, {
    durationSec: b.durationSec, stockHint: b.stockHint,
    promoVersion: b.promoVersion, authorId: b.authorId,
  }));
});

route('PATCH', /^\/api\/picks\/([^/]+)$/, async (req, res, m) => {
  const b = await readBody(req);
  send.json(res, 200, svc.updatePick(m[1], b));
});

route('POST', /^\/api\/picks\/([^/]+)\/withdraw$/, async (req, res, m) => {
  const b = await readBody(req);
  send.json(res, 200, svc.withdrawPick(m[1], b.reason, b.operatorId));
});

route('POST', /^\/api\/sessions\/([^/]+)\/reorder$/, async (req, res, m) => {
  const b = await readBody(req);
  send.json(res, 200, svc.reorderPicks(m[1], b.order));
});

route('PUT', /^\/api\/picks\/([^/]+)\/script$/, async (req, res, m) => {
  const b = await readBody(req);
  send.json(res, 200, svc.editScript(m[1], b.authorId || 'a1', b.content || '', b.note));
});

route('POST', /^\/api\/picks\/([^/]+)\/script\/publish$/, async (req, res, m) => {
  send.json(res, 200, svc.publishScript(m[1]));
});

route('POST', /^\/api\/picks\/([^/]+)\/script\/review$/, async (req, res, m) => {
  const b = await readBody(req);
  send.json(res, 200, svc.reviewScript(m[1], b.reviewerId || 'r1', b.result, b.reason));
});

route('POST', /^\/api\/links$/, async (req, res) => {
  const b = await readBody(req);
  send.json(res, 201, svc.createLink(b.sessionId, b.productId, b.url, b.priceCents));
});

route('POST', /^\/api\/picks\/([^/]+)\/bind-link$/, async (req, res, m) => {
  const b = await readBody(req);
  send.json(res, 200, svc.bindLink(m[1], b.linkId));
});

route('POST', /^\/api\/sessions\/([^/]+)\/check-links$/, async (req, res, m) => {
  send.json(res, 200, svc.checkLinks(m[1]));
});

// 模拟平台侧价格/库存/链接变化（演示用）
route('POST', /^\/api\/sim\/products\/([^/]+)$/, async (req, res, m) => {
  const b = await readBody(req);
  if (Number.isInteger(b.priceCents)) catalogAdapter.setPrice(m[1], b.priceCents);
  if (Number.isInteger(b.stock)) catalogAdapter.setStock(m[1], b.stock);
  if (typeof b.linkDead === 'boolean') catalogAdapter.markLinkDead(m[1], b.linkDead);
  send.json(res, 200, catalogAdapter.get(m[1]));
});

// 平台回调（可重复、可乱序）
route('POST', /^\/api\/callbacks$/, async (req, res) => {
  const b = await readBody(req);
  send.json(res, 200, svc.processCallback(b));
});

// 样品登记，照片可选（base64 存本地目录）
route('POST', /^\/api\/samples$/, async (req, res) => {
  const b = await readBody(req);
  let photoPath = null;
  if (b.photoBase64) {
    const ext = (b.photoExt || 'png').replace(/[^a-z0-9]/gi, '');
    const name = `smp_${Date.now()}_${Math.round(1e6 + Math.random() * 9e6)}.${ext}`;
    await writeFile(join(SAMPLE_DIR, name), Buffer.from(b.photoBase64, 'base64'));
    photoPath = `/samples/${name}`;
  }
  send.json(res, 201, svc.registerSample({
    productId: b.productId, sessionId: b.sessionId || null,
    photoPath, conform: !!b.conform, note: b.note,
  }));
});

route('GET', /^\/api\/sessions\/([^/]+)\/validate$/, async (req, res, m) => {
  send.json(res, 200, { errors: svc.validateSession(m[1]) });
});

route('POST', /^\/api\/sessions\/([^/]+)\/publish$/, async (req, res, m) => {
  send.json(res, 200, svc.publishSession(m[1]));
});

route('POST', /^\/api\/sessions\/([^/]+)\/(start|end)$/, async (req, res, m) => {
  send.json(res, 200, m[2] === 'start' ? svc.startSession(m[1]) : svc.endSession(m[1]));
});

route('POST', /^\/api\/incidents\/([^/]+)\/handle$/, async (req, res, m) => {
  send.json(res, 200, svc.handleIncident(m[1]));
});

// ---------- 静态文件 ----------
async function serveStatic(req, res, url) {
  let path;
  if (url.pathname.startsWith('/samples/')) {
    path = join(SAMPLE_DIR, normalize(decodeURIComponent(url.pathname.slice('/samples/'.length))));
    if (!path.startsWith(SAMPLE_DIR)) return send.json(res, 403, { error: 'forbidden' });
  } else {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    path = join(PUBLIC, normalize(rel));
    if (!path.startsWith(PUBLIC)) return send.json(res, 403, { error: 'forbidden' });
  }
  try {
    const st = await stat(path);
    if (st.isDirectory()) path = join(path, 'index.html');
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA 回退
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/samples/')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(await readFile(join(PUBLIC, 'index.html')));
    } else {
      send.json(res, 404, { error: 'not found' });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (m) return await r.fn(req, res, m, url);
    }
    return await serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof DomainError) {
      let detail = e.message;
      try { detail = JSON.parse(e.message); } catch { /* 普通消息 */ }
      return send.json(res, 422, { error: e.code, detail });
    }
    console.error(e);
    send.json(res, 500, { error: 'INTERNAL', detail: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`直播间排品系统已启动：http://localhost:${PORT}`);
});

export { server, svc };
