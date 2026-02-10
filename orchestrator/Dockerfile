FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package.json package-lock.json* ./
RUN npm install --production

# Копируем код приложения
COPY server.js ./

# Экспонируем порт 8001
EXPOSE 8001

# Запускаем приложение
CMD ["node", "server.js"]
