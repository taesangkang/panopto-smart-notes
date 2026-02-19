// Panopto Smart Notes - Content Script
// Captures live captions from DOM and sends chunks for notes updates.

(function() {
  'use strict';

  let videoElement = null;
  let captionElement = null;
  let captionObserver = null;
  let documentObserver = null;
  let isCapturing = false;

  let transcriptBuffer = [];
  let currentChunk = null;
  let chunkStartWallTime = null;

  let lastCaptionUpdateAt = 0;
  let lastVideoMoveAt = 0;
  let lastVideoTimeSample = null;

  let lastSentStatus = null;

  const CHUNK_SECONDS = 180;
  const CHUNK_MAX_CHARS = 5000;
  const UPDATE_WINDOW_MS = 15000;

  function init() {
    refreshVideoElement();
    attachDocumentObserver();
    findAndAttachCaptionElement();
    setupMessageListener();
    setInterval(tick, 2000);
  }

  function tick() {
    refreshVideoMovement();
    refreshVideoElement();
    ensureCaptionElementStillAttached();
    sendStatus();
  }

  function refreshVideoElement() {
    const preferred = document.querySelector('video#primaryVideo');
    const fallback = document.querySelector('video');
    const nextVideo = preferred || fallback || null;

    if (nextVideo !== videoElement) {
      videoElement = nextVideo;
      lastVideoTimeSample = null;
    }
  }

  function attachDocumentObserver() {
    if (documentObserver) return;
    documentObserver = new MutationObserver(() => {
      refreshVideoElement();
      if (!captionElement) {
        findAndAttachCaptionElement();
      } else if (!document.contains(captionElement)) {
        detachCaptionObserver();
        findAndAttachCaptionElement();
      }
      refreshVideoMovement();
      sendStatus();
    });

    documentObserver.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function ensureCaptionElementStillAttached() {
    if (!captionElement || document.contains(captionElement)) return;
    detachCaptionObserver();
    findAndAttachCaptionElement();
  }

  function findAndAttachCaptionElement() {
    const found = findCaptionElement();
    if (!found) {
      sendStatus();
      return;
    }
    if (found === captionElement) {
      return;
    }

    detachCaptionObserver();
    captionElement = found;

    captionObserver = new MutationObserver(() => {
      handleCaptionChange();
    });
    captionObserver.observe(captionElement, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Capture immediately if element already has text.
    handleCaptionChange();
    sendStatus();
  }

  function detachCaptionObserver() {
    if (captionObserver) {
      captionObserver.disconnect();
    }
    captionObserver = null;
    captionElement = null;
  }

  function findCaptionElement() {
    const docked = document.querySelector('#dockedCaptionText');
    if (docked) return docked;

    const idSelectorMatch = document.querySelector('[id*=Caption][id*=Text]');
    if (idSelectorMatch) return idSelectorMatch;

    const idMatch = Array.from(document.querySelectorAll('[id]')).find((el) => {
      const id = (el.id || '').toLowerCase();
      return id.includes('caption') && id.includes('text');
    });
    if (idMatch) return idMatch;

    const ariaRoleSelectorMatch = document.querySelector('[role*="caption" i], [aria-label*="caption" i]');
    if (ariaRoleSelectorMatch) return ariaRoleSelectorMatch;

    const ariaOrRoleMatch = Array.from(document.querySelectorAll('[role], [aria-label]')).find((el) => {
      const role = (el.getAttribute('role') || '').toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      return role.includes('caption') || ariaLabel.includes('caption');
    });
    return ariaOrRoleMatch || null;
  }

  function handleCaptionChange() {
    if (!isCapturing || !captionElement) return;

    const rawText = captionElement.textContent || '';
    const text = normalizeText(rawText);
    if (!text) return;

    refreshVideoElement();
    refreshVideoMovement();
    const now = Date.now();
    const tNow = getVideoTime();

    const lastEntry = transcriptBuffer[transcriptBuffer.length - 1];

    // Dedupe rule: ignore exact duplicates.
    if (lastEntry && lastEntry.text === text) {
      return;
    }

    // Dedupe rule: if caption text grows, replace the previous entry.
    const shouldReplace = !!lastEntry && text.startsWith(lastEntry.text);
    if (shouldReplace) {
      lastEntry.text = text;
      lastEntry.endTime = tNow;
      lastEntry.tEnd = tNow;
      lastEntry.timestamp = now;
      replaceLastChunkPart(text, tNow);
    } else {
      if (lastEntry && tNow >= lastEntry.startTime) {
        lastEntry.endTime = tNow;
        lastEntry.tEnd = tNow;
      }
      appendTranscriptEntry(text, tNow, now);
      appendChunkPart(text, tNow);
    }

    lastCaptionUpdateAt = now;

    maybeFinalizeChunk(now);
    sendTranscriptUpdate();
    sendStatus();
  }

  function appendTranscriptEntry(text, tNow, now) {
    transcriptBuffer.push({
      text,
      startTime: tNow,
      endTime: tNow,
      tStart: tNow,
      tEnd: tNow,
      timestamp: now
    });
  }

  function appendChunkPart(text, tNow) {
    if (!currentChunk) {
      currentChunk = {
        chunkId: generateChunkId(),
        tStart: tNow,
        tEnd: tNow,
        parts: [text],
        text
      };
      chunkStartWallTime = Date.now();
      return;
    }
    currentChunk.parts.push(text);
    currentChunk.text = currentChunk.parts.join(' ');
    currentChunk.tEnd = tNow;
  }

  function replaceLastChunkPart(text, tNow) {
    if (!currentChunk || !currentChunk.parts || currentChunk.parts.length === 0) return;
    currentChunk.parts[currentChunk.parts.length - 1] = text;
    currentChunk.text = currentChunk.parts.join(' ');
    currentChunk.tEnd = tNow;
  }

  function maybeFinalizeChunk(nowMs) {
    if (!currentChunk || !chunkStartWallTime) return;
    const elapsedSeconds = (nowMs - chunkStartWallTime) / 1000;
    const shouldFinalize =
      elapsedSeconds >= CHUNK_SECONDS ||
      currentChunk.text.length > CHUNK_MAX_CHARS ||
      (videoElement && (videoElement.paused || videoElement.ended));

    if (shouldFinalize) {
      finalizeChunk();
    }
  }

  function finalizeChunk() {
    if (!currentChunk || !currentChunk.text.trim()) return;
    const finalizedChunk = {
      chunkId: currentChunk.chunkId,
      tStart: currentChunk.tStart,
      tEnd: currentChunk.tEnd,
      text: currentChunk.text
    };
    const tailContext = getTailContext();

    chrome.runtime.sendMessage({
      type: 'FINALIZE_CHUNK',
      chunk: finalizedChunk,
      tailContext
    });

    currentChunk = null;
    chunkStartWallTime = null;
  }

  function getTailContext() {
    const cutoff = getVideoTime() - 30;
    return transcriptBuffer
      .filter((entry) => entry.startTime >= cutoff)
      .map((entry) => entry.text)
      .join(' ');
  }

  function normalizeText(text) {
    return text
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\u200b/g, '');
  }

  function getVideoTime() {
    refreshVideoElement();
    return videoElement ? videoElement.currentTime || 0 : 0;
  }

  function refreshVideoMovement() {
    if (!videoElement) return;
    const now = Date.now();
    const currentTime = videoElement.currentTime || 0;
    if (lastVideoTimeSample === null) {
      lastVideoTimeSample = currentTime;
      return;
    }
    if (Math.abs(currentTime - lastVideoTimeSample) > 0.05) {
      lastVideoMoveAt = now;
    }
    lastVideoTimeSample = currentTime;
  }

  function isCaptionsUpdating() {
    const now = Date.now();
    return (
      now - lastCaptionUpdateAt <= UPDATE_WINDOW_MS &&
      now - lastVideoMoveAt <= UPDATE_WINDOW_MS
    );
  }

  function buildStatusPayload() {
    const captionsDetected = !!captionElement;
    const captionsUpdating = captionsDetected && isCaptionsUpdating();
    return {
      type: 'STATUS_UPDATE',
      captionsDetected,
      captionElementDetected: captionsDetected,
      captionsUpdating,
      isCapturing,
      videoFound: !!videoElement
    };
  }

  function sendStatus(force) {
    const payload = buildStatusPayload();
    if (!force && lastSentStatus && shallowStatusEqual(payload, lastSentStatus)) {
      return;
    }
    lastSentStatus = payload;
    chrome.runtime.sendMessage(payload);
  }

  function shallowStatusEqual(a, b) {
    return (
      a.captionsDetected === b.captionsDetected &&
      a.captionElementDetected === b.captionElementDetected &&
      a.captionsUpdating === b.captionsUpdating &&
      a.isCapturing === b.isCapturing &&
      a.videoFound === b.videoFound
    );
  }

  function sendTranscriptUpdate() {
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT_UPDATE',
      transcript: transcriptBuffer.slice(-50),
      currentChunk: currentChunk
        ? {
            chunkId: currentChunk.chunkId,
            tStart: currentChunk.tStart,
            tEnd: currentChunk.tEnd,
            text: currentChunk.text
          }
        : null
    });
  }

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {
        case 'START_CAPTURE':
          isCapturing = true;
          refreshVideoElement();
          findAndAttachCaptionElement();
          refreshVideoMovement();
          sendStatus(true);
          break;

        case 'PAUSE_CAPTURE':
          isCapturing = false;
          if (currentChunk) {
            finalizeChunk();
          }
          sendStatus(true);
          break;

        case 'CLEAR_SESSION':
          transcriptBuffer = [];
          currentChunk = null;
          chunkStartWallTime = null;
          lastCaptionUpdateAt = 0;
          isCapturing = false;
          chrome.runtime.sendMessage({
            type: 'TRANSCRIPT_UPDATE',
            transcript: [],
            currentChunk: null
          });
          sendStatus(true);
          break;

        case 'GET_STATUS':
          refreshVideoElement();
          refreshVideoMovement();
          sendResponse({
            captionsDetected: !!captionElement,
            captionElementDetected: !!captionElement,
            captionsUpdating: !!captionElement && isCaptionsUpdating(),
            isCapturing,
            videoFound: !!videoElement
          });
          break;

        case 'SEEK_VIDEO':
          if (videoElement && typeof message.time === 'number') {
            videoElement.currentTime = message.time;
          }
          break;

        default:
          break;
      }
      return true;
    });
  }

  function generateChunkId() {
    return `chunk_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


