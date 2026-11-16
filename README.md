# Stremio Double Subtitles

Fetches subtitles from the public Stremio OpenSubtitles v3 addon, translates them with `googletrans`, DeepL, or any OpenAI-compatible Chat Completions model, merges them together and serves generated WebVTT subtitles to Stremio. Google Translate remains the default and requires no credentials.

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

### Custom AI / OpenAI-compatible API

Choose **Custom AI** and enter the API Base URL, API Key, and Model ID. The addon appends `/chat/completions` automatically (or uses the endpoint as-is if that suffix is already present). Use any service that supports the OpenAI-compatible Chat Completions format. Google Translate and DeepL remain available with their original configuration flows.

Server environment variables are `CUSTOM_AI_BASE_URL`, `CUSTOM_AI_API_KEY`, and `CUSTOM_AI_MODEL`. 
