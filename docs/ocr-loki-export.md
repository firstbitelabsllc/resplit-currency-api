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

The sink is created disabled. Updates are staged with a digest-derived traffic
tag and `--no-traffic`; unknown environment variables are preserved. If an
existing sink is enabled or drifted, staging stops before Cloud Run is touched.

`bootstrap/verify-ocr-loki-export.sh` is the only promotion path. It generates
fresh 32-hex proof IDs itself, temporarily points the push subscription at the
tagged candidate, publishes a sanitized fixture, and requires that exact ID in
Loki before promoting. With `ENABLE_SINK=1`, it then enables the sink, writes a
second fixture through the real Cloud Logging API, and requires the second
exact Loki result. Its failure trap disables the sink, restores the stable push
endpoint, and restores the previous 100% revision. A typed proof string alone
cannot enable export.

Before running the verifier with `ENABLE_SINK=1`:

1. Provide the reviewed immutable image digest and a read-capable Grafana token
   through the local environment; do not print or persist either credential.
2. Force a downstream 503 and prove unacked backlog rises while Loki remains
   empty, then restore delivery and prove the backlog drains.
3. Prove a poison fixture reaches `ocr-loki-logs-dlq-inspect` after bounded
   attempts.
4. Send one real OCR request with the same 32-hex trace ID in `traceparent` and
   `X-Cloud-Trace-Context`; require the exact request/trace in Cloud Logging,
   Tempo, and Loki within 90 seconds.
5. Confirm `_Default` and the `ocr` service shape are unchanged.

The verifier performs the two positive convergence proofs and can enable the
sink only in the same successful process. To stop export without losing the
queue:

```sh
gcloud logging sinks update ocr-loki-export \
  --project=resplit-fx-prod --disabled
```

Never delete the topic or subscription during an incident. Cloud Logging stays
available for replay, and Pub/Sub delivery is at-least-once, so duplicates are
allowed and measured; missing identifiers are a failure.
