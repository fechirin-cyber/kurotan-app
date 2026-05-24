'use strict';

/**
 * custom-confirm-window/index.js — Custom 設定ウィンドウ renderer (§5.11.5.3 v2)
 *
 * §5.11.7 / §5.10.5.A 制約準拠:
 * - CSS animation (@keyframes) 使用禁止
 * - transform 使用禁止
 * - DOM 構築は document.createElement + .textContent を使用 (XSS 防止)
 *
 * v2 変更点:
 * - 旧 listPatterns / setPattern 撤去 → getToolTypes / setToolType / listExceptions / setException / removeException を利用
 * - ツール種別 9 行 × 4 状態ラジオボタンセクション追加
 * - 個別パターン例外セクション追加 (折りたたみ + 直接追加)
 * - 履歴行に [+例外] ボタン追加 (F-8)
 */

// ─── i18n (インライン実装) ────────────────────────────
var _i18nDict = {};
var _i18nFallbackDict = {};
function t(key, params) {
  var str = _i18nDict[key];
  if (str === undefined || str === null) str = _i18nFallbackDict[key];
  if (str === undefined || str === null) str = key;
  if (params && typeof params === 'object') {
    str = str.replace(/\{(\w+)\}/g, function(_, k) {
      var v = params[k];
      return (v !== undefined && v !== null) ? String(v) : '{' + k + '}';
    });
  }
  return str;
}
function hydrateI18n() {
  document.querySelectorAll('[data-i18n]:not(option)').forEach(function(el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('option[data-i18n]').forEach(function(el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-attr]').forEach(function(el) {
    var spec = el.getAttribute('data-i18n-attr');
    var colonIdx = spec.indexOf(':');
    if (colonIdx >= 0) {
      el.setAttribute(spec.slice(0, colonIdx), t(spec.slice(colonIdx + 1)));
    }
  });
 // DECISIONS ラベルを現在言語で更新して再描画
  DECISIONS = [
    { value: 'allow',   label: t('custom_confirm.decision.allow') },
    { value: 'ask',     label: t('custom_confirm.decision.ask') },
    { value: 'deny',    label: t('custom_confirm.decision.deny') },
    { value: 'inherit', label: t('custom_confirm.decision.inherit') }
  ];
  renderToolTypes();
  updateModeDisplay(currentMode);
  updateHistoryCount();
}
function updateHistoryCount() {
  if (historyCount) {
    historyCount.textContent = t('custom_confirm.history.count', {
      filtered: filteredHistory.length,
      total: allHistory.length
    });
  }
}

// ─── 仮想スクロール設定 ──────────────────────────────
var ROW_HEIGHT = 30;
var BUFFER_ROWS = 10;

// ─── ツール種別定義 (§5.11.4.3 Q10=A / 9 種別) ──────
var TOOL_TYPES = [
  { key: 'Bash',    label: 'Bash' },
  { key: 'Read',    label: 'Read' },
  { key: 'Edit',    label: 'Edit' },
  { key: 'Search',  label: 'Search' },
  { key: 'Web',     label: 'Web' },
  { key: 'Skill',   label: 'Skill' },
  { key: 'Agent',   label: 'Agent' },
  { key: 'mcp__*',  label: 'mcp__*' },
  { key: 'Other',   label: 'Other' }
];

// 4 状態ラジオ定義
var DECISIONS = [
  { value: 'allow',   label: '許可' },
  { value: 'ask',     label: '確認' },
  { value: 'deny',    label: '拒否' },
  { value: 'inherit', label: '自動' }
];

// ─── 状態 ────────────────────────────────────────────
var allHistory = [];
var filteredHistory = [];
var currentMode = 'auto';
var currentToolTypes = {}; // { Bash: "inherit", ... }
var exceptions = []; // [{ rule, decision, source, addedAt }, ...]

// ─── DOM 参照 ─────────────────────────────────────────
var modeDisplay        = document.getElementById('mode-display');
var tooltypeList       = document.getElementById('tooltype-list');
var tooltypeError      = document.getElementById('tooltype-error');
var btnToggleExceptions = document.getElementById('btn-toggle-exceptions');
var exceptionsArrow    = document.getElementById('exceptions-arrow');
var exceptionsBody     = document.getElementById('exceptions-body');
var exceptionsList     = document.getElementById('exceptions-list');
var exceptionInput     = document.getElementById('exception-input');
var exceptionAddDecision = document.getElementById('exception-add-decision');
var btnExceptionAdd    = document.getElementById('btn-exception-add');
var exceptionAddError  = document.getElementById('exception-add-error');
var exceptionOverwriteConfirm = document.getElementById('exception-overwrite-confirm');
var exceptionOverwriteMsg = document.getElementById('exception-overwrite-msg');
var btnOverwriteYes    = document.getElementById('btn-overwrite-yes');
var btnOverwriteNo     = document.getElementById('btn-overwrite-no');
var historyViewport    = document.getElementById('history-viewport');
var historySpacer      = document.getElementById('history-spacer');
var historyRows        = document.getElementById('history-rows');
var historySearch      = document.getElementById('history-search');
var historySort        = document.getElementById('history-sort');
var historyCount       = document.getElementById('history-count');
var btnRefresh         = document.getElementById('btn-refresh-history');

// ─── モード表示更新 ───────────────────────────────────
function updateModeDisplay(mode) {
  currentMode = mode;
  modeDisplay.className = 'mode-' + mode;
  if (mode === 'custom') {
    modeDisplay.textContent = t('custom_confirm.mode_custom');
  } else {
    modeDisplay.textContent = t('custom_confirm.mode_auto');
  }
}

// ─── ツール種別セクション描画 ─────────────────────────
function renderToolTypes() {
  while (tooltypeList.firstChild) {
    tooltypeList.removeChild(tooltypeList.firstChild);
  }

  TOOL_TYPES.forEach(function(tt) {
    var row = document.createElement('div');
    row.className = 'tooltype-row';
    row.setAttribute('data-tooltype', tt.key);
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', tt.label);

    var nameEl = document.createElement('span');
    nameEl.className = 'tooltype-name';
    nameEl.textContent = tt.label;
    row.appendChild(nameEl);

    var radiosEl = document.createElement('div');
    radiosEl.className = 'tooltype-radios';

    DECISIONS.forEach(function(dec) {
      var label = document.createElement('label');

      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'tooltype-' + tt.key;
      radio.value = dec.value;
      radio.setAttribute('aria-label', tt.label + ' を ' + dec.label + ' に設定');

      var currentVal = currentToolTypes[tt.key] || 'inherit';
      if (currentVal === dec.value) {
        radio.checked = true;
      }

      (function(toolKey, decValue, radioEl, rowEl) {
        radio.addEventListener('change', function() {
          if (radioEl.checked) {
            handleToolTypeChange(toolKey, decValue, rowEl, radioEl);
          }
        });
      })(tt.key, dec.value, radio, row);

      var labelText = document.createTextNode(dec.label);
      label.appendChild(radio);
      label.appendChild(labelText);
      radiosEl.appendChild(label);
    });

    row.appendChild(radiosEl);

 // Other 行の警告ラベル
    if (tt.key === 'Other') {
      var warningEl = document.createElement('span');
      warningEl.className = 'tooltype-warning';
      warningEl.setAttribute('aria-label', '警告');
      var currentVal = currentToolTypes['Other'] || 'inherit';
      if (currentVal === 'allow') {
        warningEl.textContent = t('custom_confirm.warn.all_allow');
        row.classList.add('allow-selected');
      } else {
        warningEl.textContent = t('custom_confirm.warn.future_tools');
      }
      row.appendChild(warningEl);
    }

    tooltypeList.appendChild(row);
  });
}

function handleToolTypeChange(toolKey, decValue, rowEl, radioEl) {
  var previousVal = currentToolTypes[toolKey] || 'inherit';
  currentToolTypes[toolKey] = decValue;

 // Other 行の警告表示更新
  if (toolKey === 'Other') {
    updateOtherWarning(rowEl, decValue);
  }

  clearTooltypeError();

  window.kurotanCustomConfirm.setToolType({ toolType: toolKey, decision: decValue })
    .then(function(result) {
      if (result && result.error) {
 // ロールバック
        currentToolTypes[toolKey] = previousVal;
        rollbackRadio(rowEl, toolKey, previousVal);
        if (toolKey === 'Other') {
          updateOtherWarning(rowEl, previousVal);
        }
        showTooltypeError(t('custom_confirm.error.save_failed', { error: result.error }));
      }
    })
    .catch(function(err) {
      currentToolTypes[toolKey] = previousVal;
      rollbackRadio(rowEl, toolKey, previousVal);
      if (toolKey === 'Other') {
        updateOtherWarning(rowEl, previousVal);
      }
      showTooltypeError(err && err.message ? t('custom_confirm.error.save_failed', { error: err.message }) : t('custom_confirm.error.save_unknown'));
    });
}

function updateOtherWarning(rowEl, decValue) {
  var warningEl = rowEl.querySelector('.tooltype-warning');
  if (!warningEl) return;
  if (decValue === 'allow') {
    warningEl.textContent = t('custom_confirm.warn.all_allow');
    rowEl.classList.add('allow-selected');
  } else {
    warningEl.textContent = t('custom_confirm.warn.future_tools');
    rowEl.classList.remove('allow-selected');
  }
}

function rollbackRadio(rowEl, toolKey, value) {
  var radios = rowEl.querySelectorAll('input[type="radio"][name="tooltype-' + toolKey + '"]');
  for (var i = 0; i < radios.length; i++) {
    radios[i].checked = (radios[i].value === value);
  }
}

function showTooltypeError(msg) {
  tooltypeError.textContent = msg;
}

function clearTooltypeError() {
  tooltypeError.textContent = '';
}

// ─── 例外セクション折りたたみ ────────────────────────
var exceptionsExpanded = true;

function initExceptionsToggle() {
  var saved = localStorage.getItem('kurotan_exceptions_expanded');
  if (saved === 'false') {
    exceptionsExpanded = false;
    collapseExceptions(false);
  }
}

function collapseExceptions(animate) {
  exceptionsBody.style.display = 'none';
  exceptionsArrow.textContent = '▶';
  btnToggleExceptions.setAttribute('aria-expanded', 'false');
  exceptionsExpanded = false;
  localStorage.setItem('kurotan_exceptions_expanded', 'false');
}

function expandExceptions(animate) {
  exceptionsBody.style.display = 'flex';
  exceptionsArrow.textContent = '▼';
  btnToggleExceptions.setAttribute('aria-expanded', 'true');
  exceptionsExpanded = true;
  localStorage.setItem('kurotan_exceptions_expanded', 'true');
}

btnToggleExceptions.addEventListener('click', function() {
  if (exceptionsExpanded) {
    collapseExceptions(true);
  } else {
    expandExceptions(true);
  }
});

// ─── 例外一覧描画 ─────────────────────────────────────
function renderExceptions() {
  while (exceptionsList.firstChild) {
    exceptionsList.removeChild(exceptionsList.firstChild);
  }

  if (exceptions.length === 0) {
    var hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = t('custom_confirm.exceptions.empty');
    exceptionsList.appendChild(hint);
    return;
  }

  exceptions.forEach(function(ex) {
    var row = document.createElement('div');
    row.className = 'exception-row';
    row.setAttribute('role', 'listitem');

    var ruleEl = document.createElement('span');
    ruleEl.className = 'exception-rule';
    ruleEl.textContent = ex.rule;
    ruleEl.title = ex.rule;
    row.appendChild(ruleEl);

    var decSel = document.createElement('select');
    decSel.className = 'exception-decision';
    decSel.setAttribute('aria-label', ex.rule + ' の decision');
    DECISIONS.forEach(function(dec) {
      var opt = document.createElement('option');
      opt.value = dec.value;
      opt.textContent = dec.label;
      if (ex.decision === dec.value) opt.selected = true;
      decSel.appendChild(opt);
    });

    (function(rule, sel, exObj) {
      sel.addEventListener('change', function() {
        var prevDecision = exObj.decision;
        exObj.decision = sel.value;
        window.kurotanCustomConfirm.setException({ rule: rule, decision: sel.value, source: exObj.source || 'manual' })
          .then(function(result) {
            if (result && result.error) {
              exObj.decision = prevDecision;
              sel.value = prevDecision;
              showExceptionAddError(t('custom_confirm.error.change_failed', { error: result.error }));
            }
          })
          .catch(function(err) {
            exObj.decision = prevDecision;
            sel.value = prevDecision;
            showExceptionAddError(t('custom_confirm.error.change_failed', { error: err && err.message ? err.message : '' }));
          });
      });
    })(ex.rule, decSel, ex);

    row.appendChild(decSel);

    var delBtn = document.createElement('button');
    delBtn.className = 'btn-delete';
    delBtn.textContent = t('custom_confirm.exceptions.delete_btn');
    (function(rule) {
      delBtn.addEventListener('click', function() {
        deleteException(rule);
      });
    })(ex.rule);
    row.appendChild(delBtn);

    exceptionsList.appendChild(row);
  });
}

// ─── 例外追加 ─────────────────────────────────────────
var pendingOverwriteRule = null;
var pendingOverwriteDecision = null;

function addException(rule, decision, source, forceOverwrite) {
  if (!rule) return;
  if (!validateRule(rule)) {
    showExceptionAddError(t('custom_confirm.exceptions.error_invalid'));
    return;
  }
  clearExceptionAddError();
  hideOverwriteConfirm();

 // 既存チェック (上書き確認)
  if (!forceOverwrite) {
    var exists = exceptions.some(function(ex) { return ex.rule === rule; });
    if (exists) {
      pendingOverwriteRule = rule;
      pendingOverwriteDecision = decision;
      exceptionOverwriteMsg.textContent = t('custom_confirm.exceptions.overwrite_confirm', { rule: rule });
      exceptionOverwriteConfirm.style.display = 'flex';
      return;
    }
  }

  window.kurotanCustomConfirm.setException({ rule: rule, decision: decision, source: source || 'manual' })
    .then(function(result) {
      if (result && result.ok) {
        exceptionInput.value = '';
        exceptionAddDecision.value = 'ask';
        return loadExceptions();
      }
      showExceptionAddError(t('custom_confirm.error.add_failed', { error: result && result.error ? result.error : '' }));
    })
    .catch(function(err) {
      showExceptionAddError(t('custom_confirm.error.add_failed', { error: err && err.message ? err.message : '' }));
    });
}

function deleteException(rule) {
  window.kurotanCustomConfirm.removeException({ rule: rule })
    .then(function(result) {
      if (result && result.ok) {
        return loadExceptions();
      }
      showExceptionAddError('削除失敗: ' + (result && result.error ? result.error : ''));
    })
    .catch(function(err) {
      showExceptionAddError('削除失敗: ' + (err && err.message ? err.message : '不明なエラー'));
    });
}

function hideOverwriteConfirm() {
  exceptionOverwriteConfirm.style.display = 'none';
  exceptionOverwriteMsg.textContent = '';
  pendingOverwriteRule = null;
  pendingOverwriteDecision = null;
}

btnOverwriteYes.addEventListener('click', function() {
  if (pendingOverwriteRule) {
    addException(pendingOverwriteRule, pendingOverwriteDecision, 'manual', true);
  }
});

btnOverwriteNo.addEventListener('click', function() {
  hideOverwriteConfirm();
});

function showExceptionAddError(msg) {
  exceptionAddError.textContent = msg;
}

function clearExceptionAddError() {
  exceptionAddError.textContent = '';
}

// ─── rule 簡易バリデート (§5.11.5.3 / §5.11.4.2) ──────
var KNOWN_TOOLS = [
  'Bash', 'BashOutput', 'Read', 'Edit', 'Write', 'NotebookEdit',
  'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Skill'
];

function validateRule(rule) {
  if (!rule || typeof rule !== 'string') return false;
  var parenIdx = rule.indexOf('(');
  if (parenIdx === -1) {
 // tool 名のみ — MCP 前方一致も許容
    return rule.length > 0;
  }
  var tool = rule.slice(0, parenIdx);
 // 既知ツールか MCP 前方一致 (early check)
  if (KNOWN_TOOLS.indexOf(tool) === -1 && !tool.startsWith('mcp__')) return false;

 // quote-aware で対応する closing ')' を探す
 // permission-resolver.js の parseRule (L139-L222) と等価なロジックを inline 移植。
 // contextIsolation: true のため resolver を直接 import 不可。
  var depth = 0;
 var inQuote = null; // null | '"' | "'"
  var closingIdx = -1;
  for (var i = parenIdx; i < rule.length; i++) {
    var ch = rule[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < rule.length) { i++; continue; }
      if (ch === inQuote) { inQuote = null; }
 continue; // クォート内の () はネスト判定に使わない
    }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === '(') { depth++; }
    else if (ch === ')') {
      depth--;
      if (depth === 0) { closingIdx = i; break; }
    }
  }
 if (closingIdx === -1) return false; // 対応する ')' が見つからない
 if (closingIdx !== rule.length - 1) return false; // ')' の後に余分な文字

 // specifier 内のクォート外ネスト括弧チェック
  var specifier = rule.slice(parenIdx + 1, closingIdx);
  var d = 0;
  var iq = null;
  for (var j = 0; j < specifier.length; j++) {
    var c = specifier[j];
    if (iq) {
      if (c === '\\' && j + 1 < specifier.length) { j++; continue; }
      if (c === iq) { iq = null; }
      continue;
    }
    if (c === '"' || c === "'") { iq = c; continue; }
    if (c === '(') d++;
    else if (c === ')') d--;
 if (d !== 0) return false; // クォート外のネスト括弧 → 不正
  }
  return true;
}

// ─── 履歴ロード ───────────────────────────────────────
function loadHistory() {
  window.kurotanCustomConfirm.listHistory({})
    .then(function(result) {
      allHistory = result.entries || [];
      applyFilter();
    });
}

function applyFilter() {
  var q = historySearch.value.trim().toLowerCase();
  if (!q) {
    filteredHistory = allHistory.slice();
  } else {
    filteredHistory = allHistory.filter(function(e) {
      return (e.toolName || '').toLowerCase().indexOf(q) !== -1
          || (e.matchingKey || '').toLowerCase().indexOf(q) !== -1
          || (e.ruleSuggestion || '').toLowerCase().indexOf(q) !== -1;
    });
  }
  var sortOrder = historySort ? historySort.value : 'newest';
  filteredHistory.sort(function(a, b) {
    var ta = a.ts ? new Date(a.ts).getTime() : 0;
    var tb = b.ts ? new Date(b.ts).getTime() : 0;
    return sortOrder === 'oldest' ? ta - tb : tb - ta;
  });
  historyCount.textContent = filteredHistory.length + ' 件 (全 ' + allHistory.length + ' 件)';
  historyViewport.scrollTop = 0;
  renderHistoryVirtual();
}

// ─── 仮想スクロール描画 ───────────────────────────────
function renderHistoryVirtual() {
  historySpacer.style.height = (filteredHistory.length * ROW_HEIGHT) + 'px';
  renderVisibleRows();
}

function renderVisibleRows() {
  var scrollTop = historyViewport.scrollTop;
  var viewHeight = historyViewport.clientHeight || 200;

  var startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
  var endIdx   = Math.min(filteredHistory.length, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + BUFFER_ROWS);

  historyRows.style.top = (startIdx * ROW_HEIGHT) + 'px';

  while (historyRows.firstChild) {
    historyRows.removeChild(historyRows.firstChild);
  }

  for (var i = startIdx; i < endIdx; i++) {
    historyRows.appendChild(buildHistoryRow(filteredHistory[i], i));
  }
}

function buildHistoryRow(entry, idx) {
  var row = document.createElement('div');
  row.className = 'history-row';
  row.setAttribute('role', 'listitem');
  row.style.height = ROW_HEIGHT + 'px';

 // tool 名
  var toolEl = document.createElement('span');
  toolEl.className = 'history-tool';
  toolEl.textContent = entry.toolName || '';
  row.appendChild(toolEl);

 // matchingKey
  var keyEl = document.createElement('span');
  keyEl.className = 'history-key';
  keyEl.textContent = entry.matchingKey || '';
  keyEl.title = entry.matchingKey || '';
  row.appendChild(keyEl);

 // タイムスタンプ
  var tsEl = document.createElement('span');
  tsEl.className = 'history-ts';
  tsEl.textContent = formatTs(entry.ts);
  row.appendChild(tsEl);

 // decision (mode / source を含む場合は優先)
  var decEl = document.createElement('span');
  var dec = entry.source || entry.decision || entry.mode || '';
  decEl.className = 'history-decision ' + decisionClass(dec);
  decEl.textContent = dec;
  row.appendChild(decEl);

 // [+例外] ボタン (F-8)
  var addExBtn = document.createElement('button');
  addExBtn.className = 'btn-add-exception';
  addExBtn.textContent = '+例外';
  var rule = entry.ruleSuggestion || entry.toolName || '';
  addExBtn.setAttribute('aria-label', rule + ' を例外に追加');
  (function(r) {
    addExBtn.addEventListener('click', function() {
      addExceptionFromHistory(r);
    });
  })(rule);
  row.appendChild(addExBtn);

  return row;
}

// ─── 履歴からの例外追加 ───────────────────────────────
function addExceptionFromHistory(rule) {
  if (!rule) return;
 // 例外セクションを展開
  if (!exceptionsExpanded) {
    expandExceptions(false);
  }
 // 既存チェック
  var exists = exceptions.some(function(ex) { return ex.rule === rule; });
  if (exists) {
    showExceptionAddError('"' + rule + '" は既に例外に登録されています');
    return;
  }
  window.kurotanCustomConfirm.setException({ rule: rule, decision: 'ask', source: 'history' })
    .then(function(result) {
      if (result && result.ok) {
        clearExceptionAddError();
        return loadExceptions();
      }
      showExceptionAddError('例外追加失敗: ' + (result && result.error ? result.error : ''));
    })
    .catch(function(err) {
      showExceptionAddError('例外追加失敗: ' + (err && err.message ? err.message : '不明なエラー'));
    });
}

function decisionClass(dec) {
  if (dec === 'allow' || dec === 'auto-allow') return 'allow';
  if (dec === 'deny'  || dec === 'auto-deny')  return 'deny';
  if (dec === 'no-match') return 'ui';
  return 'ask';
}

function formatTs(ts) {
  if (!ts) return '';
  try {
    var d = new Date(ts);
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var min = String(d.getMinutes()).padStart(2, '0');
    return mm + '/' + dd + ' ' + hh + ':' + min;
  } catch (_) { return ts; }
}

// ─── ツール種別ロード ──────────────────────────────────
function loadToolTypes() {
  return window.kurotanCustomConfirm.getToolTypes()
    .then(function(result) {
      currentToolTypes = result.toolTypes || {};
      renderToolTypes();
    })
    .catch(function(err) {
      showTooltypeError('種別設定の読み込みに失敗しました: ' + (err && err.message ? err.message : ''));
    });
}

// ─── 例外ロード ───────────────────────────────────────
function loadExceptions() {
  return window.kurotanCustomConfirm.listExceptions()
    .then(function(result) {
      exceptions = result.exceptions || [];
      renderExceptions();
    })
    .catch(function(err) {
      showExceptionAddError('例外の読み込みに失敗しました: ' + (err && err.message ? err.message : ''));
    });
}

// ─── イベント登録 ─────────────────────────────────────
historyViewport.addEventListener('scroll', renderVisibleRows);

historySearch.addEventListener('input', function() {
  applyFilter();
});

historySort.addEventListener('change', function() {
  applyFilter();
});

btnRefresh.addEventListener('click', function() {
  loadHistory();
});

btnExceptionAdd.addEventListener('click', function() {
  var rule = exceptionInput.value.trim();
  var decision = exceptionAddDecision.value;
  addException(rule, decision, 'manual', false);
});

exceptionInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    btnExceptionAdd.click();
  }
});

// ─── mode-changed イベント (§5.11.5.4) ───────────────
window.kurotanCustomConfirm.onModeChanged(function(data) {
  updateModeDisplay(data.mode || 'auto');
});

// ─── 初期ロード ───────────────────────────────────────
initExceptionsToggle();

window.kurotanCustomConfirm.getMode().then(function(result) {
  updateModeDisplay(result.mode || 'auto');
});

loadToolTypes().then(function() {
  return loadExceptions();
}).then(function() {
  loadHistory();
});

// ─── Esc キーでウィンドウを閉じる ────────────────────
window.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    if (window.kurotanCustomConfirm && window.kurotanCustomConfirm.closeWindow) {
      window.kurotanCustomConfirm.closeWindow();
    }
  }
});
