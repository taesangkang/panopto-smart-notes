# Panopto Smart Notes

Chrome Extension (Manifest V3) that captures live Panopto captions from the DOM and turns them into cumulative structured notes with optional AI processing.

## Current Feature Set

- DOM-based live caption capture with mutation observers
- Live transcript stream with clickable timestamps
- Chunked note updates with pause-triggered finalization
- Multi-provider BYOK AI support: Gemini, OpenAI, Anthropic
- Side panel settings for provider selection, key management, and connection testing
- Structured notes editing in the side panel
- Markdown export of notes
- Local/session persistence via Chrome storage APIs

## Architecture

- `content-script.js`
  - Finds a page video element and caption element
  - Captures normalized caption text while capture is enabled
  - Builds transcript entries and rolling chunks
  - Sends status, transcript, and finalized chunk messages
- `service-worker.js`
  - Routes runtime messages between components
  - Stores notes state and AI settings
  - Runs AI processing pipeline on finalized chunks when enabled
  - Normalizes/repairs/merges cumulative notes
  - Exports notes as Markdown
- `sidepanel.html`, `sidepanel.js`, `sidepanel.css`
  - Displays status, transcript, and notes
  - Handles capture controls
  - Manages settings modal, provider keys, theme, and note editing

## Capture And Chunking Behavior

### Caption element detection

Content script checks, in order:

1. `#dockedCaptionText`
2. `[id*=Caption][id*=Text]`
3. Any element whose `id` includes both `caption` and `text`
4. `[role*="caption" i], [aria-label*="caption" i]`
5. Any element whose `role` or `aria-label` includes `caption`

### Video time source

- Preferred: `video#primaryVideo`
- Fallback: first `<video>` element on page

### Dedupe rules

- Ignore empty/whitespace-only caption text
- Ignore exact duplicate consecutive caption text
- If new caption starts with previous caption text, replace previous entry (growth update)
- Otherwise append a new transcript entry

### Finalize rules

Current chunk finalizes when any condition is true:

- 180 seconds elapsed since chunk start
- Chunk text length exceeds 5000 chars
- Video is paused or ended

When finalized, content script sends:

```json
{
  "type": "FINALIZE_CHUNK",
  "chunk": {
    "chunkId": "chunk_...",
    "tStart": 0,
    "tEnd": 0,
    "text": "..."
  },
  "tailContext": "..."
}
```

`tailContext` is built from transcript entries in the last 30 seconds of video time.

## AI Processing Pipeline

When `aiNotesEnabled` is true and the selected provider key exists:

1. Service worker applies a minimum interval rate limit between model calls.
2. Stage 1 prompt cleans noisy captions into readable lecture text.
3. Stage 2 prompt merges cleaned text into cumulative notes JSON.
4. JSON is parsed, optionally repaired, normalized, and quality-merged.
5. Updated notes are persisted to `chrome.storage.session` and broadcast to UI.

Quality merge includes:

- heading sanitization and section matching
- semantic bullet dedupe
- filtering banned low-value bullets (e.g., generic study-tip content)
- caps on sections and bullets per section

## Data Models

### Notes state (`chrome.storage.session.notesState`)

```json
{
  "title": "string | null",
  "sections": [
    {
      "heading": "string",
      "bullets": ["string"]
    }
  ],
  "lastUpdatedAt": "string | null",
  "lastChunkId": "string | null"
}
```

### AI settings (`chrome.storage.local.aiSettings`)

```json
{
  "aiNotesEnabled": "boolean",
  "provider": "gemini | openai | anthropic",
  "keys": {
    "gemini": "string",
    "openai": "string",
    "anthropic": "string"
  },
  "models": {
    "gemini": "string",
    "openai": "string",
    "anthropic": "string"
  }
}
```

### Theme preference (`chrome.storage.local.theme`)

- `"system"` (default), `"light"`, or `"dark"`

## Message Types

### Content script -> service worker

- `FINALIZE_CHUNK`
- `STATUS_UPDATE`
- `TRANSCRIPT_UPDATE`

### Service worker -> side panel

- `NOTES_UPDATE`
- `STATUS_UPDATE` (forwarded)
- `TRANSCRIPT_UPDATE` (forwarded)
- `ERROR`

### Side panel -> service worker

- `GET_NOTES_STATE`
- `GET_AI_SETTINGS`
- `SAVE_AI_SETTINGS`
- `CLEAR_PROVIDER_KEY`
- `TEST_AI_PROVIDER`
- `SAVE_NOTES_STATE`
- `EXPORT_MARKDOWN`
- `CLEAR_SESSION`

### Side panel -> content script (via `chrome.tabs.sendMessage`)

- `START_CAPTURE`
- `PAUSE_CAPTURE`
- `CLEAR_SESSION`
- `GET_STATUS`
- `SEEK_VIDEO`

## Installation (Load Unpacked)

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked and select this project folder.
4. Open a Panopto video tab and open the extension side panel.

## Usage

1. Open side panel.
2. Open Settings and configure AI provider/key (optional).
3. Toggle AI Notes on if AI note generation is desired.
4. Click Start to capture captions.
5. Click Pause to stop capture and force-finalize current chunk.
6. Click Export Markdown to download notes.

## Troubleshooting

### Captions not detected

- Confirm captions are enabled in the Panopto player.
- Reload the tab after reloading the extension.
- Check side panel status values (`Captions` and `Status`).

### AI provider test fails

- Verify provider/key pairing.
- Verify provider account quota/billing.
- Inspect service worker logs at `chrome://extensions` -> extension -> Service worker -> Inspect.

### Notes do not update

- Ensure AI Notes is enabled.
- Ensure selected provider has a configured key.
- Wait for finalize thresholds or click Pause to force finalize.
