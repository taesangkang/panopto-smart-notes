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
  const editNotesBtn = document.getElementById('edit-notes-btn');
  const saveNotesBtn = document.getElementById('save-notes-btn');
  const cancelNotesBtn = document.getElementById('cancel-notes-btn');
  const notesEditStatusEl = document.getElementById('notes-edit-status');

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

  let isEditingNotes = false;
  let notesDraftText = '';
  let pendingNotesUpdateWhileEditing = false;

  function init() {
    setupEventListeners();
    requestStatus();
    loadNotesState();
    loadAiSettings();
    setupMessageListener();
    toggleNotesEditButtons();
    setNotesEditStatus('', '');
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
      isEditingNotes = false;
      notesDraftText = '';
      pendingNotesUpdateWhileEditing = false;
      toggleNotesEditButtons();
      setNotesEditStatus('', '');
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

    if (editNotesBtn) {
      editNotesBtn.addEventListener('click', enterNotesEditMode);
    }
    if (saveNotesBtn) {
      saveNotesBtn.addEventListener('click', saveNotesEdits);
    }
    if (cancelNotesBtn) {
      cancelNotesBtn.addEventListener('click', cancelNotesEdit);
    }

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
            if (isEditingNotes) {
              pendingNotesUpdateWhileEditing = true;
              setNotesEditStatus('New AI notes arrived while editing. Save or Cancel to refresh.', 'warning');
            } else {
              currentNotes = message.notes;
              renderNotes();
            }
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
        if (isEditingNotes) {
          pendingNotesUpdateWhileEditing = true;
          setNotesEditStatus('Stored notes changed while editing. Save or Cancel to refresh.', 'warning');
          return;
        }
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
    if (isEditingNotes) {
      renderNotesEditor();
      return;
    }

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
      const parsedHeading = parseCompositeHeading(heading);
      const headingLabel = parsedHeading.subheading
        ? `${parsedHeading.heading} - ${parsedHeading.subheading}`
        : parsedHeading.heading;

      html += '<div class="outline-item">';
      html += `<div class="outline-heading">${escapeHtml(headingLabel)}</div>`;
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

  function renderNotesEditor() {
    if (!notesDraftText) {
      notesDraftText = notesToEditableText(currentNotes || {});
    }
    if (!notesDraftText.trim()) {
      notesDraftText = '## Notes\n- ';
    }

    const hint = 'Edit format: # Title, ## Main Section, ### Subsection, - Bullet';
    notesContainer.innerHTML = `
      <p class="notes-edit-hint">${escapeHtml(hint)}</p>
      <textarea id="notes-editor" class="notes-editor" spellcheck="false"></textarea>
    `;

    const editor = document.getElementById('notes-editor');
    if (editor) {
      editor.value = notesDraftText;
      editor.addEventListener('input', () => {
        notesDraftText = editor.value;
      });
      window.setTimeout(() => editor.focus(), 0);
    }
  }

  function enterNotesEditMode() {
    if (isEditingNotes) return;
    isEditingNotes = true;
    pendingNotesUpdateWhileEditing = false;
    notesDraftText = notesToEditableText(currentNotes || {});
    toggleNotesEditButtons();
    renderNotes();
    setNotesEditStatus('Editing Smart Notes. Save to persist your changes.', 'success');
  }

  function cancelNotesEdit() {
    if (!isEditingNotes) return;

    isEditingNotes = false;
    notesDraftText = '';
    toggleNotesEditButtons();
    renderNotes();

    if (pendingNotesUpdateWhileEditing) {
      pendingNotesUpdateWhileEditing = false;
      loadNotesState();
      setNotesEditStatus('Edits discarded. Reloaded latest notes.', 'warning');
      return;
    }

    setNotesEditStatus('Edits discarded.', 'warning');
  }

  async function saveNotesEdits() {
    if (!isEditingNotes) return;

    const editor = document.getElementById('notes-editor');
    if (editor) {
      notesDraftText = editor.value;
    }

    let parsedNotes;
    try {
      parsedNotes = parseEditedNotesText(notesDraftText, currentNotes || {});
    } catch (error) {
      setNotesEditStatus(`Cannot save: ${error.message}`, 'error');
      return;
    }

    saveNotesBtn.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'SAVE_NOTES_STATE',
        notes: parsedNotes
      });

      if (!response || !response.success) {
        throw new Error((response && response.error) || 'Save failed');
      }

      currentNotes = response.notes || parsedNotes;
      isEditingNotes = false;
      notesDraftText = '';
      pendingNotesUpdateWhileEditing = false;
      toggleNotesEditButtons();
      renderNotes();
      setNotesEditStatus('Smart Notes saved.', 'success');
    } catch (error) {
      setNotesEditStatus(`Failed to save notes: ${error.message}`, 'error');
    } finally {
      saveNotesBtn.disabled = false;
    }
  }

  function toggleNotesEditButtons() {
    if (!editNotesBtn || !saveNotesBtn || !cancelNotesBtn) return;
    editNotesBtn.hidden = isEditingNotes;
    saveNotesBtn.hidden = !isEditingNotes;
    cancelNotesBtn.hidden = !isEditingNotes;
  }

  function setNotesEditStatus(message, variant) {
    if (!notesEditStatusEl) return;
    notesEditStatusEl.textContent = message || '';
    notesEditStatusEl.className = variant
      ? `notes-edit-status ${variant}`
      : 'notes-edit-status';
  }

  function notesToEditableText(notes) {
    const source = notes && typeof notes === 'object' ? notes : {};
    const lines = [];

    if (typeof source.title === 'string' && source.title.trim()) {
      lines.push(`# ${source.title.trim()}`);
      lines.push('');
    }

    const sections = Array.isArray(source.sections) ? source.sections : [];
    let previousMainHeading = '';
    sections.forEach((section, index) => {
      const heading = section && typeof section.heading === 'string'
        ? section.heading.trim()
        : '';
      const bullets = section && Array.isArray(section.bullets)
        ? section.bullets
        : [];

      if (!heading) return;
      const parsedHeading = parseCompositeHeading(heading);
      if (parsedHeading.subheading) {
        if (!headingsMatch(previousMainHeading, parsedHeading.heading)) {
          if (lines.length > 0 && lines[lines.length - 1] !== '') {
            lines.push('');
          }
          lines.push(`## ${parsedHeading.heading}`);
        }
        lines.push(`### ${parsedHeading.subheading}`);
        previousMainHeading = parsedHeading.heading;
      } else {
        if (lines.length > 0 && lines[lines.length - 1] !== '') {
          lines.push('');
        }
        lines.push(`## ${parsedHeading.heading}`);
        previousMainHeading = parsedHeading.heading;
      }

      bullets.forEach((bullet) => {
        if (typeof bullet === 'string' && bullet.trim()) {
          lines.push(`- ${bullet.trim()}`);
        }
      });

      if (index < sections.length - 1) {
        lines.push('');
      }
    });

    return lines.join('\n').trim();
  }

  function parseEditedNotesText(text, previousNotes) {
    const input = String(text || '').replace(/\r/g, '');
    const lines = input.split('\n');

    let title = null;
    const sections = [];
    let currentSection = null;
    let currentMainHeading = '';

    function ensureSection(headingText) {
      const heading = String(headingText || '').trim() || 'Notes';
      currentSection = { heading, bullets: [] };
      sections.push(currentSection);
      return currentSection;
    }

    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line) return;

      if (line.startsWith('### ')) {
        const subheading = line.slice(4).trim();
        if (subheading) {
          const mainHeading = currentMainHeading || 'Notes';
          if (
            currentSection &&
            headingsMatch(currentSection.heading, mainHeading) &&
            currentSection.bullets.length === 0
          ) {
            sections.pop();
          }
          ensureSection(composeCompositeHeading(mainHeading, subheading));
        }
        return;
      }

      if (line.startsWith('## ')) {
        const heading = line.slice(3).trim();
        if (heading) {
          currentMainHeading = heading;
          ensureSection(heading);
        }
        return;
      }

      if (line.startsWith('# ') && title === null) {
        const nextTitle = line.slice(2).trim();
        title = nextTitle || null;
        return;
      }

      const bulletMatch = line.match(/^([-*]|\d+\.)\s+(.+)$/);
      if (bulletMatch) {
        const bullet = bulletMatch[2].trim();
        if (!bullet) return;
        if (!currentSection) {
          ensureSection('Notes');
        }
        currentSection.bullets.push(bullet);
        return;
      }

      if (!currentSection) {
        ensureSection('Notes');
      }
      currentSection.bullets.push(line);
    });

    const cleanedSections = sections
      .map((section) => ({
        heading: String(section.heading || '').trim(),
        bullets: Array.isArray(section.bullets)
          ? section.bullets.map((bullet) => String(bullet || '').trim()).filter(Boolean)
          : []
      }))
      .filter((section) => section.heading);

    const previousTitle = previousNotes && typeof previousNotes.title === 'string' && previousNotes.title.trim()
      ? previousNotes.title.trim()
      : null;
    const nextTitle = title !== null ? title : previousTitle;

    if (!nextTitle && cleanedSections.length === 0) {
      throw new Error('Add a title, section heading, or bullet.');
    }

    const previousChunkId = previousNotes && typeof previousNotes.lastChunkId === 'string' && previousNotes.lastChunkId.trim()
      ? previousNotes.lastChunkId.trim()
      : null;

    return {
      title: nextTitle,
      sections: cleanedSections,
      lastUpdatedAt: new Date().toISOString(),
      lastChunkId: previousChunkId
    };
  }

  function parseCompositeHeading(rawHeading) {
    const heading = String(rawHeading || '').trim();
    if (!heading) {
      return { heading: 'Notes', subheading: '' };
    }

    const parts = heading
      .split('::')
      .map((part) => String(part || '').trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      return {
        heading: parts[0],
        subheading: parts.slice(1).join(' - ')
      };
    }

    return { heading, subheading: '' };
  }

  function composeCompositeHeading(mainHeading, subheading) {
    const main = String(mainHeading || '').trim() || 'Notes';
    const sub = String(subheading || '').trim();
    return sub ? `${main} :: ${sub}` : main;
  }

  function headingsMatch(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  async function loadNotesState() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_NOTES_STATE' });
      if (response && response.notes) {
        currentNotes = response.notes;
        if (!isEditingNotes) {
          renderNotes();
        }
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
