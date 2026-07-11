#!/usr/bin/env bash
# Resolve an immutable Artifact Registry image to the exact runtime manifest
# Cloud Run stores for linux/amd64. Buildx provenance turns a one-platform build
# into an OCI index with a second attestation manifest, so comparing Cloud Run's
# child digest directly to the reviewed parent digest is incorrect.

resolve_artifact_linux_amd64_image() {
  local gcloud_bin="${1:-}"
  local image="${2:-}"
  local repository
  local registry
  local registry_path
  local image_digest
  local access_token
  local manifest_url
  local manifest_json
  local media_type
  local runtime_digest

  if [[ -z "$gcloud_bin" || -z "$image" ]]; then
    echo ">> Artifact Registry resolver requires gcloud and an immutable image" >&2
    return 2
  fi
  repository="${image%@*}"
  image_digest="${image##*@}"
  registry="${repository%%/*}"
  registry_path="${repository#*/}"
  if [[ "$registry" != *.pkg.dev || "$registry_path" == "$repository" ||
        ! "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo ">> refusing malformed Artifact Registry digest reference" >&2
    return 2
  fi
  command -v "$gcloud_bin" >/dev/null
  command -v curl >/dev/null
  command -v jq >/dev/null

  if ! access_token="$("$gcloud_bin" auth print-access-token)"; then
    echo ">> unable to obtain an Artifact Registry read token" >&2
    return 1
  fi
  if [[ -z "$access_token" ]]; then
    echo ">> unable to obtain an Artifact Registry read token" >&2
    return 1
  fi
  manifest_url="https://${registry}/v2/${registry_path}/manifests/${image_digest}"
  if ! manifest_json="$(
    printf 'header = "Authorization: Bearer %s"\n' "$access_token" |
      curl --fail --silent --show-error \
        --connect-timeout 10 --max-time 30 \
        --config - \
        --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
        "$manifest_url"
  )"; then
    echo ">> unable to read the reviewed manifest from Artifact Registry" >&2
    return 1
  fi
  if ! media_type="$(printf '%s' "$manifest_json" | jq -er '.mediaType')"; then
    echo ">> Artifact Registry returned malformed manifest metadata" >&2
    return 1
  fi

  case "$media_type" in
    application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json)
      if ! runtime_digest="$(printf '%s' "$manifest_json" | jq -er '
        [
          .manifests[]
          | select(.platform.os == "linux" and .platform.architecture == "amd64")
          | select((.annotations["vnd.docker.reference.type"] // "") != "attestation-manifest")
          | .digest
        ]
        | if length == 1 then .[0] else error("expected exactly one linux/amd64 runtime manifest") end
      ')"; then
        echo ">> reviewed index does not contain exactly one linux/amd64 runtime" >&2
        return 1
      fi
      ;;
    application/vnd.oci.image.manifest.v1+json|application/vnd.docker.distribution.manifest.v2+json)
      runtime_digest="$image_digest"
      ;;
    *)
      echo ">> unsupported image manifest type: ${media_type}" >&2
      return 1
      ;;
  esac

  if [[ ! "$runtime_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo ">> Artifact Registry returned an invalid runtime digest" >&2
    return 1
  fi
  printf '%s@%s' "$repository" "$runtime_digest"
}
