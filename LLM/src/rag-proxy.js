import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { httpError } from './gemini.js';
import { procedurePrompt, retrieveProcedures } from './retrieval.js';

const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const equipmentPrefix = 'Dados calculados do equipamento (JSON):\n';
const maxBodyBytes = 64 * 1024;

export function addRetrievedContext(body) {
  const message = body.messages.findLast(({ role, content }) =>
    role === 'user' && typeof content === 'string' && content.startsWith(equipmentPrefix));
  if (!message) return body;

  let indicators;
  try {
    indicators = JSON.parse(message.content.slice(equipmentPrefix.length));
  } catch {
    throw httpError(400, 'Indicadores de telemetria inválidos.');
  }
  if (!Number.isInteger(indicators?.readings) || indicators.readings < 0
      || !['normal', 'warning', 'alarm', 'offline'].includes(indicators.currentStatus)) {
    throw httpError(400, 'Indicadores de telemetria inválidos.');
  }
  const context = procedurePrompt(retrieveProcedures(indicators));
  if (!context) return body;
  const instruction = body.messages.findIndex(({ role }) => role === 'system');
  const messages = body.messages.map((entry, index) =>
    index === instruction ? { ...entry, content: entry.content + context } : entry);
  if (instruction === -1) messages.unshift({ role: 'system', content: context.trim() });
  return { ...body, messages };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) throw httpError(413, 'Requisição grande demais.');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Envie um corpo JSON válido.');
  }
  if (!Array.isArray(body?.messages) || !body.messages.length
      || body.messages.some((entry) => !entry || typeof entry.role !== 'string' || typeof entry.content !== 'string')
      || body.stream === true || !/^gemini-[a-z0-9.-]+$/.test(body.model ?? '')) {
    throw httpError(400, 'Informe um modelo Gemini e mensagens textuais sem streaming.');
  }
  return body;
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createRagProxy({ integrationToken, geminiKey, fetcher = fetch }) {
  if (Buffer.byteLength(integrationToken ?? '') < 32 || !geminiKey?.trim()) {
    throw new Error('Configure RAG_INTEGRATION_TOKEN com pelo menos 32 bytes e GEMINI_API_KEY.');
  }
  const expected = Buffer.from(`Bearer ${integrationToken}`);
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'up' });
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      return send(response, 404, { error: { message: 'Rota não encontrada.' } });
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return send(response, 401, { error: { message: 'Credencial de integração inválida.' } });
    }

    try {
      const body = addRetrievedContext(await readBody(request));
      const upstream = await fetcher(geminiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${geminiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
      if (!upstream.ok) {
        return send(response, upstream.status === 429 ? 429 : 502,
          { error: { message: 'O Gemini não concluiu a análise.' } });
      }
      const result = await upstream.json();
      const choice = result?.choices?.[0];
      if (choice?.finish_reason === 'length' || typeof choice?.message?.content !== 'string'
          || !choice.message.content.trim()) {
        throw httpError(502, 'O Gemini não devolveu um resumo.');
      }
      return send(response, 200, result);
    } catch (error) {
      return send(response, error.status ?? 502,
        { error: { message: error.status ? error.message : 'Falha ao consultar o Gemini.' } });
    }
  });
}
