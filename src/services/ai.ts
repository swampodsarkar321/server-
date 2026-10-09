import { config } from '../config/env.js';

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface AiResult {
  ok: boolean;
  text: string;
  provider: string;
  model: string;
  inputChars: number;
  outputChars: number;
  latencyMs: number;
  error?: string;
  fallback?: boolean;
}

export interface AiProvider {
  name: string;
  generate(prompt: string, history: ChatMessage[], opts: { model: string; temperature: number; maxTokens: number; timeoutMs: number }): Promise<string>;
}

/** Primary provider: Google Gemini via REST generateContent (no SDK needed). */
export class GeminiProvider implements AiProvider {
  name = 'gemini';
  async generate(prompt: string, history: ChatMessage[], opts: { model: string; temperature: number; maxTokens: number; timeoutMs: number }): Promise<string> {
    const key = config.ai.geminiKey;
    if (!key) throw Object.assign(new Error('GEMINI_API_KEY is not configured'), { code: 'NO_KEY' });
    const model = opts.model || 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const contents = [
      ...history.slice(-config.ai.maxContext).map((m) => ({
        role: m.role === 'model' ? 'model' : 'user',
        parts: [{ text: m.text }],
      })),
      { role: 'user', parts: [{ text: prompt }] },
    ];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: 'You are a helpful customer-support assistant.' }] },
          contents,
          generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxTokens },
        }),
      });
      if (res.status === 429) throw Object.assign(new Error('Gemini rate limit exceeded (429). Try again shortly.'), { code: 'RATE_LIMIT', retryable: true });
      if (res.status === 400) {
        const t = await res.text().catch(() => '');
        throw Object.assign(new Error(`Gemini rejected the request (400). Check AI_MODEL name in AI Studio. ${t.slice(0, 200)}`), { code: 'BAD_REQUEST' });
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const err: any = new Error(`Gemini error ${res.status}: ${t.slice(0, 200)}`);
        err.code = 'PROVIDER_ERROR';
        err.retryable = res.status >= 500;
        throw err;
      }
      const data: any = await res.json();
      const text: string | undefined =
        data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('')?.trim();
      if (!text) throw Object.assign(new Error('Gemini returned an empty response'), { code: 'EMPTY', retryable: true });
      return text;
    } catch (e: any) {
      if (e?.name === 'AbortError') throw Object.assign(new Error('Gemini request timed out'), { code: 'TIMEOUT', retryable: true });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Optional future provider: Groq OpenAI-compatible chat completions. */
export class GroqProvider implements AiProvider {
  name = 'groq';
  async generate(prompt: string, history: ChatMessage[], opts: { model: string; temperature: number; maxTokens: number; timeoutMs: number }): Promise<string> {
    const key = config.ai.groqKey;
    if (!key) throw Object.assign(new Error('GROQ_API_KEY is not configured'), { code: 'NO_KEY' });
    const model = opts.model || 'llama-3.1-8b-instant';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            ...history.slice(-config.ai.maxContext).map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text })),
            { role: 'user', content: prompt },
          ],
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
        }),
      });
      if (res.status === 429) throw Object.assign(new Error('Groq rate limit exceeded'), { code: 'RATE_LIMIT', retryable: true });
      if (!res.ok) throw Object.assign(new Error(`Groq error ${res.status}`), { code: 'PROVIDER_ERROR', retryable: res.status >= 500 });
      const data: any = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) throw Object.assign(new Error('Groq returned an empty response'), { code: 'EMPTY', retryable: true });
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic local fallback — used when no key is set or as last-resort echo. */
export class EchoProvider implements AiProvider {
  name = 'echo';
  async generate(prompt: string): Promise<string> {
    return `Thanks for your message (“${prompt.slice(0, 120)}”). Our team will reply shortly. (Local fallback — configure GEMINI_API_KEY for full AI replies.)`;
  }
}

export function getProvider(name?: string): AiProvider {
  const n = (name ?? config.ai.provider).toLowerCase();
  if (n === 'groq') return new GroqProvider();
  if (n === 'echo') return new EchoProvider();
  return new GeminiProvider();
}

/**
 * Generate a reply with retries for transient failures + graceful fallback.
 * Never claims success when the provider failed (fallback flag is explicit).
 */
export async function generateReply(args: {
  systemPrompt: string;
  userText: string;
  history: ChatMessage[];
  fallbackMessage: string;
  providerName?: string;
  model?: string;
}): Promise<AiResult> {
  const provider = getProvider(args.providerName);
  const model = args.model || config.ai.model;
  const fullPrompt = `${args.systemPrompt}\n\nCustomer message: ${args.userText}`;
  const inputChars = fullPrompt.length + args.history.reduce((n, m) => n + m.text.length, 0);
  const t0 = Date.now();
  const maxAttempts = 3;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let text = await provider.generate(fullPrompt, args.history, {
        model,
        temperature: config.ai.temperature,
        maxTokens: config.ai.maxOutputTokens,
        timeoutMs: config.ai.timeoutMs,
      });
      text = text.trim().slice(0, 2000);
      return { ok: true, text, provider: provider.name, model, inputChars, outputChars: text.length, latencyMs: Date.now() - t0 };
    } catch (e: any) {
      lastErr = e;
      if (!e?.retryable && e?.code !== 'TIMEOUT') break;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  const msg = lastErr?.message ?? 'AI provider unavailable';
  const quota = /quota|429|exhaust|limit/i.test(msg);
  return {
    ok: false,
    text: args.fallbackMessage,
    provider: provider.name,
    model,
    inputChars,
    outputChars: args.fallbackMessage.length,
    latencyMs: Date.now() - t0,
    error: quota ? `AI quota/rate-limit reached: ${msg}` : msg,
    fallback: true,
  };
}
