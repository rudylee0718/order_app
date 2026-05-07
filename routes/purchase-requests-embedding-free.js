
// ============================================================
// 方案 A：Ollama（完全免費，本機執行）
// ============================================================
//
// 安裝步驟：
//   1. 下載 Ollama：https://ollama.com/download
//   2. 執行：ollama pull nomic-embed-text
//      （nomic-embed-text 是專為 embedding 設計的模型，
//        768 維，效果好，只有 274MB）
//   3. Ollama 預設在 http://localhost:11434 提供 API
//
// 環境變數：
//   OLLAMA_HOST=http://localhost:11434  （預設值，可不設）
//   EMBEDDING_MODEL=nomic-embed-text
//   EMBEDDING_DIM=768
//
// DDL 也要調整維度：
//   ALTER TABLE app_order.purchase_requests
//     ADD COLUMN embedding vector(768);

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

async function getEmbeddingOllama(text) {
  const response = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
      prompt: text.replace(/\n/g, ' ').trim(),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama embedding 失敗: ${err}`);
  }

  const data = await response.json();
  return data.embedding; // number[]
}

// ── 使用方式 ──────────────────────────────────────────────
// 將 purchase-requests-ai-search.js 中的：
//   const openai = new OpenAI(...)
//   async function getEmbedding(text) { ... }
// 替換為：
//   const getEmbedding = getEmbeddingOllama;


// ============================================================
// 方案 B：Hugging Face Inference API（免費額度）
// ============================================================
//
// 免費額度：每月有一定免費用量，個人使用基本夠
// 推薦模型：BAAI/bge-m3（支援中文，1024 維）
//           或 sentence-transformers/paraphrase-multilingual-mpnet-base-v2
//
// 設定步驟：
//   1. 到 https://huggingface.co/ 註冊（免費）
//   2. Settings > Access Tokens > New Token（免費）
//   3. 設定環境變數 HF_API_KEY=hf_xxxx
//
// 環境變數：
//   HF_API_KEY=hf_xxxxxxxxxx
//   HF_MODEL=BAAI/bge-m3
//   EMBEDDING_DIM=1024

const HF_MODEL = process.env.HF_MODEL || 'BAAI/bge-m3';

async function getEmbeddingHuggingFace(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) throw new Error('缺少 HF_API_KEY 環境變數');

  const response = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: text.replace(/\n/g, ' ').trim(),
        options: { wait_for_model: true },  // 冷啟動時自動等待
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HuggingFace embedding 失敗: ${err}`);
  }

  const data = await response.json();

  // HF 回傳格式可能是 number[] 或 number[][]（token-level）
  // bge-m3 回傳 number[][]，取平均池化
  if (Array.isArray(data[0])) {
    // token embeddings → 平均池化
    const dim = data[0].length;
    const avg = new Array(dim).fill(0);
    data.forEach(tok => tok.forEach((v, i) => { avg[i] += v; }));
    return avg.map(v => v / data.length);
  }
  return data; // 已經是 number[]
}


// ============================================================
// 方案 C：Cloudflare Workers AI（免費額度非常大）
// ============================================================
//
// 免費額度：每天 10,000 次 embedding 請求（個人完全夠用）
// 推薦模型：@cf/baai/bge-base-en-v1.5（768 維）
//           @cf/baai/bge-large-en-v1.5（1024 維）
//
// 注意：目前 Cloudflare AI embedding 主要支援英文
//       中文效果較差，建議搭配翻譯或使用 Ollama
//
// 設定步驟：
//   1. 到 https://dash.cloudflare.com/ 註冊（免費）
//   2. My Profile > API Tokens > Create Token
//   3. 設定環境變數 CF_API_TOKEN, CF_ACCOUNT_ID
//
// 環境變數：
//   CF_API_TOKEN=xxxxxx
//   CF_ACCOUNT_ID=xxxxxx
//   CF_AI_MODEL=@cf/baai/bge-base-en-v1.5
//   EMBEDDING_DIM=768

async function getEmbeddingCloudflare(text) {
  const token     = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  const model     = process.env.CF_AI_MODEL || '@cf/baai/bge-base-en-v1.5';

  if (!token || !accountId) throw new Error('缺少 CF_API_TOKEN 或 CF_ACCOUNT_ID');

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [text.replace(/\n/g, ' ').trim()],
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Cloudflare AI embedding 失敗: ${err}`);
  }

  const data = await response.json();
  return data.result.data[0]; // number[]
}


// ============================================================
// 方案 D：transformers.js（純 Node.js，不需外部服務）
// ============================================================
//
// 完全本機執行，不需任何 API Key
// 首次執行會下載模型（約 100~400MB）
// 之後存在 cache，不再下載
//
// 安裝：npm install @xenova/transformers
//
// 推薦模型：Xenova/multilingual-e5-small（支援中文，384 維）
//           Xenova/paraphrase-multilingual-MiniLM-L12-v2
//
// 環境變數：
//   TRANSFORMERS_MODEL=Xenova/multilingual-e5-small
//   EMBEDDING_DIM=384

let _pipeline = null; // 單例，只初始化一次

async function getEmbeddingTransformers(text) {
  // 動態 import（避免在不需要時載入）
  const { pipeline } = await import('@xenova/transformers');

  if (!_pipeline) {
    const modelName = process.env.TRANSFORMERS_MODEL
      || 'Xenova/multilingual-e5-small';
    console.log(`🔄 載入 embedding 模型：${modelName}`);
    _pipeline = await pipeline('feature-extraction', modelName, {
      quantized: true,  // 使用量化模型，體積更小
    });
    console.log(`✅ 模型載入完成`);
  }

  const output = await _pipeline(
    text.replace(/\n/g, ' ').trim(),
    { pooling: 'mean', normalize: true }
  );

  return Array.from(output.data); // Float32Array → number[]
}


// ============================================================
// 統一介面：根據環境變數自動選擇方案
// ============================================================
//
// 在 .env 設定 EMBEDDING_PROVIDER 決定使用哪個方案：
//   EMBEDDING_PROVIDER=ollama       → 方案 A（推薦）
//   EMBEDDING_PROVIDER=huggingface  → 方案 B
//   EMBEDDING_PROVIDER=cloudflare   → 方案 C
//   EMBEDDING_PROVIDER=local        → 方案 D

async function getEmbedding(text) {
  const provider = process.env.EMBEDDING_PROVIDER || 'ollama';

  switch (provider) {
    case 'ollama':
      return getEmbeddingOllama(text);
    case 'huggingface':
      return getEmbeddingHuggingFace(text);
    case 'cloudflare':
      return getEmbeddingCloudflare(text);
    case 'local':
      return getEmbeddingTransformers(text);
    default:
      throw new Error(`未知的 EMBEDDING_PROVIDER: ${provider}`);
  }
}

module.exports = { getEmbedding };

