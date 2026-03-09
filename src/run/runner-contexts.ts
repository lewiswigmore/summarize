import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import type { AssetSummaryContext, SummarizeAssetArgs } from "./flows/asset/summary.js";
import { summarizeAsset as summarizeAssetFlow } from "./flows/asset/summary.js";
import type { UrlFlowContext } from "./flows/url/types.js";

type SummarizeMediaFile = typeof import("./flows/asset/media.js").summarizeMediaFile;

export function createRunnerFlowContexts(options: {
  summarizeMediaFileImpl: SummarizeMediaFile;
  cacheState: CacheState;
  mediaCache: MediaCache | null;
  io: UrlFlowContext["io"];
  flags: UrlFlowContext["flags"];
  model: UrlFlowContext["model"];
  setTranscriptionCost: UrlFlowContext["hooks"]["setTranscriptionCost"];
  writeViaFooter: UrlFlowContext["hooks"]["writeViaFooter"];
  clearProgressForStdout: UrlFlowContext["hooks"]["clearProgressForStdout"];
  restoreProgressAfterStdout: UrlFlowContext["hooks"]["restoreProgressAfterStdout"];
  setClearProgressBeforeStdout: UrlFlowContext["hooks"]["setClearProgressBeforeStdout"];
  clearProgressIfCurrent: UrlFlowContext["hooks"]["clearProgressIfCurrent"];
  buildReport: UrlFlowContext["hooks"]["buildReport"];
  estimateCostUsd: UrlFlowContext["hooks"]["estimateCostUsd"];
}) {
  const {
    summarizeMediaFileImpl,
    cacheState,
    mediaCache,
    io,
    flags,
    model,
    setTranscriptionCost,
    writeViaFooter,
    clearProgressForStdout,
    restoreProgressAfterStdout,
    setClearProgressBeforeStdout,
    clearProgressIfCurrent,
    buildReport,
    estimateCostUsd,
  } = options;

  const assetSummaryContext: AssetSummaryContext = {
    env: io.env,
    envForRun: io.envForRun,
    stdout: io.stdout,
    stderr: io.stderr,
    execFileImpl: io.execFileImpl,
    timeoutMs: flags.timeoutMs,
    preprocessMode: flags.preprocessMode,
    format: flags.format,
    extractMode: flags.extractMode,
    lengthArg: flags.lengthArg,
    forceSummary: flags.forceSummary,
    outputLanguage: flags.outputLanguage,
    videoMode: flags.videoMode,
    fixedModelSpec: model.fixedModelSpec,
    promptOverride: flags.promptOverride,
    lengthInstruction: flags.lengthInstruction,
    languageInstruction: flags.languageInstruction,
    isFallbackModel: model.isFallbackModel,
    isImplicitAutoSelection: model.isImplicitAutoSelection,
    allowAutoCliFallback: model.allowAutoCliFallback,
    desiredOutputTokens: model.desiredOutputTokens,
    envForAuto: model.envForAuto,
    configForModelSelection: model.configForModelSelection,
    cliAvailability: model.cliAvailability,
    requestedModel: model.requestedModel,
    requestedModelInput: model.requestedModelInput,
    requestedModelLabel: model.requestedModelLabel,
    wantsFreeNamedModel: model.wantsFreeNamedModel,
    isNamedModelSelection: model.isNamedModelSelection,
    maxOutputTokensArg: flags.maxOutputTokensArg,
    json: flags.json,
    metricsEnabled: flags.metricsEnabled,
    metricsDetailed: flags.metricsDetailed,
    shouldComputeReport: flags.shouldComputeReport,
    runStartedAtMs: flags.runStartedAtMs,
    verbose: flags.verbose,
    verboseColor: flags.verboseColor,
    streamingEnabled: flags.streamingEnabled,
    plain: flags.plain,
    summaryEngine: model.summaryEngine,
    trackedFetch: io.fetch,
    writeViaFooter,
    clearProgressForStdout,
    restoreProgressAfterStdout,
    getLiteLlmCatalog: model.getLiteLlmCatalog,
    buildReport,
    estimateCostUsd,
    llmCalls: model.llmCalls,
    cache: cacheState,
    summaryCacheBypass: flags.summaryCacheBypass,
    mediaCache,
    apiStatus: {
      xaiApiKey: model.apiStatus.xaiApiKey,
      apiKey: model.apiStatus.apiKey,
      nvidiaApiKey: model.apiStatus.nvidiaApiKey,
      openrouterApiKey: model.apiStatus.openrouterApiKey,
      apifyToken: model.apiStatus.apifyToken,
      firecrawlConfigured: model.apiStatus.firecrawlConfigured,
      googleConfigured: model.apiStatus.googleConfigured,
      anthropicConfigured: model.apiStatus.anthropicConfigured,
      providerBaseUrls: model.apiStatus.providerBaseUrls,
      zaiApiKey: model.apiStatus.zaiApiKey,
      zaiBaseUrl: model.apiStatus.zaiBaseUrl,
      nvidiaBaseUrl: model.apiStatus.nvidiaBaseUrl,
      assemblyaiApiKey: model.apiStatus.assemblyaiApiKey,
    },
  };

  const summarizeAsset = (args: SummarizeAssetArgs) =>
    summarizeAssetFlow(assetSummaryContext, args);
  const summarizeMediaFile = (args: Parameters<SummarizeMediaFile>[1]) =>
    summarizeMediaFileImpl(assetSummaryContext, args);

  return {
    summarizeAsset,
    assetInputContext: {
      env: assetSummaryContext.env,
      envForRun: assetSummaryContext.envForRun,
      stderr: assetSummaryContext.stderr,
      progressEnabled: flags.progressEnabled,
      timeoutMs: flags.timeoutMs,
      trackedFetch: io.fetch,
      summarizeAsset,
      summarizeMediaFile,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    },
    urlFlowContext: {
      io,
      flags,
      model,
      cache: cacheState,
      mediaCache,
      hooks: {
        onModelChosen: null,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        setTranscriptionCost,
        summarizeAsset,
        writeViaFooter,
        clearProgressForStdout,
        restoreProgressAfterStdout,
        setClearProgressBeforeStdout,
        clearProgressIfCurrent,
        buildReport,
        estimateCostUsd,
        onSlideChunk: undefined,
        onSlidesDone: null,
      },
    } satisfies UrlFlowContext,
  };
}
