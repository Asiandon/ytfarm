// YT Farm — Vercel Serverless Function
// Fixed: proper error handling, JSON always returned, viral scraper added

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // FIX: Always wrap everything in try/catch so we ALWAYS return JSON
  try {
    // FIX: Vercel sometimes sends body as string — parse it
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
    }
    if (!body?.action) return res.status(400).json({ error: 'Missing action' });
    const { action } = body;

    // ============ GROQ AI (FREE — 14,400 req/day) ============
    if (action === 'ai') {
      const { prompt, system, max_tokens } = body;
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

      const GROQ_KEY = process.env.GROQ_API_KEY;
      if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set in Vercel env vars. Go to Vercel → Project → Settings → Environment Variables and add it.' });

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
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

      // FIX: check r.ok before parsing
      if (!r.ok) {
        const errText = await r.text();
        return res.status(500).json({ error: 'Groq API error: ' + errText.slice(0, 200) });
      }
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message || JSON.stringify(data.error) });
      return res.status(200).json({ text: data.choices?.[0]?.message?.content || '' });
    }

    // ============ GOOGLE NEWS RSS (FREE, no key) ============
    if (action === 'trends') {
      const { topic } = body;
      const query = topic ? encodeURIComponent(topic) : 'breaking+news+today';
      const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        }
      });
      if (!r.ok) return res.status(500).json({ error: 'Failed to fetch Google News: ' + r.status });

      const xml = await r.text();
      const items = [];
      const matches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
      for (const m of matches) {
        const item = m[1];
        const title = (
          item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] ||
          item.match(/<title>(.*?)<\/title>/)?.[1] || ''
        ).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
        const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '';
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
        if (title) items.push({ title, source, pubDate, link });
        if (items.length >= 15) break;
      }
      return res.status(200).json({ items });
    }

    // ============ VIRAL VIDEO SCRAPER ============
    // Source 1: Invidious public API (YouTube trending mirror, no key)
    // Source 2: Google News RSS → oembed title lookup
    // Source 3: AI-generated trending topics (always works if GROQ_KEY set)
    if (action === 'viral_scrape') {
      const { niche = 'all', region = 'US' } = body;

      const nicheKeywords = {
        news: 'breaking news', tech: 'technology AI',
        finance: 'stock market finance', entertainment: 'viral trending',
        gaming: 'gaming', education: 'educational', all: 'trending news'
      };
      const keyword = nicheKeywords[niche.toLowerCase()] || 'trending';

      let videos = [];

      // --- SOURCE 1: Invidious public instances (free YouTube trending mirror) ---
      const invidiousInstances = [
        'https://inv.nadeko.net',
        'https://invidious.privacydev.net',
        'https://yt.artemislena.eu',
        'https://invidious.nerdvpn.de',
        'https://invidious.lunar.icu',
      ];
      const invTypeMap = {
        news: 'News%20%26%20Politics', tech: 'Science%20%26%20Technology',
        finance: 'News%20%26%20Politics', entertainment: 'Entertainment',
        gaming: 'Gaming', education: 'Education', all: ''
      };
      const invType = invTypeMap[niche.toLowerCase()] || '';

      for (const instance of invidiousInstances) {
        if (videos.length >= 8) break;
        try {
          const url = `${instance}/api/v1/trending?region=${region}${invType ? '&type=' + invType : ''}`;
          const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            signal: AbortSignal.timeout(5000)
          });
          if (!r.ok) continue;
          const data = await r.json();
          if (!Array.isArray(data) || data.length === 0) continue;
          for (const v of data.slice(0, 12)) {
            if (!v.videoId || !v.title) continue;
            videos.push({
              videoId: v.videoId,
              title: v.title,
              channelName: v.author || '',
              viewCount: v.viewCount || 0,
              published: v.published ? new Date(v.published * 1000).toISOString() : new Date().toISOString(),
              description: (v.description || '').slice(0, 300),
              thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
              url: `https://www.youtube.com/watch?v=${v.videoId}`,
              source: 'invidious'
            });
          }
          if (videos.length > 0) break;
        } catch (e) { /* try next instance */ }
      }

      // --- SOURCE 2: Google News RSS → find YouTube video IDs via oembed ---
      if (videos.length < 6) {
        try {
          const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword + ' youtube')}&hl=en-US&gl=US&ceid=US:en`;
          const rssRes = await fetch(rssUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(7000)
          });
          if (rssRes.ok) {
            const xml = await rssRes.text();
            const ytMatches = [...xml.matchAll(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/g)];
            const seenIds = new Set(videos.map(v => v.videoId));
            const toFetch = [...new Set(ytMatches.map(m => m[1]))].filter(id => !seenIds.has(id)).slice(0, 6);
            await Promise.all(toFetch.map(async (videoId) => {
              try {
                const oe = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { signal: AbortSignal.timeout(3000) });
                if (!oe.ok) return;
                const od = await oe.json();
                videos.push({
                  videoId, title: od.title || 'Trending Video', channelName: od.author_name || '',
                  viewCount: 0, published: new Date().toISOString(), description: '',
                  thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                  url: `https://www.youtube.com/watch?v=${videoId}`, source: 'news-rss'
                });
              } catch {}
            }));
          }
        } catch (e) { /* continue */ }
      }

      // --- SOURCE 3: AI-generated trending (guaranteed fallback) ---
      if (videos.length === 0) {
        const GROQ_KEY = process.env.GROQ_API_KEY;
        if (GROQ_KEY) {
          try {
            const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
              body: JSON.stringify({
                model: 'llama-3.3-70b-versatile', max_tokens: 900, temperature: 0.85,
                messages: [{ role: 'user', content: `Generate 8 realistic trending YouTube video titles for niche: "${niche}" as of April 2026. Use CURRENT events, recent AI models, recent news stories, 2026 product releases. Do NOT use old products like Samsung S23 or iPhone 15. Make channels sound like real popular YouTube channels. Return ONLY a JSON array with no markdown:\n[{"title":"...","channelName":"...","viewCount":2100000,"description":"What the video is about in one sentence"}]\nNo extra text. Just the JSON array.` }]
              })
            });
            if (aiRes.ok) {
              const aiData = await aiRes.json();
              const raw = (aiData.choices?.[0]?.message?.content || '[]').replace(/```json|```/g,'').trim();
              // Find the JSON array even if there's surrounding text
              const match = raw.match(/\[[\s\S]*\]/);
              const generated = match ? JSON.parse(match[0]) : [];

              // Real YouTube video IDs to use as varied thumbnails (popular videos, not rickroll)
              const thumbIds = [
                'jNQXAC9IVRw','9bZkp7q19f0','kJQP7kiw5Fk','OPf0YbXqDm0','60ItHLz5WEA',
                'RgKAFK5djSk','hT_nvWreIhg','YQHsXMglC9A','fJ9rUzIMcZQ','7PCkvCPvDXk',
                'CevxZvSJLk8','dQw4w9WgXcQ'
              ];
              generated.forEach((v, i) => {
                const thumbId = thumbIds[i % thumbIds.length];
                videos.push({
                  videoId: 'ai_' + i + '_' + Date.now().toString(36),
                  title: v.title || 'Trending Video',
                  channelName: v.channelName || 'News Channel',
                  viewCount: v.viewCount || Math.floor(Math.random()*3e6+500000),
                  published: new Date().toISOString(),
                  description: v.description || '',
                  thumbnail: `https://i.ytimg.com/vi/${thumbId}/mqdefault.jpg`,
                  url: `https://www.youtube.com/results?search_query=${encodeURIComponent(v.title||'')}`,
                  source: 'ai-generated',
                  isAiGenerated: true
                });
              });
            }
          } catch (e) { console.log('AI fallback error:', e.message); }
        }
      }

      videos.sort((a, b) => b.viewCount - a.viewCount);
      return res.status(200).json({ videos: videos.slice(0, 12), total: videos.length, source: videos[0]?.source || 'none' });
    }


    // ============ VIRAL CLIP ANALYSIS — AI identifies viral moments ============
    if (action === 'analyze_viral') {
      const { videoTitle, videoDescription, channelName } = body;
      if (!videoTitle) return res.status(400).json({ error: 'Missing videoTitle' });

      const GROQ_KEY = process.env.GROQ_API_KEY;
      if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });

      const prompt = `You are a viral YouTube clip analyst.

Video: "${videoTitle}"
Channel: ${channelName || 'Unknown'}
Description: ${(videoDescription || '').slice(0, 500)}

Based on this trending video, provide:

1. VIRAL HOOK (0:00–0:30): What the most shareable opening moment likely is
2. PEAK MOMENT: The likely most viral timestamp/segment (describe it)  
3. CLIP STRATEGY: 3 specific clip timestamps to extract (e.g., "0:45–1:20 — The shocking reveal")
4. REPOST ANGLE: How to legally repost this as a reaction/commentary/news video on DailyFeedin
5. SCRIPT HOOK: First 2 sentences to open YOUR version of this story
6. VIRAL SCORE: Rate virality 1-10 with one-line reason

Be specific and actionable. Format clearly with the numbered sections.`;

      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 800,
          temperature: 0.6,
          messages: [
            { role: 'system', content: 'You are a viral content strategist for faceless YouTube news channels.' },
            { role: 'user', content: prompt }
          ]
        })
      });
      if (!r.ok) return res.status(500).json({ error: 'Groq error: ' + r.status });
      const data = await r.json();
      return res.status(200).json({ analysis: data.choices?.[0]?.message?.content || '' });
    }

    // ============ PEXELS STOCK VIDEO SEARCH ============
    if (action === 'pexels_search') {
      const { query, per_page = 6 } = body;
      if (!query) return res.status(400).json({ error: 'Missing query' });
      const PEXELS_KEY = process.env.PEXELS_API_KEY;
      if (!PEXELS_KEY) return res.status(500).json({ error: 'PEXELS_API_KEY not set in Vercel env vars. Go to pexels.com/api → Get API Key (free), then add to Vercel → Settings → Environment Variables.' });
      const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${per_page}&orientation=landscape`, {
        headers: { Authorization: PEXELS_KEY }
      });
      if (!r.ok) return res.status(r.status).json({ error: 'Pexels API error: ' + r.status });
      const data = await r.json();
      const videos = (data.videos || []).map(v => ({
        id: v.id,
        url: v.url,
        duration: v.duration,
        thumbnail: v.image,
        downloadUrl: v.video_files?.find(f => f.quality === 'hd' || f.quality === 'sd')?.link || v.video_files?.[0]?.link || '',
        width: v.width,
        height: v.height
      }));
      return res.status(200).json({ videos, total: data.total_results });
    }

    // ============ PEXELS VERIFY ============
    if (action === 'pexels_verify') {
      const { api_key } = body;
      if (!api_key) return res.status(400).json({ error: 'Missing api_key' });
      const r = await fetch('https://api.pexels.com/videos/search?query=news&per_page=1', {
        headers: { Authorization: api_key }
      });
      if (!r.ok) return res.status(401).json({ valid: false, error: 'Invalid Pexels API key' });
      return res.status(200).json({ valid: true });
    }

    // ============ ELEVENLABS VERIFY ============
    if (action === 'el_verify') {
      const { api_key } = body;
      if (!api_key) return res.status(400).json({ error: 'Missing api_key' });
      const r = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': api_key }
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return res.status(401).json({ valid: false, error: err?.detail?.message || 'Invalid API key — check it at elevenlabs.io' });
      }
      const data = await r.json();
      return res.status(200).json({ valid: true, voices: data.voices?.length || 0 });
    }

    // ============ ELEVENLABS TTS ============
    if (action === 'el_tts') {
      const { api_key, voice_id, text, voice_settings } = body;
      if (!api_key || !text) return res.status(400).json({ error: 'Missing api_key or text' });

      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id || 'pNInz6obpgDQGcFmaJgB'}`, {
        method: 'POST',
        headers: {
          'xi-api-key': api_key,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        body: JSON.stringify({
          text: text.slice(0, 5000),
          model_id: 'eleven_turbo_v2_5',
          voice_settings: voice_settings || { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
        })
      });

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: err?.detail?.message || 'TTS failed — check your API key or character limit' });
      }

      const buf = await r.arrayBuffer();
      return res.status(200).json({
        audio_base64: Buffer.from(buf).toString('base64'),
        size_kb: Math.round(buf.byteLength / 1024)
      });
    }

    // ============ YOUTUBE OAUTH REFRESH ============
    if (action === 'refresh') {
      const { refresh_token, client_id, client_secret } = body;
      const CID = process.env.YT_CLIENT_ID || client_id;
      const CSC = process.env.YT_CLIENT_SECRET || client_secret;
      if (!refresh_token || !CID || !CSC) return res.status(400).json({ error: 'Missing credentials' });

      const params = new URLSearchParams({
        refresh_token, client_id: CID, client_secret: CSC, grant_type: 'refresh_token'
      });
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error_description || data.error });
      return res.status(200).json({ access_token: data.access_token, expires_in: data.expires_in });
    }

    // ============ YOUTUBE VERIFY TOKEN ============
    if (action === 'verify') {
      const { access_token } = body;
      if (!access_token) return res.status(400).json({ error: 'Missing access_token' });
      const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
        headers: { Authorization: 'Bearer ' + access_token }
      });
      const data = await r.json();
      if (!data.items?.length) return res.status(401).json({ error: 'Token invalid or no channel found' });
      const ch = data.items[0];
      return res.status(200).json({
        id: ch.id, title: ch.snippet.title,
        thumbnail: ch.snippet.thumbnails?.default?.url,
        subscribers: ch.statistics.subscriberCount,
        views: ch.statistics.viewCount,
        videos: ch.statistics.videoCount
      });
    }

    // ============ YOUTUBE UPLOAD METADATA ============
    if (action === 'upload_metadata') {
      const { access_token, title, description, tags, categoryId, publishAt, privacyStatus } = body;
      if (!access_token || !title) return res.status(400).json({ error: 'Missing access_token or title' });

      const payload = {
        snippet: {
          title: title.slice(0, 100), description: description || '',
          tags: tags || [], categoryId: categoryId || '25',
          defaultLanguage: 'en', defaultAudioLanguage: 'en'
        },
        status: {
          privacyStatus: publishAt ? 'private' : (privacyStatus || 'public'),
          selfDeclaredMadeForKids: false,
          ...(publishAt && { publishAt })
        }
      };

      const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,status', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message });
      return res.status(200).json({ videoId: data.id, url: 'https://youtube.com/watch?v=' + data.id });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    // FIX: Global catch — always returns JSON, never empty response
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
