# Mynt's confidential service (keyhouse), run as a confidential-VM workload (docs/reference.md, Confidential computing).
#
# Reproducible: the base image is pinned by digest, the service has no npm dependencies (its lockfile is empty and
# checked), every file is copied with fixed ownership and mode, and timestamps are normalised by the build
# (SOURCE_DATE_EPOCH with rewrite-timestamp, as CI's confidential-image job builds it). The same commit builds the same
# image digest, which is what the hardware measures, what the cloud key policy names, and what partners check.
#
# Build from the repository root after `cd core && npm run build && cd ../deploy/confidential && npm run sync-shared`:
#   docker buildx build --file deploy/confidential/Dockerfile deploy/confidential
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# The launcher's rules for this image, which it enforces before starting it:
#   - only these settings may be overridden from the VM's metadata (none of them is a secret, and none changes what
#     the code does with keys; policy.json, which does, is part of the image);
#   - the container's output may go to the cloud's logs (it holds route, caller and outcome only);
#   - it runs as a non-root user.
LABEL "tee.launch_policy.allow_env_override"="KEYHOUSE_WIP_PROVIDER,KEYHOUSE_WRAP_KEY,KEYHOUSE_SIGNING_KEYS,KEYHOUSE_WRAPPED_ROOT,KEYHOUSE_CLIENT_CA,KEYHOUSE_PORT"
LABEL "tee.launch_policy.log_redirect"="always"
LABEL "tee.launch_policy.monitoring_memory_allow"="never"

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=1000:1000 --chmod=0555 package.json package-lock.json policy.json ./
COPY --chown=1000:1000 --chmod=0555 src/ ./src/
USER 1000:1000
EXPOSE 8443
ENTRYPOINT ["node", "src/server.mjs"]
