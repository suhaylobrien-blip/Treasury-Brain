
// ─── GLOBAL TARGET TRACKER ────────────────────────────────────────────────────
// Shows on all tabs: realized period PNL vs daily target + monthly progress bar.

function renderTargetTracker(goldDeals, silverDeals, goldExp, silverExp, groupMtdGP) {
  const gp = arr => arr.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  // Period PNL = dealing GP + treasury alpha for current filter period
  const periodGP    = gp(goldDeals) + gp(silverDeals);
  const goldAlpha   = (goldExp   && goldExp.treasury_alpha)   || 0;
  const silverAlpha = (silverExp && silverExp.treasury_alpha) || 0;
  const periodPNL   = periodGP + goldAlpha + silverAlpha;

  // Group monthly figures
  const now = new Date();
  const mTarget    = parseFloat(document.getElementById('ds-monthly-target')?.value || '4250000') || 4250000;
  const totalTD    = workingDaysInMonth(now.getFullYear(), now.getMonth());
  const daysComp   = workingDaysUpTo(now.getFullYear(), now.getMonth(), now.getDate());
  const daysRem    = Math.max(1, totalTD - daysComp + 1); // include today
  const mtdGP      = typeof groupMtdGP === 'number' ? groupMtdGP : periodPNL;
  const dailyTgt   = Math.max(0, (mTarget - mtdGP) / daysRem);
  const remaining  = mTarget - mtdGP;
  const pct        = mTarget > 0 ? Math.min(100, (mtdGP / mTarget) * 100) : 0;
  const isOver     = mtdGP >= mTarget;
  const isBehind   = pct < (daysComp / totalTD) * 100 * 0.9; // 10% grace

  // Period label
  const periodMap = { all: 'All Time', today: 'Today', yesterday: 'Yesterday', week: 'This Week', month: 'This Month', year: 'This Year', custom: 'Custom' };
  const periodLabel = periodMap[filterMode] || 'All';
  const ttLbl = document.getElementById('tt-mtd-label');
  if (ttLbl) ttLbl.textContent = 'Group MTD GP (' + daysComp + ' of ' + totalTD + ' days)';

  // Period PNL
  const periodEl = document.getElementById('tt-period-pnl');
  if (periodEl) {
    periodEl.textContent = formatCurrency(periodPNL) + ' (' + periodLabel + ')';
    periodEl.className   = 'tt-val ' + (periodPNL >= 0 ? 'tt-pos' : 'tt-neg');
  }

  // Daily target (dynamic)
  const dtEl = document.getElementById('tt-daily-target');
  if (dtEl) {
    dtEl.textContent = formatCurrency(dailyTgt);
    dtEl.className   = 'tt-val ' + (periodPNL >= dailyTgt ? 'tt-pos' : 'tt-neg');
  }

  // MTD GP
  const mtdEl = document.getElementById('tt-mtd-gp');
  if (mtdEl) {
    mtdEl.textContent = formatCurrency(mtdGP);
    mtdEl.className   = 'tt-val ' + (mtdGP >= 0 ? 'tt-pos' : 'tt-neg');
  }

  // Remaining
  const remEl = document.getElementById('tt-remaining');
  if (remEl) {
    remEl.textContent = formatCurrency(remaining);
    remEl.className   = 'tt-val ' + (remaining <= 0 ? 'tt-pos' : 'tt-neg');
  }

  // Progress bar
  const barFill = document.getElementById('tt-bar-fill');
  if (barFill) {
    barFill.style.width = pct + '%';
    barFill.className   = 'tt-bar-fill' + (isOver ? ' tt-over' : isBehind ? ' tt-behind' : '');
  }

  const pctEl = document.getElementById('tt-pct-label');
  if (pctEl) pctEl.textContent = fmt(pct, 1) + '%';

  const tgtLbl = document.getElementById('tt-target-label');
  if (tgtLbl) tgtLbl.textContent = formatCurrency(mTarget);
}
