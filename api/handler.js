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
    // Scrapes YouTube trending via RSS + noembed metadata
    if (action === 'viral_scrape') {
      const { niche = 'news', region = 'US' } = body;

      // YouTube trending RSS by category
      const categoryMap = {
        news: '25', tech: '28', finance: '25', entertainment: '24',
        gaming: '20', education: '27', all: '0'
      };
      const catId = categoryMap[niche.toLowerCase()] || '0';

      // Use YouTube trending RSS (free, no key)
      const trendingUrl = `https://www.youtube.com/feeds/videos.xml?chart=mostpopular&regionCode=${region}&videoCategoryId=${catId}&max-results=20`;

      let videos = [];
      try {
        const rssRes = await fetch(trendingUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YTFarm/1.0)' }
        });
        if (rssRes.ok) {
          const xml = await rssRes.text();
          const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
          for (const entry of entries.slice(0, 12)) {
            const block = entry[1];
            const videoId = block.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] || '';
            const title = block.match(/<title>(.*?)<\/title>/)?.[1]
              ?.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'") || '';
            const published = block.match(/<published>(.*?)<\/published>/)?.[1] || '';
            const viewCount = block.match(/<media:statistics views="(\d+)"/)?.[1] || '0';
            const channelName = block.match(/<name>(.*?)<\/name>/)?.[1] || '';
            const description = block.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]
              ?.trim().slice(0, 300) || '';
            if (videoId && title) {
              videos.push({
                videoId,
                title,
                channelName,
                viewCount: parseInt(viewCount),
                published,
                description,
                thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                watchUrl: `https://www.youtube.com/watch?v=${videoId}`
              });
            }
          }
        }
      } catch(rssErr) {
        console.error('RSS scrape error:', rssErr);
      }

      // Fallback: use YouTube search RSS for niche keyword
      if (videos.length === 0) {
        try {
          const searchRss = `https://www.youtube.com/feeds/videos.xml?search_query=${encodeURIComponent(niche + ' news today')}&max-results=10`;
          const sRes = await fetch(searchRss, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (sRes.ok) {
            const xml = await sRes.text();
            const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
            for (const entry of entries.slice(0, 10)) {
              const block = entry[1];
              const videoId = block.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1] || '';
              const title = block.match(/<title>(.*?)<\/title>/)?.[1]
                ?.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') || '';
              const channelName = block.match(/<name>(.*?)<\/name>/)?.[1] || '';
              const published = block.match(/<published>(.*?)<\/published>/)?.[1] || '';
              if (videoId && title) {
                videos.push({ videoId, title, channelName, viewCount: 0, published,
                  description: '', thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                  url: `https://www.youtube.com/watch?v=${videoId}` });
              }
            }
          }
        } catch(fallbackErr) {
          console.error('Fallback RSS error:', fallbackErr);
        }
      }

      // Sort by view count descending
      videos.sort((a, b) => b.viewCount - a.viewCount);

      return res.status(200).json({ videos: videos.slice(0, 12), total: videos.length });
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
          model_id: 'eleven_monolingual_v1',
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
