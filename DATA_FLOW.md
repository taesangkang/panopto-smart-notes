# Data Flow Documentation

## Overview

This document explains how data flows through the Panopto Smart Notes extension.

## Components

1. **Content Script** (`content-script.js`) - Runs in page context
2. **Service Worker** (`service-worker.js`) - Background script
3. **Side Panel** (`sidepanel.html/js`) - UI component

## Data Flow

### 1. Caption Capture Flow

```
Video Element (Page)
    ↓
Content Script detects video.textTracks
    ↓
Selects best caption track (prefers English)
    ↓
Listens to track.addEventListener('cuechange')
    ↓
On cuechange: Reads VTTCue.activeCues
    ↓
Normalizes text (trim, collapse whitespace)
    ↓
Appends to transcriptBuffer[]
    ↓
Updates currentChunk
```

### 2. Chunk Finalization Flow

```
Content Script detects chunk should finalize:
  - 120 seconds elapsed OR
  - >1500 characters OR
  - Video paused/ended
    ↓
Creates finalized chunk object:
  {
    chunkId: "chunk_123...",
    tStart: 45.2,
    tEnd: 125.8,
    text: "Full chunk text..."
  }
    ↓
Gets tail context (last 30 seconds)
    ↓
Sends message to Service Worker:
  {
    type: 'FINALIZE_CHUNK',
    chunk: {...},
    tailContext: "..."
  }
```

### 3. LLM Processing Flow

```
Service Worker receives FINALIZE_CHUNK
    ↓
Retrieves current notes state from chrome.storage.session
    ↓
Calls updateNotesWithLLM(notes, chunk, tailContext)
    ↓
[Mock LLM Function]
  - Parses chunk text
  - Extracts headings, terms, hints, questions
  - Updates notes structure
  - Returns updated notes JSON
    ↓
Saves updated notes to chrome.storage.session
    ↓
Broadcasts NOTES_UPDATE to Side Panel
```

### 4. UI Update Flow

```
Side Panel receives updates via:
  A) chrome.runtime.onMessage (direct messages)
  B) chrome.storage.onChanged (storage changes)
    ↓
Updates local state (currentTranscript, currentNotes)
    ↓
Re-renders UI:
  - Live Transcript section
  - Smart Notes section
```

### 5. User Control Flow

```
User clicks "Start" in Side Panel
    ↓
Side Panel sends: { type: 'START_CAPTURE' }
    ↓
Content Script receives message
    ↓
Sets isCapturing = true
    ↓
Begins processing cuechange events
    ↓
Sends STATUS_UPDATE back to Side Panel
```

## Message Types

### Content Script → Service Worker
- `FINALIZE_CHUNK` - New chunk ready for processing
- `STATUS_UPDATE` - Caption detection/capture status
- `TRANSCRIPT_UPDATE` - Live transcript updates

### Service Worker → Side Panel
- `NOTES_UPDATE` - Updated notes state
- `STATUS_UPDATE` - Status updates (forwarded)
- `TRANSCRIPT_UPDATE` - Transcript updates (forwarded)
- `ERROR` - Error messages

### Side Panel → Service Worker
- `GET_NOTES_STATE` - Request current notes
- `UPDATE_NOTES_STATE` - Update notes (not used currently)
- `EXPORT_MARKDOWN` - Request markdown export
- `CLEAR_SESSION` - Clear all data

### Side Panel → Content Script (via tabs.sendMessage)
- `START_CAPTURE` - Begin capturing
- `PAUSE_CAPTURE` - Pause capturing
- `CLEAR_SESSION` - Clear transcript buffer
- `GET_STATUS` - Request current status
- `SEEK_VIDEO` - Seek video to timestamp

## Storage

### chrome.storage.session
- `notesState` - Current structured notes JSON
  ```json
  {
    "title": string | null,
    "outline": [...],
    "keyTerms": [...],
    "examHints": [...],
    "openQuestions": [...],
    "lastUpdatedChunkId": string | null
  }
  ```

### In-Memory (Content Script)
- `transcriptBuffer[]` - Array of caption entries
- `currentChunk` - Current chunk being built
- `isCapturing` - Capture state flag

## Chunking Logic

A chunk is finalized when ANY condition is met:

1. **Time-based**: 120 seconds elapsed since chunk start
2. **Size-based**: >1500 characters accumulated
3. **State-based**: Video paused or ended

Each chunk includes:
- `chunkId` - Unique identifier
- `tStart` - Start timestamp (video time)
- `tEnd` - End timestamp (video time)
- `text` - Full chunk text

## Tail Context

For LLM continuity, the last 30 seconds of transcript are sent as `tailContext`:

```javascript
const cutoffTime = videoElement.currentTime - 30;
const tailContext = transcriptBuffer
  .filter(entry => entry.startTime >= cutoffTime)
  .map(entry => entry.text)
  .join(' ');
```

This helps the LLM maintain context across chunk boundaries.

## Error Handling

- **No captions detected**: Status shows "Not Detected", capture disabled
- **Video not found**: Periodic retry every 2 seconds
- **LLM error**: Error message broadcast to side panel
- **Storage error**: Console error, graceful degradation

## Robustness Features

1. **MutationObserver**: Watches for dynamic video changes
2. **Periodic video check**: Re-attaches if video removed
3. **Duplicate detection**: Prevents same cue from being added twice
4. **Text normalization**: Cleans up caption text
5. **Storage persistence**: Notes survive extension reload (session storage)
