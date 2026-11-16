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
    const batches = [];
    let batch = { texts: [], indexes: [], chars: 0 };

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

        if (batch.texts.length >= limits.texts || batch.chars + text.length > limits.chars) {
            if (batch.texts.length) batches.push(batch);
            batch = { texts: [], indexes: [], chars: 0 };
        }

        batch.texts.push(text);
        batch.indexes.push(index);
        batch.chars += text.length;
    }
    if (batch.texts.length) batches.push(batch);

    let nextBatchIndex = 0;
    async function processBatches() {
        while (nextBatchIndex < batches.length) {
            const currentIndex = nextBatchIndex++;
            const current = batches[currentIndex];
            const batchNumber = currentIndex + 1;
            const batchContext = {
                taskId: config.__translationTaskId,
                batchNumber,
                textCount: current.texts.length,
                characterCount: current.chars,
            };
            if (isCustomAI) logger.info("custom AI batch started", batchContext);

            const result = await translateBatch(current.texts, config, batchContext);
            if (isCustomAI) {
                logger.info(result.__customAiFallback ? "custom AI batch fallback finished" : "custom AI batch finished", {
                    ...batchContext,
                    translatedCount: result.length,
                    fallbackProvider: result.__customAiFallback ? "google" : undefined,
                });
            }

            result.forEach((text, index) => {
                const cleaned = cleanTranslatedText(text);
                translated[current.indexes[index]] = cleaned;
                if (isCustomAI && !result.__customAiFallback && cleaned) {
                    customTranslationCache.set(customAiTextCacheKey(cacheScope, current.texts[index]), cleaned);
                }
            });
        }
    }

    // Two concurrent Custom AI batches reduce long-video wait time while keeping
    // Google and DeepL behavior unchanged.
    const concurrency = isCustomAI ? Math.min(2, batches.length) : 1;
    await Promise.all(Array.from({ length: concurrency }, () => processBatches()));
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
            logger.warn("custom AI cooling down; using Google fallback", {
                ...context,
                cooldownRemainingMs: restUntil - Date.now(),
            });
            return translateGoogleFallback(texts, config, context);
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
            logger.warn("custom AI batch failed; falling back to Google", {
                ...context,
                error: error.message,
                fallbackProvider: "google",
            });
            return translateGoogleFallback(texts, config, context);
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

async function translateGoogleFallback(texts, config, context = {}) {
    try {
        let translations;
        try {
            const result = await withRetries(() =>
                googleTranslate(texts, {
                    from: config.googleSourceLanguage,
                    to: config.googleTargetLanguage,
                }),
            );
            translations = result.textArray || [result.text];
        } catch (batchError) {
            if (texts.length === 1) throw batchError;
            translations = [];
            for (const text of texts) {
                const result = await withRetries(() =>
                    googleTranslate(text, {
                        from: config.googleSourceLanguage,
                        to: config.googleTargetLanguage,
                    }),
                );
                translations.push(result.text);
            }
        }

        if (translations.length !== texts.length || translations.some((item) => !String(item || "").trim())) {
            throw new Error(`Google fallback returned ${translations.length} translations for ${texts.length} texts`);
        }
        translations.__customAiFallback = true;
        logger.info("custom AI Google fallback succeeded", {
            ...context,
            translatedCount: translations.length,
        });
        return translations;
    } catch (error) {
        logger.error("custom AI Google fallback failed", {
            ...context,
            error: error.message,
            fallbackProvider: "google",
        });
        throw new Error(`Custom AI translation failed and Google fallback also failed: ${error.message}`);
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
