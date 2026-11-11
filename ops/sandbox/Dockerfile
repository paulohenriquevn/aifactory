# The sandbox an agent works in when the factory runs on this machine instead of Vercel Sandbox: Node, git,
# the build tools, and bubblewrap and strace for the projects whose tests need them. It has no network of its own:
# everything goes through the egress proxy of its sandbox (see docker-sandbox.ts).
FROM node:22-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap jq strace unzip \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && mkdir -p /work /cache \
 && chown node:node /work /cache /usr/local/bin
# What a package manager downloads is kept in /cache, which a sandbox of the same repository shares.
ENV NODE_USE_ENV_PROXY=1 CI=true COREPACK_HOME=/cache/corepack
USER node
RUN echo 'store-dir=/cache/pnpm' > /home/node/.npmrc
WORKDIR /work
CMD ["sleep", "infinity"]
