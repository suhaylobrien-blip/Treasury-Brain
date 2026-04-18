
// ═══════════════════════════════════════════════════════════════════════════════
// v3.0 NEW FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── TREASURY EXPOSURE DETAIL CARDS ──────────────────────────────────────────

function renderTreasuryExposure(goldInv, silverInv, goldHedging, silverHedging, goldExp, silverExp) {
  const goldSpot   = liveSpots.gold   || (goldInv.spot_zar   || 0);
  const silverSpot = liveSpots.silver || (silverInv.spot_zar || 0);

  function metalStats(inv, hedging, exp, spot) {
    const physical  = inv.total_oz || 0;
    const positions = (hedging && hedging.positions) || [];
    const hedgeVal  = positions.reduce((s, p) => s + (p.contract_oz || 0) * (p.open_price_zar || 0), 0);
    const hedgeOz   = positions.reduce((s, p) => s + (p.contract_oz || 0), 0);
    const hedgeVwap = hedgeOz > 0 ? hedgeVal / hedgeOz : 0;  // Stone X only
    const netHz     = (hedging && hedging.net_oz) || 0;
    const netExp    = physical - netHz;
    const alpha     = (exp && exp.treasury_alpha) || 0;
    const alphaPct  = hedgeVal > 0 ? (alpha / hedgeVal) * 100 : null;

    // Open Exposure VWAP — FIFO full book (physical + hedge combined)
    const expNetOz   = (exp && exp.net_oz) || 0;
    const openExpVwap = expNetOz > 0
      ? ((exp && exp.open_long_vwap)  || 0)
      : expNetOz < 0
        ? ((exp && exp.open_short_vwap) || 0)
        : 0;

    // Spot % comparison uses Open Exposure VWAP as primary
    const spotPct = (openExpVwap > 0 && spot > 0)
      ? (spot - openExpVwap) / openExpVwap * 100
      : null;

    return { physical, hedgeVwap, openExpVwap, netExp, spotPct, alpha, alphaPct, netHz };
  }

  const g = metalStats(goldInv,   goldHedging,   goldExp,   goldSpot);
  const s = metalStats(silverInv, silverHedging, silverExp, silverSpot);

  function setPct(v, id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (v === null) { el.textContent = '--'; return; }
    el.textContent = (v >= 0 ? '+' : '') + fmt(v, 2) + '%';
    el.className   = 'tc-stat-val ' + (v >= 0 ? 'pos-mtm-pos' : 'pos-mtm-neg');
  }

  set('texp-gold-oz',         fmt(g.netExp, 3) + ' oz');
  set('texp-gold-vwap',       g.openExpVwap > 0 ? formatCurrency(g.openExpVwap) : '--');
  set('texp-gold-hedge-vwap', g.hedgeVwap   > 0 ? formatCurrency(g.hedgeVwap)   : '--');
  set('texp-gold-physical',   fmt(g.physical, 3) + ' oz');
  setPct(g.spotPct, 'texp-gold-pct');
  set('texp-gold-alpha',      formatCurrency(g.alpha) +
    (g.alphaPct !== null ? ' (' + (g.alphaPct >= 0 ? '+' : '') + fmt(g.alphaPct, 2) + '%)' : ''));

  set('texp-silver-oz',         fmt(s.netExp, 3) + ' oz');
  set('texp-silver-vwap',       s.openExpVwap > 0 ? formatCurrency(s.openExpVwap) : '--');
  set('texp-silver-hedge-vwap', s.hedgeVwap   > 0 ? formatCurrency(s.hedgeVwap)   : '--');
  set('texp-silver-physical',   fmt(s.physical, 3) + ' oz');
  setPct(s.spotPct, 'texp-silver-pct');
  set('texp-silver-alpha',      formatCurrency(s.alpha) +
    (s.alphaPct !== null ? ' (' + (s.alphaPct >= 0 ? '+' : '') + fmt(s.alphaPct, 2) + '%)' : ''));

  const goldNetZAR    = Math.abs(g.netExp) * goldSpot;
  const silverNetZAR  = Math.abs(s.netExp) * silverSpot;
  const goldHedgedZAR = Math.abs(g.netHz)  * goldSpot;
  const silverHZAR    = Math.abs(s.netHz)  * silverSpot;
  const stonexZAR     = zarPerUsd > 0 ? 460000 * zarPerUsd : 0;

  set('texp-comb-ozval',    formatCurrency(goldNetZAR + silverNetZAR));
  set('texp-comb-hedgeval', formatCurrency(goldHedgedZAR + silverHZAR));
  set('texp-comb-stonex',   stonexZAR > 0 ? formatCurrency(stonexZAR) : '$460,000 x ZAR');
}

// ─── DEALING SUMMARY CARDS ────────────────────────────────────────────────────

function renderDealingGP(deals, otherDeals, inv, otherInv) {
  const goldDeals   = currentMetal === 'gold'   ? deals : otherDeals;
  const silverDeals = currentMetal === 'silver' ? deals : otherDeals;
  const goldGP   = goldDeals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  const silverGP = silverDeals.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  const sells       = deals.filter(d => d.deal_type === 'sell');
  const buys        = deals.filter(d => d.deal_type === 'buy');
  const ozSold      = sells.reduce((s, d) => s + (d.oz || 0), 0);
  const ozBought    = buys.reduce((s, d)  => s + (d.oz || 0), 0);
  const valSold     = sells.reduce((s, d) => s + (d.deal_value_zar || 0), 0);
  const valBought   = buys.reduce((s, d)  => s + (d.deal_value_zar || 0), 0);
  const vwapSold    = ozSold   > 0 ? valSold   / ozSold   : 0;
  const vwapBought  = ozBought > 0 ? valBought / ozBought : 0;
  const vwapMargin  = ozSold   > 0
    ? sells.reduce((s, d) => s + (d.margin_pct || 0) * (d.oz || 0), 0) / ozSold   : 0;
  const buyMargin   = ozBought > 0
    ? buys.reduce((s, d)  => s + (d.margin_pct || 0) * (d.oz || 0), 0) / ozBought : 0;

  const badge = document.getElementById('dgp-badge');
  if (badge) badge.textContent = currentMetal === 'gold' ? 'Au' : 'Ag';

  set('dgp-oz-sold',        fmt(ozSold,    3) + ' oz');
  set('dgp-oz-bought',      fmt(ozBought,  3) + ' oz');
  set('dgp-vwap-sold',      vwapSold   > 0 ? formatCurrency(vwapSold)   : '--');
  set('dgp-vwap-margin',    ozSold     > 0 ? fmt(vwapMargin, 2) + '%'   : '--');
  set('dgp-vwap-bought',    vwapBought > 0 ? formatCurrency(vwapBought) : '--');
  set('dgp-vwap-buy-margin',ozBought   > 0 ? fmt(buyMargin,  2) + '%'   : '--');
  set('dgp-inv-oz',         fmt((inv && inv.total_oz) || 0, 3) + ' oz');
  set('dcgp-total',         formatCurrency(goldGP + silverGP));
  set('dcgp-gold',          formatCurrency(goldGP));
  set('dcgp-silver',        formatCurrency(silverGP));
}

// ─── BANK RECONCILIATION ─────────────────────────────────────────────────────

function renderBankRecon(goldDeals, silverDeals) {
  const OPENING    = 20000000;
  const SAM_MARGIN =  3000000;
  const STONEX_USD =   460000;

  const allDeals  = [...goldDeals, ...silverDeals];
  const salesProc = allDeals.filter(d => d.deal_type === 'sell')
    .reduce((s, d) => s + (d.deal_value_zar || 0), 0);
  const buyCost   = allDeals.filter(d => d.deal_type === 'buy')
    .reduce((s, d) => s + (d.deal_value_zar || 0), 0);
  const stonexZAR = zarPerUsd > 0 ? STONEX_USD * zarPerUsd : 0;
  const net = OPENING + salesProc - buyCost - SAM_MARGIN - stonexZAR;

  const netEl = document.getElementById('bank-net-cash');
  if (netEl) {
    netEl.textContent = formatCurrency(net);
    netEl.className   = 'tc-vwap-val ' + (net >= 0 ? 'pos-mtm-pos' : 'pos-mtm-neg');
  }
  set('bank-sales',  '+' + formatCurrency(salesProc));
  set('bank-buys',   '-' + formatCurrency(buyCost));
  set('bank-stonex', stonexZAR > 0 ? '-' + formatCurrency(stonexZAR) : '-$460K x ZAR');
}

// ─── DAILY SUMMARY TABLE (Image #2 style) ────────────────────────────────────

function renderDailySummary(goldDeals, silverDeals, goldExp, silverExp, goldInv, silverInv) {
  const tbody = document.getElementById('ds-tbody');
  if (!tbody) return;

  const isNumism = d => {
    const txt = ((d.silo || '') + (d.product_name || '') + (d.channel || '')).toLowerCase();
    return txt.includes('numism') || txt.includes('proof') || txt.includes('coin');
  };
  const gp = arr => arr.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  const goldBullionGP   = gp(goldDeals.filter(d => !isNumism(d)));
  const goldNumismGP    = gp(goldDeals.filter(d => isNumism(d)));
  const silverBullionGP = gp(silverDeals.filter(d => !isNumism(d)));
  const silverNumismGP  = gp(silverDeals.filter(d => isNumism(d)));
  const goldAlpha       = (goldExp   && goldExp.treasury_alpha)   || 0;
  const silverAlpha     = (silverExp && silverExp.treasury_alpha) || 0;
  const goldTreasuryPL  = goldAlpha;
  const groupPL = goldBullionGP + goldTreasuryPL + goldNumismGP
                + silverBullionGP + silverAlpha + silverNumismGP;

  const dailyTarget = parseFloat(document.getElementById('ds-daily-target')?.value || '202000') || 202000;
  const gpPct       = dailyTarget > 0 ? (groupPL / dailyTarget) * 100 : 0;
  const shortfall   = groupPL - dailyTarget;

  const fc  = v => v === 0 ? 'R0.00' : formatCurrency(v);
  const vc  = v => '<span style="color:' + (v < 0 ? 'var(--red)' : v > 0 ? 'var(--gold)' : 'var(--muted)') + '">' + fc(v) + '</span>';
  const sec = lbl => '<tr class="ds-section"><td colspan="4">' + lbl + '</td></tr>';
  const row = (lbl, v1, v2, v3, stub) =>
    '<tr class="ds-data' + (stub ? ' ds-stub' : '') + '"><td>' + lbl + '</td><td>' + (v1 || '') + '</td><td>' + (v2 || '') + '</td><td class="ds-val">' + vc(v3) + '</td></tr>';
  const tot = (lbl, v3) =>
    '<tr class="ds-total"><td>' + lbl + '</td><td></td><td></td><td class="ds-val">' + vc(v3) + '</td></tr>';
  const gtot = (lbl, v3) =>
    '<tr class="ds-group-total"><td>' + lbl + '</td><td></td><td></td><td class="ds-val">' + vc(v3) + '</td></tr>';
  const trk  = (lbl, pct, v3) =>
    '<tr class="ds-tracker"><td>' + lbl + '</td><td style="color:' + (pct < 50 ? 'var(--red)' : 'var(--muted)') + '">' + fmt(pct, 0) + '%</td><td></td><td class="ds-val">' + vc(v3) + '</td></tr>';

  const periodMap = { all: 'All Time', today: 'Today', yesterday: 'Yesterday', week: 'This Week', month: 'This Month', year: 'This Year', custom: 'Custom Period' };
  const titleEl = document.getElementById('ds-title');
  if (titleEl) titleEl.textContent = 'Daily Summary -- ' + (periodMap[filterMode] || 'All Time');

  tbody.innerHTML =
    '<tr class="ds-title-row"><td colspan="4">DAILY SUMMARY</td></tr>' +
    sec('GOLD BULLION') +
    row('Daily GP', '', '', goldBullionGP) +
    sec('GOLD TREASURY') +
    row('Bullion Treasury Alpha', fc(goldAlpha), 'R0.00', goldAlpha) +
    row('Market Impact Costs', '', '', 0, true) +
    row('Trading Fees', '-0.20%', 'AAM', 0, true) +
    row('Funding Costs', '--', 'AV Days/pm', 0, true) +
    row('Interest Earned on Free Equity', '', '', 0, true) +
    tot('Gold Treasury P&L', goldTreasuryPL) +
    sec('GOLD NUMISMATICS') +
    row('Dealing GP Tracker', '', '', goldNumismGP) +
    row('Proof Treasury Alpha', '', '', 0, true) +
    tot('Numismatics P&L', goldNumismGP) +
    sec('SILVER BULLION') +
    row('Daily GP', '', '', silverBullionGP) +
    sec('SILVER TREASURY') +
    row('Daily GP', '', '', silverAlpha) +
    sec('SILVER NUMISMATICS') +
    row('Daily GP', '', '', silverNumismGP) +
    sec('USDZAR HEDGE') +
    row('Daily Alpha', '', '', 0, true) +
    sec('SABI') +
    row('Gold Dealing GP',      '$0.00', 'R0.00', 0, true) +
    row('Gold Treasury Alpha',  '$0.00', 'R0.00', 0, true) +
    row('Silver Dealing GP',    '$0.00', 'R0.00', 0, true) +
    row('Silver Treasury Alpha','$0.00', 'R0.00', 0, true) +
    tot('SABI Daily GP', 0) +
    sec('OTHER') +
    row('Fisch Tool Sale', '', '', 0, true) +
    gtot('GROUP P&L', groupPL) +
    sec('DEALING GP TRACKER') +
    trk('Daily GP Tracker', gpPct, groupPL) +
    trk('Daily GP Target', 100, dailyTarget) +
    trk('Shortfall', gpPct - 100, shortfall);
}

// ─── HIGHLIGHTS OF THE DAY (Image #3 style) ───────────────────────────────────

function workingDaysInMonth(year, month) {
  let count = 0;
  const last = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function workingDaysUpTo(year, month, day) {
  let count = 0;
  for (let d = 1; d <= day; d++) {
    const dow = new Date(year, month, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function renderHighlights(goldDeals, silverDeals, goldExp, silverExp, goldInv, silverInv, monthlyGold, monthlySilver) {
  const el = document.getElementById('highlights-content');
  if (!el) return;

  const now      = new Date();
  const dateStr  = now.toLocaleDateString('en-ZA', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const monthNm  = now.toLocaleString('en-ZA', { month: 'long' }).toUpperCase();

  const isNumism = d => ((d.silo||'')+(d.product_name||'')+(d.channel||'')).toLowerCase().match(/numism|proof|coin/);
  const gp  = arr => arr.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);
  const fc  = v => v === 0 ? 'R0.00' : formatCurrency(v);
  const cls = v => v < 0 ? 'hl-neg' : v > 0 ? 'hl-pos' : '';
  const fp  = v => fmt(v, 2) + '%';

  function tradingStats(deals) {
    const buys  = deals.filter(d => d.deal_type === 'buy');
    const sells = deals.filter(d => d.deal_type === 'sell');
    const buyOz  = buys.reduce((s, d)  => s + (d.oz || 0), 0);
    const sellOz = sells.reduce((s, d) => s + (d.oz || 0), 0);
    const buyMgn  = buyOz  > 0 ? buys.reduce((s, d)  => s + (d.margin_pct||0)*(d.oz||0), 0) / buyOz  : 0;
    const sellMgn = sellOz > 0 ? sells.reduce((s, d) => s + (d.margin_pct||0)*(d.oz||0), 0) / sellOz : 0;
    const provActive = (goldInv.total_oz || 0) < 0;
    return { buyOz, sellOz, buyMgn, sellMgn, provActive };
  }

  const g = tradingStats(goldDeals);
  const s = tradingStats(silverDeals);
  const provTxt = g.provActive ? 'on a provision system.' : 'standard margin.';

  const isGS = d => (d.channel||'').toLowerCase().match(/goldstore|online/);
  const goldGSSells   = goldDeals.filter(d => d.deal_type === 'sell' && isGS(d));
  const silverGSSells = silverDeals.filter(d => d.deal_type === 'sell' && isGS(d));
  const totGSellOz    = goldDeals.filter(d => d.deal_type === 'sell').reduce((s,d) => s+(d.oz||0), 0);
  const totSSellOz    = silverDeals.filter(d => d.deal_type === 'sell').reduce((s,d) => s+(d.oz||0), 0);
  const goldGSOz      = goldGSSells.reduce((s,d) => s+(d.oz||0), 0);
  const silverGSOz    = silverGSSells.reduce((s,d) => s+(d.oz||0), 0);
  const goldGSPct     = totGSellOz > 0 ? (goldGSOz / totGSellOz) * 100 : 0;
  const silverGSPct   = totSSellOz > 0 ? (silverGSOz / totSSellOz) * 100 : 0;
  const goldGSGP      = gp(goldGSSells);
  const silverGSGP    = gp(silverGSSells);
  const totalGSGP     = goldGSGP + silverGSGP;

  const goldBullGP   = gp(goldDeals.filter(d => !isNumism(d)));
  const silBullGP    = gp(silverDeals.filter(d => !isNumism(d)));
  const silNumGP     = gp(silverDeals.filter(d => isNumism(d)));
  const goldAlpha    = (goldExp   && goldExp.treasury_alpha)   || 0;
  const silverAlpha  = (silverExp && silverExp.treasury_alpha) || 0;
  const netProfit    = goldBullGP + silBullGP + silNumGP + goldAlpha + silverAlpha;

  const totalTD    = workingDaysInMonth(now.getFullYear(), now.getMonth());
  const daysComp   = workingDaysUpTo(now.getFullYear(), now.getMonth(), now.getDate());
  const daysRem    = totalTD - daysComp;
  const daysCompP  = totalTD > 0 ? (daysComp / totalTD) * 100 : 0;
  const daysRemP   = totalTD > 0 ? (daysRem  / totalTD) * 100 : 0;

  const mTarget     = parseFloat(document.getElementById('ds-monthly-target')?.value || '4250000') || 4250000;
  const allMonthly  = [...(monthlyGold || goldDeals), ...(monthlySilver || silverDeals)];
  const mtdGP       = gp(allMonthly);
  const tAchPct     = mTarget > 0 ? (mtdGP / mTarget) * 100 : 0;
  const tShortfall  = mtdGP - mTarget;
  const tSFPct      = mTarget > 0 ? (tShortfall / mTarget) * 100 : 0;
  const initRR      = totalTD > 0 ? mTarget / totalTD : 0;
  const achRR       = daysComp > 0 ? mtdGP / daysComp : 0;
  const reqRR       = daysRem  > 0 ? (mTarget - mtdGP) / daysRem : 0;

  function hlRow(oz, metal, action, margin, prov) {
    if (oz <= 0) return '<div class="hl-row hl-empty">No ' + metal + ' ' + action + ' in this period.</div>';
    return '<div class="hl-row"><span class="hl-oz">' + fmt(oz,1) + '</span>&nbsp;' + metal +
      ' oz ' + action + ' at a VWAP of spot + <span class="hl-margin">' + fmt(margin,1) + '%</span>&nbsp;- ' + prov + '</div>';
  }

  el.innerHTML =
    '<div class="hl-section"><div class="hl-section-header">GOLD BULLION TRADING</div><div class="hl-trading-rows">' +
      hlRow(g.buyOz,  'Gold', 'bought back', g.buyMgn,  provTxt) +
      hlRow(g.sellOz, 'Gold', 'sold',        g.sellMgn, provTxt) +
    '</div></div>' +

    '<div class="hl-section"><div class="hl-section-header">SILVER BULLION TRADING</div><div class="hl-trading-rows">' +
      hlRow(s.buyOz,  'Silver', 'bought back', s.buyMgn,  provTxt) +
      hlRow(s.sellOz, 'Silver', 'sold',        s.sellMgn, provTxt) +
    '</div></div>' +

    '<div class="hl-section"><div class="hl-section-header">GOLDSTORE SALES STATS</div>' +
    '<table class="hl-stats-table">' +
      '<tr><td>Gold Oz Sold Online</td><td>' + fmt(goldGSOz,2) + '</td></tr>' +
      '<tr><td>Goldstore % of Total Gold Oz Sold</td><td>' + fp(goldGSPct) + '</td></tr>' +
      '<tr><td>Contribution to Daily Gold Sales GP</td><td class="' + cls(goldGSGP) + '">' + fc(goldGSGP) + '</td></tr>' +
      '<tr><td>Silver Oz Sold Online</td><td>' + fmt(silverGSOz,2) + '</td></tr>' +
      '<tr><td>Goldstore % of Total Silver Oz Sold</td><td>' + fp(silverGSPct) + '</td></tr>' +
      '<tr><td>Contribution to Daily Silver Sales GP</td><td class="' + cls(silverGSGP) + '">' + fc(silverGSGP) + '</td></tr>' +
      '<tr class="hl-stats-total"><td><strong>Goldstore Daily Total GP Contribution</strong></td><td class="' + cls(totalGSGP) + '"><strong>' + fc(totalGSGP) + '</strong></td></tr>' +
    '</table></div>' +

    '<div class="hl-section"><div class="hl-section-header">TRADING SUMMARY ' + dateStr + '</div>' +
    '<table class="hl-stats-table">' +
      '<tr><td>GP Gold</td><td class="' + cls(goldBullGP) + '">' + fc(goldBullGP) + '</td></tr>' +
      '<tr><td>Fisch Tool Sale GP</td><td>R0.00</td></tr>' +
      '<tr><td>GP Silver</td><td class="' + cls(silBullGP) + '">' + fc(silBullGP) + '</td></tr>' +
      '<tr><td>Platinum Sales GP</td><td>R0.00</td></tr>' +
      '<tr><td>Silver Numismatics GP</td><td class="' + cls(silNumGP) + '">' + fc(silNumGP) + '</td></tr>' +
      '<tr><td>Treasury Alpha</td><td class="' + cls(goldAlpha+silverAlpha) + '">' + fc(goldAlpha+silverAlpha) + '</td></tr>' +
      '<tr><td>MIC</td><td>R0.00</td></tr>' +
      '<tr><td>Trading Fees</td><td>R0.00</td></tr>' +
      '<tr><td>Funding Costs</td><td>R0.00</td></tr>' +
      '<tr><td>SABI GP</td><td>R0.00</td></tr>' +
      '<tr><td>SABGB</td><td>R0.00</td></tr>' +
      '<tr class="hl-stats-total"><td><strong>Net profit</strong></td><td class="' + cls(netProfit) + '"><strong>' + fc(netProfit) + '</strong></td></tr>' +
    '</table></div>' +

    '<div class="hl-section"><div class="hl-section-header">' + monthNm + ' KEY STATS &mdash; ' + fc(mTarget) + ' TARGET</div>' +
    '<table class="hl-stats-table">' +
      '<tr><td>' + monthNm + ' Target</td><td>' + fc(mTarget) + '</td></tr>' +
      '<tr><td>Month to Date Net GP</td><td class="' + cls(mtdGP) + '">' + fc(mtdGP) + '</td></tr>' +
      '<tr><td>Trading days complete</td><td>' + daysComp + '</td></tr>' +
      '<tr><td>Monthly Target Achieved</td><td class="' + cls(tAchPct-100) + '">' + fmt(tAchPct,0) + '%</td></tr>' +
      '<tr><td>Trading days complete %</td><td>' + fmt(daysCompP,0) + '%</td></tr>' +
      '<tr><td>Target Shortfall</td><td class="' + cls(tShortfall) + '">' + fc(tShortfall) + '</td></tr>' +
      '<tr><td>Monthly Target Shortfall</td><td class="' + cls(tSFPct) + '">' + fmt(tSFPct,0) + '%</td></tr>' +
      '<tr><td>Trading days remaining</td><td>' + daysRem + '</td></tr>' +
      '<tr><td>Trading days remaining %</td><td>' + fmt(daysRemP,0) + '%</td></tr>' +
    '</table></div>' +

    '<div class="hl-section"><div class="hl-section-header">' + monthNm + ' DAILY RUN RATES &mdash; ' + fc(mTarget) + '</div>' +
    '<table class="hl-stats-table">' +
      '<tr><td>Initial Required Run Rate</td><td>' + fc(initRR) + '</td></tr>' +
      '<tr><td>Run Rate Achieved</td><td class="' + cls(achRR - initRR) + '">' + fc(achRR) + '</td></tr>' +
      '<tr><td>Run Rate Required</td><td class="' + cls(reqRR <= achRR ? 1 : -1) + '">' + fc(reqRR) + '</td></tr>' +
    '</table></div>';

  const htEl = document.getElementById('highlights-title');
  if (htEl) htEl.textContent = 'Highlights of the Day -- ' + dateStr;
}

async function copyHighlights() {
  const el = document.getElementById('highlights-content');
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.innerText);
    showToast('Highlights copied to clipboard');
  } catch (e) {
    showToast('Select the content manually and copy', true);
  }
}

function printHighlights() {
  const el = document.getElementById('highlights-content');
  if (!el) return;
  const w = window.open('', '_blank');
  w.document.write('<html><head><title>Highlights of the Day</title><style>');
  w.document.write('body{font-family:Arial,sans-serif;font-size:13px;padding:20px;color:#111;max-width:700px}');
  w.document.write('table{width:100%;border-collapse:collapse}td{padding:5px 10px;border-bottom:1px solid #ddd}');
  w.document.write('.hl-section-header{background:#2a1a4a;color:#fff;font-weight:700;padding:7px 12px;margin:14px 0 4px;text-transform:uppercase;letter-spacing:1px}');
  w.document.write('.hl-trading-rows{padding:6px 12px}.hl-row{padding:4px 0}');
  w.document.write('.hl-oz{font-weight:700}.hl-margin{font-weight:700;color:#8B6914}');
  w.document.write('.hl-stats-total td{font-weight:700;border-top:2px solid #888}');
  w.document.write('.hl-neg{color:#c00}.hl-pos{color:#2a7a3a}.hl-empty{color:#999}');
  w.document.write('</style></head><body>');
  w.document.write(el.innerHTML);
  w.document.write('</body></html>');
  w.document.close();
  w.print();
}

// ─── FUNDING COSTS ───────────────────────────────────────────────────────────

function renderFundingCosts(data) {
  if (!data) return;
  const s  = data.summary || {};
  const fc = v => v === 0 ? 'R0.00' : formatCurrency(v);
  const cls = v => v < 0 ? 'color:var(--red)' : v > 0 ? 'color:var(--gold)' : '';

  set('fc-gold-swap',   fc(s.gold_swap_fees   || 0));
  set('fc-silver-swap', fc(s.silver_swap_fees || 0));
  set('fc-total-swap',  fc(s.total_swap_fees  || 0));
  set('fc-gold-int',    fc(s.gold_interest    || 0));
  set('fc-silver-int',  fc(s.silver_interest  || 0));
  set('fc-total-int',   fc(s.total_interest   || 0));

  const net    = s.net_funding_cost || 0;
  const netEl  = document.getElementById('fc-net');
  if (netEl) { netEl.textContent = fc(net); netEl.style = cls(net * -1); }

  const rows   = data.rows || [];
  set('fc-count', rows.length);
  const lbl = document.getElementById('fc-summary-label');
  if (lbl) lbl.textContent = `${rows.length} entr${rows.length !== 1 ? 'ies' : 'y'} in period`;

  const tbody = document.getElementById('fc-tbody');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;opacity:0.45;padding:18px">No funding costs logged for this period</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const isSwap = r.cost_type === 'swap_fee';
    const colour = isSwap ? 'var(--red)' : 'var(--green)';
    const typeLbl = isSwap ? 'Swap Fee' : 'Interest Earned';
    return `<tr>
      <td>${r.charge_date}</td>
      <td>${r.metal === 'gold' ? 'Gold' : 'Silver'}</td>
      <td>${r.platform || 'Stone X'}</td>
      <td style="color:${colour}">${typeLbl}</td>
      <td style="color:${colour};font-weight:600">${fc(r.amount_zar)}</td>
      <td style="opacity:0.65">${r.notes || '–'}</td>
      <td><button class="btn-close-pos" onclick="deleteFundingCost(${r.id})">✕</button></td>
    </tr>`;
  }).join('');
}

async function addFundingCost() {
  const metal    = document.getElementById('fc-metal')?.value;
  const platform = document.getElementById('fc-platform')?.value;
  const costType = document.getElementById('fc-type')?.value;
  const amount   = parseFloat(document.getElementById('fc-amount')?.value);
  const date_    = document.getElementById('fc-date')?.value?.trim();
  const notes    = document.getElementById('fc-notes')?.value?.trim() || '';

  if (!metal || !costType || isNaN(amount) || !date_) {
    alert('Please fill in metal, type, amount and date.');
    return;
  }

  // Swap fees stored as negative (cost); interest earned as positive
  const signedAmount = costType === 'swap_fee' ? -Math.abs(amount) : Math.abs(amount);

  await api('/api/funding-costs', {
    method: 'POST',
    json: {
      entity: currentEntity, metal, platform, cost_type: costType,
      amount_zar: signedAmount, charge_date: date_, notes,
    },
  });

  document.getElementById('fc-amount').value = '';
  document.getElementById('fc-date').value   = '';
  document.getElementById('fc-notes').value  = '';
  loadFundingCosts();
}

async function deleteFundingCost(id) {
  if (!confirm('Remove this funding cost entry?')) return;
  await api(`/api/funding-costs/${id}`, { method: 'DELETE' });
  loadFundingCosts();
}

async function loadFundingCosts() {
  const fq = filterFrom ? `&from=${filterFrom}` + (filterTo ? `&to=${filterTo}` : '') : '';
  const data = await api(`/api/funding-costs?entity=${currentEntity}${fq}`).catch(() => null);
  renderFundingCosts(data);
}
