# Action Recorder — Feature Documentation

Chrome Extension (Manifest V3) for recording browser interactions and replaying them on demand.

---

## Installation

This extension is loaded as an unpacked extension — it is not published to the Chrome Web Store.

1. Clone or download this repository to a local folder.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the root folder of this repository (the folder containing `manifest.json`).
5. The **⚡ Action Recorder** icon appears in the Chrome toolbar. Pin it for easy access.

**Updating after code changes:** go back to `chrome://extensions` and click the **↺ reload** button on the extension card (or use the keyboard shortcut shown there).

---

## Overview

Action Recorder captures clicks, form-fill interactions, and dropdown selections on any HTTP/HTTPS page and saves them as a named **suite** of steps. Suites can be replayed, exported as JSON, imported from a file, and managed independently.

---

## Architecture

| File | Role |
|---|---|
| `manifest.json` | Extension manifest (MV3). Declares permissions, content script, background worker, and popup. |
| `background.js` | Service worker. Owns all state mutations (storage), manages suites, and routes messages between popup and content script. |
| `content.js` | Injected into every HTTP/HTTPS page. Captures DOM events during recording and drives replay. |
| `popup.js` | Popup UI logic. Reads state from background via messages and `chrome.storage.local`. |
| `popup.html` | Popup markup. |
| `popup.css` | Popup styles. |

---

## Storage Schema

All data lives in `chrome.storage.local`.

| Key | Type | Description |
|---|---|---|
| `arRecording` | `{ active, tabId, url, startedAt }` | Current recording state. `active: true` while a recording session is running. |
| `arSuites` | `string[]` | Ordered list of suite names, e.g. `["suite1", "a/test1"]`. Defaults to `["suite1"]`. |
| `arActiveSuite` | `string` | Name of the currently selected suite. |
| `arHideLog` | `boolean` | Whether debug console logging is suppressed in the content script. Defaults to `true` (hidden). |
| `arSession__<suiteName>` | Session object (see below) | One key per suite. Each stores that suite's recorded steps. |

### Session object shape

```json
{
  "suiteName": "suite1",
  "url": "https://example.com/some/page",
  "urlPattern": "https://example.com/some/",
  "urlIsRegex": false,
  "startedAt": 1700000000000,
  "endedAt": 1700000060000,
  "steps": [ /* Step[] */ ]
}
```

`urlPattern` and `urlIsRegex` are set by the user via the URL row in the popup. They control which URL the suite auto-selects on and which URL must be matched before replay begins.

### Step object shape

```json
{
  "type": "click" | "fill" | "select",
  "selector": "input[name=\"username\"]",
  "delay": 850,
  "url": "https://example.com/login",
  "timestamp": 1700000010000,

  // click-only
  "tag": "button",
  "text": "Submit",
  "name": "",
  "id": "submitBtn",
  "href": "",
  "value": "",

  // fill-only
  "name": "username",
  "value": "admin",

  // select-only (native <select> or custom dropdown)
  "name": "status",
  "value": "active",
  "optionText": "Active"
}
```

`delay` is the elapsed time in ms since the previous step (capped at 60 s). The first step always has `delay: 0`.

Rapid typing on the same input is collapsed: if a `fill` step arrives for the same selector as the previous `fill` step, the value is updated in-place rather than appending a new step.

---

## Features

### 1. Recording

**Start:** Click **▶ Start Recording** in the popup. The background verifies the active tab is an HTTP/HTTPS page, persists `arRecording.active = true`, and sends `SET_RECORDING: true` to the content script.

**In-page feedback:** While recording, hovered elements get a fixed-position dashed orange outline with the resolved selector shown as a label above (or inside) the element. The status dot in the popup header pulses amber.

**Captured events:**

| Event | Step type | Trigger |
|---|---|---|
| Click on a button, link, or any non-input element | `click` | `click` (capture phase) |
| Typing in `<input>` / `<textarea>` | `fill` | `input` event |
| `<input type="checkbox">` / `<input type="radio">` | `fill` | `change` event |
| Native `<select>` change | `select` | `change` event |
| Custom dropdown option click (mat-select, ng-select, nz-select, etc.) | `select` | `click` on option element |

Clicks inside `nz-select` / `.ant-select` trigger internals are suppressed — only the option click is recorded as a `select` step.

Clicks on large layout containers (e.g. `<div>`, `<nav>`, `<aside>`) with more than 5 children and no stable identity (`id`, `data-testid`, `role`, `tabindex`) are also suppressed as noise.

**Selector strategy** (`getBestSelector` in `content.js`): picks the first stable selector in priority order:

1. For `nz-select`: `name` attr → `id` attr → `data-testid`/`data-qa` → `:has(#inner-input-id)` → `nz-select:nth-of-type(n)`
2. General elements: `name` attr → `id` → `data-testid`/`data-qa` → `aria-label` (if unique) → unique visible text as XPath (`//tag[normalize-space(.)="..."]`) → meaningful class name (single or combined, skipping Angular-generated `_ng*`, `ng-*`, `cdk-*`, `mat-mdc*`) → CSS path walk up to 8 levels deep

XPath selectors are stored as-is (start with `/`) and resolved via `document.evaluate` during replay.

**Stop:** Click **⏹ Stop Recording**. The background stamps `endedAt` on the session and clears `arRecording.active`.

Steps persist across page navigations because each step is written to storage immediately when recorded, not batched at stop time.

---

### 2. Replay

**Start:** Click **▶ Replay**. The background injects the content script into the active tab (if not already present) and sends `SET_REPLAY: true` along with the suite's `urlPattern` and `urlIsRegex`.

**URL guard:** If a `urlPattern` is set, replay checks whether the current page URL matches before starting. A mismatch sends a `REPLAY_EVENT` error and aborts immediately.

**DOM readiness wait:** Replay waits up to 10 s (polling every 500 ms) for `document.body` to have children — handles Angular/Vue hydration delays.

**Playback behaviour:**
- Steps play sequentially. Between steps the content script waits for the original inter-step delay (capped at 10 s); the minimum wait is 500 ms even when `delay` is 0.
- Each replayed element is scrolled into view and briefly highlighted with a green outline (`ar-flash` class).
- Before clicking, `mouseover` and `mouseenter` are dispatched on every ancestor from `<body>` down to the element (hover chain), so Angular components that expand on `(mouseenter)` are open before the click lands.
- `click` steps use `el.click()` as the primary mechanism (trusted in most browsers); falls back to synthetic `pointerdown → mousedown → pointerup → mouseup → click` for elements without a native `.click()`.
- `fill` steps use the native `value` setter (bypasses React/Angular change-detection guards), then fire `input` → `change` → `focusout` → `blur`.
- `checkbox`/`radio` sets `.checked` directly and fires `input` → `change` → `focusout` → `blur`.
- `select` steps on native `<select>`: set `.value`, fire `change` + `input`. On custom dropdowns (mat-select, ng-select, nz-select): click the trigger to open the panel, then scan for the matching option by `optionText` or `value` — retries up to 5 × 300 ms.
- Layout containers (sidebar, nav, etc.) matched on `click` steps are hover-only during replay — `dispatchHoverChain` is called but no `.click()` fires.
- Missing elements retry up to 3 × 1 s before logging a warning and skipping. Skipped steps do not abort the replay.

**Progress bar:** While replaying, a progress bar appears in the popup showing `current / total` and the current step's selector.

**Stop:** Click **⏹ Stop Replay** at any time to cancel mid-sequence.

---

### 3. Suites

A suite is an independent named recording. Each suite has its own step list, URL, and timestamps. Suites are isolated — recording or clearing one suite does not affect others.

**Hierarchical naming:** Suite names may contain `/` to form groups (e.g. `a/test1`, `a/test2`). The dropdown renders these as `<optgroup>` sections labelled by the prefix, with only the short name shown inside the group. Root suites (no slash) appear at the top without a group.

The suite bar sits at the top of the popup below the header and contains:

| Control | Action |
|---|---|
| Dropdown | Switch the active suite. The step list and meta immediately reflect the selected suite. |
| `+` (New) | Prompt for a name → create an empty suite → switch to it. |
| Pencil (Rename) | Prompt for a new name → rename in-place, moving session data to the new storage key. |
| Trash (Delete) | Confirm → delete the suite and its session data. Blocked if only one suite exists. |
| Upload (Import) | Open file picker → import a JSON file as a new or overwritten suite (see Import below). |

All suite controls are **disabled while recording** to prevent inconsistent state.

**Auto-select on popup open:** When the popup opens (and is not currently recording), if more than one suite exists the popup checks every suite's `urlPattern`/`urlIsRegex` against the active tab's URL and automatically switches to the first matching suite. This happens only once per popup open — subsequent storage-change refreshes do not override the user's manual choice.

---

### 4. URL Pattern

Each suite stores a `urlPattern` (plain string or regex) and `urlIsRegex` flag. The URL row appears below the suite bar whenever a session exists.

| Control | Behaviour |
|---|---|
| Text input | Enter a plain URL prefix or a regex pattern. |
| `.*` toggle button | Switches between plain-URL mode and regex mode. Active state is highlighted. |
| Save (✓) button | Persists `urlPattern` + `urlIsRegex` to storage via `SAVE_SESSION_URL`. Also validates the regex before saving. |

The URL pattern is used in two places:
1. **Auto-select** — on popup open, matching suite is activated automatically.
2. **Replay guard** — replay aborts with an error if the current page URL does not match the pattern.

---

### 5. Export

Click **⬇ Export JSON** to download the active suite's session as a `.json` file.

Filename format: `action-recording-<suiteName>-<ISO-timestamp>.json`

The file is a plain JSON dump of the session object (same shape as stored in `arSession__<suiteName>`).

---

### 6. Import

Click the **upload icon** in the suite bar to open a file picker (`accept=".json"`).

**Accepted format:** any JSON file with a top-level `steps` array — i.e. any file previously exported from this extension.

**Name resolution:**
1. Reads `suiteName` from the JSON. If absent, derives a name from the filename by stripping the `action-recording-` prefix and the timestamp suffix.
2. Falls back to `"imported"` if no name can be derived.
3. If the resolved name already exists, a prompt asks the user to either accept the same name (overwrite) or enter a different one (create alongside).

After import the suite is immediately set as the active suite and the step list is shown.

---

### 7. Clear

Click **🗑 Clear** to erase all recorded steps for the active suite only. Other suites are unaffected.

If a recording is currently active, clearing also stops it (with a confirmation prompt).

---

### 8. Debug Logging

A **Hide debug logs** checkbox at the bottom of the popup controls verbose `console.log` output in the content script (`arLogEnabled` flag). Default: checked (logs hidden). The preference is persisted in `arHideLog` and applied immediately to the active tab via a `SET_HIDE_LOG` message.

---

## Message Protocol

The popup communicates with the background service worker via `chrome.runtime.sendMessage`. All messages return `{ ok: boolean, error?: string }`.

### Popup → Background

| Message type | Payload | Description |
|---|---|---|
| `START_RECORDING` | `{ tabId }` | Begin recording on the given tab. |
| `STOP_RECORDING` | — | Stop recording, stamp `endedAt`. |
| `START_REPLAY` | `{ tabId, urlPattern, urlIsRegex }` | Begin replay on the given tab. |
| `STOP_REPLAY` | — | Cancel an in-progress replay. |
| `GET_SESSION_INFO` | — | Returns `{ session, suites, active }` for the active suite. |
| `ADD_SUITE` | `{ suiteName }` | Create a new empty suite. Returns `{ suites, active }`. |
| `RENAME_SUITE` | `{ oldName, newName }` | Rename a suite, migrating its session data. Returns `{ suites, active }`. |
| `DELETE_SUITE` | `{ suiteName }` | Delete a suite and its session. Returns `{ suites, active }`. |
| `SWITCH_SUITE` | `{ suiteName }` | Set `arActiveSuite`. |
| `IMPORT_SUITE` | `{ session, suiteName }` | Write a session object under the given suite name. Returns `{ suites, active }`. |
| `CLEAR_SESSION` | `{ suiteName? }` | Remove the session for the given suite (defaults to active). |
| `CLEAR_ALL_SUITES` | — | Remove all suites, reset to `["suite1"]`. |
| `DELETE_STEP` | `{ suiteName, stepIndex }` | Remove a single step by index from the given suite. |
| `EDIT_STEP` | `{ suiteName, stepIndex, patch }` | Overwrite allowed fields (`selector`, `value`, `text`, `href`, `delay`) on a step. |
| `SAVE_SESSION_URL` | `{ suiteName, pattern, isRegex }` | Persist `urlPattern` + `urlIsRegex` onto the suite's session object. |

### Background → Content Script

| Message type | Payload | Description |
|---|---|---|
| `SET_RECORDING` | `{ value: bool }` | Toggle recording listeners in the content script. |
| `SET_REPLAY` | `{ value: bool, urlPattern, urlIsRegex }` | Start or cancel replay in the content script. |
| `SET_HIDE_LOG` | `{ value: bool }` | Toggle verbose debug logging (`arLogEnabled`) in the content script. |

### Content Script → Background → Popup (relayed)

| Message type | Payload | Description |
|---|---|---|
| `STEP_RECORDED` | `{ data: Step }` | Relay a newly recorded step to the popup for live list updates. |
| `REPLAY_STARTED` | — | Replay began. |
| `REPLAY_STEP` | `{ data: { current, total, selector, stepType } }` | Per-step progress update. |
| `REPLAY_FINISHED` | — | Replay completed normally or was cancelled. |
| `REPLAY_EVENT` | `{ data: { level, step, text } }` | Per-step warning or error during replay (`level`: `'warn'` or `'error'`). |
| `HOVER_SELECTOR` | `{ selector }` | Fired on mouseover during recording; handled on-page only (overlay label). |

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist suites and recording state in `chrome.storage.local`. |
| `scripting` | Inject `content.js` into tabs as a fallback when the declarative content script is not yet active. |
| `tabs` | Query the active tab URL and `tabId` for recording/replay. |
| `activeTab` | Required alongside `tabs` for MV3 scripting access. |
| `host_permissions: http://*/, https://*/` | Allow content script injection and tab messaging on all HTTP/HTTPS pages. |

---

## Constraints and Known Behaviour

- Recording and suite controls are locked during an active recording session to prevent race conditions.
- Steps survive page navigation within the same recording session — the content script re-activates on the new page and continues writing to the same suite key.
- Replay delay per step is capped at **10 000 ms** even if the original delay was longer, to prevent indefinite hangs. The minimum delay per step during replay is **500 ms**.
- The content script guards against double injection via `window.__actionRecorderInjected`.
- The extension does not support `chrome://`, `file://`, or extension pages — the popup shows an error if recording or replay is attempted on those URL schemes.
- Deleting the last remaining suite is blocked; at least one suite must always exist.
- Custom dropdown replay (Ant Design `nz-select`, Angular Material `mat-select`, ng-select) opens the panel by clicking the trigger surface, then scans up to 5 attempts for the matching option. If no option is found after all attempts, an `Escape` keydown is dispatched to close the panel and a warning is logged to the popup.
- `nz-select` selectors are stripped of dynamic state classes (`ant-select-open`, `ant-select-focused`, etc.) before `querySelector` is called during replay, since those classes are absent when replay starts.
