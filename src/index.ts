import { Handler, Context } from "aws-lambda";

import {
  incrementErrorsMetric,
  incrementInvocationsMetric,
  KMSService,
  MetricsConfig,
  MetricsListener,
} from "./metrics";
import { TraceConfig, TraceHeaders, TraceListener } from "./trace";
import {
  logError,
  LogLevel,
  Logger,
  setColdStart,
  setLogLevel,
  setLogger,
  promisifiedHandler,
  logDebug,
} from "./utils";
export { TraceHeaders } from "./trace";

export const apiKeyEnvVar = "DD_API_KEY";
export const apiKeyKMSEnvVar = "DD_KMS_API_KEY";
export const siteURLEnvVar = "DD_SITE";
export const logLevelEnvVar = "DD_LOG_LEVEL";
export const logForwardingEnvVar = "DD_FLUSH_TO_LOG";
export const logInjectionEnvVar = "DD_LOGS_INJECTION";
export const enhancedMetricsEnvVar = "DD_ENHANCED_METRICS";
export const datadogHandlerEnvVar = "DD_LAMBDA_HANDLER";
export const lambdaTaskRootEnvVar = "LAMBDA_TASK_ROOT";
export const mergeXrayTracesEnvVar = "DD_MERGE_XRAY_TRACES";
export const defaultSiteURL = "datadoghq.com";

interface GlobalConfig {
  /**
   * Whether to log extra information.
   * @default false
   */
  debugLogging: boolean;
  /**
   * Whether to force the `datadog()` wrapper to always wrap.
   * @default false
   */
  forceWrap: boolean;
  /**
   * Custom logger.
   */
  logger?: Logger;
}

/**
 * Configuration options for Datadog's lambda wrapper.
 */
export type Config = MetricsConfig & TraceConfig & GlobalConfig;

export const defaultConfig: Config = {
  apiKey: "",
  apiKeyKMS: "",
  autoPatchHTTP: true,
  debugLogging: false,
  enhancedMetrics: true,
  forceWrap: false,
  injectLogContext: true,
  logForwarding: false,
  mergeDatadogXrayTraces: false,
  shouldRetryMetrics: false,
  siteURL: "",
} as const;

let currentMetricsListener: MetricsListener | undefined;
let currentTraceListener: TraceListener | undefined;

/**
 * Wraps your AWS lambda handler functions to add tracing/metrics support
 * @param handler A lambda handler function.
 * @param config Configuration options for datadog.
 * @returns A wrapped handler function.
 *
 * ```javascript
 * import { datadog } from 'datadog-lambda-layer';
 * function yourHandler(event) {}
 * exports.yourHandler = datadog(yourHandler);
 * ```
 */
export function datadog<TEvent, TResult>(
  handler: Handler<TEvent, TResult>,
  config?: Partial<Config>,
): Handler<TEvent, TResult> {
  const finalConfig = getConfig(config);
  const metricsListener = new MetricsListener(new KMSService(), finalConfig);
  const handlerName = getEnvValue(datadogHandlerEnvVar, getEnvValue("_HANDLER", "handler"));

  const traceListener = new TraceListener(finalConfig, handlerName);

  // Only wrap the handler once unless forced
  const _ddWrappedKey = "_ddWrapped";
  if ((handler as any)[_ddWrappedKey] !== undefined && !finalConfig.forceWrap) {
    return handler;
  }

  setLogLevel(finalConfig.debugLogging ? LogLevel.DEBUG : LogLevel.ERROR);
  if (finalConfig.logger) {
    setLogger(finalConfig.logger);
  }

  const promHandler = promisifiedHandler(handler);
  const wrappedFunc = async (event: TEvent, context: Context) => {
    setColdStart();

    currentMetricsListener = metricsListener;
    currentTraceListener = traceListener;

    await traceListener.onStartInvocation(event, context);

    const { result, error, didError } = await traceListener.onWrap(async (event: TEvent, context: Context) => {
      await metricsListener.onStartInvocation(event);
      if (finalConfig.enhancedMetrics) {
        incrementInvocationsMetric(metricsListener, context);
      }
      let result: TResult | undefined;
      let error: any;
      let didError = false;
      try {
        result = (await promHandler(event, context)) as TResult | undefined;
      } catch (err) {
        if (finalConfig.enhancedMetrics) {
          incrementErrorsMetric(metricsListener, context);
        }
        err = error;
        didError = true;
      }
      await metricsListener.onCompleteInvocation();
      return { result, error, didError };
    })(event, context);
    await traceListener.onCompleteInvocation();
    currentMetricsListener = undefined;
    currentTraceListener = undefined;
    if (didError) {
      throw error;
    }
    return result as TResult;
  };

  (wrappedFunc as any)[_ddWrappedKey] = true;
  return wrappedFunc;
}

/**
 * Sends a Distribution metric asynchronously to the Datadog API.
 * @param name The name of the metric to send.
 * @param value The value of the metric
 * @param metricTime The timesamp associated with this metric data point.
 * @param tags The tags associated with the metric. Should be of the format "tag:value".
 */
export function sendDistributionMetricWithDate(name: string, value: number, metricTime: Date, ...tags: string[]) {
  tags = [...tags, getRuntimeTag()];

  if (currentMetricsListener !== undefined) {
    currentMetricsListener.sendDistributionMetricWithDate(name, value, metricTime, false, ...tags);
  } else {
    logError("handler not initialized");
  }
}

/**
 * Sends a Distribution metric asynchronously to the Datadog API.
 * @param name The name of the metric to send.
 * @param value The value of the metric
 * @param tags The tags associated with the metric. Should be of the format "tag:value".
 */
export function sendDistributionMetric(name: string, value: number, ...tags: string[]) {
  tags = [...tags, getRuntimeTag()];

  if (currentMetricsListener !== undefined) {
    currentMetricsListener.sendDistributionMetric(name, value, false, ...tags);
  } else {
    logError("handler not initialized");
  }
}

/**
 * Retrieves the Datadog headers for the current trace.
 */
export function getTraceHeaders(): Partial<TraceHeaders> {
  if (currentTraceListener === undefined) {
    return {};
  }
  return currentTraceListener.currentTraceHeaders;
}

function getConfig(userConfig?: Partial<Config>): Config {
  let config: Config;

  if (userConfig === undefined) {
    config = defaultConfig;
  } else {
    config = {
      ...defaultConfig,
      ...userConfig,
    };
  }
  if (config.apiKey === "") {
    config.apiKey = getEnvValue(apiKeyEnvVar, "");
  }

  if (config.siteURL === "") {
    config.siteURL = getEnvValue(siteURLEnvVar, defaultSiteURL);
  }

  if (config.apiKeyKMS === "") {
    config.apiKeyKMS = getEnvValue(apiKeyKMSEnvVar, "");
  }

  if (userConfig === undefined || userConfig.injectLogContext === undefined) {
    const result = getEnvValue(logInjectionEnvVar, "true").toLowerCase();
    config.injectLogContext = result === "true";
  }

  if (userConfig === undefined || userConfig.debugLogging === undefined) {
    const result = getEnvValue(logLevelEnvVar, "ERROR").toLowerCase();
    config.debugLogging = result === "debug";
  }
  if (userConfig === undefined || userConfig.logForwarding === undefined) {
    const result = getEnvValue(logForwardingEnvVar, "false").toLowerCase();
    config.logForwarding = result === "true";
  }
  if (userConfig === undefined || userConfig.enhancedMetrics === undefined) {
    const result = getEnvValue(enhancedMetricsEnvVar, "true").toLowerCase();
    config.enhancedMetrics = result === "true";
  }
  if (userConfig === undefined || userConfig.mergeDatadogXrayTraces === undefined) {
    const result = getEnvValue(mergeXrayTracesEnvVar, "false").toLowerCase();
    config.mergeDatadogXrayTraces = result === "true";
  }

  return config;
}

export function getEnvValue(key: string, defaultValue: string): string {
  const val = process.env[key];
  return val !== undefined ? val : defaultValue;
}

function getRuntimeTag(): string {
  const version = process.version;
  return `dd_lambda_layer:datadog-node${version}`;
}
