const assert = require("assert");
const { getSubtitleConfig } = require("../lib/config");
const { translateGroqBatch } = require("../lib/groq-translator");

describe("Groq translator", function () {
    const originalFetch = global.fetch;
    afterEach(function () {
        global.fetch = originalFetch;
    });

    it("calls the Groq OpenAI-compatible chat completions API with the selected model", async function () {
        const config = getSubtitleConfig({
            groqApiKey: "groq-secret",
            groqModel: "my-custom-model",
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

        const result = await translateGroqBatch(["Hallo", "Tschüss"], config);
        assert.deepEqual(result, ["你好", "再见"]);
        assert.equal(request.url, "https://api.groq.com/openai/v1/chat/completions");
        assert.equal(request.options.headers.Authorization, "Bearer groq-secret");
        assert.equal(request.body.model, "my-custom-model");
        assert.deepEqual(JSON.parse(request.body.messages[1].content).texts, ["Hallo", "Tschüss"]);
    });
});
