// Panopto Smart Notes - Side Panel
// UI controller for transcript, AI settings, and structured notes.

(function() {
  'use strict';

  const captionsStatusEl = document.getElementById('captions-status');
  const captureStatusEl = document.getElementById('capture-status');
  const startBtn = document.getElementById('start-btn');
  const pauseBtn = document.getElementById('pause-btn');
  const clearBtn = document.getElementById('clear-btn');
  const exportBtn = document.getElementById('export-btn');
  const transcriptContainer = document.getElementById('transcript-container');
  const notesContainer = document.getElementById('notes-container');

  const aiEnabledToggle = document.getElementById('ai-enabled-toggle');
  const providerSelect = document.getElementById('provider-select');
  const geminiApiKeyInput = document.getElementById('gemini-api-key');
  const openaiApiKeyInput = document.getElementById('openai-api-key');
  const anthropicApiKeyInput = document.getElementById('anthropic-api-key');
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  const testProviderBtn = document.getElementById('test-provider-btn');
  const settingsStatusEl = document.getElementById('settings-status');

  let currentTranscript = [];
  let currentNotes = null;
  let latestAiSettings = null;

  function init() {
    setupEventListeners();
    requestStatus();
    loadNotesState();
    loadAiSettings();
    setupMessageListener();
  }

  function setupEventListeners() {
    startBtn.addEventListener('click', async () => {
      await sendToActiveTab({ type: 'START_CAPTURE' });
      requestStatus();
    });

    pauseBtn.addEventListener('click', async () => {
      await sendToActiveTab({ type: 'PAUSE_CAPTURE' });
      requestStatus();
    });

    clearBtn.addEventListener('click', async () => {
      currentTranscript = [];
      currentNotes = null;
      renderTranscript();
      renderNotes();

      await broadcastToTabs({ type: 'CLEAR_SESSION' });
      try {
        await chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' });
      } catch (error) {
        console.warn('Failed to clear notes state:', error);
      }
      requestStatus();
    });

    exportBtn.addEventListener('click', async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'EXPORT_MARKDOWN' });
        if (response && response.markdown) {
          downloadMarkdown(response.markdown);
        }
      } catch (error) {
        console.error('Export error:', error);
        alert('Failed to export notes');
      }
    });

    providerSelect.addEventListener('change', renderProviderHints);
    saveSettingsBtn.addEventListener('click', saveAiSettings);
    testProviderBtn.addEventListener('click', testProviderConnection);
  }

  function requestStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATUS' }, (response) => {
        if (chrome.runtime.lastError) {
          captionsStatusEl.textContent = 'Not detected';
          captionsStatusEl.className = 'status-value not-detected';
          captureStatusEl.textContent = 'Paused';
          captureStatusEl.className = 'status-value';
          startBtn.disabled = false;
          pauseBtn.disabled = true;
          return;
        }
        if (response) updateStatus(response);
      });
    });
  }

  function updateStatus(status) {
    if (status.captionsUpdating) {
      captionsStatusEl.textContent = 'Captions updating';
      captionsStatusEl.className = 'status-value capturing';
    } else if (status.captionElementDetected || status.captionsDetected) {
      captionsStatusEl.textContent = 'Caption element detected';
      captionsStatusEl.className = 'status-value detected';
    } else {
      captionsStatusEl.textContent = 'Not detected';
      captionsStatusEl.className = 'status-value not-detected';
    }

    if (status.isCapturing) {
      captureStatusEl.textContent = 'Capturing';
      captureStatusEl.className = 'status-value capturing';
      startBtn.disabled = true;
      pauseBtn.disabled = false;
    } else {
      captureStatusEl.textContent = 'Paused';
      captureStatusEl.className = 'status-value';
      startBtn.disabled = false;
      pauseBtn.disabled = true;
    }
  }

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message) => {
      switch (message.type) {
        case 'STATUS_UPDATE':
          updateStatus(message);
          break;
        case 'TRANSCRIPT_UPDATE':
          if (message.transcript) {
            currentTranscript = message.transcript;
            renderTranscript();
          }
          break;
        case 'NOTES_UPDATE':
          if (message.notes) {
            currentNotes = message.notes;
            renderNotes();
          }
          break;
        case 'ERROR':
          setSettingsStatus(message.message || 'AI processing error', true);
          break;
        default:
          break;
      }
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'session' && changes.notesState) {
        currentNotes = changes.notesState.newValue;
        renderNotes();
      }
    });
  }

  function renderTranscript() {
    if (currentTranscript.length === 0) {
      transcriptContainer.innerHTML = '<p class="empty-state">No transcript yet. Click Start to begin capturing.</p>';
      return;
    }

    const html = currentTranscript.map((entry) => {
      const timestamp = formatTimestamp(entry.startTime);
      return `
        <div class="transcript-entry" data-time="${entry.startTime}">
          <span class="transcript-timestamp">${timestamp}</span>
          <span class="transcript-text">${escapeHtml(entry.text)}</span>
        </div>
      `;
    }).join('');

    transcriptContainer.innerHTML = html;
    transcriptContainer.querySelectorAll('.transcript-entry').forEach((el) => {
      el.addEventListener('click', () => {
        const time = parseFloat(el.dataset.time);
        seekToTime(time);
      });
    });
    transcriptContainer.scrollTop = transcriptContainer.scrollHeight;
  }

  function renderNotes() {
    const notes = currentNotes || {};
    const sections = Array.isArray(notes.sections) ? notes.sections : [];
    const hasContent = Boolean(notes.title) || sections.length > 0;

    if (!hasContent) {
      notesContainer.innerHTML = '<p class="empty-state">Notes will appear here as captions are processed.</p>';
      return;
    }

    let html = '';
    if (notes.title) {
      html += `<div class="notes-title">${escapeHtml(notes.title)}</div>`;
    }

    sections.forEach((section) => {
      const heading = section && typeof section.heading === 'string' ? section.heading : 'Section';
      const bullets = section && Array.isArray(section.bullets) ? section.bullets : [];

      html += '<div class="outline-item">';
      html += `<div class="outline-heading">${escapeHtml(heading)}</div>`;
      if (bullets.length > 0) {
        html += '<ul class="outline-bullets">';
        bullets.forEach((bullet) => {
          html += `<li>${escapeHtml(bullet)}</li>`;
        });
        html += '</ul>';
      }
      html += '</div>';
    });

    notesContainer.innerHTML = html;
  }

  async function loadNotesState() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_NOTES_STATE' });
      if (response && response.notes) {
        currentNotes = response.notes;
        renderNotes();
      }
    } catch (error) {
      console.error('Failed to load notes:', error);
    }
  }

  async function loadAiSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_AI_SETTINGS' });
      const settings = response && response.settings ? response.settings : {};
      latestAiSettings = settings;

      aiEnabledToggle.checked = Boolean(settings.aiNotesEnabled);
      providerSelect.value = settings.provider || 'gemini';
      renderProviderHints();

      const keyConfigured = settings.keyConfigured || {};
      const provider = settings.provider || 'gemini';
      const isProviderConfigured = Boolean(keyConfigured[provider]);
      const modelText = settings.activeModel ? ` (${settings.activeModel})` : '';
      const providerLabel = providerSelect.options[providerSelect.selectedIndex]?.text || provider;

      setSettingsStatus(
        isProviderConfigured
          ? `${providerLabel} key saved${modelText}.`
          : `No key saved for ${providerLabel}.`,
        !isProviderConfigured
      );
    } catch (error) {
      setSettingsStatus('Failed to load AI settings.', true);
    }
  }

  function renderProviderHints() {
    const provider = providerSelect.value;
    geminiApiKeyInput.placeholder = provider === 'gemini'
      ? 'Active provider: paste Gemini API key'
      : 'Paste Gemini API key (optional)';
    openaiApiKeyInput.placeholder = provider === 'openai'
      ? 'Active provider: paste OpenAI API key'
      : 'Paste OpenAI API key (optional)';
    anthropicApiKeyInput.placeholder = provider === 'anthropic'
      ? 'Active provider: paste Anthropic API key'
      : 'Paste Anthropic API key (optional)';
  }

  async function saveAiSettings() {
    const aiNotesEnabled = aiEnabledToggle.checked;
    const provider = providerSelect.value;
    const keys = {
      gemini: geminiApiKeyInput.value.trim(),
      openai: openaiApiKeyInput.value.trim(),
      anthropic: anthropicApiKeyInput.value.trim()
    };

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_AI_SETTINGS',
        aiNotesEnabled,
        provider,
        keys
      });

      if (!response || !response.success) {
        throw new Error((response && response.error) || 'Save failed');
      }

      geminiApiKeyInput.value = '';
      openaiApiKeyInput.value = '';
      anthropicApiKeyInput.value = '';
      latestAiSettings = response.settings || latestAiSettings;
      const providerLabel = providerSelect.options[providerSelect.selectedIndex]?.text || provider;
      setSettingsStatus(`AI settings saved. Active provider: ${providerLabel}.`, false);
    } catch (error) {
      setSettingsStatus(`Failed to save settings: ${error.message}`, true);
    }
  }

  async function testProviderConnection() {
    const provider = providerSelect.value;
    const keys = {
      gemini: geminiApiKeyInput.value.trim(),
      openai: openaiApiKeyInput.value.trim(),
      anthropic: anthropicApiKeyInput.value.trim()
    };

    setSettingsStatus('Testing provider connection...', false);
    testProviderBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_AI_PROVIDER',
        provider,
        keys
      });

      if (!response || !response.success) {
        throw new Error((response && response.error) || 'Provider test failed');
      }

      const providerName = response.provider || provider;
      const modelName = response.model ? ` (${response.model})` : '';
      setSettingsStatus(`${providerName} connection OK${modelName}.`, false);
    } catch (error) {
      setSettingsStatus(`Provider test failed: ${error.message}`, true);
    } finally {
      testProviderBtn.disabled = false;
    }
  }

  function setSettingsStatus(message, isError) {
    settingsStatusEl.textContent = message;
    settingsStatusEl.className = isError
      ? 'settings-status error'
      : 'settings-status success';
  }

  function seekToTime(time) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SEEK_VIDEO', time });
    });
  }

  async function sendToActiveTab(message) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) {
          resolve(null);
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, message, () => {
          resolve(chrome.runtime.lastError ? null : true);
        });
      });
    });
  }

  async function broadcastToTabs(message) {
    return new Promise((resolve) => {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          resolve();
          return;
        }
        let remaining = tabs.length;
        tabs.forEach((tab) => {
          if (!tab.id) {
            remaining -= 1;
            if (remaining === 0) resolve();
            return;
          }
          chrome.tabs.sendMessage(tab.id, message, () => {
            remaining -= 1;
            if (remaining === 0) resolve();
          });
        });
      });
    });
  }

  function formatTimestamp(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function downloadMarkdown(markdown) {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `panopto-notes-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  init();
  setInterval(requestStatus, 2000);
})();
