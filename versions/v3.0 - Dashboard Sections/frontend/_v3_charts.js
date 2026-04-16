
// ─── SUMMARY CHARTS ───────────────────────────────────────────────────────────

let summaryMetalChart, summaryTargetChart, summaryPnlChart;

function renderSummaryCharts(goldDeals, silverDeals, goldExp, silverExp) {
  const isNumism = d => ((d.silo||'')+(d.product_name||'')+(d.channel||'')).toLowerCase().match(/numism|proof|coin/);
  const gp = arr => arr.reduce((s, d) => s + (d.gp_contribution_zar || 0), 0);

  const goldBullGP   = gp(goldDeals.filter(d => !isNumism(d)));
  const goldNumGP    = gp(goldDeals.filter(d => isNumism(d)));
  const silBullGP    = gp(silverDeals.filter(d => !isNumism(d)));
  const silNumGP     = gp(silverDeals.filter(d => isNumism(d)));
  const goldAlpha    = (goldExp   && goldExp.treasury_alpha)   || 0;
  const silverAlpha  = (silverExp && silverExp.treasury_alpha) || 0;
  const combinedGP   = goldBullGP + goldNumGP + silBullGP + silNumGP;
  const combinedAlpha = goldAlpha + silverAlpha;
  const totalPNL     = combinedGP + combinedAlpha;

  const dailyTarget = parseFloat(document.getElementById('ds-daily-target')?.value || '202000') || 202000;

  const chartDefaults = {
    plugins: {
      legend: { labels: { color: 'rgba(240,238,248,0.6)', font: { size: 11 } } },
    },
    scales: {
      x: { ticks: { color: 'rgba(240,238,248,0.5)', font: { size: 10 } }, grid: { color: 'rgba(107,57,175,0.12)' } },
      y: { ticks: { color: 'rgba(240,238,248,0.5)', font: { size: 10 }, callback: v => 'R' + (v/1000).toFixed(0) + 'k' }, grid: { color: 'rgba(107,57,175,0.12)' } },
    },
    animation: { duration: 400 },
  };

  // ── Chart 1: GP by Metal (bar) ───────────────────────────────────
  const mc = document.getElementById('summary-metal-chart');
  if (mc) {
    if (summaryMetalChart) summaryMetalChart.destroy();
    summaryMetalChart = new Chart(mc, {
      type: 'bar',
      data: {
        labels: ['Gold Bullion', 'Gold Numism', 'Silver Bullion', 'Silver Numism', 'Gold Alpha', 'Silver Alpha'],
        datasets: [{
          label: 'GP (ZAR)',
          data: [goldBullGP, goldNumGP, silBullGP, silNumGP, goldAlpha, silverAlpha],
          backgroundColor: [
            'rgba(212,167,85,0.75)',
            'rgba(212,167,85,0.45)',
            'rgba(200,200,220,0.55)',
            'rgba(200,200,220,0.35)',
            'rgba(64,181,173,0.75)',
            'rgba(64,181,173,0.55)',
          ],
          borderRadius: 4,
        }],
      },
      options: { ...chartDefaults, plugins: { ...chartDefaults.plugins, legend: { display: false } } },
    });
  }

  // ── Chart 2: Daily GP vs Target (gauge-style doughnut) ───────────
  const tc = document.getElementById('summary-target-chart');
  if (tc) {
    if (summaryTargetChart) summaryTargetChart.destroy();
    const achieved = Math.max(0, Math.min(totalPNL, dailyTarget));
    const remaining = Math.max(0, dailyTarget - totalPNL);
    const over = totalPNL > dailyTarget ? totalPNL - dailyTarget : 0;
    summaryTargetChart = new Chart(tc, {
      type: 'doughnut',
      data: {
        labels: ['Achieved', 'Remaining', 'Over Target'],
        datasets: [{
          data: [achieved, remaining, over],
          backgroundColor: ['rgba(64,181,173,0.8)', 'rgba(107,57,175,0.25)', 'rgba(212,167,85,0.8)'],
          borderWidth: 0,
          circumference: 270,
          rotation: -135,
        }],
      },
      options: {
        cutout: '72%',
        plugins: {
          legend: { position: 'bottom', labels: { color: 'rgba(240,238,248,0.6)', font: { size: 10 }, boxWidth: 12 } },
          tooltip: { callbacks: { label: ctx => ' R' + (ctx.raw / 1000).toFixed(1) + 'k' } },
        },
        animation: { duration: 400 },
      },
      plugins: [{
        id: 'centerLabel',
        afterDraw(chart) {
          const { ctx, chartArea: { top, bottom, left, right } } = chart;
          const cx = (left + right) / 2;
          const cy = (top + bottom) / 2 + 10;
          ctx.save();
          ctx.font = 'bold 14px Helvetica Neue, Arial';
          ctx.fillStyle = totalPNL >= dailyTarget ? '#40B5AD' : '#D4A755';
          ctx.textAlign = 'center';
          ctx.fillText(Math.round((totalPNL / dailyTarget) * 100) + '%', cx, cy);
          ctx.font = '10px Helvetica Neue, Arial';
          ctx.fillStyle = 'rgba(240,238,248,0.5)';
          ctx.fillText('of target', cx, cy + 16);
          ctx.restore();
        },
      }],
    });
  }

  // ── Chart 3: Treasury Alpha vs Dealing GP (horizontal bar) ───────
  const pc = document.getElementById('summary-pnl-chart');
  if (pc) {
    if (summaryPnlChart) summaryPnlChart.destroy();
    summaryPnlChart = new Chart(pc, {
      type: 'bar',
      data: {
        labels: ['Gold GP', 'Silver GP', 'Gold Alpha', 'Silver Alpha', 'Combined PNL'],
        datasets: [{
          label: 'ZAR',
          data: [goldBullGP + goldNumGP, silBullGP + silNumGP, goldAlpha, silverAlpha, totalPNL],
          backgroundColor: [
            'rgba(212,167,85,0.7)',
            'rgba(200,200,220,0.5)',
            'rgba(64,181,173,0.7)',
            'rgba(64,181,173,0.5)',
            'rgba(123,79,201,0.8)',
          ],
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        ...chartDefaults,
        plugins: { ...chartDefaults.plugins, legend: { display: false } },
        scales: {
          x: { ...chartDefaults.scales.x },
          y: { ticks: { color: 'rgba(240,238,248,0.6)', font: { size: 10 } }, grid: { display: false } },
        },
      },
    });
  }
}
