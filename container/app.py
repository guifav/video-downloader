"""Servidor do container: baixa um video avulso com yt-dlp e devolve o arquivo no corpo.

POST /download {"url": str, "platform": "youtube"|"x"|"instagram"|"facebook"|"tiktok", "budget_ms": int}
  200 -> corpo = arquivo; headers Content-Length, X-Title (percent-encoded), X-Ext, e quando o
         ffprobe rodou X-Source-Codec (codec de video baixado, antes da conversao) e X-Video-Size
         (LxA do arquivo entregue); se o arquivo nao saiu H.264, X-Warning (percent-encoded)
  400 -> {"error"} requisicao invalida
  422 -> {"error", "transient": false} o video nao pode ser baixado (mensagem real do yt-dlp)
  503 -> {"error", "transient": true} falha de rede/servidor durante o download; vale retentar
  500 -> {"error", "transient": true} excecao inesperada no container
GET /health -> {"ok": true}

O Worker ja valida a URL; aqui repetimos a checagem de host (defesa em profundidade),
porque o container tem acesso a internet.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import yt_dlp
from yt_dlp.networking.exceptions import HTTPError, TransportError
from yt_dlp.utils import DownloadError, ExtractorError

PORT = 8080
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"
# Prazo padrao quando o Worker nao manda budget_ms (versao antiga do Worker durante um deploy).
DEFAULT_BUDGET_S = 10 * 60
MAX_BUDGET_MS = 15 * 60 * 1000
# Conversao: abaixo disso de tempo restante, nem comeca; a projecao so vale depois de alguns
# segundos de progresso, para nao decidir pelo ruido do inicio.
MIN_CONVERT_S = 10
MIN_PROJECTION_S = 8
CHUNK = 1024 * 1024
MAX_BODY = 4096

# So a forma canonica que o Worker gera (src/urls.ts) e aceita.
ALLOWED_HOSTS = {
    "youtube": {"www.youtube.com"},
    "x": {"x.com"},
    "instagram": {"www.instagram.com"},
    "facebook": {"www.facebook.com"},
    "tiktok": {"www.tiktok.com"},
}

# So o extrator da plataforma pode rodar. Sem isso, um post do X sem video que aponta para
# um link externo faz o yt-dlp seguir para o extrator generico e buscar uma URL arbitraria.
# O yt-dlp aplica fullmatch: "instagram" nao carrega instagram:story/user/tag, e "facebook" nao
# carrega facebook:ads. O reel do Facebook delega para o extrator "facebook", tambem permitido.
ALLOWED_EXTRACTORS = {
    "youtube": ["youtube"],
    "x": ["twitter"],
    "instagram": ["instagram"],
    "facebook": ["facebook", "facebook:reel"],
    # So o extrator de video: tiktok:user/live/collection ficam fora. Link curto chega ja resolvido.
    "tiktok": ["tiktok"],
}

# Cookies opcionais de conta descartavel, um secret por plataforma. Nunca a conta pessoal.
COOKIE_SECRETS = {
    "youtube": "YT_COOKIES_B64",
    "instagram": "IG_COOKIES_B64",
    "facebook": "FB_COOKIES_B64",
    "tiktok": "TT_COOKIES_B64",
}

# H.264 + AAC primeiro: VP9/AV1/Opus dentro de mp4 nao tocam no QuickTime/Safari. O yt-dlp
# rotula H.264 como "avc1..." (YouTube, X) ou "h264" (TikTok, que tambem oferece h265 ao lado).
# Depois cai para o melhor disponivel. Todas as alternativas respeitam o teto de 1080p pelo
# LADO MENOR: video vertical ou quase quadrado (aspect_ratio <= 1, que o yt-dlp arredonda em 2
# casas: 1080x1084 vira 1.0) e limitado pela largura, o resto pela altura.
# Sem isso, um reel/Short 1080x1920 caia para 540x960. `<=?` na altura aceita formatos sem
# dimensao declarada (comum no X), em vez de um fallback irrestrito; a variante vertical exige
# largura conhecida, entao formato sem dimensao segue pela regra antiga.
MAX_SIDE = 1080
_VERTICAL = f"[aspect_ratio<=1][width<={MAX_SIDE}]"
_CAPPED = f"[height<=?{MAX_SIDE}]"
FORMAT = "/".join(
    f"{alt.format(cap=cap)}"
    for alt in (
        "bv*[vcodec~='^(avc1|h264)']{cap}+ba[acodec^=mp4a]",
        "b[vcodec~='^(avc1|h264)']{cap}",
        "bv*{cap}+ba",
        "b{cap}",
    )
    for cap in (_VERTICAL, _CAPPED)
)


class DownloadFailed(Exception):
    """Erro do yt-dlp com mensagem apresentavel ao usuario.

    transient=True: falha de rede/servidor que vale tentar de novo (HTTP 503 para o Worker).
    transient=False: o video nao pode ser baixado (indisponivel, privado, sem video): HTTP 422.
    """

    def __init__(self, message: str, transient: bool = False):
        super().__init__(message)
        self.transient = transient


_TRANSIENT_TEXT = (
    "timed out",
    "timeout",
    "connection reset",
    "connection refused",
    "connection aborted",
    "remote end closed",
    "temporary failure in name resolution",
    "network is unreachable",
    "incomplete read",
    "more expected",  # IncompleteRead do downloader: "100 bytes read, 900 more expected"
    "giving up after",  # retries do downloader esgotados: a causa tipada ja foi descartada
    "got error:",  # prefixo do downloader HTTP para falhas de transporte durante o download
    "http error 429",
    "http error 500",
    "http error 502",
    "http error 503",
    "http error 504",
)


def is_transient(exc: BaseException) -> bool:
    """Classifica um erro do yt-dlp seguindo a cadeia de causas; cai para o texto da mensagem."""
    seen: set[int] = set()
    cause: BaseException | None = exc
    while cause is not None and id(cause) not in seen:
        seen.add(id(cause))
        if isinstance(cause, HTTPError):
            return cause.status >= 500 or cause.status == 429
        if isinstance(cause, (TransportError, TimeoutError, ConnectionError, socket.timeout)):
            return True
        if isinstance(cause, ExtractorError) and cause.expected and cause.cause is None:
            return False
        nxt = None
        if isinstance(cause, DownloadError) and cause.exc_info:
            nxt = cause.exc_info[1]
        elif isinstance(cause, ExtractorError) and isinstance(cause.cause, BaseException):
            nxt = cause.cause
        cause = nxt or cause.__cause__ or cause.__context__
    text = str(exc).lower()
    return any(marker in text for marker in _TRANSIENT_TEXT)


def _is_public(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


_original_getaddrinfo = socket.getaddrinfo


def _public_getaddrinfo(host, *args, **kwargs):
    """Resolve normalmente, mas descarta enderecos nao publicos (loopback, rede privada,
    link-local, metadata). Vale para toda conexao Python do yt-dlp, inclusive redirects."""
    results = _original_getaddrinfo(host, *args, **kwargs)
    public = [r for r in results if _is_public(r[4][0])]
    if not public:
        raise socket.gaierror(socket.EAI_NONAME, f"destino nao publico bloqueado: {host}")
    return public


def install_network_guard() -> None:
    socket.getaddrinfo = _public_getaddrinfo


def validate_request(data: Any) -> tuple[str, str, float]:
    if not isinstance(data, dict):
        raise ValueError("corpo deve ser um objeto JSON")
    url, platform = data.get("url"), data.get("platform")
    if platform not in ALLOWED_HOSTS:
        raise ValueError("plataforma invalida")
    if not isinstance(url, str):
        raise ValueError("url ausente")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS[platform]:
        raise ValueError("url fora da lista permitida")
    if parsed.username or parsed.password or parsed.port:
        raise ValueError("url fora da lista permitida")
    budget_ms = data.get("budget_ms", DEFAULT_BUDGET_S * 1000)
    if type(budget_ms) is not int or not 0 < budget_ms <= MAX_BUDGET_MS:
        raise ValueError("budget_ms invalido")
    return url, platform, budget_ms / 1000


def cookie_file(platform: str, workdir: str) -> str | None:
    """Cookies da conta descartavel da propria plataforma, so se o secret dela existir."""
    secret = COOKIE_SECRETS.get(platform)
    raw = os.environ.get(secret, "") if secret else ""
    if not raw:
        return None
    path = os.path.join(workdir, "cookies.txt")
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(raw))
    return path


class _QuietLogger:
    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        print(f"yt-dlp warning: {msg}", flush=True)

    def error(self, msg: str) -> None:
        print(f"yt-dlp error: {msg}", flush=True)


def clean_error(exc: BaseException) -> str:
    text = str(exc).strip()
    if text.startswith("ERROR: "):
        text = text[len("ERROR: "):]
    return text[:1000] or exc.__class__.__name__


def _has_video(info: Any) -> bool:
    """False so quando o item ja traz a lista de formatos e nenhum tem video (foto de carrossel).
    Sem a chave formats (cabecalho do playlist, item ainda nao resolvido), nao ha o que julgar."""
    if info.get("_type") not in (None, "video") or info.get("url") or "formats" not in info:
        return True
    return any(f.get("vcodec") != "none" for f in info.get("formats") or [])


LIVE_ERROR = "Live em andamento ou agendada: so da para baixar video ja gravado. Tente depois que a live terminar."


class LiveRejected(Exception):
    """Levantada no match_filter: interrompe a extracao inteira antes de qualquer download."""


def live_guard(inner: Any = None) -> Any:
    """match_filter que recusa live em andamento ou agendada antes de baixar (follow-up #5).

    O filtro interno (carrossel) decide primeiro: item que ele descarta nunca e julgado como live,
    entao um carrossel [video, live] entrega o video. Se o item escolhido for live, a extracao para
    na hora (LiveRejected), sem baixar nenhum item seguinte (R1 Kimi, PR #14). `live_status`
    post_live (live encerrada, VOD em processamento) passa: nao e mais transmissao (A6)."""

    def check(info: Any, *, incomplete: bool = False) -> str | None:
        reason = inner(info, incomplete=incomplete) if inner else None
        if reason:
            return reason
        # So na chamada final, que o yt-dlp faz antes de baixar cada item: na fase incompleta de um
        # playlist ele avalia itens a frente, quando o carrossel ainda nao escolheu o primeiro video.
        # Nessa chamada o yt-dlp ja normalizou live_status a partir de is_live/was_live
        # (_fill_common_fields), entao basta o live_status.
        if not incomplete and info.get("live_status") in ("is_live", "is_upcoming"):
            raise LiveRejected(LIVE_ERROR)
        return None

    return check


def first_video_only() -> Any:
    """match_filter para carrossel: pula itens sem video (fotos) e aceita so o primeiro video.

    O yt-dlp chama o filtro mais de uma vez por item, com informacao parcial (incomplete
    verdadeiro ou um conjunto de campos) e por fim com incomplete=False antes de baixar; o
    estado so muda nessa chamada final."""
    accepted: list[str] = []

    def check(info: Any, *, incomplete: bool = False) -> str | None:
        if not _has_video(info):
            return "item sem video"
        if "id" not in info:
            return None  # cabecalho do playlist
        key = str(info.get("id"))
        if accepted and key not in accepted:
            return "carrossel: so o primeiro video"
        if not incomplete and not accepted:
            accepted.append(key)
        return None

    return check


def build_options(platform: str, workdir: str) -> dict[str, Any]:
    options: dict[str, Any] = {
        "format": FORMAT,
        "merge_output_format": "mp4",
        "outtmpl": os.path.join(workdir, "%(id)s.%(ext)s"),
        "noplaylist": True,
        "playlist_items": "1",
        "noprogress": True,
        "quiet": True,
        "no_warnings": False,
        "logger": _QuietLogger(),
        "socket_timeout": 30,
        "retries": 3,
        "allowed_extractors": ALLOWED_EXTRACTORS[platform],
        # I3 (docs/contrato-de-falhas.md): fragmento HLS/DASH indisponivel falha o download em vez
        # de gerar um arquivo com buracos que seria servido como completo.
        "skip_unavailable_fragments": False,
    }
    if platform == "instagram":
        # Carrossel com foto na frente: "primeiro item" falharia; vale o primeiro video.
        del options["playlist_items"]
        options["match_filter"] = live_guard(first_video_only())
    else:
        options["match_filter"] = live_guard()
    return options


def download(url: str, platform: str, workdir: str) -> dict[str, Any]:
    opts = build_options(platform, workdir)
    cookies = cookie_file(platform, workdir)
    if cookies:
        opts["cookiefile"] = cookies
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:  # type: ignore[arg-type]
            info = ydl.extract_info(url, download=True)
    except LiveRejected as exc:
        raise DownloadFailed(LIVE_ERROR) from exc
    except DownloadError as exc:
        raise DownloadFailed(clean_error(exc), transient=is_transient(exc)) from exc

    if info and info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        info = entries[0] if entries else None
    if not info:
        raise DownloadFailed("yt-dlp nao encontrou video neste link")
    downloads = info.get("requested_downloads") or []
    path = downloads[0].get("filepath") if downloads else None
    if not path or not os.path.isfile(path):
        raise DownloadFailed("yt-dlp terminou sem gerar arquivo (post sem video?)")
    ext = os.path.splitext(path)[1].lstrip(".").lower() or "mp4"
    return {"path": path, "title": info.get("title") or "", "ext": ext, "bytes": os.path.getsize(path)}


def _probe(path: str, timeout: float) -> dict[str, Any]:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", path],
        check=True, capture_output=True, text=True, timeout=timeout,
    ).stdout
    return json.loads(out)


def _codecs(info: dict[str, Any]) -> tuple[str | None, str | None]:
    video = next((s.get("codec_name") for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s.get("codec_name") for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    return video, audio


def _record(meta: dict[str, Any] | None, info: dict[str, Any], source_codec: str) -> None:
    """Codec de origem e dimensoes do arquivo descrito por info (origem, ou saida da conversao)."""
    if meta is None:
        return
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    meta["source_codec"] = source_codec
    width, height = video.get("width"), video.get("height")
    if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
        meta["width"], meta["height"] = width, height


def _warning(codec: str, reason: str) -> str:
    return (
        f"Video em {codec.upper()}: {reason}. Pode nao abrir no QuickTime nem no app Fotos; "
        "VLC e Chrome abrem."
    )


UNVERIFIED = "Nao foi possivel verificar o codec do video; pode nao abrir no QuickTime nem no app Fotos."
NO_TIME = "nao deu tempo de converter para H.264"
PROBE_MAX_S = 30
POLL_S = 0.25


def _left(deadline: float) -> float:
    return deadline - time.monotonic()


def ensure_h264(path: str, deadline: float, workdir: str, meta: dict[str, Any] | None = None) -> tuple[str, str | None]:
    """Devolve (arquivo, aviso). Se o video nao for H.264, converte para H.264+AAC dentro do prazo
    (relogio monotonic). Se a conversao nao couber ou falhar, devolve o original intacto com aviso.
    Nunca devolve arquivo parcial (I3): a saida so substitui o original depois de ffmpeg terminar
    com sucesso e o ffprobe confirmar H.264. Nenhuma etapa (probe, conversao, probe da saida)
    passa do prazo: cada uma e limitada pelo tempo restante, e o prazo e fiscalizado por relogio,
    nao pela chegada de progresso do ffmpeg. Se `meta` vier, recebe source_codec (codec baixado) e
    width/height do arquivo devolvido; fica vazio quando o probe da origem nao rodou."""
    if _left(deadline) <= 0:
        return path, UNVERIFIED
    try:
        info = _probe(path, min(PROBE_MAX_S, _left(deadline)))
    except (subprocess.SubprocessError, OSError, ValueError):
        return path, UNVERIFIED
    vcodec, acodec = _codecs(info)
    if vcodec is None:
        return path, None
    _record(meta, info, vcodec)
    if vcodec == "h264":
        return path, None
    try:
        duration = float(info.get("format", {}).get("duration") or 0)
    except ValueError:
        duration = 0.0

    if _left(deadline) < MIN_CONVERT_S:
        return path, _warning(vcodec, NO_TIME)

    out = os.path.join(workdir, "h264-" + os.path.splitext(os.path.basename(path))[0] + ".mp4")
    audio = ["-c:a", "copy"] if acodec == "aac" else ["-c:a", "aac", "-b:a", "160k"]
    cmd = [
        FFMPEG, "-nostdin", "-v", "error", "-y", "-i", path,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
        *audio, "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", out,
    ]
    started = time.monotonic()
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except OSError:
        return path, _warning(vcodec, "a conversao para H.264 falhou")

    # O progresso e lido numa thread; o laco principal fiscaliza o prazo por relogio, mesmo que o
    # ffmpeg fique em silencio (achado P1 do PR #8).
    progress = {"seconds": 0.0}

    def read_progress() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("out_time_us="):
                try:
                    progress["seconds"] = int(line.split("=", 1)[1]) / 1e6
                except ValueError:
                    pass

    reader = threading.Thread(target=read_progress, daemon=True)
    reader.start()
    reason: str | None = None
    rc: int | None = None
    try:
        while rc is None:
            try:
                rc = proc.wait(timeout=min(POLL_S, max(0.01, _left(deadline))))
                break
            except subprocess.TimeoutExpired:
                pass
            now = time.monotonic()
            if now >= deadline:
                reason = NO_TIME
                break
            done = progress["seconds"] / duration if duration > 0 else 0.0
            elapsed = now - started
            if done > 0 and elapsed >= MIN_PROJECTION_S and started + elapsed / done > deadline:
                reason = NO_TIME
                break
    finally:
        if rc is None:
            proc.kill()
            proc.wait()
        reader.join(timeout=1)
        if proc.stdout:
            proc.stdout.close()

    if reason is None and rc == 0 and os.path.isfile(out) and _left(deadline) > 0:
        out_info: dict[str, Any] = {}
        try:
            out_info = _probe(out, min(PROBE_MAX_S, _left(deadline)))
            converted, _ = _codecs(out_info)
        except (subprocess.SubprocessError, OSError, ValueError):
            converted = None
            reason = NO_TIME if _left(deadline) <= 0 else None
        if converted == "h264":
            os.remove(path)
            # Dimensoes do arquivo entregue: a conversao aplica a rotacao da origem (320x240 com
            # rotacao de 90 graus sai 240x320). O codec registrado continua o da origem.
            _record(meta, out_info, vcodec)
            return out, None
    elif reason is None and rc == 0 and _left(deadline) <= 0:
        reason = NO_TIME  # conversao terminou, mas sem tempo para confirmar o codec da saida
    if os.path.exists(out):
        os.remove(out)
    return path, _warning(vcodec, reason or "a conversao para H.264 falhou")


class Handler(BaseHTTPRequestHandler):
    server_version = "video-download"

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "nao encontrado"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/download":
            self._json(404, {"error": "nao encontrado"})
            return
        try:
            length = int(self.headers.get("content-length") or "0")
            if length <= 0 or length > MAX_BODY:
                raise ValueError("corpo ausente ou grande demais")
            url, platform, budget_s = validate_request(json.loads(self.rfile.read(length)))
        except (ValueError, json.JSONDecodeError) as exc:
            self._json(400, {"error": str(exc)})
            return

        deadline = time.monotonic() + budget_s
        workdir = tempfile.mkdtemp(prefix="job-")
        try:
            try:
                result = download(url, platform, workdir)
                meta: dict[str, Any] = {}
                path, warning = ensure_h264(result["path"], deadline, workdir, meta)
                if path != result["path"]:
                    result.update(path=path, ext="mp4", bytes=os.path.getsize(path))
            except DownloadFailed as exc:
                self._json(503 if exc.transient else 422, {"error": str(exc), "transient": exc.transient})
                return
            except Exception as exc:  # noqa: BLE001 - nunca derrubar a conexao sem resposta
                print(f"erro inesperado: {exc!r}", flush=True)
                self._json(500, {"error": f"erro interno no container: {type(exc).__name__}: {exc}"[:1000], "transient": True})
                return
            self.send_response(200)
            self.send_header("content-type", "application/octet-stream")
            self.send_header("content-length", str(result["bytes"]))
            self.send_header("x-title", urllib.parse.quote(result["title"], safe=""))
            self.send_header("x-ext", result["ext"])
            if meta.get("source_codec"):
                self.send_header("x-source-codec", str(meta["source_codec"])[:20])
            if "width" in meta:
                self.send_header("x-video-size", f"{meta['width']}x{meta['height']}")
            if warning:
                self.send_header("x-warning", urllib.parse.quote(warning, safe=""))
            self.end_headers()
            with open(result["path"], "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, CHUNK)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def log_message(self, format: str, *args: Any) -> None:
        print(format % args, flush=True)


def main() -> None:
    install_network_guard()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
