import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import mqtt from 'mqtt';

const supplied = process.argv.slice(2).map(Number);
const distances = supplied.length ? supplied : [102, 102, 42, 20, 20, 102, 102, 102];
if (distances.some((value) => !Number.isFinite(value) || value < 2 || value > 400)) {
  throw new Error('Informe distâncias em centímetros, entre 2 e 400.');
}
const boot = randomBytes(8).toString('hex');
const topic = process.env.MQTT_TOPIC || 'saneia/demo/72f4a1ce9b/res07/telemetry';
const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://broker.hivemq.com:1883', {
  reconnectPeriod: 5000, connectTimeout: 8000,
  ...(process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD } : {}),
});
client.on('error', () => { /* o cliente tenta novamente até o limite abaixo */ });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('O broker não confirmou a conexão. Confira MQTT_URL e tente novamente.')), 30_000);
    client.once('connect', () => { clearTimeout(timeout); resolve(); });
  });
  for (const [index, distanceCm] of distances.entries()) {
    const reading = { schemaVersion: 1, sensorId: 'S07', sampleId: `${boot}-${index + 1}`, distanceCm };
    await client.publishAsync(topic, JSON.stringify(reading), { qos: 1, retain: false });
    console.log(`Leitura fictícia publicada: ${distanceCm} cm`);
    if (index < distances.length - 1) await delay(5000);
  }
} finally {
  await client.endAsync(true);
}
