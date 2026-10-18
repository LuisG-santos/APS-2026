FROM node:22-bookworm-slim AS build

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node api-alagamento-inundacao/package.json ./api-alagamento-inundacao/
COPY --chown=node:node api-qualidade-do-ar/package.json ./api-qualidade-do-ar/
COPY --chown=node:node api-transito-e-transporte/package.json ./api-transito-e-transporte/
RUN npm ci

COPY --chown=node:node prisma ./prisma
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node api-alagamento-inundacao ./api-alagamento-inundacao
COPY --chown=node:node api-qualidade-do-ar ./api-qualidade-do-ar
COPY --chown=node:node api-transito-e-transporte ./api-transito-e-transporte
RUN DATABASE_URL=postgresql://prisma:prisma@localhost:5432/prisma npm run build

FROM build AS migrate

FROM build AS production-dependencies

RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

EXPOSE 3002

CMD ["node", "dist/api-qualidade-do-ar/index.js"]