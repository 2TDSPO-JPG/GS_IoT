import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Telemetry, decodeReading } from '../src/telemetry.js';
import { createGemini } from '../src/gemini.js';

const start = Date.parse('2026-11-04T18:00:00Z');
const input = (seq, distanceCm) => ({ schemaVersion: 1, sensorId: 'S07', sampleId: `abcd0123abcd0123-${seq}`, distanceCm });

test('valida a identidade, a faixa física e o tamanho do payload', () => {
  assert.deepEqual(decodeReading(Buffer.from(JSON.stringify(input(1, 102)))), input(1, 102));
  assert.equal(decodeReading(Buffer.from(JSON.stringify(input(1, 401)))), null);
  assert.equal(decodeReading(Buffer.from('x'.repeat(257))), null);
  assert.equal(decodeReading(Buffer.from(JSON.stringify({ ...input(1, 20), sensorId: 'S99' }))), null);
});

test('abre um único alarme, conserva-o ao perder comunicação e normaliza só após três leituras', () => {
  const data = new Telemetry();
  data.ingest(input(1, 102), start);
  assert.equal(data.snapshot(start).volume, 1000);
  assert.equal(data.snapshot(start).status, 'normal');
  data.ingest(input(2, 42), start + 5000);
  assert.equal(data.snapshot(start + 5000).status, 'warning');
  data.ingest(input(3, 20), start + 10_000);
  data.ingest(input(4, 18), start + 15_000);
  assert.equal(data.ingest(input(4, 18), start + 20_000), false);
  assert.equal(data.snapshot(start + 20_000).alarmsSixMonths, 1);
  assert.equal(data.snapshot(start + 40_000).status, 'offline');
  data.ingest(input(5, 20), start + 45_000);
  assert.equal(data.snapshot(start + 45_000).alarmsSixMonths, 1);
  for (let step = 1; step <= 3; step++) {
    const at = start + 45_000 + step * 5000;
    data.ingest(input(5 + step, 102), at);
    assert.equal(data.snapshot(at).status, step < 3 ? 'alarm' : 'normal');
  }
  const facts = data.facts({ from: new Date(start + 10_000).toISOString(), to: new Date(start + 15_000).toISOString() });
  assert.equal(facts.leiturasNoLimite, 2);
  assert.equal(facts.alarmesAbertosNoPeriodo, 1);
});

test('envia apenas os indicadores ao Gemini e limita chamadas repetidas', async () => {
  let request;
  const analyze = createGemini({ key: 'chave-de-teste', model: 'gemini-3.5-flash', clock: () => 0,
    fetcher: async (url, options) => {
      request = { url, ...options };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { thought: true, text: 'ignorado' }, { text: 'O pico simulado foi de 1.820 L.' },
      ] } }] }));
    },
  });
  assert.equal(await analyze({ picoL: 1820 }), 'O pico simulado foi de 1.820 L.');
  assert.match(request.url, /gemini-3\.5-flash:generateContent$/);
  assert.equal(request.headers['x-goog-api-key'], 'chave-de-teste');
  assert.equal(JSON.parse(request.body).generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.deepEqual(JSON.parse(JSON.parse(request.body).contents[0].parts[0].text), { picoL: 1820 });
  await assert.rejects(analyze({ picoL: 1820 }), { status: 429 });
});

test('não entrega um resumo cortado por limite de saída', async () => {
  const analyze = createGemini({ key: 'chave-de-teste', model: 'gemini-3.5-flash',
    fetcher: async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS',
      content: { parts: [{ text: 'O reservatório chegou a' }] },
    }] })),
  });
  await assert.rejects(analyze({ picoL: 1820 }), { status: 502, message: /análise incompleta/ });
});
