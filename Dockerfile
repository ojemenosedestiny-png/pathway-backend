FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
FROM build AS runtime
ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["sh", "-c", "node dist/prisma/migrate-phase2.js --apply && node dist/prisma/seed-exam-research.js --apply && exec node dist/src/server.js"]
