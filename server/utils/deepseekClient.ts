import { getEnvConfig } from '../config/env.ts';
import type { AiErrorCategory } from '../models/index.ts';

export interface DeepSeekChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekCompletionOptions {
  messages: DeepSeekChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  responseFormat?: 'json_object' | 'text';
  retryOnBlankJson?: boolean;
  signal?: AbortSignal;
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface DeepSeekUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface DeepSeekCompletionResult {
  content: string;
  model: string;
  usage: DeepSeekUsage;
  finishReason: string | null;
  durationMs: number;
}

export class DeepSeekClientError extends Error {
  code: string;
  httpStatus: number;
  category: AiErrorCategory;
  retryAfterSeconds?: number;

  constructor(
    message: string,
    code: string,
    httpStatus: number,
    category: AiErrorCategory,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'DeepSeekClientError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.category = category;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function redactSecret(text: string, secret: string): string {
  if (!text) return '';
  if (!secret) return text;
  return text.split(secret).join('[REDACTED]');
}

function parseUpstreamErrorMessage(rawBody: string, apiKey: string): string {
  if (!rawBody) return '';
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: { message?: unknown; type?: unknown; code?: unknown };
      message?: unknown;
    };
    const msg =
      typeof parsed?.error?.message === 'string'
        ? parsed.error.message
        : typeof parsed?.message === 'string'
          ? parsed.message
          : '';
    return redactSecret(msg, apiKey).slice(0, 300);
  } catch {
    return redactSecret(rawBody, apiKey).slice(0, 200);
  }
}

function validateBaseUrl(rawBaseUrl: string): string {
  const cleaned = rawBaseUrl.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new DeepSeekClientError(
      'DEEPSEEK_BASE_URL is not a valid URL.',
      'AI_CONFIG_INVALID',
      500,
      'upstream_error'
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new DeepSeekClientError(
      'DEEPSEEK_BASE_URL must use HTTPS.',
      'AI_CONFIG_INVALID',
      500,
      'upstream_error'
    );
  }

  return cleaned;
}

export async function createDeepSeekChatCompletion(
  options: DeepSeekCompletionOptions
): Promise<DeepSeekCompletionResult> {
  const env = getEnvConfig();
  const apiKey = (options.apiKey ?? env.deepseekApiKey).trim();
  const model = (options.model ?? env.deepseekModel).trim() || 'deepseek-chat';
  const baseUrl = validateBaseUrl(options.baseUrl ?? env.deepseekBaseUrl);
  const temperature =
    typeof options.temperature === 'number'
      ? Math.min(2.0, Math.max(0, options.temperature))
      : 0.75;
  const maxTokens =
    typeof options.maxTokens === 'number'
      ? Math.min(4000, Math.max(64, Math.round(options.maxTokens)))
      : 1200;
  const timeoutMs =
    typeof options.timeoutMs === 'number'
      ? Math.min(60000, Math.max(1000, options.timeoutMs))
      : env.deepseekTimeoutMs;

  if (!apiKey) {
    throw new DeepSeekClientError(
      'DeepSeek API key is not configured on the server. Set DEEPSEEK_API_KEY in environment secrets to enable AI email generation.',
      'AI_NOT_CONFIGURED',
      503,
      'missing_api_key'
    );
  }

  const fetchImpl = options.fetchFn ?? fetch;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => {
    controller.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      throw new DeepSeekClientError(
        'AI email generation was cancelled.',
        'AI_CANCELLED',
        499,
        'cancelled'
      );
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const startedAt = Date.now();
  const maxAttempts =
    options.responseFormat === 'json_object' && options.retryOnBlankJson !== false ? 2 : 1;

  try {
    let lastResult: DeepSeekCompletionResult | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const requestBody: Record<string, unknown> = {
        model,
        messages: options.messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      };

      if (options.responseFormat === 'json_object') {
        requestBody.response_format = { type: 'json_object' };
      }

      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        const rawErrorText = await response.text().catch(() => '');
        const upstreamMsg = parseUpstreamErrorMessage(rawErrorText, apiKey).toLowerCase();

        if (response.status === 401 || response.status === 403) {
          throw new DeepSeekClientError(
            'DeepSeek rejected the configured API key. Verify DEEPSEEK_API_KEY on the server.',
            'AI_INVALID_CREDENTIALS',
            502,
            'auth_error'
          );
        }

        if (response.status === 402) {
          throw new DeepSeekClientError(
            'DeepSeek API account has insufficient balance. Top up your DeepSeek balance to continue.',
            'AI_INSUFFICIENT_BALANCE',
            402,
            'insufficient_balance'
          );
        }

        if (response.status === 429) {
          const retryHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryHeader ? Number(retryHeader) || 15 : 15;
          throw new DeepSeekClientError(
            'DeepSeek API rate limit reached. Wait a moment before retrying.',
            'AI_RATE_LIMITED',
            429,
            'rate_limit',
            retryAfterSeconds
          );
        }

        if (
          response.status === 404 ||
          (response.status === 400 &&
            (upstreamMsg.includes('model') || upstreamMsg.includes('not exist')))
        ) {
          throw new DeepSeekClientError(
            `Configured DeepSeek model "${model}" is unavailable or unsupported.`,
            'AI_MODEL_UNAVAILABLE',
            502,
            'model_unavailable'
          );
        }

        if (response.status >= 500) {
          throw new DeepSeekClientError(
            'DeepSeek service is temporarily unavailable. Please try again shortly.',
            'AI_UPSTREAM_ERROR',
            502,
            'upstream_error'
          );
        }

        throw new DeepSeekClientError(
          'DeepSeek request could not be completed. Check your prompt inputs and try again.',
          'AI_REQUEST_FAILED',
          502,
          'upstream_error'
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new DeepSeekClientError(
          'DeepSeek returned an unreadable response.',
          'AI_MALFORMED_RESPONSE',
          502,
          'invalid_response'
        );
      }

      const data = json as {
        model?: unknown;
        choices?: Array<{
          message?: { content?: unknown };
          finish_reason?: unknown;
        }>;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
        };
      };

      const rawContent = data?.choices?.[0]?.message?.content;
      if (typeof rawContent !== 'string' || !rawContent.trim()) {
        if (attempt + 1 < maxAttempts && !controller.signal.aborted) {
          continue;
        }
        throw new DeepSeekClientError(
          'DeepSeek returned an empty completion. Try adjusting your instructions and regenerating.',
          'AI_MALFORMED_RESPONSE',
          502,
          'invalid_response'
        );
      }

      const usage: DeepSeekUsage = {
        promptTokens:
          typeof data?.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : null,
        completionTokens:
          typeof data?.usage?.completion_tokens === 'number'
            ? data.usage.completion_tokens
            : null,
        totalTokens:
          typeof data?.usage?.total_tokens === 'number' ? data.usage.total_tokens : null,
      };

      lastResult = {
        content: rawContent.trim(),
        model: typeof data?.model === 'string' && data.model.trim() ? data.model.trim() : model,
        usage,
        finishReason:
          typeof data?.choices?.[0]?.finish_reason === 'string'
            ? data.choices[0].finish_reason
            : null,
        durationMs,
      };
      break;
    }

    if (!lastResult) {
      throw new DeepSeekClientError(
        'DeepSeek returned an empty completion.',
        'AI_MALFORMED_RESPONSE',
        502,
        'invalid_response'
      );
    }

    return lastResult;
  } catch (err) {
    if (err instanceof DeepSeekClientError) {
      throw err;
    }

    if (timedOut) {
      throw new DeepSeekClientError(
        'DeepSeek API request timed out. Please try again.',
        'AI_TIMEOUT',
        504,
        'timeout'
      );
    }

    if (options.signal?.aborted) {
      throw new DeepSeekClientError(
        'AI email generation was cancelled.',
        'AI_CANCELLED',
        499,
        'cancelled'
      );
    }

    throw new DeepSeekClientError(
      'Unable to reach the DeepSeek API service.',
      'AI_UPSTREAM_ERROR',
      502,
      'upstream_error'
    );
  } finally {
    clearTimeout(timer);
    if (options.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export interface DeepSeekStatusResult {
  provider: 'deepseek';
  configured: boolean;
  available: boolean;
  model: string;
  baseUrl: string;
  status: 'ready' | 'configured' | 'missing_api_key' | 'invalid_credentials' | 'unreachable';
  message: string;
}

export async function getDeepSeekStatus(options?: {
  probe?: boolean;
  fetchFn?: typeof fetch;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<DeepSeekStatusResult> {
  const env = getEnvConfig();
  const apiKey = (options?.apiKey ?? env.deepseekApiKey).trim();
  const model = (options?.model ?? env.deepseekModel).trim() || 'deepseek-chat';
  const baseUrl = (options?.baseUrl ?? env.deepseekBaseUrl).trim().replace(/\/+$/, '');

  if (!apiKey) {
    return {
      provider: 'deepseek',
      configured: false,
      available: false,
      model,
      baseUrl,
      status: 'missing_api_key',
      message:
        'DEEPSEEK_API_KEY is not configured. Add it to your server secrets to enable AI email generation.',
    };
  }

  if (!options?.probe) {
    return {
      provider: 'deepseek',
      configured: true,
      available: true,
      model,
      baseUrl,
      status: 'configured',
      message: `DeepSeek is configured (model: ${model}).`,
    };
  }

  const fetchImpl = options?.fetchFn ?? fetch;
  try {
    const validatedUrl = validateBaseUrl(baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchImpl(`${validatedUrl}/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });

      if (res.status === 401 || res.status === 403) {
        return {
          provider: 'deepseek',
          configured: true,
          available: false,
          model,
          baseUrl,
          status: 'invalid_credentials',
          message: 'DeepSeek rejected the configured API key.',
        };
      }

      if (!res.ok) {
        return {
          provider: 'deepseek',
          configured: true,
          available: false,
          model,
          baseUrl,
          status: 'unreachable',
          message: `DeepSeek connectivity check returned HTTP ${res.status}.`,
        };
      }

      return {
        provider: 'deepseek',
        configured: true,
        available: true,
        model,
        baseUrl,
        status: 'ready',
        message: `DeepSeek API is reachable and authenticated (model: ${model}).`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return {
      provider: 'deepseek',
      configured: true,
      available: false,
      model,
      baseUrl,
      status: 'unreachable',
      message: 'Could not reach the DeepSeek API endpoint.',
    };
  }
}
