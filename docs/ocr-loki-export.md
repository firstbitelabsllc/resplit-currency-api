# OCR production log export

OCR remains independent of Grafana: it writes structured JSON to stdout, Cloud
Logging remains the 30-day primary store, and an additive sink can copy only the
`ocr` Cloud Run service's stdout into a dedicated Pub/Sub queue. The private
`ocr-loki-forwarder` acknowledges a push only after Grafana Loki accepts the
sanitized record. A Loki outage therefore leaves work in Pub/Sub for retry or
the dead-letter queue; it cannot fail an OCR request.

The original Alloy proposal was rejected after source inspection. Alloy's GCP
push receiver returns HTTP 204 after enqueueing to its internal receiver, before
`loki.write` confirms remote acceptance. Cloud Run's filesystem cannot make its
experimental WAL durable across instance replacement. The small synchronous Go
forwarder preserves the intended backlog guarantee.

## Hard-rail activation

Source merge does not create resources. The manual workflow defaults to
`activate=false`, and the canonical script exits before any mutation unless
`ACTIVATE=1`. Activation creates separately billed GCP resources and therefore
requires explicit authority. It reuses the existing server-side
`grafana-otlp-auth-header` secret by version number without reading, printing,
copying, or rotating its value. If Grafana rejects that credential for Loki,
leave the sink disabled and provision a distinct `logs:write` credential rather
than widening or exposing a token.

The sink is created disabled. Before enabling it:

1. Publish a wrapped, PII-free Cloud Logging fixture to `ocr-loki-logs`.
2. Query Loki for its exact message and request IDs.
3. Force a downstream 503 and prove unacked backlog rises while Loki remains
   empty, then restore delivery and prove the backlog drains.
4. Prove a poison fixture reaches `ocr-loki-logs-dlq-inspect` after bounded
   attempts.
5. Send one real OCR request with the same 32-hex trace ID in `traceparent` and
   `X-Cloud-Trace-Context`; require the exact request/trace in Cloud Logging,
   Tempo, and Loki within 90 seconds.
6. Confirm `_Default` and the `ocr` service shape are unchanged.

Only then rerun the script with `ENABLE_SINK=1` and the mechanically verified
`PROOF_REQUEST_ID`. To stop export without losing the queue:

```sh
gcloud logging sinks update ocr-loki-export \
  --project=resplit-fx-prod --disabled
```

Never delete the topic or subscription during an incident. Cloud Logging stays
available for replay, and Pub/Sub delivery is at-least-once, so duplicates are
allowed and measured; missing identifiers are a failure.
