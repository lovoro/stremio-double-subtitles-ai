const { fetchWithTimeout } = require("./http-client");

// Generic OpenAI-compatible Chat Completions translator.
function normalizeChatCompletionsUrl(baseUrl) {
    const value = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!value) throw new Error("Custom AI API address is required");
    if (/\/chat\/completions$/i.test(value)) return value;
    return `${value}/chat/completions`;
}

async function translateCustomAIBatch(texts, config) {
    const apiKey = config.customApiKey || process.env.CUSTOM_AI_API_KEY;
    if (!apiKey) throw new Error("Custom AI API Key is required");

    const baseUrl = config.customApiBaseUrl || process.env.CUSTOM_AI_BASE_URL || "";
    const model = config.customModel || process.env.CUSTOM_AI_MODEL || "";
    const response = await fetchWithTimeout(normalizeChatCompletionsUrl(baseUrl), {
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
                    content: "You are a professional subtitle translator. Translate every item from the source language to the target language. Preserve meaning, tone, names, punctuation and subtitle-friendly brevity. Do not explain or add notes. Return only a valid JSON object with a translations array containing exactly one translated string for each input item, in the same order.",
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
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error?.message || `${response.status} ${response.statusText}`);

    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("Custom AI response did not include a translation");
    let parsed;
    try {
        parsed = JSON.parse(String(content).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
    } catch {
        throw new Error("Custom AI returned invalid JSON; choose a model that follows the JSON output instruction");
    }
    if (!Array.isArray(parsed.translations) || parsed.translations.length !== texts.length) {
        throw new Error("Custom AI response did not include the expected number of translations");
    }
    return parsed.translations.map((value) => String(value ?? ""));
}

module.exports = { normalizeChatCompletionsUrl, translateCustomAIBatch };
