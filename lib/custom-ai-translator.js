const { fetchWithTimeout } = require("./http-client");
const logger = require("./logger");

// Generic OpenAI-compatible Chat Completions translator.
function normalizeChatCompletionsUrl(baseUrl) {
    const value = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!value) throw new Error("Custom AI API address is required");
    if (/\/chat\/completions$/i.test(value)) return value;
    return `${value}/chat/completions`;
}

function extractMessageContent(message) {
    const content = message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                return "";
            })
            .filter(Boolean)
            .join("\n")
            .trim();
    }
    return "";
}

function parseTranslations(content, expectedCount) {
    const cleaned = String(content || "")
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();

    const candidates = [cleaned];
    const objectStart = cleaned.indexOf("{");
    const objectEnd = cleaned.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
        candidates.push(cleaned.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
        candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const values = Array.isArray(parsed)
                ? parsed
                : parsed && Array.isArray(parsed.translations)
                    ? parsed.translations
                    : null;
            if (values && values.length === expectedCount) {
                return values.map((value) => String(value ?? ""));
            }
        } catch {
            // Try the next possible JSON segment.
        }
    }

    // Some compatible models ignore the JSON instruction for a one-line batch.
    // Accept plain text only for a single subtitle to avoid misaligning batches.
    if (expectedCount === 1 && cleaned && !cleaned.startsWith("{") && !cleaned.startsWith("[")) {
        return [cleaned];
    }

    throw new Error("Custom AI response did not contain the expected number of translations");
}

async function translateCustomAIBatch(texts, config, context = {}) {
    const apiKey = config.customApiKey || process.env.CUSTOM_AI_API_KEY;
    if (!apiKey) throw new Error("Custom AI API Key is required");

    const baseUrl = config.customApiBaseUrl || process.env.CUSTOM_AI_BASE_URL || "";
    const model = config.customModel || process.env.CUSTOM_AI_MODEL || "";
    const startedAt = process.hrtime.bigint();
    let response;
    try {
        response = await fetchWithTimeout(normalizeChatCompletionsUrl(baseUrl), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
                {
                    role: "system",
                    content: "You are a professional subtitle translator. Translate every item from the source language to the target language. Preserve meaning, tone, names, punctuation and subtitle-friendly brevity. Do not explain or add notes. Return only a JSON object with a translations array containing exactly one translated string for each input item, in the same order.",
                },
                {
                    role: "user",
                    content: JSON.stringify({
                        source_language: config.sourceLanguage,
                        target_language: config.targetLanguage,
                        texts,
                    }),
                },
            ],
        }),
        });
    } catch (error) {
        logger.warn("custom AI HTTP request failed", {
            ...context,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            textCount: texts.length,
            characterCount: texts.reduce((sum, text) => sum + String(text).length, 0),
            error: error.message,
        });
        throw error;
    }

    logger.info("custom AI HTTP response", {
        ...context,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        statusCode: response.status,
        ok: response.ok,
        textCount: texts.length,
        characterCount: texts.reduce((sum, text) => sum + String(text).length, 0),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(json.error?.message || json.message || `${response.status} ${response.statusText}`);
    }

    const content = extractMessageContent(json.choices?.[0]?.message);
    if (!content) {
        const reason = json.choices?.[0]?.finish_reason;
        throw new Error(reason
            ? `Custom AI returned no translation (finish reason: ${reason})`
            : "Custom AI response did not include a translation");
    }

    return parseTranslations(content, texts.length);
}

module.exports = { normalizeChatCompletionsUrl, translateCustomAIBatch };
