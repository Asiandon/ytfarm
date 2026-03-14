// Netlify Serverless Function — YouTube OAuth Handler
// Handles: token exchange, auto-refresh, channel verification
// Runs server-side so credentials are never exposed to the browser

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const CLIENT_ID     = process.env.YT_CLIENT_ID     || body.client_id;
  const CLIENT_SECRET = process.env.YT_CLIENT_SECRET || body.client_secret;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing credentials. Set YT_CLIENT_ID and YT_CLIENT_SECRET in Netlify environment variables.' }) };
  }

  const { action } = body;

  // ── EXCHANGE code → tokens ──────────────────────────────────────────
  if (action === 'exchange') {
    const { code, redirect_uri } = body;
    if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing code' }) };

    const params = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirect_uri || 'https://localhost',
      grant_type: 'authorization_code'
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await res.json();
    if (data.error) return { statusCode: 400, headers, body: JSON.stringify({ error: data.error_description || data.error }) };

    return { statusCode: 200, headers, body: JSON.stringify({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_in:    data.expires_in
    })};
  }

  // ── REFRESH access_token using refresh_token ────────────────────────
  if (action === 'refresh') {
    const { refresh_token } = body;
    if (!refresh_token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing refresh_token' }) };

    const params = new URLSearchParams({
      refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token'
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await res.json();
    if (data.error) return { statusCode: 400, headers, body: JSON.stringify({ error: data.error_description || data.error }) };

    return { statusCode: 200, headers, body: JSON.stringify({
      access_token: data.access_token,
      expires_in:   data.expires_in
    })};
  }

  // ── VERIFY token + fetch channel info ──────────────────────────────
  if (action === 'verify') {
    const { access_token } = body;
    if (!access_token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing access_token' }) };

    const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', {
      headers: { Authorization: 'Bearer ' + access_token }
    });

    const data = await res.json();
    if (!data.items || data.items.length === 0) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token invalid or no channel found' }) };
    }

    const ch = data.items[0];
    return { statusCode: 200, headers, body: JSON.stringify({
      id:          ch.id,
      title:       ch.snippet.title,
      thumbnail:   ch.snippet.thumbnails?.default?.url,
      subscribers: ch.statistics.subscriberCount,
      views:       ch.statistics.viewCount,
      videos:      ch.statistics.videoCount
    })};
  }

  // ── UPLOAD video metadata to YouTube ───────────────────────────────
  if (action === 'upload_metadata') {
    const { access_token, title, description, tags, categoryId, publishAt, privacyStatus } = body;
    if (!access_token || !title) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing access_token or title' }) };

    const payload = {
      snippet: {
        title: title.slice(0, 100),
        description: description || '',
        tags: tags || [],
        categoryId: categoryId || '25',
        defaultLanguage: 'en',
        defaultAudioLanguage: 'en'
      },
      status: {
        privacyStatus: publishAt ? 'private' : (privacyStatus || 'public'),
        selfDeclaredMadeForKids: false,
        ...(publishAt && { publishAt })
      }
    };

    const res = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet,status', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.error) return { statusCode: 400, headers, body: JSON.stringify({ error: data.error.message }) };

    return { statusCode: 200, headers, body: JSON.stringify({
      videoId: data.id,
      title: data.snippet?.title,
      status: data.status?.privacyStatus,
      publishAt: data.status?.publishAt,
      url: 'https://youtube.com/watch?v=' + data.id
    })};
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
};
