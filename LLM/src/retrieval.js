import { readFileSync } from 'node:fs';

const procedures = JSON.parse(readFileSync(new URL('../knowledge/procedimentos.json', import.meta.url), 'utf8'));

export function retrieveProcedures({ readings, currentStatus, readingsAtOrAboveLimit, alarmEvents, etaHours, changeLiters }) {
  const signals = new Map();
  if (currentStatus === 'offline') signals.set('offline', 8);
  if (currentStatus === 'alarm') signals.set('active-alarm', 6);
  if (readingsAtOrAboveLimit > 0 || alarmEvents > 0) signals.set('above-limit', 5);
  if (currentStatus === 'warning') signals.set('warning', 4);
  if (readings < 3) signals.set('sparse', 3);
  if (readings >= 3 && currentStatus !== 'offline' && changeLiters > 0
      && Number.isFinite(etaHours) && etaHours > 0) signals.set('rising', 2);
  if (signals.size === 0 && currentStatus === 'normal') signals.set('normal', 1);

  return procedures.map(({ signals: tags, ...source }) => ({
    source, score: tags.reduce((total, tag) => total + (signals.get(tag) ?? 0), 0),
  })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score)
    .slice(0, 2).map(({ source }) => source);
}

export function procedurePrompt(sources) {
  if (!sources.length) return '';
  return '\n\nProcedimentos internos simulados recuperados para este caso. ' +
    'Se couber uma verificação prática na análise, fundamente-a somente nos trechos abaixo e cite o ID correspondente entre colchetes. ' +
    'Use os indicadores para afirmar volumes, datas e estado atual.\n' +
    sources.map(({ id, title, text }) => `[${id}] ${title}. ${text}`).join('\n');
}
