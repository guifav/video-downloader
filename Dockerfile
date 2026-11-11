# syntax=docker/dockerfile:1
FROM denoland/deno:bin AS deno

FROM python:3.13-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
# O metadado do PyPI muda a cada release do yt-dlp: invalida o cache desta camada, entao todo
# deploy depois de uma release nova reconstroi a imagem com o yt-dlp atual.
ADD https://pypi.org/pypi/yt-dlp/json /tmp/yt-dlp-release.json
RUN pip install --no-cache-dir -U "yt-dlp[default]"
COPY container/app.py /app/app.py
EXPOSE 8080
CMD ["python", "/app/app.py"]
