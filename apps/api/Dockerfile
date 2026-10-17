FROM node:22-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

EXPOSE 4000
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
