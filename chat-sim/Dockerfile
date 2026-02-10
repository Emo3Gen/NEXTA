FROM python:3.11-slim

WORKDIR /app

# Копируем файлы приложения
COPY index.html styles.css app.js ./

# Экспонируем порт 8000
EXPOSE 8000

# Запускаем HTTP сервер на порту 8000
CMD ["python", "-m", "http.server", "8000", "--bind", "0.0.0.0"]
