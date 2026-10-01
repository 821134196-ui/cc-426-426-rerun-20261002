/* 珊瑚直播间 · 排品脚本与挂链审核 前端（原生 JS，零依赖） */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ISSUE_LABEL = {
  none: "正常", oos: "商品缺货", price: "价格变更", dead_link: "链接失效",
  sample: "样品不符", violation: "违规词", withdraw: "临时撤品",
};
const STATUS_CN = {
  planning: "编排中", published: "已发布", live: "直播中", ended: "已结束",
  draft: "草稿", submitted: "待审核", approved: "已通过", rejected: "已驳回",
  live_link: "已上架", taken_down: "已下架", dead: "已失效",
};
const REVIEWERS = ["审核-老周", "审核-阿岚"];
const AUTHORS = ["编导-小晚"];

const state = {
  sessions: [], currentSid: null, meta: { banned_words: [], promos: [], anchors: [] },
  timeline: null, check: null, currentItem: null, products: [],
};

// ---------- HTTP ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), {
    code: data.code, details: data.details,
  });
  return data;
}
const post = (path, body = {}) => api(path, { method: "POST", body });

let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}
async function guard(fn) {
  try { await fn(); } catch (e) {
    toast(e.message + (e.details?.length ? `（${e.details.length} 项问题）` : ""), "err");
  }
}

// ---------- 初始化 ----------
async function init() {
  bindEvents();
  state.meta = await api("/api/meta");
  await loadSessions();
  await loadProducts();
  renderSamples();
  renderReceipts();
}

function bindEvents() {
  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    $$(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${btn.dataset.tab}`));
    if (btn.dataset.tab === "products") loadProducts();
    if (btn.dataset.tab === "samples") renderSamples();
    if (btn.dataset.tab === "receipts") renderReceipts();
  });
  $("#sessionTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".session-tab");
    if (tab) selectSession(Number(tab.dataset.sid));
  });
  $("#btnRunCheck").addEventListener("click", () => guard(loadCheck));
  $("#btnScanIssues").addEventListener("click", () => guard(async () => {
    const r = await post(`/api/sessions/${state.currentSid}/refresh`, {});
    toast(`扫描完成：${r.issues.length} 个异常，${r.alerts.length} 条库存提示`,
      r.issues.length ? "err" : "ok");
    await refreshSession();
  }));
  $("#btnRefresh").addEventListener("click", () => guard(refreshSession));
  $("#btnPublish").addEventListener("click", () => guard(publishFlow));

  $("#btnCloseDrawer").addEventListener("click", closeDrawer);
  $("#drawerMask").addEventListener("click", closeDrawer);
  $("#btnSaveDraft").addEventListener("click", () => guard(saveDraft));
  $("#btnSubmitScript").addEventListener("click", () => guard(async () => {
    await post(`/api/items/${state.currentItem}/script/submit`, {});
    toast("已送审", "ok");
    await refreshSession();
    await openDrawer(state.currentItem);
  }));
  $("#btnApprove").addEventListener("click", () => guard(doReview.bind(null, true)));
  $("#btnReject").addEventListener("click", () => guard(doReview.bind(null, false)));
  $("#scriptContent").addEventListener("input", renderLiveTips);
  $("#reviewerSelect").addEventListener("change", renderLiveTips);

  $("#btnRegisterSample").addEventListener("click", () => guard(registerSample));
}

// ---------- 场次 ----------
async function loadSessions() {
  const data = await api("/api/sessions");
  state.sessions = data.sessions;
  if (!state.sessions.some((s) => s.id === state.currentSid)) {
    state.currentSid = state.sessions[0]?.id ?? null;
  }
  renderSessionTabs();
  if (state.currentSid) await refreshSession();
}

async function selectSession(sid) {
  state.currentSid = sid;
  renderSessionTabs();
  await refreshSession();
}

async function refreshSession() {
  if (!state.currentSid) return;
  const [tl, ck] = await Promise.all([
    api(`/api/sessions/${state.currentSid}/timeline`),
    api(`/api/sessions/${state.currentSid}/check`),
  ]);
  state.timeline = tl; state.check = ck;
  renderSessionTabs();
  renderHeader();
  renderCheck();
  renderTimeline();
  renderAddForm();
}

async function loadCheck() {
  state.check = await api(`/api/sessions/${state.currentSid}/check`);
  renderCheck();
  toast(state.check.ok ? "整场挂链检查通过" : "检查发现问题", state.check.ok ? "ok" : "err");
}

function renderSessionTabs() {
  $("#sessionTabs").innerHTML = state.sessions.map((s) => `
    <div class="session-tab ${s.id === state.currentSid ? "active" : ""}" data-sid="${s.id}">
      <div class="st-title">S${s.id} · ${esc(s.title)}</div>
      <div class="st-sub">${esc(s.anchor_name)} · ${esc(s.starts_at.replace("T", " "))}
        · ${STATUS_CN[s.status]}</div>
    </div>`).join("");
}

function renderHeader() {
  const s = state.timeline?.session;
  const badge = $("#sessionBadge");
  if (!s) { badge.textContent = ""; return; }
  badge.textContent = `S${s.id} ${STATUS_CN[s.status]}`;
  badge.className = `status-badge ${s.status}`;
  const canPublish = s.status === "planning";
  $("#btnPublish").disabled = !canPublish;
  $("#btnPublish").textContent = canPublish ? "发布整场" : `已${STATUS_CN[s.status]}·快照冻结`;

  let meta = `共 ${state.timeline.timeline.items.filter((i) => !i.withdrawn).length} 个在播排品`;
  const btns = [];
  if (s.status === "planning") {
    btns.push(`<button class="btn small dark" id="btnStart">开始直播（需先发布）</button>`);
  } else if (s.status === "published") {
    btns.push(`<button class="btn small coral" id="btnStartNow">开始直播</button>`);
  } else if (s.status === "live") {
    btns.push(`<button class="btn small ghost" id="btnEnd">结束直播</button>`);
  }
  $("#sessionMeta").innerHTML =
    `<span>${meta}</span> <span style="display:inline-flex;gap:6px">${btns.join(" ")}</span>`;
  $("#btnStart")?.addEventListener("click", () =>
    toast("请先点击右上角「发布整场」完成挂链校验", "err"));
  $("#btnStartNow")?.addEventListener("click", () => guard(async () => {
    await post(`/api/sessions/${s.id}/start`, {});
    toast("直播已开始，继续使用发布快照", "ok");
    await refreshSession();
  }));
  $("#btnEnd")?.addEventListener("click", () => guard(async () => {
    await post(`/api/sessions/${s.id}/end`, {});
    await refreshSession();
  }));

  const banner = $("#snapshotBanner");
  if (state.timeline.mode === "snapshot") {
    const vers = state.timeline.timeline.script_versions.join("、") || "—";
    banner.classList.remove("hidden");
    banner.innerHTML = `🔒 本场已发布开播，时间轴与讲解内容使用<b>发布快照</b>（脚本版本 ${vers}，`
      + `${esc(state.timeline.timeline.frozen_at)} 冻结）。之后修改脚本只会生成新版本，草稿不能覆盖快照。`;
  } else {
    banner.classList.add("hidden");
  }
}

// ---------- 挂链检查 ----------
function renderCheck() {
  const ck = state.check;
  if (!ck) return;
  const errLines = ck.errors.map((e) =>
    `<div class="check-line"><span class="dot err"></span>${esc(e)}</div>`).join("");
  const warnLines = (ck.warnings || []).map((w) =>
    `<div class="check-line"><span class="dot warn"></span>${esc(w)}（仅提示，不阻断发布）</div>`
  ).join("");
  const okLine = ck.ok
    ? `<div class="check-allok">✅ 整场挂链校验通过，可以发布（另有 ${(ck.warnings || []).length} 条库存提示）</div>`
    : `<div class="check-line"><span class="dot err"></span><b>${ck.errors.length} 项阻断问题，不能发布</b>（可强制发布并留痕）</div>`;
  $("#checkResult").innerHTML = okLine + errLines + warnLines;
}

// ---------- 时间轴 ----------
function cardProduct(c) {
  // 草稿模式用 product 对象，快照模式内嵌 product
  return c.product || { id: c.product_id, name: c.product_name, image: c.image };
}

function stockPill(c) {
  // 快照模式脚本/价格冻结，但库存看实时运行态（保留发布时库存 stock_at_publish）
  const stock = state.timeline.mode === "snapshot"
    ? (c.stock_live ?? c.stock_at_publish)
    : c.product.stock;
  const cls = stock <= 0 ? "oos" : stock <= c.stock_alert ? "warn" : "ok";
  const txt = stock <= 0 ? "缺货" : `库存 ${stock}`;
  return `<span class="stock-pill ${cls}">${txt}</span>`;
}

function linkChip(c) {
  if (!c.link) return `<span class="link-chip none">未挂链</span>`;
  const st = c.link.status;
  const map = { live: "live", draft: "draft", taken_down: "taken_down", dead: "dead" };
  const label = { live: "🔗 已上架", draft: "🔗 待上架", taken_down: "⛓ 已下架", dead: "⚠ 链接失效" };
  return `<span class="link-chip ${map[st] || "draft"}">${label[st] || st}</span>`;
}

function renderTimeline() {
  const items = state.timeline.timeline.items;
  const sess = state.timeline.session;
  const track = $("#timelineTrack");
  track.innerHTML = items.map((c) => {
    const p = cardProduct(c);
    const promo = c.promo?.label || c.promo_version || "—";
    const promoText = c.promo ? `${c.promo.label}` : esc(promo);
    const mm = Math.round(c.duration_sec / 60);
    const issue = c.issue && c.issue !== "none"
      ? `<div class="issue-tag ${c.issue === "none" ? "" : ""}">⚠ ${ISSUE_LABEL[c.issue] || c.issue}：${esc(c.issue_note || "")}</div>`
      : "";
    // 脚本状态
    let scriptLine = "";
    if (state.timeline.mode === "snapshot") {
      scriptLine = c.script
        ? `<div class="script-state"><span>脚本 v${c.script.version}（快照）</span><span class="ok">${esc(c.script.reviewer || "")} 审</span></div>`
        : `<div class="script-state"><span class="bad">快照中无审核脚本</span></div>`;
    } else if (c.script) {
      const sc = c.script;
      const ok = sc.approved_version != null;
      const right = ok
        ? `<span class="ok">已过审 v${sc.approved_version}</span>`
        : `<span class="bad">${STATUS_CN[sc.latest_status] || sc.latest_status}${sc.violations.length ? "·违规词" : ""}</span>`;
      scriptLine = `<div class="script-state"><span>当前 v${sc.current_version} · ${esc(sc.author)}</span>${right}</div>`;
    } else {
      scriptLine = `<div class="script-state"><span class="bad">未编写脚本</span></div>`;
    }

    const actions = [];
    actions.push(`<button class="btn dark" data-act="script" data-iid="${c.item_id}">脚本</button>`);
    if (sess.status !== "ended") {
      if (!c.withdrawn && c.issue && c.issue !== "none" && c.issue !== "withdraw") {
        actions.push(`<button class="btn ghost" data-act="resolve" data-iid="${c.item_id}">处理异常</button>`);
      }
      if (c.issue === "price") {
        actions.push(`<button class="btn ghost" data-act="sync" data-iid="${c.item_id}">同步价格</button>`);
      }
      if (!c.withdrawn) {
        actions.push(`<button class="btn danger" data-act="withdraw" data-iid="${c.item_id}">撤品</button>`);
      }
      if (c.link && sess.status === "live" && c.link.status !== "taken_down") {
        actions.push(`<button class="btn small ok" data-act="cbonline" data-iid="${c.item_id}">上架回调</button>`);
        actions.push(`<button class="btn small danger" data-act="cboffline" data-iid="${c.item_id}">下架回调</button>`);
      }
    }

    return `
    <div class="pcard ${c.withdrawn ? "withdrawn" : ""}">
      <span class="pos-ribbon">第 ${c.position} 位 · ${mm} 分钟</span>
      ${c.withdrawn ? `<div class="withdrawn-flag"><span>已撤品</span></div>` : ""}
      <img class="pimg" src="${esc(p.image)}" alt="${esc(p.name)}">
      <div class="pbody">
        <div class="pname">${esc(p.name)}</div>
        <div class="fixed-row">${stockPill(c)}${linkChip(c)}</div>
        <div class="meta-line">
          <span>阈值 ${c.stock_alert}</span>
          ${c.link ? `<span>成交 ${c.link.order_count ?? 0} 单</span>` : ""}
        </div>
        <div class="meta-line"><span class="promo-tag">🎟 ${promoText}</span></div>
        ${issue}
        ${scriptLine}
        <div class="pcard-actions">${actions.join("")}</div>
      </div>
    </div>`;
  }).join("");

  track.onclick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const iid = Number(btn.dataset.iid);
    const act = btn.dataset.act;
    guard(async () => {
      if (act === "script") await openDrawer(iid);
      else if (act === "withdraw") {
        const note = prompt("撤品原因（将触发幂等下架，已成交订单保留）", "临时撤品");
        if (note == null) return;
        const r = await post(`/api/items/${iid}/withdraw`, { note });
        toast(`已撤品，挂链状态：${r.offline?.link_status || "无上架挂链"}`, "ok");
        await refreshSession();
      } else if (act === "resolve") {
        await post(`/api/items/${iid}/resolve`, { note: "已处理" });
        await refreshSession();
      } else if (act === "sync") {
        const r = await post(`/api/items/${iid}/link/sync`, {});
        toast(`挂链价已同步为 ¥${r.listed_price}`, "ok");
        await refreshSession();
      } else if (act === "cbonline" || act === "cboffline") {
        const linkId = await linkIdOf(iid);
        const type = act === "cbonline" ? "online" : "offline";
        const r = await post(`/api/links/${linkId}/callback`,
          { event_type: type, event_id: `ui-${type}-${iid}-${Date.now()}`, seq: Date.now() % 100000 });
        toast(`回调：${r.status}${r.changed ? "（状态已变更）" : "（未重复生效）"}`,
          r.status === "processed" ? "ok" : "");
        await refreshSession();
      }
    });
  };
}

async function linkIdOf(iid) {
  const row = state.timeline.timeline.items.find((x) => x.item_id === iid);
  return row.link.id;
}

// ---------- 加入排品 ----------
function renderAddForm() {
  const sess = state.timeline?.session;
  const box = $("#addItemBox");
  if (!sess || sess.status !== "planning") { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const opts = state.products.map((p) => {
    const m = p.material;
    const ok = m?.status === "approved";
    return `<option value="${p.id}" ${ok ? "" : "disabled"}>
      ${p.name}（¥${p.current_price} / 库存 ${p.stock}）— ${ok ? "资料已过审" : `资料${m ? STATUS_CN[m.status] : "未提交"}`}
    </option>`;
  }).join("");
  const promos = state.meta.promos.map((p) => `<option value="${p.code}">${p.label}</option>`).join("");
  $("#addItemForm").innerHTML = `
    <div class="field">商品<select id="fProduct">${opts}</select></div>
    <div class="field">讲解时长(秒)<input id="fDuration" type="number" value="300" min="30"></div>
    <div class="field">库存提示阈值<input id="fAlert" type="number" value="50" min="0"></div>
    <div class="field">优惠版本<select id="fPromo">${promos}</select></div>
    <label class="checkline"><input type="checkbox" id="fLink" checked> 同时挂演示链接（价格取实时价）</label>
    <button class="btn coral" id="fAdd">加入排品</button>`;
  $("#fAdd").onclick = () => guard(async () => {
    const pid = Number($("#fProduct").value);
    const p = state.products.find((x) => x.id === pid);
    await post(`/api/sessions/${sess.id}/items`, {
      product_id: pid,
      duration_sec: Number($("#fDuration").value),
      stock_alert: Number($("#fAlert").value),
      promo_version: $("#fPromo").value,
      url: $("#fLink").checked ? p.link_url : undefined,
    });
    toast("已加入排品", "ok");
    await refreshSession();
  });
}

// ---------- 发布 ----------
async function publishFlow() {
  await loadCheck();
  const ck = state.check;
  if (!ck.ok) {
    const force = confirm(`整场挂链校验有 ${ck.errors.length} 项阻断问题：\n\n${ck.errors.join("\n")}\n\n`
      + "是否仍要强制发布？（会在流水中留痕，未过审/无挂链项将以空缺进入快照）");
    if (!force) return;
  }
  const r = await post(`/api/sessions/${state.currentSid}/publish`, { force: !ck.ok });
  toast(`发布成功，回执号 ${r.receipt_no}`, "ok");
  await loadSessions();
  renderReceipts();
}

// ---------- 脚本抽屉 ----------
async function openDrawer(iid) {
  state.currentItem = iid;
  const ov = await api(`/api/items/${iid}/script`);
  const item = state.timeline.timeline.items.find((x) => x.item_id === iid);
  const p = cardProduct(item);
  $("#drawerTitle").textContent = `脚本 · ${p.name}`;
  $("#drawerSub").textContent = `S${state.currentSid} 第 ${item.position} 位 · 排品项 ${iid}`;

  $("#reviewerSelect").innerHTML = REVIEWERS.map((r) => `<option>${r}</option>`).join("");

  if (!ov.script) {
    $("#scriptAuthor").value = AUTHORS[0];
    $("#scriptContent").value = "";
    $("#scriptVersionTag").textContent = "尚未创建，保存即 v1";
    $("#versionHistory").innerHTML = `<div class="vrow"><span>还没有任何版本</span></div>`;
  } else {
    $("#scriptAuthor").value = ov.latest.author;
    $("#scriptContent").value = ov.latest.content;
    $("#scriptVersionTag").textContent =
      `当前 v${ov.script.current_version} · ${STATUS_CN[ov.latest.status]}`
      + (ov.approved ? ` · 已过审 v${ov.approved.version}` : "");
    const rows = (ov.versions || []).map((v) => `
      <div class="vrow">
        <span>v${v.version} · ${esc(v.author)} · ${v.created_at}</span>
        <span class="vstatus ${v.status}">${STATUS_CN[v.status] || v.status}
          ${v.reviewer ? "· " + esc(v.reviewer) : ""}</span>
      </div>`).join("");
    $("#versionHistory").innerHTML = rows;
  }

  const locked = state.timeline.mode === "snapshot";
  $("#btnSaveDraft").disabled = false;
  $("#btnSubmitScript").disabled = false;
  $("#scriptAuthor").disabled = false;
  renderLiveTips();
  if (locked) {
    let note = $("#snapshotNote");
    if (!note) {
      note = document.createElement("div");
      note.id = "snapshotNote";
      note.className = "snapshot-note";
      $("#scriptContent").before(note);
    }
    note.textContent = "本场已开播：修改仍会生成新版本，但直播继续使用发布快照，草稿无法覆盖。";
  } else {
    $("#snapshotNote")?.remove();
  }

  $("#scriptDrawer").classList.remove("hidden");
  $("#drawerMask").classList.remove("hidden");
}

function closeDrawer() {
  $("#scriptDrawer").classList.add("hidden");
  $("#drawerMask").classList.add("hidden");
}

async function saveDraft() {
  const content = $("#scriptContent").value;
  if (!content.trim()) throw new Error("脚本文本不能为空");
  await post(`/api/items/${state.currentItem}/script/edit`, {
    author: $("#scriptAuthor").value, content,
  });
  toast("已生成新草稿版本", "ok");
  await refreshSession();
  await openDrawer(state.currentItem);
}

async function doReview(approve) {
  const note = $("#reviewNote").value;
  const reviewer = $("#reviewerSelect").value;
  await post(`/api/items/${state.currentItem}/script/review`, { approve, note, reviewer });
  toast(approve ? "审核通过" : "已驳回", approve ? "ok" : "");
  $("#reviewNote").value = "";
  await refreshSession();
  await openDrawer(state.currentItem);
}

function renderLiveTips() {
  const text = $("#scriptContent").value;
  const hits = state.meta.banned_words.filter((w) => text.includes(w));
  const reviewer = $("#reviewerSelect").value;
  const author = $("#scriptAuthor").value;
  const tips = [];
  tips.push(hits.length
    ? `<div class="tip err">🚫 检出违规词：<b>${esc(hits.join("、"))}</b>，该版本无法审核通过</div>`
    : `<div class="tip ok">✅ 未检出违规词（词表 ${state.meta.banned_words.length} 个）</div>`);
  tips.push(reviewer === author
    ? `<div class="tip err">🚫 当前审核人「${esc(reviewer)}」正是脚本作者，不能审核自己编写的脚本</div>`
    : `<div class="tip ok">✅ 审核人「${esc(reviewer)}」与作者「${esc(author)}」不是同一人</div>`);
  const ov = state.timeline?.timeline.items.find((x) => x.item_id === state.currentItem);
  if (ov) {
    const linkOk = !!ov.link;
    tips.push(linkOk
      ? `<div class="tip ok">🔗 已挂链：${esc(ov.link.url)} · ¥${ov.link.listed_price}</div>`
      : `<div class="tip warn">⚠ 该排品还没有挂链，整场校验会拦截</div>`);
  }
  if (state.timeline?.mode === "snapshot") {
    tips.push(`<div class="tip warn">🔒 场次已开播：新版本不会影响正在使用的发布快照</div>`);
  }
  $("#reviewTips").innerHTML = tips.join("");
}

// ---------- 商品与资料审核 ----------
async function loadProducts() {
  const data = await api("/api/products");
  state.products = data.products.map((p) => ({ ...p, material: null }));
  await Promise.all(state.products.map(async (p) => {
    const d = await api(`/api/products/${p.id}`);
    p.material = d.material;
  }));
  if (state.currentSid) renderAddForm();
  renderProducts();
}

function matPill(m) {
  const st = m?.status || "none";
  return `<span class="review-pill ${st}">${
    st === "none" ? "资料未提交" : STATUS_CN[st] || st}${m?.reviewer ? "·" + esc(m.reviewer) : ""}</span>`;
}

function renderProducts() {
  $("#productGrid").innerHTML = state.products.map((p) => `
    <div class="card prod-card">
      <img src="${esc(p.image)}" alt="">
      <div class="prod-body">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="pname">${esc(p.name)}</div>${matPill(p.material)}
        </div>
        <div class="prod-price">
          <span class="now-price">¥${p.current_price.toFixed(2)}</span>
          <span class="base-price">¥${p.base_price.toFixed(2)}</span>
          <span class="stock-pill ${p.stock <= 0 ? "oos" : "ok"}">${p.stock <= 0 ? "缺货" : `库存 ${p.stock}`}</span>
          <span class="link-chip ${p.link_ok ? "live" : "dead"}">${p.link_ok ? "挂链正常" : "链接失效"}</span>
        </div>
        ${p.material?.status === "rejected" ? `<div class="issue-tag">驳回原因：${esc(p.material.reason)}</div>` : ""}
        ${!p.material_complete ? `<div class="issue-tag stock_alert">资料不完整：缺少规格/资质图</div>` : ""}
        <div class="inline-form">
          <button class="btn small dark" data-pact="submit" data-pid="${p.id}">提交资料</button>
          <button class="btn small ok" data-pact="approve" data-pid="${p.id}">通过</button>
          <input type="text" placeholder="驳回原因" id="rej-${p.id}" value="资料不完整">
          <button class="btn small danger" data-pact="reject" data-pid="${p.id}">驳回</button>
        </div>
        <div class="inline-form">
          <input type="number" step="0.1" id="price-${p.id}" value="${p.current_price}" style="max-width:90px">
          <button class="btn small ghost" data-pact="price" data-pid="${p.id}">改价</button>
          <input type="number" id="stock-${p.id}" value="${p.stock}" style="max-width:80px">
          <button class="btn small ghost" data-pact="stock" data-pid="${p.id}">改库存</button>
          <button class="btn small ghost" data-pact="togglelink" data-pid="${p.id}">
            ${p.link_ok ? "置链接失效" : "恢复链接"}</button>
        </div>
      </div>
    </div>`).join("");

  $("#productGrid").onclick = (e) => {
    const btn = e.target.closest("button[data-pact]");
    if (!btn) return;
    const pid = Number(btn.dataset.pid);
    const act = btn.dataset.pact;
    guard(async () => {
      if (act === "submit") await post(`/api/products/${pid}/material/submit`, {});
      else if (act === "approve") await post(`/api/products/${pid}/material/approve`,
        { reviewer: "审核-阿岚" });
      else if (act === "reject") await post(`/api/products/${pid}/material/reject`,
        { reviewer: "审核-阿岚", reason: $(`#rej-${pid}`).value });
      else if (act === "price") await post("/api/demo/price",
        { product_id: pid, price: Number($(`#price-${pid}`).value) });
      else if (act === "stock") await post("/api/demo/stock",
        { product_id: pid, stock: Number($(`#stock-${pid}`).value) });
      else if (act === "togglelink") {
        const cur = state.products.find((x) => x.id === pid);
        await post("/api/demo/link", { product_id: pid, ok: !cur.link_ok });
      }
      await loadProducts();
      if (state.currentSid) await refreshSession();
    });
  };
}

// ---------- 样品 ----------
function demoSampleSvg(label, ok) {
  const color = ok ? "#2E8B57" : "#E85D50";
  const mark = ok
    ? `<circle cx="120" cy="80" r="30" fill="${color}"/><path d="M106 80 l10 10 l20 -22" fill="none" stroke="#fff" stroke-width="6"/>`
    : `<circle cx="120" cy="80" r="30" fill="${color}"/><path d="M108 68 l24 24 M132 68 l-24 24" stroke="#fff" stroke-width="6"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
    <rect width="240" height="160" rx="14" fill="#EFE9DC"/>
    <rect x="30" y="30" width="180" height="100" rx="10" fill="#fff" stroke="#8A8478" stroke-width="2" stroke-dasharray="6 5"/>
    ${mark}
    <text x="120" y="146" font-size="12" text-anchor="middle" fill="#2E3036" font-family="sans-serif">${esc(label)}</text>
  </svg>`;
  return btoa(unescape(encodeURIComponent(svg)));
}

async function renderSamples() {
  const products = state.products.length ? state.products : (await api("/api/products")).products;
  $("#sampleProduct").innerHTML = products.map((p) =>
    `<option value="${p.id}">${p.name}</option>`).join("");
  const list = await api("/api/samples");
  const samples = list.samples;
  $("#sampleList").innerHTML = samples.length ? samples.map((s) => {
    const p = products.find((x) => x.id === s.product_id);
    return `<div class="card sample-card">
      <img src="${esc(s.photo_path)}">
      <div class="sb">
        <span>${esc(p?.name || ("商品 " + s.product_id))}</span>
        <span class="${s.match_status === "ok" ? "match-ok" : "match-bad"}">
          ${s.match_status === "ok" ? "✅ 核对一致" : "⚠ 样品不符"}</span>
        <span style="color:var(--muted)">${esc(s.note || "")}</span>
        <span style="color:var(--muted)">${esc(s.received_by)} · ${s.created_at}</span>
      </div></div>`;
  }).join("") : `<div class="hint">暂无样品登记记录。</div>`;
}

async function registerSample() {
  const pid = Number($("#sampleProduct").value);
  const p = state.products.find((x) => x.id === pid) ||
    (await api("/api/products")).products.find((x) => x.id === pid);
  const mismatch = $("#sampleMismatch").checked;
  const note = $("#sampleNote").value || (mismatch ? "样品与资料不符" : "核对一致");
  const b64 = demoSampleSvg(`${p.name} · ${mismatch ? "不符" : "一致"}`, !mismatch);
  await post(`/api/products/${pid}/sample`, {
    filename: `sample_${pid}_ui.svg`, photo_base64: b64, note, mismatch,
    operator: "仓管-阿May",
  });
  toast("样品已登记，照片已保存到 data/samples", "ok");
  $("#sampleNote").value = "";
  await renderSamples();
}

// ---------- 回执 / 流水 ----------
async function renderReceipts() {
  const [r, a] = await Promise.all([api("/api/receipts"), api("/api/audit")]);
  $("#receiptList").innerHTML = r.receipts.length ? r.receipts.map((x) => `
    <div class="receipt-item ${x.ok ? "good" : "bad"}">
      <span class="receipt-no">${esc(x.receipt_no)}</span>
      <span>${x.ok ? "✅ 成功" : "❌ 失败"}</span>
      <span>场次 ${x.session_id || "—"}</span>
      <span style="color:var(--muted)">${esc(x.channel)}</span>
      <span style="color:var(--muted)">${x.created_at}${x.returned_at ? " · 已回执 " + x.returned_at : " · 待平台回执"}</span>
      <span style="flex:1"></span>
      <code style="font-size:11px;color:var(--muted)">${esc(JSON.stringify(x.detail))}</code>
    </div>`).join("") : `<div class="hint">暂无回执</div>`;

  $("#auditList").innerHTML = a.logs.map((l) => `
    <div class="audit-item">
      <span class="at">${l.created_at}</span>
      <span class="act">${esc(l.action)}</span>
      <span class="who">${esc(l.operator)}</span>
      <span style="color:var(--muted)">${esc(l.ref_type)}#${l.ref_id ?? ""}</span>
      <pre>${esc(l.detail)}</pre>
    </div>`).join("");
}

init().catch((e) => toast("初始化失败：" + e.message, "err"));
