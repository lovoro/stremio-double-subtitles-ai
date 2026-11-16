const crypto = require("crypto");
const { LRUCache } = require("lru-cache");
const googleTranslate = require("googletrans").default;
const logger = require("./logger");
const { translateDeepLBatch } = require("./deepl-translator");
const { translateCustomAIBatch } = require("./custom-ai-translator");
const { cueTextForTranslation } = require("./subtitle-parser");

const BATCH_LIMITS = {
    deepl: {
        chars: 100000,
        texts: 50,
    },
    googletrans: {
        chars: 10000,
        texts: 50,
    },
    custom: {
        chars: 6000,
        texts: 60,
    },
};

const BATCH_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const CUSTOM_AI_FAILURE_REST_MS = 30_000;
const customAiFailureRest = new Map();
const customTranslationCache = new LRUCache({
    max: 50000,
    ttl: 24 * 60 * 60 * 1000,
    updateAgeOnGet: false,
});

async function translateCues(cues, config) {
    const translated = new Array(cues.length).fill("");
    const limits = batchLimits(config);
    const isCustomAI = ["custom", "groq"].includes(translationProvider(config));
    const cacheScope = isCustomAI ? customAiCacheScope(config) : "";
    let batch = [];
    let batchIndexes = [];
    let batchChars = 0;
    let batchNumber = 0;

    async function flushBatch() {
        if (!batch.length) return;

        batchNumber += 1;
        const batchContext = { taskId: config.__translationTaskId, batchNumber, textCount: batch.length, characterCount: batchChars };
        if (["custom", "groq"].includes(translationProvider(config))) {
            logger.info("custom AI batch started", batchContext);
        }
        const result = await translateBatch(batch, config, batchContext);
        if (isCustomAI) {
            logger.info("custom AI batch finished", { ...batchContext, translatedCount: result.length });
        }
        result.forEach((text, index) => {
            const cleaned = cleanTranslatedText(text);
            translated[batchIndexes[index]] = cleaned;
            if (isCustomAI && cleaned) {
                customTranslationCache.set(customAiTextCacheKey(cacheScope, batch[index]), cleaned);
            }
        });

        batch = [];
        batchIndexes = [];
        batchChars = 0;
    }

    for (let index = 0; index < cues.length; index += 1) {
        const text = cueTextForTranslation(cues[index]);
        if (!text) continue;

        if (isCustomAI) {
            const cached = customTranslationCache.get(customAiTextCacheKey(cacheScope, text));
            if (cached !== undefined) {
                translated[index] = cached;
                continue;
            }
        }

        if (batch.length >= limits.texts || batchChars + text.length > limits.chars) {
            await flushBatch();
        }

        batch.push(text);
        batchIndexes.push(index);
        batchChars += text.length;
    }

    await flushBatch();
    return translated;
}

function batchLimits(config) {
    return BATCH_LIMITS[translationProvider(config)] || BATCH_LIMITS.googletrans;
}

async function translateBatch(texts, config, context = {}) {
    if (translationProvider(config) === "deepl") {
        return withRetries(() => translateDeepLBatch(texts, config));
    }
    if (["custom", "groq"].includes(translationProvider(config))) {
        const scope = customAiCacheScope(config);
        const restUntil = customAiFailureRest.get(scope) || 0;
        if (restUntil > Date.now()) {
            const error = new Error("Custom AI is resting after a failed request. Please retry in a moment.");
            error.name = "CustomAIBackoffError";
            throw error;
        }

        try {
            // A timed-out request may already have been billed by the provider.
            // Do not immediately send the same batch up to two more times.
            const result = await withRetries(
                (attempt) => translateCustomAIBatch(texts, config, { ...context, attempt }),
                {
                    retries: 1,
                    onAttemptError: (error, attempt) => logger.warn("custom AI request attempt failed", {
                        ...context,
                        attempt,
                        error: error.message,
                    }),
                },
            );
            customAiFailureRest.delete(scope);
            return result;
        } catch (error) {
            customAiFailureRest.set(scope, Date.now() + CUSTOM_AI_FAILURE_REST_MS);
            throw error;
        }
    }

    try {
        const result = await withRetries(() =>
            googleTranslate(texts, {
                from: config.googleSourceLanguage,
                to: config.googleTargetLanguage,
            }),
        );
        return result.textArray || [result.text];
    } catch (error) {
        if (texts.length === 1) throw error;

        const translated = [];
        for (const text of texts) {
            const result = await withRetries(() =>
                googleTranslate(text, {
                    from: config.googleSourceLanguage,
                    to: config.googleTargetLanguage,
                }),
            );
            translated.push(result.text);
        }
        return translated;
    }
}

async function withRetries(run, { retries = BATCH_RETRIES, onAttemptError } = {}) {
    let lastError;

    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            return await run(attempt + 1);
        } catch (error) {
            lastError = error;
            if (onAttemptError) onAttemptError(error, attempt + 1);
            if (attempt < retries - 1) await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 100);
        }
    }

    throw lastError;
}

function customAiCacheScope(config) {
    return crypto.createHash("sha256").update(JSON.stringify({
        apiKey: config.customApiKey || process.env.CUSTOM_AI_API_KEY || "",
        baseUrl: config.customApiBaseUrl || process.env.CUSTOM_AI_BASE_URL || "",
        model: config.customModel || process.env.CUSTOM_AI_MODEL || "",
        sourceLanguage: config.sourceLanguage || "",
        targetLanguage: config.targetLanguage || "",
    })).digest("hex");
}

function customAiTextCacheKey(scope, text) {
    return crypto.createHash("sha256").update(scope).update("\\0").update(String(text)).digest("hex");
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function translationProvider(config = {}) {
    const provider = String(config.translationProvider || "googletrans").trim().toLowerCase();
    return provider || "googletrans";
}

function cleanTranslatedText(text) {
    return String(text || "")
        .replace(/[ \t]+/g, " ")
        .trim();
}

module.exports = {
    batchLimits,
    translateCues,
    translationProvider,
};
