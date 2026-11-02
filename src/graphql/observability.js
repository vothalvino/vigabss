// =============================================================================
// GraphQL error visibility (GQL-08)
// =============================================================================
// GraphQL answers HTTP 200 even when a resolver throws, and yoga masks the
// error to 'Unexpected error.' for the client. With yoga's logging disabled,
// a SQL error inside a resolver reached no log, metric or Sentry event; the
// only trace was the request log's 'POST /graphql 200'.
//
// The plugin sees execution errors before yoga masks them, so it can log the
// original error with the request, user, organization and operation. Errors
// it has reported are skipped by the yoga logger below, which still logs the
// failures yoga handles outside execution (a context or parse failure).
// =============================================================================

const { getOperationAST } = require('graphql');
const logger = require('../utils/logger').child({ service: 'graphql' });
const errorTracking = require('../utils/errorTracking');
const { registry } = require('../utils/metricsRegistry');

const graphqlErrors = registry.counter({
  name: 'graphql_errors_total',
  help: 'GraphQL execution errors by operation and code',
  labelNames: ['operation', 'code'],
  maxSeries: 400,
});

const reported = new WeakSet();

function isGraphqlError(err) {
  return Boolean(err) && (err.name === 'GraphQLError' || Array.isArray(err.locations) || 'extensions' in err);
}

// A resolver that throws a GraphQLError (FORBIDDEN, NOT_FOUND, BAD_USER_INPUT)
// is answering the client on purpose; anything else is an unexpected failure.
function classify(err) {
  const original = err.originalError;
  const code = err.extensions?.code;
  if (code) return { code: String(code), unexpected: code === 'INTERNAL_SERVER_ERROR' };
  if (original && !isGraphqlError(original)) return { code: 'INTERNAL_SERVER_ERROR', unexpected: true };
  return { code: 'GRAPHQL_ERROR', unexpected: false };
}

function operationName(args) {
  if (args.operationName) return String(args.operationName);
  try {
    return getOperationAST(args.document, null)?.name?.value || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function reportExecutionErrors(errors, args) {
  const ctx = args.contextValue || {};
  const operation = operationName(args);
  const fields = {
    requestId: ctx.requestId || null,
    userId: ctx.user?.id ?? null,
    orgId: ctx.orgId ?? null,
    operationName: operation,
  };
  for (const err of errors) {
    const { code, unexpected } = classify(err);
    graphqlErrors.inc({ operation, code });
    const path = Array.isArray(err.path) ? err.path.join('.') : undefined;
    if (unexpected) {
      const original = err.originalError || err;
      reported.add(err);
      logger.error({ ...fields, path, err: original }, 'GraphQL resolver failed');
      errorTracking.captureException(original, { ...fields, path, source: 'graphql' });
    } else if (code === 'FORBIDDEN') {
      logger.warn({ ...fields, path, code }, 'GraphQL permission denied');
    }
  }
}

const errorReportingPlugin = {
  onExecute({ args }) {
    return {
      onExecuteDone({ result }) {
        // A subscription yields an async iterator here; its errors arrive per event.
        if (result && Array.isArray(result.errors) && result.errors.length) {
          reportExecutionErrors(result.errors, args);
        }
      },
    };
  },
};

const yogaLogger = {
  debug: (...args) => logger.trace({ detail: args }, 'graphql-yoga'),
  info: (...args) => logger.debug({ detail: args }, 'graphql-yoga'),
  warn: (...args) => logger.warn({ detail: args }, 'graphql-yoga warning'),
  error: (err, ...rest) => {
    if (err && typeof err === 'object' && reported.has(err)) return;
    logger.error({ err, detail: rest.length ? rest : undefined }, 'GraphQL request failed');
  },
};

module.exports = { errorReportingPlugin, yogaLogger, graphqlErrors, classify };
