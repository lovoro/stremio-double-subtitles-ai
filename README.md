# Stremio Double Subtitles

Fetches subtitles from the public Stremio OpenSubtitles v3 addon, translates them with `googletrans`, DeepL, or a custom Groq-hosted LLM model, merges them together and serves generated WebVTT subtitles to Stremio. Google Translate remains the default and requires no credentials.

![Screenshot of web interface](img/screenshot.webp "Stremio with double subtitles")

## Setup

Install dependencies:

```bash
pnpm install
```

## Run

```bash
pnpm start
```

Open the local web interface and choose the source and target languages:

```text
http://127.0.0.1:53100/
```

Install it on Stremio using instructions from the web interface.

The generated subtitle is one double subtitle: source language on top, translated language on the bottom.

### Groq / custom LLM

Select **Groq (自定义大模型)** in the configuration page, enter your Groq API key and the model ID you want to use. The API endpoint is `https://api.groq.com/openai/v1` (Chat Completions). The model ID is configurable, so you can choose any model currently available to your Groq account. Google Translate remains unchanged and is still the default option.

You can also configure the server with `GROQ_API_KEY` and `GROQ_MODEL`; the web form's key/model are used when installing a configured addon.

### Docker

```bash
docker run -p 53100:53100 ghcr.io/awerks/stremio-double-subtitles:latest
```

then open the local web interface
