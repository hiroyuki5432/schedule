FROM python:3.11-slim

# Build deps for psycopg / bcrypt (kept minimal; psycopg[binary] ships wheels but
# libpq + build-essential guarantee a working build on any base arch).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for layer caching. The application code itself is
# volume-mounted by docker-compose (./backend:/app), so the image only carries deps.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
