# Data Flow Documentation

## Overview

This document describes the runtime data flow in the current implementation of Panopto Smart Notes.

## Components

1. Content script (`content-script.js`): runs in page context, captures captions, builds transcript/chunks.
2. Service worker (`service-worker.js`): receives events, runs AI pipeline, persists and broadcasts notes.
3. Side panel (`sidepanel.html`, `sidepanel.js`): UI for controls, transcript, notes, and settings.

## End-To-End Flow

### 1. Caption capture in page context

```text
Page DOM updates
  -> content script MutationObservers run
  -> video element and caption element are discovered/validated
  -> caption text is normalized
  -> transcript entry is deduped/inserted or previous entry is replaced
  -> current chunk text is updated
  -> STATUS_UPDATE + TRANSCRIPT_UPDATE are emitted
```

The content script only appends transcript data while `isCapturing` is true.

### 2. Chunk finalization

```text
Chunk is finalized when any condition is true:
  - elapsed >= 180 seconds
  - chunk text length > 5000 chars
  - video is paused or ended
  -> build finalized chunk payload
  -> compute tailContext from last 30 seconds of transcript
  -> send FINALIZE_CHUNK to service worker
```

Finalized chunk shape:

```json
{
  "chunkId": "chunk_123...",
  "tStart": 45.2,
  "tEnd": 125.8,
  "text": "Full chunk text..."
}
```

### 3. AI note update pipeline in service worker

```text
Service worker receives FINALIZE_CHUNK
  -> load notesState from chrome.storage.session
  -> load aiSettings from chrome.storage.local
  -> if AI disabled or provider key missing: stop
  -> enforce minimum LLM call interval
  -> run caption-cleaning model call
  -> run notes-merging model call
  -> parse/repair/normalize returned JSON
  -> quality-merge with previous notes
  -> save notesState to chrome.storage.session
  -> broadcast NOTES_UPDATE
```

### 4. Side panel UI updates

```text
Side panel receives runtime messages and storage change events
  -> update local transcript/notes/settings state
  -> render status, transcript, notes, and settings UI
```

### 5. User control path

```text
User clicks Start in side panel
  -> side panel sends START_CAPTURE to active tab
  -> content script sets isCapturing = true
  -> content script emits STATUS_UPDATE
```

Pause flow:

```text
User clicks Pause
  -> side panel sends PAUSE_CAPTURE
  -> content script sets isCapturing = false
  -> content script finalizes current chunk if present
```

Clear flow:

```text
User clicks Clear
  -> side panel clears local UI state
  -> side panel sends CLEAR_SESSION to all tabs (content scripts)
  -> side panel sends CLEAR_SESSION to service worker
  -> service worker removes notesState from session storage
```

## Message Types

### Content script -> service worker

- `FINALIZE_CHUNK`: finalized chunk + tail context for AI update.
- `STATUS_UPDATE`: caption/video/capture status.
- `TRANSCRIPT_UPDATE`: latest transcript slice and current chunk snapshot.

### Service worker -> side panel

- `NOTES_UPDATE`: updated notes state.
- `STATUS_UPDATE`: forwarded from content script.
- `TRANSCRIPT_UPDATE`: forwarded from content script.
- `ERROR`: provider/model/runtime errors.

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

## Storage

### `chrome.storage.session`

- `notesState`

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

### `chrome.storage.local`

- `aiSettings`
- `theme`

`aiSettings` contains:

- `aiNotesEnabled`
- `provider`
- `keys` per provider (`gemini`, `openai`, `anthropic`)
- `models` per provider

### In-memory state (content script)

- `transcriptBuffer[]`
- `currentChunk`
- `isCapturing`
- status timing markers (`lastCaptionUpdateAt`, `lastVideoMoveAt`)

## Tail Context Logic

Tail context is built from the last 30 seconds of transcript relative to current video time:

```javascript
const cutoff = getVideoTime() - 30;
const tailContext = transcriptBuffer
  .filter((entry) => entry.startTime >= cutoff)
  .map((entry) => entry.text)
  .join(' ');
```

This provides local continuity across chunk boundaries.

## Error Handling And Robustness

- Missing caption element: observer keeps searching and status reflects detection state.
- Video element changes: periodic checks and mutation observer refresh references.
- Duplicate/noisy caption updates: normalization + dedupe rules reduce churn.
- AI/provider errors: service worker catches and emits `ERROR` messages.
- Side panel availability: service worker broadcast errors are ignored if panel is closed.
