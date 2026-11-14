import { createRagProxy } from './rag-proxy.js';

const host = process.env.RAG_HOST || '127.0.0.1';
const port = Number(process.env.RAG_PORT || 8091);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RAG_PORT inválida.');
const proxy = createRagProxy({
  integrationToken: process.env.RAG_INTEGRATION_TOKEN,
  geminiKey: process.env.GEMINI_API_KEY,
});
proxy.listen(port, host, () => console.log(`RAG do Saneia em http://${host}:${port}`));
