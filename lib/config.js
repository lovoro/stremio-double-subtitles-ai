const {
    normalizeDeepLSourceLanguage,
    normalizeDeepLTargetLanguage,
    normalizeGoogleLanguage,
    normalizeStremioLanguage,
} = require("./languages");
const { Buffer } = require("buffer");

function getSubtitleConfig(config = {}) {
    const sourceLanguage = config.sourceLang || config.sourceLanguage || "de";
    const targetLanguage = config.targetLang || config.targetLanguage || "en";
    const deeplApiKey = config.deeplApiKey;
    const customApiBaseUrl = config.customApiBaseUrl || config.apiBaseUrl || "";
    const customApiKey = config.customApiKey || config.apiKey || config.groqApiKey || "";
    const customModel = config.customModel || config.model || config.groqModel || "";
    const groqApiKey = config.groqApiKey;
    const groqModel = config.groqModel || "llama-3.3-70b-versatile";
    const translationProvider = config.translationProvider;
    return {
        deeplApiKey,
        groqApiKey,
        groqModel,
        customApiBaseUrl,
        customApiKey,
        customModel,
        sourceLanguage,
        targetLanguage,
        translationProvider,
        deeplSourceLanguage: normalizeDeepLSourceLanguage(sourceLanguage),
        deeplTargetLanguage: normalizeDeepLTargetLanguage(targetLanguage),
        stremioSourceLanguage: normalizeStremioLanguage(sourceLanguage),
        stremioTargetLanguage: normalizeStremioLanguage(targetLanguage),
        googleSourceLanguage: normalizeGoogleLanguage(sourceLanguage),
        googleTargetLanguage: normalizeGoogleLanguage(targetLanguage),
    };
}

function parseConfigPrefix(parts) {
    if (parts[0] !== "configure" || !parts[1] || !parts[2]) return null;

    return {
        deeplApiKey: parts[3] === "deepl" && parts[4] ? decodeProviderKey(parts[4]) : "",
        groqApiKey: parts[3] === "groq" && parts[4] ? decodeProviderKey(parts[4]) : "",
        customApiBaseUrl: parts[3] === "custom" && parts[4] ? decodeProviderKey(parts[4]) : "",
        customApiKey: parts[3] === "custom" && parts[5] ? decodeProviderKey(parts[5]) : "",
        customModel: parts[3] === "custom" && parts[6] ? decodeProviderKey(parts[6]) : "",
        groqModel: parts[3] === "groq" && parts[5] ? decodeProviderKey(parts[5]) : "llama-3.3-70b-versatile",
        sourceLang: decodeURIComponent(parts[1]),
        targetLang: decodeURIComponent(parts[2]),
        translationProvider: parts[3] === "groq" ? "custom" : parts[3] ? decodeURIComponent(parts[3]) : "googletrans",
    };
}

function decodeProviderKey(value) {
    return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

module.exports = {
    getSubtitleConfig,
    parseConfigPrefix,
};
