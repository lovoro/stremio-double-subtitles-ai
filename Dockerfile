FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0

RUN corepack enable && corepack prepare pnpm@10.25.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY . .

# The hosting platform may inject PORT at runtime. If it does not, server.js
# falls back to 53100.
EXPOSE 53100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "const p=Number(process.env.PORT||53100);const r=require('http').get({host:'127.0.0.1',port:p,path:'/healthz',timeout:3000},s=>process.exit(s.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)})"]

CMD ["node", "server.js"]
