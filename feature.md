# Action Recorder — Feature Documentation

Chrome Extension (Manifest V3) for recording browser interactions and replaying them on demand.

---

## Overview

Action Recorder captures clicks and form-fill interactions on any HTTP/HTTPS page and saves them as a named **suite** of steps. Suites can be replayed, exported as JSON, imported from a file, and managed independently.

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
| `arSuites` | `string[]` | Ordered list of suite names, e.g. `["suite1", "suite2"]`. Defaults to `["suite1"]`. |
| `arActiveSuite` | `string` | Name of the currently selected suite. |
| `arSession__<suiteName>` | Session object (see below) | One key per suite. Each stores that suite's recorded steps. |

### Session object shape

```json
{
  "suiteName": "suite1",
  "url": "https://example.com/some/page",
  "startedAt": 1700000000000,
  "endedAt": 1700000060000,
  "steps": [ /* Step[] */ ]
}
```

### Step object shape

```json
{
  "type": "click" | "fill",
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
  "value": "admin"
}
```

`delay` is the elapsed time in ms since the previous step (capped at 60 s). The first step always has `delay: 0`.

---

## Features

### 1. Recording

**Start:** Click **▶ Start Recording** in the popup. The background verifies the active tab is an HTTP/HTTPS page, persists `arRecording.active = true`, and sends `SET_RECORDING: true` to the content script.

**In-page feedback:** While recording, hovered elements get a dashed orange outline. The status dot in the popup header pulses amber.

**Captured events:**
- `click` — any element except plain `<input>`, `<textarea>`, `<select>` (those are captured as fills). Button-type inputs (`type=submit/button/reset/image`) are recorded as clicks.
- `fill` — `<input>` and `<textarea>` on every `input` event; `<select>`, `<checkbox>`, and `<radio>` on `change`.

**Selector strategy** (`getBestSelector` in `content.js`): picks the first stable attribute in priority order — `name`, `id`, `data-testid`/`data-qa`, `aria-label` (if unique) — falling back to a CSS path walk up to 8 levels deep.

**Stop:** Click **⏹ Stop Recording**. The background stamps `endedAt` on the session and clears `arRecording.active`.

Steps persist across page navigations because each step is written to storage immediately when it is recorded, not batched at stop time.

---

### 2. Replay

**Start:** Click **▶ Replay**. The background injects the content script into the active tab (if not already present) and sends `SET_REPLAY: true`.

**Playback behaviour:**
- Steps play sequentially. Between steps the content script waits for the original inter-step delay (capped at 10 s) plus an additional 250 ms after each action.
- Each replayed element is scrolled into view and briefly highlighted with a green outline.
- `click` steps fire `pointerdown → mousedown → pointerup → mouseup → click` then `el.click()`.
- `fill` steps use the native `value` setter (bypasses React/Angular change detection guards), then fire `input` and `change`.
- `checkbox`/`radio` sets `.checked` directly and fires `change`.
- Missing elements log a warning to the popup status bar but do not abort the replay.

**Stop:** Click **⏹ Stop Replay** at any time to cancel mid-sequence.

---

### 3. Suites

A suite is an independent named recording. Each suite has its own step list, URL, and timestamps. Suites are isolated — recording or clearing one suite does not affect others.

The suite bar sits at the top of the popup below the header and contains:

| Control | Action |
|---|---|
| Dropdown | Switch the active suite. The step list and meta immediately reflect the selected suite. |
| `+` (New) | Prompt for a name → create an empty suite → switch to it. |
| Pencil (Rename) | Prompt for a new name → rename in-place, moving session data to the new storage key. |
| Trash (Delete) | Confirm → delete the suite and its session data. Blocked if only one suite exists. |
| Upload (Import) | Open file picker → import a JSON file as a new or overwritten suite (see Import below). |

All suite controls are **disabled while recording** to prevent inconsistent state.

---

### 4. Export

Click **⬇ Export JSON** to download the active suite's session as a `.json` file.

Filename format: `action-recording-<suiteName>-<ISO-timestamp>.json`

The file is a plain JSON dump of the session object (same shape as stored in `arSession__<suiteName>`).

---

### 5. Import

Click the **upload icon** in the suite bar to open a file picker (`accept=".json"`).

**Accepted format:** any JSON file with a top-level `steps` array — i.e. any file previously exported from this extension.

**Name resolution:**
1. Reads `suiteName` from the JSON. If absent, derives a name from the filename by stripping the `action-recording-` prefix and the timestamp suffix.
2. Falls back to `"imported"` if no name can be derived.
3. If the resolved name already exists, a prompt asks the user to either accept the same name (overwrite) or enter a different one (create alongside).

After import the suite is immediately set as the active suite and the step list is shown.

---

### 6. Clear

Click **🗑 Clear** to erase all recorded steps for the active suite only. Other suites are unaffected.

If a recording is currently active, clearing also stops it.

---

## Message Protocol

The popup communicates with the background service worker via `chrome.runtime.sendMessage`. All messages return `{ ok: boolean, error?: string }`.

| Message type | Direction | Payload | Description |
|---|---|---|---|
| `START_RECORDING` | popup → bg | `{ tabId }` | Begin recording on the given tab. |
| `STOP_RECORDING` | popup → bg | — | Stop recording, stamp `endedAt`. |
| `START_REPLAY` | popup → bg | `{ tabId }` | Begin replay on the given tab. |
| `STOP_REPLAY` | popup → bg | — | Cancel an in-progress replay. |
| `GET_SESSION_INFO` | popup → bg | — | Returns `{ session, suites, active }` for the active suite. |
| `ADD_SUITE` | popup → bg | `{ suiteName }` | Create a new empty suite. Returns `{ suites, active }`. |
| `RENAME_SUITE` | popup → bg | `{ oldName, newName }` | Rename a suite, migrating its session data. Returns `{ suites, active }`. |
| `DELETE_SUITE` | popup → bg | `{ suiteName }` | Delete a suite and its session. Returns `{ suites, active }`. |
| `SWITCH_SUITE` | popup → bg | `{ suiteName }` | Set `arActiveSuite`. |
| `IMPORT_SUITE` | popup → bg | `{ session, suiteName }` | Write a session object under the given suite name. Returns `{ suites, active }`. |
| `CLEAR_SESSION` | popup → bg | `{ suiteName }` | Remove the session for the given suite (defaults to active). |
| `CLEAR_ALL_SUITES` | popup → bg | — | Remove all suites, reset to `["suite1"]`. |
| `SET_RECORDING` | bg → content | `{ value: bool }` | Toggle recording listeners in the content script. |
| `SET_REPLAY` | bg → content | `{ value: bool }` | Start or cancel replay in the content script. |
| `STEP_RECORDED` | content → bg → popup | `{ data: Step }` | Relay a newly recorded step to the popup for live list updates. |
| `REPLAY_STARTED` | content → bg → popup | — | Replay began. |
| `REPLAY_FINISHED` | content → bg → popup | — | Replay completed normally. |
| `REPLAY_EVENT` | content → bg → popup | `{ level, step, text }` | Per-step warning or error during replay. |

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
- Replay delay per step is capped at **10 000 ms** even if the original delay was longer, to prevent indefinite hangs.
- The content script guards against double injection via `window.__actionRecorderInjected`.
- The extension does not support `chrome://`, `file://`, or extension pages — the popup shows an error if recording is attempted on those URL schemes.
- Deleting the last remaining suite is blocked; at least one suite must always exist.
