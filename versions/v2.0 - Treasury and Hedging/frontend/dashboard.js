/**
 * Treasury Brain — Dashboard JS
 * SA Bullion × Apple aesthetic
 */

'use strict';

let currentEntity = 'SABIS';
let currentMetal  = 'gold';
let siloChart, channelChart, volumeChart, vwapChart, gpChart;
let zarPerUsd  = 0;   // ZAR per 1 USD — populated from /api/spot
let liveSpots  = { gold: 0, silver: 0 };  // live spot per metal for MTM calc
const POLL_INTERVAL = 30_000;

// Date filter state
let filterMode  = 'all';   // all | today | week | month | year | custom
let filterFrom  = '';
let filterTo    = '';

// ─── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  startClock();
  loadAll();
  setInterval(loadAll, POLL_INTERVAL);
});

function startClock() {
  const el = document.getElementById('live-clock');
  setInterval(() => {
    el.textContent = new Date().toLocaleTimeString('en-ZA', { hour12: false });
  }, 1000);
}

// ─── TAB SWITCHING ────────────────────────────────────────────────────────────

function switchEntity(entity, btn) {
  currentEntity = entity;
  document.querySelectorAll('.entity-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  loadAll();
}

function switchMetal(metal, btn) {
  currentMetal = metal;
  document.querySelectorAll('.metal-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  loadAll();
}

// ─── DATE FILTER ─────────────────────────────────────────────────────────────

function setFilter(mode, btn) {
  filterMode = mode;

  // Update pill active state
  document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const today = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const ymd   = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  if (mode === 'today') {
    filterFrom = filterTo = ymd(today);
  } else if (mode === 'yesterday') {
    const yest = new Date(today);
    yest.setDate(today.getDate() - 1);
    filterFrom = filterTo = ymd(yest);
  } else if (mode === 'week') {
    const mon = new Date(today);
    mon.setDate(today.getDate() - today.getDay() + 1);
    filterFrom = ymd(mon);
    filterTo   = ymd(today);
  } else if (mode === 'month') {
    filterFrom = `${today.getFullYear()}-${pad(today.getMonth()+1)}-01`;
    filterTo   = ymd(today);
  } else if (mode === 'year') {
    filterFrom = `${today.getFullYear()}-01-01`;
    filterTo   = ymd(today);
  } else if (mode === 'custom') {
    filterFrom = document.getElementById('filter-from')?.value || '';
    filterTo   = document.getElementById('filter-to')?.value   || '';
    // Deactivate all pills for custom
    document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
  } else {
    // 'all'
    filterFrom = '';
    filterTo   = '';
  }

  const lbl = document.getElementById('filter-label');
  if (lbl) {
    if      (mode === 'all')       lbl.textContent = 'Showing all deals';
    else if (mode === 'today')     lbl.textContent = 'Today';
    else if (mode === 'yesterday') lbl.textContent = 'Yesterday';
    else if (mode === 'week')      lbl.textContent = 'This week';
    else if (mode === 'month')     lbl.textContent = 'This month';
    else if (mode === 'year')      lbl.textContent = 'This year';
    else if (filterFrom && filterTo) lbl.textContent = `${filterFrom} → ${filterTo}`;
    else lbl.textContent = '';
  }

  loadAll();
}

function buildDealsUrl() {
  const base = `/api/deals?entity=${currentEntity}&metal=${currentMetal}&limit=1000`;
  if (filterFrom) return base + `&from=${filterFrom}` + (filterTo ? `&to=${filterTo}` : '');
  return base;
}

function buildPipelineUrl() {
  const base = `/api/pipeline?entity=${currentEntity}&metal=${currentMetal}`;
  if (filterFrom) return base + `&from=${filterFrom}` + (filterTo ? `&to=${filterTo}` : '');
  return base;
}

// ─── LOAD ALL ────────────────────────────────────────────────────────────────

function buildExposureUrl() {
  const base = `/api/exposure?entity=${currentEntity}&metal=${currentMetal}`;
  if (filterFrom) return base + `&from=${filterFrom}` + (filterTo ? `&to=${filterTo}` : '');
  return base;
}

function buildOtherExposureUrl() {
  const otherMetal = currentMetal === 'gold' ? 'silver' : 'gold';
  const base = `/api/exposure?entity=${currentEntity}&metal=${otherMetal}`;
  if (filterFrom) return base + `&from=${filterFrom}` + (filterTo ? `&to=${filterTo}` : '');
  return base;
}

async function loadAll() {
  const otherMetal = currentMetal === 'gold' ? 'silver' : 'gold';
  const otherDealsUrl = `/api/deals?entity=${currentEntity}&metal=${otherMetal}&limit=1000` +
    (filterFrom ? `&from=${filterFrom}` + (filterTo ? `&to=${filterTo}` : '') : '');

  const otherMetal2     = currentMetal === 'gold' ? 'silver' : 'gold';
  const otherHedgingUrl = `/api/hedging?entity=${currentEntity}&metal=${otherMetal2}`;
  const otherInvUrl     = `/api/inventory?entity=${currentEntity}&metal=${otherMetal2}`;

  const [deals, inv, hedging, pipeline, otherDeals, exposure, otherExposure, otherHedging, otherInv] = await Promise.all([
    api(buildDealsUrl()).catch(() => []),
    api(`/api/inventory?entity=${currentEntity}&metal=${currentMetal}`).catch(() => ({})),
    api(`/api/hedging?entity=${currentEntity}&metal=${currentMetal}`).catch(() => ({ positions: [], long_oz: 0, short_oz: 0, net_oz: 0 })),
    api(buildPipelineUrl()).catch(() => []),
    api(otherDealsUrl).catch(() => []),
    api(buildExposureUrl()).catch(() => ({})),
    api(buildOtherExposureUrl()).catch(() => ({})),
    api(otherHedgingUrl).catch(() => ({ positions: [] })),
    api(otherInvUrl).catch(() => ({})),
  ]);

  // Combine all metals' positions for the ledger table, sorted gold→silver, longs→shorts, newest first
  const allPositions = [
    ...(hedging.positions || []),
    ...(otherHedging.positions || []),
  ].sort((a, b) => {
    if (a.metal !== b.metal) return a.metal === 'gold' ? -1 : 1;
    if (a.position_type !== b.position_type) return a.position_type === 'long' ? -1 : 1;
    return (b.open_date || '').localeCompare(a.open_date || '');
  });

  // Physical inventory per metal for exposure effect calculation
  const goldPhysical   = currentMetal === 'gold'   ? (inv.total_oz || 0) : (otherInv.total_oz || 0);
  const silverPhysical = currentMetal === 'silver' ? (inv.total_oz || 0) : (otherInv.total_oz || 0);

  // Pre-compute combined GP + combined alpha for the PNL card
  const goldDeals_    = currentMetal === 'gold'   ? deals : otherDeals;
  const silverDeals_  = currentMetal === 'silver' ? deals : otherDeals;
  const goldGP_       = goldDeals_.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  const silverGP_     = silverDeals_.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  const combinedGP_   = goldGP_ + silverGP_;
  const goldAlpha_    = currentMetal === 'gold'   ? (exposure.treasury_alpha || 0) : (otherExposure.treasury_alpha || 0);
  const silverAlpha_  = currentMetal === 'silver' ? (exposure.treasury_alpha || 0) : (otherExposure.treasury_alpha || 0);
  const combinedAlpha_ = goldAlpha_ + silverAlpha_;

  renderExposure(deals, inv, hedging);
  renderCombinedGP(deals, otherDeals);
  renderCombinedPNL(combinedGP_, combinedAlpha_, goldGP_, silverGP_, goldAlpha_, silverAlpha_);
  renderTrading(deals);
  renderHedging(hedging, inv);
  renderLongsShorts(hedging, inv);
  renderCombinedExposure(exposure);
  renderBannerAlpha(exposure, otherExposure);
  renderPositionsTable(allPositions, goldPhysical, silverPhysical);
  renderPipelineTable(pipeline, inv, hedging);
  renderDealsTable(deals);
  renderAgedInventory(inv.aged_parcels || []);
  await loadSpot();
}

// ─── EXPOSURE BANNER ─────────────────────────────────────────────────────────

function renderExposure(deals, inv, hedging) {
  const spot      = inv.spot_zar  || 0;
  const bullionOz = inv.total_oz  || 0;
  const hedgeNet  = (hedging && hedging.net_oz) || 0;

  // Ecosystem net = bullion/physical inventory + net hedge positions (for exposure display)
  const ecosystemOz = bullionOz + hedgeNet;

  // Provision mode driven by PHYSICAL inventory only — hedges are irrelevant to provision
  const provActive = bullionOz < 0;
  const provRate   = (inv.provision || {}).rate_pct || 0;

  const totalGP = deals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  // ZAR value is the prominent figure; oz breakdown in sub-label
  const zarValue = Math.abs(ecosystemOz) * spot;
  set('exp-value-zar', formatCurrency(zarValue));
  set('exp-oz',        `${fmt(ecosystemOz, 2)} oz net  |  ${fmt(bullionOz, 2)} oz physical`);
  set('exp-gp',        formatCurrency(totalGP));
  set('exp-gp-sub',    `${deals.length} deal${deals.length !== 1 ? 's' : ''} total`);
  set('exp-spot',      formatCurrency(spot));
  set('exp-provision', provActive ? 'PROVISION' : 'NO PROVISION');
  set('exp-prov-sub',  provActive ? `${provRate}% applies` : `Physical: ${fmt(bullionOz, 2)} oz`);

  const provCard = document.getElementById('exp-card-provision');
  if (provCard) {
    provCard.classList.toggle('active',   provActive);
    provCard.classList.toggle('inactive', !provActive);
  }
}

// ─── COMBINED GP (Au + Ag) ────────────────────────────────────────────────────

function renderCombinedGP(currentDeals, otherDeals) {
  const goldDeals   = currentMetal === 'gold'   ? currentDeals : otherDeals;
  const silverDeals = currentMetal === 'silver' ? currentDeals : otherDeals;

  const goldGP   = goldDeals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  const silverGP = silverDeals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  const totalGP  = goldGP + silverGP;

  set('exp-combined-gp',     formatCurrency(totalGP));
  set('exp-combined-gp-sub', `Au ${formatCurrency(goldGP)}  |  Ag ${formatCurrency(silverGP)}`);
}

// ─── COMBINED PNL BANNER ─────────────────────────────────────────────────────

function renderCombinedPNL(combinedGP, combinedAlpha, goldGP, silverGP, goldAlpha, silverAlpha) {
  const totalPNL = combinedGP + combinedAlpha;
  set('exp-combined-pnl', formatCurrency(totalPNL));
  set('exp-combined-pnl-sub',
    `Au GP ${formatCurrency(goldGP)}  |  Ag GP ${formatCurrency(silverGP)}` +
    `\u2003Au α ${formatCurrency(goldAlpha)}  |  Ag α ${formatCurrency(silverAlpha)}`
  );

  const card = document.getElementById('exp-card-combined-pnl');
  if (card) {
    card.classList.toggle('alpha-positive', totalPNL >= 0);
    card.classList.toggle('alpha-negative', totalPNL <  0);
  }
}

// ─── TREASURY ALPHA BANNER ───────────────────────────────────────────────────

function renderBannerAlpha(currentExp, otherExp) {
  const currentAlpha  = (currentExp && currentExp.treasury_alpha) || 0;
  const otherAlpha    = (otherExp   && otherExp.treasury_alpha)   || 0;
  const goldAlpha     = currentMetal === 'gold'   ? currentAlpha : otherAlpha;
  const silverAlpha   = currentMetal === 'silver' ? currentAlpha : otherAlpha;
  const combinedAlpha = goldAlpha + silverAlpha;

  set('exp-alpha',     formatCurrency(currentAlpha));
  set('exp-alpha-sub', `${currentMetal === 'gold' ? 'Au' : 'Ag'} · ${fmt((currentExp && currentExp.matched_oz) || 0, 2)} oz matched`);
  set('exp-combined-alpha',     formatCurrency(combinedAlpha));
  set('exp-combined-alpha-sub', `Au ${formatCurrency(goldAlpha)}  |  Ag ${formatCurrency(silverAlpha)}`);

  const alphaCard = document.getElementById('exp-card-alpha');
  if (alphaCard) {
    alphaCard.classList.toggle('alpha-positive', currentAlpha >= 0);
    alphaCard.classList.toggle('alpha-negative', currentAlpha <  0);
  }
  const combinedCard = document.getElementById('exp-card-combined-alpha');
  if (combinedCard) {
    combinedCard.classList.toggle('alpha-positive', combinedAlpha >= 0);
    combinedCard.classList.toggle('alpha-negative', combinedAlpha <  0);
  }
}

// ─── TOP DEAL TRACKER ────────────────────────────────────────────────────────

function renderTopDeal(deals) {
  const section = document.getElementById('top-deal-section');
  if (!section) return;

  if (!deals.length) { section.style.display = 'none'; return; }

  // Deal with highest GP contribution in the current filter period
  const top = deals.reduce((best, d) =>
    (d.gp_contribution_zar || 0) > (best.gp_contribution_zar || 0) ? d : best
  , deals[0]);

  const totalGP  = deals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  const gpShare  = totalGP > 0 ? (top.gp_contribution_zar / totalGP) * 100 : 0;
  const dealer   = top.dealer_name || top.channel || '–';
  const dealType = top.deal_type === 'buy' ? 'Buyback' : 'Sale';

  section.style.display = '';
  set('top-deal-dealer',  dealer);
  set('top-deal-product', top.product_name || top.product_code || '–');
  set('top-deal-type',    dealType);
  set('top-deal-oz',      fmt(top.oz || 0, 2) + ' oz');
  set('top-deal-gp',      formatCurrency(top.gp_contribution_zar || 0));
  set('top-deal-share',   fmt(gpShare, 1) + '% of total GP');
}

// ─── TRADING CARDS (Buybacks / Sales / Hedging) ───────────────────────────────

function renderTrading(deals) {
  const buys  = deals.filter(d => d.deal_type === 'buy');
  const sells = deals.filter(d => d.deal_type === 'sell');

  function calcStats(subset) {
    const count = subset.length;
    const oz    = subset.reduce((s, d) => s + (d.oz || 0), 0);
    const val   = subset.reduce((s, d) => s + (d.deal_value_zar || 0), 0);
    const vwap  = oz > 0 ? val / oz : 0;
    const gp    = subset.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
    const vwapMargin = oz > 0
      ? subset.reduce((s, d) => s + (d.margin_pct || 0) * (d.oz || 0), 0) / oz
      : 0;
    return { count, oz, val, vwap, gp, vwapMargin };
  }

  const b = calcStats(buys);
  const s = calcStats(sells);

  // Buybacks
  set('buy-count',  b.count + ' deal' + (b.count !== 1 ? 's' : ''));
  set('buy-vwap',   b.vwap > 0 ? formatCurrency(b.vwap) : '–');
  set('buy-margin', b.count > 0 ? fmt(b.vwapMargin, 2) + '%' : '–');
  set('buy-oz',     fmt(b.oz, 2) + ' oz');
  set('buy-value',  formatCurrency(b.val));
  set('buy-gp',     formatCurrency(b.gp));

  // Sales
  set('sell-count',  s.count + ' deal' + (s.count !== 1 ? 's' : ''));
  set('sell-vwap',   s.vwap > 0 ? formatCurrency(s.vwap) : '–');
  set('sell-margin', s.count > 0 ? fmt(s.vwapMargin, 2) + '%' : '–');
  set('sell-oz',     fmt(s.oz, 2) + ' oz');
  set('sell-value',  formatCurrency(s.val));
  set('sell-gp',     formatCurrency(s.gp));

  // Hedging rendered separately via renderHedging()

  // Silo / channel charts
  renderSiloChart(calcSiloStats(deals));
  renderChannelChart(calcChannelStats(deals));
  renderVolumeChart(deals);
  renderVwapChart(deals);
  renderGpChart(deals);
  renderDealerTable(deals);
  renderTopDeal(deals);
}

// ─── HEDGING / POSITIONS ─────────────────────────────────────────────────────

function renderHedging(hedging, inv) {
  const longOz      = hedging.long_oz   || 0;
  const shortOz     = hedging.short_oz  || 0;
  const netOz       = hedging.net_oz    || 0;
  const longVwap    = hedging.long_vwap  || 0;
  const shortVwap   = hedging.short_vwap || 0;
  const bullionOz   = (inv && inv.total_oz) || 0;
  const ecosystemOz = bullionOz + netOz;
  const positions   = hedging.positions || [];

  set('hedge-count',      `${positions.length} position${positions.length !== 1 ? 's' : ''}`);
  set('hedge-long-oz',    fmt(longOz,  2) + ' oz');
  set('hedge-long-vwap',  longVwap  > 0 ? formatCurrency(longVwap)  : '–');
  set('hedge-short-oz',   fmt(shortOz, 2) + ' oz');
  set('hedge-short-vwap', shortVwap > 0 ? formatCurrency(shortVwap) : '–');
  set('hedge-net-oz',     fmt(netOz,       2) + ' oz');
  set('hedge-ecosystem-oz', fmt(ecosystemOz, 2) + ' oz');

  // Render individual position rows
  const list = document.getElementById('hedge-positions-list');
  if (!list) return;
  list.innerHTML = '';

  if (!positions.length) {
    list.innerHTML = '<div class="hedge-pos-empty">No positions — add below</div>';
    return;
  }

  positions.forEach(p => {
    const isLong = p.position_type === 'long';
    const div = document.createElement('div');
    div.className = 'hedge-pos-row';
    div.innerHTML = `
      <span class="hedge-pos-platform">${p.platform || 'Unknown'}</span>
      <span class="hedge-pos-type ${isLong ? 'long-label' : 'short-label'}">${isLong ? 'Long' : 'Short'}</span>
      <span class="hedge-pos-oz ${isLong ? 'long-val' : 'short-val'}">${fmt(p.contract_oz, 2)} oz</span>
      <span class="hedge-pos-price">${formatCurrency(p.open_price_zar)}</span>
      <button class="btn-hedge-remove" onclick="removeHedgePosition(${p.id})" title="Remove">×</button>
    `;
    list.appendChild(div);
  });
}

// ─── TREASURY POSITIONS (Longs / Shorts) ─────────────────────────────────────

function renderLongsShorts(hedging, inv) {
  const positions = (hedging && hedging.positions) || [];
  const longs  = positions.filter(p => p.position_type === 'long');
  const shorts = positions.filter(p => p.position_type === 'short');

  const longOz   = longs.reduce((s, p)  => s + (p.contract_oz    || 0), 0);
  const shortOz  = shorts.reduce((s, p) => s + (p.contract_oz    || 0), 0);
  const longVal  = longs.reduce((s, p)  => s + (p.open_price_zar || 0) * (p.contract_oz || 0), 0);
  const shortVal = shorts.reduce((s, p) => s + (p.open_price_zar || 0) * (p.contract_oz || 0), 0);
  const longVwap  = longOz  > 0 ? longVal  / longOz  : 0;
  const shortVwap = shortOz > 0 ? shortVal / shortOz : 0;

  const netOz       = longOz - shortOz;
  const bullionOz   = (inv && inv.total_oz) || 0;
  const ecosystemOz = bullionOz + netOz;

  set('ht-long-count', longs.length  + ' position' + (longs.length  !== 1 ? 's' : ''));
  set('ht-long-vwap',  longVwap  > 0 ? formatCurrency(longVwap)  : '–');
  set('ht-long-val',   formatCurrency(longVal));
  set('ht-long-oz',    fmt(longOz, 2)  + ' oz');

  set('ht-short-count', shorts.length + ' position' + (shorts.length !== 1 ? 's' : ''));
  set('ht-short-vwap',  shortVwap > 0 ? formatCurrency(shortVwap) : '–');
  set('ht-short-val',   formatCurrency(shortVal));
  set('ht-short-oz',    fmt(shortOz, 2) + ' oz');

  set('ht-net-oz', fmt(netOz,       2) + ' oz');
  set('ht-eco-oz', fmt(ecosystemOz, 2) + ' oz');
}

// ─── COMBINED EXPOSURE + TREASURY ALPHA ──────────────────────────────────────

function renderCombinedExposure(exp) {
  if (!exp || !exp.buy_side) return;

  const bs    = exp.buy_side  || {};
  const ss    = exp.sell_side || {};
  const alpha = exp.treasury_alpha || 0;

  // Buy-side (Buybacks + Longs)
  set('cexp-buy-oz',       fmt(bs.oz || 0, 2) + ' oz');
  set('cexp-buy-vwap',     bs.vwap > 0 ? formatCurrency(bs.vwap) : '–');
  set('cexp-buy-val',      formatCurrency(bs.val || 0));
  set('cexp-buy-physical', fmt(bs.buy_oz  || 0, 2) + ' oz');
  set('cexp-buy-hedged',   fmt(bs.long_oz || 0, 2) + ' oz');
  set('cexp-buy-badge',    fmt(bs.oz      || 0, 2) + ' oz total');

  // Sell-side (Sales + Shorts)
  set('cexp-sell-oz',       fmt(ss.oz || 0, 2) + ' oz');
  set('cexp-sell-vwap',     ss.vwap > 0 ? formatCurrency(ss.vwap) : '–');
  set('cexp-sell-val',      formatCurrency(ss.val || 0));
  set('cexp-sell-physical', fmt(ss.sell_oz  || 0, 2) + ' oz');
  set('cexp-sell-hedged',   fmt(ss.short_oz || 0, 2) + ' oz');
  set('cexp-sell-badge',    fmt(ss.oz       || 0, 2) + ' oz total');

  // Treasury Alpha
  set('cexp-alpha',         formatCurrency(alpha));
  set('cexp-alpha-sub',     fmt(exp.matched_oz || 0, 2) + ' oz matched');
  set('cexp-matched-badge', fmt(exp.matched_oz || 0, 2) + ' oz matched');

  const alphaCard = document.getElementById('cexp-alpha-card');
  if (alphaCard) {
    alphaCard.classList.toggle('positive', alpha > 0);
    alphaCard.classList.toggle('negative', alpha < 0);
  }
}

// ─── POSITIONS LEDGER TABLE ───────────────────────────────────────────────────

function renderPositionsTable(positions, goldPhysical, silverPhysical) {
  const tbody   = document.getElementById('positions-tbody');
  const countEl = document.getElementById('positions-count-label');
  if (!tbody) return;

  const open = positions.filter(p => p.status === 'open' || !p.status);
  if (countEl) countEl.textContent = open.length ? `${open.length} open` : '';

  if (!open.length) {
    tbody.innerHTML = `<tr><td colspan="15" class="empty-row">No open positions — add via the Hedging &amp; Positions panel above</td></tr>`;
    return;
  }

  // ── Running net exposure (calculated chronologically, oldest position first) ──
  // Mirrors inventory_after_oz in the deals table: shows where net exposure lands
  // after each hedge position has been applied.
  const physical = { gold: goldPhysical || 0, silver: silverPhysical || 0 };
  const running  = { gold: physical.gold, silver: physical.silver };

  // Running hedge VWAP per metal — for % vs spot calculation
  const runningHedgeVal = { gold: 0, silver: 0 };  // Σ(delta × open_price)
  const runningHedgeOz  = { gold: 0, silver: 0 };  // Σ(delta) — net hedge oz

  const chronological = [...open].sort((a, b) =>
    (a.open_date || '').localeCompare(b.open_date || '') || a.id - b.id
  );
  for (const p of chronological) {
    const delta        = p.position_type === 'long' ? p.contract_oz : -p.contract_oz;
    running[p.metal]         += delta;
    runningHedgeVal[p.metal] += delta * p.open_price_zar;
    runningHedgeOz[p.metal]  += delta;

    const spot       = liveSpots[p.metal] || 0;
    const hedgeVwap  = runningHedgeOz[p.metal] !== 0
      ? runningHedgeVal[p.metal] / runningHedgeOz[p.metal] : 0;

    p._hedgeEffect  = delta;
    p._runningNet   = running[p.metal];
    p._physicalBase = physical[p.metal];
    p._coverPct     = physical[p.metal] !== 0
      ? (Math.abs(delta) / Math.abs(physical[p.metal]) * 100) : 0;
    p._runZar       = Math.abs(running[p.metal]) * spot;
    // % diff = how far live spot is from the avg hedge open price
    p._spotPct      = (spot > 0 && hedgeVwap > 0)
      ? (spot - hedgeVwap) / hedgeVwap * 100 : null;
  }

  // ── Render in display order (gold→silver, longs→shorts, newest first) ─────────
  tbody.innerHTML = open.map(p => {
    const spot     = liveSpots[p.metal] || 0;
    const bookVal  = (p.contract_oz || 0) * (p.open_price_zar || 0);
    const mtm      = spot > 0
      ? (p.position_type === 'long'
          ? (spot - p.open_price_zar) * p.contract_oz
          : (p.open_price_zar - spot) * p.contract_oz)
      : null;
    const mtmPct   = (mtm !== null && bookVal > 0) ? (mtm / bookVal * 100) : null;
    const isLong   = p.position_type === 'long';
    const mtmClass = mtm === null ? '' : (mtm >= 0 ? 'pos-mtm-pos' : 'pos-mtm-neg');

    // Hedge effect column
    const effSign  = p._hedgeEffect >= 0 ? '+' : '';
    const effClass = p._hedgeEffect >= 0 ? 'pos-mtm-pos' : 'pos-mtm-neg';

    // Running net column — direction label + ZAR at live spot + % vs spot
    const netAbs   = Math.abs(p._runningNet);
    const dirLabel = p._runningNet > 0 ? 'Long' : p._runningNet < 0 ? 'Short' : 'Flat';
    const dirClass = p._runningNet > 0 ? 'pos-mtm-pos' : p._runningNet < 0 ? 'pos-mtm-neg' : '';
    const spotSign = p._spotPct !== null ? (p._spotPct >= 0 ? '+' : '') : '';
    const spotPctClass = p._spotPct !== null
      ? (p._spotPct >= 0 ? 'pos-mtm-pos' : 'pos-mtm-neg') : '';

    return `<tr>
      <td class="pos-id">${p.id}</td>
      <td>${p.open_date || '–'}</td>
      <td><span class="pos-metal-badge ${p.metal}">${p.metal === 'gold' ? 'Au' : 'Ag'}</span></td>
      <td>${p.platform || '–'}</td>
      <td><span class="pos-type-badge ${isLong ? 'pos-long' : 'pos-short'}">${isLong ? 'Long' : 'Short'}</span></td>
      <td class="num">${fmt(p.contract_oz, 2)} oz</td>
      <td class="num">${formatCurrency(p.open_price_zar)}</td>
      <td class="num">${formatCurrency(bookVal)}</td>
      <td class="num">${spot > 0 ? formatCurrency(spot) : '–'}</td>
      <td class="num ${mtmClass}">${mtm !== null ? formatCurrency(mtm) : '–'}</td>
      <td class="num ${mtmClass}">${mtmPct !== null ? fmt(mtmPct, 2) + '%' : '–'}</td>
      <td class="num ${effClass}">${effSign}${fmt(p._hedgeEffect, 2)} oz
        <span class="pos-cover">${fmt(p._coverPct, 1)}% of physical</span></td>
      <td class="num pos-net-cell">
        <span class="${dirClass}">${fmt(netAbs, 2)} oz ${dirLabel}</span>
        <span class="pos-cover">${p._runZar > 0 ? formatCurrency(p._runZar) + ' at spot' : '–'}</span>
        ${p._spotPct !== null
          ? `<span class="pos-cover ${spotPctClass}">${spotSign}${fmt(p._spotPct, 2)}% vs avg open</span>`
          : ''}
      </td>
      <td class="pos-notes">${p.notes || '–'}</td>
      <td><button class="btn-pos-close" onclick="closePosition(${p.id})">Close</button></td>
    </tr>`;
  }).join('');
}

async function closePosition(id) {
  try {
    await api(`/api/hedging/${id}`, { method: 'DELETE' });
    showToast('Position closed');
    loadAll();
  } catch (e) {
    showToast('Failed to close position', true);
  }
}

async function addHedgePosition() {
  const platform = document.getElementById('h-platform')?.value || '';
  const type     = document.getElementById('h-type')?.value    || 'long';
  const oz       = parseFloat(document.getElementById('h-oz')?.value);
  const price    = parseFloat(document.getElementById('h-price')?.value) || null;

  if (!oz || isNaN(oz)) { showToast('Enter a valid oz amount', true); return; }

  try {
    await api('/api/hedging', {
      method: 'POST',
      json: {
        entity:         currentEntity,
        metal:          currentMetal,
        position_type:  type,
        contract_oz:    oz,
        open_price_zar: price,
        platform:       platform,
      },
    });
    // Clear inputs
    document.getElementById('h-oz').value    = '';
    document.getElementById('h-price').value = '';
    showToast(`Added ${type} ${oz} oz on ${platform}`);
    loadAll();
  } catch (e) {
    showToast('Failed to add position: ' + e.message, true);
  }
}

async function removeHedgePosition(id) {
  try {
    await api(`/api/hedging/${id}`, { method: 'DELETE' });
    loadAll();
  } catch (e) {
    showToast('Failed to remove position: ' + e.message, true);
  }
}

// ─── DEALER BREAKDOWN TABLE ───────────────────────────────────────────────────

function renderDealerTable(deals) {
  const tbody = document.getElementById('dealer-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // Group by dealer name
  const dealers = {};
  deals.forEach(d => {
    const name = (d.dealer_name || '').trim() || 'Unknown';
    if (!dealers[name]) dealers[name] = { buys: [], sells: [] };
    if (d.deal_type === 'buy')  dealers[name].buys.push(d);
    else                         dealers[name].sells.push(d);
  });

  const totalGP = deals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  // Sort by total GP descending
  const sorted = Object.entries(dealers).sort(([, a], [, b]) => {
    const gpA = [...a.buys, ...a.sells].reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
    const gpB = [...b.buys, ...b.sells].reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
    return gpB - gpA;
  });

  if (!sorted.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--muted)">No dealer data</td></tr>';
    return;
  }

  sorted.forEach(([name, { buys, sells }]) => {
    const all   = [...buys, ...sells];
    const buyOz  = buys.reduce((s, d)  => s + (d.oz || 0), 0);
    const sellOz = sells.reduce((s, d) => s + (d.oz || 0), 0);
    const buyVal  = buys.reduce((s, d)  => s + (d.deal_value_zar || 0), 0);
    const sellVal = sells.reduce((s, d) => s + (d.deal_value_zar || 0), 0);
    const buyVwap  = buyOz  > 0 ? buyVal  / buyOz  : 0;
    const sellVwap = sellOz > 0 ? sellVal / sellOz : 0;
    const gp       = all.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
    const gpPct    = totalGP > 0 ? (gp / totalGP) * 100 : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;color:var(--text)">${name}</td>
      <td>${all.length}</td>
      <td class="buy">${buys.length}</td>
      <td class="sell">${sells.length}</td>
      <td>${fmt(buyOz, 2)} oz</td>
      <td>${fmt(sellOz, 2)} oz</td>
      <td>${buyVwap  > 0 ? formatCurrency(buyVwap)  : '–'}</td>
      <td>${sellVwap > 0 ? formatCurrency(sellVwap) : '–'}</td>
      <td style="color:${gp >= 0 ? 'var(--gold)' : 'var(--red)'};font-weight:600">${formatCurrency(gp)}</td>
      <td style="color:var(--muted)">${fmt(gpPct, 1)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── PIPELINE TABLE ───────────────────────────────────────────────────────────

function renderPipelineTable(pipeline, inv, hedging) {
  const tbody = document.getElementById('pipeline-tbody');
  if (!tbody) return;

  const label = document.getElementById('pipeline-count-label');
  if (label) label.textContent = pipeline.length ? `(${pipeline.length})` : '';

  const section = document.getElementById('pipeline-section');
  if (section) section.style.display = pipeline.length ? '' : 'none';

  tbody.innerHTML = '';
  if (!pipeline.length) return;

  const spot       = (inv && inv.spot_zar) || 0;
  const provision  = (inv && inv.provision) || {};
  const provRate   = provision.rate_pct || 0;
  const bullionOz  = (inv && inv.total_oz) || 0;
  // Live ecosystem net = physical inventory + hedge net (hedges don't change per pipeline deal)
  const hedgeNet   = (hedging && hedging.net_oz) || 0;
  const liveEcoOz  = bullionOz + hedgeNet;

  pipeline.forEach(p => {
    const oz       = parseFloat(p.oz) || 0;
    const margin   = parseFloat(p.margin_pct) || 0;
    const useSpot  = parseFloat(p.spot_price_zar) || spot;
    const dealType = p.deal_type || 'sell';

    const effectivePrice = dealType === 'sell'
      ? useSpot * (1 + margin / 100)
      : useSpot * (1 - margin / 100);
    const estValue = effectivePrice * oz;

    // Estimated GP using provision hurdle
    const profitPct = dealType === 'sell'
      ? margin - provRate
      : provRate - margin;
    const estGP = (profitPct / 100) * (useSpot * oz);

    // Exposure effect on live ecosystem net (physical + hedges)
    const exposureDelta = dealType === 'buy' ? oz : -oz;
    const newEcoOz      = liveEcoOz + exposureDelta;
    const deltaLabel    = `${exposureDelta >= 0 ? '+' : ''}${fmt(exposureDelta, 2)} oz`;
    const ecoLabel      = `${fmt(liveEcoOz, 2)} → ${fmt(newEcoOz, 2)} oz`;

    const tr = document.createElement('tr');
    tr.className = 'pipeline-row';
    tr.innerHTML = `
      <td>${p.deal_date || '–'}</td>
      <td class="${dealType}">${dealType === 'buy' ? 'Buyback' : 'Sale'}</td>
      <td>${p.product_name || p.product_code || '–'}</td>
      <td>${fmt(p.units)}</td>
      <td>${fmt(oz, 2)} oz</td>
      <td>${formatCurrency(useSpot)}</td>
      <td>${fmt(margin, 2)}%</td>
      <td>${formatCurrency(estValue)}</td>
      <td style="color:${estGP >= 0 ? 'var(--gold)' : 'var(--red)'};font-weight:600">${formatCurrency(estGP)}</td>
      <td style="color:${exposureDelta >= 0 ? 'var(--green)' : 'var(--red)'}">
        <span style="font-weight:600">${deltaLabel}</span>
        <span style="color:var(--muted);font-size:11px;display:block">${ecoLabel}</span>
      </td>
      <td><button class="btn-confirm-deal" onclick="confirmPipelineDeal(${p.id})">Confirm ✓</button></td>
    `;
    tbody.appendChild(tr);
  });
}

async function confirmPipelineDeal(id) {
  try {
    const r = await api(`/api/pipeline/${id}/confirm`, { method: 'POST' });
    showToast('Deal confirmed and moved to transactions');
    loadAll();
  } catch (e) {
    showToast('Confirm failed: ' + e.message, true);
  }
}

// ─── DEALS TABLE ─────────────────────────────────────────────────────────────

function renderDealsTable(deals) {
  const tbody = document.getElementById('deals-tbody');
  tbody.innerHTML = '';

  const label = document.getElementById('deals-count-label');
  if (label) label.textContent = deals.length ? `(${deals.length})` : '';

  if (!deals.length) {
    tbody.innerHTML = '<tr><td colspan="17" style="text-align:center;padding:24px;color:var(--muted)">No deals found — upload a dealer sheet to get started</td></tr>';
    return;
  }

  // Group by date (deals arrive newest-first, so reverse for chronological display)
  const byDate = {};
  [...deals].reverse().forEach(d => {
    const dt = d.deal_date || 'Unknown';
    if (!byDate[dt]) byDate[dt] = [];
    byDate[dt].push(d);
  });

  // Render each day with a date separator row
  Object.entries(byDate).forEach(([dateStr, dayDeals]) => {
    // Date header row
    const dateRow = document.createElement('tr');
    dateRow.className = 'date-separator';
    const buyCount  = dayDeals.filter(d => d.deal_type === 'buy').length;
    const sellCount = dayDeals.filter(d => d.deal_type === 'sell').length;
    const dayGP     = dayDeals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
    dateRow.innerHTML = `
      <td colspan="17">
        <span class="date-sep-label">${formatDate(dateStr)}</span>
        <span class="date-sep-meta">${dayDeals.length} deals &nbsp;·&nbsp; ${buyCount} buybacks &nbsp;·&nbsp; ${sellCount} sales &nbsp;·&nbsp; GP ${formatCurrency(dayGP)}</span>
      </td>
    `;
    tbody.appendChild(dateRow);

    // Deal rows for this day
    dayDeals.forEach(d => {
      const isProof = d.product_type === 'proof';
      const tr = document.createElement('tr');
      if (isProof) tr.className = 'proof-row';
      tr.innerHTML = `
        <td>${d.id}</td>
        <td>–</td>
        <td class="${d.deal_type}">${d.deal_type === 'buy' ? 'Buyback' : 'Sale'}</td>
        <td>${d.dealer_name || '–'}</td>
        <td>${d.silo     || '–'}</td>
        <td>${d.channel  || '–'}</td>
        <td>${d.product_name || d.product_code || '–'}${isProof ? ' <span class="proof-badge">Proof</span>' : ''}</td>
        <td>${fmt(d.units)}</td>
        <td>${fmt(d.oz, 2)}</td>
        <td>${formatCurrency(d.spot_price_zar)}</td>
        <td>${fmt(d.margin_pct, 2)}%</td>
        <td>${formatCurrency(d.deal_value_zar)}</td>
        <td>${fmt(d.provision_pct, 1)}%</td>
        <td class="${(d.profit_margin_pct || 0) >= 0 ? 'sell' : 'buy'}">${fmt(d.profit_margin_pct, 2)}%</td>
        <td>${formatCurrency(d.gp_contribution_zar)}</td>
        <td>${fmt(d.inventory_after_oz, 2)}</td>
        <td>${d.provision_flipped ? 'YES' : '–'}</td>
      `;
      tbody.appendChild(tr);
    });
  });
}

function formatDate(iso) {
  if (!iso || iso === 'Unknown') return 'Unknown Date';
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-ZA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return iso; }
}

// ─── AGED INVENTORY ───────────────────────────────────────────────────────────

function renderAgedInventory(parcels) {
  const tbody = document.getElementById('aged-tbody');
  tbody.innerHTML = '';

  if (!parcels.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--muted)">No inventory parcels</td></tr>';
    return;
  }

  parcels.forEach(p => {
    const dom     = p.dormancy || {};
    const flagged = dom.flagged;
    const tr      = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.acquired_date}</td>
      <td>${fmt(p.oz, 2)} oz</td>
      <td>${formatCurrency(p.cost_price_zar)}</td>
      <td class="${flagged ? 'flagged' : 'active'}">${dom.days_held ?? '–'} days</td>
      <td class="${flagged ? 'flagged' : 'active'}">${dom.status ?? '–'}</td>
      <td>${p.exit_suggestion || '–'}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── SPOT PRICES ──────────────────────────────────────────────────────────────

async function loadSpot() {
  const spots  = await api('/api/spot').catch(() => ({}));
  const gold   = spots['gold']   || 0;
  const silver = spots['silver'] || 0;
  if (spots['usd_rate']) zarPerUsd = spots['usd_rate'];
  liveSpots.gold   = gold;
  liveSpots.silver = silver;

  const isSabi = currentEntity === 'SABI';
  document.getElementById('spot-gold').textContent   = isSabi
    ? `Au ${formatUSD(gold)}`   : `Au ${formatZAR(gold)}`;
  document.getElementById('spot-silver').textContent = isSabi
    ? `Ag ${formatUSD(silver)}` : `Ag ${formatZAR(silver)}`;

  set('exp-spot', formatCurrency(currentMetal === 'gold' ? gold : silver));

  const spotEl = document.getElementById('p-spot');
  if (spotEl && !spotEl.dataset.manuallySet) {
    spotEl.value = currentMetal === 'gold' ? gold : silver;
  }
}

async function refreshSpot() {
  showToast('Refreshing spot prices…');
  await api('/api/spot/refresh', { method: 'POST' }).catch(() => {});
  await loadSpot();
  showToast('Spot prices updated');
}

// ─── DEAL IMPACT PREVIEW ──────────────────────────────────────────────────────

async function runPreview() {
  const body = {
    entity:         currentEntity,
    metal:          currentMetal,
    deal_type:      document.getElementById('p-type').value,
    units:          parseFloat(document.getElementById('p-units').value)    || 1,
    equiv_oz:       parseFloat(document.getElementById('p-equiv-oz').value) || 1,
    spot_price_zar: parseFloat(document.getElementById('p-spot').value)     || null,
    margin_pct:     parseFloat(document.getElementById('p-margin').value)   || 0,
  };
  try {
    const r = await api('/api/preview', { method: 'POST', json: body });
    renderPreview(r);
  } catch (e) {
    showToast('Preview failed: ' + e.message, true);
  }
}

function renderPreview(r) {
  const el   = document.getElementById('preview-result');
  const mvp  = r.margin_vs_provision || {};
  const flip = r.provision_flips;
  const cashSign = r.cash_delta_zar >= 0 ? '+' : '';
  const expSign  = r.exposure_delta_zar >= 0 ? '+' : '';

  el.className = 'preview-result' + (flip ? ' flip-alert' : '');
  el.innerHTML = `
    <div class="preview-row"><span class="preview-key">Deal Value</span>
      <span class="preview-val">${formatCurrency(r.deal_value_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Effective Price</span>
      <span class="preview-val">${formatCurrency(r.effective_price)} / oz</span></div>
    <div class="preview-row"><span class="preview-key">Margin vs Provision</span>
      <span class="preview-val ${mvp.profitable ? 'profit' : 'loss'}">${mvp.profitable ? '+' : ''}${fmt(mvp.profit_pct, 2)}%</span></div>
    <div class="preview-row"><span class="preview-key">GP Contribution</span>
      <span class="preview-val ${mvp.profitable ? 'profit' : 'loss'}">${formatCurrency(r.gp_contribution_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Cash Flow</span>
      <span class="preview-val">${cashSign}${formatCurrency(r.cash_delta_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Exposure Delta</span>
      <span class="preview-val">${expSign}${formatCurrency(r.exposure_delta_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">New VWAP</span>
      <span class="preview-val">${r.new_vwap > 0 ? formatCurrency(r.new_vwap) : '–'}</span></div>
    <div class="preview-row"><span class="preview-key">Inventory After</span>
      <span class="preview-val">${fmt(r.new_inventory_oz, 2)} oz</span></div>
    <div class="preview-row"><span class="preview-key">Provision Mode</span>
      <span class="preview-val ${flip ? 'alert' : ''}">${(r.provision_before||{}).mode} → ${(r.provision_after||{}).mode}</span></div>
    ${flip ? '<div class="flip-warning">&#9888; This deal changes provision mode!</div>' : ''}
  `;
}

// ─── OPENING POSITION ─────────────────────────────────────────────────────────

async function setOpeningPosition() {
  const input = document.getElementById('opening-pos-input');
  const oz    = parseFloat(input?.value);
  if (isNaN(oz)) { showToast('Enter a valid oz value (negative = short)', true); return; }

  try {
    const r = await api('/api/inventory/set', {
      method: 'POST',
      json: { entity: currentEntity, metal: currentMetal, oz },
    });
    const prov = r.provision || {};
    showToast(`Opening position set: ${oz >= 0 ? '+' : ''}${oz.toFixed(2)} oz — ${prov.mode}`);
    if (input) input.value = '';
    loadAll();
  } catch (e) {
    showToast('Failed to set position: ' + e.message, true);
  }
}

// ─── RESET DATA ───────────────────────────────────────────────────────────────

async function resetData() {
  const confirmed = window.confirm(
    `Clear ALL deals and inventory for ${currentEntity} (gold + silver)?\n\nThis cannot be undone. Re-upload the dealer sheet after resetting.`
  );
  if (!confirmed) return;
  try {
    // Reset both metals so a single re-upload repopulates everything cleanly
    await Promise.all([
      api('/api/reset', { method: 'POST', json: { entity: currentEntity, metal: 'gold' } }),
      api('/api/reset', { method: 'POST', json: { entity: currentEntity, metal: 'silver' } }),
    ]);
    showToast(`Reset complete: ${currentEntity} gold + silver — re-upload your sheet`);
    loadAll();
  } catch (e) {
    showToast('Reset failed: ' + e.message, true);
  }
}

// ─── MARGIN CALCULATORS ───────────────────────────────────────────────────────
// Two modes:
//   simple      — Fixed price / KR  : no VAT. price = spot × (1 + margin/100)
//   vat         — Minted bar/silver : 15% VAT. price_vat_incl = spot×oz×(1+margin/100)×1.15
//
// Backwards:
//   → margin    : given price [+spot], calculate margin
//   → spot      : given price + margin, calculate implied spot

const VAT_RATE = 0.15;
let goldCalcMode   = 'simple';
let silverCalcMode = 'coin';

function _fmtR(v) {
  if (!isFinite(v)) return '—';
  return 'R ' + v.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function _fmtPct(v) {
  if (!isFinite(v)) return '—';
  return v.toFixed(4) + '%';
}

// ── Gold forward calc ──────────────────────────────────────────────────────
function runGoldCalc() {
  const spot   = parseFloat(document.getElementById('gc-spot')?.value);
  const margin = parseFloat(document.getElementById('gc-margin')?.value);
  const oz     = parseFloat(document.getElementById('gc-oz')?.value) || 1;
  const el     = document.getElementById('gc-result');
  if (!el) return;
  if (!spot || isNaN(margin)) { el.textContent = '—'; return; }

  let price, label;
  if (goldCalcMode === 'vat') {
    const priceExVAT = spot * oz * (1 + margin / 100);
    price = priceExVAT * (1 + VAT_RATE);
    label = `${_fmtR(price)} VAT incl  (ex-VAT ${_fmtR(priceExVAT)},  ${_fmtR(priceExVAT/oz)} /oz)`;
  } else {
    price = spot * oz * (1 + margin / 100);
    label = `${_fmtR(price)} / unit  (${_fmtR(price/oz)} per oz)`;
  }
  el.textContent = label;
}

// ── Gold backward calc ─────────────────────────────────────────────────────
function runGoldCalcBack() {
  const priceIn  = parseFloat(document.getElementById('gc-price-in')?.value);
  const margin   = parseFloat(document.getElementById('gc-margin')?.value);
  const spot     = parseFloat(document.getElementById('gc-spot')?.value);
  const oz       = parseFloat(document.getElementById('gc-oz')?.value) || 1;
  const backMode = document.getElementById('gc-back-mode')?.value;
  const el       = document.getElementById('gc-result-back');
  if (!el || !priceIn) { el && (el.textContent = '—'); return; }

  let result;
  if (goldCalcMode === 'vat') {
    const exVAT  = priceIn / (1 + VAT_RATE);
    const perOz  = exVAT / oz;
    if (backMode === 'margin' && spot) {
      result = `Margin: ${_fmtPct((perOz / spot - 1) * 100)}  (ex-VAT/oz ${_fmtR(perOz)})`;
    } else if (backMode === 'spot' && !isNaN(margin)) {
      const impliedSpot = perOz / (1 + margin / 100);
      result = `Implied spot: ${_fmtR(impliedSpot)}`;
    }
  } else {
    const perOz = priceIn / oz;
    if (backMode === 'margin' && spot) {
      result = `Margin: ${_fmtPct((perOz / spot - 1) * 100)}`;
    } else if (backMode === 'spot' && !isNaN(margin)) {
      result = `Implied spot: ${_fmtR(perOz / (1 + margin / 100))}`;
    }
  }
  el.textContent = result || '—';
}

// ── Silver forward calc ────────────────────────────────────────────────────
function runSilverCalc() {
  const spot   = parseFloat(document.getElementById('sc-spot')?.value);
  const margin = parseFloat(document.getElementById('sc-margin')?.value);
  const ozRaw  = parseFloat(document.getElementById('sc-oz')?.value);
  const oz     = silverCalcMode === 'kilo' ? 32.151 : (ozRaw || 1);
  const el     = document.getElementById('sc-result');
  if (!el) return;
  if (!spot || isNaN(margin)) { el.textContent = '—'; return; }

  const priceExVAT = spot * oz * (1 + margin / 100);
  const priceVAT   = priceExVAT * (1 + VAT_RATE);
  el.textContent = `${_fmtR(priceVAT)} VAT incl  (ex-VAT ${_fmtR(priceExVAT)},  ${_fmtR(priceExVAT/oz)} /oz)`;
}

// ── Silver backward calc ───────────────────────────────────────────────────
function runSilverCalcBack() {
  const priceIn  = parseFloat(document.getElementById('sc-price-in')?.value);
  const margin   = parseFloat(document.getElementById('sc-margin')?.value);
  const spot     = parseFloat(document.getElementById('sc-spot')?.value);
  const ozRaw    = parseFloat(document.getElementById('sc-oz')?.value);
  const oz       = silverCalcMode === 'kilo' ? 32.151 : (ozRaw || 1);
  const backMode = document.getElementById('sc-back-mode')?.value;
  const el       = document.getElementById('sc-result-back');
  if (!el || !priceIn) { el && (el.textContent = '—'); return; }

  const exVAT = priceIn / (1 + VAT_RATE);
  const perOz = exVAT / oz;
  let result;
  if (backMode === 'margin' && spot) {
    result = `Margin: ${_fmtPct((perOz / spot - 1) * 100)}  (ex-VAT/oz ${_fmtR(perOz)})`;
  } else if (backMode === 'spot' && !isNaN(margin)) {
    result = `Implied spot: ${_fmtR(perOz / (1 + margin / 100))}`;
  }
  el.textContent = result || '—';
}

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────

async function uploadFile(input) {
  const file = input.files[0];
  if (!file) return;

  showToast(`Uploading ${file.name}…`);
  const form = new FormData();
  form.append('file', file);

  try {
    const resp   = await fetch('/api/upload', { method: 'POST', body: form });
    const result = await resp.json();
    if (result.status === 'error') {
      showToast(`Import failed: ${result.errors?.join(', ') || result.error}`, true);
    } else {
      const breakdown = result.metal_breakdown || {};
      const parts = Object.entries(breakdown)
        .map(([m, n]) => `${n} ${m}`)
        .join(', ');
      const msg = parts
        ? `Imported ${result.deals_imported} deals (${parts}) — switch the metal tab to view each`
        : `Imported ${result.deals_imported} deals`;
      showToast(msg);
      loadAll();
    }
  } catch (e) {
    showToast('Upload error: ' + e.message, true);
  }
  input.value = '';
}

// ─── CHARTS ───────────────────────────────────────────────────────────────────

function calcSiloStats(deals) {
  const out = {};
  deals.forEach(d => {
    const s = d.silo || 'unknown';
    if (!out[s]) out[s] = { gp: 0 };
    out[s].gp += d.gp_contribution_zar || 0;
  });
  const total = Object.values(out).reduce((s, v) => s + v.gp, 0);
  Object.keys(out).forEach(k => {
    out[k].gp_proportion_pct = total > 0 ? (out[k].gp / total) * 100 : 0;
  });
  return out;
}

function calcChannelStats(deals) {
  const out = {};
  deals.forEach(d => {
    const c = d.channel || 'unknown';
    if (!out[c]) out[c] = { gp: 0 };
    out[c].gp += d.gp_contribution_zar || 0;
  });
  const total = Object.values(out).reduce((s, v) => s + v.gp, 0);
  Object.keys(out).forEach(k => {
    out[k].gp_proportion_pct = total > 0 ? (out[k].gp / total) * 100 : 0;
  });
  return out;
}

const BRAND_COLORS = ['#D4A755','#7B4FC9','#40B5AD','#A07ED6','#F5C469','#E05252'];

// ─── SHARED CHART HELPERS ─────────────────────────────────────────────────────

function groupByDate(deals) {
  const map = {};
  deals.forEach(d => {
    const dt = d.deal_date || 'unknown';
    if (!map[dt]) map[dt] = { buys: [], sells: [] };
    if (d.deal_type === 'buy')  map[dt].buys.push(d);
    if (d.deal_type === 'sell') map[dt].sells.push(d);
  });
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
}

function zarK(v) {
  // Compact ZAR for chart axes: 1 234 567 → "R 1.2M" or "R 234K"
  if (Math.abs(v) >= 1_000_000) return 'R ' + (v / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(v) >= 1_000)     return 'R ' + (v / 1_000).toFixed(0) + 'K';
  return 'R ' + v.toFixed(0);
}

const CHART_DEFAULTS = {
  animation: { duration: 400 },
  responsive: true,
  maintainAspectRatio: false,
};

const LEGEND_STYLE = {
  color: 'rgba(240,238,248,0.6)',
  font: { family: '-apple-system, Helvetica Neue, Arial', size: 11 },
  boxWidth: 10,
  padding: 12,
  usePointStyle: true,
};

function axisX() {
  return {
    ticks:  { color: 'rgba(240,238,248,0.35)', font: { size: 10 }, maxRotation: 40 },
    grid:   { color: 'rgba(107,57,175,0.08)', drawBorder: false },
  };
}

function axisY(label) {
  return {
    ticks: {
      color: 'rgba(240,238,248,0.35)',
      font:  { size: 10 },
      callback: label === 'ZAR' || label === 'ZAR/oz' ? v => zarK(v) : undefined,
    },
    grid:   { color: 'rgba(107,57,175,0.08)', drawBorder: false },
    border: { dash: [3, 3] },
    title:  label ? { display: true, text: label, color: 'rgba(240,238,248,0.3)', font: { size: 9 } } : undefined,
  };
}

function tooltipStyle() {
  return {
    backgroundColor: 'rgba(21,14,38,0.95)',
    borderColor:     'rgba(107,57,175,0.4)',
    borderWidth:     1,
    titleColor:      'rgba(240,238,248,0.9)',
    bodyColor:       'rgba(240,238,248,0.65)',
    padding:         10,
    cornerRadius:    8,
  };
}

function makeGradient(ctx, color1, color2) {
  try {
    const g = ctx.createLinearGradient(0, 0, 0, 200);
    g.addColorStop(0,   color1);
    g.addColorStop(1,   color2);
    return g;
  } catch { return color1; }
}

function emptyChartNote(canvas) {
  // Show "No data" overlay when chart has nothing to show
  const wrap = canvas?.parentElement;
  if (!wrap) return;
  let note = wrap.querySelector('.chart-empty');
  if (!note) {
    note = document.createElement('div');
    note.className = 'chart-empty';
    wrap.style.position = 'relative';
    wrap.appendChild(note);
  }
  note.textContent = 'No data for selected period';
  note.style.display = '';
}

function clearEmptyNote(canvas) {
  const note = canvas?.parentElement?.querySelector('.chart-empty');
  if (note) note.style.display = 'none';
}

// ─── VOLUME BY DAY ────────────────────────────────────────────────────────────
function renderVolumeChart(deals) {
  const canvas = document.getElementById('volume-chart');
  const ctx    = canvas?.getContext('2d');
  if (!ctx) return;
  const groups = groupByDate(deals);

  if (!groups.length) { emptyChartNote(canvas); if (volumeChart) { volumeChart.destroy(); volumeChart = null; } return; }
  clearEmptyNote(canvas);

  const labels = groups.map(([dt]) => formatDateShort(dt));
  const buyOz  = groups.map(([, g]) => +g.buys.reduce((s, d)  => s + (d.oz || 0), 0).toFixed(2));
  const sellOz = groups.map(([, g]) => +g.sells.reduce((s, d) => s + (d.oz || 0), 0).toFixed(2));

  if (volumeChart) volumeChart.destroy();
  volumeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Buybacks', data: buyOz,
          backgroundColor: makeGradient(ctx, 'rgba(64,181,173,0.85)', 'rgba(64,181,173,0.35)'),
          borderColor: '#40B5AD', borderWidth: 1, borderRadius: 5, borderSkipped: false },
        { label: 'Sales',    data: sellOz,
          backgroundColor: makeGradient(ctx, 'rgba(212,167,85,0.85)', 'rgba(212,167,85,0.35)'),
          borderColor: '#D4A755', borderWidth: 1, borderRadius: 5, borderSkipped: false },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: { labels: LEGEND_STYLE },
        tooltip: { ...tooltipStyle(), callbacks: {
          label: c => ` ${c.dataset.label}: ${c.parsed.y.toFixed(2)} oz`,
        }},
      },
      scales: { x: axisX(), y: { ...axisY('oz'), beginAtZero: true } },
    },
  });
}

// ─── VWAP TREND ───────────────────────────────────────────────────────────────
function renderVwapChart(deals) {
  const canvas = document.getElementById('vwap-chart');
  const ctx    = canvas?.getContext('2d');
  if (!ctx) return;
  const groups = groupByDate(deals);

  if (!groups.length) { emptyChartNote(canvas); if (vwapChart) { vwapChart.destroy(); vwapChart = null; } return; }
  clearEmptyNote(canvas);

  const labels = groups.map(([dt]) => formatDateShort(dt));

  function dayVwap(subset) {
    const oz  = subset.reduce((s, d) => s + (d.oz || 0), 0);
    const val = subset.reduce((s, d) => s + (d.deal_value_zar || 0), 0);
    return oz > 0 ? val / oz : null;
  }

  const buyVwap  = groups.map(([, g]) => dayVwap(g.buys));
  const sellVwap = groups.map(([, g]) => dayVwap(g.sells));

  if (vwapChart) vwapChart.destroy();
  vwapChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Buy VWAP',  data: buyVwap,
          borderColor: '#40B5AD', backgroundColor: 'rgba(64,181,173,0.08)',
          pointBackgroundColor: '#40B5AD', pointRadius: 4, pointHoverRadius: 6,
          borderWidth: 2, tension: 0.35, fill: true, spanGaps: true },
        { label: 'Sell VWAP', data: sellVwap,
          borderColor: '#D4A755', backgroundColor: 'rgba(212,167,85,0.08)',
          pointBackgroundColor: '#D4A755', pointRadius: 4, pointHoverRadius: 6,
          borderWidth: 2, tension: 0.35, fill: true, spanGaps: true },
      ],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: { labels: LEGEND_STYLE },
        tooltip: { ...tooltipStyle(), callbacks: {
          label: c => ` ${c.dataset.label}: R ${(c.parsed.y || 0).toLocaleString('en-ZA', { maximumFractionDigits: 0 })}/oz`,
        }},
      },
      scales: { x: axisX(), y: axisY('ZAR/oz') },
    },
  });
}

// ─── DAILY GP ─────────────────────────────────────────────────────────────────
function renderGpChart(deals) {
  const canvas = document.getElementById('gp-chart');
  const ctx    = canvas?.getContext('2d');
  if (!ctx) return;
  const groups = groupByDate(deals);

  if (!groups.length) { emptyChartNote(canvas); if (gpChart) { gpChart.destroy(); gpChart = null; } return; }
  clearEmptyNote(canvas);

  const labels = groups.map(([dt]) => formatDateShort(dt));
  const gpData = groups.map(([, g]) =>
    [...g.buys, ...g.sells].reduce((s, d) => s + (d.gp_contribution_zar || 0), 0)
  );
  const colors = gpData.map(v =>
    v >= 0 ? 'rgba(123,79,201,0.8)' : 'rgba(224,82,82,0.75)'
  );
  const borders = gpData.map(v => v >= 0 ? '#7B4FC9' : '#E05252');

  if (gpChart) gpChart.destroy();
  gpChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Daily GP',
        data: gpData,
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1,
        borderRadius: 5,
        borderSkipped: false,
      }],
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipStyle(), callbacks: {
          label: c => ` GP: R ${(c.parsed.y || 0).toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`,
        }},
      },
      scales: { x: axisX(), y: axisY('ZAR') },
    },
  });
}

// ─── SILO + CHANNEL DOUGHNUTS ─────────────────────────────────────────────────

function doughnutOptions(title) {
  return {
    ...CHART_DEFAULTS,
    cutout: '70%',
    plugins: {
      legend: {
        position: 'bottom',
        labels: { ...LEGEND_STYLE, padding: 10 },
      },
      tooltip: { ...tooltipStyle(), callbacks: {
        label: c => ` ${c.label}: ${c.parsed.toFixed(1)}%`,
      }},
      title: title ? {
        display: true,
        text:  title,
        color: 'rgba(240,238,248,0.45)',
        font:  { size: 10 },
        padding: { bottom: 4 },
      } : undefined,
    },
  };
}

function renderSiloChart(data) {
  const canvas = document.getElementById('silo-chart');
  const ctx    = canvas?.getContext('2d');
  if (!ctx) return;
  const labels = Object.keys(data);
  const values = labels.map(k => data[k].gp_proportion_pct || 0);

  if (!labels.length || values.every(v => v === 0)) {
    emptyChartNote(canvas); if (siloChart) { siloChart.destroy(); siloChart = null; } return;
  }
  clearEmptyNote(canvas);

  if (siloChart) siloChart.destroy();
  siloChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: BRAND_COLORS, borderWidth: 2, borderColor: '#150E26', hoverOffset: 8 }] },
    options: doughnutOptions(),
  });
}

function renderChannelChart(data) {
  const canvas = document.getElementById('channel-chart');
  const ctx    = canvas?.getContext('2d');
  if (!ctx) return;
  const labels = Object.keys(data);
  const values = labels.map(k => data[k].gp_proportion_pct || 0);

  if (!labels.length || values.every(v => v === 0)) {
    emptyChartNote(canvas); if (channelChart) { channelChart.destroy(); channelChart = null; } return;
  }
  clearEmptyNote(canvas);

  if (channelChart) channelChart.destroy();
  channelChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: BRAND_COLORS.slice(1), borderWidth: 2, borderColor: '#150E26', hoverOffset: 8 }] },
    options: doughnutOptions(),
  });
}

function formatDateShort(iso) {
  if (!iso || iso === 'unknown') return '?';
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }); }
  catch { return iso.slice(5); }
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const options = { method: opts.method || 'GET', headers: {} };
  if (opts.json) {
    options.body    = JSON.stringify(opts.json);
    options.headers['Content-Type'] = 'application/json';
  }
  const resp = await fetch(path, options);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  return resp.json();
}

function set(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function fmt(val, decimals = 2) {
  if (val == null || val === '') return '–';
  return Number(val).toLocaleString('en-ZA', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatZAR(val) {
  if (val == null || val === '' || isNaN(val)) return '–';
  return 'R\u00A0' + Number(val).toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUSD(zarVal) {
  if (zarVal == null || zarVal === '' || isNaN(zarVal)) return '–';
  const usd = zarPerUsd > 0 ? Number(zarVal) / zarPerUsd : 0;
  return '$\u00A0' + usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatCurrency(zarVal) {
  return currentEntity === 'SABI' ? formatUSD(zarVal) : formatZAR(zarVal);
}

function showToast(msg, isError = false) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = 'toast' + (isError ? ' error' : '');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}
