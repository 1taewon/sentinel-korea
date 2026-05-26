FROM python:3.12-slim

WORKDIR /app

# Install system deps for numpy/pandas/statsmodels
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Save git-tracked data as seed (before Railway volume mount shadows /app/data)
RUN cp -r /app/data /app/data_seed

COPY start.sh .
RUN chmod +x /app/start.sh

CMD ["bash", "/app/start.sh"]
