import { execFile } from "node:child_process";
import { CommanderError } from "commander";
import { type CacheState } from "../cache.js";
import type { ExecFileFn } from "../markitdown.js";
import type { FixedModelSpec } from "../model-spec.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
import { createCacheStateFromConfig } from "./cache-state.js";
import {
  handleDaemonCliRequest,
  handleHelpRequest,
  handleRefreshFreeRequest,
} from "./cli-preflight.js";
import { parseCliProviderArg } from "./env.js";
import { handleFileInput, isTranscribableExtension, withUrlAsset } from "./flows/asset/input.js";
import { summarizeMediaFile as summarizeMediaFileImpl } from "./flows/asset/media.js";
import { runUrlFlow } from "./flows/url/flow.js";
import { attachRichHelp, buildProgram } from "./help.js";
import { createMediaCacheFromConfig } from "./media-cache-state.js";
import { createProgressGate } from "./progress.js";
import { resolveRunContextState } from "./run-context.js";
import { resolveRunInput } from "./run-input.js";
import { createRunMetrics } from "./run-metrics.js";
import { resolveModelSelection } from "./run-models.js";
import { resolveDesiredOutputTokens } from "./run-output.js";
import { resolveStreamSettings } from "./run-stream.js";
import { createRunnerFlowContexts } from "./runner-contexts.js";
import { executeRunnerInput } from "./runner-execution.js";
import { resolveRunnerFlags } from "./runner-flags.js";
import {
  applyWidthOverride,
  handleCacheUtilityFlags,
  handleVersionFlag,
  prepareRunEnvironment,
  resolvePromptOverride,
} from "./runner-setup.js";
import { resolveRunnerSlidesSettings } from "./runner-slides.js";
import { handleSlidesCliRequest } from "./slides-cli.js";
import { createSummaryEngine } from "./summary-engine.js";
import { isRichTty, supportsColor } from "./terminal.js";
import { handleTranscriberCliRequest } from "./transcriber-cli.js";

type RunEnv = {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  execFile?: ExecFileFn;
  stdin?: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export async function runCli(
  argv: string[],
  { env: inputEnv, fetch, execFile: execFileOverride, stdin, stdout, stderr }: RunEnv,
): Promise<void> {
  (globalThis as unknown as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

  const { normalizedArgv, envForRun } = prepareRunEnvironment(argv, inputEnv);
  const env = envForRun;

  if (handleHelpRequest({ normalizedArgv, envForRun, stdout, stderr })) {
    return;
  }
  if (
    await handleRefreshFreeRequest({
      normalizedArgv,
      envForRun,
      fetchImpl: fetch,
      stdout,
      stderr,
    })
  ) {
    return;
  }
  if (
    await handleDaemonCliRequest({
      normalizedArgv,
      envForRun,
      fetchImpl: fetch,
      stdout,
      stderr,
    })
  ) {
    return;
  }
  if (
    await handleSlidesCliRequest({
      normalizedArgv,
      envForRun,
      fetchImpl: fetch,
      stdout,
      stderr,
    })
  ) {
    return;
  }
  if (
    await handleTranscriberCliRequest({
      normalizedArgv,
      envForRun,
      stdout,
      stderr,
    })
  ) {
    return;
  }
  const execFileImpl = execFileOverride ?? execFile;
  const program = buildProgram();
  program.configureOutput({
    writeOut(str) {
      stdout.write(str);
    },
    writeErr(str) {
      stderr.write(str);
    },
  });
  program.exitOverride();
  attachRichHelp(program, envForRun, stdout);

  try {
    program.parse(normalizedArgv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return;
    }
    throw error;
  }

  if (handleVersionFlag({ versionRequested: Boolean(program.opts().version), stdout })) {
    return;
  }

  applyWidthOverride({ width: program.opts().width, env });

  let promptOverride = await resolvePromptOverride({
    prompt: program.opts().prompt,
    promptFile: program.opts().promptFile,
  });

  if (
    await handleCacheUtilityFlags({
      normalizedArgv,
      envForRun,
      stdout,
    })
  ) {
    return;
  }

  const cliFlagPresent = normalizedArgv.some((arg) => arg === "--cli" || arg.startsWith("--cli="));
  let cliProviderArgRaw = typeof program.opts().cli === "string" ? program.opts().cli : null;
  const inputResolution = resolveRunInput({
    program,
    cliFlagPresent,
    cliProviderArgRaw,
    stdout,
  });
  cliProviderArgRaw = inputResolution.cliProviderArgRaw;
  const inputTarget = inputResolution.inputTarget;
  const url = inputResolution.url;

  const runStartedAtMs = Date.now();
  const {
    videoModeExplicitlySet,
    lengthExplicitlySet,
    languageExplicitlySet,
    noCacheFlag,
    noMediaCacheFlag,
    extractMode,
    json,
    forceSummary,
    slidesDebug,
    streamMode,
    plain,
    debug,
    verbose,
    transcriber,
    maxExtractCharacters,
    isYoutubeUrl,
    format,
    youtubeMode,
    lengthArg,
    maxOutputTokensArg,
    timeoutMs,
    retries,
    preprocessMode,
    requestedFirecrawlMode,
    markdownMode,
    metricsEnabled,
    metricsDetailed,
    shouldComputeReport,
    markdownModeExplicitlySet,
  } = resolveRunnerFlags({
    normalizedArgv,
    programOpts: program.opts() as Record<string, unknown>,
    envForRun,
    url: inputTarget.kind === "url" ? inputTarget.url : url,
  });

  if (extractMode && lengthExplicitlySet && !json && isRichTty(stderr)) {
    stderr.write("Warning: --length is ignored with --extract (no summary is generated).\n");
  }
  const modelArg =
    typeof program.opts().model === "string" ? (program.opts().model as string) : null;
  const cliProviderArg =
    typeof cliProviderArgRaw === "string" && cliProviderArgRaw.trim().length > 0
      ? parseCliProviderArg(cliProviderArgRaw)
      : null;
  if (cliFlagPresent && modelArg) {
    throw new Error("Use either --model or --cli (not both).");
  }
  const explicitModelArg = cliProviderArg
    ? `cli/${cliProviderArg}`
    : cliFlagPresent
      ? "auto"
      : modelArg;

  const {
    config,
    configPath,
    outputLanguage,
    openaiWhisperUsdPerMinute,
    videoMode,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
    configModelLabel,
    apiKey,
    openrouterApiKey,
    openrouterConfigured,
    groqApiKey,
    assemblyaiApiKey,
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    nvidiaApiKey,
    nvidiaBaseUrl,
    providerBaseUrls,
    firecrawlApiKey,
    firecrawlConfigured,
    googleConfigured,
    anthropicConfigured,
    apifyToken,
    ytDlpPath,
    ytDlpCookiesFromBrowser,
    falApiKey,
    cliAvailability,
    envForAuto,
  } = resolveRunContextState({
    env,
    envForRun,
    programOpts: program.opts() as Record<string, unknown>,
    languageExplicitlySet,
    videoModeExplicitlySet,
    cliFlagPresent,
    cliProviderArg,
  });
  const themeName = resolveThemeNameFromSources({
    cli: (program.opts() as { theme?: unknown }).theme,
    env: envForRun.SUMMARIZE_THEME,
    config: config?.ui?.theme,
  });
  (envForRun as Record<string, string | undefined>).SUMMARIZE_THEME = themeName;
  if (!promptOverride && typeof config?.prompt === "string" && config.prompt.trim().length > 0) {
    promptOverride = config.prompt.trim();
  }

  const slidesSettings = resolveRunnerSlidesSettings({
    normalizedArgv,
    programOpts: program.opts() as Record<string, unknown>,
    config,
    inputKind: inputTarget.kind,
  });
  const transcriptTimestamps = Boolean(program.opts().timestamps) || Boolean(slidesSettings);

  const lengthInstruction =
    promptOverride && lengthExplicitlySet && lengthArg.kind === "chars"
      ? `Output is ${lengthArg.maxCharacters.toLocaleString()} characters.`
      : null;
  const languageInstruction =
    promptOverride && languageExplicitlySet && outputLanguage.kind === "fixed"
      ? `Output should be ${outputLanguage.label}.`
      : null;

  const transcriptNamespace = `yt:${youtubeMode}`;
  const cacheState: CacheState = await createCacheStateFromConfig({
    envForRun,
    config,
    noCacheFlag: false,
    transcriptNamespace,
  });
  const mediaCache = await createMediaCacheFromConfig({
    envForRun,
    config,
    noMediaCacheFlag,
  });

  try {
    if (markdownModeExplicitlySet && format !== "markdown") {
      throw new Error("--markdown-mode is only supported with --format md");
    }
    if (
      markdownModeExplicitlySet &&
      inputTarget.kind !== "url" &&
      inputTarget.kind !== "file" &&
      inputTarget.kind !== "stdin"
    ) {
      throw new Error("--markdown-mode is only supported for URL, file, or stdin inputs");
    }
    if (
      markdownModeExplicitlySet &&
      (inputTarget.kind === "file" || inputTarget.kind === "stdin") &&
      markdownMode !== "llm"
    ) {
      throw new Error(
        "Only --markdown-mode llm is supported for file/stdin inputs; other modes require a URL",
      );
    }
    const metrics = createRunMetrics({
      env,
      fetchImpl: fetch,
      maxOutputTokensArg,
    });
    const {
      llmCalls,
      trackedFetch,
      buildReport,
      estimateCostUsd,
      getLiteLlmCatalog,
      resolveMaxOutputTokensForCall,
      resolveMaxInputTokensForCall,
      setTranscriptionCost,
    } = metrics;

    const {
      requestedModel,
      requestedModelInput,
      requestedModelLabel,
      isNamedModelSelection,
      isImplicitAutoSelection,
      wantsFreeNamedModel,
      configForModelSelection,
      isFallbackModel,
    } = resolveModelSelection({
      config,
      configForCli,
      configPath,
      envForRun,
      explicitModelArg,
    });

    const verboseColor = supportsColor(stderr, envForRun);
    const themeForStderr = createThemeRenderer({
      themeName,
      enabled: verboseColor,
      trueColor: resolveTrueColor(envForRun),
    });
    const renderSpinnerStatus = (label: string, detail = "…") =>
      `${themeForStderr.label(label)}${themeForStderr.dim(detail)}`;
    const renderSpinnerStatusWithModel = (label: string, modelId: string) =>
      `${themeForStderr.label(label)}${themeForStderr.dim(" (model: ")}${themeForStderr.accent(
        modelId,
      )}${themeForStderr.dim(")…")}`;
    const { streamingEnabled } = resolveStreamSettings({
      streamMode,
      stdout,
      json,
      extractMode,
    });

    if (
      extractMode &&
      inputTarget.kind === "file" &&
      !isTranscribableExtension(inputTarget.filePath)
    ) {
      throw new Error(
        "--extract for local files is only supported for media files (MP3, MP4, WAV, etc.)",
      );
    }
    if (extractMode && inputTarget.kind === "stdin") {
      throw new Error("--extract is not supported for piped stdin input");
    }

    // Progress UI (spinner + OSC progress) is shown on stderr. Before writing to stdout (including
    // streaming output), we stop + clear progress via the progress gate to keep scrollback clean.
    const progressEnabled = isRichTty(stderr) && !verbose && !json;
    const progressGate = createProgressGate();
    const {
      clearProgressForStdout,
      restoreProgressAfterStdout,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    } = progressGate;

    const fixedModelSpec: FixedModelSpec | null =
      requestedModel.kind === "fixed" ? requestedModel : null;

    const desiredOutputTokens = resolveDesiredOutputTokens({ lengthArg, maxOutputTokensArg });

    const summaryEngine = createSummaryEngine({
      env,
      envForRun,
      stdout,
      stderr,
      execFileImpl,
      timeoutMs,
      retries,
      streamingEnabled,
      plain,
      verbose,
      verboseColor,
      openaiUseChatCompletions,
      cliConfigForRun: cliConfigForRun ?? null,
      cliAvailability,
      trackedFetch,
      resolveMaxOutputTokensForCall,
      resolveMaxInputTokensForCall,
      llmCalls,
      clearProgressForStdout,
      restoreProgressAfterStdout,
      apiKeys: {
        xaiApiKey,
        openaiApiKey: apiKey,
        googleApiKey,
        anthropicApiKey,
        openrouterApiKey,
      },
      keyFlags: {
        googleConfigured,
        anthropicConfigured,
        openrouterConfigured,
      },
      zai: {
        apiKey: zaiApiKey,
        baseUrl: zaiBaseUrl,
      },
      nvidia: {
        apiKey: nvidiaApiKey,
        baseUrl: nvidiaBaseUrl,
      },
      providerBaseUrls,
    });
    const writeViaFooter = (parts: string[]) => {
      if (json) return;
      if (extractMode) return;
      const filtered = parts.map((p) => p.trim()).filter(Boolean);
      if (filtered.length === 0) return;
      clearProgressForStdout();
      stderr.write(`${themeForStderr.dim(`via ${filtered.join(", ")}`)}\n`);
      restoreProgressAfterStdout?.();
    };
    const { summarizeAsset, assetInputContext, urlFlowContext } = createRunnerFlowContexts({
      summarizeMediaFileImpl,
      cacheState,
      mediaCache,
      io: {
        env,
        envForRun,
        stdout,
        stderr,
        execFileImpl,
        fetch: trackedFetch,
      },
      flags: {
        timeoutMs,
        maxExtractCharacters: extractMode ? maxExtractCharacters : null,
        retries,
        format,
        markdownMode,
        preprocessMode,
        youtubeMode,
        firecrawlMode: requestedFirecrawlMode,
        videoMode,
        transcriptTimestamps,
        outputLanguage,
        lengthArg,
        forceSummary,
        promptOverride,
        lengthInstruction,
        languageInstruction,
        summaryCacheBypass: noCacheFlag,
        maxOutputTokensArg,
        json,
        extractMode,
        metricsEnabled,
        metricsDetailed,
        shouldComputeReport,
        runStartedAtMs,
        verbose,
        verboseColor,
        progressEnabled,
        streamMode,
        streamingEnabled,
        plain,
        configPath,
        configModelLabel,
        slides: slidesSettings,
        slidesDebug,
        slidesOutput: true,
      },
      model: {
        requestedModel,
        requestedModelInput,
        requestedModelLabel,
        fixedModelSpec,
        isFallbackModel,
        isImplicitAutoSelection,
        allowAutoCliFallback: false,
        isNamedModelSelection,
        wantsFreeNamedModel,
        desiredOutputTokens,
        configForModelSelection,
        envForAuto,
        cliAvailability,
        openaiUseChatCompletions,
        openaiWhisperUsdPerMinute,
        apiStatus: {
          xaiApiKey,
          apiKey,
          nvidiaApiKey,
          openrouterApiKey,
          openrouterConfigured,
          googleApiKey,
          googleConfigured,
          anthropicApiKey,
          anthropicConfigured,
          providerBaseUrls,
          zaiApiKey,
          zaiBaseUrl,
          nvidiaBaseUrl,
          firecrawlConfigured,
          firecrawlApiKey,
          apifyToken,
          ytDlpPath,
          ytDlpCookiesFromBrowser,
          falApiKey,
          groqApiKey,
          assemblyaiApiKey,
          openaiTranscriptionKey,
        },
        summaryEngine,
        getLiteLlmCatalog,
        llmCalls,
      },
      setTranscriptionCost,
      writeViaFooter,
      clearProgressForStdout,
      restoreProgressAfterStdout,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
      buildReport,
      estimateCostUsd,
    });

    await executeRunnerInput({
      inputTarget,
      stdin: stdin ?? process.stdin,
      handleFileInputContext: assetInputContext,
      url,
      isYoutubeUrl,
      withUrlAssetContext: assetInputContext,
      extractMode,
      progressEnabled,
      renderSpinnerStatus,
      renderSpinnerStatusWithModel,
      extractAssetContext: {
        env,
        envForRun,
        execFileImpl,
        timeoutMs,
        preprocessMode,
      },
      outputExtractedAssetContext: {
        io: { env, envForRun, stdout, stderr },
        flags: {
          timeoutMs,
          preprocessMode,
          format,
          plain,
          json,
          metricsEnabled,
          metricsDetailed,
          shouldComputeReport,
          runStartedAtMs,
          verboseColor,
        },
        hooks: {
          clearProgressForStdout,
          restoreProgressAfterStdout,
          buildReport,
          estimateCostUsd,
        },
        apiStatus: {
          xaiApiKey,
          apiKey,
          openrouterApiKey,
          apifyToken,
          firecrawlConfigured,
          googleConfigured,
          anthropicConfigured,
        },
      },
      summarizeAsset,
      runUrlFlowContext: urlFlowContext,
    });
  } finally {
    cacheState.store?.close();
  }
}
