# The sandbox an agent works in when the factory runs on this machine instead of Vercel Sandbox: Node, git,
# the build tools, and bubblewrap for the projects whose tests need it. It has no network of its own:
# everything goes through the egress proxy of its sandbox (see docker-sandbox.ts).
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap jq unzip \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && mkdir -p /work \
 && chown node:node /work /usr/local/bin
ENV NODE_USE_ENV_PROXY=1 CI=true
USER node
WORKDIR /work
CMD ["sleep", "infinity"]
