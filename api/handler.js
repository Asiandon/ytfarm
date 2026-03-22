// Vercel Serverless Function — 100% FREE Stack
// AI: Groq (free tier — llama-3.3-70b, 14,400 req/day)
// Trends: Google News RSS (no key needed)
// TTS: ElevenLabs free tier OR browser Web Speech API
// YouTube: OAuth (already connected)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = req.body;
  if (!body?.action) return res.status(400).json({ error: 'Missing action' });
  const { action } = body;

  // GROQ AI - FREE 14,400 requests/day
  if (action === 'ai') {
    const { prompt, system, max_tokens } = body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return res.status(500).json({ error: 'Missing GROQ_API_KEY' });
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: max_tokens || 1500,
        temperature: 0.7,
        messages: [
          { role: 'system', content: system || 'You are an expert faceless YouTube content creator for DailyFeedin breaking news channel. Be direct and compelling. No preamble.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message || JSON.stringify(data.error) });
    return res.status(200).json({ text: data.choices?.[0]?.message?.content || '' });
  }

  // GOOGLE NEWS RSS - 100% FREE, no key
  if (action === 'trends') {
    const { topic } = body;
    const query = topic ? encodeURIComponent(topic) : 'breaking+news+today';
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YTFarm/1.0)' } });
    if (!r.ok) return res.status(500).json({ error: 'Failed to fetch Google News' });
    const xml = await r.text();
    const items = [];
    const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const m of matches) {
      const item = m[1];
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || '')
        .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
      const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '';
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (title) items.push({ title, source, pubDate });
      if (items.length >= 10) break;
    }
    return res.status(200).json({ items });
  }

  // ELEVENLABS TTS
  if (action === 'el_verify') {
    const { api_key } = body;
    if (!api_key) return res.status(400).json({ error: 'Missing api_key' });
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': api_key } });
    if (!r.ok) return res.status(401).json({ error: 'Invalid API key' });
    const data = await r.json();
    return res.status(200).json({ valid: true, voices: data.voices?.length || 0 });
  }

  if (action === 'el_tts') {
    const { api_key, voice_id, text, voice_settings } = body;
    if (!api_key || !text) return res.status(400).json({ error: 'Missing api_key or text' });
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id || 'pNInz6obpgDQGcFmaJgB'}`, {
      method: 'POST',
      headers: { 'xi-api-key': api_key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text: text.slice(0,5000), model_id: 'eleven_monolingual_v1', voice_settings: voice_settings || { stability:0.5, similarity_boost:0.75, style:0.0, use_speaker_boost:true } })
    });
    if (!r.ok) { const err = await r.json().catch(()=>({})); return res.status(r.status).json({ error: err?.detail?.message || 'TTS failed' }); }
    const buf = await r.arrayBuffer();
    return res.status(200).json({ audio_base64: Buffer.from(buf).toString('base64'), size_kb: Math.round(buf.byteLength/1024) });
  }

  // YOUTUBE OAuth
  if (action === 'refresh') {
    const { refresh_token, client_id, client_secret } = body;
    const CID = process.env.YT_CLIENT_ID || client_id;
    const CSC = process.env.YT_CLIENT_SECRET || client_secret;
    if (!refresh_token || !CID || !CSC) return res.status(400).json({ error: 'Missing credentials' });
    const params = new URLSearchParams({ refresh_token, client_id: CID, client_secret: CSC, grant_type: 'refresh_token' });
    const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: params.toString() });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error_description || data.error });
    return res.status(200).json({ access_token: data.access_token, expires_in: data.expires_in });
  }

  if (action === 'verify') {
    const { access_token } = body;
    if (!access_token) return res.status(400).json({ error: 'Missing access_token' });
    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: 'Bearer ' + access_token } });
    const data = await r.json();
    if (!data.items?.length) return res.status(401).json({ error: 'Token invalid or no channel found' });
    const ch = data.items[0];
    return res.status(200).json({ id:ch.id, title:ch.snippet.title, thumbnail:ch.snippet.thumbnails?.default?.url, subscribers:ch.statistics.subscriberCount, views:ch.statistics.viewCount, videos:ch.statistics.videoCount });
  }

  if (action === 'upload_metadata') {
    const { access_token, title, description, tags, categoryId, publishAt, privacyStatus } = body;
    if (!access_token || !title) return res.status(400).json({ error: 'Missing access_token or title' });
    const payload = {
      snippet: { title: title.slice(0,100), description: description||'', tags: tags||[], categoryId: categoryId||'25', defaultLanguage:'en', defaultAudioLanguage:'en' },
      status: { privacyStatus: publishAt?'private':(privacyStatus||'public'), selfDeclaredMadeForKids:false, ...(publishAt&&{publishAt}) }
    };
    const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,status', { method:'POST', headers:{'Authorization':'Bearer '+access_token,'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    return res.status(200).json({ videoId: data.id, url: 'https://youtube.com/watch?v='+data.id });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
