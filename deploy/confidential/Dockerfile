# Mynt's confidential service (keyhouse), in two forms from one build (docs/reference/confidential-computing.md):
#
#   --target nitro                 the AWS Nitro enclave image, which nitro-cli turns into an enclave image file (EIF)
#                                  whose PCR0/PCR1/PCR2 the hardware measures (the documented deployment)
#   --target confidential-space    a Google Confidential Space container (the default target, as phase 1 built it)
#
# Reproducible: every base image is pinned by digest, the service has no npm dependencies (its lockfile is empty and
# checked), the enclave helper uses the Go standard library only and builds with -trimpath and no build id, every file
# is copied with fixed ownership and mode, and timestamps are normalised by the build (SOURCE_DATE_EPOCH with
# rewrite-timestamp, as CI's confidential-image job builds it). The same commit builds the same image, and so the same
# PCRs and digest: what the key policy names and what partners check.
#
# Build from the repository root after `cd core && npm run build && cd ../deploy/confidential && npm run sync-shared`:
#   docker buildx build --target nitro --file deploy/confidential/Dockerfile deploy/confidential

FROM golang:1.25.4-bookworm@sha256:e17419604b6d1f9bc245694425f0ec9b1b53685c80850900a376fb10cb0f70cb AS enclave-io
WORKDIR /src
COPY enclave-io/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w -buildid=" -o /out/mynt-enclave-io .

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS keyhouse
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=1000:1000 --chmod=0555 package.json package-lock.json policy.json ./
COPY --chown=1000:1000 --chmod=0555 src/ ./src/

# The enclave: mynt-enclave-io starts as root (only it opens the security module and the vsock relays) and runs the
# service as user 1000. KEYHOUSE_PLATFORM is part of the measured image, so the enclave can't be told to be anything else.
FROM keyhouse AS nitro
COPY --from=enclave-io --chmod=0555 /out/mynt-enclave-io /usr/local/bin/mynt-enclave-io
ENV KEYHOUSE_PLATFORM=aws-nitro
USER 0:0
ENTRYPOINT ["/usr/local/bin/mynt-enclave-io", "run", "--", "node", "/app/src/server.mjs"]

# Confidential Space. The launcher's rules for this image, which it enforces before starting it:
#   - only these settings may be overridden from the VM's metadata (none of them is a secret, and none changes what
#     the code does with keys; policy.json, which does, is part of the image);
#   - the container's output may go to the cloud's logs (it holds route, caller and outcome only);
#   - it runs as a non-root user.
FROM keyhouse AS confidential-space
LABEL "tee.launch_policy.allow_env_override"="KEYHOUSE_WIP_PROVIDER,KEYHOUSE_WRAP_KEY,KEYHOUSE_SIGNING_KEYS,KEYHOUSE_WRAPPED_ROOT,KEYHOUSE_CLIENT_CA,KEYHOUSE_PORT"
LABEL "tee.launch_policy.log_redirect"="always"
LABEL "tee.launch_policy.monitoring_memory_allow"="never"
USER 1000:1000
EXPOSE 8443
ENTRYPOINT ["node", "src/server.mjs"]
