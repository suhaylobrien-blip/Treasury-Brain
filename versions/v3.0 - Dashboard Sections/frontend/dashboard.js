/**
 * Treasury Brain — Dashboard JS
 * SA Bullion × Apple aesthetic
 */

'use strict';

let currentEntity    = 'SABIS';
let currentMetal     = 'gold';
let currentSection   = 'summary';
let currentCategory  = 'all';   // all | bullion | proof
let siloChart, channelChart, volumeChart, vwapChart, gpChart;
let zarPerUsd  = 0;   // ZAR per 1 USD — populated from /api/spot
let liveSpots  = { gold: 0, silver: 0 };  // live spot per metal for MTM calc
const POLL_INTERVAL = 30_000;

// Cached snapshot data for inventory re-filtering
let _invSnap = { goldBull: null, goldProof: null, silBull: null, silProof: null };

// Cached deal/inv/hedging state — refreshed on every loadAll, used by spot refresh
let _vwapCache = { deals: [], otherDeals: [], inv: {}, hedging: {}, otherInv: {}, otherHedging: {} };

// Net GP tracking — updated by renderExposure + renderBannerAlpha
let _lastDealingGP      = 0;
let _lastTreasuryAlpha  = 0;

// Date filter state
let filterMode  = 'all';   // all | today | week | month | year | custom
let filterFrom  = '';
let filterTo    = '';

// ─── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('metal-filter-gold');   // default tab = gold
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

function switchSection(section, btn) {
  currentSection = section;
  document.querySelectorAll('.section-tabs-top .stab, .section-tabs .stab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.section-pane').forEach(p => p.classList.add('hidden'));
  const pane = document.getElementById('pane-' + section);
  if (pane) pane.classList.remove('hidden');
  updateBannerLayout();
}

function switchMetal(metal, btn) {
  currentMetal = metal;
  document.querySelectorAll('.metal-tabs .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  // Drive CSS visibility via body class
  document.body.classList.remove('metal-filter-gold', 'metal-filter-silver', 'metal-filter-combined');
  document.body.classList.add(`metal-filter-${metal}`);
  loadAll();
}

// ─── CATEGORY FILTER (Bullion / Proof) ───────────────────────────────────────

const isNumism = d => ((d.silo || '') + (d.product_name || '') + (d.channel || '')).toLowerCase()
  .match(/numism|proof|coin/);

function filterByCategory(deals, cat) {
  if (cat === 'bullion') return deals.filter(d => !isNumism(d));
  if (cat === 'proof')   return deals.filter(d =>  isNumism(d));
  return deals;
}

function switchCategory(cat, btn) {
  currentCategory = cat;
  document.querySelectorAll('.cat-tab').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
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
  const fq = filterFrom
    ? `&from=${filterFrom}` + (filterTo ? `&to=${filterTo}` : '')
    : '';

  // ── COMBINED MODE: fetch gold + silver in parallel ────────────────────────
  if (currentMetal === 'combined') {
    const base = `entity=${currentEntity}`;
    const noPos = { positions: [], long_oz: 0, short_oz: 0, net_oz: 0, long_vwap: 0, short_vwap: 0 };
    const [gDeals, sDeals, gInv, sInv, gHedge, sHedge, gExp, sExp, gPipe, sPipe] = await Promise.all([
      api(`/api/deals?${base}&metal=gold&limit=1000${fq}`).catch(() => []),
      api(`/api/deals?${base}&metal=silver&limit=1000${fq}`).catch(() => []),
      api(`/api/inventory?${base}&metal=gold`).catch(() => ({})),
      api(`/api/inventory?${base}&metal=silver`).catch(() => ({})),
      api(`/api/hedging?${base}&metal=gold`).catch(() => ({ ...noPos })),
      api(`/api/hedging?${base}&metal=silver`).catch(() => ({ ...noPos })),
      api(`/api/exposure?${base}&metal=gold${fq}`).catch(() => ({})),
      api(`/api/exposure?${base}&metal=silver${fq}`).catch(() => ({})),
      api(`/api/pipeline?${base}&metal=gold${fq}`).catch(() => []),
      api(`/api/pipeline?${base}&metal=silver${fq}`).catch(() => []),
    ]);

    // Merge deals newest-first
    const allDeals = [...gDeals, ...sDeals].sort((a, b) =>
      (b.deal_date || '').localeCompare(a.deal_date || '') || (b.id || 0) - (a.id || 0)
    );

    // Merged hedging — keeps per-metal VWAPs for split display
    const mHedge = {
      positions:         [...(gHedge.positions || []), ...(sHedge.positions || [])],
      long_oz:           (gHedge.long_oz  || 0) + (sHedge.long_oz  || 0),
      short_oz:          (gHedge.short_oz || 0) + (sHedge.short_oz || 0),
      net_oz:            (gHedge.net_oz   || 0) + (sHedge.net_oz   || 0),
      long_vwap:         0,
      short_vwap:        0,
      gold_long_vwap:    gHedge.long_vwap   || 0,
      gold_short_vwap:   gHedge.short_vwap  || 0,
      silver_long_vwap:  sHedge.long_vwap   || 0,
      silver_short_vwap: sHedge.short_vwap  || 0,
    };

    const allPositions = [...mHedge.positions].sort((a, b) => {
      if (a.metal !== b.metal) return a.metal === 'gold' ? -1 : 1;
      if (a.position_type !== b.position_type) return a.position_type === 'long' ? -1 : 1;
      return (b.open_date || '').localeCompare(a.open_date || '');
    });

    const goldGP_    = gDeals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
    const silverGP_  = sDeals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
    const combGP_    = goldGP_ + silverGP_;
    const goldAlpha_   = gExp.treasury_alpha || 0;
    const silverAlpha_ = sExp.treasury_alpha || 0;
    const combAlpha_   = goldAlpha_ + silverAlpha_;

    // Update exposure banner directly for combined mode
    const goldSpot   = gInv.spot_zar || 0;
    const goldEcoOz  = (gInv.total_oz || 0) + (gHedge.net_oz || 0);
    const silverEcoOz = (sInv.total_oz || 0) + (sHedge.net_oz || 0);
    const provActive = (gInv.total_oz || 0) < 0;
    const provRate   = (gInv.provision || {}).rate_pct || 0;
    set('exp-value-zar', formatZAR(Math.abs(goldEcoOz) * goldSpot));
    setSubLines('exp-oz',
      [`Au ${fmt(goldEcoOz, 2)} oz`, 'gold net exposure'],
      [`Ag ${fmt(silverEcoOz, 2)} oz`, 'silver net exposure'],
    );
    set('exp-gp',   formatCurrency(combGP_));
    setSubLines('exp-gp-sub',
      [`${allDeals.length}`, `deal${allDeals.length !== 1 ? 's' : ''} in period (Au+Ag)`],
    );
    set('exp-provision', provActive ? 'PROVISION' : 'NO PROVISION');
    if (provActive) {
      setSubLines('exp-prov-sub', [`${provRate}%`, 'provision rate applies (Au)']);
    } else {
      setSubLines('exp-prov-sub',
        [`Au ${fmt(gInv.total_oz || 0, 2)} oz`, 'gold physical'],
        [`Ag ${fmt(sInv.total_oz || 0, 2)} oz`, 'silver physical'],
      );
    }
    const provCard = document.getElementById('exp-card-provision');
    if (provCard) {
      provCard.classList.toggle('active',   provActive);
      provCard.classList.toggle('inactive', !provActive);
    }

    set('exp-combined-gp',     formatCurrency(combGP_));
    setSubLines('exp-combined-gp-sub',
      [formatCurrency(goldGP_), 'gold GP'],
      [formatCurrency(silverGP_), 'silver GP'],
    );
    const fgDeals = filterByCategory(gDeals, currentCategory);
    const fsDeals = filterByCategory(sDeals, currentCategory);
    const fallDeals = filterByCategory(allDeals, currentCategory);
    renderCombinedPNL(combGP_, combAlpha_, goldGP_, silverGP_, goldAlpha_, silverAlpha_);
    renderTrading(fallDeals);
    renderHedging(mHedge, gInv);
    renderLongsShorts(mHedge, gInv);
    renderCombinedExposure(gExp);
    renderBannerAlpha(gExp, sExp);
    renderPositionsTable(allPositions, gInv.total_oz || 0, sInv.total_oz || 0);
    renderPipelineTable([...gPipe, ...sPipe], gInv, mHedge);
    renderDealsTable(fallDeals);
    renderAgedInventory([...(gInv.aged_parcels || []), ...(sInv.aged_parcels || [])]);
    // ── v3.0 section renders ──────────────────────────────────────────
    if (typeof renderDailySummary    === 'function') renderDailySummary(fgDeals, fsDeals, gExp, sExp, gInv, sInv);
    if (typeof renderHighlights      === 'function') renderHighlights(fgDeals, fsDeals, gExp, sExp, gInv, sInv, null, null);
    if (typeof renderSummaryCharts   === 'function') renderSummaryCharts(fgDeals, fsDeals, gExp, sExp);
    if (typeof renderTargetTracker   === 'function') renderTargetTracker(fgDeals, fsDeals, gExp, sExp, null);
    if (typeof renderTreasuryExposure=== 'function') renderTreasuryExposure(gInv, sInv, gHedge, sHedge, gExp, sExp);
    if (typeof renderDealingGP       === 'function') renderDealingGP(fgDeals, fsDeals, gInv, sInv);
    if (typeof renderBankRecon       === 'function') renderBankRecon(fgDeals, fsDeals);
    // ── Inventory snapshot ─────────────────────────────────────────────────
    const snapBase = `entity=${currentEntity}`;
    const [gsBull, gsProof, ssBull, ssProof] = await Promise.all([
      api(`/api/inv/snapshot?${snapBase}&metal=gold&category=bullion`).catch(() => null),
      api(`/api/inv/snapshot?${snapBase}&metal=gold&category=proof`).catch(() => null),
      api(`/api/inv/snapshot?${snapBase}&metal=silver&category=bullion`).catch(() => null),
      api(`/api/inv/snapshot?${snapBase}&metal=silver&category=proof`).catch(() => null),
    ]);
    _invSnap = { goldBull: gsBull, goldProof: gsProof, silBull: ssBull, silProof: ssProof };
    if (typeof renderInventorySnapshot === 'function') renderInventorySnapshot(gsBull, gsProof, ssBull, ssProof);
    // Store combined inv refs for VWAP banner spot refresh
    gInv_ = gInv; sInv_ = sInv; gHedge_ = gHedge; sHedge_ = sHedge;
    _vwapCache = { deals: fgDeals, otherDeals: fsDeals, inv: gInv, hedging: gHedge, otherInv: sInv, otherHedging: sHedge };
    renderVwapBanner(fgDeals, fsDeals, gInv, gHedge, sInv, sHedge);
    updateBannerLayout();
    await loadSpot();
    return;
  }

  // ── SINGLE METAL MODE (gold / silver) ─────────────────────────────────────
  const otherMetal      = currentMetal === 'gold' ? 'silver' : 'gold';
  const otherDealsUrl   = `/api/deals?entity=${currentEntity}&metal=${otherMetal}&limit=1000${fq}`;
  const otherHedgingUrl = `/api/hedging?entity=${currentEntity}&metal=${otherMetal}`;
  const otherInvUrl     = `/api/inventory?entity=${currentEntity}&metal=${otherMetal}`;

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

  const fDeals       = filterByCategory(deals, currentCategory);
  const fOtherDeals  = filterByCategory(otherDeals, currentCategory);
  // Exposure banner + ecosystem always use full (unfiltered) deals
  renderExposure(deals, inv, hedging);
  renderCombinedGP(deals, otherDeals);
  renderCombinedPNL(combinedGP_, combinedAlpha_, goldGP_, silverGP_, goldAlpha_, silverAlpha_);
  renderTrading(fDeals);
  renderHedging(hedging, inv);
  renderLongsShorts(hedging, inv);
  renderCombinedExposure(exposure);
  renderBannerAlpha(exposure, otherExposure);
  renderPositionsTable(allPositions, goldPhysical, silverPhysical);
  renderPipelineTable(pipeline, inv, hedging);
  renderDealsTable(fDeals);
  renderAgedInventory(inv.aged_parcels || []);

  // ── v3.0 section renders ──────────────────────────────────────────
  const goldDeals__   = filterByCategory(currentMetal === 'gold'   ? deals : otherDeals, currentCategory);
  const silverDeals__ = filterByCategory(currentMetal === 'silver' ? deals : otherDeals, currentCategory);
  const goldInv__     = currentMetal === 'gold'   ? inv   : otherInv;
  const silverInv__   = currentMetal === 'silver' ? inv   : otherInv;
  const goldHedge__   = currentMetal === 'gold'   ? hedging      : otherHedging;
  const silverHedge__ = currentMetal === 'silver' ? hedging      : otherHedging;
  const goldExp__     = currentMetal === 'gold'   ? exposure     : otherExposure;
  const silverExp__   = currentMetal === 'silver' ? exposure     : otherExposure;
  if (typeof renderDailySummary    === 'function') renderDailySummary(goldDeals__, silverDeals__, goldExp__, silverExp__, goldInv__, silverInv__);
  if (typeof renderHighlights      === 'function') renderHighlights(goldDeals__, silverDeals__, goldExp__, silverExp__, goldInv__, silverInv__, null, null);
  if (typeof renderSummaryCharts   === 'function') renderSummaryCharts(goldDeals__, silverDeals__, goldExp__, silverExp__);
  if (typeof renderTargetTracker   === 'function') renderTargetTracker(goldDeals__, silverDeals__, goldExp__, silverExp__, null);
  if (typeof renderTreasuryExposure=== 'function') renderTreasuryExposure(goldInv__, silverInv__, goldHedge__, silverHedge__, goldExp__, silverExp__);
  if (typeof renderDealingGP       === 'function') renderDealingGP(fDeals, fOtherDeals, inv, otherInv);
  if (typeof renderBankRecon       === 'function') renderBankRecon(goldDeals__, silverDeals__);

  // ── Inventory snapshot ───────────────────────────────────────────────────
  const snapBase_ = `entity=${currentEntity}`;
  const [gsBull_, gsProof_, ssBull_, ssProof_] = await Promise.all([
    api(`/api/inv/snapshot?${snapBase_}&metal=gold&category=bullion`).catch(() => null),
    api(`/api/inv/snapshot?${snapBase_}&metal=gold&category=proof`).catch(() => null),
    api(`/api/inv/snapshot?${snapBase_}&metal=silver&category=bullion`).catch(() => null),
    api(`/api/inv/snapshot?${snapBase_}&metal=silver&category=proof`).catch(() => null),
  ]);
  _invSnap = { goldBull: gsBull_, goldProof: gsProof_, silBull: ssBull_, silProof: ssProof_ };
  if (typeof renderInventorySnapshot === 'function') renderInventorySnapshot(gsBull_, gsProof_, ssBull_, ssProof_);

  _vwapCache = { deals: fDeals, otherDeals: fOtherDeals, inv, hedging, otherInv, otherHedging };
  renderVwapBanner(fDeals, fOtherDeals, inv, hedging, otherInv, otherHedging);
  updateBannerLayout();

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
  setSubLines('exp-oz',
    [`${fmt(ecosystemOz, 2)} oz`, 'net exposure'],
    [`${fmt(bullionOz, 2)} oz`, 'physical ecosystem'],
  );
  _lastDealingGP = totalGP;
  set('exp-gp',   formatCurrency(totalGP));
  setSubLines('exp-gp-sub',
    [`${deals.length}`, `deal${deals.length !== 1 ? 's' : ''} in period`],
  );
  updateNetGP();
  set('exp-spot', formatCurrency(spot));
  set('exp-provision', provActive ? 'PROVISION' : 'NO PROVISION');
  setSubLines('exp-prov-sub',
    provActive
      ? [`${provRate}%`, 'provision rate applies']
      : [`${fmt(bullionOz, 2)} oz`, 'physical on hand'],
  );

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
  setSubLines('exp-combined-gp-sub',
    [formatCurrency(goldGP), 'gold GP'],
    [formatCurrency(silverGP), 'silver GP'],
  );
}

// ─── COMBINED PNL BANNER ─────────────────────────────────────────────────────

function renderCombinedPNL(combinedGP, combinedAlpha, goldGP, silverGP, goldAlpha, silverAlpha) {
  const totalPNL = combinedGP + combinedAlpha;
  set('exp-combined-pnl', formatCurrency(totalPNL));
  setSubLines('exp-combined-pnl-sub',
    [formatCurrency(goldGP),    'gold dealing GP'],
    [formatCurrency(silverGP),  'silver dealing GP'],
    [formatCurrency(goldAlpha), 'gold treasury alpha'],
    [formatCurrency(silverAlpha),'silver treasury alpha'],
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

  _lastTreasuryAlpha = currentAlpha;
  set('exp-alpha',     formatCurrency(currentAlpha));
  setSubLines('exp-alpha-sub',
    [fmt((currentExp && currentExp.matched_oz) || 0, 2) + ' oz', `${currentMetal === 'gold' ? 'gold' : 'silver'} matched hedge`],
  );
  updateNetGP();
  set('exp-combined-alpha',     formatCurrency(combinedAlpha));
  setSubLines('exp-combined-alpha-sub',
    [formatCurrency(goldAlpha),   'gold treasury alpha'],
    [formatCurrency(silverAlpha), 'silver treasury alpha'],
  );

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

// ─── NET GP (Dealing GP + Treasury Alpha) ────────────────────────────────────

function updateNetGP() {
  const netGP = _lastDealingGP + _lastTreasuryAlpha;
  const el = document.getElementById('exp-net-gp');
  if (el) {
    el.textContent = formatCurrency(netGP);
    el.className = 'exp-value ' + (netGP >= 0 ? 'gold' : 'neg');
  }
  setSubLines('exp-net-gp-sub',
    [formatCurrency(_lastDealingGP),     'dealing GP'],
    [formatCurrency(_lastTreasuryAlpha), 'treasury alpha'],
  );
  const card = document.getElementById('exp-card-net-gp');
  if (card) {
    card.classList.toggle('alpha-positive', netGP >= 0);
    card.classList.toggle('alpha-negative', netGP <  0);
  }
}

// ─── BANNER LAYOUT CONTROLLER ────────────────────────────────────────────────
// Controls card order + visibility based on: entity / metal / category / section

function updateBannerLayout() {
  const provCard          = document.getElementById('exp-card-provision');
  const netExpCard        = document.getElementById('exp-card-net-exposure');
  const gpCard            = document.getElementById('exp-card-gp');
  const gpLabel           = document.getElementById('exp-label-gp');
  const alphaCard         = document.getElementById('exp-card-alpha');
  const vwapCard          = document.getElementById('exp-card-vwap');
  const netGpCard         = document.getElementById('exp-card-net-gp');
  const combinedGpCard    = document.getElementById('exp-card-combined-gp-card');
  const combinedGpLabel   = document.getElementById('exp-label-combined-gp');
  const combinedAlphaCard = document.getElementById('exp-card-combined-alpha');
  const combinedPnlCard   = document.getElementById('exp-card-combined-pnl');
  const vwapCombCard      = document.getElementById('exp-card-vwap-combined');

  if (currentMetal === 'combined') {
    // Order: 1-Provision, 2-VWAP (Au/Ag), 3-Net Exposure, 4-Combined Alpha, 5-Dealing GP, 6-Combined PNL
    if (provCard)          provCard.style.order          = '1';
    if (vwapCombCard)      vwapCombCard.style.order      = '2';
    if (netExpCard)        netExpCard.style.order         = '3';
    if (combinedAlphaCard) combinedAlphaCard.style.order = '4';
    if (combinedGpCard)    combinedGpCard.style.order    = '5';
    if (combinedPnlCard)   combinedPnlCard.style.order   = '6';
    // Hide generic Total GP (Combined GP card replaces it), ensure Net GP hidden
    if (gpCard)    gpCard.classList.add('exp-card-hidden');
    if (netGpCard) netGpCard.classList.add('exp-card-hidden');
    if (combinedGpLabel) combinedGpLabel.textContent = 'Dealing GP (Au + Ag)';
    if (gpLabel)         gpLabel.textContent          = 'Total GP';
  } else {
    // Order: 1-Provision, 2-VWAP, 3-Net Exposure, 4-Treasury Alpha, 5-Dealing GP, 6-Net GP
    if (provCard)   provCard.style.order   = '1';
    if (vwapCard)   vwapCard.style.order   = '2';
    if (netExpCard) netExpCard.style.order = '3';
    if (alphaCard)  alphaCard.style.order  = '4';
    if (gpCard)     gpCard.style.order     = '5';
    if (netGpCard)  netGpCard.style.order  = '6';
    // Show Total GP and Net GP, reset combined label
    if (gpCard)          gpCard.classList.remove('exp-card-hidden');
    if (netGpCard)       netGpCard.classList.remove('exp-card-hidden');
    if (combinedGpLabel) combinedGpLabel.textContent = 'Combined GP (Au + Ag)';
    if (gpLabel)         gpLabel.textContent          = 'Dealing GP';
  }
}

// ─── TOP DEAL TRACKER ────────────────────────────────────────────────────────

// ─── VWAP EXPOSURE BANNER CARD ────────────────────────────────────────────────

function renderVwapBanner(deals, otherDeals, inv, hedging, otherInv, otherHedging) {
  function buyVwap(subset) {
    const buys = subset.filter(d => d.deal_type === 'buy');
    const oz   = buys.reduce((s, d) => s + (d.oz || 0), 0);
    const val  = buys.reduce((s, d) => s + (d.deal_value_zar || 0), 0);
    return { vwap: oz > 0 ? val / oz : 0, oz };
  }

  const pctVsSpot = (vwap, spot) =>
    vwap > 0 && spot > 0 ? ((spot - vwap) / vwap) * 100 : null;

  const spot = liveSpots[currentMetal === 'silver' ? 'silver' : 'gold'];

  if (currentMetal === 'combined') {
    const gDeals = (deals || []).filter(d => d.metal === 'gold');
    const sDeals = (otherDeals || []).concat((deals || []).filter(d => d.metal === 'silver'));
    const gv = buyVwap([...(deals||[]), ...(otherDeals||[])].filter(d => d.metal === 'gold'));
    const sv = buyVwap([...(deals||[]), ...(otherDeals||[])].filter(d => d.metal === 'silver'));
    const gSpot = liveSpots.gold, sSpot = liveSpots.silver;
    const gPct  = pctVsSpot(gv.vwap, gSpot);
    const sPct  = pctVsSpot(sv.vwap, sSpot);
    const gEco  = (gInv_?.total_oz || 0) + ((gHedge_?.net_oz) || 0);
    const sEco  = (sInv_?.total_oz || 0) + ((sHedge_?.net_oz) || 0);

    set('exp-vwap-combined-val',
      [gv.vwap > 0 ? `Au ${formatCurrency(gv.vwap)}` : '', sv.vwap > 0 ? `Ag ${formatCurrency(sv.vwap)}` : '']
        .filter(Boolean).join(' / ') || '–'
    );
    setSubLines('exp-vwap-combined-sub',
      gv.vwap > 0 ? [`${fmt(gEco, 2)} oz`, 'gold net exposed'] : null,
      gPct != null ? [
        (gPct >= 0 ? '+' : '') + fmt(gPct, 2) + '%',
        `gold VWAP vs spot (${formatCurrency(gSpot)})`
      ] : null,
      sv.vwap > 0 ? [`${fmt(sEco, 2)} oz`, 'silver net exposed'] : null,
      sPct != null ? [
        (sPct >= 0 ? '+' : '') + fmt(sPct, 2) + '%',
        `silver VWAP vs spot (${formatCurrency(sSpot)})`
      ] : null,
    );

    const card = document.getElementById('exp-card-vwap-combined');
    if (card) {
      card.classList.toggle('alpha-positive', (gPct || 0) >= 0);
      card.classList.toggle('alpha-negative', (gPct || 0) < 0);
    }
    return;
  }

  // Single metal
  const metal    = currentMetal;
  const metalLbl = metal === 'gold' ? 'gold' : 'silver';
  const ecoOz    = (inv?.total_oz || 0) + (hedging?.net_oz || 0);
  const isShort  = ecoOz < 0;

  // Use sell VWAP when net short, buy VWAP when net long
  function sideVwap(subset, side) {
    const filtered = subset.filter(d => d.deal_type === side);
    const oz  = filtered.reduce((s, d) => s + (d.oz || 0), 0);
    const val = filtered.reduce((s, d) => s + (d.deal_value_zar || 0), 0);
    return { vwap: oz > 0 ? val / oz : 0 };
  }
  const { vwap } = isShort ? sideVwap(deals || [], 'sell') : buyVwap(deals || []);

  const pct    = pctVsSpot(vwap, spot);
  const pctStr = pct != null ? (pct >= 0 ? '+' : '') + fmt(pct, 2) + '%' : '–';

  const catSuffix  = currentCategory === 'bullion' ? ' bullion' : currentCategory === 'proof' ? ' proof' : '';
  const vwapLabel  = (isShort ? 'Sell VWAP' : 'Buy VWAP') + (catSuffix ? ' ·' + catSuffix : '');

  set('exp-vwap-label', vwapLabel);
  set('exp-vwap-val',   vwap > 0 ? formatCurrency(vwap) : '–');
  setSubLines('exp-vwap-sub',
    [`${fmt(ecoOz, 2)} oz`, `${metalLbl}${catSuffix} net exposed`],
    vwap > 0 ? [pctStr, `vs spot (${formatCurrency(spot)})`] : null,
  );

  const card = document.getElementById('exp-card-vwap');
  if (card) {
    card.classList.remove('alpha-positive', 'alpha-negative');
    if (pct != null) card.classList.add(pct >= 0 ? 'alpha-positive' : 'alpha-negative');
  }
}

// Module refs for combined VWAP (set during loadAll combined mode)
let gInv_, sInv_, gHedge_, sHedge_;

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
  set('buy-oz',     fmt(b.oz, 2) + ' oz');
  set('buy-value',  formatCurrency(b.val));
  set('buy-gp',     formatCurrency(b.gp));

  // Sales
  set('sell-count',  s.count + ' deal' + (s.count !== 1 ? 's' : ''));
  set('sell-oz',     fmt(s.oz, 2) + ' oz');
  set('sell-value',  formatCurrency(s.val));
  set('sell-gp',     formatCurrency(s.gp));

  if (currentMetal === 'combined') {
    // Split VWAPs by metal — can't meaningfully average across Au/Ag
    const gBuys  = buys.filter(d => d.metal === 'gold');
    const sBuys  = buys.filter(d => d.metal === 'silver');
    const gSells = sells.filter(d => d.metal === 'gold');
    const sSells = sells.filter(d => d.metal === 'silver');
    const gb = calcStats(gBuys), sb = calcStats(sBuys);
    const gs = calcStats(gSells), ss = calcStats(sSells);
    const buyVwapStr  = [gb.vwap  > 0 ? `Au ${formatCurrency(gb.vwap)}`  : '', sb.vwap  > 0 ? `Ag ${formatCurrency(sb.vwap)}`  : ''].filter(Boolean).join(' / ') || '–';
    const sellVwapStr = [gs.vwap  > 0 ? `Au ${formatCurrency(gs.vwap)}`  : '', ss.vwap  > 0 ? `Ag ${formatCurrency(ss.vwap)}`  : ''].filter(Boolean).join(' / ') || '–';
    const buyMgStr    = [gb.count > 0 ? `Au ${fmt(gb.vwapMargin, 2)}%` : '', sb.count > 0 ? `Ag ${fmt(sb.vwapMargin, 2)}%` : ''].filter(Boolean).join(' / ') || '–';
    const sellMgStr   = [gs.count > 0 ? `Au ${fmt(gs.vwapMargin, 2)}%` : '', ss.count > 0 ? `Ag ${fmt(ss.vwapMargin, 2)}%` : ''].filter(Boolean).join(' / ') || '–';
    set('buy-vwap',   buyVwapStr);
    set('buy-margin', buyMgStr);
    set('sell-vwap',  sellVwapStr);
    set('sell-margin',sellMgStr);
  } else {
    set('buy-vwap',   b.vwap > 0 ? formatCurrency(b.vwap) : '–');
    set('buy-margin', b.count > 0 ? fmt(b.vwapMargin, 2) + '%' : '–');
    set('sell-vwap',   s.vwap > 0 ? formatCurrency(s.vwap) : '–');
    set('sell-margin', s.count > 0 ? fmt(s.vwapMargin, 2) + '%' : '–');
  }

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
  set('hedge-short-oz',   fmt(shortOz, 2) + ' oz');
  set('hedge-net-oz',     fmt(netOz,       2) + ' oz');
  set('hedge-ecosystem-oz', fmt(ecosystemOz, 2) + ' oz');

  if (currentMetal === 'combined') {
    const glv = hedging.gold_long_vwap    || 0;
    const slv = hedging.silver_long_vwap  || 0;
    const gsv = hedging.gold_short_vwap   || 0;
    const ssv = hedging.silver_short_vwap || 0;
    set('hedge-long-vwap',  [glv > 0 ? `Au ${formatCurrency(glv)}` : '', slv > 0 ? `Ag ${formatCurrency(slv)}` : ''].filter(Boolean).join(' / ') || '–');
    set('hedge-short-vwap', [gsv > 0 ? `Au ${formatCurrency(gsv)}` : '', ssv > 0 ? `Ag ${formatCurrency(ssv)}` : ''].filter(Boolean).join(' / ') || '–');
  } else {
    set('hedge-long-vwap',  longVwap  > 0 ? formatCurrency(longVwap)  : '–');
    set('hedge-short-vwap', shortVwap > 0 ? formatCurrency(shortVwap) : '–');
  }

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
    const metalBadge = currentMetal === 'combined'
      ? `<span class="pos-metal-badge ${p.metal}">${p.metal === 'silver' ? 'Ag' : 'Au'}</span>`
      : '';
    const div = document.createElement('div');
    div.className = 'hedge-pos-row';
    div.innerHTML = `
      ${metalBadge}
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

  if (currentMetal === 'combined') {
    // Show per-metal breakdown in combined mode
    const gLongs  = positions.filter(p => p.metal === 'gold'   && p.position_type === 'long');
    const sLongs  = positions.filter(p => p.metal === 'silver' && p.position_type === 'long');
    const gShorts = positions.filter(p => p.metal === 'gold'   && p.position_type === 'short');
    const sShorts = positions.filter(p => p.metal === 'silver' && p.position_type === 'short');

    const gLongOz  = gLongs.reduce((s, p)  => s + (p.contract_oz || 0), 0);
    const sLongOz  = sLongs.reduce((s, p)  => s + (p.contract_oz || 0), 0);
    const gShortOz = gShorts.reduce((s, p) => s + (p.contract_oz || 0), 0);
    const sShortOz = sShorts.reduce((s, p) => s + (p.contract_oz || 0), 0);

    const gLongVal = gLongs.reduce((s, p)  => s + (p.open_price_zar || 0) * (p.contract_oz || 0), 0);
    const sLongVal = sLongs.reduce((s, p)  => s + (p.open_price_zar || 0) * (p.contract_oz || 0), 0);

    const gLongVwap = gLongOz > 0 ? gLongVal / gLongOz : 0;
    const sLongVwap = sLongOz > 0 ? sLongVal / sLongOz : 0;

    const totalLongs = gLongs.length + sLongs.length;
    const totalShorts = gShorts.length + sShorts.length;

    set('ht-long-count', totalLongs + ' position' + (totalLongs !== 1 ? 's' : ''));
    set('ht-long-vwap',  [gLongVwap > 0 ? `Au ${formatCurrency(gLongVwap)}` : '', sLongVwap > 0 ? `Ag ${formatCurrency(sLongVwap)}` : ''].filter(Boolean).join(' / ') || '–');
    set('ht-long-val',   `Au ${formatCurrency(gLongVal)}  |  Ag ${formatCurrency(sLongVal)}`);
    set('ht-long-oz',    `Au ${fmt(gLongOz, 2)} oz  |  Ag ${fmt(sLongOz, 2)} oz`);

    set('ht-short-count', totalShorts + ' position' + (totalShorts !== 1 ? 's' : ''));
    set('ht-short-vwap',  totalShorts > 0 ? `Au ${fmt(gShortOz, 2)} oz  |  Ag ${fmt(sShortOz, 2)} oz` : '–');
    set('ht-short-val',   '–');
    set('ht-short-oz',    `Au ${fmt(gShortOz, 2)} oz  |  Ag ${fmt(sShortOz, 2)} oz`);

    set('ht-net-oz', `Au ${fmt(gLongOz - gShortOz, 2)} oz  |  Ag ${fmt(sLongOz - sShortOz, 2)} oz`);
    set('ht-eco-oz', `Au ${fmt((inv && inv.total_oz || 0) + gLongOz - gShortOz, 2)} oz`);
    return;
  }

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
  // In combined mode use the dedicated metal selector; otherwise use the active tab metal
  const metal    = currentMetal === 'combined'
    ? (document.getElementById('h-metal-combined')?.value || 'gold')
    : currentMetal;

  if (!oz || isNaN(oz)) { showToast('Enter a valid oz amount', true); return; }

  try {
    await api('/api/hedging', {
      method: 'POST',
      json: {
        entity:         currentEntity,
        metal:          metal,
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

  const colCount = currentMetal === 'combined' ? 18 : 17;
  if (!deals.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;padding:24px;color:var(--muted)">No deals found — upload a dealer sheet to get started</td></tr>`;
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
      <td colspan="${colCount}">
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
      const metalBadge = d.metal === 'silver'
        ? '<span class="deal-metal-badge silver">Ag</span>'
        : '<span class="deal-metal-badge gold">Au</span>';
      tr.innerHTML = `
        <td>${d.id}</td>
        <td>–</td>
        <td class="metal-col">${metalBadge}</td>
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

// ─── INVENTORY SNAPSHOT ───────────────────────────────────────────────────────

function renderInventorySnapshot(goldBull, goldProof, silBull, silProof) {
  function buildRows(tbody, tfoot, items) {
    tbody.innerHTML = '';
    let totalEaches = 0, totalOz = 0;

    const nonZero = Object.values(items).filter(it => (it.closing_eaches || 0) !== 0);
    if (!nonZero.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">No stock on hand</td></tr>';
    }

    nonZero.forEach(it => {
        totalEaches += it.closing_eaches || 0;
        totalOz     += it.closing_oz     || 0;
        const recon = it.recon_match === null ? '–' : it.recon_match ? '✓' : '✗';
        const reconCls = it.recon_match === null ? '' : it.recon_match ? 'recon-ok' : 'recon-fail';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${it.product_name}</td>
          <td style="color:var(--muted);font-size:11px">${it._category || ''}</td>
          <td class="num">${fmt(it.closing_eaches, 0)}</td>
          <td class="num">${fmt(it.closing_oz, 3)}</td>
          <td class="num" style="color:var(--muted)">${fmt(it.threshold_stock, 0)}</td>
          <td class="num">${fmt(it.available_to_sell, 0)}</td>
          <td class="num" style="color:var(--muted)">${it.sage_eaches !== null ? fmt(it.sage_eaches, 0) : '–'}</td>
          <td class="num ${reconCls}">${recon}</td>
        `;
        tbody.appendChild(tr);
      });

    tfoot.innerHTML = `
      <tr class="inv-totals-row">
        <td colspan="2"><strong>Total</strong></td>
        <td class="num"><strong>${fmt(totalEaches, 0)}</strong></td>
        <td class="num"><strong>${fmt(totalOz, 3)}</strong></td>
        <td colspan="4"></td>
      </tr>
    `;
  }

  // Merge items respecting the currentCategory filter
  function mergeItems(bull, proof) {
    const merged = {};
    if (currentCategory !== 'proof'   && bull  && bull.items)
      Object.entries(bull.items).forEach(([k, v])  => { merged[k] = { ...v, _category: 'Bullion' }; });
    if (currentCategory !== 'bullion' && proof && proof.items)
      Object.entries(proof.items).forEach(([k, v]) => { merged[k] = { ...v, _category: 'Proof'   }; });
    return merged;
  }

  const goldTbody = document.getElementById('inv-gold-tbody');
  const goldTfoot = document.getElementById('inv-gold-tfoot');
  const silTbody  = document.getElementById('inv-silver-tbody');
  const silTfoot  = document.getElementById('inv-silver-tfoot');

  if (goldTbody && goldTfoot) {
    buildRows(goldTbody, goldTfoot, mergeItems(goldBull, goldProof));
  }
  if (silTbody && silTfoot) {
    buildRows(silTbody, silTfoot, mergeItems(silBull, silProof));
  }

  // Hedge exposure cards
  const goldEco = (goldBull && goldBull.ecosystem) || {};
  const silEco  = (silBull  && silBull.ecosystem)  || {};

  function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
  setEl('inv-gold-physical-oz',  `${fmt(goldEco.total_inv_oz        || 0, 3)} oz`);
  setEl('inv-gold-sam-oz',       `${fmt(goldEco.sam_hedged_oz       || 0, 3)} oz`);
  setEl('inv-gold-sx-oz',        `${fmt(goldEco.sx_hedged_oz        || 0, 3)} oz`);
  setEl('inv-gold-net-oz',       `${fmt(goldEco.ecosystem_oz        || 0, 3)} oz`);
  setEl('inv-silver-physical-oz',`${fmt(silEco.total_inv_oz         || 0, 3)} oz`);
  setEl('inv-silver-sam-oz',     `${fmt(silEco.sam_hedged_oz        || 0, 3)} oz`);
  setEl('inv-silver-sx-oz',      `${fmt(silEco.sx_hedged_oz         || 0, 3)} oz`);
  setEl('inv-silver-net-oz',     `${fmt(silEco.ecosystem_oz         || 0, 3)} oz`);
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
    // combined mode defaults to gold spot in the preview panel
    spotEl.value = (currentMetal === 'gold' || currentMetal === 'combined') ? gold : silver;
  }

  // Re-render VWAP banner so % vs spot stays live after price refresh
  if (_vwapCache.deals || _vwapCache.otherDeals) {
    renderVwapBanner(
      _vwapCache.deals, _vwapCache.otherDeals,
      _vwapCache.inv, _vwapCache.hedging,
      _vwapCache.otherInv, _vwapCache.otherHedging
    );
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

let siloChartSummary;

function renderSiloChart(data) {
  const canvas = document.getElementById('silo-chart');
  const ctx    = canvas?.getContext('2d');
  if (ctx) {
    const labels = Object.keys(data);
    const values = labels.map(k => data[k].gp_proportion_pct || 0);
    if (!labels.length || values.every(v => v === 0)) {
      emptyChartNote(canvas); if (siloChart) { siloChart.destroy(); siloChart = null; }
    } else {
      clearEmptyNote(canvas);
      if (siloChart) siloChart.destroy();
      siloChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: BRAND_COLORS, borderWidth: 2, borderColor: '#150E26', hoverOffset: 8 }] },
        options: doughnutOptions(),
      });
    }
  }

  // Also render summary silo chart + table
  const sc = document.getElementById('silo-chart-summary');
  if (sc) {
    const labels = Object.keys(data);
    const values = labels.map(k => data[k].gp_proportion_pct || 0);
    if (siloChartSummary) siloChartSummary.destroy();
    if (labels.length && !values.every(v => v === 0)) {
      siloChartSummary = new Chart(sc, {
        type: 'doughnut',
        data: { labels, datasets: [{ data: values, backgroundColor: BRAND_COLORS, borderWidth: 2, borderColor: '#150E26', hoverOffset: 8 }] },
        options: { ...doughnutOptions(), plugins: { ...doughnutOptions().plugins, legend: { position: 'bottom', labels: { color: 'rgba(240,238,248,0.6)', font: { size: 10 }, boxWidth: 10 } } } },
      });
    }
  }
  const tbody = document.getElementById('silo-summary-tbody');
  if (tbody) {
    tbody.innerHTML = '';
    const silos = Object.entries(data).sort((a, b) => (b[1].gp_zar || 0) - (a[1].gp_zar || 0));
    const totalGP = silos.reduce((s, [, v]) => s + (v.gp_zar || 0), 0);
    silos.forEach(([silo, v]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${silo || '(unclassified)'}</td>
        <td class="num">${v.count || 0}</td>
        <td class="num" style="color:var(--gold)">${formatCurrency(v.gp_zar || 0)}</td>
        <td class="num">${fmt(v.gp_proportion_pct || 0, 1)}%</td>
      `;
      tbody.appendChild(tr);
    });
    if (silos.length) {
      const tfoot = document.createElement('tr');
      tfoot.className = 'silo-total-row';
      tfoot.innerHTML = `<td><strong>Total</strong></td><td class="num">${silos.reduce((s, [, v]) => s + (v.count || 0), 0)}</td><td class="num" style="color:var(--gold)"><strong>${formatCurrency(totalGP)}</strong></td><td class="num">100%</td>`;
      tbody.appendChild(tfoot);
    }
  }
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

// Render labeled sub-lines: setSubLines('id', ['value', 'label'], ['value2', 'label2'], ...)
// Null entries are skipped.
function setSubLines(id, ...pairs) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = pairs.filter(p => p != null).map(([val, lbl]) =>
    `<span class="sub-line"><span class="sub-val">${val}</span>&ensp;${lbl}</span>`
  ).join('');
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
