// Action Recorder - popup logic
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let currentSession = null;
  let recordingState = { active: false, tabId: null, url: '', startedAt: 0 };
  let statusTimer = null;

  const sendMsg = (type, data = {}) =>
    chrome.runtime.sendMessage({ type, ...data })
      .then((res) => !!(res && res.ok))
      .catch(() => false);

  function showStatus(text, isError = false) {
    const el = $('status');
    el.textContent = text;
    el.className = 'msg ' + (isError ? 'error' : 'info');
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  function fmtTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  // ----------------------------- storage -> UI
  async function refresh() {
    const data = await chrome.storage.local.get(['arSession', 'arRecording']);
    currentSession = data.arSession || null;
    recordingState = data.arRecording || { active: false, tabId: null, url: '', startedAt: 0 };
    render();
  }

  function render() {
    const steps = (currentSession && currentSession.steps) || [];

    const btn = $('startStopBtn');
    if (recordingState.active) {
      btn.textContent = '⏹ Stop Recording';
      btn.classList.add('recording');
    } else {
      btn.textContent = '▶ Start Recording';
      btn.classList.remove('recording');
    }

    $('replayBtn').disabled = steps.length === 0 || recordingState.active;
    $('stopReplayBtn').disabled = steps.length === 0;
    $('exportBtn').disabled = steps.length === 0;
    $('clearBtn').disabled = steps.length === 0 && !recordingState.active;

    const dot = $('statusDot');
    const line = $('statusLine');
    if (recordingState.active) {
      dot.classList.add('on');
      line.textContent = 'Recording active';
    } else {
      dot.classList.remove('on');
      line.textContent = 'Ready';
    }

    const meta = $('meta');
    const parts = [];
    if (currentSession && currentSession.url) parts.push(`URL: ${currentSession.url}`);
    if (currentSession && currentSession.startedAt) parts.push(`Start: ${fmtTime(currentSession.startedAt)}`);
    if (currentSession && currentSession.endedAt) parts.push(`End: ${fmtTime(currentSession.endedAt)}`);
    if (steps.length) parts.push(`Steps: ${steps.length}`);
    meta.textContent = parts.join('  ·  ');

    renderList(steps);
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
      badge.className = 'badge ' + (step.type === 'click' ? 'b-click' : 'b-fill');
      badge.textContent = step.type === 'click' ? 'CLICK' : 'FILL';

      const body = document.createElement('div');
      body.className = 'step-body';

      const sel = document.createElement('div');
      sel.className = 'step-sel';
      sel.textContent = step.selector;
      sel.title = step.selector;

      const val = document.createElement('div');
      val.className = 'step-val';
      if (step.type === 'fill') val.textContent = `value: ${step.value}`;
      else if (step.text) val.textContent = `text: ${step.text}`;
      else if (step.href) val.textContent = step.href;

      body.appendChild(sel);
      if (val.textContent) body.appendChild(val);
      row.append(idx, badge, body);
      list.appendChild(row);
    });
  }

  // ----------------------------- actions
  async function toggleRecording() {
    if (recordingState.active) {
      const ok = await sendMsg('STOP_RECORDING');
      showStatus(ok ? 'Recording stopped.' : 'Failed to stop recording.', !ok);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id == null) { showStatus('No active tab found.', true); return; }
      if (!/^https?:/.test(tab.url || '')) {
        showStatus('Cannot record on this page type (chrome://, etc).', true);
        return;
      }
      const ok = await sendMsg('START_RECORDING', { tabId: tab.id });
      showStatus(ok ? 'Recording started — click & type on the page.' : 'Failed to start recording.', !ok);
    }
    await refresh();
  }

  async function replay() {
    if (!currentSession || !currentSession.steps.length) { showStatus('Nothing to replay.', true); return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) { showStatus('No active tab found.', true); return; }
    if (!/^https?:/.test(tab.url || '')) { showStatus('Cannot replay on this page type.', true); return; }
    const ok = await sendMsg('START_REPLAY', { tabId: tab.id });
    showStatus(ok ? 'Replaying…' : 'Failed to start replay.', !ok);
  }

  async function stopReplay() {
    const ok = await sendMsg('STOP_REPLAY');
    showStatus(ok ? 'Replay stopped.' : 'Nothing to stop.', !ok);
  }

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
    a.download = `action-recording-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 200);
    showStatus(`Exported ${currentSession.steps.length} steps as JSON.`);
  }

  async function clearAll() {
    if (recordingState.active) {
      if (!confirm('Stop recording and clear all steps?')) return;
    } else if (currentSession && currentSession.steps && currentSession.steps.length) {
      if (!confirm('Clear all recorded steps?')) return;
    }
    const ok = await sendMsg('CLEAR_SESSION');
    showStatus(ok ? 'Cleared.' : 'Failed to clear.', !ok);
    await refresh();
  }

  // ----------------------------- init
  document.addEventListener('DOMContentLoaded', async () => {
    $('startStopBtn').addEventListener('click', toggleRecording);
    $('replayBtn').addEventListener('click', replay);
    $('stopReplayBtn').addEventListener('click', stopReplay);
    $('exportBtn').addEventListener('click', exportJson);
    $('clearBtn').addEventListener('click', clearAll);
    await refresh();
  });

  // Live updates while the popup is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.arSession || changes.arRecording)) refresh();
  });

  // Relay events from content scripts (via background) while popup is open.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'REPLAY_STARTED') showStatus('Replay started.');
    else if (message.type === 'REPLAY_FINISHED') showStatus('Replay finished.');
    else if (message.type === 'REPLAY_EVENT') {
      const d = message.data || {};
      showStatus(`Replay step ${d.step}: ${d.text}`, d.level === 'error');
    }
  });
})();