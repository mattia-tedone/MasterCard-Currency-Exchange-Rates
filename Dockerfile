FROM mcr.microsoft.com/playwright:v1.47.2-jammy

WORKDIR /app

# Install only production deps to keep image lean
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

