/**
 * Treasury Brain — Dashboard JS
 * SA Bullion × Apple aesthetic
 */

'use strict';

let currentEntity = 'SABIS';
let currentMetal  = 'gold';
let siloChart, channelChart, volumeChart, vwapChart, gpChart;
const POLL_INTERVAL = 30_000;

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

// ─── LOAD ALL ────────────────────────────────────────────────────────────────

async function loadAll() {
  const [deals, inv] = await Promise.all([
    api(`/api/deals?entity=${currentEntity}&metal=${currentMetal}&limit=500`).catch(() => []),
    api(`/api/inventory?entity=${currentEntity}&metal=${currentMetal}`).catch(() => ({})),
  ]);

  renderExposure(deals, inv);
  renderTrading(deals);
  renderDealsTable(deals);
  renderAgedInventory(inv.aged_parcels || []);
  await loadSpot();
}

// ─── EXPOSURE BANNER ─────────────────────────────────────────────────────────

function renderExposure(deals, inv) {
  const oz   = inv.total_oz  || 0;
  const spot = inv.spot_zar  || 0;
  const prov = inv.provision || {};

  const totalGP = deals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  set('exp-oz',        fmt(Math.abs(oz), 4) + ' oz' + (oz < 0 ? ' (short)' : ''));
  set('exp-value-zar', formatZAR(Math.abs(oz * spot)));
  set('exp-gp',        formatZAR(totalGP));
  set('exp-gp-sub',    `${deals.length} deal${deals.length !== 1 ? 's' : ''} total`);
  set('exp-spot',      formatZAR(spot));
  set('exp-provision', prov.mode || '–');
  set('exp-prov-sub',  prov.active ? `${prov.rate_pct}% applies` : 'No provision active');

  const provCard = document.getElementById('exp-card-provision');
  if (provCard) {
    provCard.classList.toggle('active',   !!prov.active);
    provCard.classList.toggle('inactive', !prov.active);
  }
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
    const margins = subset.map(d => d.margin_pct).filter(m => m != null);
    const avgMargin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0;
    return { count, oz, val, vwap, gp, avgMargin };
  }

  const b = calcStats(buys);
  const s = calcStats(sells);

  // Buybacks
  set('buy-count',  b.count + ' deal' + (b.count !== 1 ? 's' : ''));
  set('buy-vwap',   b.vwap > 0 ? formatZAR(b.vwap) : '–');
  set('buy-margin', b.count > 0 ? fmt(b.avgMargin, 2) + '%' : '–');
  set('buy-oz',     fmt(b.oz, 4) + ' oz');
  set('buy-value',  formatZAR(b.val));
  set('buy-gp',     formatZAR(b.gp));

  // Sales
  set('sell-count',  s.count + ' deal' + (s.count !== 1 ? 's' : ''));
  set('sell-vwap',   s.vwap > 0 ? formatZAR(s.vwap) : '–');
  set('sell-margin', s.count > 0 ? fmt(s.avgMargin, 2) + '%' : '–');
  set('sell-oz',     fmt(s.oz, 4) + ' oz');
  set('sell-value',  formatZAR(s.val));
  set('sell-gp',     formatZAR(s.gp));

  // Hedging — placeholders until hedging API is wired up
  set('hedge-long-oz',  '– oz');
  set('hedge-long-val', 'Not configured');
  set('hedge-short-oz', '– oz');
  set('hedge-short-val','Not configured');
  set('hedge-net-oz',   '– oz');
  set('hedge-net-val',  'Not configured');

  // Silo / channel charts
  renderSiloChart(calcSiloStats(deals));
  renderChannelChart(calcChannelStats(deals));
  renderVolumeChart(deals);
  renderVwapChart(deals);
  renderGpChart(deals);
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
        <span class="date-sep-meta">${dayDeals.length} deals &nbsp;·&nbsp; ${buyCount} buybacks &nbsp;·&nbsp; ${sellCount} sales &nbsp;·&nbsp; GP ${formatZAR(dayGP)}</span>
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
        <td>${fmt(d.oz, 4)}</td>
        <td>${formatZAR(d.spot_price_zar)}</td>
        <td>${fmt(d.margin_pct, 2)}%</td>
        <td>${formatZAR(d.deal_value_zar)}</td>
        <td>${fmt(d.provision_pct, 1)}%</td>
        <td class="${(d.profit_margin_pct || 0) >= 0 ? 'sell' : 'buy'}">${fmt(d.profit_margin_pct, 2)}%</td>
        <td>${formatZAR(d.gp_contribution_zar)}</td>
        <td>${fmt(d.inventory_after_oz, 4)}</td>
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
      <td>${fmt(p.oz, 4)} oz</td>
      <td>${formatZAR(p.cost_price_zar)}</td>
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

  document.getElementById('spot-gold').textContent   = `Au ${formatZAR(gold)}`;
  document.getElementById('spot-silver').textContent = `Ag ${formatZAR(silver)}`;

  set('exp-spot', formatZAR(currentMetal === 'gold' ? gold : silver));

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
  const el  = document.getElementById('preview-result');
  const mvp = r.margin_vs_provision || {};
  const flip = r.provision_flips;

  el.className = 'preview-result' + (flip ? ' flip-alert' : '');
  el.innerHTML = `
    <div class="preview-row"><span class="preview-key">Deal Value</span>
      <span class="preview-val">${formatZAR(r.deal_value_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Effective Price</span>
      <span class="preview-val">${formatZAR(r.effective_price)}/oz</span></div>
    <div class="preview-row"><span class="preview-key">Profit vs Provision</span>
      <span class="preview-val ${mvp.profitable ? 'profit' : 'loss'}">${fmt(mvp.profit_pct, 2)}%</span></div>
    <div class="preview-row"><span class="preview-key">GP Contribution</span>
      <span class="preview-val ${mvp.profitable ? 'profit' : 'loss'}">${formatZAR(r.gp_contribution_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Cash Flow</span>
      <span class="preview-val">${formatZAR(r.cash_delta_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Inventory After</span>
      <span class="preview-val">${fmt(r.new_inventory_oz, 4)} oz</span></div>
    <div class="preview-row"><span class="preview-key">Provision</span>
      <span class="preview-val ${flip ? 'alert' : ''}">${(r.provision_before||{}).mode} → ${(r.provision_after||{}).mode}</span></div>
    ${flip ? '<div class="flip-warning">This deal changes provision mode</div>' : ''}
  `;
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
      showToast(`Imported ${result.deals_imported} deals`);
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

// ─── HELPER: group deals by date ─────────────────────────────────────────────
function groupByDate(deals) {
  const map = {};
  deals.forEach(d => {
    const dt = d.deal_date || 'unknown';
    if (!map[dt]) map[dt] = { buys: [], sells: [] };
    if (d.deal_type === 'buy')  map[dt].buys.push(d);
    if (d.deal_type === 'sell') map[dt].sells.push(d);
  });
  // Return sorted by date ascending
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
}

function lineChartDefaults() {
  return {
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0.35,
    fill: false,
  };
}

function axisDefaults(title) {
  return {
    ticks:  { color: 'rgba(240,238,248,0.4)', font: { size: 10 }, maxRotation: 45 },
    grid:   { color: 'rgba(107,57,175,0.12)' },
    title:  title ? { display: true, text: title, color: 'rgba(240,238,248,0.35)', font: { size: 10 } } : undefined,
  };
}

// ─── VOLUME BY DAY (bar chart) ────────────────────────────────────────────────
function renderVolumeChart(deals) {
  const ctx    = document.getElementById('volume-chart')?.getContext('2d');
  if (!ctx) return;
  const groups = groupByDate(deals);
  const labels = groups.map(([dt]) => dt.slice(5)); // MM-DD
  const buyOz  = groups.map(([, g]) => g.buys.reduce((s, d)  => s + (d.oz || 0), 0));
  const sellOz = groups.map(([, g]) => g.sells.reduce((s, d) => s + (d.oz || 0), 0));

  if (volumeChart) volumeChart.destroy();
  volumeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Buybacks (oz)', data: buyOz,  backgroundColor: 'rgba(64,181,173,0.75)',  borderRadius: 4 },
        { label: 'Sales (oz)',    data: sellOz,  backgroundColor: 'rgba(212,167,85,0.75)', borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: 'rgba(240,238,248,0.55)', font: { size: 11 }, boxWidth: 10, padding: 10 } },
      },
      scales: {
        x: axisDefaults(),
        y: { ...axisDefaults('oz'), beginAtZero: true },
      },
    },
  });
}

// ─── VWAP TREND (line chart) ──────────────────────────────────────────────────
function renderVwapChart(deals) {
  const ctx    = document.getElementById('vwap-chart')?.getContext('2d');
  if (!ctx) return;
  const groups = groupByDate(deals);
  const labels = groups.map(([dt]) => dt.slice(5));

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
        { label: 'Buy VWAP',  data: buyVwap,  borderColor: '#40B5AD', pointBackgroundColor: '#40B5AD', ...lineChartDefaults() },
        { label: 'Sell VWAP', data: sellVwap, borderColor: '#D4A755', pointBackgroundColor: '#D4A755', ...lineChartDefaults() },
      ],
    },
    options: {
      responsive: true,
      spanGaps: true,
      plugins: {
        legend: { labels: { color: 'rgba(240,238,248,0.55)', font: { size: 11 }, boxWidth: 10, padding: 10 } },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': R ' + (ctx.parsed.y || 0).toLocaleString('en-ZA', { maximumFractionDigits: 0 }),
          }
        }
      },
      scales: {
        x: axisDefaults(),
        y: { ...axisDefaults('ZAR/oz') },
      },
    },
  });
}

// ─── DAILY GP (bar chart) ─────────────────────────────────────────────────────
function renderGpChart(deals) {
  const ctx    = document.getElementById('gp-chart')?.getContext('2d');
  if (!ctx) return;
  const groups = groupByDate(deals);
  const labels = groups.map(([dt]) => dt.slice(5));
  const gpData = groups.map(([, g]) => {
    const all = [...g.buys, ...g.sells];
    return all.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  });

  if (gpChart) gpChart.destroy();
  gpChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'GP (ZAR)',
        data: gpData,
        backgroundColor: gpData.map(v => v >= 0 ? 'rgba(123,79,201,0.75)' : 'rgba(224,82,82,0.7)'),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => 'GP: R ' + (ctx.parsed.y || 0).toLocaleString('en-ZA', { maximumFractionDigits: 0 }),
          }
        }
      },
      scales: {
        x: axisDefaults(),
        y: { ...axisDefaults('ZAR') },
      },
    },
  });
}

function chartOptions(legendColor) {
  return {
    plugins: {
      legend: {
        labels: {
          color: legendColor || 'rgba(240,238,248,0.6)',
          font: { family: '-apple-system, Helvetica Neue, Arial', size: 11 },
          boxWidth: 10,
          padding: 12,
        }
      }
    },
    cutout: '68%',
  };
}

function renderSiloChart(data) {
  const ctx    = document.getElementById('silo-chart').getContext('2d');
  const labels = Object.keys(data);
  const values = labels.map(k => data[k].gp_proportion_pct || 0);

  if (siloChart) siloChart.destroy();
  siloChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: BRAND_COLORS, borderWidth: 0, hoverOffset: 6 }]
    },
    options: chartOptions(),
  });
}

function renderChannelChart(data) {
  const ctx    = document.getElementById('channel-chart').getContext('2d');
  const labels = Object.keys(data);
  const values = labels.map(k => data[k].gp_proportion_pct || 0);

  if (channelChart) channelChart.destroy();
  channelChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: BRAND_COLORS.slice(1), borderWidth: 0, hoverOffset: 6 }]
    },
    options: chartOptions(),
  });
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
