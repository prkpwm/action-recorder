// Action Recorder - background service worker (MV3)

const CONTENT_SCRIPT = 'content.js';

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

  // Prefer the declaratively-injected content script; fall back to injection.
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
  const { arRecording, arSession } = await chrome.storage.local.get(['arRecording', 'arSession']);
  const session = arSession || { steps: [] };
  if (arRecording && arRecording.active) {
    session.endedAt = Date.now();
  }
  await chrome.storage.local.set({
    arRecording: { active: false, tabId: null, url: '', startedAt: 0 },
    arSession: session
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

async function startReplay(tabId) {
  if (!await sendToTab(tabId, { type: 'SET_REPLAY', value: true })) {
    await ensureContentScript(tabId);
    await sendToTab(tabId, { type: 'SET_REPLAY', value: true });
  }
  return { ok: true };
}

async function stopReplay() {
  await broadcast({ type: 'SET_REPLAY', value: false });
  return { ok: true };
}

async function clearSession() {
  await chrome.storage.local.set({
    arSession: null,
    arRecording: { active: false, tabId: null, url: '', startedAt: 0 }
  });
  await broadcast({ type: 'SET_RECORDING', value: false });
  return { ok: true };
}

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
        sendResponse(await startReplay(message.tabId));
        break;
      case 'STOP_REPLAY':
        sendResponse(await stopReplay());
        break;
      case 'CLEAR_SESSION':
        sendResponse(await clearSession());
        break;

      // Events coming in from content scripts - relay to the popup if open.
      case 'STEP_RECORDED':
      case 'REPLAY_STARTED':
      case 'REPLAY_FINISHED':
      case 'REPLAY_EVENT':
        chrome.runtime.sendMessage(message).catch(() => {});
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the message channel open for the async response
});