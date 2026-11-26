FROM oven/bun:1
WORKDIR /app
COPY server.ts index.html ./
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "server.ts"]
