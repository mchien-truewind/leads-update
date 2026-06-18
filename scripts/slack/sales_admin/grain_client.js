const https = require('https');
const http = require('http');

function normalizeBaseUrl(value) {
  return String(value || 'https://api.grain.com/_/public-api/v2').replace(/\/$/, '');
}

function parseListItems(payload) {
  if (Array.isArray(payload)) return { items: payload, cursor: '', hasMore: false };
  if (!payload || typeof payload !== 'object') return { items: [], cursor: '', hasMore: false };
  const items = payload.recordings || payload.data || payload.results || payload.items || [];
  const cursor = payload.next_cursor || payload.cursor || payload.next || payload.next_page_token || '';
  return {
    items: Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [],
    cursor: String(cursor || ''),
    hasMore: Boolean(payload.has_more || cursor),
  };
}

function normalizeInclude(include) {
  if (!include) return {};
  if (Array.isArray(include)) {
    return Object.fromEntries(include.filter(Boolean).map(key => [key, true]));
  }
  if (typeof include === 'object') return include;
  return {};
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let payload = data;
        try { payload = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = payload && typeof payload === 'object'
            ? (payload.message || payload.error || JSON.stringify(payload))
            : String(payload || '');
          const err = new Error(`Grain ${res.statusCode}: ${message}`);
          err.statusCode = res.statusCode;
          err.body = payload;
          reject(err);
          return;
        }
        resolve(payload);
      });
    });
    req.setTimeout(Number(options.timeoutMs || 30000), () => {
      req.destroy(new Error(`Grain request timed out after ${options.timeoutMs || 30000}ms`));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

class GrainClient {
  constructor({ token, baseUrl, logger = console, httpRequest = requestJson } = {}) {
    this.token = token;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.logger = logger;
    this.httpRequest = httpRequest;
  }

  isConfigured() {
    return Boolean(this.token);
  }

  async request(method, endpoint, body = null, headers = {}) {
    if (!this.token) throw new Error('Grain not configured');
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    return this.httpRequest(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Public-Api-Version': '2025-10-31',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async listRecordings({ start, end, teamId = '', maxPages = 10, include = { participants: true, ai_action_items: true, ai_summary: true, calendar_event: true, hubspot: true } } = {}) {
    const recordings = [];
    let cursor = '';
    for (let page = 0; page < maxPages; page++) {
      const body = {
        include: normalizeInclude(include),
      };
      if (cursor) body.cursor = cursor;
      const filter = {};
      if (end) filter.after_datetime = new Date(end).toISOString();
      if (teamId) filter.team = String(teamId).trim();
      if (Object.keys(filter).length) body.filter = filter;
      let payload;
      try {
        payload = await this.request('POST', '/recordings', body);
      } catch (err) {
        if (page > 0) throw err;
        payload = await this.request('POST', '/recordings', { include: body.include });
      }
      const parsed = parseListItems(payload);
      recordings.push(...parsed.items);
      if (!parsed.hasMore || !parsed.cursor || parsed.items.length === 0) break;
      cursor = parsed.cursor;
    }
    const startMs = start ? new Date(start).getTime() : 0;
    const endMs = end ? new Date(end).getTime() : 0;
    if (!startMs && !endMs) return recordings;
    return recordings.filter(recording => {
      const raw = recording.start_datetime || recording.start_time || recording.started_at || recording.recorded_at || recording.created_at || '';
      const recordingStartMs = raw ? new Date(raw).getTime() : 0;
      if (!Number.isFinite(recordingStartMs) || recordingStartMs <= 0) return false;
      if (startMs && recordingStartMs < startMs) return false;
      if (endMs && recordingStartMs > endMs) return false;
      return true;
    });
  }

  async getRecording(recordingId) {
    const id = encodeURIComponent(recordingId);
    try {
      return await this.request('POST', `/recordings/${id}`, {
        include: {
          participants: true,
          ai_action_items: true,
          ai_summary: true,
          calendar_event: true,
          hubspot: true,
        },
      });
    } catch (err) {
      return this.request('GET', `/recordings/${id}`);
    }
  }

  async getTranscript(recordingId) {
    const id = encodeURIComponent(recordingId);
    try {
      return await this.request('GET', `/recordings/${id}/transcript`);
    } catch (err) {
      return this.request('GET', `/recordings/${id}/transcript.txt`, null, { Accept: 'text/plain' });
    }
  }
}

module.exports = {
  GrainClient,
  normalizeInclude,
  parseListItems,
};
