/* 排品工作台前端：原生 JS，零依赖 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof data.detail === 'object'
      ? data.detail.map((d) => d.message).join('\n')
      : (data.detail || data.error || '操作失败');
    throw new Error(msg);
  }
  return data;
};
const fmtPrice = (c) => `¥${(c / 100).toFixed(2)}`;
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '';
const fmtDur = (s) => `${Math.floor(s / 60)}分${s % 60 ? s % 60 + '秒' : ''}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let STATE = null;
let sessionId = null;
let selectedPickId = null;

// ---------- 数据加载 ----------
async function loadState() {
  STATE = await api('/api/state');
  if (!sessionId && STATE.sessions[0]) sessionId = STATE.sessions[0].id;
  renderAll();
}
function session() { return STATE.sessions.find((s) => s.id === sessionId); }
function picks() { const s = session(); return s ? s.picks.filter((p) => p.status === 'planned') : []; }

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast ${isErr ? 'err' : ''}`;
  setTimeout(() => t.classList.add('hidden'), 0);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ---------- 渲染 ----------
function renderAll() {
  renderHeader();
  renderBoard();
  renderScriptTab();
  renderReviewTab();
  renderLinksTab();
  renderSamplesTab();
  renderReceiptsTab();
}

function renderHeader() {
  const sel = $('#sessionSelect');
  sel.innerHTML = STATE.sessions.map((s) =>
    `<option value="${s.id}" ${s.id === sessionId ? 'selected' : ''}>${esc(s.title)} · ${esc(anchorName(s.anchor_id))}</option>`).join('');
  const s = session();
  const pill = $('#sessionStatus');
  const map = { draft: ['草稿（可编排）', 'draft'], live: ['直播中（使用发布快照）', 'live'], ended: ['已结束', 'ended'] };
  const [txt, cls] = map[s.status] || ['', ''];
  pill.textContent = txt; pill.className = `status-pill ${cls}`;
  $('#startBtn').disabled = s.status !== 'draft' || !s.published_at;
  $('#endBtn').disabled = s.status !== 'live';
  $('#publishBtn').disabled = s.status !== 'draft';
  $('#boardTitle').textContent = s.title;
  $('#boardMeta').textContent =
    `${anchorName(s.anchor_id)} · 开场 ${fmtTime(s.starts_at)} · ${picks().length} 个排品 · ${s.published_at ? '已发布 ' + fmtTime(s.published_at) : '未发布'}`;
}
function anchorName(id) { return STATE.anchors.find((a) => a.id === id)?.name || id; }

function linkStatusTag(pick) {
  if (!pick.link) return `<span class="pc-tag tag-bad">无挂链</span>`;
  if (pick.link.status === 'active') {
    if (pick.link.price_cents !== pick.product.priceCents)
      return `<span class="pc-tag tag-warn">价格待核对</span>`;
    return `<span class="pc-tag tag-ok">挂链正常</span>`;
  }
  if (pick.link.status === 'dead') return `<span class="pc-tag tag-bad">链接失效</span>`;
  return `<span class="pc-tag tag-muted">已下架</span>`;
}

function renderBoard() {
  const ps = picks();
  const tl = $('#timeline');
  let clock = 0;
  tl.innerHTML = ps.map((p, i) => {
    const start = clock; clock += p.duration_sec;
    const out = p.product.stock <= 0;
    return `<div class="tl-slot" data-pick="${p.id}">
      <div class="product-card ${selectedPickId === p.id ? 'selected' : ''}" data-pick="${p.id}">
        <span class="pc-seq ${i === 0 ? 'coral' : ''}">${p.position}</span>
        <img class="pc-img" src="${p.product.image}" alt="">
        <div class="pc-body">
          <div class="pc-name">${esc(p.product.name)}</div>
          <div class="pc-top">
            <span class="pc-price">${fmtPrice(p.product.priceCents)}</span>
            <span class="pc-stock ${out ? 'out' : ''}">库存 ${p.product.stock}${out ? ' · 缺货' : ''}</span>
          </div>
          <div class="pc-foot">
            ${linkStatusTag(p)}
            <span class="pc-time">${fmtDur(p.duration_sec)} · 优惠 ${esc(p.promo_version)}</span>
          </div>
          <div class="pc-top">
            <span class="pc-link ${p.link?.status === 'active' ? 'on' : 'off'}">
              ${p.link ? (p.link.status === 'active' ? '🔗 已挂链' : '🔗 挂链异常') : '🔗 未挂链'}
            </span>
            <span class="pc-time">口播库存 ${p.stock_hint}</span>
          </div>
        </div>
      </div>
      <div class="muted" style="text-align:center;margin-top:6px;font-size:11px">
        ${mmss(start)} – ${mmss(clock)}
      </div>
    </div>`;
  }).join('') || `<p class="muted">暂无排品。商品通过资料审核后可加入。</p>`;

  $('#addProductSelect').innerHTML = STATE.products.map((p) => {
    const st = STATE.reviewStates[p.id]?.status || 'pending';
    return `<option value="${p.id}" ${st !== 'approved' ? 'disabled' : ''}>
      ${esc(p.name)}（${st === 'approved' ? '已过审' : st === 'rejected' ? '已驳回' : '待审核'}）</option>`;
  }).join('');

  renderPickDetail();
}

function mmss(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

function renderPickDetail() {
  const panel = $('#pickDetail');
  const p = picks().find((x) => x.id === selectedPickId);
  if (!p) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const locked = session().status !== 'draft';
  panel.innerHTML = `
    <h3 style="margin-top:0">${esc(p.product.name)} · 排品设置</h3>
    <div class="detail-fields">
      <div><label>讲解时长（秒）</label><input id="f-duration" type="number" value="${p.duration_sec}" ${locked ? 'disabled' : ''}></div>
      <div><label>库存提示（口播）</label><input id="f-stock" type="number" value="${p.stock_hint}" ${locked ? 'disabled' : ''}></div>
      <div><label>优惠版本</label>
        <select id="f-promo" ${locked ? 'disabled' : ''}>
          ${['v1', 'v2', 'v3'].map((v) => `<option ${v === p.promo_version ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
      <div><label>挂链</label><div style="font-size:13px;padding-top:8px">
        ${p.link ? `${esc(p.link.id)} · ${fmtPrice(p.link.price_cents)} · ${p.link.status}` : '未绑定'}
      </div></div>
    </div>
    <div class="detail-actions">
      ${locked ? '' : `
        <button class="btn dark" id="savePickBtn">保存设置</button>
        <button class="btn coral" id="addLinkBtn">${p.link ? '重建/核对挂链' : '创建挂链'}</button>
        <button class="btn ghost-dark" id="withdrawBtn">临时撤品</button>`}
      <button class="btn ghost-dark" id="gotoScriptBtn">去写脚本</button>
    </div>
    <p class="muted" id="detailMsg"></p>`;
  if (!locked) {
    $('#savePickBtn').onclick = async () => {
      try {
        await api(`/api/picks/${p.id}`, { method: 'PATCH', body: {
          durationSec: Number($('#f-duration').value),
          stockHint: Number($('#f-stock').value),
          promoVersion: $('#f-promo').value,
        } });
        await loadState(); toast('排品已更新');
      } catch (e) { toast(e.message, true); }
    };
    $('#addLinkBtn').onclick = () => createLinkFor(p);
    $('#withdrawBtn').onclick = async () => {
      const reason = prompt('撤品原因（将自动下架挂链并记录工单）', '临时撤品');
      if (reason === null) return;
      try {
        await api(`/api/picks/${p.id}/withdraw`, { method: 'POST', body: { reason, operatorId: 'a1' } });
        await loadState(); toast('已撤品并下架挂链');
      } catch (e) { toast(e.message, true); }
    };
  }
  $('#gotoScriptBtn').onclick = () => { switchTab('script'); $('#scriptPickSelect').value = p.id; renderScriptTab(); };
}

async function createLinkFor(p) {
  const url = prompt('挂链地址', `https://demo.shop/live/${sessionId}/${p.product_id}`);
  if (!url) return;
  const price = prompt(`挂链价格（分），须与当前价 ${p.product.priceCents} 一致`, p.product.priceCents);
  if (price === null) return;
  try {
    const link = await api('/api/links', { method: 'POST', body: {
      sessionId, productId: p.product_id, url, priceCents: Number(price) } });
    await api(`/api/picks/${p.id}/bind-link`, { method: 'POST', body: { linkId: link.id } });
    await loadState(); toast('挂链已创建并绑定');
  } catch (e) { toast(e.message, true); }
}

// ---------- 脚本编辑 + 审核提示 ----------
function renderScriptTab() {
  const ps = picks();
  const opts = ps.map((p) =>
    `<option value="${p.id}" ${p.id === selectedPickId ? 'selected' : ''}>#${p.position} ${esc(p.product.name)}</option>`).join('');
  $('#scriptPickSelect').innerHTML = opts;
  if (!selectedPickId && ps[0]) selectedPickId = ps[0].id;
  $('#scriptPickSelect').value = selectedPickId;
  const reviewerOpts = [
    ['a1', '珊瑚酱（主播/脚本人）'],
    ['r1', '审核人 r1'],
    ['r2', '审核人 r2'],
  ].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  $('#authorSelect').innerHTML = reviewerOpts;
  $('#reviewerSelect').innerHTML = reviewerOpts;
  $('#reviewerSelect').value = 'r1';

  const p = ps.find((x) => x.id === selectedPickId);
  if (!p) { $('#scriptEditor').value = ''; $('#reviewHints').innerHTML = '<p class="muted">暂无排品</p>'; $('#versionList').innerHTML = ''; return; }
  const s = p.script;
  if (document.activeElement !== $('#scriptEditor'))
    $('#scriptEditor').value = s.draft_content || '';

  // 版本列表
  $('#versionList').innerHTML = s.versions.map((v) => `
    <div class="version-item ${v.version === s.published_version ? 'published' : ''}">
      <span class="v-no">v${v.version}</span>
      <span class="v-content">${esc(v.content) || '（空）'}</span>
      <span class="muted">${esc(v.author_id)} · ${v.note ? esc(v.note) + ' · ' : ''}${fmtTime(v.created_at)}</span>
      <button data-v="${v.version}">查看</button>
      ${v.version === s.published_version ? '<span class="pc-tag tag-ok">已发布版</span>' : ''}
    </div>`).join('') || '<p class="muted">还没有版本，保存即生成 v1。</p>';
  $$('#versionList button').forEach((b) => b.onclick = () => {
    const v = s.versions.find((x) => x.version === Number(b.dataset.v));
    $('#scriptEditor').value = v.content;
  });

  renderReviewHints(p);
}

function renderReviewHints(p) {
  const s = p.script;
  const hints = [];
  // 商品审核
  hints.push(p.review.status === 'approved'
    ? ['ok', '商品资料审核已通过']
    : ['bad', `商品资料${p.review.status === 'rejected' ? '已驳回' : '待审核'}`]);
  // 违规词实时扫描
  const words = scanWordsClient(s.draft_content, p.product);
  if (words.length) hints.push(['bad', `命中违规词：${words.join('、')}`]);
  else if (s.draft_content) hints.push(['ok', '未发现违规词']]);
  // 版本状态
  if (s.published_version == null) hints.push(['warn', '脚本尚未发布']);
  else if (s.published_version < s.current_version)
    hints.push(['warn', `草稿 v${s.current_version} 较已发布 v${s.published_version} 有更新；场次开始后继续使用发布快照`]);
  else hints.push(['ok', `当前已发布版本 v${s.published_version}`]);
  // 脚本审核结论
  // 从 reviews 无法直接拿到（state 接口未含），用 receipts 反查最新脚本审核
  const scriptReviews = STATE.receipts.filter((r) => r.targetType === 'script' && r.targetId === s.id);
  const last = scriptReviews[scriptReviews.length - 1];
  if (!last) hints.push(['warn', '脚本尚未审核']);
  else hints.push([last.result === 'approved' ? 'ok' : 'bad',
    `脚本审核${last.result === 'approved' ? '通过' : '驳回'}（${last.reviewerId}${last.reason ? '：' + esc(last.reason) : ''}）`]);
  // 挂链
  hints.push(p.link?.status === 'active'
    ? (p.link.price_cents === p.product.priceCents
      ? ['ok', '挂链有效，价格一致'] : ['bad', '挂链价与当前价不一致'])
    : ['bad', '挂链缺失或异常']);
  // 自审提示
  const reviewer = $('#reviewerSelect').value;
  const isAuthor = s.author_id === reviewer || s.versions.some((v) => v.author_id === reviewer);
  $('#selfWarn').classList.toggle('hidden', !isAuthor);

  $('#reviewHints').innerHTML = hints.map(([cls, t]) =>
    `<div class="hint ${cls}">${t}</div>`).join('');
}

function scanWordsClient(content, product) {
  const words = ['第一', '绝无仅有', '永久', ...(product.bannedWords || [])];
  return words.filter((w) => content.includes(w));
}

// ---------- 商品审核台 ----------
function renderReviewTab() {
  $('#productGrid').innerHTML = STATE.products.map((p) => {
    const st = STATE.reviewStates[p.id] || { status: 'pending' };
    const tag = {
      approved: '<span class="pc-tag tag-ok">已通过</span>',
      rejected: '<span class="pc-tag tag-bad">已驳回</span>',
      pending: '<span class="pc-tag tag-warn">待审核</span>',
    }[st.status];
    const stockLine = p.stock <= 0
      ? '<span class="pc-stock out">当前缺货</span>' : `<span class="pc-stock">库存 ${p.stock}</span>`;
    return `<div class="prod-card">
      <img src="${p.image}" alt="">
      <div class="prod-body">
        <div class="pc-name">${esc(p.name)}</div>
        <div class="pc-top"><span class="pc-price">${fmtPrice(p.priceCents)}</span>${stockLine}</div>
        <div class="prod-desc">${esc(p.brand)} · ${esc(p.desc)}</div>
        <div class="pc-top">${tag}<span class="muted">${st.reviewer_id ? '审核 ' + st.reviewer_id : ''}</span></div>
        <div class="review-actions">
          <button class="btn dark" data-approve="${p.id}" ${st.status === 'approved' ? 'disabled' : ''}>通过</button>
          <button class="btn ghost-dark" data-reject="${p.id}">驳回</button>
        </div>
      </div>
    </div>`;
  }).join('');
  $$('[data-approve]').forEach((b) => b.onclick = async () => {
    try { await api(`/api/products/${b.dataset.approve}/review`, { method: 'POST', body: { reviewerId: 'r1', result: 'approved' } });
      await loadState(); toast('审核通过，回执已生成'); } catch (e) { toast(e.message, true); }
  });
  $$('[data-reject]').forEach((b) => b.onclick = async () => {
    const reason = prompt('驳回原因', '资质图片缺失');
    if (reason === null) return;
    try { await api(`/api/products/${b.dataset.reject}/review`, { method: 'POST', body: { reviewerId: 'r1', result: 'rejected', reason } });
      await loadState(); toast('已驳回'); } catch (e) { toast(e.message, true); }
  });
}

// ---------- 挂链检查 ----------
function renderLinksTab() {
  const links = STATE.sessions.flatMap((s) => s.picks.map((p) => p.link).filter(Boolean));
  const uniq = new Map(links.map((l) => [l.id, l]));
  $('#linkList').innerHTML = [...uniq.values()].map((l) => {
    const product = STATE.products.find((p) => p.id === l.product_id);
    const priceBad = l.status === 'active' && l.price_cents !== product.priceCents;
    return `<div class="link-card">
      <div>
        <strong>${esc(product.name)}</strong>
        <span class="pc-tag tag-${l.status === 'active' ? (priceBad ? 'warn' : 'ok') : 'bad'}">
          ${l.status === 'active' ? '上架中' : l.status === 'dead' ? '已失效' : '已下架'}
        </span>
      </div>
      <span class="url">${esc(l.url)}</span>
      <span class="${priceBad ? 'pc-stock out' : ''}">挂链 ${fmtPrice(l.price_cents)} / 当前 ${fmtPrice(product.priceCents)}</span>
    </div>`;
  }).join('') || '<p class="muted">暂无挂链</p>';

  const kindText = { stockout: '缺货下架', price_change: '价格变更', link_dead: '链接失效', sample_mismatch: '样品不符', withdraw: '临时撤品' };
  $('#incidentList').innerHTML = STATE.incidents.map((i) => `
    <div class="incident-card ${i.status}">
      <div><span class="kind-badge kind-${i.kind}">${kindText[i.kind] || i.kind}</span>
        <strong>${esc(STATE.products.find((p) => p.id === i.product_id)?.name || i.product_id)}</strong>
        <span class="muted">${esc(i.detail || '')}</span></div>
      <div class="row"><span class="muted">${fmtTime(i.created_at)}</span>
      ${i.status === 'open' ? `<button class="btn ghost-dark" data-inc="${i.id}">标记已处理</button>` : '<span class="pc-tag tag-ok">已处理</span>'}</div>
    </div>`).join('') || '<p class="muted">暂无异常工单</p>';
  $$('[data-inc]').forEach((b) => b.onclick = async () => {
    await api(`/api/incidents/${b.dataset.inc}/handle`, { method: 'POST' }); await loadState();
  });
}

// ---------- 样品 ----------
function renderSamplesTab() {
  $('#sampleProductSelect').innerHTML = STATE.products.map((p) =>
    `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#sampleList').innerHTML = STATE.samples.map((s) => {
    const p = STATE.products.find((x) => x.id === s.product_id);
    return `<div class="sample-card ${s.conform ? '' : 'bad'}">
      ${s.photo_path ? `<img src="${s.photo_path}" alt="样品照片">` : '<div style="height:150px;display:grid;place-items:center" class="muted">无照片</div>'}
      <div class="s-body">
        <strong>${esc(p?.name || s.product_id)}</strong>
        <span class="pc-tag ${s.conform ? 'tag-ok' : 'tag-bad'}">${s.conform ? '样品一致' : '样品不符（已开工单）'}</span>
        <span class="muted">${fmtTime(s.received_at)}</span>
        <span>${esc(s.note || '')}</span>
      </div>
    </div>`;
  }).join('') || '<p class="muted">暂无样品记录</p>';
}

// ---------- 回执 / 回调 ----------
function renderReceiptsTab() {
  const s = session();
  $('#publishReceipts').innerHTML = s.snapshot ? `
    <div class="receipt-card">
      <div><strong>发布快照</strong>
        <p class="muted" style="margin:4px 0">${s.snapshot.picks.length} 个排品 · 生成于 ${fmtTime(s.snapshot.builtAt)}（开场后锁定，草稿不能覆盖）</p></div>
      <button class="btn ghost-dark" id="viewSnapshot">查看快照 JSON</button>
    </div>` : '<p class="muted">该场次尚未发布</p>';
  const pb = STATE.receipts.filter((r) => r.targetType === 'publish');
  $('#publishReceipts').innerHTML += pb.map((r) => `
    <div class="receipt-card">
      <div><strong>回执 ${esc(r.receiptNo)}</strong>
        <span class="muted">场次 ${esc(r.sessionId)} · ${r.picks} 排品 / ${r.links} 挂链${r.duplicated ? ' · 重复请求（幂等返回同号）' : ''}</span></div>
      <span class="muted">${fmtTime(r.at)}</span>
    </div>`).join('');
  $('#viewSnapshot')?.addEventListener('click', () => {
    showModal('发布快照（直播中的场次继续使用此快照）', `<pre>${esc(JSON.stringify(s.snapshot, null, 2))}</pre>`);
  });

  $('#auditReceipts').innerHTML = STATE.receipts.filter((r) => r.targetType !== 'publish').map((r) => `
    <div class="receipt-card">
      <div><strong>${esc(r.receiptNo)}</strong>
        <span class="pc-tag ${r.result === 'approved' ? 'tag-ok' : 'tag-bad'}">${r.targetType === 'product' ? '商品' : '脚本'}${r.result === 'approved' ? '通过' : '驳回'}</span>
        <span class="muted">${esc(r.targetId)} · ${r.reviewerId}${r.reason ? ' · ' + esc(r.reason) : ''}</span></div>
      <span class="muted">${fmtTime(r.at)}</span>
    </div>`).join('') || '<p class="muted">暂无审核回执</p>';

  $('#eventLog').innerHTML = STATE.events.map((e) => `
    <div class="event-card">
      <div><span class="kind-badge kind-${e.type}">${esc(e.type)}</span>
        <span class="muted">${esc(e.link_id)}</span>
        <span>${esc(e.payload)}</span></div>
      <span class="muted">${fmtTime(e.processed_at)}</span>
    </div>`).join('') || '<p class="muted">暂无回调事件</p>';
}

function showModal(title, html) {
  $('#modalBox').innerHTML = `<h3 style="margin-top:0">${esc(title)}</h3>${html}
    <div style="text-align:right;margin-top:12px"><button class="btn dark" id="modalClose">关闭</button></div>`;
  $('#modal').classList.remove('hidden');
  $('#modalClose').onclick = () => $('#modal').classList.add('hidden');
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

// ---------- Tab 切换 ----------
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpanel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
$$('.tab').forEach((t) => t.onclick = () => switchTab(t.dataset.tab));

// ---------- 事件绑定 ----------
$('#sessionSelect').onchange = (e) => { sessionId = e.target.value; selectedPickId = null; loadState(); };

$('#timeline').addEventListener('click', (e) => {
  const card = e.target.closest('[data-pick]');
  if (card) { selectedPickId = card.dataset.pick; renderBoard(); }
});

$('#addPickBtn').onclick = async () => {
  const productId = $('#addProductSelect').value;
  try {
    const p = await api(`/api/sessions/${sessionId}/picks`, { method: 'POST', body: { productId, authorId: 'a1' } });
    selectedPickId = p.id; await loadState(); toast('已加入排品');
  } catch (e) { toast(e.message, true); }
};

$('#scriptPickSelect').onchange = (e) => { selectedPickId = e.target.value; renderScriptTab(); };
$('#reviewerSelect').onchange = () => { const p = picks().find((x) => x.id === selectedPickId); if (p) renderReviewHints(p); };

$('#saveScriptBtn').onclick = async () => {
  const content = $('#scriptEditor').value;
  try {
    await api(`/api/picks/${selectedPickId}/script`, { method: 'PUT', body: {
      authorId: $('#authorSelect').value, content, note: $('#scriptNote').value } });
    $('#scriptNote').value = ''; await loadState(); toast('已生成新版本');
  } catch (e) { toast(e.message, true); }
};

$('#publishScriptBtn').onclick = async () => {
  try { await api(`/api/picks/${selectedPickId}/script/publish`, { method: 'POST' });
    await loadState(); toast('脚本已发布（已开始的场次不受后续草稿影响）');
  } catch (e) { toast(e.message, true); }
};

async function reviewScript(result) {
  try {
    await api(`/api/picks/${selectedPickId}/script/review`, { method: 'POST', body: {
      reviewerId: $('#reviewerSelect').value, result, reason: $('#rejectReason').value } });
    $('#rejectReason').value = ''; await loadState(); toast(result === 'approved' ? '审核通过' : '已驳回');
  } catch (e) { toast(e.message, true); }
}
$('#approveScriptBtn').onclick = () => reviewScript('approved');
$('#rejectScriptBtn').onclick = () => reviewScript('rejected');

$('#checkLinksBtn').onclick = async () => {
  try {
    const incidents = await api(`/api/sessions/${sessionId}/check-links`, { method: 'POST' });
    await loadState();
    toast(incidents.length ? `检查完成，新增 ${incidents.length} 条异常工单` : '检查完成：挂链全部正常');
  } catch (e) { toast(e.message, true); }
};

$('#registerSampleBtn').onclick = async () => {
  const file = $('#samplePhoto').files[0];
  const body = {
    productId: $('#sampleProductSelect').value,
    sessionId,
    conform: $('#sampleConform').checked,
    note: $('#sampleNote').value,
  };
  try {
    if (file) {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(',')[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      body.photoBase64 = b64;
      body.photoExt = file.name.split('.').pop();
    }
    await api('/api/samples', { method: 'POST', body });
    $('#sampleNote').value = ''; $('#samplePhoto').value = '';
    await loadState(); toast('样品已登记');
  } catch (e) { toast(e.message, true); }
};

$('#publishBtn').onclick = async () => {
  try {
    const { errors } = await api(`/api/sessions/${sessionId}/validate`);
    if (errors.length) {
      showModal('发布前校验未通过', `<ul>${errors.map((x) => `<li>${esc(x.message)}</li>`).join('')}</ul>`);
      return;
    }
    const { receipt } = await api(`/api/sessions/${sessionId}/publish`, { method: 'POST' });
    await loadState();
    showModal('发布成功', `<p>平台回执：<strong>${esc(receipt.receiptNo)}</strong></p>
      <p class="muted">${receipt.picks} 个排品、${receipt.links} 条挂链已按快照上架。开场后草稿修改不会覆盖直播场次。</p>`);
  } catch (e) { toast(e.message, true); }
};

$('#startBtn').onclick = async () => {
  try { await api(`/api/sessions/${sessionId}/start`, { method: 'POST' }); await loadState(); toast('已开场，使用发布快照'); }
  catch (e) { toast(e.message, true); }
};
$('#endBtn').onclick = async () => {
  try { await api(`/api/sessions/${sessionId}/end`, { method: 'POST' }); await loadState(); toast('场次已结束'); }
  catch (e) { toast(e.message, true); }
};

loadState();
