// YT Farm — Vercel Serverless Function v4
// TTS: Browser Web Speech API (free) — no ElevenLabs subscription needed
// Viral: Piped API (real YouTube data, no key) + multiple fallbacks  
// Auto-clipper: AI identifies viral timestamps + generates captions

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body' }); }
    }
    if (!body?.action) return res.status(400).json({ error: 'Missing action' });
    const { action } = body;

    // ============ GROQ AI ============
    if (action === 'ai') {
      const { prompt, system, max_tokens } = body;
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
      const GROQ_KEY = process.env.GROQ_API_KEY;
      if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set in Vercel → Settings → Environment Variables.' });
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile', max_tokens: max_tokens || 1500, temperature: 0.7,
          messages: [
            { role: 'system', content: system || 'You are an expert faceless YouTube content creator. Be direct. No preamble.' },
            { role: 'user', content: prompt }
          ]
        })
      });
      if (!r.ok) { const t = await r.text(); return res.status(500).json({ error: 'Groq error: ' + t.slice(0, 200) }); }
      const data = await r.json();
      if (data.error) return res.status(400).json({ error: data.error.message || JSON.stringify(data.error) });
      return res.status(200).json({ text: data.choices?.[0]?.message?.content || '' });
    }

    // ============ GOOGLE NEWS RSS ============
    if (action === 'trends') {
      const { topic } = body;
      const query = topic ? encodeURIComponent(topic) : 'breaking+news+today';
      const r = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120' }
      });
      if (!r.ok) return res.status(500).json({ error: 'Google News failed: ' + r.status });
      const xml = await r.text();
      const items = [];
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const b = m[1];
        const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || b.match(/<title>(.*?)<\/title>/)?.[1] || '')
          .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'");
        const source = b.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || '';
        const pubDate = b.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        if (title) items.push({ title, source, pubDate });
        if (items.length >= 15) break;
      }
      return res.status(200).json({ items });
    }

    // ============ VIRAL VIDEO SCRAPER — Real YouTube data ============
    if (action === 'viral_scrape') {
      const { niche = 'all', region = 'US', yt_api_key } = body;
      const nicheKeywords = {
        news: 'breaking news today', tech: 'technology AI 2026', finance: 'stock market economy',
        entertainment: 'viral trending', gaming: 'gaming viral review', education: 'educational trending', all: 'trending'
      };
      let videos = [];

      // SOURCE 1: YouTube Data API v3 (user's own key — most reliable)
      if (yt_api_key) {
        try {
          const catMap = { news:'25', tech:'28', finance:'25', entertainment:'24', gaming:'20', education:'27', all:'' };
          const catId = catMap[niche] || '';
          const ytUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${region}&maxResults=12${catId?'&videoCategoryId='+catId:''}&key=${yt_api_key}`;
          const r = await fetch(ytUrl, { signal: AbortSignal.timeout(8000) });
          if (r.ok) {
            const data = await r.json();
            for (const v of (data.items||[])) {
              videos.push({
                videoId: v.id, title: v.snippet?.title||'', channelName: v.snippet?.channelTitle||'',
                viewCount: parseInt(v.statistics?.viewCount||0), likeCount: parseInt(v.statistics?.likeCount||0),
                published: v.snippet?.publishedAt||'', description: (v.snippet?.description||'').slice(0,300),
                thumbnail: v.snippet?.thumbnails?.high?.url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
                url: `https://www.youtube.com/watch?v=${v.id}`, source:'youtube-api'
              });
            }
          }
        } catch(e) { console.log('YT API:', e.message); }
      }

      // SOURCE 2: Piped API (open-source YT mirror, no key needed)
      if (videos.length < 6) {
        const pipedInstances = [
          'https://pipedapi.kavin.rocks',
          'https://piped-api.privacy.com.de',
          'https://api.piped.yt',
          'https://pipedapi.adminforge.de',
          'https://pipedapi.syncpundit.io',
        ];
        for (const inst of pipedInstances) {
          if (videos.length >= 8) break;
          try {
            const r = await fetch(`${inst}/trending?region=${region}`, {
              headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000)
            });
            if (!r.ok) continue;
            const data = await r.json();
            if (!Array.isArray(data)||!data.length) continue;
            const keyword = niche!=='all' ? nicheKeywords[niche]?.split(' ')[0]?.toLowerCase() : null;
            const pool = keyword ? (data.filter(v=>(v.title||'').toLowerCase().includes(keyword)||
              (v.uploaderName||'').toLowerCase().includes(keyword)).length>3
              ? data.filter(v=>(v.title||'').toLowerCase().includes(keyword)) : data) : data;
            for (const v of pool.slice(0,12)) {
              const rawUrl = v.url||'';
              const vid = rawUrl.includes('watch?v=') ? rawUrl.split('watch?v=')[1]?.split('&')[0] : (v.videoId||rawUrl);
              if (!vid||!v.title) continue;
              videos.push({
                videoId: vid, title: v.title||'', channelName: v.uploaderName||v.uploader||'',
                viewCount: v.views||0, published: v.uploaded?new Date(v.uploaded).toISOString():new Date().toISOString(),
                description: (v.shortDescription||'').slice(0,300),
                thumbnail: v.thumbnail||`https://i.ytimg.com/vi/${vid}/mqdefault.jpg`,
                url: `https://www.youtube.com/watch?v=${vid}`, duration: v.duration||0, source:'piped'
              });
            }
            if (videos.length>=6) break;
          } catch(e) { console.log(`Piped ${inst}:`, e.message); }
        }
      }

      // SOURCE 3: Invidious API
      if (videos.length < 4) {
        const invInsts = ['https://inv.nadeko.net','https://invidious.privacydev.net','https://yt.artemislena.eu','https://invidious.nerdvpn.de'];
        for (const inst of invInsts) {
          if (videos.length>=6) break;
          try {
            const r = await fetch(`${inst}/api/v1/trending?region=${region}`, {
              headers:{Accept:'application/json'}, signal: AbortSignal.timeout(5000)
            });
            if (!r.ok) continue;
            const data = await r.json();
            if (!Array.isArray(data)||!data.length) continue;
            for (const v of data.slice(0,10)) {
              if (!v.videoId||!v.title) continue;
              videos.push({
                videoId:v.videoId, title:v.title, channelName:v.author||'',
                viewCount:v.viewCount||0, published:v.published?new Date(v.published*1000).toISOString():new Date().toISOString(),
                description:(v.description||'').slice(0,300),
                thumbnail:`https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
                url:`https://www.youtube.com/watch?v=${v.videoId}`, duration:v.lengthSeconds||0, source:'invidious'
              });
            }
            if (videos.length>=6) break;
          } catch {}
        }
      }

      // SOURCE 4: Google News → YouTube oembed
      if (videos.length < 4) {
        try {
          const keyword = nicheKeywords[niche]||'trending news';
          const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword+' youtube')}&hl=en-US&gl=US&ceid=US:en`;
          const rssRes = await fetch(rssUrl, {headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(7000)});
          if (rssRes.ok) {
            const xml = await rssRes.text();
            const seenIds = new Set(videos.map(v=>v.videoId));
            const ytIds = [...new Set([...xml.matchAll(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/g)].map(m=>m[1]))]
              .filter(id=>!seenIds.has(id)).slice(0,6);
            await Promise.all(ytIds.map(async videoId => {
              try {
                const oe = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,{signal:AbortSignal.timeout(3000)});
                if (!oe.ok) return;
                const od = await oe.json();
                videos.push({videoId,title:od.title||'',channelName:od.author_name||'',viewCount:0,
                  published:new Date().toISOString(),description:'',
                  thumbnail:`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
                  url:`https://www.youtube.com/watch?v=${videoId}`,source:'news-rss'});
              } catch {}
            }));
          }
        } catch {}
      }

      // SOURCE 5: AI fallback (last resort)
      if (videos.length === 0) {
        const GROQ_KEY = process.env.GROQ_API_KEY;
        if (GROQ_KEY) {
          try {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+GROQ_KEY},
              body: JSON.stringify({
                model:'llama-3.3-70b-versatile', max_tokens:900, temperature:0.85,
                messages:[{role:'user',content:`Generate 8 trending YouTube titles for niche "${niche}" April 2026. Current events, no old products. Return ONLY JSON array:\n[{"title":"...","channelName":"...","viewCount":2000000,"description":"one sentence"}]\nNo markdown.`}]
              })
            });
            if (r.ok) {
              const d = await r.json();
              const raw = (d.choices?.[0]?.message?.content||'[]').replace(/```json|```/g,'').trim();
              const match = raw.match(/\[[\s\S]*\]/);
              const gen = match ? JSON.parse(match[0]) : [];
              const thumbIds = ['jNQXAC9IVRw','M7FIvfx5J10','WPni755-Krg','QH2-TGUlwu4','kffacxfA7G4','9bZkp7q19f0','hT_nvWreIhg','kJQP7kiw5Fk'];
              gen.forEach((v,i)=>{
                videos.push({videoId:'ai_'+i,title:v.title||'Trending',channelName:v.channelName||'NewsChannel',
                  viewCount:v.viewCount||Math.floor(Math.random()*3e6+500000),
                  published:new Date().toISOString(),description:v.description||'',
                  thumbnail:`https://i.ytimg.com/vi/${thumbIds[i%thumbIds.length]}/mqdefault.jpg`,
                  url:`https://www.youtube.com/results?search_query=${encodeURIComponent(v.title||'')}`,
                  source:'ai-generated',isAiGenerated:true});
              });
            }
          } catch {}
        }
      }

      videos.sort((a,b)=>b.viewCount-a.viewCount);
      return res.status(200).json({videos:videos.slice(0,12),total:videos.length,source:videos[0]?.source||'none'});
    }

    // ============ AI VIRAL CLIP ANALYSIS ============
    if (action === 'analyze_viral') {
      const { videoTitle, videoDescription, channelName, duration } = body;
      if (!videoTitle) return res.status(400).json({ error: 'Missing videoTitle' });
      const GROQ_KEY = process.env.GROQ_API_KEY;
      if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY not set' });
      const durStr = duration ? `Duration: ${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')}` : '';
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+GROQ_KEY},
        body: JSON.stringify({
          model:'llama-3.3-70b-versatile', max_tokens:1000, temperature:0.6,
          messages:[
            {role:'system',content:'You are a viral YouTube clip analyst and content strategist for faceless news channels.'},
            {role:'user',content:`Analyze this video for viral clips:
Title: "${videoTitle}"
Channel: ${channelName||'Unknown'}
${durStr}
Description: ${(videoDescription||'').slice(0,400)}

Give:
1. 🔴 VIRAL HOOK (0:00–0:30): Most shareable opening
2. ✂️ CLIP #1: Timestamp range + why viral (e.g. "1:20–2:45 — shocking reveal")
3. ✂️ CLIP #2: Second best timestamp
4. ✂️ CLIP #3: Third timestamp
5. 📱 SHORTS STRATEGY: Best 15s/30s/60s clip + reason for vertical format
6. 📝 REPOST ANGLE: How to cover this on DailyFeedin with fair-use commentary
7. 🚀 YOUR HOOK: First 2 sentences for your version
8. ⭐ VIRAL SCORE: X/10 with one-line reason`}
          ]
        })
      });
      if (!r.ok) return res.status(500).json({error:'Groq error '+r.status});
      const data = await r.json();
      return res.status(200).json({analysis:data.choices?.[0]?.message?.content||''});
    }

    // ============ CAPTION GENERATOR (SRT + VTT) ============
    if (action === 'generate_captions') {
      const { script, words_per_second = 2.5, format = 'both' } = body;
      if (!script) return res.status(400).json({ error: 'Missing script' });
      const clean = script
        .replace(/\[B-ROLL:[^\]]+\]/gi,'').replace(/[🔴📌📣🎬🎯⏱️═]+/g,'')
        .replace(/\n{3,}/g,'\n\n').trim();
      const sentences = clean.match(/[^.!?]+[.!?]+/g)||clean.split('\n').filter(Boolean);

      let srt='', vtt='WEBVTT\n\n';
      let t=0, idx=1;
      const fmt = s=>{
        const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60),ms=Math.round((s%1)*1000);
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
      };
      for (const sentence of sentences) {
        const words = sentence.trim().split(/\s+/).filter(Boolean);
        if (!words.length) continue;
        for (let i=0;i<words.length;i+=8) {
          const chunk = words.slice(i,i+8).join(' ');
          const dur = Math.max(1.5, chunk.split(' ').length/words_per_second);
          const s=t, e=t+dur;
          srt += `${idx}\n${fmt(s)} --> ${fmt(e)}\n${chunk}\n\n`;
          vtt += `${fmt(s).replace(',','.')} --> ${fmt(e).replace(',','.')}\n${chunk}\n\n`;
          t=e+0.1; idx++;
        }
      }
      return res.status(200).json({srt,vtt,count:idx-1,totalSeconds:Math.round(t)});
    }

    // ============ PEXELS ============
    if (action === 'pexels_search') {
      const { query, per_page=6 } = body;
      if (!query) return res.status(400).json({error:'Missing query'});
      const KEY = process.env.PEXELS_API_KEY;
      if (!KEY) return res.status(500).json({error:'PEXELS_API_KEY not set in Vercel env vars'});
      const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${per_page}&orientation=landscape`,{headers:{Authorization:KEY}});
      if (!r.ok) return res.status(r.status).json({error:'Pexels error '+r.status});
      const data = await r.json();
      return res.status(200).json({videos:(data.videos||[]).map(v=>({id:v.id,url:v.url,duration:v.duration,thumbnail:v.image,downloadUrl:v.video_files?.find(f=>f.quality==='hd')?.link||v.video_files?.[0]?.link||''})),total:data.total_results});
    }
    if (action === 'pexels_verify') {
      const {api_key} = body;
      const r = await fetch('https://api.pexels.com/videos/search?query=news&per_page=1',{headers:{Authorization:api_key}});
      if (!r.ok) return res.status(401).json({valid:false,error:'Invalid Pexels API key'});
      return res.status(200).json({valid:true});
    }

    // ============ ELEVENLABS (optional paid upgrade) ============
    if (action === 'el_verify') {
      const {api_key} = body;
      const r = await fetch('https://api.elevenlabs.io/v1/user',{headers:{'xi-api-key':api_key}});
      if (!r.ok) return res.status(401).json({valid:false,error:'Invalid key'});
      const data = await r.json();
      const tier = data.subscription?.tier||'free';
      return res.status(200).json({valid:true,tier,charLimit:data.subscription?.character_limit||10000,isPaid:tier!=='free'});
    }
    if (action === 'el_tts') {
      const {api_key,voice_id,text,voice_settings,model_id} = body;
      if (!api_key||!text) return res.status(400).json({error:'Missing api_key or text'});
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice_id||'pNInz6obpgDQGcFmaJgB'}`,{
        method:'POST', headers:{'xi-api-key':api_key,'Content-Type':'application/json',Accept:'audio/mpeg'},
        body:JSON.stringify({text:text.slice(0,5000),model_id:model_id||'eleven_turbo_v2_5',voice_settings:voice_settings||{stability:0.5,similarity_boost:0.75,style:0.0,use_speaker_boost:true}})
      });
      if (!r.ok) {const e=await r.json().catch(()=>({}));return res.status(r.status).json({error:e?.detail?.message||'TTS failed. Note: free tier only works with your own cloned voices.'});}
      const buf = await r.arrayBuffer();
      return res.status(200).json({audio_base64:Buffer.from(buf).toString('base64'),size_kb:Math.round(buf.byteLength/1024)});
    }

    // ============ YOUTUBE OAUTH ============
    if (action === 'refresh') {
      const {refresh_token,client_id,client_secret} = body;
      const CID = process.env.YT_CLIENT_ID||client_id;
      const CSC = process.env.YT_CLIENT_SECRET||client_secret;
      if (!refresh_token||!CID||!CSC) return res.status(400).json({error:'Missing credentials'});
      const params = new URLSearchParams({refresh_token,client_id:CID,client_secret:CSC,grant_type:'refresh_token'});
      const r = await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params.toString()});
      const data = await r.json();
      if (data.error) return res.status(400).json({error:data.error_description||data.error});
      return res.status(200).json({access_token:data.access_token,expires_in:data.expires_in});
    }
    if (action === 'verify') {
      const {access_token} = body;
      const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',{headers:{Authorization:'Bearer '+access_token}});
      const data = await r.json();
      if (!data.items?.length) return res.status(401).json({error:'Token invalid or no channel found'});
      const ch = data.items[0];
      return res.status(200).json({id:ch.id,title:ch.snippet.title,thumbnail:ch.snippet.thumbnails?.default?.url,subscribers:ch.statistics.subscriberCount,views:ch.statistics.viewCount,videos:ch.statistics.videoCount});
    }

    return res.status(400).json({error:'Unknown action: '+action});
  } catch(err) {
    console.error('Handler error:',err);
    return res.status(500).json({error:err.message||'Internal server error'});
  }
}
