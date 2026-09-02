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

  // Debug logging — off by default; toggled by the popup "Hide debug logs" checkbox.
  let arLogEnabled = false;
  const arLog = (...args) => { if (arLogEnabled) console.log(...args); };
  const arWarn = (...args) => { if (arLogEnabled) console.warn(...args); };
  const arError = (...args) => { if (arLogEnabled) console.error(...args); };

  // Read persisted preference immediately (async, best-effort)
  storageGet('arHideLog').then(({ arHideLog }) => {
    arLogEnabled = arHideLog === false; // default hide → log disabled
  }).catch(() => {});

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

  // Build an absolute XPath for an element (used as fallback selector).
  function getXPath(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el === document.body) return '/html/body';

    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      // Short-circuit on id — produces a concise absolute path
      if (node.id) {
        parts.unshift(`//*[@id="${node.id.replace(/"/g, '\\"')}"]`);
        return parts.join('/');
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      let idx = 1;
      if (parent) {
        for (const sib of parent.children) {
          if (sib === node) break;
          if (sib.tagName === node.tagName) idx++;
        }
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName
        );
        parts.unshift(siblings.length > 1 ? `${tag}[${idx}]` : tag);
      } else {
        parts.unshift(tag);
      }
      node = parent;
    }
    return '/' + parts.join('/');
  }

  // Evaluate an XPath expression and return the first matching element.
  function queryByXPath(xpath) {
    try {
      const result = document.evaluate(
        xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      return result.singleNodeValue || null;
    } catch (e) {
      return null;
    }
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

    // For nz-select: NEVER use class-based selectors — ng-zorro adds/removes state
    // classes (ant-select-open, ant-select-focused, etc.) dynamically.
    // Use stable attributes first; fall back to :has(#inner-input-id) or nth-of-type.
    if (tag === 'nz-select') {
      const name = el.getAttribute('name');
      if (name) return `nz-select[name="${attr(name)}"]`;
      const id = el.getAttribute('id');
      if (id) return `nz-select#${esc(id)}`;
      const testid = el.getAttribute('data-testid') || el.getAttribute('data-qa');
      if (testid) return `nz-select[data-testid="${attr(testid)}"]`;
      // Use the inner search input's id as a proxy — produces a stable :has() selector
      const innerInput = el.querySelector('input[id]');
      if (innerInput && innerInput.id) {
        const hasSel = `nz-select:has(#${esc(innerInput.id)})`;
        try {
          if (document.querySelectorAll(hasSel).length === 1) return hasSel;
        } catch (e) { /* :has() not supported */ }
      }
      // Fallback: positional index among all nz-select on the page
      const allNz = Array.from(document.querySelectorAll('nz-select'));
      const idx = allNz.indexOf(el);
      return idx >= 0 ? `nz-select:nth-of-type(${idx + 1})` : getCssPath(el);
    }

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

    // Try unique visible text — only for interactive/leaf elements (buttons, links, labels, spans, divs with no child elements)
    const isLeafLike = !el.children.length ||
      ['button', 'a', 'label', 'option', 'li', 'td', 'th', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag);
    if (isLeafLike) {
      const txt = trimmed(el.textContent);
      if (txt && txt.length >= 2 && txt.length <= 80) {
        // XPath: all elements of this tag whose normalised text equals txt
        const xp = `//${tag}[normalize-space(.)="${txt.replace(/"/g, '\\"')}"]`;
        try {
          const res = document.evaluate(`count(${xp})`, document, null, XPathResult.NUMBER_TYPE, null);
          if (res.numberValue === 1) return xp;
        } catch (e) { /* ignore invalid xpath due to special chars */ }
      }
    }

    // Try meaningful class names (skip Angular-generated ones like _ngcontent-*)
    const classes = Array.from(el.classList).filter(
      (c) => !/^_ng|^ng-|^cdk-|^mat-mdc/.test(c) && c.length > 2
    );
    if (classes.length > 0) {
      // Try the full meaningful class combo first (most specific)
      const multi = `${tag}.${classes.map(esc).join('.')}`;
      if (document.querySelectorAll(multi).length === 1) return multi;

      // Try each class individually
      for (const c of classes) {
        const s = `${tag}.${esc(c)}`;
        if (document.querySelectorAll(s).length === 1) return s;
      }

      // Try class alone (without tag) for uniqueness
      for (const c of classes) {
        const s = `.${esc(c)}`;
        if (document.querySelectorAll(s).length === 1) return s;
      }
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

  // ------------------------------------------------------------- dropdown detection helpers

  // Returns the closest custom-dropdown trigger ancestor (mat-select, ng-select, etc.)
  function getDropdownTrigger(el) {
    return el.closest(
      'mat-select, ng-select, .ng-select, [role="combobox"], [role="listbox"], ' +
      '.p-dropdown, .p-multiselect, select2-container, .select2, ' +
      'nz-select, .ant-select'
    );
  }

  // Returns true when el is an option inside a custom dropdown panel
  function isCustomOption(el) {
    return !!(el.closest(
      'mat-option, mat-select-panel, ng-dropdown-panel, .ng-option, ' +
      '[role="option"], [role="listbox"] li, .p-dropdown-items li, .select2-results__option, ' +
      '.cdk-overlay-container mat-option, ' +
      '.ant-select-item-option, .ant-select-item-option-content, nz-option-item, .ant-select-dropdown nz-option-item-group'
    ));
  }

  // Given an option element, find the triggering select element (best effort)
  function findTriggerForOption(optionEl) {
    // Ant Design (nz-select / ant-select) — check FIRST because the panel is a portal
    // overlay that has no ancestor relationship to the trigger. Identify the open
    // nz-select by its ant-select-open class (added by ng-zorro when the panel is open).
    const nzSelectOpen = document.querySelector('nz-select.ant-select-open')
      || document.querySelector('nz-select[nzopen]')
      || document.querySelector('.ant-select.ant-select-open nz-select');
    if (nzSelectOpen) return nzSelectOpen;

    // Check for any nz-select whose inner search input id matches a data attribute on
    // the option panel (best-effort correlation when multiple nz-selects exist).
    const allNzSelects = Array.from(document.querySelectorAll('nz-select'));
    if (allNzSelects.length === 1) return allNzSelects[0];
    // Pick the one whose aria-expanded is true, or the one with ant-select-focused
    const focused = allNzSelects.find(s => s.classList.contains('ant-select-focused'))
      || allNzSelects.find(s => s.querySelector('.ant-select-selection-search-input:focus'));
    if (focused) return focused;

    // Angular Material — panel is in overlay; find the open mat-select
    const matSelect = document.querySelector('mat-select[aria-expanded="true"]')
      || document.querySelector('mat-select.mat-select-invalid')
      || document.querySelector('mat-select');
    if (matSelect) return matSelect;

    // ng-select
    const ngSelect = document.querySelector('ng-select.ng-select-opened')
      || document.querySelector('ng-select');
    if (ngSelect) return ngSelect;

    // Generic: look for an ancestor trigger
    return getDropdownTrigger(optionEl) || optionEl;
  }

  // For Ant Design: return the nz-select-top-control (.ant-select-selector) surface.
  // ng-zorro attaches its (click) host listener to nz-select-top-control, NOT the
  // nz-select host — clicking the host element alone does NOT open the dropdown panel.
  function getAntSelectClickTarget(el) {
    // Walk up to the nz-select host first
    const nzSelect = el.closest('nz-select') ||
      (el.tagName === 'NZ-SELECT' ? el : null);
    if (nzSelect) {
      // Prefer the selector surface — ng-zorro's click handler lives here
      const surface = nzSelect.querySelector('nz-select-top-control, .ant-select-selector');
      if (surface) return surface;
      return nzSelect;
    }
    // Plain .ant-select wrapper without nz-select tag
    if (el.classList.contains('ant-select')) {
      const surface = el.querySelector('nz-select-top-control, .ant-select-selector');
      if (surface) return surface;
      return el;
    }
    return el;
  }

  // Open an ng-zorro nz-select dropdown by clicking nz-select-top-control (the selector
  // surface). ng-zorro's (click) host listener lives on nz-select-top-control in recent
  // versions — clicking the nz-select host alone does NOT open the panel.
  // Pass the already-resolved surface element directly; do NOT re-wrap via getAntSelectClickTarget.
  function openNzSelect(surfaceEl) {
    arLog('[AR:openNzSelect] clicking surface:', surfaceEl.tagName, surfaceEl.className);
    surfaceEl.click();
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
    if (!session.url) session.url = location.href;  // set from first step only

    // If this is a fill step and the last step is also a fill on the same selector,
    // update in place instead of appending (collapses rapid typing into one step).
    const last = session.steps[session.steps.length - 1];
    if (step.type === 'fill' && last && last.type === 'fill' && last.selector === step.selector) {
      last.value = step.value;
      last.timestamp = step.timestamp;
      // keep the original delay (time from previous distinct action)
    } else {
      session.steps.push(step);
    }

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
    // Use the deepest element at the pointer position — e.target can be a
    // container when the real click lands on a child (text node, icon, etc.)
    let el = (typeof e.clientX === 'number' && typeof e.clientY === 'number')
      ? (document.elementFromPoint(e.clientX, e.clientY) || e.target)
      : e.target;
    if (!(el instanceof Element)) return;
    if (el.closest && el.closest('#ar-overlay, #ar-hover-overlay, .' + FLASH_CLS)) return;

    // Debug: log every click captured during recording so we can see if synthetic
    // events from replay's clickElement() accidentally reach this handler.
    arLog('[AR:handleClick]', {
      isTrusted: e.isTrusted,
      type: e.type,
      tag: el.tagName,
      id: el.id,
      class: el.className,
      recording,
      replaying,
      target: el
    });

    // Custom dropdown option click — record as 'select' step
    if (isCustomOption(el)) {
      const optText = trimmed(el.textContent);
      const optValue = el.getAttribute('data-value') || el.getAttribute('value') || optText;
      const trigger = findTriggerForOption(el);
      recordStep({
        type: 'select',
        selector: getBestSelector(trigger),
        value: optValue,
        optionText: optText
      });
      return;
    }

    // Suppress recording clicks on Ant Design trigger internals (.ant-select-selector,
    // .ant-select-selection-search-input, arrow icon, etc.) — these are just "open
    // the dropdown" gestures; the real recorded action is the option click above.
    if (el.closest('nz-select, .ant-select')) {
      arLog('[AR:handleClick] suppressed — click inside nz-select / .ant-select trigger (not an option)');
      return;
    }

    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const t = (el.type || '').toLowerCase();
      if (!(tag === 'INPUT' && (t === 'submit' || t === 'button' || t === 'reset' || t === 'image'))) {
        return;
      }
    }

    // Skip recording clicks on large layout containers (sidebars, navbars, wrappers)
    // that have no stable identity and contain many children — these are accidental
    // clicks that produce unplayable steps and pollute the recorded suite.
    // A container is considered "noise" if it: has children, no id/name/data-testid,
    // is a block-level div/nav/aside/header/footer, and has >5 children.
    const noiseTags = new Set(['DIV', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'SECTION', 'MAIN', 'UL', 'OL']);
    if (noiseTags.has(tag)) {
      const hasStableId = el.id && el.id.trim();
      const hasTestId = el.getAttribute('data-testid') || el.getAttribute('data-qa');
      const hasRole = el.getAttribute('role');
      const isInteractive = el.getAttribute('tabindex') != null || el.getAttribute('aria-expanded') != null;
      if (!hasStableId && !hasTestId && !hasRole && !isInteractive && el.children.length > 5) {
        arLog('[AR:handleClick] suppressed — large layout container with no stable identity', {
          tag, children: el.children.length, class: el.className
        });
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
    if (el.tagName === 'SELECT') {
      // Native select — record as 'select' with both value and visible text
      const selectedOpt = el.options[el.selectedIndex];
      const optText = selectedOpt ? trimmed(selectedOpt.textContent) : '';
      recordStep({
        type: 'select',
        selector: getBestSelector(el),
        name: el.getAttribute('name') || el.getAttribute('id') || '',
        value: String(el.value),
        optionText: optText
      });
    } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
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

  // Simulate real mouse movement by firing mouseenter on every ancestor from
  // <body> down to el (top-down, as the browser does on actual pointer entry).
  // This is critical for Angular components that show/expand on (mouseenter) —
  // e.g. a sidebar that must be hovered before its menu items are clickable.
  function dispatchHoverChain(el) {
    // Collect ancestors from body → el
    const chain = [];
    let node = el;
    while (node && node !== document.documentElement) {
      chain.unshift(node);
      node = node.parentElement;
    }
    for (const ancestor of chain) {
      ancestor.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true,  cancelable: true, view: window }));
      ancestor.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }));
    }
    arLog('[AR:clickElement] hover dispatched on', {
      tag: el.tagName, id: el.id, class: el.className, text: trimmed(el.textContent).slice(0, 60)
    });
  }

  function clickElement(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
    arLog('[AR:clickElement] dispatching mouse events on', {
      tag: el.tagName, id: el.id, class: el.className, text: trimmed(el.textContent).slice(0, 60)
    });
    // Fire mouseenter on the full ancestor chain first (top-down) so Angular
    // sidebar/menu components that expand on (mouseenter) are open before the click.
    dispatchHoverChain(el);
    // Use native .click() as the primary mechanism — it is trusted in most browsers
    // and triggers Angular (click) host-listeners, routerLink, and other framework
    // bindings that ignore synthetic MouseEvent dispatches (isTrusted: false).
    if (typeof el.click === 'function') {
      el.click();
    } else {
      // Fallback for elements that don't have a native .click() method
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }

  async function fillElement(el, step) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
    el.focus();
    if (el.type === 'checkbox' || el.type === 'radio') {
      el.checked = step.value === 'true';
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(50);
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, cancelable: true, relatedTarget: null }));
      el.dispatchEvent(new FocusEvent('blur',      { bubbles: false, cancelable: false, relatedTarget: null }));
      el.blur();
      return;
    } else if (el.tagName === 'SELECT') {
      // Native select — delegate to selectElement
      await selectElement(el, step);
      return;
    } else {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, step.value || '');
      else el.value = step.value || '';
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Give the framework (Angular/React/Vue) a tick to process the value change,
    // then fire focusout (bubbles — needed for Angular reactive form touched state)
    // before the native blur so validators and UI state update correctly.
    await waitFor(50);
    // Angular ControlValueAccessor listens to 'input' and 'change'  ✓ (already fired above)
    // Angular reactive forms mark 'touched' on 'focusout' (bubbles)
    // React SyntheticEvent listens to 'change' (bubbles) + 'blur' (non-bubbling via capture)
    // Vue uses 'input'/'change' + native blur
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true,  cancelable: true,  relatedTarget: null }));
    el.dispatchEvent(new FocusEvent('blur',      { bubbles: false, cancelable: false, relatedTarget: null }));
    el.blur();
  }

  // Select an option in a native <select> or trigger a custom dropdown.
  async function selectElement(el, step) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);

    // --- Native <select> ---
    if (el.tagName === 'SELECT') {
      el.focus();
      // Try matching by value first, then by visible text
      let matched = false;
      for (const opt of el.options) {
        if (opt.value === step.value || trimmed(opt.textContent) === step.optionText) {
          el.value = opt.value;
          matched = true;
          break;
        }
      }
      if (matched) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input',  { bubbles: true }));
      }
      await waitFor(50);
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true,  cancelable: true,  relatedTarget: null }));
      el.dispatchEvent(new FocusEvent('blur',      { bubbles: false, cancelable: false, relatedTarget: null }));
      el.blur();
    
      return;
    }

    // --- Custom dropdown (mat-select, ng-select, etc.) ---
    // Step 1: open the dropdown by clicking the trigger
    const isNzSelect = el.tagName === 'NZ-SELECT' || !!el.closest('nz-select');
    // getAntSelectClickTarget returns nz-select-top-control for nz-select elements
    // (the surface where ng-zorro's click handler actually lives).
    const clickTarget = getAntSelectClickTarget(el);

    arLog('[AR:dropdown] Step 1 — opening trigger', {
      elTag: el.tagName, elId: el.id,
      clickTargetTag: clickTarget.tagName, clickTargetClass: clickTarget.className,
      isNzSelect, optionText: step.optionText, value: step.value
    });

    if (isNzSelect) {
      openNzSelect(clickTarget);   // clickTarget is already the surface; openNzSelect just .click()s it
    } else {
      clickElement(clickTarget);
    }
    arLog('[AR:dropdown] clickElement() dispatched — waiting 600ms for panel to open');
    await waitFor(600);

    // Snapshot the DOM immediately after open to see what's there
    const optionSelectors = [
      'mat-option', '.ng-option', '[role="option"]',
      '.p-dropdown-item', '.select2-results__option',
      '.cdk-overlay-container [role="option"]',
      '.ant-select-item-option',
      'nz-option-item',
      'li.ant-select-item'
    ];

    arLog('[AR:dropdown] Post-open DOM snapshot:', {
      nzOptionItem: document.querySelectorAll('nz-option-item').length,
      antSelectItemOption: document.querySelectorAll('.ant-select-item-option').length,
      roleOption: document.querySelectorAll('[role="option"]').length,
      antDropdownVisible: !!document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'),
      nzSelectOpen: !!document.querySelector('nz-select.ant-select-open'),
    });

    // Step 2: find and click the matching option in the panel
    for (let attempt = 0; attempt < 5; attempt++) {
      await waitFor(300);
      let optionEl = null;

      arLog(`[AR:dropdown] Attempt ${attempt + 1}/5 — scanning for option "${step.optionText}" / value "${step.value}"`);

      for (const sel of optionSelectors) {
        const candidates = Array.from(document.querySelectorAll(sel));
        // Match by optionText first, then value attribute
        optionEl = candidates.find(
          (o) => trimmed(o.textContent) === step.optionText
        ) || candidates.find(
          (o) => (o.getAttribute('value') || o.getAttribute('data-value')) === step.value
        );
        if (optionEl) {
          arLog(`[AR:dropdown]   MATCHED via selector "${sel}"`, { text: trimmed(optionEl.textContent) });
          break;
        }
        if (candidates.length > 0) {
          arLog(`[AR:dropdown]   selector "${sel}" found ${candidates.length} candidate(s):`,
            candidates.slice(0, 5).map(o => trimmed(o.textContent)));
        }
      }

      // Re-check if the dropdown is still open before clicking
      const isStillOpen =
        document.querySelectorAll('mat-option').length > 0 ||
        document.querySelectorAll('.ng-option').length > 0 ||
        document.querySelectorAll('[role="option"]').length > 0 ||
        document.querySelectorAll('.ant-select-item-option').length > 0 ||
        document.querySelectorAll('nz-option-item').length > 0 ||
        document.querySelectorAll('li.ant-select-item').length > 0 ||
        !!document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
      arLog(`[AR:dropdown] Attempt ${attempt + 1} — dropdown still open: ${isStillOpen}, optionEl found: ${!!optionEl}`);

      if (!isStillOpen && attempt === 0) {
        arWarn('[AR:dropdown] ⚠ Dropdown closed immediately after open! Possible causes:',
          '(1) synthetic mousedown on inner input triggered outside-click close (Ant Design),',
          '(2) backdrop click fired during synthetic mouse events,',
          '(3) recording=true listener re-fired.',
          { recording, replaying, clickTargetClass: clickTarget.className }
        );
        const retryTarget = getAntSelectClickTarget(el);
        arLog('[AR:dropdown] Attempting to reopen via', retryTarget.tagName, retryTarget.className);
        if (isNzSelect) {
          openNzSelect(retryTarget);
        } else {
          clickElement(retryTarget);
        }
        await waitFor(600);
        arLog('[AR:dropdown] After reopen — nz-option-item:', document.querySelectorAll('nz-option-item').length,
          'ant-select-item-option:', document.querySelectorAll('.ant-select-item-option').length);
      }

      if (optionEl) {
        optionEl.scrollIntoView({ block: 'nearest' });
        flash(optionEl);
        arLog('[AR:dropdown] Clicking matched option:', trimmed(optionEl.textContent));
        clickElement(optionEl);
        return;
      }
    }

    // Fallback: close the dropdown if nothing matched
    arError('[AR:dropdown] ✖ No matching option found after 5 attempts. Escaping.', {
      targetText: step.optionText,
      targetValue: step.value,
      antOptions: Array.from(document.querySelectorAll('.ant-select-item-option')).map(o => trimmed(o.textContent)),
      nzOptions:  Array.from(document.querySelectorAll('nz-option-item')).map(o => trimmed(o.textContent)),
      roleOptions: Array.from(document.querySelectorAll('[role="option"]')).map(o => trimmed(o.textContent)),
      matOptions: Array.from(document.querySelectorAll('mat-option')).map(o => trimmed(o.textContent)),
      ngOptions:  Array.from(document.querySelectorAll('.ng-option')).map(o => trimmed(o.textContent)),
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // Resolve a step's element via its selector.
  // If the stored selector is an XPath (starts with / or //) evaluate it directly;
  // otherwise use document.querySelector (CSS selector).
  function resolveElement(step) {
    let el = null;
    if (step.selector) {
      if (step.selector.startsWith('/')) {
        el = queryByXPath(step.selector);
      } else {
        // Strip ng-zorro state classes from nz-select selectors recorded with old code.
        // These classes (ant-select-open, ant-select-focused, ant-select-single, etc.)
        // are dynamic — they are absent when replay starts and cause querySelector to fail.
        let selector = step.selector;
        if (selector.startsWith('nz-select')) {
          selector = selector.replace(
            /\.(ant-select-open|ant-select-focused|ant-select-single|ant-select-multiple|ant-select-show-arrow|ant-select-show-search|ant-select-allow-clear|ant-select-disabled|ant-select-loading|ant-select-borderless)\b/g,
            ''
          );
          try {
            el = document.querySelector(selector);
          } catch (e) { el = null; }
          if (!el) {
            // Last resort: if only one nz-select on page use it; else can't resolve
            const allNz = document.querySelectorAll('nz-select');
            if (allNz.length === 1) el = allNz[0];
          }
        } else {
          try {
            el = document.querySelector(selector);
          } catch (e) { /* invalid CSS selector */ }
        }
      }
    }

    // For 'select' steps on Ant Design: if the stored selector resolved to any element
    // inside an nz-select (e.g. the hidden search input with id="cause_selector"), remap
    // to the nz-select HOST so selectElement → openNzSelect → getAntSelectClickTarget
    // can find the correct nz-select-top-control surface to click.
    // Also remap plain 'click' steps that land on nz-select internals.
    if (el && (step.type === 'select' || step.type === 'click')) {
      // First check: is this element inside an nz-select at all?
      const nzHost = el.closest('nz-select') ||
        (el.tagName === 'NZ-SELECT' ? el : null);
      if (nzHost && nzHost !== el) {
        arLog('[AR:resolveElement] remapped nz-select inner element → nz-select host', {
          stepType: step.type,
          from: { tag: el.tagName, id: el.id, class: el.className },
          to: { tag: nzHost.tagName, id: nzHost.id, class: nzHost.className }
        });
        if (step.type === 'click') {
          nzHost.__antSelectTriggerOnly = true;
        }
        return nzHost;
      }
      // Non-nz-select ant-select fallback
      const remapped = getAntSelectClickTarget(el);
      if (remapped !== el) {
        arLog('[AR:resolveElement] remapped ant-select inner input → selector surface', {
          stepType: step.type,
          from: { tag: el.tagName, class: el.className },
          to: { tag: remapped.tagName, class: remapped.className }
        });
        if (step.type === 'click') {
          remapped.__antSelectTriggerOnly = true;
        }
        return remapped;
      }
    }

    return el;
  }

  // Returns true when el is a layout container that has no interactive role
  // and was only recorded because of event bubbling (e.g. sticky-left-menu sidebar).
  // During replay these should trigger hover only — not a click.
  function isLayoutContainer(el) {
    const noiseTags = new Set(['DIV', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'SECTION', 'MAIN', 'UL', 'OL']);
    if (!noiseTags.has(el.tagName)) return false;
    const hasStableId = el.id && el.id.trim();
    const hasTestId = el.getAttribute('data-testid') || el.getAttribute('data-qa');
    const hasRole = el.getAttribute('role');
    const isInteractive = el.getAttribute('tabindex') != null || el.getAttribute('aria-expanded') != null;
    return !hasStableId && !hasTestId && !hasRole && !isInteractive && el.children.length > 5;
  }

  let replayCancel = false;

  async function runReplay(urlPattern, urlIsRegex) {
    if (!ctxOk()) return;

    // --- URL guard
    if (urlPattern) {
      let matches = false;
      try {
        matches = urlIsRegex
          ? new RegExp(urlPattern).test(location.href)
          : location.href.startsWith(urlPattern) || location.href === urlPattern;
      } catch (e) {
        matches = false;
      }
      if (!matches) {
        safeSend({
          type: 'REPLAY_EVENT',
          data: { level: 'error', step: 0, text: `URL mismatch — expected: ${urlPattern}  got: ${location.href}` }
        });
        safeSend({ type: 'REPLAY_FINISHED' });
        return;
      }
    }
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

    // Wait for the page body to have actual content (Angular/Vue hydration)
    let bodyReady = false;
    for (let w = 0; w < 20; w++) {
      if (document.body && document.body.children.length > 0) { bodyReady = true; break; }
      await waitFor(500);
    }
    if (!bodyReady) {
      safeSend({ type: 'REPLAY_EVENT', data: { level: 'error', step: 0, text: 'Page DOM did not become ready in time.' } });
      replaying = false;
      safeSend({ type: 'REPLAY_FINISHED' });
      return;
    }

    safeSend({ type: 'REPLAY_STARTED' });

    const steps = session.steps;
    for (let i = 0; i < steps.length; i++) {
      if (replayCancel) break;
      const step = steps[i];
      safeSend({ type: 'REPLAY_STEP', data: { current: i + 1, total: steps.length, selector: step.selector, stepType: step.type } });
      await waitFor(step.delay > 0 ? Math.min(step.delay, 10000) : 500);
      if (replayCancel) break;

      const el = resolveElement(step);
      if (!el) {
        // Retry up to 3x with 1s gap before giving up (handles slow Angular/Vue renders)
        let found = null;
        for (let r = 0; r < 3; r++) {
          await waitFor(1000);
          if (replayCancel) break;
          found = resolveElement(step);
          if (found) break;
        }
        if (!found) {
          safeSend({ type: 'REPLAY_EVENT', data: { level: 'warn', step: i + 1, text: `Element not found: ${step.selector}` } });
          continue;
        }
        // Skip orphaned ant-select trigger clicks (recorded before option was chosen)
        if (found.__antSelectTriggerOnly) {
          arLog(`[AR:replay] step ${i + 1} skipped — ant-select trigger-only click (no option to replay)`);
          safeSend({ type: 'REPLAY_EVENT', data: { level: 'warn', step: i + 1, text: `Skipped ant-select trigger click (step ${i + 1}) — re-record this dropdown selection` } });
          continue;
        }
        try {
          if (step.type === 'click') {
            if (isLayoutContainer(found)) {
              // Hover-only step — sidebar/nav containers expand on mouseenter, not click
              arLog(`[AR:replay] step ${i + 1} — layout container, hover-only (no click)`);
              dispatchHoverChain(found);
              await waitFor(400); // give Angular time to expand
            } else {
              clickElement(found);
            }
          }
          else if (step.type === 'fill') await fillElement(found, step);
          else if (step.type === 'select') await selectElement(found, step);
        } catch (err) {
          safeSend({ type: 'REPLAY_EVENT', data: { level: 'error', step: i + 1, text: `Step ${i + 1} failed: ${err}` } });
        }
        await waitFor(250);
        continue;
      }
      // Skip orphaned ant-select trigger clicks (recorded before option was chosen)
      if (el.__antSelectTriggerOnly) {
        arLog(`[AR:replay] step ${i + 1} skipped — ant-select trigger-only click (no option to replay)`);
        safeSend({ type: 'REPLAY_EVENT', data: { level: 'warn', step: i + 1, text: `Skipped ant-select trigger click (step ${i + 1}) — re-record this dropdown selection` } });
        await waitFor(250);
        continue;
      }
      try {
        if (step.type === 'click') {
          if (isLayoutContainer(el)) {
            // Hover-only step — sidebar/nav containers expand on mouseenter, not click
            arLog(`[AR:replay] step ${i + 1} — layout container, hover-only (no click)`);
            dispatchHoverChain(el);
            await waitFor(400); // give Angular time to expand
          } else {
            clickElement(el);
          }
        }
        else if (step.type === 'fill') await fillElement(el, step);
        else if (step.type === 'select') await selectElement(el, step);
      } catch (err) {
        safeSend({ type: 'REPLAY_EVENT', data: { level: 'error', step: i + 1, text: `Step ${i + 1} failed: ${err}` } });
      }
      await waitFor(250);
    }

    replaying = false;
    safeSend({ type: 'REPLAY_FINISHED' });
  }

  // ------------------------------------------------------------- messaging
  function setReplay(value, urlPattern, urlIsRegex) {
    if (value) {
      if (!replaying) runReplay(urlPattern, urlIsRegex);
    } else {
      replayCancel = true;
      replaying = false;
    }
  }

  // ------------------------------------------------------------- single-step replay
  async function runSingleStep(suiteName, stepIndex) {
    if (!ctxOk()) return;
    const key = suiteKey(suiteName);
    const stored = await storageGet(key);
    const session = stored[key];
    if (!session || !Array.isArray(session.steps)) return;
    const step = session.steps[stepIndex];
    if (!step) return;

    replaying = true;
    replayCancel = false;

    safeSend({ type: 'REPLAY_STARTED' });
    safeSend({ type: 'REPLAY_STEP', data: { current: 1, total: 1, selector: step.selector, stepType: step.type } });

    // Resolve with up to 3 retries (element may not be in DOM yet)
    let el = resolveElement(step);
    if (!el) {
      for (let r = 0; r < 3; r++) {
        await waitFor(1000);
        el = resolveElement(step);
        if (el) break;
      }
    }

    if (!el) {
      safeSend({ type: 'REPLAY_EVENT', data: { level: 'warn', step: stepIndex + 1, text: `Element not found: ${step.selector}` } });
    } else if (el.__antSelectTriggerOnly) {
      safeSend({ type: 'REPLAY_EVENT', data: { level: 'warn', step: stepIndex + 1, text: `Skipped ant-select trigger-only click — re-record this dropdown selection` } });
    } else {
      try {
        if (step.type === 'click') {
          if (isLayoutContainer(el)) {
            dispatchHoverChain(el);
            await waitFor(400);
          } else {
            clickElement(el);
          }
        } else if (step.type === 'fill') {
          await fillElement(el, step);
        } else if (step.type === 'select') {
          await selectElement(el, step);
        }
      } catch (err) {
        safeSend({ type: 'REPLAY_EVENT', data: { level: 'error', step: stepIndex + 1, text: `Step ${stepIndex + 1} failed: ${err}` } });
      }
    }

    replaying = false;
    safeSend({ type: 'REPLAY_FINISHED' });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!ctxOk()) return;
    if (message.type === 'SET_RECORDING') {
      setRecording(!!message.value);
      sendResponse({ ok: true });
    } else if (message.type === 'SET_REPLAY') {
      setReplay(!!message.value, message.urlPattern, message.urlIsRegex);
      sendResponse({ ok: true });
    } else if (message.type === 'SET_HIDE_LOG') {
      arLogEnabled = !message.value; // value=true means hide → disable logging
      sendResponse({ ok: true });
    } else if (message.type === 'RUN_STEP') {
      runSingleStep(message.suiteName, message.stepIndex);
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
      if (session && session.urlIsRegex !== undefined) {
        // Session already has regex metadata — just update the stored url to the
        // current href only when it doesn't already match the recorded urlPattern.
        let currentUrlMatches = false;
        try {
          currentUrlMatches = session.urlIsRegex
            ? new RegExp(session.urlPattern || session.url).test(location.href)
            : location.href.startsWith(session.urlPattern || session.url) ||
              location.href === (session.urlPattern || session.url);
        } catch (e) { /* invalid regex — fall back to exact compare */ }
        if (!currentUrlMatches) {
          session.url = location.href;
          await storageSet({ [key]: session });
        }
      } else if (session && session.url !== location.href) {
        // Legacy session without urlIsRegex metadata — keep plain URL fresh.
        session.url = location.href;
        await storageSet({ [key]: session });
      }
    }
  })();
})();
