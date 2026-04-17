
// ─── GLOBAL TARGET TRACKER ────────────────────────────────────────────────────

// Working-day helpers
function workingDaysInMonth(y, m) {
  const days = new Date(y, m + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(y, m, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function workingDaysUpTo(y, m, day) {
  let count = 0;
  for (let d = 1; d <= day; d++) {
    const dow = new Date(y, m, d).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function workingDaysRemainingInWeek(today) {
  // Count Mon-Fri days from today (inclusive) to end of this week (Sunday)
  const dow = today.getDay(); // 0=Sun,1=Mon,...,6=Sat
  let count = 0;
  for (let d = dow; d <= 5; d++) { // up to Friday (5)
    if (d >= 1) count++;           // Monday (1) onwards
  }
  return Math.max(1, count);
}

function workingDaysInWeek(weekStartDate) {
  // Mon–Fri of the given week
  return 5;
}

function workingDaysRemainingInMonth(y, m, day) {
  const totalTD  = workingDaysInMonth(y, m);
  const daysComp = workingDaysUpTo(y, m, day);
  return Math.max(1, totalTD - daysComp + 1);
}

// ─── Period config: labels + rate scaling ─────────────────────────────────────

function getPeriodConfig(mode, now, mTarget, mtdGP) {
  const y   = now.getFullYear();
  const m   = now.getMonth();
  const day = now.getDate();

  const totalTD  = workingDaysInMonth(y, m);
  const daysComp = workingDaysUpTo(y, m, day);
  const daysRem  = workingDaysRemainingInMonth(y, m, day);
  const dailyReq = Math.max(0, (mTarget - mtdGP) / daysRem);

  switch (mode) {
    case 'today':
      return {
        periodLabel:   'Today',
        rateLabel:     'Req. Daily Rate',
        rateAmount:    dailyReq,
        dsTitle:       "Today's Summary",
        highlightsTitle: 'Highlights of the Day',
        dealsTitle:    "Today's Deals",
        pnlTitle:      "Today's PNL",
      };
    case 'yesterday':
      return {
        periodLabel:   'Yesterday',
        rateLabel:     'Req. Daily Rate',
        rateAmount:    dailyReq,
        dsTitle:       "Yesterday's Summary",
        highlightsTitle: "Yesterday's Highlights",
        dealsTitle:    "Yesterday's Deals",
        pnlTitle:      "Yesterday's PNL",
      };
    case 'week': {
      const weekDaysRem = workingDaysRemainingInWeek(now);
      return {
        periodLabel:   'This Week',
        rateLabel:     'Req. Weekly Rate',
        rateAmount:    dailyReq * 5,
        dsTitle:       'Weekly Summary',
        highlightsTitle: 'Highlights of the Week',
        dealsTitle:    "This Week's Deals",
        pnlTitle:      'Weekly PNL',
      };
    }
    case 'month':
      return {
        periodLabel:   'This Month',
        rateLabel:     'Req. Monthly Rate',
        rateAmount:    mTarget,
        dsTitle:       'Monthly Summary',
        highlightsTitle: 'Monthly Highlights',
        dealsTitle:    "This Month's Deals",
        pnlTitle:      'Monthly PNL',
      };
    case 'year':
      return {
        periodLabel:   'This Year',
        rateLabel:     'Req. Annual Rate',
        rateAmount:    mTarget * 12,
        dsTitle:       'Annual Summary',
        highlightsTitle: 'Annual Highlights',
        dealsTitle:    "This Year's Deals",
        pnlTitle:      'YTD PNL',
      };
    case 'custom':
      return {
        periodLabel:   'Custom Period',
        rateLabel:     'Req. Daily Rate',
        rateAmount:    dailyReq,
        dsTitle:       'Period Summary',
        highlightsTitle: 'Period Highlights',
        dealsTitle:    'Period Deals',
        pnlTitle:      'Period PNL',
      };
    default: // 'all'
      return {
        periodLabel:   'All Time',
        rateLabel:     'Req. Daily Rate',
        rateAmount:    dailyReq,
        dsTitle:       'Summary',
        highlightsTitle: 'Highlights',
        dealsTitle:    'All Deals',
        pnlTitle:      'Total PNL',
      };
  }
}

// ─── Update page headings globally ────────────────────────────────────────────
function applyPeriodHeadings(cfg) {
  const s = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  s('ds-title',         cfg.dsTitle);
  s('highlights-title', cfg.highlightsTitle);
  s('deals-heading',    cfg.dealsTitle);
  s('tt-rate-label',    cfg.rateLabel);
  s('filter-label',     cfg.periodLabel);
}

// ─── MAIN RENDER ──────────────────────────────────────────────────────────────
function renderTargetTracker(goldDeals, silverDeals, goldExp, silverExp, groupMtdGP) {
  const gp = arr => arr.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  const periodGP    = gp(goldDeals) + gp(silverDeals);
  const goldAlpha   = (goldExp   && goldExp.treasury_alpha)   || 0;
  const silverAlpha = (silverExp && silverExp.treasury_alpha) || 0;
  const periodPNL   = periodGP + goldAlpha + silverAlpha;

  const now      = new Date();
  const y        = now.getFullYear();
  const m        = now.getMonth();
  const day      = now.getDate();
  const mTarget  = parseFloat(document.getElementById('ds-monthly-target')?.value || '4250000') || 4250000;
  const totalTD  = workingDaysInMonth(y, m);
  const daysComp = workingDaysUpTo(y, m, day);
  const mtdGP    = typeof groupMtdGP === 'number' ? groupMtdGP : periodPNL;

  const cfg      = getPeriodConfig(filterMode, now, mTarget, mtdGP);

  // Apply all headings across the page
  applyPeriodHeadings(cfg);

  // Period PNL
  const periodEl = document.getElementById('tt-period-pnl');
  if (periodEl) {
    periodEl.textContent = formatCurrency(periodPNL) + ' (' + cfg.periodLabel + ')';
    periodEl.className   = 'tt-val ' + (periodPNL >= 0 ? 'tt-pos' : 'tt-neg');
  }

  // Rate (scaled to period)
  const dtEl = document.getElementById('tt-daily-target');
  if (dtEl) {
    dtEl.textContent = formatCurrency(cfg.rateAmount);
    dtEl.className   = 'tt-val ' + (periodPNL >= cfg.rateAmount ? 'tt-pos' : 'tt-neg');
  }

  // MTD GP label + value
  const ttLbl = document.getElementById('tt-mtd-label');
  if (ttLbl) ttLbl.textContent = 'Group MTD GP (' + daysComp + ' of ' + totalTD + ' days)';

  const mtdEl = document.getElementById('tt-mtd-gp');
  if (mtdEl) {
    mtdEl.textContent = formatCurrency(mtdGP);
    mtdEl.className   = 'tt-val ' + (mtdGP >= 0 ? 'tt-pos' : 'tt-neg');
  }

  // Remaining to monthly target
  const remaining = mTarget - mtdGP;
  const remEl = document.getElementById('tt-remaining');
  if (remEl) {
    remEl.textContent = formatCurrency(remaining);
    remEl.className   = 'tt-val ' + (remaining <= 0 ? 'tt-pos' : 'tt-neg');
  }

  // Progress bar (always monthly)
  const pct      = mTarget > 0 ? Math.min(100, (mtdGP / mTarget) * 100) : 0;
  const isOver   = mtdGP >= mTarget;
  const isBehind = pct < (daysComp / totalTD) * 100 * 0.9;
  const barFill  = document.getElementById('tt-bar-fill');
  if (barFill) {
    barFill.style.width = pct + '%';
    barFill.className   = 'tt-bar-fill' + (isOver ? ' tt-over' : isBehind ? ' tt-behind' : '');
  }

  const pctEl = document.getElementById('tt-pct-label');
  if (pctEl) pctEl.textContent = fmt(pct, 1) + '%';

  const tgtLbl = document.getElementById('tt-target-label');
  if (tgtLbl) tgtLbl.textContent = formatCurrency(mTarget);
}
