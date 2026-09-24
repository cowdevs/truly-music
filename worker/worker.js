const PRODUCTION_ORIGIN = 'https://cowdevs.github.io';

function isAllowedOrigin(origin) {
    if (origin === PRODUCTION_ORIGIN) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const ALLOWED_PATHS = ['playlists', 'playlistItems'];

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        const corsHeaders = buildCorsHeaders(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }
        if (request.method !== 'GET') {
            return jsonResponse({ error: { message: 'Method not allowed' } }, 405, corsHeaders);
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/^\/+/, '');

        if (!ALLOWED_PATHS.includes(path)) {
            return jsonResponse({ error: { message: 'Not found' } }, 404, corsHeaders);
        }

        const target = new URL('https://www.googleapis.com/youtube/v3/' + path);
        for (const [key, value] of url.searchParams) {
            if (key.toLowerCase() === 'key') continue;
            target.searchParams.set(key, value);
        }
        target.searchParams.set('key', env.YOUTUBE_API_KEY);

        const upstream = await fetch(target.toString());
        const body = await upstream.text();

        return new Response(body, {
            status: upstream.status,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
    },
};

function buildCorsHeaders(origin) {
    const headers = {
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
    if (isAllowedOrigin(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function jsonResponse(data, status, corsHeaders) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}