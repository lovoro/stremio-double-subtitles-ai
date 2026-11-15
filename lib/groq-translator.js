const { fetchWithTimeout } = require("./http-client");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

async function translateGroqBatch(texts, config) {
    const apiKey = config.groqApiKey || process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("Groq API key is required when using the Groq translation provider");

    const model = config.groqModel || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
    const response = await fetchWithTimeout(GROQ_API_URL, {
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
    if (!response.ok) {
        throw new Error(json.error?.message || `${response.status} ${response.statusText}`);
    }

    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq response did not include a translation");
    let parsed;
    try {
        parsed = JSON.parse(content.replace(/^```(?:json)?\\s*/i, "").replace(/\\s*```$/, "").trim());
    } catch {
        throw new Error("Groq returned invalid JSON; choose a model that follows the JSON output instruction");
    }
    if (!Array.isArray(parsed.translations) || parsed.translations.length !== texts.length) {
        throw new Error("Groq response did not include the expected number of translations");
    }
    return parsed.translations.map((value) => String(value ?? ""));
}

module.exports = { GROQ_API_URL, translateGroqBatch };
