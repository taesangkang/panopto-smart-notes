// Panopto Smart Notes - Service Worker
// Handles model calls, note updates, and side panel routing.

(function() {
  'use strict';

  const PROVIDERS = {
    GEMINI: 'gemini',
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic'
  };
  const DEFAULT_PROVIDER = PROVIDERS.GEMINI;
  const DEFAULT_MODELS = {
    [PROVIDERS.GEMINI]: 'gemini-2.0-flash',
    [PROVIDERS.OPENAI]: 'gpt-4o-mini',
    [PROVIDERS.ANTHROPIC]: 'claude-3-5-haiku-latest'
  };

  const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
  const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
  const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

  const MIN_LLM_INTERVAL_MS = 5000;
  const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
  const MAX_SECTIONS = 30;
  const MAX_BULLETS_PER_SECTION = 80;

  const PREFERRED_MODELS = {
    [PROVIDERS.GEMINI]: [
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-pro'
    ],
    [PROVIDERS.OPENAI]: [
      'gpt-4.1-mini',
      'gpt-4o-mini',
      'gpt-4o'
    ],
    [PROVIDERS.ANTHROPIC]: [
      'claude-3-5-haiku-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-7-sonnet-latest'
    ]
  };

  const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
    'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to',
    'was', 'were', 'with', 'we', 'you', 'your'
  ]);

  const FILLER_ONLY_RE = /^(uh+|um+|hmm+|mm+|yeah+|okay+|ok+|right+|so+|well+|like+|you know|i mean|alright|all right|let's see|huh)[\s,.\-!?]*$/i;
  const BANNED_NOTE_CONTENT_RE = /(exam tips?|study tips?|helpful hints?|key takeaways?|test strategy|quiz strategy)/i;

  let llmQueue = Promise.resolve();
  let lastLlmCallAt = 0;
  const modelCache = {
    [PROVIDERS.GEMINI]: { apiKey: '', fetchedAt: 0, models: [] },
    [PROVIDERS.OPENAI]: { apiKey: '', fetchedAt: 0, models: [] }
  };

  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setOptions({ enabled: true });
  });

  chrome.action.onClicked.addListener((tab) => {
    chrome.sidePanel.open({ tabId: tab.id });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'FINALIZE_CHUNK':
        llmQueue = llmQueue
          .then(() => handleFinalizeChunk(message.chunk, message.tailContext))
          .catch((error) => console.error('Chunk processing failed:', error));
        break;

      case 'STATUS_UPDATE':
      case 'TRANSCRIPT_UPDATE':
        broadcastToSidePanel(message);
        break;

      case 'GET_NOTES_STATE':
        getNotesState().then((notes) => sendResponse({ notes }));
        return true;

      case 'GET_AI_SETTINGS':
        getAiSettings().then((settings) => {
          sendResponse({ settings: buildAiSettingsView(settings) });
        });
        return true;

      case 'SAVE_AI_SETTINGS':
        saveAiSettings(message)
          .then((settings) => sendResponse({ success: true, settings: buildAiSettingsView(settings) }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'TEST_AI_PROVIDER':
        testAiProvider(message)
          .then((result) => sendResponse({ success: true, ...result }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'EXPORT_MARKDOWN':
        exportToMarkdown().then((markdown) => sendResponse({ markdown }));
        return true;

      case 'SAVE_NOTES_STATE':
        saveManualNotesState(message.notes)
          .then((notes) => sendResponse({ success: true, notes }))
          .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;

      case 'CLEAR_SESSION':
        clearSession().then(() => sendResponse({ success: true }));
        return true;

      default:
        break;
    }
    return false;
  });

  async function handleFinalizeChunk(chunk, tailContext) {
    if (!chunk || !chunk.text || !chunk.text.trim()) return;

    const currentNotes = await getNotesState();
    const aiSettings = await getAiSettings();
    if (!aiSettings.aiNotesEnabled) return;

    const provider = isValidProvider(aiSettings.provider) ? aiSettings.provider : DEFAULT_PROVIDER;
    const apiKey = getProviderApiKey(aiSettings, provider);
    if (!apiKey) {
      broadcastToSidePanel({
        type: 'ERROR',
        message: `AI Notes enabled, but no API key saved for ${provider}.`
      });
      return;
    }

    await waitForRateLimit();

    try {
      const resolvedModel = await resolveModelForProvider(provider, apiKey, aiSettings.models[provider]);
      const updatedNotes = await updateNotesWithLLM(currentNotes, chunk, tailContext || '', {
        provider,
        apiKey,
        model: resolvedModel
      });

      await updateNotesState(updatedNotes);
      broadcastToSidePanel({ type: 'NOTES_UPDATE', notes: updatedNotes });
    } catch (error) {
      console.error(`Error updating notes with ${provider}:`, error);
      broadcastToSidePanel({
        type: 'ERROR',
        message: `${provider} notes update failed: ${error.message}`
      });
    }
  }

  async function updateNotesWithLLM(notes, chunk, tailContext, aiContext) {
    const previousNotes = normalizeNotesState(notes);
    const cleanedRaw = await runCaptionCleaner(chunk.text, tailContext, aiContext);
    const cleanText = tightenCleanTranscript(cleanedRaw);

    if (!cleanText.trim()) {
      return {
        ...previousNotes,
        lastChunkId: chunk.chunkId || previousNotes.lastChunkId
      };
    }

    const mergedRaw = await runNotesMerger(previousNotes, cleanText, aiContext);
    const mergedParsed = await parseAndValidateNotesJson(mergedRaw, aiContext);
    const qualityMerged = enforceCumulativeQuality(previousNotes, mergedParsed);

    return {
      ...qualityMerged,
      lastUpdatedAt: new Date().toISOString(),
      lastChunkId: chunk.chunkId || qualityMerged.lastChunkId || null
    };
  }

  async function runCaptionCleaner(chunkText, tailContext, aiContext) {
    const systemPrompt = [
      'You clean noisy live lecture captions into clear academic text.',
      'Rules:',
      '- Remove filler words, false starts, and casual backchanneling.',
      '- Reconstruct broken sentences and punctuation.',
      '- Keep only lecture substance: definitions, methods, examples, comparisons, conclusions.',
      '- Preserve technical terms, equations, symbols, and numeric values exactly.',
      '- Do NOT summarize or shorten substantive content.',
      '- Output plain text paragraphs only (no bullets, no headings).'
    ].join('\n');

    const userPrompt = [
      'Tail context (may overlap):',
      tailContext || '',
      '',
      'New caption chunk:',
      chunkText
    ].join('\n');

    return callModelText({
      provider: aiContext.provider,
      apiKey: aiContext.apiKey,
      model: aiContext.model,
      systemPrompt,
      userPrompt,
      temperature: 0.15
    });
  }

  async function runNotesMerger(notes, cleanText, aiContext) {
    const headings = notes.sections.map((s) => s.heading).join(' | ');
    const systemPrompt = [
      'You are an expert lecture note-taker maintaining one cumulative lecture note document.',
      'You will merge new cleaned transcript text into existing notes JSON.',
      '',
      'Strict rules:',
      '- Use only transcript-supported content.',
      '- No exam tips, study tips, helpful hints, or key takeaways.',
      '- Keep headings stable unless a clearly new topic appears.',
      '- Avoid duplicates; do not re-add an existing point.',
      '- Prefer appending concise technical bullets to existing sections.',
      '- Use specific concept headings instead of generic labels like "Lecture 6" alone.',
      '- When useful, encode hierarchy in heading text as "Main Topic :: Subtopic".',
      '- Keep sections focused: split broad sections into narrower subtopics when they become too large.',
      '- Keep bullets concise and factual.',
      '- Return ONLY valid JSON matching the schema exactly.'
    ].join('\n');

    const userPrompt = [
      'Schema:',
      '{ "title": string | null, "sections": [{ "heading": string, "bullets": string[] }], "lastUpdatedAt": string | null, "lastChunkId": string | null }',
      '',
      'Existing heading inventory:',
      headings || '(none)',
      '',
      'Existing notes JSON:',
      JSON.stringify(notes, null, 2),
      '',
      'New cleaned transcript:',
      cleanText
    ].join('\n');

    return callModelText({
      provider: aiContext.provider,
      apiKey: aiContext.apiKey,
      model: aiContext.model,
      systemPrompt,
      userPrompt,
      temperature: 0.05,
      responseMimeType: 'application/json'
    });
  }

  async function parseAndValidateNotesJson(rawText, aiContext) {
    const parsed = tryParseJson(rawText);
    if (parsed) return normalizeNotesState(parsed);

    const repairedText = await repairNotesJson(rawText, aiContext);
    const repaired = tryParseJson(repairedText);
    if (!repaired) {
      throw new Error('Model output could not be parsed as valid JSON.');
    }
    return normalizeNotesState(repaired);
  }

  async function repairNotesJson(invalidText, aiContext) {
    const systemPrompt = [
      'Repair invalid JSON output.',
      'Return only valid JSON. No markdown. No prose.',
      'Target schema exactly:',
      '{ "title": string | null, "sections": [{ "heading": string, "bullets": string[] }], "lastUpdatedAt": string | null, "lastChunkId": string | null }'
    ].join('\n');

    const userPrompt = [
      'Fix this invalid JSON output:',
      invalidText
    ].join('\n');

    return callModelText({
      provider: aiContext.provider,
      apiKey: aiContext.apiKey,
      model: aiContext.model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      responseMimeType: 'application/json'
    });
  }

  async function callModelText(params) {
    switch (params.provider) {
      case PROVIDERS.GEMINI:
        return callGeminiText(params);
      case PROVIDERS.OPENAI:
        return callOpenAIText(params);
      case PROVIDERS.ANTHROPIC:
        return callAnthropicText(params);
      default:
        throw new Error(`Unsupported provider: ${params.provider}`);
    }
  }

  async function callGeminiText(params) {
    const requestedModel = normalizeModelName(params.model || DEFAULT_MODELS[PROVIDERS.GEMINI]);
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(requestedModel)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;
    const body = {
      systemInstruction: {
        parts: [{ text: params.systemPrompt }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: params.userPrompt }]
        }
      ],
      generationConfig: {
        temperature: typeof params.temperature === 'number' ? params.temperature : 0.2
      }
    };
    if (params.responseMimeType) {
      body.generationConfig.responseMimeType = params.responseMimeType;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      if (response.status === 404 && !params._retriedModel) {
        const fallbackModel = await resolveGeminiModel(params.apiKey, requestedModel);
        if (fallbackModel && fallbackModel !== requestedModel) {
          return callGeminiText({ ...params, model: fallbackModel, _retriedModel: true });
        }
      }
      const errorBody = await response.text();
      throw new Error(`Gemini API ${response.status} (${requestedModel}): ${errorBody.slice(0, 400)}`);
    }

    const data = await response.json();
    const text = extractGeminiText(data);
    if (!text) throw new Error('Gemini returned no text output.');
    return text;
  }

  async function callOpenAIText(params) {
    const requestedModel = params.model || DEFAULT_MODELS[PROVIDERS.OPENAI];
    const body = {
      model: requestedModel,
      temperature: typeof params.temperature === 'number' ? params.temperature : 0.2,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt }
      ]
    };
    if (params.responseMimeType === 'application/json' && !params._retryWithoutJsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${params.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      if (response.status === 404 && !params._retriedModel) {
        const fallbackModel = await resolveOpenAIModel(params.apiKey, requestedModel);
        if (fallbackModel && fallbackModel !== requestedModel) {
          return callOpenAIText({ ...params, model: fallbackModel, _retriedModel: true });
        }
      }
      if (response.status === 400 && body.response_format && !params._retryWithoutJsonMode) {
        return callOpenAIText({ ...params, _retryWithoutJsonMode: true });
      }
      const errorBody = await response.text();
      throw new Error(`OpenAI API ${response.status} (${requestedModel}): ${errorBody.slice(0, 400)}`);
    }

    const data = await response.json();
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : '';
    const text = extractOpenAIText(content);
    if (!text) throw new Error('OpenAI returned no text output.');
    return text;
  }

  async function callAnthropicText(params) {
    const requestedModel = params.model || DEFAULT_MODELS[PROVIDERS.ANTHROPIC];
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: requestedModel,
        max_tokens: 2048,
        temperature: typeof params.temperature === 'number' ? params.temperature : 0.2,
        system: params.systemPrompt,
        messages: [
          { role: 'user', content: params.userPrompt }
        ]
      })
    });

    if (!response.ok) {
      if (response.status === 404 && !params._retriedModel) {
        const fallbackModel = resolveAnthropicModel(requestedModel);
        if (fallbackModel && fallbackModel !== requestedModel) {
          return callAnthropicText({ ...params, model: fallbackModel, _retriedModel: true });
        }
      }
      const errorBody = await response.text();
      throw new Error(`Anthropic API ${response.status} (${requestedModel}): ${errorBody.slice(0, 400)}`);
    }

    const data = await response.json();
    const text = extractAnthropicText(data);
    if (!text) throw new Error('Anthropic returned no text output.');
    return text;
  }

  function extractGeminiText(data) {
    const candidate = data && data.candidates && data.candidates[0];
    if (!candidate || !candidate.content || !Array.isArray(candidate.content.parts)) return '';
    return candidate.content.parts
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }

  function extractOpenAIText(content) {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item.text === 'string') return item.text;
          if (item && item.type === 'text' && typeof item.value === 'string') return item.value;
          return '';
        })
        .join('')
        .trim();
    }
    return '';
  }

  function extractAnthropicText(data) {
    const parts = data && Array.isArray(data.content) ? data.content : [];
    return parts
      .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }

  function tryParseJson(text) {
    if (!text || typeof text !== 'string') return null;
    const stripped = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    try {
      return JSON.parse(stripped);
    } catch (e) {
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(stripped.slice(start, end + 1));
        } catch (ignored) {
          return null;
        }
      }
      return null;
    }
  }

  function tightenCleanTranscript(text) {
    if (!text || typeof text !== 'string') return '';
    const rawParts = text
      .replace(/\r/g, '\n')
      .split(/\n+/)
      .flatMap((line) => line.split(/(?<=[.!?])\s+/));

    const cleaned = [];
    for (const part of rawParts) {
      const sentence = normalizeSentence(part);
      if (!sentence) continue;
      if (isFillerSentence(sentence)) continue;
      const last = cleaned[cleaned.length - 1];
      if (last && isNearDuplicateText(last, sentence)) continue;
      cleaned.push(sentence);
    }

    return cleaned.join(' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeSentence(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^\s*[-*\u2022]+\s*/, '')
      .trim();
  }

  function isFillerSentence(sentence) {
    if (!sentence) return true;
    if (FILLER_ONLY_RE.test(sentence)) return true;
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return true;
    const tokens = normalized.split(' ').filter(Boolean);
    if (tokens.length <= 2) {
      return tokens.every((token) => [
        'uh', 'um', 'hmm', 'yeah', 'okay', 'ok', 'right', 'so', 'well', 'like'
      ].includes(token));
    }
    return false;
  }

  function normalizeNotesState(input) {
    const base = defaultNotesState();
    if (!input || typeof input !== 'object') return base;

    if (typeof input.title === 'string' && input.title.trim()) {
      base.title = input.title.trim();
    }

    const sections = [];
    const sourceSections = Array.isArray(input.sections)
      ? input.sections
      : (Array.isArray(input.outline) ? input.outline : []);

    sourceSections.forEach((section) => {
      const heading = sanitizeHeading(section && section.heading);
      const bullets = Array.isArray(section && section.bullets)
        ? section.bullets.map(sanitizeBullet).filter(Boolean)
        : [];
      if (heading) {
        sections.push({ heading, bullets });
      }
    });
    base.sections = sections.slice(0, MAX_SECTIONS);

    if (typeof input.lastUpdatedAt === 'string' && input.lastUpdatedAt.trim()) {
      base.lastUpdatedAt = input.lastUpdatedAt.trim();
    } else if (input.lastUpdatedAt === null) {
      base.lastUpdatedAt = null;
    }

    if (typeof input.lastChunkId === 'string' && input.lastChunkId.trim()) {
      base.lastChunkId = input.lastChunkId.trim();
    } else if (typeof input.lastUpdatedChunkId === 'string' && input.lastUpdatedChunkId.trim()) {
      base.lastChunkId = input.lastUpdatedChunkId.trim();
    } else if (input.lastChunkId === null) {
      base.lastChunkId = null;
    }

    return base;
  }

  function enforceCumulativeQuality(previousNotes, candidateNotes) {
    const previous = normalizeNotesState(previousNotes);
    const candidate = normalizeNotesState(candidateNotes);

    const merged = {
      title: previous.title || candidate.title || null,
      sections: previous.sections.map((section) => ({
        heading: section.heading,
        bullets: dedupeBullets(section.bullets)
      })),
      lastUpdatedAt: candidate.lastUpdatedAt || previous.lastUpdatedAt,
      lastChunkId: candidate.lastChunkId || previous.lastChunkId
    };

    candidate.sections.forEach((incomingSection) => {
      const heading = sanitizeHeading(incomingSection.heading);
      const incomingBullets = dedupeBullets(incomingSection.bullets);
      if (!heading || incomingBullets.length === 0) return;

      const index = findMatchingSectionIndex(merged.sections, heading);
      if (index >= 0) {
        merged.sections[index].bullets = dedupeBullets([
          ...merged.sections[index].bullets,
          ...incomingBullets
        ]);
      } else if (isUsefulHeading(heading)) {
        merged.sections.push({ heading, bullets: incomingBullets });
      }
    });

    merged.sections = merged.sections
      .map((section) => ({
        heading: sanitizeHeading(section.heading),
        // Keep the most recent bullets so live notes continue updating in long lectures.
        bullets: dedupeBullets(section.bullets).slice(-MAX_BULLETS_PER_SECTION)
      }))
      .filter((section) => section.heading && section.bullets.length > 0)
      .slice(0, MAX_SECTIONS);

    return merged;
  }

  function sanitizeHeading(heading) {
    if (typeof heading !== 'string') return '';
    const clean = heading.replace(/\s+/g, ' ').replace(/[:\-\u2013\s]+$/, '').trim();
    if (!clean || clean.length < 3) return '';
    return clean;
  }

  function sanitizeBullet(bullet) {
    if (typeof bullet !== 'string') return '';
    let clean = bullet.replace(/\s+/g, ' ').trim();
    clean = clean.replace(/^\s*[-*\u2022\d.)]+\s*/, '').trim();
    if (!clean) return '';
    if (BANNED_NOTE_CONTENT_RE.test(clean)) return '';
    if (clean.length < 8) return '';
    return clean;
  }

  function isUsefulHeading(heading) {
    if (!heading) return false;
    const key = canonicalHeading(heading);
    if (!key) return false;
    return key !== 'lecture notes' && key !== 'notes';
  }

  function dedupeBullets(bullets) {
    const out = [];
    for (const raw of bullets || []) {
      const bullet = sanitizeBullet(raw);
      if (!bullet) continue;
      const duplicate = out.some((existing) => isNearDuplicateText(existing, bullet));
      if (!duplicate) out.push(bullet);
    }
    return out;
  }

  function isNearDuplicateText(a, b) {
    if (!a || !b) return false;
    const an = semanticTextKey(a);
    const bn = semanticTextKey(b);
    if (!an || !bn) return false;
    if (an === bn) return true;
    if (an.includes(bn) || bn.includes(an)) return true;
    return tokenSetSimilarity(an, bn) >= 0.82;
  }

  function semanticTextKey(text) {
    const tokens = String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !STOPWORDS.has(t));
    return tokens.slice(0, 18).join(' ');
  }

  function tokenSetSimilarity(a, b) {
    const aSet = new Set(a.split(' ').filter(Boolean));
    const bSet = new Set(b.split(' ').filter(Boolean));
    if (aSet.size === 0 || bSet.size === 0) return 0;
    let intersection = 0;
    aSet.forEach((token) => {
      if (bSet.has(token)) intersection += 1;
    });
    return intersection / Math.max(aSet.size, bSet.size);
  }

  function canonicalHeading(heading) {
    return String(heading || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((t) => !STOPWORDS.has(t))
      .slice(0, 8)
      .join(' ');
  }

  function findMatchingSectionIndex(sections, heading) {
    const target = canonicalHeading(heading);
    if (!target) return -1;

    for (let i = 0; i < sections.length; i += 1) {
      if (canonicalHeading(sections[i].heading) === target) return i;
    }

    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < sections.length; i += 1) {
      const score = tokenSetSimilarity(target, canonicalHeading(sections[i].heading));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestScore >= 0.72 ? bestIndex : -1;
  }

  async function resolveModelForProvider(provider, apiKey, requestedModel) {
    switch (provider) {
      case PROVIDERS.GEMINI:
        return resolveGeminiModel(apiKey, requestedModel);
      case PROVIDERS.OPENAI:
        return resolveOpenAIModel(apiKey, requestedModel);
      case PROVIDERS.ANTHROPIC:
        return resolveAnthropicModel(requestedModel);
      default:
        return requestedModel || DEFAULT_MODELS[DEFAULT_PROVIDER];
    }
  }

  async function resolveGeminiModel(apiKey, requestedModel) {
    const available = await listGeminiModels(apiKey);
    return pickModel(available, requestedModel, PREFERRED_MODELS[PROVIDERS.GEMINI], DEFAULT_MODELS[PROVIDERS.GEMINI]);
  }

  async function resolveOpenAIModel(apiKey, requestedModel) {
    const available = await listOpenAIModels(apiKey);
    return pickModel(available, requestedModel, PREFERRED_MODELS[PROVIDERS.OPENAI], DEFAULT_MODELS[PROVIDERS.OPENAI]);
  }

  function resolveAnthropicModel(requestedModel) {
    const requested = normalizeModelName(requestedModel || '');
    if (requested) return requested;
    return PREFERRED_MODELS[PROVIDERS.ANTHROPIC][0];
  }

  function pickModel(available, requested, preferredOrder, fallbackDefault) {
    const normalized = available.map(normalizeModelName).filter(Boolean);
    const requestedNorm = normalizeModelName(requested || '');
    if (requestedNorm && normalized.includes(requestedNorm)) return requestedNorm;
    for (const preferred of preferredOrder) {
      if (normalized.includes(preferred)) return preferred;
    }
    if (normalized.length > 0) return normalized[0];
    return fallbackDefault;
  }

  async function listGeminiModels(apiKey) {
    const cache = modelCache[PROVIDERS.GEMINI];
    const now = Date.now();
    if (cache.apiKey === apiKey && now - cache.fetchedAt < MODEL_CACHE_TTL_MS && cache.models.length > 0) {
      return cache.models.slice();
    }

    const url = `${GEMINI_API_BASE}?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gemini ListModels failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const names = models
      .filter((model) => {
        const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
        return methods.includes('generateContent');
      })
      .map((model) => normalizeModelName(model.name))
      .filter(Boolean);

    modelCache[PROVIDERS.GEMINI] = { apiKey, fetchedAt: now, models: names };
    return names.slice();
  }

  async function listOpenAIModels(apiKey) {
    const cache = modelCache[PROVIDERS.OPENAI];
    const now = Date.now();
    if (cache.apiKey === apiKey && now - cache.fetchedAt < MODEL_CACHE_TTL_MS && cache.models.length > 0) {
      return cache.models.slice();
    }

    const response = await fetch(OPENAI_MODELS_URL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI ListModels failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : [];
    const names = models
      .map((model) => (model && typeof model.id === 'string' ? model.id.trim() : ''))
      .filter(Boolean);

    modelCache[PROVIDERS.OPENAI] = { apiKey, fetchedAt: now, models: names };
    return names.slice();
  }

  function normalizeModelName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.replace(/^models\//, '').trim();
  }

  function defaultNotesState() {
    return {
      title: null,
      sections: [],
      lastUpdatedAt: null,
      lastChunkId: null
    };
  }

  async function getNotesState() {
    const result = await chrome.storage.session.get(['notesState']);
    return normalizeNotesState(result.notesState);
  }

  async function updateNotesState(notes) {
    await chrome.storage.session.set({ notesState: normalizeNotesState(notes) });
  }

  async function saveManualNotesState(notes) {
    const normalized = normalizeNotesState(notes);
    normalized.lastUpdatedAt = new Date().toISOString();
    await updateNotesState(normalized);
    broadcastToSidePanel({ type: 'NOTES_UPDATE', notes: normalized });
    return normalized;
  }

  async function getAiSettings() {
    const result = await chrome.storage.local.get(['aiSettings']);
    const stored = result.aiSettings || {};

    const envKeys = {
      [PROVIDERS.GEMINI]: typeof self.GEMINI_API_KEY === 'string' ? self.GEMINI_API_KEY.trim() : '',
      [PROVIDERS.OPENAI]: typeof self.OPENAI_API_KEY === 'string' ? self.OPENAI_API_KEY.trim() : '',
      [PROVIDERS.ANTHROPIC]: typeof self.ANTHROPIC_API_KEY === 'string' ? self.ANTHROPIC_API_KEY.trim() : ''
    };

    const legacyGeminiKey = typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
    const keys = {
      [PROVIDERS.GEMINI]: getStoredKey(stored, PROVIDERS.GEMINI) || legacyGeminiKey || envKeys[PROVIDERS.GEMINI],
      [PROVIDERS.OPENAI]: getStoredKey(stored, PROVIDERS.OPENAI) || envKeys[PROVIDERS.OPENAI],
      [PROVIDERS.ANTHROPIC]: getStoredKey(stored, PROVIDERS.ANTHROPIC) || envKeys[PROVIDERS.ANTHROPIC]
    };

    const models = {
      [PROVIDERS.GEMINI]: getStoredModel(stored, PROVIDERS.GEMINI) || normalizeModelName(stored.model) || DEFAULT_MODELS[PROVIDERS.GEMINI],
      [PROVIDERS.OPENAI]: getStoredModel(stored, PROVIDERS.OPENAI) || DEFAULT_MODELS[PROVIDERS.OPENAI],
      [PROVIDERS.ANTHROPIC]: getStoredModel(stored, PROVIDERS.ANTHROPIC) || DEFAULT_MODELS[PROVIDERS.ANTHROPIC]
    };

    return {
      aiNotesEnabled: Boolean(stored.aiNotesEnabled),
      provider: isValidProvider(stored.provider) ? stored.provider : DEFAULT_PROVIDER,
      keys,
      models
    };
  }

  function getStoredKey(stored, provider) {
    return stored &&
      stored.keys &&
      typeof stored.keys[provider] === 'string'
      ? stored.keys[provider].trim()
      : '';
  }

  function getStoredModel(stored, provider) {
    return stored &&
      stored.models &&
      typeof stored.models[provider] === 'string'
      ? normalizeModelName(stored.models[provider])
      : '';
  }

  async function saveAiSettings(message) {
    const result = await chrome.storage.local.get(['aiSettings']);
    const stored = result.aiSettings || {};

    const next = {
      aiNotesEnabled: Boolean(message.aiNotesEnabled),
      provider: isValidProvider(message.provider) ? message.provider : (isValidProvider(stored.provider) ? stored.provider : DEFAULT_PROVIDER),
      keys: {
        [PROVIDERS.GEMINI]: getStoredKey(stored, PROVIDERS.GEMINI) || (typeof stored.apiKey === 'string' ? stored.apiKey.trim() : ''),
        [PROVIDERS.OPENAI]: getStoredKey(stored, PROVIDERS.OPENAI),
        [PROVIDERS.ANTHROPIC]: getStoredKey(stored, PROVIDERS.ANTHROPIC)
      },
      models: {
        [PROVIDERS.GEMINI]: getStoredModel(stored, PROVIDERS.GEMINI) || normalizeModelName(stored.model) || DEFAULT_MODELS[PROVIDERS.GEMINI],
        [PROVIDERS.OPENAI]: getStoredModel(stored, PROVIDERS.OPENAI) || DEFAULT_MODELS[PROVIDERS.OPENAI],
        [PROVIDERS.ANTHROPIC]: getStoredModel(stored, PROVIDERS.ANTHROPIC) || DEFAULT_MODELS[PROVIDERS.ANTHROPIC]
      }
    };

    if (message.keys && typeof message.keys === 'object') {
      Object.values(PROVIDERS).forEach((provider) => {
        const raw = message.keys[provider];
        if (typeof raw === 'string') {
          const trimmed = raw.trim();
          if (trimmed) next.keys[provider] = trimmed;
        }
      });
    }

    await chrome.storage.local.set({ aiSettings: next });
    return getAiSettings();
  }

  async function testAiProvider(message) {
    const settings = await getAiSettings();
    const provider = isValidProvider(message.provider)
      ? message.provider
      : settings.provider;

    const keyOverrides = message && message.keys && typeof message.keys === 'object'
      ? message.keys
      : {};
    const overrideKey = typeof keyOverrides[provider] === 'string'
      ? keyOverrides[provider].trim()
      : '';
    const apiKey = overrideKey || getProviderApiKey(settings, provider);
    if (!apiKey) {
      throw new Error(`No API key available for ${provider}.`);
    }

    const resolvedModel = await resolveModelForProvider(provider, apiKey, settings.models[provider]);
    const probeText = await callModelText({
      provider,
      apiKey,
      model: resolvedModel,
      systemPrompt: 'Return exactly: OK',
      userPrompt: 'Reply with OK only.',
      temperature: 0
    });

    if (!probeText || !probeText.trim()) {
      throw new Error(`Provider responded without text for ${resolvedModel}.`);
    }

    return {
      provider,
      model: resolvedModel
    };
  }

  function buildAiSettingsView(settings) {
    return {
      aiNotesEnabled: settings.aiNotesEnabled,
      provider: settings.provider,
      activeModel: settings.models[settings.provider] || null,
      keyConfigured: {
        [PROVIDERS.GEMINI]: Boolean(settings.keys[PROVIDERS.GEMINI]),
        [PROVIDERS.OPENAI]: Boolean(settings.keys[PROVIDERS.OPENAI]),
        [PROVIDERS.ANTHROPIC]: Boolean(settings.keys[PROVIDERS.ANTHROPIC])
      }
    };
  }

  function getProviderApiKey(settings, provider) {
    if (!settings || !settings.keys) return '';
    const key = settings.keys[provider];
    return typeof key === 'string' ? key.trim() : '';
  }

  function isValidProvider(value) {
    return value === PROVIDERS.GEMINI || value === PROVIDERS.OPENAI || value === PROVIDERS.ANTHROPIC;
  }

  async function exportToMarkdown() {
    const notes = await getNotesState();
    let markdown = `# ${notes.title || 'Panopto Smart Notes'}\n\n`;
    if (notes.lastUpdatedAt) {
      markdown += `*Last updated: ${notes.lastUpdatedAt}*\n\n`;
    }

    let openMainHeading = null;
    notes.sections.forEach((section) => {
      const parsed = parseCompositeHeading(section.heading);
      if (parsed.subheading) {
        if (openMainHeading !== parsed.heading) {
          markdown += `## ${parsed.heading}\n\n`;
          openMainHeading = parsed.heading;
        }
        markdown += `### ${parsed.subheading}\n\n`;
      } else {
        markdown += `## ${parsed.heading}\n\n`;
        openMainHeading = null;
      }
      section.bullets.forEach((bullet) => {
        markdown += `- ${bullet}\n`;
      });
      markdown += '\n';
    });
    return markdown;
  }

  function parseCompositeHeading(rawHeading) {
    const heading = sanitizeHeading(rawHeading);
    if (!heading) {
      return { heading: 'Notes', subheading: '' };
    }

    const parts = heading
      .split('::')
      .map((part) => sanitizeHeading(part))
      .filter(Boolean);

    if (parts.length >= 2) {
      return {
        heading: parts[0],
        subheading: parts.slice(1).join(' - ')
      };
    }

    return { heading, subheading: '' };
  }

  async function clearSession() {
    await chrome.storage.session.remove('notesState');
    broadcastToSidePanel({ type: 'NOTES_UPDATE', notes: defaultNotesState() });
  }

  function broadcastToSidePanel(message) {
    chrome.runtime.sendMessage(message).catch(() => {
      // Side panel might not be open.
    });
  }

  async function waitForRateLimit() {
    const now = Date.now();
    const delay = Math.max(0, MIN_LLM_INTERVAL_MS - (now - lastLlmCallAt));
    if (delay > 0) await sleep(delay);
    lastLlmCallAt = Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();



