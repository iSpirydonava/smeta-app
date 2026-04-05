const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const DIRECTUS_URL = process.env.DIRECTUS_URL || 'https://admin.polakohedonist.club';
const DIRECTUS_TOKEN = process.env.DIRECTUS_TOKEN;

// ── helpers ──────────────────────────────────────────────────────────────────

function jsonRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, status, data) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── routes ───────────────────────────────────────────────────────────────────

async function handleGenerate(req, res) {
  if (!ANTHROPIC_KEY) return send(res, 500, { error: 'ANTHROPIC_API_KEY not set' });

  const body = await parseBody(req);
  const { client, desc, extra, services, historyContext } = body;

  if (!desc) return send(res, 400, { error: 'desc is required' });

  const prompt = `Ты — специалист рекламного агентства Polako Hedonist. Тебе нужно составить смету для клиента на основе его описания.

СПИСОК ДОСТУПНЫХ УСЛУГ (JSON):
${JSON.stringify(services || [])}

ЗАПРОС КЛИЕНТА:
Клиент: ${client || 'не указан'}
Описание: ${desc}
${extra ? 'Дополнительно: ' + extra : ''}
${historyContext ? '\nПРЕДЫДУЩИЕ СМЕТЫ (используй для понимания паттернов):\n' + historyContext : ''}

ЗАДАЧА: Подбери подходящие услуги из списка и верни JSON:
{
  "tags": ["2-4 ключевых слова"],
  "thinking": "краткое объяснение (1-3 предложения)",
  "items": [
    {
      "category": "категория",
      "name": "точное название из списка",
      "price": число,
      "qty": число,
      "comment": "почему выбрана",
      "discount": 0,
      "discountAllowed": true/false
    }
  ]
}

Правила:
- Выбирай только услуги из списка, не придумывай новые
- qty разумный (таргет 14 дней = qty:14)
- Если у услуги discountAllowed=false — обязательно сохрани discountAllowed: false в ответе
- Услуги связанные с таргетингом/таргетом ВСЕГДА получают discountAllowed: false и discount: 0
- Подбирай 3-10 услуг
- Отвечай ТОЛЬКО JSON, без markdown`;

  try {
    const directusHost = new URL(DIRECTUS_URL).hostname;
    const result = await jsonRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });

    if (result.status !== 200) return send(res, 502, { error: 'Anthropic error', detail: result.body });

    const text = result.body.content.map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    send(res, 200, parsed);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handleSaveEstimate(req, res) {
  if (!DIRECTUS_TOKEN) return send(res, 500, { error: 'DIRECTUS_TOKEN not set' });

  const body = await parseBody(req);
  const host = new URL(DIRECTUS_URL).hostname;

  try {
    const result = await jsonRequest({
      hostname: host,
      path: '/items/estimates',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DIRECTUS_TOKEN}`
      }
    }, {
      client_name: body.client_name || 'Клиент',
      status: body.status || 'draft',
      total_amount: body.total_amount || 0,
      global_discount: body.global_discount || 0,
      comment: body.comment || '',
      items: body.items || [],
      tags: body.tags || []
    });

    send(res, result.status === 200 ? 200 : 201, result.body);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handleGetEstimates(req, res) {
  if (!DIRECTUS_TOKEN) return send(res, 500, { error: 'DIRECTUS_TOKEN not set' });

  const host = new URL(DIRECTUS_URL).hostname;
  const parsedUrl = url.parse(req.url, true);
  const limit = parsedUrl.query.limit || 50;

  try {
    const result = await jsonRequest({
      hostname: host,
      path: `/items/estimates?sort=-date_created&limit=${limit}&fields=id,client_name,status,total_amount,global_discount,comment,items,tags,date_created`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${DIRECTUS_TOKEN}` }
    });

    send(res, 200, result.body);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handleUpdateEstimate(req, res, id) {
  if (!DIRECTUS_TOKEN) return send(res, 500, { error: 'DIRECTUS_TOKEN not set' });

  const body = await parseBody(req);
  const host = new URL(DIRECTUS_URL).hostname;

  try {
    const result = await jsonRequest({
      hostname: host,
      path: `/items/estimates/${id}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DIRECTUS_TOKEN}`
      }
    }, body);

    send(res, 200, result.body);
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

async function handleGetServices(req, res) {
  if (!DIRECTUS_TOKEN) return send(res, 500, { error: 'DIRECTUS_TOKEN not set' });

  const host = new URL(DIRECTUS_URL).hostname;

  try {
    const result = await jsonRequest({
      hostname: host,
      path: '/items/platform_services?fields=id,name,base_price,short_description,is_discount_applied,duration_type,category_id.name&filter[is_active][_eq]=true&limit=100',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${DIRECTUS_TOKEN}` }
    });

    // Human-readable name overrides for technical Directus names
    const NAME_MAP = {
      'Pin 3 days': 'Закреп поста на 3 дня',
      'Pin 7 days': 'Закреп поста на 7 дней',
      'Pin 14 days': 'Закреп поста на 14 дней',
      'Pin 30 days': 'Закреп поста на 30 дней',
      'Pin 1 day': 'Закреп поста на 1 день',
      'Repost stories': 'Репост в сторис',
      'Repost feed': 'Репост в ленту',
      'Story mention': 'Упоминание в сторис',
      'Feed post': 'Пост в ленте',
      'Story post': 'Публикация в сторис',
    };

    // Map to frontend format
    const services = (result.body.data || []).map(s => {
      const rawName = s.name || '';
      const displayName = NAME_MAP[rawName] || rawName;
      const isTarget = rawName.toLowerCase().includes('target') ||
                       rawName.toLowerCase().includes('таргет') ||
                       (s.short_description || '').toLowerCase().includes('таргет');
      return {
        id: s.id,
        category: s.category_id?.name || 'Прочее',
        name: displayName,
        rawName: rawName,
        price: parseFloat(s.base_price) || 0,
        duration: s.duration_type === 'monthly' ? 'в месяц' : '',
        comment: s.short_description || '',
        discountAllowed: isTarget ? false : (s.is_discount_applied !== false)
      };
    });

    send(res, 200, { data: services });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

// ── server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (path === '/health') return send(res, 200, { ok: true });

  // Routes
  if (path === '/api/generate' && req.method === 'POST') return handleGenerate(req, res);
  if (path === '/api/services' && req.method === 'GET') return handleGetServices(req, res);
  if (path === '/api/estimates' && req.method === 'GET') return handleGetEstimates(req, res);
  if (path === '/api/estimates' && req.method === 'POST') return handleSaveEstimate(req, res);

  const updateMatch = path.match(/^\/api\/estimates\/([^/]+)$/);
  if (updateMatch && req.method === 'PATCH') return handleUpdateEstimate(req, res, updateMatch[1]);

  // Serve static index.html for everything else
  const fs = require('fs');
  if (fs.existsSync('./public/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync('./public/index.html'));
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
