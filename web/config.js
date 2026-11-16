const form = document.getElementById("configForm");
const source = document.getElementById("sourceLang");
const target = document.getElementById("targetLang");
const deeplApiKey = document.getElementById("deeplApiKey");
const deeplKeyField = document.getElementById("deeplKeyField");
const customApiBaseUrl = document.getElementById("customApiBaseUrl");
const customApiKey = document.getElementById("customApiKey");
const customModel = document.getElementById("customModel");
const customAiFields = document.getElementById("customAiFields");
const copyButton = document.getElementById("copyManifest");
const openStremioWebButton = document.getElementById("openStremioWeb");
const copyStatus = document.getElementById("copyStatus");

function manifestUrl() {
    const baseUrl = `${location.origin}/configure/${encodeURIComponent(source.value)}/${encodeURIComponent(target.value)}`;
    if (selectedProvider() === "deepl") {
        return `${baseUrl}/deepl/${encodeProviderKey(deeplApiKey.value.trim())}/manifest.json`;
    }
    if (selectedProvider() === "custom") {
        return `${baseUrl}/custom/${encodeProviderKey(customApiBaseUrl.value.trim())}/${encodeProviderKey(customApiKey.value.trim())}/${encodeProviderKey(customModel.value.trim())}/manifest.json`;
    }
    return `${baseUrl}/manifest.json`;
}

function stremioWebUrl() {
    return `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl())}`;
}

function updateView() {
    deeplKeyField.hidden = selectedProvider() !== "deepl";
    customAiFields.hidden = selectedProvider() !== "custom";
    copyStatus.textContent = "";
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validateConfig()) return;

    location.href = manifestUrl().replace(/^https?:\/\//, "stremio://");
});

copyButton.addEventListener("click", async () => {
    if (!validateConfig()) return;

    try {
        await copyText(manifestUrl());
        copyStatus.textContent = "Copied";
    } catch {
        copyStatus.textContent = "Copy failed";
    }
});

openStremioWebButton.addEventListener("click", () => {
    if (!validateConfig()) return;

    location.href = stremioWebUrl();
});

source.addEventListener("change", updateView);
target.addEventListener("change", updateView);
deeplApiKey.addEventListener("input", updateView);
customApiBaseUrl.addEventListener("input", updateView);
customApiKey.addEventListener("input", updateView);
customModel.addEventListener("input", updateView);
document.querySelectorAll("input[name='translationProvider']").forEach((input) => {
    input.addEventListener("change", updateView);
});
updateView();

function selectedProvider() {
    return document.querySelector("input[name='translationProvider']:checked").value;
}

function encodeProviderKey(value) {
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validateConfig() {
    if (source.value === target.value) {
        copyStatus.textContent = "Choose different source and target languages";
        return false;
    }

    if (selectedProvider() === "deepl" && !deeplApiKey.value.trim()) {
        copyStatus.textContent = "Enter DeepL API key";
        return false;
    }
    if (selectedProvider() === "custom") {
        if (!customApiBaseUrl.value.trim() || !customApiKey.value.trim() || !customModel.value.trim()) {
            copyStatus.textContent = "请填写 API 地址、API Key 和模型名称";
            return false;
        }
        try {
            const url = new URL(customApiBaseUrl.value.trim());
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
        } catch {
            copyStatus.textContent = "请输入有效的 API Base URL（http 或 https）";
            return false;
        }
    }

    return true;
}

async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
    }
}
