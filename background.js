// Action Recorder - background service worker (MV3)

const CONTENT_SCRIPT = 'content.js';

// ------------------------------------------------------------- helpers

function suiteKey(suiteName) {
  return `arSession__${suiteName}`;
}

async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (e) {
    return false;
  }
}

// Send a message to every frame (main + all iframes) in a tab.
// Falls back to sendToTab (main frame only) when webNavigation API is unavailable.
async function sendToAllFrames(tabId, message) {
  let frames = null;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (e) {
    // webNavigation not available — send to main frame only
    return sendToTab(tabId, message);
  }
  if (!frames || frames.length === 0) return sendToTab(tabId, message);
  let anyOk = false;
  for (const frame of frames) {
    try {
      await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
      anyOk = true;
    } catch (e) { /* frame may not have content script — skip */ }
  }
  return anyOk;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (e) {
    // Already injected, or page type not injectable - ignore.
  }
}

// Returns the current active suite name, creating suite list + default if missing.
async function getActiveSuite() {
  const { arActiveSuite, arSuites } = await chrome.storage.local.get(['arActiveSuite', 'arSuites']);
  const suites = arSuites && arSuites.length ? arSuites : ['suite1'];
  const active = arActiveSuite && suites.includes(arActiveSuite) ? arActiveSuite : suites[0];
  return { active, suites };
}

// ------------------------------------------------------------- network capture
// While recording is active we buffer every completed XHR/fetch request for
// the recording tab. When a STEP_RECORDED message arrives from the content
// script we drain all requests that finished AFTER the previous step's
// timestamp and attach them as step.networkRequests = [...].
//
// Each entry: { url, method, status, duration, timestamp, requestBody, responseBody }
// We skip browser-internal URLs, extension URLs, and static assets
// (images, fonts, css, js) to keep the list focused on API calls.

const netBuffer = [];   // { url, method, status, duration, timestamp, requestBody, responseBody }
const pendingRequests = new Map(); // requestId → { url, method, startTime, requestBody }
let netRecordingTabId = null;
let lastStepTimestamp = 0;

// Map of requestId → responseBody string, populated by debugger events.
const responseBodyMap = new Map();
// Map of requestId → resolve function waiting for response body
const responseBodyWaiters = new Map();

const ASSET_EXT = /\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|css|js|map)(\?.*)?$/i;

function shouldCaptureUrl(url) {
  if (!url) return false;
  if (url.startsWith('chrome-extension://')) return false;
  if (url.startsWith('chrome://')) return false;
  if (ASSET_EXT.test(url.split('?')[0])) return false;
  return true;
}

// ----- debugger-based response body capture -----
let debuggerAttached = false;

async function attachDebugger(tabId) {
  if (debuggerAttached) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    debuggerAttached = true;

    chrome.debugger.onEvent.addListener(onDebuggerEvent);
    chrome.debugger.onDetach.addListener(() => {
      debuggerAttached = false;
      chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    });
  } catch (e) {
    // Debugger may already be attached by DevTools — fall back gracefully
    debuggerAttached = false;
  }
}

async function detachDebugger(tabId) {
  if (!debuggerAttached) return;
  try {
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    await chrome.debugger.detach({ tabId });
  } catch {}
  debuggerAttached = false;
}

function onDebuggerEvent(source, method, params) {
  if (method === 'Network.loadingFinished' || method === 'Network.responseReceived') {
    const requestId = params && params.requestId;
    if (!requestId) return;
    // Fetch response body asynchronously and store it
    chrome.debugger.sendCommand(source, 'Network.getResponseBody', { requestId })
      .then(result => {
        const body = result && result.body ? result.body : '';
        responseBodyMap.set(requestId, body);
        // Resolve any waiter for this requestId
        const waiter = responseBodyWaiters.get(requestId);
        if (waiter) { waiter(body); responseBodyWaiters.delete(requestId); }
      })
      .catch(() => {
        responseBodyMap.set(requestId, '');
      });
  }
}

// Wait up to 2s for the response body of a requestId to be fetched by debugger
function waitForResponseBody(requestId) {
  if (responseBodyMap.has(requestId)) {
    return Promise.resolve(responseBodyMap.get(requestId));
  }
  return new Promise(resolve => {
    responseBodyWaiters.set(requestId, resolve);
    setTimeout(() => {
      responseBodyWaiters.delete(requestId);
      resolve(responseBodyMap.get(requestId) || '');
    }, 2000);
  });
}

function startNetCapture(tabId) {
  stopNetCapture(); // remove any previous listeners first
  netRecordingTabId = tabId;
  netBuffer.length = 0;
  pendingRequests.clear();
  responseBodyMap.clear();
  responseBodyWaiters.clear();
  lastStepTimestamp = 0;

  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: ['<all_urls>'], tabId },
    ['requestBody']
  );
  chrome.webRequest.onCompleted.addListener(
    onCompleted,
    { urls: ['<all_urls>'], tabId },
    ['responseHeaders']
  );
  chrome.webRequest.onErrorOccurred.addListener(
    onErrorOccurred,
    { urls: ['<all_urls>'], tabId },
    []
  );

  attachDebugger(tabId);
}

function stopNetCapture() {
  try { chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest); } catch {}
  try { chrome.webRequest.onCompleted.removeListener(onCompleted); } catch {}
  try { chrome.webRequest.onErrorOccurred.removeListener(onErrorOccurred); } catch {}
  if (netRecordingTabId != null) detachDebugger(netRecordingTabId);
  netRecordingTabId = null;
  pendingRequests.clear();
  responseBodyMap.clear();
  responseBodyWaiters.clear();
}

function extractRequestBody(details) {
  try {
    const rb = details.requestBody;
    if (!rb) return '';
    if (rb.raw && rb.raw.length > 0) {
      const bytes = rb.raw[0].bytes;
      if (bytes) return new TextDecoder().decode(bytes);
    }
    if (rb.formData) return JSON.stringify(rb.formData);
  } catch {}
  return '';
}

function onBeforeRequest(details) {
  if (!shouldCaptureUrl(details.url)) return;
  pendingRequests.set(details.requestId, {
    url: details.url,
    method: details.method,
    startTime: details.timeStamp,
    requestBody: extractRequestBody(details)
  });
}

// onCompleted MUST be synchronous — Chrome ignores the return value of async
// webRequest listeners. Push to netBuffer immediately, then fill response body
// asynchronously by patching the existing entry in-place.
function onCompleted(details) {
  const pending = pendingRequests.get(details.requestId);
  pendingRequests.delete(details.requestId);
  if (!pending || !shouldCaptureUrl(details.url)) return;

  // Parse request body now (sync)
  let parsedRequest = pending.requestBody;
  try { if (parsedRequest) parsedRequest = JSON.parse(pending.requestBody); } catch {}

  const entry = {
    url: details.url,
    method: details.method || pending.method,
    status: details.statusCode,
    duration: Math.round(details.timeStamp - pending.startTime),
    timestamp: details.timeStamp,
    requestBody: parsedRequest || '',
    responseBody: ''   // filled in async below
  };
  netBuffer.push(entry);

  // Fill response body asynchronously without blocking the listener
  waitForResponseBody(details.requestId).then(body => {
    responseBodyMap.delete(details.requestId);
    let parsed = body;
    try { parsed = JSON.parse(body); } catch {}
    entry.responseBody = parsed || '';
  }).catch(() => {});
}

function onErrorOccurred(details) {
  const pending = pendingRequests.get(details.requestId);
  pendingRequests.delete(details.requestId);
  if (!pending || !shouldCaptureUrl(details.url)) return;
  netBuffer.push({
    url: details.url,
    method: details.method || pending.method,
    status: 0,
    error: details.error,
    duration: Math.round(details.timeStamp - pending.startTime),
    timestamp: details.timeStamp,
    requestBody: pending.requestBody || '',
    responseBody: ''
  });
}

// Drain requests that completed AFTER `sinceTimestamp` and return them.
// Removes drained entries from the buffer.
function drainRequests(sinceTimestamp) {
  const taken = netBuffer.filter(r => r.timestamp >= sinceTimestamp);
  netBuffer.splice(0, netBuffer.length, ...netBuffer.filter(r => r.timestamp < sinceTimestamp));
  return taken;
}

// ------------------------------------------------------------- recording

async function startRecording(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    return { ok: false, error: 'Tab not found.' };
  }
  if (!tab.url || !/^https?:/.test(tab.url)) {
    return { ok: false, error: 'Cannot record on this page type.' };
  }

  const { active, suites } = await getActiveSuite();

  // Ensure suite list and active suite are persisted before the content script runs.
  await chrome.storage.local.set({ arActiveSuite: active, arSuites: suites });

  if (!await sendToTab(tabId, { type: 'SET_RECORDING', value: true })) {
    await ensureContentScript(tabId);
    if (!await sendToTab(tabId, { type: 'SET_RECORDING', value: true })) {
      return { ok: false, error: 'Content script unavailable on this page.' };
    }
  }

  await chrome.storage.local.set({
    arRecording: { active: true, tabId, url: tab.url, startedAt: Date.now() }
  });
  startNetCapture(tabId);
  lastStepTimestamp = Date.now(); // treat recording start as t=0 for first step window
  return { ok: true };
}

async function stopRecording() {
  const { arRecording, arActiveSuite } = await chrome.storage.local.get(['arRecording', 'arActiveSuite']);
  const suiteName = arActiveSuite || 'suite1';
  const key = suiteKey(suiteName);

  // Tell content scripts to stop FIRST, then wait for their in-flight step
  // writes (the serialized recordQueue) to flush before we read the session
  // and stamp endedAt. Without this wait, a final click recorded right before
  // stop can be clobbered by our endedAt write.
  broadcast({ type: 'SET_RECORDING', value: false });
  stopNetCapture();
  await new Promise(r => setTimeout(r, 600));

  if (arRecording && arRecording.active) {
    const stored = await chrome.storage.local.get(key);
    const session = stored[key] || { suiteName, steps: [] };
    session.endedAt = Date.now();
    await chrome.storage.local.set({ [key]: session });
  }

  await chrome.storage.local.set({
    arRecording: { active: false, tabId: null, url: '', startedAt: 0 }
  });
  return { ok: true };
}

// Pause / resume recording without ending the session.
async function setPaused(paused) {
  const { arRecording } = await chrome.storage.local.get('arRecording');
  if (!arRecording || !arRecording.active) {
    return { ok: false, error: 'Not currently recording.' };
  }
  arRecording.paused = !!paused;
  await chrome.storage.local.set({ arRecording });
  await broadcast({ type: 'SET_PAUSED', value: !!paused });
  return { ok: true, paused: !!paused };
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null) await sendToTab(t.id, message);
  }
}

// ------------------------------------------------------------- replay

async function startReplay(tabId, urlPattern, urlIsRegex, startIndex) {
  const msg = { type: 'SET_REPLAY', value: true, urlPattern: urlPattern || '', urlIsRegex: !!urlIsRegex, startIndex: startIndex | 0 };
  if (!await sendToAllFrames(tabId, msg)) {
    await ensureContentScript(tabId);
    await sendToAllFrames(tabId, msg);
  }
  return { ok: true };
}

async function stopReplay() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null) {
      try { await sendToAllFrames(t.id, { type: 'SET_REPLAY', value: false }); } catch { /* ignore */ }
    }
  }
  return { ok: true };
}

async function runSingleStep(tabId, suiteName, stepIndex) {
  const msg = { type: 'RUN_STEP', suiteName, stepIndex };
  if (!await sendToAllFrames(tabId, msg)) {
    await ensureContentScript(tabId);
    await sendToAllFrames(tabId, msg);
  }
  return { ok: true };
}

// ------------------------------------------------------------- suite management

async function addSuite(suiteName) {
  suiteName = (suiteName || '').trim();
  if (!suiteName) return { ok: false, error: 'Suite name cannot be empty.' };

  const { arSuites } = await chrome.storage.local.get('arSuites');
  const suites = arSuites && arSuites.length ? [...arSuites] : ['suite1'];

  if (suites.includes(suiteName)) {
    return { ok: false, error: `Suite "${suiteName}" already exists.` };
  }
  suites.push(suiteName);
  await chrome.storage.local.set({ arSuites: suites, arActiveSuite: suiteName });
  return { ok: true, suites, active: suiteName };
}

async function renameSuite(oldName, newName) {
  newName = (newName || '').trim();
  if (!newName) return { ok: false, error: 'Suite name cannot be empty.' };

  const { arSuites, arActiveSuite } = await chrome.storage.local.get(['arSuites', 'arActiveSuite']);
  const suites = arSuites && arSuites.length ? [...arSuites] : ['suite1'];

  if (!suites.includes(oldName)) return { ok: false, error: `Suite "${oldName}" not found.` };
  if (suites.includes(newName)) return { ok: false, error: `Suite "${newName}" already exists.` };

  // Rename in list
  const idx = suites.indexOf(oldName);
  suites[idx] = newName;

  // Move session data to new key
  const oldKey = suiteKey(oldName);
  const newKey = suiteKey(newName);
  const stored = await chrome.storage.local.get(oldKey);
  const session = stored[oldKey];
  const updates = { arSuites: suites };
  if (session) {
    session.suiteName = newName;
    updates[newKey] = session;
  }
  updates.arActiveSuite = arActiveSuite === oldName ? newName : arActiveSuite;

  await chrome.storage.local.set(updates);
  if (session) await chrome.storage.local.remove(oldKey);

  return { ok: true, suites, active: updates.arActiveSuite };
}

async function deleteSuite(suiteName) {
  const { arSuites, arActiveSuite } = await chrome.storage.local.get(['arSuites', 'arActiveSuite']);
  const suites = arSuites && arSuites.length ? [...arSuites] : ['suite1'];

  if (suites.length <= 1) {
    return { ok: false, error: 'Cannot delete the last suite.' };
  }
  if (!suites.includes(suiteName)) return { ok: false, error: `Suite "${suiteName}" not found.` };

  const newSuites = suites.filter((s) => s !== suiteName);
  const newActive = arActiveSuite === suiteName ? newSuites[0] : arActiveSuite;

  await chrome.storage.local.set({ arSuites: newSuites, arActiveSuite: newActive });
  await chrome.storage.local.remove(suiteKey(suiteName));

  return { ok: true, suites: newSuites, active: newActive };
}

async function switchSuite(suiteName) {
  const { arSuites } = await chrome.storage.local.get('arSuites');
  const suites = arSuites && arSuites.length ? arSuites : ['suite1'];
  if (!suites.includes(suiteName)) return { ok: false, error: `Suite "${suiteName}" not found.` };
  await chrome.storage.local.set({ arActiveSuite: suiteName });
  return { ok: true };
}

// ------------------------------------------------------------- session / clear

// Returns { session, suites, active } for the popup to render.
async function getSessionInfo() {
  const { active, suites } = await getActiveSuite();
  const key = suiteKey(active);
  const stored = await chrome.storage.local.get(key);
  return { ok: true, session: stored[key] || null, suites, active };
}

async function deleteStep(suiteName, stepIndex) {
  const key = suiteKey(suiteName);
  const stored = await chrome.storage.local.get(key);
  const session = stored[key];
  if (!session || !Array.isArray(session.steps)) return { ok: false, error: 'Session not found.' };
  if (stepIndex < 0 || stepIndex >= session.steps.length) return { ok: false, error: 'Step index out of range.' };
  session.steps.splice(stepIndex, 1);
  await chrome.storage.local.set({ [key]: session });
  return { ok: true };
}

async function editStep(suiteName, stepIndex, patch) {
  const key = suiteKey(suiteName);
  const stored = await chrome.storage.local.get(key);
  const session = stored[key];
  if (!session || !Array.isArray(session.steps)) return { ok: false, error: 'Session not found.' };
  if (stepIndex < 0 || stepIndex >= session.steps.length) return { ok: false, error: 'Step index out of range.' };
  // Only allow editing safe fields: selector, value, text, href, delay
  const allowed = ['selector', 'value', 'text', 'href', 'delay'];
  for (const field of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      session.steps[stepIndex][field] = patch[field];
    }
  }
  await chrome.storage.local.set({ [key]: session });
  return { ok: true };
}

async function clearSession(suiteName) {
  // Clear only the specified suite's session (default: active suite).
  const { arActiveSuite } = await chrome.storage.local.get('arActiveSuite');
  const target = suiteName || arActiveSuite || 'suite1';
  await chrome.storage.local.remove(suiteKey(target));
  await chrome.storage.local.set({
    arRecording: { active: false, tabId: null, url: '', startedAt: 0 }
  });
  await broadcast({ type: 'SET_RECORDING', value: false });
  return { ok: true };
}

async function importSuite(session, suiteName) {
  suiteName = (suiteName || '').trim();
  if (!suiteName) return { ok: false, error: 'Suite name cannot be empty.' };
  if (!session || !Array.isArray(session.steps)) {
    return { ok: false, error: 'Invalid session data.' };
  }

  const { arSuites } = await chrome.storage.local.get('arSuites');
  const suites = arSuites && arSuites.length ? [...arSuites] : ['suite1'];

  // Add suite name to list if new
  if (!suites.includes(suiteName)) {
    suites.push(suiteName);
  }

  // Stamp the correct suite name onto the imported session
  session.suiteName = suiteName;

  await chrome.storage.local.set({
    arSuites: suites,
    arActiveSuite: suiteName,
    [suiteKey(suiteName)]: session
  });

  return { ok: true, suites, active: suiteName };
}

async function clearAllSuites() {
  const { arSuites } = await chrome.storage.local.get('arSuites');
  const suites = arSuites && arSuites.length ? arSuites : ['suite1'];
  const keysToRemove = suites.map(suiteKey);
  await chrome.storage.local.remove(keysToRemove);
  // Reset to a single default suite
  await chrome.storage.local.set({
    arSuites: ['suite1'],
    arActiveSuite: 'suite1',
    arRecording: { active: false, tabId: null, url: '', startedAt: 0 }
  });
  await broadcast({ type: 'SET_RECORDING', value: false });
  return { ok: true };
}

// ------------------------------------------------------------- message router

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.type) {
      case 'START_RECORDING':
        sendResponse(await startRecording(message.tabId));
        break;
      case 'STOP_RECORDING':
        sendResponse(await stopRecording());
        break;
      case 'SET_PAUSED':
        sendResponse(await setPaused(message.value));
        break;
      case 'START_REPLAY':
        sendResponse(await startReplay(message.tabId, message.urlPattern, message.urlIsRegex, message.startIndex));
        break;
      case 'STOP_REPLAY':
        sendResponse(await stopReplay());
        break;
      case 'RUN_STEP':
        sendResponse(await runSingleStep(message.tabId, message.suiteName, message.stepIndex));
        break;

      case 'ADD_SUITE':
        sendResponse(await addSuite(message.suiteName));
        break;
      case 'RENAME_SUITE':
        sendResponse(await renameSuite(message.oldName, message.newName));
        break;
      case 'DELETE_SUITE':
        sendResponse(await deleteSuite(message.suiteName));
        break;
      case 'SWITCH_SUITE':
        sendResponse(await switchSuite(message.suiteName));
        break;

      case 'GET_SESSION_INFO':
        sendResponse(await getSessionInfo());
        break;
      case 'CLEAR_SESSION':
        sendResponse(await clearSession(message.suiteName));
        break;
      case 'IMPORT_SUITE':
        sendResponse(await importSuite(message.session, message.suiteName));
        break;
      case 'CLEAR_ALL_SUITES':
        sendResponse(await clearAllSuites());
        break;
      case 'DELETE_STEP':
        sendResponse(await deleteStep(message.suiteName, message.stepIndex));
        break;
      case 'EDIT_STEP':
        sendResponse(await editStep(message.suiteName, message.stepIndex, message.patch));
        break;
      case 'SAVE_SESSION_URL': {
        const key = suiteKey(message.suiteName);
        const stored = await chrome.storage.local.get(key);
        const session = stored[key];
        if (!session) { sendResponse({ ok: false, error: 'Session not found.' }); break; }
        session.urlPattern = message.pattern;
        session.urlIsRegex = !!message.isRegex;
        await chrome.storage.local.set({ [key]: session });
        sendResponse({ ok: true });
        break;
      }

      // Events from content scripts — relay to the popup if open.
      case 'STEP_RECORDED': {
        // Attach network requests that fired since the previous step to this step.
        const step = message.data;
        if (step && typeof step.timestamp === 'number') {
          const captureFrom = lastStepTimestamp;
          lastStepTimestamp = step.timestamp;

          // Wait 1.5s for any in-flight requests triggered by this action to complete
          // before draining. Without this, fast API responses land after drainRequests()
          // and get attributed to the wrong step or dropped entirely.
          await new Promise(r => setTimeout(r, 1500));

          const requests = drainRequests(captureFrom);

          if (requests.length > 0) {
            const { arActiveSuite } = await chrome.storage.local.get('arActiveSuite');
            const sk = suiteKey(arActiveSuite || 'suite1');
            const stored = await chrome.storage.local.get(sk);
            const session = stored[sk];
            if (session && Array.isArray(session.steps) && session.steps.length > 0) {
              // Find the step by timestamp (not just last — fill steps may collapse)
              const idx = session.steps.findLastIndex(s => s.timestamp === step.timestamp)
                ?? session.steps.length - 1;
              const target = session.steps[idx >= 0 ? idx : session.steps.length - 1];
              target.networkRequests = requests;
              await chrome.storage.local.set({ [sk]: session });
              message.data = target;
            }
          }
        }
        chrome.runtime.sendMessage(message).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case 'REPLAY_STARTED':
      case 'REPLAY_STEP':
      case 'REPLAY_FINISHED':
      case 'REPLAY_EVENT':
      case 'HOVER_SELECTOR':
        chrome.runtime.sendMessage(message).catch(() => {});
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep channel open for async response
});
