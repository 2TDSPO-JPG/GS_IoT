import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import mqtt from 'mqtt';
import { Telemetry, decodeReading, device } from './telemetry.js';
import { createGemini, httpError } from './gemini.js';
import { retrieveProcedures } from './retrieval.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8090);
const broker = process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883';
const topic = process.env.MQTT_TOPIC || 'saneia/demo/72f4a1ce9b/res07/telemetry';
const demoToken = process.env.IOT_DEMO_TOKEN || '';
const webOrigin = process.env.IOT_WEB_ORIGIN;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && demoToken.length < 20) {
  throw new Error('Defina IOT_DEMO_TOKEN com pelo menos 20 caracteres para liberar acesso pela rede local.');
}
if (/[#+\u0000]/.test(topic)) throw new Error('Use um tópico MQTT exato para o equipamento.');

const telemetry = new Telemetry(resolve(process.env.IOT_DATA_FILE || 'data/telemetry.json'));
const analyze = createGemini({ key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' });
let brokerReady = false;
let rejected = 0;
const client = mqtt.connect(broker, {
  clientId: `saneia-${randomUUID().slice(0, 12)}`, reconnectPeriod: 5000, connectTimeout: 6000, resubscribe: false,
  ...(process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD } : {}),
});
client.on('connect', () => client.subscribe(topic, { qos: 0 }, (error, granted) => {
  brokerReady = !error && granted?.[0]?.qos === 0;
  console.log(brokerReady ? 'MQTT conectado e inscrito no tópico do Saneia.' : 'Não foi possível assinar o tópico MQTT.');
}));
client.on('close', () => { brokerReady = false; });
client.on('error', (error) => console.warn('Conexão MQTT indisponível:', error.code || error.name));
client.on('message', (name, payload, packet) => {
  const reading = name === topic && !packet.retain ? decodeReading(payload) : null;
  if (!reading) { rejected += 1; return; }
  try {
    telemetry.tick();
    if (telemetry.ingest(reading)) console.log('Leitura recebida:', device.id, `${reading.distanceCm} cm`);
  } catch (error) {
    console.error('Falha ao salvar leitura:', error.code || error.name);
  }
});

function authorized(req) {
  if (!demoToken) return true;
  const expected = Buffer.from(`Bearer ${demoToken}`);
  const supplied = Buffer.from(req.headers.authorization || '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readRange(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) throw httpError(413, 'Solicitação grande demais.');
    chunks.push(chunk);
  }
  let range;
  try { range = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Envie um período válido.'); }
  if (!range || !['today', '7d', '30d', '90d', 'all'].includes(range.period)) throw httpError(400, 'Período inválido.');
  const to = Date.parse(range.to);
  const from = range.period === 'all' ? null : Date.parse(range.from);
  if (!Number.isFinite(to) || to > Date.now() + 120_000 || (from !== null && (!Number.isFinite(from) || from > to))) {
    throw httpError(400, 'Intervalo inválido.');
  }
  return { from: from === null ? null : new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const server = createServer(async (req, res) => {
  if (webOrigin && req.headers.origin === webOrigin) {
    res.setHeader('Access-Control-Allow-Origin', webOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  }
  if (!authorized(req)) { send(res, 401, { message: 'Token da demonstração inválido.' }); return; }
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { mqttConnected: brokerReady, geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
        sensorStatus: telemetry.snapshot().status, rejected });
    } else if (req.method === 'GET' && path === '/sensors') {
      const { samples, events, ...point } = telemetry.snapshot();
      send(res, 200, [point]);
    } else if (req.method === 'GET' && path === `/sensors/${device.id}`) {
      send(res, 200, telemetry.snapshot());
    } else if (req.method === 'POST' && path === `/sensors/${device.id}/insights`) {
      const facts = telemetry.facts(await readRange(req));
      if (!facts) throw httpError(422, 'Não há leituras nesse período para analisar.');
      const sources = retrieveProcedures({ readings: facts.amostras, currentStatus: telemetry.snapshot().status,
        readingsAtOrAboveLimit: facts.leiturasNoLimite, alarmEvents: facts.alarmesAbertosNoPeriodo,
        changeLiters: facts.variacaoL, etaHours: telemetry.snapshot().etaHours });
      send(res, 200, { summary: await analyze(facts, sources),
        references: sources.map(({ id, title }) => ({ id, title })) });
    } else {
      send(res, 404, { message: 'Rota não encontrada.' });
    }
  } catch (error) {
    if (!error.status) console.error('Erro da ponte IoT:', error.code || error.name);
    if (!res.destroyed) send(res, error.status || 500, { message: error.status ? error.message : 'Falha interna da ponte IoT.' });
  }
});

const clock = setInterval(() => {
  try { telemetry.tick(); } catch (error) { console.error('Falha ao salvar estado:', error.code || error.name); }
}, 1000);
server.listen(port, host, () => console.log(`Ponte IoT Saneia em http://${host}:${port} (dados simulados).`));
function shutdown() {
  clearInterval(clock);
  client.end(true);
  server.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
