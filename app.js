// 畫面：讀設定 → 抓資料 → 計算 → 畫圖與表格；選取的模型（方法 + k）會同步到圖表、表格與右側的模型細節
const $ = id => document.getElementById(id);
const charts = {};
const state = {
  header: null, rows: null, result: null, sel: null, model: null, inputs: {}, showAllResiduals: false,
  hidden: new Set(), excludedColumns: [], groupColumn: null, analysisRunId: 0, analysisBusy: false,
};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
// 圖表顏色依這裡的順序對應 --series-1..5，不隨顯示的方法數改變；point / glyph 是比較圖的點形狀與圖例符號
const METHODS = [
  { key: 'forward', name: 'Forward SFS', point: 'circle', glyph: '●' },
  { key: 'rfe', name: 'RFE（Backward）', point: 'triangle', glyph: '▲' },
  { key: 'lasso', name: 'Lasso', point: 'rect', glyph: '■' },
  { key: 'enet', name: 'ElasticNet', point: 'crossRot', glyph: '✕' },
  { key: 'exhaustive', name: 'Exhaustive', point: 'cross', glyph: '+' },
];
// 兩張圖各自的指標；below：最佳點的標籤放在點的下方（RMSE 的最佳點是最低點）
const METRICS = {
  rmse: { label: 'Test RMSE', fmt: fmtNum, below: true },
  r2: { label: 'Test R²', fmt: v => v.toFixed(4), below: false },
};
const RESIDUAL_ROWS = 10;

Chart.defaults.font.family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
Chart.defaults.font.size = 11;
// 網頁字型載入前畫的圖會用後備字型，載入後重畫一次
document.fonts?.ready.then(() => {
  if (state.result && !$('results').hidden) drawCharts();
});

$('data-url').value = resolveDataUrl(CONFIG.dataUrl);
$('test-ratio').value = Math.round(CONFIG.testRatio * 100);
$('seed').value = CONFIG.seed;
fillPresetSelect();
fillChoices('method', [...METHODS.map(m => [m.key, m.name]), ['all', '比較全部方法']], 'forward');

$('load-form').addEventListener('submit', e => {
  e.preventDefault();
  load();
});
$('preset').addEventListener('change', onPresetChange);
$('data-url').addEventListener('input', syncPreset);
for (const id of ['target', 'test-ratio', 'seed']) $(id).addEventListener('change', analyze);
$('method').addEventListener('change', onMethodChange);
$('back-to-best').addEventListener('click', () => {
  const b = modeBest();
  select(b.method, b.k);
});
$('copy-eq').addEventListener('click', copyEquation);
$('predict-inputs').addEventListener('input', onPredictInput);
$('resid-toggle').addEventListener('click', () => {
  state.showAllResiduals = !state.showAllResiduals;
  renderResiduals();
});
$('theme-toggle').addEventListener('click', toggleTheme);
darkQuery.addEventListener('change', onThemeChange);
updateThemeIcon();
load();

// ---------- 資料流程 ----------

// preferTarget：切換題目時指定的 target，優先於目前的選擇
async function load(preferTarget) {
  state.analysisRunId++;
  state.analysisBusy = false;
  $('results').classList.remove('is-loading');
  const url = $('data-url').value.trim();
  syncPreset();
  setBusy(true);
  try {
    const res = await fetch(url).catch(() => {
      throw new Error('無法下載資料。請確認網址正確，且伺服器允許跨來源（CORS）存取。');
    });
    if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}），請確認網址是否正確。`);
    const { header, rows } = parseCSV(await res.text());
    const preset = CONFIG.presets.find(p => sameDataUrl(p.dataUrl, url));
    state.groupColumn = preset?.groupColumn ?? null;
    state.excludedColumns = preset?.excludedColumns ?? [];
    fillTargets(header, rows, preferTarget, [...state.excludedColumns, ...(state.groupColumn ? [state.groupColumn] : [])]);
    Object.assign(state, { header, rows });
    const sourceUrl = preset?.sourceUrl ?? url;
    $('source-link').href = sourceUrl;
    $('source-link').textContent = preset?.sourceLabel ?? (decodeURIComponent(url.split('/').pop()) || url);
    $('source-credit').textContent = preset?.sourceUrl ? '' : '（自訂 CSV）';
    analyze();
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

// 選預設題目：帶入它的網址與 target 後重新載入；選「自訂」則交給使用者輸入網址
function onPresetChange() {
  const selected = $('preset').value;
  const p = CONFIG.presets[Number(selected)];
  if (!p) {
    $('data-url').value = '';
    $('data-url').focus();
    return;
  }
  $('data-url').value = resolveDataUrl(p.dataUrl);
  load(p.target);
}

// Relative preset paths and their resolved URL values identify the same dataset.
function syncPreset() {
  const i = CONFIG.presets.findIndex(p => sameDataUrl(p.dataUrl, $('data-url').value.trim()));
  $('preset').value = i < 0 ? 'custom' : String(i);
}

// target 只列數值欄；優先順序：題目指定的 target → 目前選擇 → CONFIG.target → 最後一個數值欄
function fillTargets(header, rows, preferTarget, excludedColumns = []) {
  const { isNum } = inspect(header, rows);
  const excluded = new Set(excludedColumns);
  const numeric = header.filter((h, c) => isNum[c] && !excluded.has(h));
  if (!numeric.length) throw new Error('資料中沒有數值欄位可當預測目標。');
  const current = [preferTarget, choice('target'), CONFIG.target].find(n => numeric.includes(n)) ?? numeric[numeric.length - 1];
  fillChoices('target', numeric.map(n => [n, n]), current);
}

// 五種方法一次算完：切換方法或比較全部時不必重算
async function analyze() {
  const runId = ++state.analysisRunId;
  if (!state.rows) return;
  const ratio = readInt('test-ratio', 5, 50, Math.round(CONFIG.testRatio * 100)) / 100;
  const seed = readInt('seed', 0, 4294967295, CONFIG.seed);
  const target = choice('target');
  try {
    const data = buildDataset(state.header, state.rows, target, state.excludedColumns, state.groupColumn);
    const split = data.groups
      ? trainTestSplitGroups(data.groups, ratio, seed)
      : trainTestSplit(data.y.length, ratio, seed);
    setStatus('loading', '在訓練集內執行 5-fold 交叉驗證…');
    state.analysisBusy = true;
    $('results').classList.add('is-loading');
    await new Promise(resolve => setTimeout(resolve, 0));
    if (runId !== state.analysisRunId) return;
    const pick = (a, idx) => idx.map(i => a[i]);
    const Xtr = pick(data.X, split.train), ytr = pick(data.y, split.train);
    const Xte = pick(data.X, split.test), yte = pick(data.y, split.test);
    const cols = independentFeatures(Xtr, ytr, data.names.length);
    if (!cols.length) throw new Error('訓練資料太少，無法擬合任何模型。');
    const methods = METHODS.map(m => m.key).filter(m => m !== 'exhaustive' || cols.length <= EXHAUSTIVE_MAX_P);
    const runs = {};
    for (const m of methods) {
      const steps = evaluateSubsets(SELECTORS[m](Xtr, ytr, cols), Xtr, ytr, Xte, yte);
      runs[m] = { steps };
    }
    const cvGroups = data.groups ? pick(data.groups, split.train) : null;
    const complete = await attachCrossValidatedMetrics(runs, methods, Xtr, ytr, cvGroups, seed, () => runId === state.analysisRunId);
    if (!complete || runId !== state.analysisRunId) return;
    state.result = { data, target, split, Xtr, ytr, Xte, yte, cols, methods, runs };
    state.inputs = {};
    syncMethodOptions();
    state.analysisBusy = false;
    $('results').classList.remove('is-loading');
    setStatus();
    render();
  } catch (err) {
    if (runId === state.analysisRunId) {
      state.analysisBusy = false;
      $('results').classList.remove('is-loading');
      showError(err.message);
    }
  }
}

// Rerun feature selection and OLS inside every training fold. Test-set scores
// are attached separately and are never used to choose k or a method.
async function attachCrossValidatedMetrics(runs, methods, X, y, groups, seed, isCurrent = () => true) {
  const foldCount = 5;
  const folds = makeFolds(y.length, foldCount, seed, groups);
  for (const method of methods) {
    const steps = runs[method].steps;
    const sums = new Array(steps.length).fill(0);
    const counts = new Array(steps.length).fill(0);
    for (const fold of folds) {
      const XfoldTrain = fold.train.map(i => X[i]), yfoldTrain = fold.train.map(i => y[i]);
      const XfoldValidation = fold.validation.map(i => X[i]), yfoldValidation = fold.validation.map(i => y[i]);
      const foldCols = independentFeatures(XfoldTrain, yfoldTrain, X[0].length);
      if (!foldCols.length) continue;
      const subsets = SELECTORS[method](XfoldTrain, yfoldTrain, foldCols);
      for (const subset of subsets) {
        const kIndex = subset.length - 1;
        if (kIndex < 0 || kIndex >= sums.length) continue;
        const fit = lstsq(design(XfoldTrain, subset), yfoldTrain);
        if (!fit) continue;
        const validationPredictions = predict(XfoldValidation, subset, fit.coef);
        sums[kIndex] += rmse(yfoldValidation, validationPredictions);
        counts[kIndex]++;
      }
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!isCurrent()) return false;
    }
    for (let i = 0; i < steps.length; i++) {
      steps[i].cvRmse = counts[i] === foldCount ? sums[i] / foldCount : null;
    }
    const eligible = steps.filter(step => Number.isFinite(step.cvRmse));
    if (!eligible.length) throw new Error(`${methodName(method)} 無法在所有 5 個 fold 中完成交叉驗證。`);
    runs[method].best = eligible.reduce((best, step) => step.cvRmse < best.cvRmse ? step : best);
  }
  return true;
}

// 特徵太多時 Exhaustive 停用；原本選它就改回 Forward SFS
function syncMethodOptions() {
  const ok = state.result.methods.includes('exhaustive');
  const input = $('method').querySelector('input[value="exhaustive"]');
  input.disabled = !ok;
  input.nextElementSibling.textContent = ok ? 'Exhaustive' : `Exhaustive（特徵超過 ${EXHAUSTIVE_MAX_P} 個時停用）`;
  if (!ok && input.checked) setChoice('method', 'forward');
}

// 讀取整數輸入框，超出範圍就夾回並寫回輸入框
function readInt(id, min, max, fallback) {
  const v = Math.round(Number($(id).value));
  const clamped = Number.isFinite(v) && $(id).value !== '' ? Math.min(max, Math.max(min, v)) : fallback;
  $(id).value = clamped;
  return clamped;
}

function onMethodChange() {
  if (!state.result || $('results').hidden) return;
  const b = modeBest();
  showModel(b.method, b.k);
  renderTable();
  drawCharts();
}

const isCompare = () => choice('method') === 'all';
const modeMethods = () => (isCompare() ? state.result.methods : [choice('method')]);
const methodName = key => METHODS.find(m => m.key === key).name;
const seriesVar = key => `--series-${METHODS.findIndex(m => m.key === key) + 1}`;
const stepOf = (method, k) => state.result.runs[method].steps.find(s => s.k === k);
// 不同方法選到同一組特徵時，RMSE 只差在浮點誤差，視為相同
const sameRmse = (a, b) => Math.abs(a - b) <= 1e-9 * Math.abs(b);

// 目前模式的最佳模型：以平均 5-fold CV RMSE 選 k 與方法；測試集只留作最終評估。
function modeBest() {
  let best = null;
  for (const m of modeMethods()) {
    const b = state.result.runs[m].best;
    if (!best || (b.cvRmse < best.cvRmse && !sameRmse(b.cvRmse, best.cvRmse))) best = { method: m, k: b.k, cvRmse: b.cvRmse };
  }
  return best;
}

function select(method, k) {
  showModel(method, k);
  markSelected();
  [charts.rmse, charts.r2].forEach(c => c?.draw());
}

// 切換選取的模型：算出它的統計量與測試集預測，更新右側的模型細節
function showModel(method, k) {
  const { Xtr, ytr, Xte, split, data } = state.result;
  const s = stepOf(method, k);
  state.sel = { method, k };
  const stats = olsSummary(Xtr, ytr, s.features);
  state.model = {
    ...s,
    method,
    stats,
    pred: predict(Xte, s.features, s.coef),
    intervals: predictionIntervals(Xte, s.features, s.coef, stats),
    assumptions: assumptionDiagnostics(Xtr, ytr, s.features, stats, split.train.map(i => data.ids[i])),
  };
  renderModel();
  renderCoefs();
  renderPredictor();
  renderResiduals();
  renderPredictionChart();
  renderAssumptions();
}

// ---------- 狀態 ----------

function setBusy(busy) {
  $('load-btn').disabled = busy;
  $('preset').disabled = busy;
  $('load-btn').textContent = busy ? '載入中…' : '載入資料';
  $('results').classList.toggle('is-loading', busy || state.analysisBusy);
  if (busy && $('results').hidden) setStatus('loading', '正在載入資料…');
}

function setStatus(kind = '', msg = '') {
  $('status').className = `status ${kind}`;
  $('status').textContent = msg;
  $('status').hidden = !kind;
}

function showError(msg) {
  setStatus('error', msg);
  $('results').hidden = true;
  $('hero').hidden = true;
  $('data-info').hidden = true;
}

// ---------- 畫面 ----------

function render() {
  renderDataInfo();
  const b = modeBest();
  showModel(b.method, b.k);
  renderTable();
  $('results').hidden = false;
  $('hero').hidden = false;
  drawCharts();
  renderPredictionChart();
  renderAssumptions();
}

function renderDataInfo() {
  const { data, target, split, cols } = state.result;
  const parts = [
    `${data.y.length} 筆有效資料`,
    `訓練 ${split.train.length} 筆`,
    `測試 ${split.test.length} 筆`,
    `候選特徵 ${data.names.length} 個`,
  ];
  if (data.dropped) parts.push(`略過 ${data.dropped} 筆缺值`);
  if (cols.length < data.names.length) parts.push(`${data.names.length - cols.length} 個特徵因線性相依未納入`);
  $('data-counts').textContent = parts.join(' · ');

  const encoded = new Map(data.encoded.map(e => [e.column, e]));
  $('column-list').replaceChildren(...state.header.map(h => {
    const e = encoded.get(h);
    const type = h === target ? '預測目標'
      : h === state.groupColumn ? '分組欄（不作特徵）'
      : state.excludedColumns.includes(h) ? '排除欄位（不作特徵）'
      : e ? `類別 → ${e.levels.length - 1} 個 dummy，基準 ${e.baseline}`
      : '數值';
    return el('li', h === target ? 'chip target' : 'chip', el('b', '', h), el('span', '', type));
  }));
  $('column-count').textContent = `${state.header.length} 欄`;
  $('n-total').textContent = data.y.length;
  $('n-features').textContent = `${data.names.length} 個候選特徵`;
  $('split-train').textContent = split.train.length;
  $('split-test').textContent = split.test.length;
  $('split-bar').style.width = `${(split.test.length / data.y.length) * 100}%`;
  const groupUnit = state.groupColumn === 'Country' ? '國' : '組';
  $('split-note').textContent = split.groupColumn
    ? `依 ${state.groupColumn} 分組：訓練 ${split.trainGroupCount} ${groupUnit}／測試 ${split.testGroupCount} ${groupUnit} · seed ${$('seed').value}`
    : `隨機切分 · 測試集 ${$('test-ratio').value}% · seed ${$('seed').value}`;
  $('data-info').hidden = false;
}

function renderModel() {
  const { data, target, ytr, yte, runs } = state.result;
  const s = state.model, { stats } = s;
  const best = modeBest();
  const isBest = best.method === s.method && best.k === s.k;
  const steps = runs[s.method].steps, full = steps[steps.length - 1];
  const label = `${methodName(s.method)}，k = ${s.k}`;

  $('model-title').textContent = isBest ? `最佳模型：${label}` : `${label} 的模型`;
  $('hero-sub').textContent = `CV RMSE ${fmtMaybe(s.cvRmse)} · 最終 Test RMSE ${fmtNum(s.rmse)} · 使用 ${s.k} / ${data.names.length} 個特徵`;
  $('back-to-best').hidden = isBest;
  $('back-to-best').textContent = `回到最佳：${methodName(best.method)}，k = ${best.k}`;

  $('m-rmse').textContent = fmtNum(s.rmse);
  $('m-r2').textContent = s.r2.toFixed(4);
  $('m-mae').textContent = fmtNum(mae(yte, s.pred));
  $('m-n-test').textContent = yte.length;
  $('m-adj').textContent = dash(stats.adjR2, v => v.toFixed(4));
  $('m-f').textContent = dash(stats.F, fmtNum);
  $('m-fp').textContent = fmtP(stats.Fp);
  $('m-n-train').textContent = ytr.length;
  $('m-df').textContent = stats.df;
  $('m-sigma').textContent = dash(stats.sigma, fmtCoef);
  $('m-k').textContent = `${s.k} / ${data.names.length}`;
  $('k-dots').replaceChildren(...data.names.map((_, i) => el('i', i < s.k ? 'on' : '')));
  // R² 可能為負，環形只畫 0–100% 的部分，文字照實顯示
  $('donut').style.setProperty('--p', Math.min(100, Math.max(0, s.r2 * 100)));
  $('donut-value').textContent = `${(s.r2 * 100).toFixed(1)}%`;
  $('donut').setAttribute('aria-label', `Test R² ${s.r2.toFixed(4)}`);
  $('m-vs-all-label').textContent = `RMSE 較全部 ${full.k} 個特徵`;
  if (s.k === full.k) {
    $('m-vs-all').textContent = '—';
  } else {
    setDelta($('m-vs-all'), ((s.rmse - full.rmse) / full.rmse) * 100, v => `${Math.abs(v).toFixed(1)}%`);
  }

  const [b0, ...bs] = s.coef;
  const terms = bs.map((b, i) => el('span', 'term',
    `${b < 0 ? '−' : '+'} `, el('b', '', fmtCoef(Math.abs(b))), ` × ${data.names[s.features[i]]}`));
  $('equation').replaceChildren(
    el('span', 'eq-target', target), ' = ', el('span', 'term', b0 < 0 ? '−' : '', el('b', '', fmtCoef(Math.abs(b0)))),
    ...terms.flatMap(t => [' ', t]),
  );
}

function renderTable() {
  const compare = isCompare();
  $('table-title').textContent = compare ? '各方法比較' : '每個 k 選到的特徵';
  if (compare) $('table-hint').textContent = '每格依序為 CV RMSE、Test RMSE、Test R²；最佳標記依 CV RMSE 選擇';
  else {
    $('table-hint').replaceChildren(
      el('span', 'key', el('i', 'in'), '已選入'),
      el('span', 'key', el('i', 'in new'), '比上一個 k 新加入'),
    );
  }
  $('steps').classList.toggle('compare', compare);
  $('steps').classList.toggle('matrix', !compare);
  if (compare) renderCompareTable();
  else renderStepsTable();
  markSelected();
}

function setHead(...cols) {
  $('steps-head').replaceChildren(el('tr', '', ...cols.map(([text, cls]) => {
    const th = el('th', cls, text);
    th.scope = 'col';
    return th;
  })));
}

// 特徵納入矩陣：列為 k、欄為特徵（依第一次被選入的順序排列），方塊標出每個 k 選到哪些特徵
function renderStepsTable() {
  const { data, runs } = state.result;
  const method = choice('method');
  const { steps, best } = runs[method];
  const order = [...new Set(steps.flatMap(s => s.features))];
  setHead(['k'], ['CV RMSE', 'num'], ['Test RMSE', 'num'], ['CV RMSE 差', 'num'], ['Test R²', 'num'], ...order.map(f => {
    const name = el('span', '', data.names[f]);
    name.title = data.names[f];
    return [name, 'fh'];
  }), ['', 'fill']);
  $('steps-body').replaceChildren(...steps.map((s, i) => {
    const k = el('td', 'k-cell', String(s.k));
    if (s === best) k.append(el('span', 'best-tag', '最佳'));
    k.append(el('span', 'sr', `，特徵：${s.features.map(f => data.names[f]).join('、')}`));
    const has = new Set(s.features), prev = new Set(i ? steps[i - 1].features : []);
    const marks = order.map(f => {
      const td = el('td', 'm', el('i', !has.has(f) ? '' : prev.has(f) ? 'in' : 'in new'));
      td.setAttribute('aria-hidden', 'true');
      return td;
    });
    const delta = el('td', 'num', '—');
    if (i && Number.isFinite(s.cvRmse) && Number.isFinite(steps[i - 1].cvRmse)) {
      setDelta(delta, s.cvRmse - steps[i - 1].cvRmse, v => fmtNum(Math.abs(v)));
    }

    const tr = el('tr', '', k, el('td', 'num', fmtMaybe(s.cvRmse)), el('td', 'num', fmtNum(s.rmse)), delta, el('td', 'num', s.r2.toFixed(4)), ...marks, el('td', 'fill'));
    tr.tabIndex = 0;
    tr.dataset.k = s.k;
    tr.addEventListener('click', () => select(method, s.k));
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(method, s.k);
      }
    });
    tr.addEventListener('mouseenter', () => peek(s.k));
    tr.addEventListener('focus', () => peek(s.k));
    tr.addEventListener('mouseleave', () => peek(null));
    tr.addEventListener('blur', () => peek(null));
    return tr;
  }));
}

// 比較表：主要數字為 CV RMSE；測試指標只供選模後參考。
function renderCompareTable() {
  const { runs, methods } = state.result;
  const best = modeBest();
  const maxK = Math.max(...methods.map(m => runs[m].steps[runs[m].steps.length - 1].k));
  setHead(['k'], ...methods.map(m => [methodName(m), 'num']));
  $('steps-body').replaceChildren(...Array.from({ length: maxK }, (_, i) => {
    const k = i + 1;
    const cells = methods.map(m => {
      const s = stepOf(m, k);
      if (!s) return el('td', 'num', '—');
      const btn = el('button', 'cell-btn',
        el('b', '', fmtMaybe(s.cvRmse)),
        el('span', '', `Test ${fmtNum(s.rmse)} · R² ${s.r2.toFixed(4)}`));
      const isBest = Number.isFinite(s.cvRmse) && sameRmse(s.cvRmse, best.cvRmse);
      if (isBest) btn.append(el('span', 'best-tag', '最佳'));
      btn.type = 'button';
      btn.setAttribute('aria-label', `${methodName(m)}，k = ${k}：CV RMSE ${fmtMaybe(s.cvRmse)}，Test RMSE ${fmtNum(s.rmse)}，R² ${s.r2.toFixed(4)}${isBest ? '，CV 最佳' : ''}`);
      btn.addEventListener('click', () => select(m, k));
      const td = el('td', s === runs[m].best ? 'num cell method-best' : 'num cell', btn);
      td.dataset.method = m;
      td.dataset.k = k;
      return td;
    });
    const tr = el('tr', '', el('td', 'k-cell', String(k)), ...cells);
    tr.addEventListener('mouseenter', () => peek(k));
    tr.addEventListener('focusin', () => peek(k));
    tr.addEventListener('mouseleave', () => peek(null));
    tr.addEventListener('focusout', () => peek(null));
    return tr;
  }));
}

function markSelected() {
  const { method, k } = state.sel;
  for (const tr of $('steps-body').rows) {
    if (isCompare()) {
      for (const td of tr.cells) {
        const on = td.dataset.method === method && Number(td.dataset.k) === k;
        td.classList.toggle('selected', on);
        const btn = td.querySelector('button');
        if (on) btn.setAttribute('aria-current', 'true');
        else btn?.removeAttribute('aria-current');
      }
      continue;
    }
    const on = Number(tr.dataset.k) === k;
    tr.classList.toggle('selected', on);
    if (on) tr.setAttribute('aria-current', 'true');
    else tr.removeAttribute('aria-current');
  }
}

// 滑過表格列時，在兩張圖上同步顯示該 k 的 tooltip（比較模式會列出每個方法）
function peek(k) {
  for (const c of [charts.rmse, charts.r2]) {
    if (!c) continue;
    const active = k == null ? [] : c.data.datasets
      .map((ds, d) => ({ datasetIndex: d, index: k - 1 }))
      .filter(a => c.isDatasetVisible(a.datasetIndex) && c.data.datasets[a.datasetIndex].data[a.index] != null);
    c.setActiveElements(active);
    c.tooltip.setActiveElements(active, { x: 0, y: 0 });
    c.update('none');
  }
}

function renderCoefs() {
  const { data } = state.result;
  const { features, stats } = state.model;
  $('coef-body').replaceChildren(...stats.terms.map((t, i) => {
    const name = el('th', '', i ? data.names[features[i - 1]] : '截距（Intercept）');
    name.scope = 'row';
    const p = el('td', 'num', fmtP(t.p));
    const stars = t.p < 0.001 ? '***' : t.p < 0.01 ? '**' : t.p < 0.05 ? '*' : '';
    p.append(el('span', 'sig', stars));
    const vif = el('td', 'num', t.vif == null ? '—' : dash(t.vif, v => v.toFixed(2)));
    if (t.vif >= 5) vif.prepend(el('span', 'flag', '偏高'));
    return el('tr', '', name,
      el('td', 'num', fmtSigned(t.coef)),
      el('td', 'num', dash(t.se, fmtCoef)),
      el('td', 'num', dash(t.t, v => fmtSigned(v, x => x.toFixed(3)))),
      p,
      el('td', 'num', Number.isFinite(t.lo) ? `[${fmtSigned(t.lo)}, ${fmtSigned(t.hi)}]` : '—'),
      vif);
  }));
}

// 即時預測：模型用到的每個原始欄位一個輸入（數值用滑桿 + 數字框、類別用膠囊按鈕）；輸入值在切換模型時保留
function renderPredictor() {
  const { data, target, Xtr } = state.result;
  const used = new Set(state.model.features.map(f => data.sources[f].column));
  const encoded = new Map(data.encoded.map(e => [e.column, e]));
  $('predict-inputs').replaceChildren(...state.header.filter(h => used.has(h)).map((h, n) => {
    const id = `predict-${n}`;
    const enc = encoded.get(h);
    if (enc) {
      if (!enc.levels.includes(state.inputs[h])) state.inputs[h] = enc.baseline;
      const label = el('span', 'field-label', h);
      label.id = `${id}-label`;
      const group = el('div', 'seg-options');
      group.id = id;
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', label.id);
      group.append(...enc.levels.map(lv => choiceChip(id, lv, lv === enc.baseline ? `${lv}（基準）` : lv, lv === state.inputs[h])));
      for (const input of group.querySelectorAll('input')) input.dataset.column = h;
      return el('div', 'predict-field', label, group);
    }
    const label = el('label', 'field-label', h);
    label.htmlFor = id;
    const vals = column(Xtr, data.sources.findIndex(s => s.column === h));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const step = sliderStep(vals, lo, hi);
    if (!(h in state.inputs)) state.inputs[h] = roundTo(mean(vals), step);
    const range = el('input');
    Object.assign(range, { type: 'range', min: roundTo(Math.floor(lo / step) * step, step), max: roundTo(Math.ceil(hi / step) * step, step), step, value: state.inputs[h] });
    range.dataset.column = h;
    range.setAttribute('aria-label', `${h} 滑桿`);
    const num = el('input');
    Object.assign(num, { type: 'number', id, step: 'any', value: state.inputs[h] });
    Object.assign(num.dataset, { column: h, lo, hi });
    return el('div', 'predict-field', label, el('div', 'predict-row', range, num));
  }));
  $('predict-label').textContent = `${target} 預測值`;
  updatePrediction();
}

// 滑桿約分成 200 段，步長取 10 的次方；整數欄步長至少為 1
function sliderStep(vals, lo, hi) {
  const step = hi > lo ? 10 ** Math.floor(Math.log10((hi - lo) / 200)) : 1;
  return vals.every(Number.isInteger) ? Math.max(1, step) : step;
}

function roundTo(v, step) {
  return Number((Math.round(v / step) * step).toPrecision(12));
}

// 同一欄的滑桿與數字框互相同步
function onPredictInput(e) {
  const h = e.target.dataset.column;
  if (h == null) return;
  state.inputs[h] = e.target.value;
  if (e.target.value !== '') {
    for (const node of $('predict-inputs').querySelectorAll('input[type="range"], input[type="number"]')) {
      if (node !== e.target && node.dataset.column === h) node.value = e.target.value;
    }
  }
  updatePrediction();
}

function updatePrediction() {
  const { data } = state.result;
  const { method, k, features, coef, stats } = state.model;
  const x0 = [1];
  features.forEach(f => {
    const { column: h, level } = data.sources[f];
    const v = state.inputs[h];
    x0.push(level == null ? (v === '' ? NaN : Number(v)) : v === level ? 1 : 0);
  });
  const interval = predictionIntervalForRow(x0, coef, stats);
  const outside = [...$('predict-inputs').querySelectorAll('input[type="number"]')]
    .some(n => n.value !== '' && (Number(n.value) < Number(n.dataset.lo) || Number(n.value) > Number(n.dataset.hi)));
  $('predict-value').textContent = dash(interval.yhat, v => fmtSigned(v, fmtNum));
  $('predict-interval').textContent = Number.isFinite(interval.piLower)
    ? `95% CI（平均反應）：[${fmtSigned(interval.ciLower, fmtNum)}, ${fmtSigned(interval.ciUpper, fmtNum)}] · 95% PI（單筆新樣本）：[${fmtSigned(interval.piLower, fmtNum)}, ${fmtSigned(interval.piUpper, fmtNum)}]`
    : '目前輸入無法計算信賴區間與預測區間。';
  $('predict-note').textContent = `以「${methodName(method)}，k = ${k}」的模型計算`
    + (outside ? '；有輸入超出訓練資料範圍，屬於外插，預測較不可靠' : '');
}

function renderPredictionChart() {
  const { yte } = state.result;
  const { pred, intervals } = state.model;
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const ordered = yte.map((actual, i) => ({ actual, predicted: pred[i], interval: intervals[i], i }))
    .sort((a, b) => a.predicted - b.predicted);
  const labels = ordered.map((_, i) => String(i + 1));
  const transparent = 'rgba(0, 0, 0, 0)';
  const piWash = color('--accent-wash');
  const ciWash = color('--ci-wash');
  const ciInk = color('--ci-ink');
  const upper = (label, key, border = transparent) => ({
    label, data: ordered.map(row => row.interval[key]),
    borderColor: border, backgroundColor: transparent, pointRadius: 0,
    borderWidth: border === transparent ? 0 : 1.5, fill: false, tension: 0,
  });
  const lower = (label, key, target, wash, border = transparent) => ({
    label, data: ordered.map(row => row.interval[key]),
    borderColor: border, backgroundColor: transparent, pointRadius: 0,
    borderWidth: border === transparent ? 0 : 1.5, fill: { target, above: wash, below: wash }, tension: 0,
  });
  const chartData = [
    upper('PI upper', 'piUpper'),
    lower('95% PI', 'piLower', 0, piWash),
    upper('CI upper', 'ciUpper', ciInk),
    lower('95% CI', 'ciLower', 2, ciWash, ciInk),
    {
      label: '預測值', data: ordered.map(row => row.predicted),
      borderColor: color('--accent'), backgroundColor: color('--accent'),
      borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: false, tension: 0.08,
    },
    {
      label: '實際值（PI 內）', data: ordered.map(row => row.actual >= row.interval.piLower && row.actual <= row.interval.piUpper ? row.actual : null),
      showLine: false, borderColor: color('--series-2'), backgroundColor: color('--series-2'),
      pointRadius: 3, pointHoverRadius: 5,
    },
    {
      label: '實際值（PI 外）', data: ordered.map(row => row.actual < row.interval.piLower || row.actual > row.interval.piUpper ? row.actual : null),
      showLine: false, borderColor: color('--inner'), backgroundColor: color('--outlier'),
      pointStyle: 'triangle', pointBorderWidth: 2.5,
      pointRadius: 6, pointHoverRadius: 8,
    },
  ];
  const inside = ordered.filter(row => row.actual >= row.interval.piLower && row.actual <= row.interval.piUpper).length;
  const piWidth = intervals.map(row => row.piUpper - row.piLower);
  const ciWidth = intervals.map(row => row.ciUpper - row.ciLower);
  $('pi-coverage').textContent = `${(100 * inside / yte.length).toFixed(1)}%`;
  $('pi-width').textContent = `${fmtNum(mean(piWidth))}`;
  $('ci-width').textContent = `${fmtNum(mean(ciWidth))}`;

  charts.prediction?.destroy();
  charts.prediction = new Chart($('prediction-chart'), {
    type: 'line',
    data: { labels, datasets: chartData },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: color('--solid'),
          titleColor: color('--muted'), bodyColor: color('--on-solid'),
          filter: item => item.datasetIndex >= 4 && item.parsed.y != null,
          callbacks: {
            title: items => `預測值排序第 ${items[0].label} 筆`,
            label: item => `${item.dataset.label}：${fmtNum(item.parsed.y)}`,
            afterBody: items => {
              if (!items.length) return '';
              const row = ordered[items[0].dataIndex].interval;
              return [`95% CI：[${fmtNum(row.ciLower)}, ${fmtNum(row.ciUpper)}]`, `95% PI：[${fmtNum(row.piLower)}, ${fmtNum(row.piUpper)}]`];
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: '測試樣本（依預測值排序）', color: color('--text-2') },
          grid: { display: false }, border: { display: false },
          ticks: { color: color('--text-2'), maxTicksLimit: 12 },
        },
        y: {
          title: { display: true, text: state.result.target, color: color('--text-2') },
          grid: { color: color('--line') }, border: { display: false },
          ticks: { color: color('--text-2'), padding: 8 },
        },
      },
    },
  });
}

function renderAssumptions() {
  const { data } = state.result;
  const diagnostics = state.model.assumptions;
  const results = [
    {
      title: '線性',
      stat: `二次趨勢 F = ${fmtStat(diagnostics.linearity.f)} · p = ${fmtP(diagnostics.linearity.p)}`,
      ok: diagnostics.linearity.p >= 0.05,
      detail: diagnostics.linearity.p >= 0.05
        ? '未發現明顯的殘差曲線趨勢；仍請搭配左側殘差圖判讀。'
        : '殘差仍呈現顯著曲線趨勢，線性形式可能不足。',
    },
    {
      title: '誤差獨立',
      stat: `Durbin–Watson = ${fmtStat(diagnostics.durbinWatson)} · 參考範圍 1.5–2.5`,
      ok: diagnostics.durbinWatson >= 1.5 && diagnostics.durbinWatson <= 2.5,
      detail: diagnostics.durbinWatson < 1.5
        ? '相鄰列殘差有正自相關跡象；DW 約 2 才接近無自相關。'
        : diagnostics.durbinWatson > 2.5
          ? '相鄰列殘差有負自相關跡象；DW 約 2 才接近無自相關。'
          : '未見明顯的一階自相關；DW 是依原始列序計算，需考慮資料排序方式。',
    },
    {
      title: '等變異',
      stat: `Breusch–Pagan F(${diagnostics.breuschPagan.df1}, ${diagnostics.breuschPagan.df2}) = ${fmtStat(diagnostics.breuschPagan.f)} · p = ${fmtP(diagnostics.breuschPagan.p)}`,
      ok: diagnostics.breuschPagan.p >= 0.05,
      detail: diagnostics.breuschPagan.p >= 0.05
        ? '未發現殘差變異隨特徵改變的明顯證據。'
        : '殘差變異可能隨特徵改變，標準誤與區間推論需謹慎。',
    },
    {
      title: '常態',
      stat: `Jarque–Bera = ${fmtStat(diagnostics.jarqueBera.statistic)} · p = ${fmtP(diagnostics.jarqueBera.p)} · 偏態 = ${fmtStat(diagnostics.jarqueBera.skewness)} · 峰度 = ${fmtStat(diagnostics.jarqueBera.kurtosis)}`,
      ok: diagnostics.jarqueBera.p >= 0.05,
      detail: diagnostics.jarqueBera.p >= 0.05
        ? '未拒絕殘差常態分布；也請檢視右側 Q–Q 圖。'
        : '殘差偏離常態的證據明顯；Q–Q 圖可查看偏離位置與尾部。',
    },
    {
      title: '無多重共線性',
      stat: `最大 VIF = ${fmtStat(diagnostics.maxVif?.vif)} · ${diagnostics.maxVif ? data.names[diagnostics.maxVif.feature] : '無特徵'} · 門檻 < 5`,
      ok: diagnostics.maxVif?.vif < 5,
      detail: diagnostics.maxVif?.vif < 5
        ? '目前模型中各特徵的 VIF 均低於 5。'
        : '最大 VIF 達到或超過 5，相關係數估計可能不穩。',
    },
  ];
  $('assumption-results').replaceChildren(...results.map(result => {
    const badge = el('span', `assumption-badge ${result.ok ? 'pass' : 'warn'}`, result.ok ? '✓ 符合' : '⚠ 違反');
    const top = el('div', 'assumption-result-top', el('b', '', result.title), badge);
    return el('article', `assumption-result ${result.ok ? 'pass' : 'warn'}`,
      top,
      el('p', 'assumption-stat', result.stat),
      el('p', 'label', result.detail));
  }));

  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const residualPoints = diagnostics.orderedResiduals.map(row => ({ x: row.fitted, y: row.residual, id: row.id }));
  const xValues = residualPoints.map(point => point.x);
  const xMin = Math.min(...xValues), xMax = Math.max(...xValues);
  const yAbs = Math.max(...residualPoints.map(point => Math.abs(point.y))) || 1;
  charts.assumptionResidual?.destroy();
  charts.assumptionResidual = new Chart($('assumption-resid-chart'), {
    type: 'scatter',
    data: { datasets: [
      { label: '訓練集殘差', data: residualPoints, backgroundColor: color('--series-2'), borderColor: color('--series-2'), pointRadius: 2.5, pointHoverRadius: 4 },
      { label: 'y = 0', data: [{ x: xMin, y: 0 }, { x: xMax, y: 0 }], type: 'line', borderColor: color('--accent'), borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, fill: false },
    ] },
    options: assumptionChartOptions(color, {
      x: { title: { display: true, text: '預測值' } },
      y: { min: -yAbs * 1.05, max: yAbs * 1.05, title: { display: true, text: '殘差' } },
    }, point => `原始列 ${point.raw.id}`),
  });

  const qq = diagnostics.qqPoints;
  const qqAbs = Math.max(...qq.map(point => Math.max(Math.abs(point.x), Math.abs(point.y)))) || 1;
  charts.assumptionQQ?.destroy();
  charts.assumptionQQ = new Chart($('assumption-qq-chart'), {
    type: 'scatter',
    data: { datasets: [
      { label: '殘差分位數', data: qq, backgroundColor: color('--series-2'), borderColor: color('--series-2'), pointRadius: 2.5, pointHoverRadius: 4 },
      { label: '常態參考線', data: [{ x: -qqAbs, y: -qqAbs }, { x: qqAbs, y: qqAbs }], type: 'line', borderColor: color('--accent'), borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, fill: false },
    ] },
    options: assumptionChartOptions(color, {
      x: { min: -qqAbs, max: qqAbs, title: { display: true, text: '常態理論分位數' } },
      y: { min: -qqAbs, max: qqAbs, title: { display: true, text: '標準化殘差分位數' } },
    }),
  });
}

function assumptionChartOptions(color, axisTitles, tooltipTitle = null) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: color('--solid'), titleColor: color('--muted'), bodyColor: color('--on-solid'),
        callbacks: { title: items => tooltipTitle ? tooltipTitle(items[0]) : '常態 Q–Q 圖' },
      },
    },
    scales: {
      x: { type: 'linear', grid: { color: color('--line') }, border: { display: false }, ticks: { color: color('--text-2') }, title: { color: color('--text-2'), ...axisTitles.x.title } },
      y: { type: 'linear', grid: { color: color('--line') }, border: { display: false }, ticks: { color: color('--text-2') }, title: { color: color('--text-2'), ...axisTitles.y.title }, ...(axisTitles.y.min != null ? { min: axisTitles.y.min, max: axisTitles.y.max } : {}) },
    },
  };
}

// 測試集殘差（實際 − 預測）依 |殘差| 排序；|殘差| > 2σ̂（訓練集殘差標準誤）標為高殘差
function renderResiduals() {
  const { data, split, yte } = state.result;
  const { pred, stats } = state.model;
  const limit = 2 * stats.sigma;
  const rows = yte.map((y, i) => ({ id: data.ids[split.test[i]] + 1, y, p: pred[i], r: y - pred[i] }))
    .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const high = rows.filter(r => Math.abs(r.r) > limit).length;
  $('resid-count').hidden = !high;
  $('resid-count').textContent = `${high} 筆高殘差`;

  // 殘差條碼依測試集原本順序，高度以 max(|殘差|, 2σ̂) 為滿格
  const resid = yte.map((y, i) => y - pred[i]);
  const scale = Math.max(...resid.map(Math.abs), Number.isFinite(limit) ? limit : 0) || 1;
  $('resid-strip').style.setProperty('--t', Number.isFinite(limit) ? (limit / scale) * 100 : 200);
  $('resid-strip').setAttribute('aria-label', `${resid.length} 筆測試集殘差的分布，詳見下表`);
  $('resid-strip').replaceChildren(...resid.map(r => {
    const bar = el('i', `${r >= 0 ? 'up' : 'down'}${Math.abs(r) > limit ? ' high' : ''}`);
    bar.style.setProperty('--h', (Math.abs(r) / scale) * 100);
    return bar;
  }));
  $('resid-note').textContent = Number.isFinite(limit)
    ? `依 |殘差| 由大到小排序；|殘差| > 2σ̂ = ${fmtCoef(limit)} 標為高殘差，共 ${high} 筆`
    : '依 |殘差| 由大到小排序';
  const shown = state.showAllResiduals ? rows : rows.slice(0, RESIDUAL_ROWS);
  $('resid-body').replaceChildren(...shown.map((r, i) => {
    const isHigh = Math.abs(r.r) > limit;
    return el('tr', isHigh ? 'high' : '',
      el('td', 'num', String(i + 1)),
      el('td', '', `第 ${r.id} 筆`),
      el('td', 'num', fmtSigned(r.y, fmtNum)),
      el('td', 'num', fmtSigned(r.p, fmtNum)),
      el('td', 'num', `${r.r > 0 ? '+' : ''}${fmtSigned(r.r, fmtNum)}`),
      el('td', 'num', r.y ? `${Math.abs((r.r / r.y) * 100).toFixed(1)}%` : '—'),
      el('td', '', isHigh ? el('span', 'flag', '高殘差') : el('span', 'muted', '正常')));
  }));
  $('resid-toggle').hidden = rows.length <= RESIDUAL_ROWS;
  $('resid-toggle').textContent = state.showAllResiduals ? `只顯示前 ${RESIDUAL_ROWS} 筆` : `顯示全部 ${rows.length} 筆`;
}

// RMSE 變化：▼ 下降、▲ 上升
function setDelta(node, d, fmt) {
  node.textContent = `${d < 0 ? '▼ ' : d > 0 ? '▲ ' : ''}${fmt(d)}`;
}

async function copyEquation() {
  const btn = $('copy-eq');
  try {
    await navigator.clipboard.writeText($('equation').textContent);
    btn.textContent = '已複製';
  } catch {
    btn.textContent = '複製失敗';
  }
  setTimeout(() => (btn.textContent = '複製'), 1500);
}

// ---------- 圖表 ----------

// 比較模式的圖例：每個方法一個膠囊開關（核取方塊），兩張圖一起切換它的顯示（重畫後仍保留）
function renderLegend(series) {
  $('legend').hidden = !isCompare();
  $('legend').replaceChildren(...series.map((m, d) => {
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !state.hidden.has(m);
    box.addEventListener('change', () => {
      if (box.checked) state.hidden.delete(m);
      else state.hidden.add(m);
      for (const c of Object.values(charts)) {
        c.data.datasets.forEach((dataset, index) => {
          if (dataset.methodKey === m) c.setDatasetVisibility(index, box.checked);
        });
        c.update();
      }
    });
    const swatch = el('span', 'swatch', METHODS.find(x => x.key === m).glyph);
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.setProperty('--c', `var(${seriesVar(m)})`);
    return el('label', 'chip-toggle', box, swatch, methodName(m));
  }));
}

function drawCharts() {
  const { data, runs } = state.result;
  const css = getComputedStyle(document.documentElement);
  const color = v => css.getPropertyValue(v).trim();
  const compare = isCompare();
  const series = modeMethods();
  const maxK = Math.max(...series.map(m => runs[m].steps[runs[m].steps.length - 1].k));
  const labels = Array.from({ length: maxK }, (_, i) => i + 1);
  const best = modeBest();
  const bestSeries = series.indexOf(best.method), bestIdx = best.k - 1;
  const ties = series.filter(m => sameRmse(runs[m].best.cvRmse, best.cvRmse)).length;
  const bestText = !compare ? `CV 最佳 k = ${best.k}`
    : ties > 1 ? `CV 最佳 k = ${best.k}（${ties} 個方法相同）`
    : `CV 最佳：${methodName(best.method)} k = ${best.k}`;
  renderLegend(series);

  for (const [key, { label, fmt, below }] of Object.entries(METRICS)) {
    charts[key]?.destroy();
    // Test curves remain visible as reference; CV curves determine the best k and method.
    const testDatasets = series.map((m, d) => {
      const c = color(compare ? seriesVar(m) : '--accent');
      const shape = compare ? METHODS.find(x => x.key === m).point : 'circle';
      return {
        methodKey: m,
        metric: key,
        label: compare ? `${methodName(m)} · Test ${label}（參考）` : `Test ${label}（僅供參考）`,
        data: labels.map(k => stepOf(m, k)?.[key] ?? null),
        hidden: compare && state.hidden.has(m),
        borderColor: c,
        backgroundColor: c,
        borderWidth: 2,
        cubicInterpolationMode: 'monotone',
        pointStyle: shape,
        pointRadius: compare ? 3.5 : 4,
        pointHoverRadius: 6,
        pointHitRadius: 12,
        pointBackgroundColor: c,
        pointBorderColor: c,
        pointBorderWidth: 1.5,
      };
    });
    const cvDatasets = key === 'rmse' ? series.map(m => {
      const c = color(compare ? seriesVar(m) : '--accent');
      return {
        methodKey: m,
        metric: 'cvRmse',
        label: compare ? `${methodName(m)} · 5-fold CV RMSE` : '5-fold CV RMSE（用於選模）',
        data: labels.map(k => stepOf(m, k)?.cvRmse ?? null),
        hidden: compare && state.hidden.has(m),
        borderColor: c,
        backgroundColor: c,
        borderWidth: 2.5,
        borderDash: [7, 4],
        cubicInterpolationMode: 'monotone',
        pointStyle: 'circle',
        pointRadius: labels.map((_, i) => (m === best.method && i === bestIdx ? 7 : compare ? 3 : 3.5)),
        pointHoverRadius: 7,
        pointHitRadius: 12,
        pointBackgroundColor: labels.map((_, i) => (m === best.method && i === bestIdx ? color('--solid') : c)),
        pointBorderColor: labels.map((_, i) => (m === best.method && i === bestIdx ? color('--inner') : c)),
        pointBorderWidth: labels.map((_, i) => (m === best.method && i === bestIdx ? 3 : 1.5)),
      };
    }) : [];
    const datasets = [...testDatasets, ...cvDatasets];
    const markerSeries = key === 'rmse' ? series.length + bestSeries : bestSeries;
    charts[key] = new Chart($(`${key}-chart`), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: { padding: { top: 32, right: 8 } },
        interaction: { mode: 'index', intersect: false },
        onClick(evt, _, chart) {
          const mode = compare ? 'nearest' : 'index';
          const [hit] = chart.getElementsAtEventForMode(evt, mode, { intersect: false }, false);
          if (hit) select(chart.data.datasets[hit.datasetIndex].methodKey, hit.index + 1);
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: color('--solid'),
            cornerRadius: 12,
            padding: 10,
            caretSize: 0,
            displayColors: compare,
            usePointStyle: true,
            titleColor: color('--muted'),
            titleFont: { weight: 'normal' },
            bodyColor: color('--on-solid'),
            bodyFont: { weight: '600', size: 12 },
            footerColor: color('--muted'),
            footerFont: { weight: 'normal' },
            callbacks: {
              title: items => `k = ${items[0].label}`,
              label: item => `${fmt(item.parsed.y)}  ${item.dataset.label}`,
              labelColor: item => ({ borderColor: item.dataset.borderColor, backgroundColor: item.dataset.borderColor, borderWidth: 2 }),
              labelPointStyle: () => ({ pointStyle: 'line', rotation: 0 }),
              footer: items => (compare ? '' : stepOf(items[0].dataset.methodKey, items[0].dataIndex + 1).features.map(i => data.names[i]).join(', ')),
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: '特徵數 k', color: color('--text-2') },
            grid: { display: false },
            border: { display: false },
            ticks: { color: color('--text-2') },
          },
          y: {
            grace: '15%',
            grid: { color: color('--line') },
            border: { display: false },
            ticks: { color: color('--text-2'), padding: 8 },
          },
        },
      },
      plugins: [markers(markerSeries, bestIdx, bestText, below, {
        band: color('--accent-wash'),
        crosshair: color('--line-2'),
        pill: color('--solid'),
        pillText: color('--on-solid'),
      })],
    });
  }
}

// 選取的 k 畫圓角底色帶、滑鼠所在的 k 畫垂直線、最佳點加膠囊標籤
// （最佳點在 RMSE 圖是最低點、在 R² 圖是最高點，below 讓標籤放在離開折線的那一側）
function markers(bestSeries, bestIdx, text, below, colors) {
  const xOf = (chart, i) => chart.scales.x.getPixelForValue(i);
  return {
    id: 'markers',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a } = chart;
      const sel = state.sel.k - 1;
      const w = Math.min(36, ((a.right - a.left) / chart.data.labels.length) * 0.7);
      ctx.save();
      const x0 = Math.max(a.left, xOf(chart, sel) - w / 2);
      const x1 = Math.min(a.right, xOf(chart, sel) + w / 2);
      ctx.fillStyle = colors.band;
      ctx.beginPath();
      ctx.roundRect(x0, a.top, x1 - x0, a.bottom - a.top, 10);
      ctx.fill();
      const [hover] = chart.tooltip.getActiveElements();
      if (hover) {
        const x = Math.round(xOf(chart, hover.index)) + 0.5;
        ctx.strokeStyle = colors.crosshair;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x, a.top);
        ctx.lineTo(x, a.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      if (!chart.isDatasetVisible(bestSeries)) return;
      const pt = chart.getDatasetMeta(bestSeries).data[bestIdx];
      const { ctx, chartArea: a } = chart;
      ctx.save();
      ctx.font = `600 11px ${Chart.defaults.font.family}`;
      const w = ctx.measureText(text).width + 20, h = 22;
      // 標籤靠近左右邊緣時往內移，避免被裁掉
      const x = Math.min(Math.max(pt.x - w / 2, a.left), a.right - w);
      const y = below ? pt.y + 12 : pt.y - 12 - h;
      ctx.fillStyle = colors.pill;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h / 2);
      ctx.fill();
      ctx.fillStyle = colors.pillText;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
      ctx.restore();
    },
  };
}

// ---------- 主題 ----------

function effectiveTheme() {
  return document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {}
  onThemeChange();
}

function onThemeChange() {
  updateThemeIcon();
  if (state.result && !$('results').hidden) {
    drawCharts();
    renderPredictionChart();
    renderAssumptions();
  }
}

function updateThemeIcon() {
  const dark = effectiveTheme() === 'dark';
  $('theme-toggle').dataset.mode = dark ? 'dark' : 'light';
  $('theme-toggle').setAttribute('aria-label', dark ? '切換為淺色模式' : '切換為深色模式');
}

function fillPresetSelect() {
  const select = $('preset');
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = '自訂 CSV 網址';
  select.replaceChildren(
    ...CONFIG.presets.map((preset, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = preset.name;
      return option;
    }),
    custom,
  );
  const selected = CONFIG.presets.findIndex(p => sameDataUrl(p.dataUrl, CONFIG.dataUrl));
  select.value = selected < 0 ? 'custom' : String(selected);
}

function resolveDataUrl(url) {
  try { return new URL(url, document.baseURI).href; }
  catch { return String(url ?? '').trim(); }
}

function sameDataUrl(a, b) {
  if (!String(a ?? '').trim() || !String(b ?? '').trim()) return false;
  return resolveDataUrl(a) === resolveDataUrl(b);
}

// ---------- 小工具 ----------

// 膠囊分段按鈕：容器 id 同時是這組 radio 的 name，值就是選中那顆的 value
function fillChoices(id, items, checked) {
  $(id).replaceChildren(...items.map(([value, text]) => choiceChip(id, value, text, value === checked)));
}

function choiceChip(name, value, text, checked) {
  const input = el('input');
  Object.assign(input, { type: 'radio', name, value, checked });
  return el('label', 'seg-opt', input, el('span', '', text));
}

function choice(id) {
  return $(id).querySelector('input:checked')?.value ?? '';
}

function setChoice(id, value) {
  for (const input of $(id).querySelectorAll('input')) input.checked = input.value === String(value);
}

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function fmtNum(v) {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtStat(v) {
  return Number.isFinite(v) ? fmtNum(v) : '—';
}

function fmtMaybe(v) {
  return Number.isFinite(v) ? fmtNum(v) : '—';
}

function fmtCoef(v) {
  return Math.abs(v) >= 1000 ? fmtNum(v) : String(Number(v.toPrecision(4)));
}

// 負號一律用 −（U+2212）
function fmtSigned(v, fmt = fmtCoef) {
  return `${v < 0 ? '−' : ''}${fmt(Math.abs(v))}`;
}

// 無法計算（例如殘差自由度為 0）時顯示 —
function dash(v, fmt) {
  return Number.isFinite(v) ? fmt(v) : '—';
}

function fmtP(p, prefix = '') {
  if (!Number.isFinite(p)) return '—';
  return p < 0.0001 ? `${prefix}< 0.0001` : `${prefix}${prefix ? '= ' : ''}${p.toFixed(4)}`;
}
