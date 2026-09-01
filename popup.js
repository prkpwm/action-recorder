// Action Recorder - popup logic
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------- state
  let currentSession = null;
  let recordingState = { active: false, tabId: null, url: '', startedAt: 0 };
  let suites = ['suite1'];
  let activeSuite = 'suite1';
  let statusTimer = null;
  let isReplaying = false;

  // ------------------------------------------------------------- messaging
  const sendMsg = (type, data = {}) =>
    chrome.runtime.sendMessage({ type, ...data })
      .then((res) => res || { ok: false })
      .catch(() => ({ ok: false }));

  // ------------------------------------------------------------- status
  function showStatus(text, isError = false) {
    const el = $('status');
    el.textContent = text;
    el.className = 'msg ' + (isError ? 'error' : 'info');
    clearTimeout(statusTimer);
    // Don't auto-clear while a replay is running — the message stays until replay ends
    if (text && !isReplaying) statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function setReplayProgress(current, total, selector) {
    const wrap = $('replayProgress');
    if (current == null) {
      wrap.setAttribute('hidden', '');
      return;
    }
    wrap.removeAttribute('hidden');
    $('replayProgressCount').textContent = `${current} / ${total}`;
    $('replayProgressBar').style.width = `${Math.round((current / total) * 100)}%`;
    $('replayProgressSel').textContent = selector || '';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  // ------------------------------------------------------------- refresh / render
  async function refresh() {
    const { arRecording } = await chrome.storage.local.get('arRecording');
    recordingState = arRecording || { active: false, tabId: null, url: '', startedAt: 0 };

    const res = await sendMsg('GET_SESSION_INFO');
    if (res.ok) {
      currentSession = res.session;
      suites = res.suites || ['suite1'];
      activeSuite = res.active || 'suite1';
    }
    render();
  }

  function render() {
    const steps = (currentSession && currentSession.steps) || [];

    // --- recording button
    const btn = $('startStopBtn');
    if (recordingState.active) {
      btn.textContent = '⏹ Stop Recording';
      btn.classList.add('recording');
    } else {
      btn.textContent = '▶ Start Recording';
      btn.classList.remove('recording');
    }

    // --- action buttons
    $('replayBtn').disabled = steps.length === 0 || recordingState.active || isReplaying;
    $('stopReplayBtn').disabled = !isReplaying;
    $('exportBtn').disabled = steps.length === 0;
    $('clearBtn').disabled = steps.length === 0 && !recordingState.active;

    // --- status dot
    const dot = $('statusDot');
    const line = $('statusLine');
    if (recordingState.active) {
      dot.classList.add('on');
      line.textContent = `Recording — ${activeSuite}`;
    } else if (isReplaying) {
      dot.classList.add('on');
      line.textContent = `Replaying — ${activeSuite}`;
    } else {
      dot.classList.remove('on');
      line.textContent = 'Ready';
    }

    // --- meta line
    const meta = $('meta');
    const parts = [];
    if (currentSession && currentSession.startedAt) parts.push(`Start: ${fmtTime(currentSession.startedAt)}`);
    if (currentSession && currentSession.endedAt) parts.push(`End: ${fmtTime(currentSession.endedAt)}`);
    if (steps.length) parts.push(`Steps: ${steps.length}`);
    meta.textContent = parts.join('  ·  ');

    // --- URL row
    const urlRow = $('urlRow');
    if (currentSession) {
      urlRow.removeAttribute('hidden');
      const isRegex = !!currentSession.urlIsRegex;
      $('urlInput').value = currentSession.urlPattern || currentSession.url || '';
      $('urlRegexBtn').classList.toggle('active', isRegex);
      $('urlRegexBtn').title = isRegex ? 'Regex mode ON — click to switch to plain URL' : 'Plain URL — click to enable regex mode';
    } else {
      urlRow.setAttribute('hidden', '');
    }

    // --- suite controls
    renderSuiteBar();
    renderList(steps);
  }

  function renderSuiteBar() {
    const dropdown = $('suiteDropdown');
    // Rebuild options, preserving selection
    dropdown.innerHTML = '';
    for (const s of suites) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === activeSuite) opt.selected = true;
      dropdown.appendChild(opt);
    }

    // Disable suite controls while recording
    dropdown.disabled = recordingState.active;
    $('newSuiteBtn').disabled = recordingState.active;
    $('editSuiteBtn').disabled = recordingState.active;
    $('deleteSuiteBtn').disabled = recordingState.active || suites.length <= 1;
    $('importSuiteBtn').disabled = recordingState.active;
  }

  function renderList(steps) {
    const list = $('stepList');
    list.innerHTML = '';
    if (!steps.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = 'No steps recorded yet.<br>Press <b>Start Recording</b>, then click and type on the page.';
      list.appendChild(empty);
      return;
    }

    steps.forEach((step, i) => {
      const row = document.createElement('div');
      row.className = 'step';

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);

      const badge = document.createElement('span');
      badge.className = 'badge ' + (step.type === 'click' ? 'b-click' : step.type === 'select' ? 'b-select' : 'b-fill');
      badge.textContent = step.type === 'click' ? 'CLICK' : step.type === 'select' ? 'SELECT' : 'FILL';

      const body = document.createElement('div');
      body.className = 'step-body';

      const sel = document.createElement('div');
      sel.className = 'step-sel';
      sel.textContent = step.selector;
      sel.title = step.selector;

      const val = document.createElement('div');
      val.className = 'step-val';
      if (step.type === 'select') val.textContent = `option: ${step.optionText || step.value}`;
      else if (step.type === 'fill') val.textContent = `value: ${step.value}`;
      else if (step.text) val.textContent = `text: ${step.text}`;
      else if (step.href) val.textContent = step.href;

      body.appendChild(sel);
      if (val.textContent) body.appendChild(val);

      // --- action buttons
      const actions = document.createElement('div');
      actions.className = 'step-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'step-btn step-btn--edit';
      editBtn.title = 'Edit step';
      editBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M5 19H6.4L15.025 10.375L13.625 8.975L5 17.6V19ZM19.3 8.925L15.05 4.725L16.45 3.325C16.833 2.942 17.304 2.75 17.863 2.75C18.421 2.75 18.892 2.942 19.275 3.325L20.675 4.725C21.058 5.108 21.25 5.579 21.25 6.137C21.25 6.696 21.058 7.167 20.675 7.55L19.3 8.925ZM17.85 10.4L7.25 21H3V16.75L13.6 6.15L17.85 10.4Z"/></svg>';
      editBtn.addEventListener('click', () => editStep(i, step));

      const delBtn = document.createElement('button');
      delBtn.className = 'step-btn step-btn--del';
      delBtn.title = 'Delete step';
      delBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M7 21C6.45 21 5.979 20.804 5.587 20.412C5.195 20.02 5 19.55 5 19V6H4V4H9V3H15V4H20V6H19V19C19 19.55 18.804 20.021 18.412 20.413C18.02 20.805 17.55 21 17 21H7Z"/></svg>';
      delBtn.addEventListener('click', () => deleteStep(i));

      actions.append(editBtn, delBtn);
      row.append(idx, badge, body, actions);
      list.appendChild(row);
    });
  }

  // ------------------------------------------------------------- step edit / delete
  async function deleteStep(index) {
    const res = await sendMsg('DELETE_STEP', { suiteName: activeSuite, stepIndex: index });
    if (res.ok) {
      await refresh();
    } else {
      showStatus(res.error || 'Failed to delete step.', true);
    }
  }

  // ------------------------------------------------------------- inline edit modal
  let _editResolve = null;

  function openEditModal(step) {
    return new Promise((resolve) => {
      _editResolve = resolve;

      const isFill = step.type === 'fill';
      const isSelect = step.type === 'select';
      const valLabel = isFill ? 'Value' : isSelect ? 'Option Text' : step.href ? 'Href' : 'Text';

      $('editValLabel').textContent = valLabel;
      $('editSelector').value = step.selector || '';
      $('editValue').value = isFill ? (step.value || '') : isSelect ? (step.optionText || step.value || '') : (step.text || step.href || '');
      $('editDelay').value = step.delay != null ? String(step.delay) : '0';

      $('editModal').removeAttribute('hidden');
      $('editSelector').focus();
    });
  }

  function closeEditModal(result) {
    $('editModal').setAttribute('hidden', '');
    if (_editResolve) { _editResolve(result); _editResolve = null; }
  }

  async function editStep(index, step) {
    const result = await openEditModal(step);
    if (!result) return; // cancelled

    const isFill = step.type === 'fill';
    const isSelect = step.type === 'select';
    const patch = {
      selector: result.selector,
      delay: Math.max(0, parseInt(result.delay, 10) || 0)
    };
    if (isFill) patch.value = result.value;
    else if (isSelect) { patch.optionText = result.value; patch.value = result.value; }
    else if (step.href) patch.href = result.value;
    else patch.text = result.value;

    const res = await sendMsg('EDIT_STEP', { suiteName: activeSuite, stepIndex: index, patch });
    if (res.ok) {
      await refresh();
    } else {
      showStatus(res.error || 'Failed to edit step.', true);
    }
  }

  // ------------------------------------------------------------- URL pattern
  async function saveUrlPattern() {
    if (!currentSession) return;
    const pattern = $('urlInput').value.trim();
    const isRegex = $('urlRegexBtn').classList.contains('active');

    // Validate regex if regex mode is on
    if (isRegex) {
      try { new RegExp(pattern); }
      catch (e) { showStatus('Invalid regex: ' + e.message, true); return; }
    }

    const res = await sendMsg('SAVE_SESSION_URL', { suiteName: activeSuite, pattern, isRegex });
    if (res.ok) {
      currentSession.urlPattern = pattern;
      currentSession.urlIsRegex = isRegex;
      showStatus('URL pattern saved.');
    } else {
      showStatus(res.error || 'Failed to save URL.', true);
    }
  }

  // ------------------------------------------------------------- suite actions
  async function switchSuite(name) {
    const res = await sendMsg('SWITCH_SUITE', { suiteName: name });
    if (res.ok) {
      activeSuite = name;
      await refresh();
    } else {
      showStatus(res.error || 'Failed to switch suite.', true);
    }
  }

  async function addSuite() {
    const name = prompt('Name for the new suite:');
    if (!name || !name.trim()) return;
    const res = await sendMsg('ADD_SUITE', { suiteName: name.trim() });
    if (res.ok) {
      suites = res.suites;
      activeSuite = res.active;
      showStatus(`Suite "${res.active}" created.`);
      await refresh();
    } else {
      showStatus(res.error || 'Failed to add suite.', true);
    }
  }

  async function editSuite() {
    const newName = prompt('Rename suite to:', activeSuite);
    if (!newName || !newName.trim() || newName.trim() === activeSuite) return;
    const res = await sendMsg('RENAME_SUITE', { oldName: activeSuite, newName: newName.trim() });
    if (res.ok) {
      suites = res.suites;
      activeSuite = res.active;
      showStatus(`Suite renamed to "${activeSuite}".`);
      await refresh();
    } else {
      showStatus(res.error || 'Failed to rename suite.', true);
    }
  }

  async function deleteSuite() {
    if (suites.length <= 1) {
      showStatus('Cannot delete the last suite.', true);
      return;
    }
    if (!confirm(`Delete suite "${activeSuite}" and all its recorded steps?`)) return;
    const res = await sendMsg('DELETE_SUITE', { suiteName: activeSuite });
    if (res.ok) {
      suites = res.suites;
      activeSuite = res.active;
      showStatus('Suite deleted.');
      await refresh();
    } else {
      showStatus(res.error || 'Failed to delete suite.', true);
    }
  }

  // ------------------------------------------------------------- recording actions
  async function toggleRecording() {
    if (recordingState.active) {
      const res = await sendMsg('STOP_RECORDING');
      showStatus(res.ok ? 'Recording stopped.' : 'Failed to stop recording.', !res.ok);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) { showStatus('No active tab found.', true); return; }
      if (!/^https?:/.test(tab.url || '')) {
        showStatus('Cannot record on this page type (chrome://, etc).', true);
        return;
      }
      const res = await sendMsg('START_RECORDING', { tabId: tab.id });
      showStatus(res.ok ? `Recording into "${activeSuite}" — click & type on the page.` : 'Failed to start recording.', !res.ok);
    }
    await refresh();
  }

  async function replay() {
    if (!currentSession || !currentSession.steps || !currentSession.steps.length) {
      showStatus('Nothing to replay.', true);
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) { showStatus('No active tab found.', true); return; }
    if (!/^https?:/.test(tab.url || '')) { showStatus('Cannot replay on this page type.', true); return; }
    const res = await sendMsg('START_REPLAY', {
      tabId: tab.id,
      urlPattern: currentSession.urlPattern || currentSession.url || '',
      urlIsRegex: !!currentSession.urlIsRegex
    });
    if (res.ok) {
      isReplaying = true;
      setReplayProgress(0, currentSession.steps.length, '');
      showStatus('Replaying…');
      render();
    } else {
      showStatus('Failed to start replay.', true);
    }
  }

  async function stopReplay() {
    const res = await sendMsg('STOP_REPLAY');
    isReplaying = false;
    setReplayProgress(null);
    showStatus(res.ok ? 'Replay stopped.' : 'Nothing to stop.', !res.ok);
    render();
  }

  // ------------------------------------------------------------- export
  function exportJson() {
    if (!currentSession || !currentSession.steps || !currentSession.steps.length) {
      showStatus('Nothing to export.', true);
      return;
    }
    const blob = new Blob([JSON.stringify(currentSession, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `action-recording-${activeSuite}-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
    showStatus(`Exported ${currentSession.steps.length} steps (${activeSuite}).`);
  }

  // ------------------------------------------------------------- import
  async function importSuite(event) {
    const file = event.target.files[0];
    if (!file) return;
    // Reset so the same file can be re-imported if needed
    event.target.value = '';

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      showStatus('Invalid JSON file.', true);
      return;
    }

    // Accept either a bare session object { steps, suiteName, ... }
    // or the full export wrapper that exportJson produces (same shape).
    if (!parsed || !Array.isArray(parsed.steps)) {
      showStatus('File does not contain a valid suite (missing steps array).', true);
      return;
    }

    // Determine the default name: prefer the file's suiteName field, then the filename stem.
    const defaultName = parsed.suiteName
      || file.name.replace(/\.json$/i, '').replace(/^action-recording-/, '').replace(/-\d{4}-\d{2}-\d{2}.*$/, '')
      || 'imported';

    // If a suite with that name already exists, ask whether to overwrite or pick a new name.
    let targetName = defaultName;
    if (suites.includes(targetName)) {
      const choice = prompt(
        `Suite "${targetName}" already exists.\nEnter a new name to keep both, or leave as-is to overwrite:`,
        targetName
      );
      if (choice === null) return; // cancelled
      targetName = choice.trim() || targetName;
    }

    const res = await sendMsg('IMPORT_SUITE', { session: parsed, suiteName: targetName });
    if (res.ok) {
      suites = res.suites;
      activeSuite = res.active;
      showStatus(`Imported "${targetName}" (${parsed.steps.length} steps).`);
      await refresh();
    } else {
      showStatus(res.error || 'Import failed.', true);
    }
  }

  // ------------------------------------------------------------- clear
  async function clearCurrent() {
    const hasSteps = currentSession && currentSession.steps && currentSession.steps.length;
    if (recordingState.active) {
      if (!confirm(`Stop recording and clear all steps in "${activeSuite}"?`)) return;
    } else if (hasSteps) {
      if (!confirm(`Clear all recorded steps in "${activeSuite}"?`)) return;
    }
    const res = await sendMsg('CLEAR_SESSION', { suiteName: activeSuite });
    showStatus(res.ok ? `"${activeSuite}" cleared.` : 'Failed to clear.', !res.ok);
    await refresh();
  }

  // ------------------------------------------------------------- init
  document.addEventListener('DOMContentLoaded', async () => {
    $('startStopBtn').addEventListener('click', toggleRecording);
    $('replayBtn').addEventListener('click', replay);
    $('stopReplayBtn').addEventListener('click', stopReplay);
    $('exportBtn').addEventListener('click', exportJson);
    $('clearBtn').addEventListener('click', clearCurrent);

    // URL pattern row
    $('urlSaveBtn').addEventListener('click', saveUrlPattern);
    $('urlRegexBtn').addEventListener('click', () => {
      $('urlRegexBtn').classList.toggle('active');
    });
    $('urlInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveUrlPattern();
    });

    // Edit modal
    $('editSaveBtn').addEventListener('click', () => {
      closeEditModal({
        selector: $('editSelector').value.trim(),
        value: $('editValue').value,
        delay: $('editDelay').value
      });
    });
    $('editCancelBtn').addEventListener('click', () => closeEditModal(null));
    $('editModal').addEventListener('click', (e) => {
      if (e.target === $('editModal')) closeEditModal(null); // click backdrop to cancel
    });
    // Save on Enter in either field
    [$('editSelector'), $('editValue'), $('editDelay')].forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('editSaveBtn').click();
        if (e.key === 'Escape') closeEditModal(null);
      });
    });

    // Suite bar
    $('suiteDropdown').addEventListener('change', (e) => switchSuite(e.target.value));
    $('newSuiteBtn').addEventListener('click', addSuite);
    $('editSuiteBtn').addEventListener('click', editSuite);
    $('deleteSuiteBtn').addEventListener('click', deleteSuite);
    $('importSuiteBtn').addEventListener('click', () => $('importSuiteFile').click());
    $('importSuiteFile').addEventListener('change', importSuite);

    // Debug log toggle — persisted in storage, default: hidden (checked)
    const hideLogChk = $('hideLogChk');
    const { arHideLog } = await chrome.storage.local.get('arHideLog');
    hideLogChk.checked = arHideLog !== false; // default true
    hideLogChk.addEventListener('change', async () => {
      await chrome.storage.local.set({ arHideLog: hideLogChk.checked });
      // Notify the active tab's content script immediately
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { type: 'SET_HIDE_LOG', value: hideLogChk.checked }).catch(() => {});
      }
    });

    await refresh();
  });

  // Live updates while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = Object.keys(changes).some(
      (k) => k === 'arRecording' || k === 'arActiveSuite' || k === 'arSuites' || k.startsWith('arSession__')
    );
    if (relevant) refresh();
  });

  // Relay events from content scripts (via background) while popup is open.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'REPLAY_STARTED') {
      isReplaying = true;
      setReplayProgress(0, (currentSession && currentSession.steps.length) || 0, '');
      showStatus('Replaying…');
      render();
    } else if (message.type === 'REPLAY_STEP') {
      const d = message.data || {};
      setReplayProgress(d.current, d.total, d.selector);
      showStatus(`Step ${d.current} / ${d.total} — ${d.stepType}`);
    } else if (message.type === 'REPLAY_FINISHED') {
      isReplaying = false;
      setReplayProgress(null);
      showStatus('Replay finished.');
      render();
    } else if (message.type === 'REPLAY_EVENT') {
      const d = message.data || {};
      showStatus(`Step ${d.step}: ${d.text}`, d.level === 'error' || d.level === 'warn');
    } else if (message.type === 'HOVER_SELECTOR') {
      // selector shown on-page overlay only — nothing to do in popup
    }
  });
})();
