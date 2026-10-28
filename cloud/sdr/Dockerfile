FROM python:3.12-slim
WORKDIR /app
COPY cloud/sdr/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY cloud/sdr /app/cloud/sdr
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Volume initialization occurs before start.py drops to UID502/503.
CMD ["python", "-B", "-m", "cloud.sdr.start"]
