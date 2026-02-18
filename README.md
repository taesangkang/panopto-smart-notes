# Panopto Smart Notes

A Chrome Extension (Manifest V3) that captures live Panopto captions from the page DOM and turns them into structured, cumulative AI notes.

## Features

- Real-time caption capture from Panopto caption UI (DOM observers)
- Live transcript feed with clickable timestamps
- Smart chunking for note updates (time/size/pause-based finalize)
- Multi-provider AI support (BYOK):
  - Gemini
  - OpenAI (ChatGPT API)
  - Anthropic (Claude API)
- AI settings panel:
  - Provider selection
  - Per-provider API keys
  - AI Notes ON/OFF
  - Provider connection test
- Structured notes + Markdown export
- Local persistence:
  - Notes state in `chrome.storage.session`
  - AI settings in `chrome.storage.local`

## How It Works

### Caption capture

The content script waits for and monitors caption elements in the page using `MutationObserver`, with these selectors:

1. `#dockedCaptionText`
2. `[id*=Caption][id*=Text]`
3. Elements with `role` or `aria-label` containing `caption`

Each caption update is timestamped using:

- `video#primaryVideo.currentTime`, or
- first available `<video>` element fallback

### Dedupe behavior

- Ignore empty text
- Ignore exact duplicates
- If new text starts with previous text (line growth), replace the previous entry
- Otherwise append a new transcript entry

### Chunk finalize rules

A chunk is finalized when any of:

- 120 seconds elapsed
- Text length exceeds ~1500 chars
- Video paused/ended

On finalize, the service worker runs a 2-stage AI pipeline:

1. Caption cleaner
2. Notes merger (cumulative JSON update)

Then notes are merged with additional local quality checks:

- heading stability
- section matching
- semantic bullet dedupe
- filtering of banned/low-value note content

## Notes JSON Schema (v1)

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

## Installation (Load Unpacked)

1. Clone/download this repo.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Open any Panopto video page.
6. Open the extension side panel.

## Usage

1. Open side panel.
2. In **AI Settings**:
   - Choose provider
   - Paste API key for that provider
   - (Optional) click **Test Provider**
   - Turn AI Notes ON and click **Save**
3. Press **Start** to begin capture.
4. Watch live transcript update.
5. Notes update after chunk finalize (or press **Pause** to force finalize).
6. Press **Export Markdown** to download notes.

## Controls

- `Start`: begin capture
- `Pause`: pause capture + finalize current chunk
- `Clear`: clear transcript and notes state
- `Export Markdown`: export current notes as `.md`
- `Save` (AI Settings): persist provider/toggle/keys
- `Test Provider`: verify current provider key/model connectivity

## Provider Notes

- Keys are user-provided (BYOK).
- Keys are stored in `chrome.storage.local`.
- No keys are hardcoded in repository files.
- Model resolution includes provider-specific fallback behavior.

## Architecture

- `content-script.js`
  - DOM-based caption detection/capture
  - transcript buffer + chunk creation/finalize triggers
- `service-worker.js`
  - provider abstraction (Gemini/OpenAI/Anthropic)
  - 2-stage AI pipeline (clean + merge)
  - JSON parse/repair validation
  - quality merge/dedupe hardening
  - notes persistence + markdown export
- `sidepanel.html` / `sidepanel.js` / `sidepanel.css`
  - controls, status UI, AI settings, transcript + notes rendering

## Troubleshooting

### Captions not detected

- Ensure captions are enabled in Panopto player.
- Refresh the video tab after reloading the extension.
- Confirm `Caption element detected` appears in the side panel.

### Provider test fails

- Verify key is for selected provider.
- Check quota/billing/status for that provider.
- Open extension service worker console (`chrome://extensions` -> extension -> Service worker -> Inspect) for exact API error.

### Notes not updating

- Confirm AI Notes is ON.
- Confirm provider key exists for selected provider.
- Wait for chunk finalize, or press Pause to force finalize.

## Security and Privacy

- Captured transcript and notes stay in browser storage.
- External API calls only happen when AI Notes is enabled and a provider key is configured.
- Review permissions in `manifest.json` before production release.

## Current Status

This is a working MVP with real provider integrations and local quality hardening.  
Before public launch, you should still complete permission narrowing, privacy policy/docs, and release hardening.
