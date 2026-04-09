/**
 * Treasury Brain — Dashboard JS
 * Polls API, renders KPIs, charts, tables, and handles deal preview + file upload.
 */

'use strict';

let currentEntity = 'SABIS';
let currentMetal  = 'gold';
let siloChart, channelChart;
const POLL_INTERVAL = 30_000; // 30s

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// LOAD ALL
// ─────────────────────────────────────────────

async function loadAll() {
  await Promise.all([
    loadDashboard(),
    loadDeals(),
    loadAgedInventory(),
    loadSpot(),
  ]);
}

// ─────────────────────────────────────────────
// DASHBOARD KPIs
// ─────────────────────────────────────────────

async function loadDashboard() {
  try {
    const data = await api('/api/dashboard');
    const d = data[currentEntity]?.[currentMetal];
    if (!d) return;

    set('kpi-gp-val',        formatZAR(d.total_gp_today));
    set('kpi-inventory-val', fmt(d.inventory_oz, 6) + ' oz');
    set('kpi-inv-value-val', formatZAR(d.inventory_value_zar));
    set('kpi-buy-vwap',      formatZAR(d.buy_vwap));
    set('kpi-sell-vwap',     formatZAR(d.sell_vwap));
    set('kpi-deal-count',    d.deal_count_today);

    // Provision KPI
    const provEl = document.getElementById('kpi-provision');
    const mode   = d.provision_mode;
    set('kpi-provision-val', mode.mode + (mode.active ? ` (${mode.rate_pct}%)` : ''));
    provEl.classList.toggle('active',   mode.active);
    provEl.classList.toggle('inactive', !mode.active);

    // Charts
    renderSiloChart(d.silo_analytics);
    renderChannelChart(d.channel_analytics);

  } catch (e) {
    console.error('Dashboard load failed:', e);
  }
}

// ─────────────────────────────────────────────
// DEALS TABLE
// ─────────────────────────────────────────────

async function loadDeals() {
  const today  = new Date().toISOString().slice(0, 10);
  const deals  = await api(`/api/deals?entity=${currentEntity}&metal=${currentMetal}&date=${today}`);
  const tbody  = document.getElementById('deals-tbody');
  tbody.innerHTML = '';

  if (!deals.length) {
    tbody.innerHTML = '<tr><td colspan="17" style="text-align:center;color:var(--muted)">No deals today</td></tr>';
    return;
  }

  deals.forEach(d => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${d.id}</td>
      <td>${d.deal_date}</td>
      <td class="${d.deal_type}">${d.deal_type.toUpperCase()}</td>
      <td>${d.dealer_name || '–'}</td>
      <td>${d.silo}</td>
      <td>${d.channel}</td>
      <td>${d.product_name || d.product_code || '–'}</td>
      <td>${fmt(d.units)}</td>
      <td>${fmt(d.oz, 4)}</td>
      <td>${formatZAR(d.spot_price_zar)}</td>
      <td>${fmt(d.margin_pct, 2)}%</td>
      <td>${formatZAR(d.deal_value_zar)}</td>
      <td>${fmt(d.provision_pct, 1)}%</td>
      <td class="${d.profit_margin_pct >= 0 ? 'sell' : 'buy'}">${fmt(d.profit_margin_pct, 2)}%</td>
      <td>${formatZAR(d.gp_contribution_zar)}</td>
      <td>${fmt(d.inventory_after_oz, 4)}</td>
      <td>${d.provision_flipped ? '⚠ YES' : '–'}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─────────────────────────────────────────────
// AGED INVENTORY TABLE
// ─────────────────────────────────────────────

async function loadAgedInventory() {
  const data  = await api(`/api/inventory?entity=${currentEntity}&metal=${currentMetal}`);
  const tbody = document.getElementById('aged-tbody');
  tbody.innerHTML = '';

  const parcels = data.aged_parcels || [];
  if (!parcels.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No inventory parcels</td></tr>';
    return;
  }

  parcels.forEach(p => {
    const dom     = p.dormancy || {};
    const flagged = dom.flagged;
    const tr      = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.acquired_date}</td>
      <td>${fmt(p.oz, 4)}</td>
      <td>${formatZAR(p.cost_price_zar)}</td>
      <td class="${flagged ? 'flagged' : 'active'}">${dom.days_held ?? '–'}</td>
      <td class="${flagged ? 'flagged' : 'active'}">${dom.status ?? '–'}</td>
      <td>${p.exit_suggestion || '–'}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─────────────────────────────────────────────
// SPOT PRICES
// ─────────────────────────────────────────────

async function loadSpot() {
  const spots = await api('/api/spot');
  const gold  = spots['gold']   || 0;
  const silver = spots['silver'] || 0;
  document.getElementById('spot-gold').textContent   = `Au R${gold.toLocaleString('en-ZA', {maximumFractionDigits:0})}`;
  document.getElementById('spot-silver').textContent = `Ag R${silver.toLocaleString('en-ZA', {maximumFractionDigits:0})}`;

  // Pre-fill spot in preview panel
  const spotEl = document.getElementById('p-spot');
  if (!spotEl.dataset.manuallySet) {
    spotEl.value = currentMetal === 'gold' ? gold : silver;
  }
}

async function refreshSpot() {
  showToast('Refreshing spot prices…');
  await api('/api/spot/refresh', { method: 'POST' });
  await loadSpot();
  showToast('Spot prices updated');
}

// ─────────────────────────────────────────────
// DEAL IMPACT PREVIEW
// ─────────────────────────────────────────────

async function runPreview() {
  const body = {
    entity:        currentEntity,
    metal:         currentMetal,
    deal_type:     document.getElementById('p-type').value,
    units:         parseFloat(document.getElementById('p-units').value) || 1,
    equiv_oz:      parseFloat(document.getElementById('p-equiv-oz').value) || 1,
    spot_price_zar: parseFloat(document.getElementById('p-spot').value) || null,
    margin_pct:    parseFloat(document.getElementById('p-margin').value) || 0,
  };

  try {
    const r = await api('/api/preview', { method: 'POST', json: body });
    renderPreview(r);
  } catch (e) {
    showToast('Preview failed: ' + e.message, true);
  }
}

function renderPreview(r) {
  const el    = document.getElementById('preview-result');
  const mvp   = r.margin_vs_provision;
  const flip  = r.provision_flips;
  const profitable = mvp.profitable;

  el.className = 'preview-result' + (flip ? ' flip-alert' : '');

  el.innerHTML = `
    <div class="preview-row"><span class="preview-key">Deal Value (ZAR)</span>
      <span class="preview-val">${formatZAR(r.deal_value_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Effective Price</span>
      <span class="preview-val">${formatZAR(r.effective_price)}/oz</span></div>
    <div class="preview-row"><span class="preview-key">Profit vs Provision</span>
      <span class="preview-val ${profitable ? 'profit' : 'loss'}">${fmt(mvp.profit_pct, 2)}% (${mvp.label})</span></div>
    <div class="preview-row"><span class="preview-key">GP Contribution (ZAR)</span>
      <span class="preview-val ${profitable ? 'profit' : 'loss'}">${formatZAR(r.gp_contribution_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Cash Flow (ZAR)</span>
      <span class="preview-val">${formatZAR(r.cash_delta_zar)}</span></div>
    <div class="preview-row"><span class="preview-key">Inventory After (oz)</span>
      <span class="preview-val">${fmt(r.new_inventory_oz, 4)} oz</span></div>
    <div class="preview-row"><span class="preview-key">New VWAP</span>
      <span class="preview-val">${formatZAR(r.new_vwap)}</span></div>
    <div class="preview-row"><span class="preview-key">Provision Before → After</span>
      <span class="preview-val ${flip ? 'alert' : ''}">${r.provision_before.mode} → ${r.provision_after.mode}</span></div>
    ${flip ? `<div class="flip-warning">⚠ This deal changes provision mode!</div>` : ''}
  `;
}

// ─────────────────────────────────────────────
// FILE UPLOAD
// ─────────────────────────────────────────────

async function uploadFile(input) {
  const file = input.files[0];
  if (!file) return;

  showToast(`Uploading ${file.name}…`);
  const form = new FormData();
  form.append('file', file);

  try {
    const resp = await fetch('/api/upload', { method: 'POST', body: form });
    const result = await resp.json();

    if (result.status === 'error') {
      showToast(`Import failed: ${result.errors?.join(', ') || result.error}`, true);
    } else {
      showToast(`Imported ${result.deals_imported} deals (${result.status})`);
      loadAll();
    }
  } catch (e) {
    showToast('Upload error: ' + e.message, true);
  }

  input.value = '';
}

// ─────────────────────────────────────────────
// CHARTS
// ─────────────────────────────────────────────

function renderSiloChart(siloData) {
  const ctx    = document.getElementById('silo-chart').getContext('2d');
  const labels = Object.keys(siloData);
  const values = labels.map(k => siloData[k].gp_proportion_pct || 0);

  if (siloChart) siloChart.destroy();
  siloChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: ['#C9A84C','#A8A9AD','#1F4E79'] }]
    },
    options: {
      plugins: { legend: { labels: { color: '#E6EDF3' } } },
      cutout: '60%',
    }
  });
}

function renderChannelChart(channelData) {
  const ctx    = document.getElementById('channel-chart').getContext('2d');
  const labels = Object.keys(channelData);
  const values = labels.map(k => channelData[k].gp_proportion_pct || 0);

  if (channelChart) channelChart.destroy();
  channelChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: ['#1F4E79','#C9A84C'] }]
    },
    options: {
      plugins: { legend: { labels: { color: '#E6EDF3' } } },
      cutout: '60%',
    }
  });
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

async function api(path, opts = {}) {
  const options = {
    method: opts.method || 'GET',
    headers: {},
  };
  if (opts.json) {
    options.body = JSON.stringify(opts.json);
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
  return Number(val).toLocaleString('en-ZA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatZAR(val) {
  if (val == null || val === '') return '–';
  return 'R' + Number(val).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showToast(msg, isError = false) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = isError ? '#C62828' : '#1F4E79';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}
