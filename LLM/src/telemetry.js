import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const device = {
  id: 'S07', prefix: 'RES-07', name: 'Reservatório 07', neighborhood: 'Setor Norte',
  address: 'Setor Norte · ponto 07 (simulado)', coordinate: { latitude: -23.5492, longitude: -46.637 },
  equipmentType: 'Reservatório com sensor ultrassônico HC-SR04', source: 'Wokwi via HiveMQ',
  expectedIntervalMinutes: 5 / 60, radiusMeters: 220, capacity: 2000, limit: 1800,
};
const tankHeightCm = 200;
const emptyDistanceCm = 202;
const warningAt = 1500;
const releaseBelow = 1750;
const offlineMs = 25_000;
const dayMs = 86_400_000;
const rounded = (value, precision) => Math.round(value * precision) / precision;

export function decodeReading(buffer) {
  if (buffer.length > 256) return null;
  try {
    const sample = JSON.parse(buffer.toString('utf8'));
    return sample?.schemaVersion === 1 && sample.sensorId === device.id
      && typeof sample.sampleId === 'string' && /^[a-f0-9]{16}-[1-9]\d{0,9}$/.test(sample.sampleId)
      && Number.isFinite(sample.distanceCm) && sample.distanceCm >= 2 && sample.distanceCm <= 400
      ? sample : null;
  } catch {
    return null;
  }
}

function estimate(samples, current) {
  if (current.volume >= device.limit) return null;
  const recent = samples.filter((item) => Date.parse(current.at) - Date.parse(item.at) <= 120_000).slice(-4);
  if (recent.length < 2) return null;
  const first = recent[0];
  const duration = Date.parse(current.at) - Date.parse(first.at);
  const difference = current.volume - first.volume;
  if (duration < 9000 || difference < 20) return null;
  return (device.limit - current.volume) / difference * duration / 3_600_000;
}

function event(status, kind, at, message) {
  return { id: randomUUID(), status, kind, at, message };
}

export class Telemetry {
  constructor(path) {
    this.path = path;
    this.state = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))
      : { samples: [], events: [], alarmActive: false, lowStreak: 0, offline: false };
  }

  commit(next) {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.path);
    }
    this.state = next;
  }

  ingest(message, now = Date.now()) {
    const state = this.state;
    const previous = state.samples.at(-1);
    if (state.samples.some((item) => item.id === message.sampleId)
      || (previous && now - Date.parse(previous.at) < 1000)) return false;
    const at = new Date(now).toISOString();
    const levelCm = rounded(Math.min(tankHeightCm, Math.max(0, emptyDistanceCm - message.distanceCm)), 10);
    const volume = Math.round(levelCm / tankHeightCm * device.capacity);
    const reading = { id: message.sampleId, at, volume, levelCm, capacity: device.capacity, limit: device.limit, source: device.source };
    const eta = estimate(state.offline ? [] : state.samples, reading);
    const lowStreak = volume < releaseBelow && state.alarmActive ? (state.offline ? 0 : state.lowStreak) + 1 : 0;
    const alarmActive = volume >= device.limit || (state.alarmActive && lowStreak < 3);
    const status = alarmActive ? 'alarm' : volume >= warningAt || (eta != null && eta <= 8) ? 'warning' : 'normal';
    const events = [...state.events];
    if (state.offline) events.push(event(status, 'online', at, 'A comunicação voltou e uma nova leitura foi recebida.'));
    if (alarmActive && !state.alarmActive) events.push(event('alarm', 'alarm-start', at, `Limite operacional de ${device.limit} L atingido.`));
    else if (state.alarmActive && !alarmActive) events.push(event(status, 'alarm-end', at, 'Alarme normalizado após três leituras abaixo de 1.750 L.'));
    else if (status === 'warning' && previous?.status !== 'warning') events.push(event('warning', 'warning-start', at, 'Volume de atenção ou previsão próxima do limite.'));
    else if (status === 'normal' && previous?.status === 'warning') events.push(event('normal', 'warning-end', at, 'O ponto saiu da faixa de atenção.'));
    this.commit({
      samples: [...state.samples, { ...reading, status, etaHours: eta != null && eta <= 72 ? rounded(eta, 10_000) : null }].slice(-3000),
      events: events.slice(-600), alarmActive, lowStreak: alarmActive ? lowStreak : 0, offline: false,
    });
    return true;
  }

  tick(now = Date.now()) {
    const state = this.state;
    const last = state.samples.at(-1);
    if (!last || state.offline || now - Date.parse(last.at) < offlineMs) return;
    const at = new Date(now).toISOString();
    this.commit({ ...state, offline: true, lowStreak: 0,
      events: [...state.events, event('offline', 'offline', at, 'Nenhuma leitura recebida há 25 segundos.')].slice(-600) });
  }

  snapshot(now = Date.now()) {
    this.tick(now);
    const { samples, events, offline } = this.state;
    const last = samples.at(-1);
    const status = !last || offline ? 'offline' : last.status;
    let reason = 'Aguardando a primeira medição do Wokwi.';
    if (last) {
      if (offline) reason = 'Sem comunicação. Exibindo a última medição recebida.';
      else if (status === 'alarm') reason = last.volume >= device.limit ? 'Limite operacional atingido.'
        : 'Alarme ativo até três leituras abaixo de 1.750 L.';
      else if (status === 'warning') reason = 'Volume na faixa de atenção ou previsão próxima do limite.';
      else reason = 'Leitura recebida dentro da faixa normal.';
    }
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
    return { ...device, status, reason, volume: last?.volume ?? null, lastReadingAt: last?.at ?? null,
      etaHours: status === 'offline' ? null : last?.etaHours ?? null, samples, events,
      alarmsSixMonths: events.filter((item) => item.kind === 'alarm-start' && Date.parse(item.at) >= sixMonthsAgo.getTime()).length };
  }

  facts({ from, to }) {
    const start = from ? Date.parse(from) : -Infinity;
    const end = Date.parse(to);
    const samples = this.state.samples.filter((item) => Date.parse(item.at) >= start && Date.parse(item.at) <= end);
    if (!samples.length) return null;
    const first = samples[0], last = samples.at(-1);
    const peak = samples.reduce((max, sample) => sample.volume > max.volume ? sample : max);
    return {
      dadosSimulados: true, periodoInicio: from || null, periodoFim: to,
      amostras: samples.length, primeiraLeitura: first.at, ultimaLeitura: last.at,
      primeiroVolumeL: first.volume, ultimoVolumeL: last.volume,
      picoL: peak.volume, instantePico: peak.at,
      variacaoL: samples.length >= 2 ? last.volume - first.volume : null,
      limiteL: device.limit,
      leiturasNoLimite: samples.filter((item) => item.volume >= item.limit).length,
      alarmesAbertosNoPeriodo: this.state.events.filter((item) => item.kind === 'alarm-start'
        && Date.parse(item.at) >= start && Date.parse(item.at) <= end).length,
    };
  }
}
