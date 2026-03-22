// Vercel Serverless Function — All API Proxy
// Handles: Claude AI, ElevenLabs TTS, YouTube OAuth
// Path: /api/handler.js → accessible at /api/handler

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const body = req.body;
  if (!body || !body.action) return res.status(400).json({ error: 'Missing action' });

  const { action } = body;

  // ── CLAUDE AI PROXY ─────────────────────────────────────────────────
  if (action === 'claude') {
    const { prompt, system, max_tokens } = body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
    if (!CLAUDE_KEY) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY in Vercel environment variables' });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1000,
        system: system || 'You are an expert faceless YouTube content creator. Respond directly without preamble.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    return res.status(200).json({ text: data.content.map(b => b.text || '').join('') });
  }

  // ── ELEVENLABS: verify API key ──────────────────────────────────────
  if (action === 'el_verify') {
    const { api_key } = body;
    if (!api_key) return res.status(400).json({ error: 'Missing api_key' });

    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': api_key }
    });

    if (!r.ok) return res.status(401).json({ error: 'Invalid API key' });
    const data = await r.json();
    return res.status(200).json({ valid: true, voices: data.voices?.length || 0 });
  }

  // ── ELEVENLABS: generate TTS audio ──────────────────────────────────
  if (action === 'el_tts') {
    const { api_key, voice_id, text, voice_settings } = body;
    if (!api_key || !text) return res.status(400).json({ error: 'Missing api_key or text' });

    const vid = voice_id || 'pNInz6obpgDQGcFmaJgB';
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
      method: 'POST',
      headers: {
        'xi-api-key': api_key,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text.slice(0, 5000),
        model_id: 'eleven_monolingual_v1',
        voice_settings: voice_settings || {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err?.detail?.message || 'TTS failed' });
    }

    const audioBuffer = await r.arrayBuffer();
    const base64 = Buffer.from(audioBuffer).toString('base64');
    return res.status(200).json({ audio_base64: base64, size_kb: Math.round(audioBuffer.byteLength / 1024) });
  }

  // ── YOUTUBE: refresh token ──────────────────────────────────────────
  if (action === 'refresh') {
    const { refresh_token, client_id, client_secret } = body;
    const CLIENT_ID     = process.env.YT_CLIENT_ID     || client_id;
    const CLIENT_SECRET = process.env.YT_CLIENT_SECRET || client_secret;
    if (!refresh_token || !CLIENT_ID || !CLIENT_SECRET) {
      return res.status(400).json({ error: 'Missing refresh_token, client_id, or client_secret' });
    }

    const params = new URLSearchParams({ refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error_description || data.error });
    return res.status(200).json({ access_token: data.access_token, expires_in: data.expires_in });
  }

  // ── YOUTUBE: verify channel ─────────────────────────────────────────
  if (action === 'verify') {
    const { access_token } = body;
    if (!access_token) return res.status(400).json({ error: 'Missing access_token' });

    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: { Authorization: 'Bearer ' + access_token }
    });

    const data = await r.json();
    if (!data.items || data.items.length === 0) return res.status(401).json({ error: 'Token invalid or no channel found' });

    const ch = data.items[0];
    return res.status(200).json({
      id: ch.id,
      title: ch.snippet.title,
      thumbnail: ch.snippet.thumbnails?.default?.url,
      subscribers: ch.statistics.subscriberCount,
      views: ch.statistics.viewCount,
      videos: ch.statistics.videoCount
    });
  }

  // ── YOUTUBE: upload metadata ────────────────────────────────────────
  if (action === 'upload_metadata') {
    const { access_token, title, description, tags, categoryId, publishAt, privacyStatus } = body;
    if (!access_token || !title) return res.status(400).json({ error: 'Missing access_token or title' });

    const payload = {
      snippet: { title: title.slice(0,100), description: description||'', tags: tags||[], categoryId: categoryId||'25', defaultLanguage:'en', defaultAudioLanguage:'en' },
      status: { privacyStatus: publishAt ? 'private' : (privacyStatus||'public'), selfDeclaredMadeForKids: false, ...(publishAt && { publishAt }) }
    };

    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,status', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    return res.status(200).json({ videoId: data.id, url: 'https://youtube.com/watch?v=' + data.id });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
