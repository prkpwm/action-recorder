(() => {
  'use strict';
  // Guard against double injection (declarative + executeScript fallback).
  if (window.__actionRecorderInjected) return;
  // Guard against frames where chrome extension APIs are unavailable
  // (e.g. cross-origin iframes where the extension context is not exposed).
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
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
  let paused = false;   // when true, recording is temporarily suspended (no capture)
  let replaying = false;
  let lastHoverEl = null;
  let lastStepTime = 0;
  const lastInputValues = new WeakMap();

  // Tracks a button click that may have opened a file picker.
  // If a file input change fires within FILE_CLICK_WINDOW ms, we retract the
  // button click and record only the 'file' step (with triggerSelector).
  // If no file is picked in time, the button click is committed as a normal click.
  let pendingFileClickStep = null;   // { step, commitTimer }
  const FILE_CLICK_WINDOW = 10000;   // ms to wait for a file-change after a button click

  // Debug logging — off by default; toggled by the popup "Hide debug logs" checkbox.
  let arLogEnabled = true;
  const arLog = (...args) => { if (arLogEnabled) console.log(...args); };
  const arWarn = (...args) => { if (arLogEnabled) console.warn(...args); };
  const arError = (...args) => { if (arLogEnabled) console.error(...args); };

  // Read persisted preference immediately (async, best-effort)
  storageGet('arHideLog').then(({ arHideLog }) => {
    arLogEnabled = arHideLog === false; // default hide → log disabled
  }).catch(() => {});

  const STYLE_ID = 'ar-style';
  const FLASH_CLS = 'ar-flash';

  // ------------------------------------------------------------- iframe detection
  // True when this content script is running inside an iframe (not the top frame).
  const IS_IFRAME = window !== window.top;

  // When running inside an iframe, overlay is rendered by the TOP frame.
  // We postMessage the element rect + selector up to the parent so it can
  // position the overlay correctly relative to the full viewport.
  const AR_OVERLAY_MSG = '__ar_hover__';

  // Top-frame: find the <iframe> element whose contentWindow matches `win`.
  function findIframeByWindow(win) {
    for (const iframe of document.querySelectorAll('iframe')) {
      try { if (iframe.contentWindow === win) return iframe; } catch { /* cross-origin */ }
    }
    return null;
  }

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

    // For nz-date-picker: always target the <input> inside — the host element
    // carries dynamic state classes (ant-picker-focused, ant-picker-status-error, etc.)
    // that make it unreplayable. The inner input is the stable, injectable target.
    if (tag === 'nz-date-picker' || el.classList.contains('ant-picker')) {
      const inner = el.querySelector('input');
      if (inner) return getBestSelector(inner);
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

  // Serialize recordStep calls — without this, rapid clicks race on the
  // read-modify-write of storage and later writes clobber earlier steps.
  let recordQueue = Promise.resolve();
  function recordStep(step) {
    recordQueue = recordQueue.then(() => recordStepInner(step)).catch(() => {});
    return recordQueue;
  }

  async function recordStepInner(step) {
    if (!ctxOk()) return;

    // A pending button click is waiting to see if a file picker opens.
    // If something else is being recorded now (not a 'file' step), the button
    // click was a real action — commit it first, then record this new step.
    if (pendingFileClickStep && step.type !== 'file') {
      clearTimeout(pendingFileClickStep.commitTimer);
      const clickStep = pendingFileClickStep.step;
      pendingFileClickStep = null;
      await recordStepInner(clickStep); // commit the deferred click
    }

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

    // If this is a fill/date/datepick step and the last step is the same type
    // on the same selector, update in place (collapses rapid typing into one step).
    const last = session.steps[session.steps.length - 1];
    const isValueStep = step.type === 'fill' || step.type === 'date' || step.type === 'datepick';
    const lastIsValueStep = last && (last.type === 'fill' || last.type === 'date' || last.type === 'datepick');
    if (isValueStep && lastIsValueStep && last.selector === step.selector) {
      last.value = step.value;
      last.text  = step.text || step.value;
      last.type  = step.type; // upgrade type if changed (e.g. datepick → date)
      last.timestamp = step.timestamp;
      // keep the original delay (time from previous distinct action)
    } else {
      session.steps.push(step);
    }

    await storageSet({ [key]: session });
    safeSend({ type: 'STEP_RECORDED', data: step });
  }

  function recordFill(el, force) {
    if (!recording || replaying || paused) return;
    const isCheck = el.type === 'checkbox' || el.type === 'radio';
    if (!force) {
      if (lastInputValues.get(el) === el.value) return; // unchanged since last record
    }
    lastInputValues.set(el, el.value);

    // Detect date picker inputs — nz-date-picker / ant-picker wraps a plain <input>
    // but the value is a formatted date string. Record as type 'date' so replay
    // uses datepickElement (direct inject) instead of fillElement.
    const isDatePicker = !!(el.closest && (
      el.closest('nz-date-picker') || el.closest('.ant-picker')
    ));

    recordStep({
      type: isDatePicker ? 'date' : 'fill',
      selector: getBestSelector(el),
      name: el.getAttribute('name') || el.getAttribute('id') || '',
      value: isCheck ? String(el.checked) : String(el.value)
    });
  }

  function handleClick(e) {
    if (!recording || replaying || paused) return;
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

    // Ant Design date picker — intercept all clicks inside the picker panel/dropdown.
    const pickerPanel = el.closest('.ant-picker-dropdown, .cdk-overlay-container .ant-picker-panel-container');
    if (pickerPanel) {
      // Date cell click — the td ancestor carries the full date in its title attribute
      const cell = el.closest('td.ant-picker-cell');
      if (cell) {
        const dateTitle = cell.getAttribute('title') || trimmed(el.textContent);
        // Find which picker INPUT triggered this panel
        const openPicker = document.querySelector('nz-date-picker.ant-picker-focused, nz-date-picker .ant-picker-focused')
          || document.querySelector('.ant-picker-focused input, .ant-picker-active input')
          || document.querySelector('nz-date-picker input.ant-picker-input');
        const triggerSelector = openPicker ? getBestSelector(
          openPicker.closest('nz-date-picker') || openPicker
        ) : '';
        recordStep({
          type: 'datepick',
          selector: triggerSelector,
          value: dateTitle,
          text: dateTitle
        });
        arLog('[AR:handleClick] datepick recorded:', { triggerSelector, dateTitle });
        return;
      }      // Navigation clicks (prev/next year/month, header year/month btn) — suppress.
      // Since replay injects the date value directly, nav clicks are never replayed.
      const navEl = el.closest(
        '.ant-picker-header-year-btn, .ant-picker-header-month-btn, ' +
        '.ant-picker-super-prev-icon, .ant-picker-super-next-icon, ' +
        '.ant-picker-prev-icon, .ant-picker-next-icon, ' +
        '.ant-picker-header button'
      );
      if (navEl) {
        arLog('[AR:handleClick] suppressed — picker nav click (not needed with direct inject)');
        return;
      }
      // Other picker panel clicks — skip, they're noise
      arLog('[AR:handleClick] suppressed — click inside picker panel (not a cell or nav)');
      return;
    }

    // Suppress the INPUT click that opens a date picker — replay will open it
    // before replaying the datepick step.
    if (el.tagName === 'INPUT') {
      const pickerInput = el.closest('nz-date-picker, .ant-picker');
      if (pickerInput) {
        arLog('[AR:handleClick] suppressed — ant-picker INPUT open click (handled by datepick replay)');
        return;
      }
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
      const hasFewChildren = el.children.length <= 5;
      if (!hasStableId && !hasTestId && !hasRole && !isInteractive && el.children.length > 5) {
        arLog('[AR:handleClick] suppressed — large layout container with no stable identity', {
          tag, children: el.children.length, class: el.className
        });
        return;
      }
      // Also suppress non-interactive divs with no role that fire right after an upload
      // trigger was deferred — these are bubbling events from the span click.
      if (!hasRole && !isInteractive && hasFewChildren && pendingFileClickStep) {
        arLog('[AR:handleClick] suppressed — non-interactive div bubbling after upload deferral', {
          tag, id: el.id, class: el.className
        });
        return;
      }
    }

    // Check if this click will open a file picker.
    // Heuristic: a button/anchor inside a container that also contains a hidden
    // file input is almost certainly a "choose file" trigger — defer it.
    const nearbyFileInput = findNearbyFileInput(el);
    if (nearbyFileInput) {
      if (pendingFileClickStep) {
        clearTimeout(pendingFileClickStep.commitTimer);
        pendingFileClickStep = null;
      }
      const deferredStep = { type: 'click', selector: getBestSelector(el), ...elInfo(el) };
      // If the trigger text is clearly upload-related, never commit as a standalone
      // click — just wait indefinitely for the file input change.
      const triggerText = trimmed(el.textContent || '');
      const isUploadText = triggerText && /upload|อัปโหลด|choose.file|browse|เลือกไฟล์|แนบ/i.test(triggerText);
      pendingFileClickStep = {
        step: deferredStep,
        fileInput: nearbyFileInput,
        commitTimer: isUploadText ? null : setTimeout(() => {
          // No file was picked in time — commit as a normal click
          pendingFileClickStep = null;
          recordStep(deferredStep);
        }, FILE_CLICK_WINDOW)
      };
      arLog('[AR:handleClick] deferred — possible file-picker trigger:', getBestSelector(el), isUploadText ? '(indefinite)' : '');
      return;
    }

    recordStep({ type: 'click', selector: getBestSelector(el), ...elInfo(el) });
  }

  // Returns a hidden/invisible file input that is "near" el in the DOM —
  // shares an ancestor within 5 levels. Returns null if none found.
  // Only triggers for interactive elements (BUTTON, A, SPAN, DIV with role/tabindex)
  // to avoid false positives from large layout containers.
  function findNearbyFileInput(el) {
    // Walk up from the clicked element to find the nearest interactive trigger
    // (elementFromPoint may hit an icon/img inside a span/button/a).
    let trigger = el;
    while (trigger) {
      const tag = trigger.tagName;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'SPAN') break;
      if (tag === 'DIV' && (trigger.getAttribute('role') || trigger.getAttribute('tabindex'))) break;
      trigger = trigger.parentElement;
      if (trigger === document.body) { trigger = null; break; }
      if (!trigger) break;
    }
    if (!trigger) return null;
    const triggerTag = trigger.tagName;
    const isInteractiveTrigger =
      triggerTag === 'BUTTON' || triggerTag === 'A' ||
      triggerTag === 'SPAN' ||
      (triggerTag === 'DIV' && (trigger.getAttribute('role') || trigger.getAttribute('tabindex')));
    if (!isInteractiveTrigger) return null;

    // If text implies upload, return any file input on the page — don't bother
    // searching ancestors.
    const text = trimmed(trigger.textContent || '');
    const isUploadText = text && /upload|อัปโหลด|choose.file|browse|เลือกไฟล์|แนบ/i.test(text);

    if (isUploadText) {
      const allFileInputs = document.querySelectorAll('input[type="file"]');
      if (allFileInputs.length > 0) return allFileInputs[0];
      return null;
    }

    let node = trigger;
    for (let depth = 0; depth < 6; depth++) {
      if (!node || !node.parentElement) break;
      node = node.parentElement;
      const inp = node.querySelector('input[type="file"]');
      if (inp) return inp;
    }
    return null;
  }

  // ------------------------------------------------------------------- replay file-upload skip
  // At replay time a recorded "click upload" button would open the native OS file
  // picker — which we DO NOT want when the file step below injects its stored
  // base64 data directly (openFileInput → DataTransfer, no picker). So before
  // replaying a click we look ahead: if a 'file' step that injects stored data
  // follows (ignoring only layout-container bubbling clicks) and this click is the
  // upload-trigger for THAT same <input type="file">, we skip the click.

  // Find the <input type="file"> that clicking `el` would open, by climbing the
  // DOM. Mirrors findNearbyFileInput but searches deeper and drops the
  // "interactive trigger" gate — it's only consulted when a concrete following
  // 'file' step exists to associate with.
  function findAssociatedFileInput(el) {
    if (!(el instanceof Element)) return null;
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file') return el;
    let node = el;
    for (let depth = 0; depth < 10 && node && node.parentElement; depth++) {
      node = node.parentElement;
      const inp = node.querySelector('input[type="file"]');
      if (inp) return inp;
    }
    return null;
  }

  // Resolve a step to its raw element WITHOUT nz-select remapping (used for the
  // lookahead file-input association check).
  function resolvePlainElement(step) {
    if (!step || !step.selector) return null;
    try {
      return step.selector.startsWith('/')
        ? queryByXPath(step.selector)
        : document.querySelector(step.selector);
    } catch (e) {
      return null;
    }
  }

  // True when, scanning forward from `index`, the next non-layout-blocking step is
  // a 'file' step that injects stored fileData into the SAME file input that
  // clicking `clickEl` opens. When true the caller should skip that click.
  function fileUploadInjectFollows(steps, index, clickEl) {
    const myInput = findAssociatedFileInput(clickEl);
    for (let j = index + 1; j < steps.length; j++) {
      const s = steps[j];
      if (s.type === 'file') {
        // Only skip when we can inject directly (stored data present).
        if (!(s.fileData && s.fileData.length > 0)) return false;
        // If we found the associated file input via DOM, verify match.
        if (myInput) {
          const fileEl = resolvePlainElement(s);
          return !!fileEl && fileEl === myInput;
        }
        // Fallback: no DOM association found, but a file step follows within 2 steps.
        // The click is likely an upload trigger (e.g., clicking "อัปโหลด" span).
        // Skip it so the file can be injected directly.
        if (j - index <= 3) return true;
        return false;
      }
      if (s.type === 'click') {
        const cand = resolvePlainElement(s);
        if (cand && isLayoutContainer(cand)) continue; // bubbling noise — keep looking
      }
      return false; // any other step in between
    }
    return false;
  }

  function handleInput(e) {
    if (!recording || replaying || paused) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    // Skip file inputs — their value is "C:\fakepath\..." which is not replayable.
    // File attachments are captured via the 'change' event handler below.
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'file') return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      recordFill(el, true);
    }
  }

  function handleChange(e) {
    if (!recording || replaying || paused) return;
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
    } else if (el.tagName === 'INPUT' && el.type === 'file') {
      // File input — retract any pending button click (it was just the picker trigger)
      // then read each file as base64 so replay can inject without opening a dialog.
      let triggerSelector = null;
      if (pendingFileClickStep) {
        clearTimeout(pendingFileClickStep.commitTimer);
        triggerSelector = pendingFileClickStep.step.selector;
        pendingFileClickStep = null;
        arLog('[AR:handleChange] retracted pending click — recording file step instead, triggerSelector:', triggerSelector);
      }

      const fileList = Array.from(el.files || []);
      if (!fileList.length) return;
      Promise.all(
        fileList.map(
          (f) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () =>
                resolve({ name: f.name, type: f.type, dataUrl: reader.result });
              reader.onerror = () =>
                resolve({ name: f.name, type: f.type, dataUrl: null });
              reader.readAsDataURL(f);
            })
        )
      ).then((fileData) => {
        recordStep({
          type: 'file',
          selector: getBestSelector(el),
          triggerSelector,   // the button that opened the picker (null if input clicked directly)
          name: el.getAttribute('name') || el.getAttribute('id') || '',
          accept: el.getAttribute('accept') || '',
          files: fileData.map((d) => d.name),
          fileData // [{ name, type, dataUrl }]
        });
      });
    }
  }

  function handleOver(e) {
    if (!recording || replaying) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el === lastHoverEl) return;

    // Top frame: skip hover on <iframe> elements themselves — the child frame's
    // own content script handles hover inside and will postMessage the overlay up.
    if (!IS_IFRAME && el.tagName === 'IFRAME') return;

    lastHoverEl = el;

    // Skip overlay on large layout containers — they have no stable selector and
    // produce a full-page red border that visually obscures the page content.
    if (isLayoutContainer(el)) {
      hideOverlay();
      safeSend({ type: 'HOVER_SELECTOR', selector: '' });
      return;
    }

    const selector = getBestSelector(el);
    positionOverlay(el, selector);
    safeSend({ type: 'HOVER_SELECTOR', selector });
  }

  function clearHover(e) {
    // Inside an iframe: only hide when the mouse is truly leaving the iframe's
    // document (relatedTarget is null = left the window entirely, or is the
    // <html>/<body> root going out). Moving between child elements fires mouseout
    // too but relatedTarget will still be inside this document — ignore those.
    if (IS_IFRAME && e && e.relatedTarget && document.documentElement.contains(e.relatedTarget)) {
      return; // still inside the iframe — don't hide
    }

    // Top frame: if the pointer just entered an iframe element, the iframe's own
    // content script will take over hover. Don't hide — let the postMessage from
    // the child frame update the overlay instead.
    if (!IS_IFRAME && e && e.relatedTarget instanceof Element && e.relatedTarget.tagName === 'IFRAME') {
      return;
    }

    lastHoverEl = null;
    hideOverlay();
    if (recording) safeSend({ type: 'HOVER_SELECTOR', selector: '' });
  }

  // ------------------------------------------------------------- hover overlay (full border + selector label)
  let hoverOverlay = null;
  let hoverLabel = null;

  function getOrCreateOverlay() {
    // The overlay is always rendered in the top frame. When running inside an
    // iframe we postMessage up to the top frame instead of touching the DOM here.
    if (IS_IFRAME) return null;
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

  // Render the overlay at the given viewport-relative rect (already offset by
  // iframe position when called from the top-frame postMessage handler).
  function positionOverlayAtRect(rect, selector) {
    const overlay = getOrCreateOverlay();
    if (!overlay) return;

    overlay.style.top    = (rect.top  - 2) + 'px';
    overlay.style.left   = (rect.left - 2) + 'px';
    overlay.style.width  = (rect.width  + 4) + 'px';
    overlay.style.height = (rect.height + 4) + 'px';
    overlay.style.display = 'block';

    if (hoverLabel) {
      hoverLabel.textContent = selector || '';
      const labelH = hoverLabel.offsetHeight || 20;
      if (rect.top - 2 >= labelH + 2) {
        hoverLabel.style.top    = (-labelH - 2) + 'px';
        hoverLabel.style.bottom = '';
      } else {
        hoverLabel.style.top    = '2px';
        hoverLabel.style.bottom = '';
      }
    }
  }

  function positionOverlay(el, selector) {
    const r = el.getBoundingClientRect();

    if (IS_IFRAME) {
      // Send rect + selector up to the top frame; it will add the iframe offset
      // and render the overlay there so it appears at the correct screen position.
      try {
        window.top.postMessage({
          type: AR_OVERLAY_MSG,
          action: 'show',
          rect: { top: r.top, left: r.left, width: r.width, height: r.height },
          selector,
          sourceOrigin: location.origin
        }, '*');
      } catch { /* cross-origin top — silently ignore */ }
      return;
    }

    // Top frame: render directly (no offset needed).
    positionOverlayAtRect(r, selector);
  }

  function hideOverlay() {
    if (IS_IFRAME) {
      try {
        window.top.postMessage({ type: AR_OVERLAY_MSG, action: 'hide' }, '*');
      } catch { /* cross-origin top */ }
      return;
    }
    if (hoverOverlay) hoverOverlay.style.display = 'none';
  }

  // Top-frame listener: receives overlay commands from child iframes.
  if (!IS_IFRAME) {
    window.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== AR_OVERLAY_MSG) return;
      if (e.data.action === 'hide') {
        if (hoverOverlay) hoverOverlay.style.display = 'none';
        return;
      }
      if (e.data.action === 'show') {
        const iframe = findIframeByWindow(e.source);
        if (!iframe) return;
        const iframeRect = iframe.getBoundingClientRect();
        const r = e.data.rect;
        positionOverlayAtRect({
          top:    r.top  + iframeRect.top,
          left:   r.left + iframeRect.left,
          width:  r.width,
          height: r.height
        }, e.data.selector);
      }
    });
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
      // Ensure any queued step writes flush before the session is considered done.
      recordQueue.catch(() => {});
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

  // Inject recorded files into a file input via DataTransfer — no OS picker opened.
  // Falls back to opening the picker (with a warning) only when no base64 data was stored.
  async function openFileInput(el, step, stepNum) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);

    const fileData = step.fileData;
    if (fileData && fileData.length > 0) {
      try {
        // Reconstruct File objects from stored base64 DataURLs
        const dt = new DataTransfer();
        for (const fd of fileData) {
          if (!fd.dataUrl) continue;
          const [meta, b64] = fd.dataUrl.split(',');
          const mime = (meta.match(/:(.*?);/) || [])[1] || fd.type || 'application/octet-stream';
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          dt.items.add(new File([bytes], fd.name, { type: mime }));
        }

        if (dt.files.length > 0) {
          // The ONLY reliable cross-browser way to set files on an input:
          // assign the DataTransfer's FileList directly to the input's `files`
          // property via the native property descriptor (which has a setter in
          // Chromium).  If that fails, fall back to Object.defineProperty.
          const nativeDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
          if (nativeDesc && typeof nativeDesc.set === 'function') {
            nativeDesc.set.call(el, dt.files);
          } else {
            try {
              Object.defineProperty(el, 'files', { value: dt.files, writable: true, configurable: true });
            } catch (_) {
              el.files = dt.files; // last resort
            }
          }

          // Dispatch inside a macrotask so Angular's NgZone intercepts it and
          // runs change detection, which triggers FileReader → preview update.
          await new Promise((resolve) => {
            setTimeout(() => {
              el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              resolve();
            }, 0);
          });

          // Give Angular time to run FileReader and render the preview image.
          await waitFor(1000);

          arLog(`[AR:openFileInput] step ${stepNum} — injected ${dt.files.length} file(s):`,
            Array.from(dt.files).map((f) => f.name));
          safeSend({
            type: 'REPLAY_EVENT',
            data: { level: 'info', step: stepNum, text: `Step ${stepNum}: Injected file — ${step.files.join(', ')}` }
          });
          return;
        }
      } catch (err) {
        arWarn('[AR:openFileInput] DataTransfer inject failed:', err);
      }
    }
  

    // Fallback — no stored data: open the picker and wait for manual selection
    const fileNames = (step.files || []).join(', ') || 'file';
    safeSend({
      type: 'REPLAY_EVENT',
      data: { level: 'warn', step: stepNum, text: `Step ${stepNum}: No file data stored — please select manually: ${fileNames}` }
    });

    const origDisplay    = el.style.display;
    const origVisibility = el.style.visibility;
    const origOpacity    = el.style.opacity;
    if (getComputedStyle(el).display     === 'none')   el.style.display     = 'inline-block';
    if (getComputedStyle(el).visibility  === 'hidden') el.style.visibility  = 'visible';
    if (getComputedStyle(el).opacity     === '0')      el.style.opacity     = '1';

    el.click();

    let waited = 0;
    while (waited < 30000) {
      await waitFor(500);
      waited += 500;
      if (replayCancel) break;
      if (el.files && el.files.length > 0) break;
    }

    el.style.display     = origDisplay;
    el.style.visibility  = origVisibility;
    el.style.opacity     = origOpacity;

    if (!el.files || el.files.length === 0) {
      safeSend({
        type: 'REPLAY_EVENT',
        data: { level: 'warn', step: stepNum, text: `Step ${stepNum}: No file selected — skipping` }
      });
    }
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

  // Compare two URLs ignoring query string, hash, and duplicate slashes in path —
  // used for frame ownership checks so ?fake_api=true params and double-slash
  // artifacts (e.g. recorded as http://host//path) don't cause mismatches.
  function urlPathMatches(a, b) {
    if (!a || !b) return false;
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      // Normalize pathname: collapse repeated slashes, strip trailing slash
      const normPath = (p) => p.replace(/\/\/+/g, '/').replace(/\/$/, '');
      return ua.origin === ub.origin &&
        normPath(ua.pathname) === normPath(ub.pathname);
    } catch {
      const strip = (s) => s.split('?')[0].split('#')[0].replace(/\/\/+/g, '/').replace(/\/$/, '');
      return strip(a) === strip(b);
    }
  }
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

  // Replay an Ant Design date picker by directly injecting the date value into
  // the picker's input — no panel opening, no cell clicking, no navigation.
  // Uses the same native-setter + event dispatch trick as fillElement so that
  // Angular's ControlValueAccessor picks up the change.
  async function datepickElement(triggerEl, step) {
    const dateValue = step.value || step.text || '';
    if (!dateValue) { arWarn('[AR:datepick] no date value in step'); return; }

    // Find the input inside the nz-date-picker / ant-picker host
    const host = triggerEl || document.querySelector('nz-date-picker, .ant-picker');
    if (!host) { arWarn('[AR:datepick] no picker host found'); return; }

    const input = host.querySelector('input') || (host.tagName === 'INPUT' ? host : null);
    if (!input) { arWarn('[AR:datepick] no input inside picker host'); return; }

    host.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(host);
    input.focus();

    // Inject value via native setter so Angular's value accessor detects it
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, dateValue);
    else input.value = dateValue;

    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(100);
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, cancelable: true, relatedTarget: null }));
    input.dispatchEvent(new FocusEvent('blur',     { bubbles: false, cancelable: false, relatedTarget: null }));
    input.blur();

    // Press Enter to confirm — nz-date-picker confirms on Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));

    // Close any open panel by pressing Escape
    await waitFor(100);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    arLog('[AR:datepick] injected date value:', dateValue, 'into', input);
    await waitFor(200);
  }

  async function runReplay(urlPattern, urlIsRegex, startIndex) {
    if (!ctxOk()) return;

    // Read the active suite's session first — we need session.url to decide
    // which frame (top vs iframe) is the correct one to run this replay.
    const { arActiveSuite } = await storageGet('arActiveSuite');
    const suiteName = arActiveSuite || 'suite1';
    const key = suiteKey(suiteName);
    const stored = await storageGet(key);
    const session = stored[key];

    if (!session || !session.steps || !session.steps.length) return;

    // --- Frame ownership check ---
    // When background.js sends SET_REPLAY to ALL frames, every frame's content
    // script receives it. Only the frame whose location.href matches the recorded
    // session URL should actually run the replay. Other frames bail out silently
    // (no REPLAY_FINISHED sent) so the popup doesn't get confused.
    //
    // Priority:
    //  1. If session.url is set, the frame that matches it owns the replay.
    //  2. If session.url is blank (legacy), fall back to urlPattern matching.
    //  3. If no urlPattern either, the top frame (IS_IFRAME === false) runs it.
    const sessionUrl = session.url || '';
    if (sessionUrl) {
      if (!urlPathMatches(location.href, sessionUrl)) {
        arLog('[AR:runReplay] skipping — session URL is', sessionUrl, ', this frame is', location.href);
        return;
      }
    } else if (urlPattern) {
      // Legacy path: no session.url stored — match against popup's urlPattern.
      let matches = false;
      try {
        matches = urlIsRegex
          ? new RegExp(urlPattern).test(location.href)
          : location.href.startsWith(urlPattern) || location.href === urlPattern;
      } catch (e) {
        matches = false;
      }
      if (!matches) {
        // Only the top frame reports URL mismatch — iframes bail silently.
        if (!IS_IFRAME) {
          safeSend({
            type: 'REPLAY_EVENT',
            data: { level: 'error', step: 0, text: `URL mismatch — expected: ${urlPattern}  got: ${location.href}` }
          });
          safeSend({ type: 'REPLAY_FINISHED' });
        }
        return;
      }
    } else if (IS_IFRAME) {
      // No URL hints at all — top frame handles it, iframe skips.
      return;
    }
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
    // Start from the requested step index (0-based). Clamp to valid range.
    const start = Math.min(Math.max(0, startIndex | 0), Math.max(0, steps.length - 1));
    if (start > 0) {
      arLog(`[AR:runReplay] starting from step ${start + 1} (skipping ${start} step(s))`);
      safeSend({ type: 'REPLAY_EVENT', data: { level: 'info', step: start + 1, text: `Starting from step ${start + 1}` } });
    }
    for (let i = start; i < steps.length; i++) {
      if (replayCancel) break;
      const step = steps[i];

      // Skip upload-trigger clicks — a file step follows and injects data directly.
      // Opening the native file picker would block replay.
      if (step.type === 'click' && (step.tag === 'SPAN' || step.tag === 'BUTTON' || step.tag === 'A')) {
        const txt = trimmed(step.text || '');
        if (txt && /upload|อัปโหลด|choose.file|browse|เลือกไฟล์|แนบ/i.test(txt)) {
          let hasFollowingFile = false;
          for (let j = i + 1; j < steps.length && j <= i + 3; j++) {
            if (steps[j].type === 'file') { hasFollowingFile = true; break; }
            if (steps[j].type !== 'click') break;
          }
          if (hasFollowingFile) {
            arLog('[AR:replay] skipping upload-trigger click:', step.selector, step.text);
            safeSend({ type: 'REPLAY_EVENT', data: { level: 'info', step: i + 1, text: `Skipped Upload trigger (step ${i + 1}) — file is injected directly` } });
            await waitFor(250);
            continue;
          }
        }
      }

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
            // Skip upload-trigger clicks that just open the native file picker —
            // the following 'file' step injects its stored data directly instead.
            if (fileUploadInjectFollows(steps, i, found)) {
              safeSend({ type: 'REPLAY_EVENT', data: { level: 'info', step: i + 1, text: `Skipped file-upload trigger click (step ${i + 1}) — file is injected directly` } });
              arLog('[AR:replay] skipped file-upload trigger click:', step.selector);
              await waitFor(250);
              continue;
            }
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
          else if (step.type === 'file') await openFileInput(found, step, i + 1);
          else if (step.type === 'datepick' || step.type === 'date') await datepickElement(found, step);
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
          // Skip upload-trigger clicks that just open the native file picker —
          // the following 'file' step injects its stored data directly instead.
          if (fileUploadInjectFollows(steps, i, el)) {
            safeSend({ type: 'REPLAY_EVENT', data: { level: 'info', step: i + 1, text: `Skipped file-upload trigger click (step ${i + 1}) — file is injected directly` } });
            arLog('[AR:replay] skipped file-upload trigger click:', step.selector);
            await waitFor(250);
            continue;
          }
          if (isLayoutContainer(el)) {
            // Hover-only step — sidebar/nav containers expand on mouseenter, not click
            arLog(`[AR:replay] step ${i + 1} — layout container, hover-only (no click)`);
            dispatchHoverChain(el);
            await waitFor(400); // give Angular time to expand
          } else if (step.pickerNav) {
            // Picker nav click — wait for the panel to be open first
            let panelOpen = false;
            for (let w = 0; w < 10; w++) {
              if (document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)')) { panelOpen = true; break; }
              await waitFor(200);
            }
            clickElement(el);
          } else {
            clickElement(el);
          }
        }
        else if (step.type === 'fill') await fillElement(el, step);
        else if (step.type === 'select') await selectElement(el, step);
        else if (step.type === 'file') await openFileInput(el, step, i + 1);
        else if (step.type === 'datepick' || step.type === 'date') await datepickElement(el, step);
      } catch (err) {
        safeSend({ type: 'REPLAY_EVENT', data: { level: 'error', step: i + 1, text: `Step ${i + 1} failed: ${err}` } });
      }
      await waitFor(250);
    }

    replaying = false;
    safeSend({ type: 'REPLAY_FINISHED' });
  }

  // ------------------------------------------------------------- messaging
  function setReplay(value, urlPattern, urlIsRegex, startIndex) {
    if (value) {
      if (!replaying) runReplay(urlPattern, urlIsRegex, startIndex);
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

    // Frame ownership: the step carries the URL of the frame it was recorded in.
    // Only the frame whose location.href matches step.url should execute it.
    // Other frames bail silently so only one frame runs each step.
    if (step.url) {
      if (!urlPathMatches(location.href, step.url)) {
        arLog('[AR:runSingleStep] skipping — step.url is', step.url, ', this frame is', location.href);
        return;
      }
    } else if (IS_IFRAME) {
      // No URL on step (legacy) — top frame handles it
      return;
    }

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
    } else if (step.type === 'click' && (step.tag === 'SPAN' || step.tag === 'BUTTON' || step.tag === 'A')) {
      // Skip upload-trigger clicks — file step injects data directly
      const txt = trimmed(step.text || '');
      if (/upload|อัปโหลด|choose.file|browse|เลือกไฟล์|แนบ/i.test(txt)) {
        const allSteps = session.steps;
        let hasFollowingFile = false;
        for (let j = stepIndex + 1; j < allSteps.length && j <= stepIndex + 3; j++) {
          if (allSteps[j].type === 'file') { hasFollowingFile = true; break; }
          if (allSteps[j].type !== 'click') break;
        }
        if (hasFollowingFile) {
          arLog('[AR:replay] single-step: skipping upload-trigger click:', step.selector);
          safeSend({ type: 'REPLAY_EVENT', data: { level: 'info', step: stepIndex + 1, text: `Skipped file-upload trigger click (step ${stepIndex + 1}) — file is injected directly` } });
        } else {
          clickElement(el);
        }
      } else {
        clickElement(el);
      }
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
        } else if (step.type === 'file') {
          await openFileInput(el, step, stepIndex + 1);
        } else if (step.type === 'datepick' || step.type === 'date') {
          await datepickElement(el, step);
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
      if (!message.value) paused = false; // clear pause when recording stops
      sendResponse({ ok: true });
    } else if (message.type === 'SET_PAUSED') {
      paused = !!message.value;
      arLog('[AR] recording', paused ? 'paused' : 'resumed');
      sendResponse({ ok: true });
    } else if (message.type === 'SET_REPLAY') {
      setReplay(!!message.value, message.urlPattern, message.urlIsRegex, message.startIndex);
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
      paused = !!arRecording.paused; // restore pause state across page navigations
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
