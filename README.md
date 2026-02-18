# Panopto Smart Notes

A Chrome Extension (Manifest V3) that automatically captures captions from Panopto lecture videos and generates AI-powered smart notes in real-time.

## Features

- **Real-time Caption Capture**: Automatically detects and reads captions from HTML5 video elements
- **Smart Chunking**: Groups captions into ~2-minute chunks for efficient processing
- **AI-Powered Notes**: Generates structured notes including:
  - Outline with headings and bullets
  - Key terms with definitions
  - Exam hints
  - Open questions
- **Live Transcript**: View captions as they're captured
- **Export to Markdown**: Download your notes as a formatted Markdown file

## Installation

### Load as Unpacked Extension

1. **Download/Clone** this repository to your local machine

2. **Open Chrome Extensions Page**:
   - Navigate to `chrome://extensions/`
   - Or go to Menu → More Tools → Extensions

3. **Enable Developer Mode**:
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load Extension**:
   - Click "Load unpacked"
   - Select the folder containing this extension (the folder with `manifest.json`)

5. **Verify Installation**:
   - You should see "Panopto Smart Notes" in your extensions list
   - The extension icon should appear in your Chrome toolbar

## Usage

1. **Navigate to a Panopto Lecture Page**:
   - Open any page with a Panopto video player
   - The extension automatically detects video elements

2. **Open the Side Panel**:
   - Click the extension icon in your Chrome toolbar
   - Or right-click the extension icon → "Open side panel"

3. **Start Capturing**:
   - Click the "Start" button in the side panel
   - The extension will begin capturing captions in real-time

4. **View Live Transcript**:
   - Watch captions appear in the "Live Transcript" section
   - Click any transcript entry to seek the video to that timestamp

5. **View Smart Notes**:
   - Notes are automatically generated as chunks are processed
   - View outline, key terms, exam hints, and questions

6. **Export Notes**:
   - Click "Export Markdown" to download your notes as a `.md` file

## Controls

- **Start**: Begin capturing captions from the video
- **Pause**: Pause caption capture (current chunk will be finalized)
- **Clear**: Clear all transcript and notes data
- **Export Markdown**: Download notes as a Markdown file

## Architecture

### Components

1. **Content Script** (`content-script.js`):
   - Finds video elements on the page
   - Reads caption cues using `video.textTracks` and `VTTCue`
   - Groups captions into chunks (~2 minutes or 1500 characters)
   - Manages capture state

2. **Service Worker** (`service-worker.js`):
   - Handles LLM API calls (currently uses mock function)
   - Manages notes state in `chrome.storage.session`
   - Routes messages between content script and side panel

3. **Side Panel** (`sidepanel.html/js/css`):
   - Displays live transcript and smart notes
   - Provides control buttons
   - Handles export functionality

### Data Flow

```
Video Captions → Content Script → Transcript Buffer → Chunks
                                                          ↓
Side Panel ← Service Worker ← LLM Update ← Chunk + Notes State
```

### Chunking Rules

A transcript chunk is finalized when ANY of:
- 120 seconds elapsed
- >1500 characters accumulated
- Video paused/ended

### Notes Schema

```json
{
  "title": string | null,
  "outline": [
    {
      "ts": number | null,
      "heading": string,
      "bullets": string[]
    }
  ],
  "keyTerms": [
    { "term": string, "definition": string, "ts": number | null }
  ],
  "examHints": [
    { "hint": string, "ts": number | null }
  ],
  "openQuestions": string[],
  "lastUpdatedChunkId": string | null
}
```

## Technical Details

- **Manifest Version**: V3
- **Storage**: Uses `chrome.storage.session` for notes state
- **Caption Detection**: Automatically selects best caption track (prefers English)
- **Video Detection**: Finds largest visible or currently playing video
- **Robustness**: Handles dynamic video changes, missing captions, and extension reloads

## LLM Integration

Currently, the extension uses a **mock LLM function** that generates deterministic fake notes for testing. The function `updateNotesWithLLM()` in `service-worker.js` can be replaced with a real API call.

To integrate a real LLM API:

1. Update `updateNotesWithLLM()` in `service-worker.js`
2. Add API key configuration (use `chrome.storage.local` for persistence)
3. Implement proper error handling

Example structure:
```javascript
async function updateNotesWithLLM(notes, chunk, tailContext) {
  const response = await fetch('YOUR_API_ENDPOINT', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer YOUR_API_KEY'
    },
    body: JSON.stringify({
      notes_state: notes,
      new_chunk: chunk,
      tail_context: tailContext
    })
  });
  
  const updatedNotes = await response.json();
  return updatedNotes; // Must return updated notes_state JSON
}
```

## Troubleshooting

### Captions Not Detected

- Ensure the video has captions/subtitles enabled
- Check that the video player has loaded completely
- Try refreshing the page

### Extension Not Working

- Check browser console for errors (F12 → Console)
- Verify the extension is enabled in `chrome://extensions/`
- Try reloading the extension

### Notes Not Updating

- Ensure captions are being captured (check "Live Transcript" section)
- Wait for chunks to finalize (every ~2 minutes)
- Check service worker console for errors

## Development

### File Structure

```
panopto-smart-notes/
├── manifest.json          # Extension manifest
├── service-worker.js      # Background service worker
├── content-script.js      # Content script for caption capture
├── sidepanel.html         # Side panel HTML
├── sidepanel.js           # Side panel JavaScript
├── sidepanel.css          # Side panel styles
├── icon16.png            # Extension icon (16x16)
├── icon48.png            # Extension icon (48x48)
├── icon128.png           # Extension icon (128x128)
└── README.md             # This file
```

### Testing

1. Load extension as unpacked
2. Navigate to a page with video + captions
3. Open side panel and start capture
4. Verify captions appear in transcript
5. Wait for chunks to finalize and notes to appear
6. Test export functionality

## License

MIT License - feel free to use and modify as needed.

## Notes

- This is an MVP version with mock LLM integration
- Real API integration requires updating `updateNotesWithLLM()` function
- Extension works locally without external dependencies
- All data is stored locally in browser session storage
