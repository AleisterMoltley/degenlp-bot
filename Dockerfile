FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY contracts ./contracts
COPY src ./src

RUN npm run build
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV STATE_FILE=/app/data/.degenlp-state.json

CMD ["node", "dist/railway.js"]