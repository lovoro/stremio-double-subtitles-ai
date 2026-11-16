const crypto = require("crypto");
const { Buffer } = require("buffer");
const { LRUCache } = require("lru-cache");
const { getSubtitleConfig } = require("./lib/config");
const { composeDiagnosticVtt, createDiagnosticSubtitleOption } = require("./lib/diagnostic-subtitle");
const { getCachedGeneratedSubtitle, setCachedGeneratedSubtitle } = require("./lib/generated-subtitle-cache");
const { fetchText } = require("./lib/http-client");
const { normalizeStremioLanguage } = require("./lib/languages");
const logger = require("./lib/logger");
const {
    recordGeneratedSubtitleCache,
    recordSubtitleCandidates,
    recordSubtitleLookup,
    recordSubtitleTranslation,
} = require("./lib/metrics");
const { getPublicBaseUrl } = require("./lib/public-url");
const { composeVtt, parseSubtitleCues } = require("./lib/subtitle-parser");
const { searchPublicStremioOpenSubtitles } = require("./lib/stremio-subtitles");
const { translateCues } = require("./lib/translator");
const { translationProvider } = require("./lib/translator");
const RESULT_LIMIT = Number(process.env.SUBTITLE_RESULT_LIMIT || 3);
const GENERATED_SUBTITLE_CACHE_CONTROL = "public, max-age=86400";
const DIAGNOSTIC_SUBTITLE_CACHE_CONTROL = "no-store";
const DEFAULT_JOB_MAX = 1000;
const DEFAULT_JOB_TTL_SECONDS = 24 * 60 * 60;
const JOB_MAX = DEFAULT_JOB_MAX;
const JOB_TTL_SECONDS = DEFAULT_JOB_TTL_SECONDS;
const jobs = new LRUCache({
    max: JOB_MAX,
    ttl: JOB_TTL_SECONDS * 1000,
    updateAgeOnGet: true,
});

async function getSubtitleOptions(args) {
    const config = getSubtitleConfig(args.config || (args.extra && args.extra.__config));
    logger.info("subtitle options requested", {
        id: args.id,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
        type: args.type,
    });

    try {
        const results = await searchPublicStremioOpenSubtitles(args);
        const sourceLanguageSubtitles = results.filter(
            (subtitle) => normalizeStremioLanguage(subtitle.lang) === config.stremioSourceLanguage,
        );
        recordSubtitleCandidates({
            count: results.length,
            sourceLanguage: config.sourceLanguage,
            stage: "upstream",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });
        recordSubtitleCandidates({
            count: sourceLanguageSubtitles.length,
            sourceLanguage: config.sourceLanguage,
            stage: "source_language",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });
        const subtitles = createSubtitleOptions(args, results, sourceLanguageSubtitles, config);
        recordSubtitleLookup({
            sourceLanguage: config.sourceLanguage,
            status: "success",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });

        logger.info("subtitle options resolved", {
            id: args.id,
            returnedCount: subtitles.length,
            sourceLanguageCount: sourceLanguageSubtitles.length,
            totalCount: results.length,
            topSubtitleIds: sourceLanguageSubtitles.slice(0, RESULT_LIMIT).map((subtitle) => subtitle.id),
        });
        return { subtitles };
    } catch (error) {
        logger.error("subtitle lookup failed", {
            error,
            id: args.id,
            type: args.type,
        });
        recordSubtitleLookup({
            sourceLanguage: config.sourceLanguage,
            status: "failure",
            targetLanguage: config.targetLanguage,
            type: args.type,
        });
        const subtitles = [
            createDiagnosticSubtitleOption({
                code: "lookup-failed",
                config,
                title: "Double Subtitles lookup failed",
                message: "Could not look up source subtitles for this video.",
            }),
        ];
        logger.info("subtitle options resolved", {
            diagnostic: true,
            id: args.id,
            returnedCount: subtitles.length,
            sourceLanguageCount: 0,
            totalCount: 0,
            topSubtitleIds: [],
        });
        return { subtitles };
    }
}

async function getGeneratedSubtitleResponse(key, variant = "default") {
    if (variant === "google" || variant === "ai") {
        return getCustomAiSubtitleResponse(key, variant);
    }

    const startedAt = process.hrtime.bigint();
    const cachedSubtitle = await getCachedGeneratedSubtitle(key);
    if (cachedSubtitle) {
        logger.debug("generated subtitle cache hit", { key, source: cachedSubtitle.source });
        recordGeneratedSubtitleCache(`${cachedSubtitle.source}_hit`);
        logGeneratedSubtitleServed({
            cacheSource: cachedSubtitle.source,
            key,
            source: "cache",
            startedAt,
            vtt: cachedSubtitle.vtt,
        });
        return generatedSubtitleResponse(cachedSubtitle.vtt);
    }

    const job = jobs.get(key);
    if (!job) {
        return diagnosticGeneratedSubtitleResponse({
            key,
            message: "Generated subtitle expired or was not found.",
            source: "missing",
            startedAt,
        });
    }

    const source = job.promise ? "joined" : "build";
    if (!job.promise) {
        logger.info("generated subtitle build queued", { key });
        recordGeneratedSubtitleCache("miss");
        job.promise = buildTranslatedVtt(job)
            .then((vtt) => setCachedGeneratedSubtitle(key, vtt).then(() => {
                if (jobs.get(key) === job) jobs.delete(key);
                return vtt;
            }))
            .then((vtt) => {
                logger.info("generated subtitle cached", { bytes: Buffer.byteLength(vtt, "utf8"), key });
                return vtt;
            })
            .catch((error) => {
                job.promise = null;
                logger.error("generated subtitle build failed", { error, key });
                throw error;
            });
    } else {
        logger.debug("generated subtitle build joined", { key });
        recordGeneratedSubtitleCache("joined");
    }

    try {
        const vtt = await job.promise;
        logGeneratedSubtitleServed({ key, source, startedAt, vtt });
        return generatedSubtitleResponse(vtt);
    } catch (error) {
        return diagnosticGeneratedSubtitleResponse({
            error,
            key,
            message: "Could not generate translated subtitles for this video.",
            source: "error",
            startedAt,
        });
    }
}

async function getCustomAiSubtitleResponse(key, variant) {
    const startedAt = process.hrtime.bigint();
    const cacheKey = `${key}:${variant}`;
    const cachedSubtitle = await getCachedGeneratedSubtitle(cacheKey);
    if (cachedSubtitle) {
        logGeneratedSubtitleServed({
            cacheSource: cachedSubtitle.source,
            key,
            source: `${variant}_cache`,
            startedAt,
            vtt: cachedSubtitle.vtt,
        });
        return generatedSubtitleResponse(cachedSubtitle.vtt);
    }

    const job = jobs.get(key);
    if (!job) {
        return diagnosticGeneratedSubtitleResponse({
            key,
            message: "Generated subtitle expired or was not found. Please select the subtitle again.",
            source: "missing",
            startedAt,
        });
    }

    try {
        if (variant === "google") {
            if (!job.googlePromise) {
                job.googlePromise = buildGoogleVtt(job)
                    .then(async (vtt) => {
                        await setCachedGeneratedSubtitle(cacheKey, vtt);
                        logger.info("Google-first subtitle ready", {
                            key,
                            bytes: Buffer.byteLength(vtt, "utf8"),
                        });
                        startBackgroundCustomAiTranslation(job);
                        return vtt;
                    })
                    .catch((error) => {
                        job.googlePromise = null;
                        throw error;
                    });
            }
            const vtt = await job.googlePromise;
            logGeneratedSubtitleServed({ key, source: "google_first", startedAt, vtt });
            return generatedSubtitleResponse(vtt);
        }

        const vtt = await ensureBackgroundCustomAiTranslation(job);
        logGeneratedSubtitleServed({ key, source: "custom_ai_ready", startedAt, vtt });
        return generatedSubtitleResponse(vtt);
    } catch (error) {
        return diagnosticGeneratedSubtitleResponse({
            error,
            key,
            message: variant === "google"
                ? "Could not generate the initial Google subtitles for this video."
                : "Custom AI subtitles are not available. Please try again later.",
            source: `${variant}_error`,
            startedAt,
        });
    }
}

function startBackgroundCustomAiTranslation(job) {
    if (job.aiPromise) return job.aiPromise;
    job.aiPromise = buildCustomAiVtt(job)
        .then(async (vtt) => {
            await setCachedGeneratedSubtitle(`${job.key}:ai`, vtt);
            logger.info("background Custom AI subtitle translation finished", {
                key: job.key,
                bytes: Buffer.byteLength(vtt, "utf8"),
            });
            return vtt;
        })
        .catch((error) => {
            job.aiPromise = null;
            logger.error("background Custom AI subtitle translation failed", {
                key: job.key,
                error,
            });
            return null;
        });
    return job.aiPromise;
}

async function ensureBackgroundCustomAiTranslation(job) {
    const cacheKey = `${job.key}:ai`;
    const cached = await getCachedGeneratedSubtitle(cacheKey);
    if (cached) return cached.vtt;

    if (!job.aiPromise) {
        // If the AI track is selected directly, start translation here as well.
        startBackgroundCustomAiTranslation(job);
    }
    const vtt = await job.aiPromise;
    if (!vtt) throw new Error("Custom AI background translation failed");
    return vtt;
}

async function getJobSourceCues(job) {
    if (!job.sourceCuesPromise) {
        job.sourceCuesPromise = (async () => {
            logger.info("source subtitle download started", {
                key: job.key,
                subtitleUrl: job.subtitleUrl,
            });
            const subtitleText = await fetchText(job.subtitleUrl);
            const cues = parseSubtitleCues(subtitleText);
            if (!cues.length) throw new Error(`No subtitle cues found for ${job.title}`);
            logger.info("source subtitle parsed", { key: job.key, cueCount: cues.length });
            return cues;
        })().catch((error) => {
            job.sourceCuesPromise = null;
            throw error;
        });
    }
    return job.sourceCuesPromise;
}

async function buildGoogleVtt(job) {
    const config = getSubtitleConfig(job.config);
    const cues = await getJobSourceCues(job);
    const googleConfig = { ...config, translationProvider: "googletrans" };
    const translations = await translateCues(cues, {
        ...googleConfig,
        __translationTaskId: `${job.key}:google`,
    });
    return composeVtt(cues, translations);
}

async function buildCustomAiVtt(job) {
    const config = getSubtitleConfig(job.config);
    const cues = await getJobSourceCues(job);
    logger.info("background Custom AI subtitle translation started", {
        key: job.key,
        cueCount: cues.length,
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
    });
    const translations = await translateCues(cues, {
        ...config,
        __translationTaskId: job.key,
    });
    return composeVtt(cues, translations);
}

function createSubtitleOptions(args, results, sourceLanguageSubtitles, config) {
    if (!results.length) {
        return [
            createDiagnosticSubtitleOption({
                code: "no-upstream-subtitles",
                config,
                title: "Double Subtitles notice",
                message: "OpenSubtitles did not return any subtitles for this video.",
            }),
        ];
    }

    if (!sourceLanguageSubtitles.length) {
        return [
            createDiagnosticSubtitleOption({
                code: "no-source-language-subtitles",
                config,
                title: "Double Subtitles notice",
                message: `No ${config.sourceLanguage} subtitles were found for this video.`,
            }),
        ];
    }

    return sourceLanguageSubtitles
        .slice(0, RESULT_LIMIT)
        .flatMap((subtitle) => createSubtitleOption(args, subtitle, config))
        .filter(Boolean);
}

function generatedSubtitleResponse(vtt) {
    return {
        cacheControl: GENERATED_SUBTITLE_CACHE_CONTROL,
        diagnostic: false,
        vtt,
    };
}

function diagnosticGeneratedSubtitleResponse({ error, key, message, source, startedAt }) {
    const vtt = composeDiagnosticVtt({
        title: "Double Subtitles error",
        message,
    });
    logGeneratedSubtitleServed({
        diagnostic: true,
        error,
        key,
        source,
        startedAt,
        vtt,
    });

    return {
        cacheControl: DIAGNOSTIC_SUBTITLE_CACHE_CONTROL,
        diagnostic: true,
        vtt,
    };
}

function logGeneratedSubtitleServed({ cacheSource, diagnostic, error, key, source, startedAt, vtt }) {
    logger.info("generated subtitle served", {
        bytes: Buffer.byteLength(vtt, "utf8"),
        cacheSource,
        diagnostic,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        error,
        key,
        source,
    });
}

function createSubtitleOption(args, subtitle, config) {
    const key = hashKey({
        type: args.type,
        id: args.id,
        sourceLanguage: config.stremioSourceLanguage,
        targetLanguage: config.stremioTargetLanguage,
        translationProvider: translationProvider(config),
        customApiBaseUrl: config.customApiBaseUrl,
        customModel: config.customModel,
        customApiKey: config.customApiKey,
        subtitleId: subtitle.id,
        subtitleUrl: subtitle.url,
    });

    if (!jobs.get(key)) {
        jobs.set(key, {
            key,
            config,
            subtitleUrl: subtitle.url,
            title: `OpenSubtitles v3 ${subtitle.id}`,
        });
    }

    const baseUrl = getPublicBaseUrl();
    if (["custom", "groq"].includes(translationProvider(config))) {
        return [
            {
                id: `opensubtitles-v3-${subtitle.id}-google-to-${config.stremioTargetLanguage}`,
                url: `${baseUrl}/generated-subtitles/${key}/google.vtt`,
                lang: config.stremioTargetLanguage,
                label: "Google (Instant)",
            },
            {
                id: `opensubtitles-v3-${subtitle.id}-custom-ai-to-${config.stremioTargetLanguage}`,
                url: `${baseUrl}/generated-subtitles/${key}/ai.vtt`,
                lang: config.stremioTargetLanguage,
                label: "Custom AI (Final)",
            },
        ];
    }

    return [{
        id: `opensubtitles-v3-${subtitle.id}-to-${config.stremioTargetLanguage}`,
        url: `${baseUrl}/generated-subtitles/${key}.vtt`,
        lang: config.stremioTargetLanguage,
    }];
}

async function buildTranslatedVtt(job) {
    const config = getSubtitleConfig(job.config);
    const startedAt = process.hrtime.bigint();
    logger.info("source subtitle download started", {
        key: job.key,
        subtitleUrl: job.subtitleUrl,
    });
    const subtitleText = await fetchText(job.subtitleUrl);

    const cues = parseSubtitleCues(subtitleText);

    if (!cues.length) {
        throw new Error(`No subtitle cues found for ${job.title}`);
    }

    logger.info("subtitle translation started", {
        cueCount: cues.length,
        key: job.key,
        sourceLanguage: config.googleSourceLanguage,
        targetLanguage: config.googleTargetLanguage,
        provider: translationProvider(config),
    });
    try {
        const translations = await translateCues(cues, { ...config, __translationTaskId: job.key });
        const vtt = composeVtt(cues, translations);
        recordSubtitleTranslation({
            bytes: Buffer.byteLength(vtt, "utf8"),
            durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            sourceLanguage: config.sourceLanguage,
            status: "success",
            targetLanguage: config.targetLanguage,
        });
        logger.info("subtitle translation finished", {
            cueCount: cues.length,
            key: job.key,
        });
        return vtt;
    } catch (error) {
        recordSubtitleTranslation({
            bytes: 0,
            durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
            sourceLanguage: config.sourceLanguage,
            status: "failure",
            targetLanguage: config.targetLanguage,
        });
        throw error;
    }
}

function hashKey(value) {
    return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

module.exports = {
    getGeneratedSubtitleResponse,
    getSubtitleOptions,
};
