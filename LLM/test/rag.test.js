import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRagProxy } from '../src/rag-proxy.js';
import { retrieveProcedures } from '../src/retrieval.js';

const auth = 'token-local-de-teste-com-mais-de-32-bytes';
const facts = { readings: 12, currentStatus: 'alarm', readingsAtOrAboveLimit: 2, alarmEvents: 1, maxVolume: 1850 };
const prompt = JSON.stringify({
  model: 'gemini-3.5-flash',
  messages: [
    { role: 'system', content: 'Resuma a telemetria.' },
    { role: 'user', content: `Dados calculados do equipamento (JSON):\n${JSON.stringify(facts)}` },
  ],
});

test('recupera referências diferentes por estado e prioriza perda de comunicação', () => {
  const scenarios = [
    [facts, ['SAN-01']],
    [{ readings: 1, currentStatus: 'offline', alarmEvents: 1 }, ['SAN-03', 'SAN-01']],
    [{ readings: 8, currentStatus: 'warning' }, ['SAN-02']],
    [{ readings: 2, currentStatus: 'normal' }, ['SAN-04']],
    [{ readings: 15, currentStatus: 'normal' }, ['SAN-05']],
  ];
  for (const [indicators, expected] of scenarios) {
    assert.deepEqual(retrieveProcedures(indicators).map(({ id }) => id), expected);
  }
});

test('protege a rota, envia o procedimento ao Gemini e preserva as métricas e as outras solicitações', async (t) => {
  const requests = [];
  const server = createRagProxy({ integrationToken: auth, geminiKey: 'chave-falsa', fetcher: async (url, options) => {
    requests.push({ url, ...options });
    return Response.json({ choices: [{ message: { content: 'O pico foi de 1.850 L [SAN-01].' } }] });
  } });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/chat/completions`;
  const post = (body, token) => fetch(endpoint, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });

  assert.equal((await post(prompt)).status, 401);
  assert.equal((await post('não é JSON', auth)).status, 400);
  assert.equal((await post('x'.repeat(65_537), auth)).status, 413);
  assert.equal(requests.length, 0);

  const result = await post(prompt, auth);
  assert.equal(result.status, 200);
  assert.match((await result.json()).choices[0].message.content, /1850|1\.850/);
  const sent = JSON.parse(requests[0].body);
  assert.match(sent.messages[0].content, /\[SAN-01\]/);
  assert.doesNotMatch(sent.messages[0].content, /\[SAN-03\]/);
  assert.equal(sent.messages[1].content, JSON.parse(prompt).messages[1].content);
  assert.equal(requests[0].headers.Authorization, 'Bearer chave-falsa');

  const unrelated = { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'Boletim operacional.' }] };
  assert.equal((await post(JSON.stringify(unrelated), auth)).status, 200);
  assert.deepEqual(JSON.parse(requests[1].body), unrelated);
});

test('retorna falha controlada se o provedor rejeitar a chamada', async (t) => {
  const server = createRagProxy({ integrationToken: auth, geminiKey: 'chave-falsa',
    fetcher: async () => new Response('detalhe interno', { status: 503 }) });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  t.after(() => server.close());
  const result = await fetch(`http://127.0.0.1:${server.address().port}/chat/completions`, {
    method: 'POST', body: prompt, headers: { Authorization: `Bearer ${auth}` },
  });
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /detalhe interno/);
});
