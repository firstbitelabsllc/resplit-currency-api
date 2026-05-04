import {
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'

import { FX_OTEL_SERVICE_NAME } from './otel.mjs'

export const FX_OTEL_VERIFY_HEADER = 'x-resplit-otel-verify'

export function buildFxCoverageVerificationSpanName(requestId) {
  return `resplit.fx.coverage.verify.${requestId}`
}

export function shouldEmitFxCoverageVerification(request) {
  const rawHeader = request.headers.get(FX_OTEL_VERIFY_HEADER)?.trim().toLowerCase()
  return rawHeader === '1' || rawHeader === 'true'
}

export async function withFxVerificationSpan(requestId, attributes, callback) {
  return trace
    .getTracer(FX_OTEL_SERVICE_NAME)
    .startActiveSpan(buildFxCoverageVerificationSpanName(requestId), async span => {
      span.setAttributes(attributes)

      try {
        return await callback(span)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'non_error_exception'

        span.recordException(error instanceof Error ? error : String(error))
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message,
        })
        throw error
      } finally {
        span.end()
      }
    })
}
