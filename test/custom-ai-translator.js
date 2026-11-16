const assert = require("assert");
const { getSubtitleConfig } = require("../lib/config");
const { normalizeChatCompletionsUrl, translateCustomAIBatch } = require("../lib/custom-ai-translator");

describe("OpenAI-compatible custom AI translator", function () {
    const originalFetch = global.fetch;
    afterEach(function () { global.fetch = originalFetch; });

    it("normalizes a Base URL and avoids duplicating the endpoint", function () {
        assert.equal(normalizeChatCompletionsUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
        assert.equal(normalizeChatCompletionsUrl("https://example.com/v1/chat/completions"), "https://example.com/v1/chat/completions");
    });

    it("calls the configured OpenAI-compatible endpoint with the chosen model", async function () {
        const config = getSubtitleConfig({
            customApiBaseUrl: "https://openrouter.ai/api/v1/",
            customApiKey: "custom-secret",
            customModel: "provider/model-name",
            translationProvider: "custom",
            sourceLang: "de",
            targetLang: "zh-CN",
        });
        let request;
        global.fetch = async (url, options) => {
            request = { url, options, body: JSON.parse(options.body) };
            return {
                ok: true,
                async json() {
                    return { choices: [{ message: { content: JSON.stringify({ translations: ["你好", "再见"] }) } }] };
                },
            };
        };

        const result = await translateCustomAIBatch(["Hallo", "Tschüss"], config);
        assert.deepEqual(result, ["你好", "再见"]);
        assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
        assert.equal(request.options.headers.Authorization, "Bearer custom-secret");
        assert.equal(request.body.model, "provider/model-name");
        assert.deepEqual(JSON.parse(request.body.messages[1].content).texts, ["Hallo", "Tschüss"]);
    });
});
