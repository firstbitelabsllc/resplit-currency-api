# syntax=docker/dockerfile:1

FROM golang:1.26.5@sha256:079e59808d2d252516e27e3f3a9c003740dee7f75e55aa71528766d52bcfc16a AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download && go mod verify

COPY cmd/ocr-loki-forwarder ./cmd/ocr-loki-forwarder
COPY internal/ocrloki ./internal/ocrloki
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOFLAGS=-trimpath \
    go build -mod=readonly -ldflags="-s -w" -o /out/ocr-loki-forwarder ./cmd/ocr-loki-forwarder

FROM gcr.io/distroless/static-debian12:nonroot@sha256:b7bb25d9f7c31d2bdd1982feb4dafcaf137703c7075dbe2febb41c24212b946f

ENV PORT=8080
EXPOSE 8080
COPY --from=build /out/ocr-loki-forwarder /ocr-loki-forwarder
USER 65532:65532
ENTRYPOINT ["/ocr-loki-forwarder"]
