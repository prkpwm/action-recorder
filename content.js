(() => {
  'use strict';
  // Guard against double injection (declarative + executeScript fallback).
  if (window.__actionRecorderInjected) return;
  window.__actionRecorderInjected = true;

  // Returns true when the extension context is still valid.
  function ctxOk() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  const storageGet = (keys) => {
    if (!ctxOk()) return Promise.reject(new Error('context invalidated'));
    return chrome.storage.local.get(keys);
  };
  const storageSet = (obj) => {
    if (!ctxOk()) return Promise.reject(new Error('context invalidated'));
    return chrome.storage.local.set(obj);
  };

  // ------------------------------------------------------------- state
  let recording = false;
  let replaying = false;
  let lastHoverEl = null;
  let lastStepTime = 0;
  const lastInputValues = new WeakMap();

  const STYLE_ID = 'ar-style';
  const FLASH_CLS = 'ar-flash';

  // ------------------------------------------------------------- utils
  const esc = (s) => CSS.escape(s);
  const attr = (s) => String(s == null ? '' : s).replace(/"/g, '\\"');
  const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));
  const trimmed = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function safeSend(message) {
    if (!ctxOk()) return;
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* context invalidated */ }
  }

  // Build a readable, fairly unique CSS path for an element.
  function getCssPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + esc(node.id);
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName
        );
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  // Prefer stable attributes (name, id, data-testid, aria-label) over a path.
  function getBestSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = el.tagName.toLowerCase();

    const name = el.getAttribute('name');
    if (name) {
      const s = `${tag}[name="${attr(name)}"]`;
      if (document.querySelector(s)) return s;
    }
    const id = el.getAttribute('id');
    if (id) {
      const s = `#${esc(id)}`;
      if (document.querySelector(s)) return s;
    }
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-qa');
    if (testid) {
      const s = `[data-testid="${attr(testid)}"]`;
      if (document.querySelector(s)) return s;
    }
    const label = el.getAttribute('aria-label');
    if (label) {
      const s = `[aria-label="${attr(label)}"]`;
      if (document.querySelectorAll(s).length === 1) return s;
    }
    return getCssPath(el);
  }

  function elInfo(el) {
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      text: trimmed(el.hasChildNodes() ? el.textContent : (el.getAttribute('aria-label') || '')),
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      href: (el.tagName === 'A' && el.href) ? el.href : (el.getAttribute('href') || ''),
      value: (el.value !== undefined && el.value !== null) ? String(el.value) : ''
    };
  }

  // ------------------------------------------------------------- recording
  // Returns the storage key for a given suite name's session data.
  function suiteKey(suiteName) {
    return `arSession__${suiteName}`;
  }

  async function recordStep(step) {
    if (!ctxOk()) return;
    const now = Date.now();
    const delay = lastStepTime ? Math.min(Math.round(now - lastStepTime), 60000) : 0;
    lastStepTime = now;

    const base = {
      delay,
      url: location.href,
      timestamp: now
    };
    Object.assign(step, base);

    const { arRecording, arActiveSuite } = await storageGet(['arRecording', 'arActiveSuite']);
    const suiteName = arActiveSuite || 'suite1';
    const key = suiteKey(suiteName);

    const stored = await storageGet(key);
    let session = stored[key] || {
      suiteName,
      url: location.href,
      startedAt: arRecording && arRecording.startedAt ? arRecording.startedAt : now,
      steps: []
    };
    if (!session.steps) session.steps = [];
    if (!session.url) session.url = location.href;
    session.url = location.href;
    session.steps.push(step);

    await storageSet({ [key]: session });
    safeSend({ type: 'STEP_RECORDED', data: step });
  }

  function recordFill(el, force) {
    if (!recording || replaying) return;
    const isCheck = el.type === 'checkbox' || el.type === 'radio';
    if (!force) {
      if (lastInputValues.get(el) === el.value) return; // unchanged since last record
    }
    lastInputValues.set(el, el.value);
    recordStep({
      type: 'fill',
      selector: getBestSelector(el),
      name: el.getAttribute('name') || el.getAttribute('id') || '',
      value: isCheck ? String(el.checked) : String(el.value)
    });
  }

  function handleClick(e) {
    if (!recording || replaying) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.closest && el.closest('#ar-overlay, .' + FLASH_CLS)) return;

    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const t = (el.type || '').toLowerCase();
      if (!(tag === 'INPUT' && (t === 'submit' || t === 'button' || t === 'reset' || t === 'image'))) {
        return;
      }
    }
    recordStep({ type: 'click', selector: getBestSelector(el), ...elInfo(el) });
  }

  function handleInput(e) {
    if (!recording || replaying) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      recordFill(el, true);
    }
  }

  function handleChange(e) {
    if (!recording || replaying) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.tagName === 'SELECT' ||
        (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio'))) {
      recordFill(el, true);
    }
  }

  function handleOver(e) {
    if (!recording || replaying) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el === lastHoverEl) return;
    lastHoverEl = el;
    const selector = getBestSelector(el);
    positionOverlay(el, selector);
    safeSend({ type: 'HOVER_SELECTOR', selector });
  }

  function clearHover() {
    lastHoverEl = null;
    hideOverlay();
    if (recording) safeSend({ type: 'HOVER_SELECTOR', selector: '' });
  }

  // ------------------------------------------------------------- hover overlay (full border + selector label)
  let hoverOverlay = null;
  let hoverLabel = null;

  function getOrCreateOverlay() {
    if (hoverOverlay) return hoverOverlay;

    hoverOverlay = document.createElement('div');
    hoverOverlay.id = 'ar-hover-overlay';
    hoverOverlay.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483647',
      'box-sizing:border-box',
      'border:2px dashed #ff5722',
      'border-radius:4px',
      'display:none'
    ].join(';');

    hoverLabel = document.createElement('span');
    hoverLabel.style.cssText = [
      'position:absolute',
      'left:-2px',
      'background:#ff5722',
      'color:#fff',
      'font-family:Consolas,Monaco,"Courier New",monospace',
      'font-size:11px',
      'line-height:1.3',
      'padding:2px 6px',
      'border-radius:3px 3px 3px 0',
      'white-space:nowrap',
      'max-width:360px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'pointer-events:none'
    ].join(';');

    hoverOverlay.appendChild(hoverLabel);
    document.documentElement.appendChild(hoverOverlay);
    return hoverOverlay;
  }

  function positionOverlay(el, selector) {
    const overlay = getOrCreateOverlay();
    const r = el.getBoundingClientRect();

    // Size the overlay to exactly cover the element
    overlay.style.top    = (r.top  - 2) + 'px';
    overlay.style.left   = (r.left - 2) + 'px';
    overlay.style.width  = (r.width  + 4) + 'px';
    overlay.style.height = (r.height + 4) + 'px';
    overlay.style.display = 'block';

    if (hoverLabel) {
      hoverLabel.textContent = selector || '';
      const labelH = hoverLabel.offsetHeight || 20;

      // Prefer above the top border; fall back to inside-top if no room
      if (r.top - 2 >= labelH + 2) {
        hoverLabel.style.top    = (-labelH - 2) + 'px';
        hoverLabel.style.bottom = '';
      } else {
        hoverLabel.style.top    = '2px';
        hoverLabel.style.bottom = '';
      }
    }
  }

  function hideOverlay() {
    if (hoverOverlay) hoverOverlay.style.display = 'none';
  }
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${FLASH_CLS} { outline: 3px solid #4caf50 !important; outline-offset: 2px !important; border-radius: 3px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function attachListeners() {
    ensureStyle();
    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('mouseover', handleOver, true);
    document.addEventListener('mouseout', clearHover, true);
  }

  function detachListeners() {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('mouseover', handleOver, true);
    document.removeEventListener('mouseout', clearHover, true);
    clearHover();
    if (hoverOverlay) { hoverOverlay.remove(); hoverOverlay = null; hoverLabel = null; }
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  function setRecording(value) {
    if (value && !recording) {
      recording = true;
      lastStepTime = 0;
      attachListeners();
    } else if (!value && recording) {
      recording = false;
      detachListeners();
    }
  }

  // ------------------------------------------------------------- replay
  function flash(el) {
    el.classList.add(FLASH_CLS);
    setTimeout(() => el.classList.remove(FLASH_CLS), 900);
  }

  function clickElement(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === 'function') el.click();
  }

  function fillElement(el, step) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
    el.focus();
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = step.value === 'true';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, step.value || '');
      else el.value = step.value || '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.blur();
  }

  let replayCancel = false;

  async function runReplay() {
    if (!ctxOk()) return;
    // Read the active suite's session.
    const { arActiveSuite } = await storageGet('arActiveSuite');
    const suiteName = arActiveSuite || 'suite1';
    const key = suiteKey(suiteName);
    const stored = await storageGet(key);
    const session = stored[key];

    if (!session || !session.steps || !session.steps.length) return;
    if (recording) setRecording(false);

    replaying = true;
    replayCancel = false;
    safeSend({ type: 'REPLAY_STARTED' });

    const steps = session.steps;
    for (let i = 0; i < steps.length; i++) {
      if (replayCancel) break;
      const step = steps[i];
      await waitFor(step.delay > 0 ? Math.min(step.delay, 10000) : 500);
      if (replayCancel) break;

      const el = document.querySelector(step.selector);
      if (!el) {
        safeSend({ type: 'REPLAY_EVENT', data: { level: 'warn', step: i + 1, text: `Element not found: ${step.selector}` } });
        continue;
      }
      try {
        if (step.type === 'click') clickElement(el);
        else if (step.type === 'fill') fillElement(el, step);
      } catch (err) {
        safeSend({ type: 'REPLAY_EVENT', data: { level: 'error', step: i + 1, text: `Step ${i + 1} failed: ${err}` } });
      }
      await waitFor(250);
    }

    replaying = false;
    safeSend({ type: 'REPLAY_FINISHED' });
  }

  // ------------------------------------------------------------- messaging
  function setReplay(value) {
    if (value) {
      if (!replaying) runReplay();
    } else {
      replayCancel = true;
      replaying = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!ctxOk()) return;
    if (message.type === 'SET_RECORDING') {
      setRecording(!!message.value);
      sendResponse({ ok: true });
    } else if (message.type === 'SET_REPLAY') {
      setReplay(!!message.value);
      sendResponse({ ok: true });
    }
  });

  // ------------------------------------------------------------- init
  (async () => {
    if (!ctxOk()) return;
    const { arRecording } = await storageGet('arRecording');
    if (arRecording && arRecording.active && !recording) {
      setRecording(true);
      // Session may have started on a previous page: keep the URL fresh.
      const { arActiveSuite } = await storageGet('arActiveSuite');
      const suiteName = arActiveSuite || 'suite1';
      const key = suiteKey(suiteName);
      const stored = await storageGet(key);
      const session = stored[key];
      if (session && session.url !== location.href) {
        session.url = location.href;
        await storageSet({ [key]: session });
      }
    }
  })();
})();
