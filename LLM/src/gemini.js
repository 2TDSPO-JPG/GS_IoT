import { procedurePrompt } from './retrieval.js';

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function createGemini({ key, model, fetcher = fetch, clock = Date.now }) {
  if (!/^[a-z0-9.-]+$/.test(model)) throw new Error('GEMINI_MODEL inválido.');
  let lastRequest = -Infinity;

  return async function analyze(facts, sources = []) {
    if (!key) throw httpError(503, 'Configure GEMINI_API_KEY no servidor para usar a análise.');
    if (clock() - lastRequest < 30_000) throw httpError(429, 'Aguarde 30 segundos antes de gerar outra análise.');
    lastRequest = clock();
    let response;
    try {
      response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: AbortSignal.timeout(12_000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text:
            'Resuma em português do Brasil, em até três frases curtas e em texto simples, as métricas de um reservatório simulado. Cite números úteis para a operadora, diferencie leituras acima do limite de eventos de alarme e sinalize quando há poucas amostras. Use somente os fatos recebidos. Não atribua causas, não estime novos números e não mude o estado do equipamento.' + procedurePrompt(sources),
          }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify(facts) }] }],
          generationConfig: {
            maxOutputTokens: 2048,
            ...(model.startsWith('gemini-3') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
          },
        }),
      });
    } catch {
      throw httpError(502, 'Não foi possível alcançar o Gemini. Tente novamente em instantes.');
    }
    if (response.status === 429) throw httpError(429, 'O Gemini atingiu o limite de uso. Aguarde antes de tentar de novo.');
    if (!response.ok) throw httpError(502, 'O Gemini recusou a análise. Confira a chave e o modelo no servidor.');
    const data = await response.json().catch(() => null);
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw httpError(502, 'O Gemini devolveu uma análise incompleta. Os indicadores do período continuam disponíveis.');
    }
    const parts = candidate?.content?.parts || [];
    const summary = parts.filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text).join(' ').trim();
    if (!summary) throw httpError(502, 'O Gemini não devolveu um resumo para o período.');
    return summary;
  };
}
