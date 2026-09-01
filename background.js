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
  return { ok: true };
}

async function stopRecording() {
  const { arRecording, arActiveSuite } = await chrome.storage.local.get(['arRecording', 'arActiveSuite']);
  const suiteName = arActiveSuite || 'suite1';
  const key = suiteKey(suiteName);

  if (arRecording && arRecording.active) {
    const stored = await chrome.storage.local.get(key);
    const session = stored[key] || { suiteName, steps: [] };
    session.endedAt = Date.now();
    await chrome.storage.local.set({ [key]: session });
  }

  await chrome.storage.local.set({
    arRecording: { active: false, tabId: null, url: '', startedAt: 0 }
  });
  broadcast({ type: 'SET_RECORDING', value: false });
  return { ok: true };
}

async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id != null) await sendToTab(t.id, message);
  }
}

// ------------------------------------------------------------- replay

async function startReplay(tabId, urlPattern, urlIsRegex) {
  const msg = { type: 'SET_REPLAY', value: true, urlPattern: urlPattern || '', urlIsRegex: !!urlIsRegex };
  if (!await sendToTab(tabId, msg)) {
    await ensureContentScript(tabId);
    await sendToTab(tabId, msg);
  }
  return { ok: true };
}

async function stopReplay() {
  await broadcast({ type: 'SET_REPLAY', value: false });
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
      case 'START_REPLAY':
        sendResponse(await startReplay(message.tabId, message.urlPattern, message.urlIsRegex));
        break;
      case 'STOP_REPLAY':
        sendResponse(await stopReplay());
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
      case 'STEP_RECORDED':
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
