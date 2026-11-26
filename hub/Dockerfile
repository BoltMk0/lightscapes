# Built from the repository root, as the hub is built with the library there:
#   docker build -f hub/Dockerfile .
FROM node:22-alpine AS build

WORKDIR /repo
COPY src ./src
COPY hub/package*.json ./hub/
# No install scripts: esbuild's only optimises how it starts, and can fail to run its own binary (ETXTBSY) on some
# storage drivers. It finds its binary without it
RUN cd hub && npm ci --ignore-scripts
COPY hub ./hub
RUN cd hub && npm run build && npm prune --omit=dev

FROM node:22-alpine AS production

# Where the hub's identity and settings are kept; mount a volume at /data to keep them
ENV LIGHTSCAPES_DATA_DIR=/data
ENV PORT=8090

WORKDIR /app
COPY --from=build /repo/hub/dist ./dist
COPY --from=build /repo/hub/public ./public
COPY --from=build /repo/hub/node_modules ./node_modules
COPY --from=build /repo/hub/package.json ./
EXPOSE 8090
ENTRYPOINT ["node", "dist/main.js"]
