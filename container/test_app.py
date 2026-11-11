import base64
import http.client
import json
import socket
import os
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import ThreadingHTTPServer
from unittest import mock

import yt_dlp
from yt_dlp.utils import DownloadError, ExtractorError

import app


RealYoutubeDL = yt_dlp.YoutubeDL  # capturado antes de qualquer mock.patch


class FakeYDL:
    """Substitui yt_dlp.YoutubeDL: grava um arquivo e devolve info como o real."""

    behavior = "ok"
    last_opts: dict = {}

    def __init__(self, opts):
        FakeYDL.last_opts = opts
        self.opts = opts

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=True):
        if FakeYDL.behavior == "error":
            raise DownloadError("ERROR: [youtube] abc: Sign in to confirm you're not a bot")
        if FakeYDL.behavior == "timeout":
            raise DownloadError("ERROR: [youtube] abc: The read operation timed out")
        if FakeYDL.behavior == "boom":
            raise RuntimeError("falha inesperada")
        if FakeYDL.behavior == "truncated":
            # Caminho real do downloader do yt-dlp instalado: retries esgotados apos leitura
            # truncada viram DownloadError sem causa (exc_info vazio), so com a mensagem.
            from yt_dlp.downloader.http import HttpFD
            from yt_dlp.networking.exceptions import IncompleteRead

            real = RealYoutubeDL({"quiet": True, "logger": app._QuietLogger()})
            HttpFD(real, {}).report_retry(IncompleteRead(100, 900), 4, 3)
            raise AssertionError("report_retry deveria ter lancado")
        if FakeYDL.behavior == "nofile":
            return {"title": "t", "requested_downloads": []}
        path = self.opts["outtmpl"].replace("%(id)s", "vid").replace("%(ext)s", "mp4")
        with open(path, "wb") as fh:
            fh.write(b"x" * 2048)
        entry = {"title": "Título / com: chars?", "requested_downloads": [{"filepath": path}]}
        if FakeYDL.behavior == "playlist":
            return {"_type": "playlist", "entries": [None, entry]}
        return entry


class ValidateRequestTest(unittest.TestCase):
    def test_budget_is_optional_bounded_and_returned_in_seconds(self):
        url = "https://x.com/a/status/1"
        self.assertEqual(app.validate_request({"url": url, "platform": "x"})[2], app.DEFAULT_BUDGET_S)
        self.assertEqual(app.validate_request({"url": url, "platform": "x", "budget_ms": 90000})[2], 90.0)
        for bad in (0, -5, 15 * 60 * 1000 + 1, "60", True, 1.5e12):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    app.validate_request({"url": url, "platform": "x", "budget_ms": bad})

    def test_accepts_canonical_urls(self):
        self.assertEqual(
            app.validate_request({"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "platform": "youtube"})[:2],
            ("https://www.youtube.com/watch?v=jNQXAC9IVRw", "youtube"),
        )
        self.assertEqual(
            app.validate_request({"url": "https://x.com/a/status/1", "platform": "x"})[1], "x"
        )

    def test_accepts_instagram_canonical_urls(self):
        self.assertEqual(
            app.validate_request({"url": "https://www.instagram.com/reel/CDUMkliABpa/", "platform": "instagram"})[1],
            "instagram",
        )

    def test_accepts_facebook_canonical_urls(self):
        for url in ("https://www.facebook.com/watch/?v=10155529876156509", "https://www.facebook.com/reel/1195289147628387"):
            with self.subTest(url=url):
                self.assertEqual(app.validate_request({"url": url, "platform": "facebook"})[1], "facebook")

    def test_rejects_facebook_off_canonical(self):
        cases = [
            {"url": "https://www.facebook.com/reel/1", "platform": "instagram"},
            {"url": "https://m.facebook.com/watch/?v=1", "platform": "facebook"},
            {"url": "https://fb.watch/abc/", "platform": "facebook"},
            {"url": "https://www.instagram.com/reel/CDUMkliABpa/", "platform": "facebook"},
            {"url": "http://www.facebook.com/reel/1", "platform": "facebook"},
        ]
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(ValueError):
                    app.validate_request(case)

    def test_rejects_instagram_off_canonical(self):
        cases = [
            {"url": "https://www.instagram.com/reel/CDUMkliABpa/", "platform": "x"},
            {"url": "https://www.facebook.com/reel/1", "platform": "instagram"},
            {"url": "https://instagram.com/reel/CDUMkliABpa/", "platform": "instagram"},
            {"url": "https://m.instagram.com/reel/CDUMkliABpa/", "platform": "instagram"},
            {"url": "https://www.instagram.com/reel/CDUMkliABpa/", "platform": "facebook"},
            {"url": "https://instagram.com.evil.com/p/abc/", "platform": "instagram"},
        ]
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(ValueError):
                    app.validate_request(case)

    def test_rejects_other_hosts_and_mismatched_platform(self):
        cases = [
            {"url": "https://evil.com/watch?v=x", "platform": "youtube"},
            {"url": "https://x.com/a/status/1", "platform": "youtube"},
            {"url": "http://www.youtube.com/watch?v=x", "platform": "youtube"},
            {"url": "https://user@www.youtube.com/watch?v=x", "platform": "youtube"},
            {"url": "https://www.youtube.com:8443/watch?v=x", "platform": "youtube"},
            {"url": "https://169.254.169.254/", "platform": "x"},
            {"url": 123, "platform": "x"},
            {"url": "https://x.com/a/status/1", "platform": "tiktok"},
            [],
        ]
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(ValueError):
                    app.validate_request(case)


class CookieFileTest(unittest.TestCase):
    def test_youtube_secret_only_for_youtube_and_only_when_present(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertIsNone(app.cookie_file("youtube", d))
            secret = base64.b64encode(b"# Netscape HTTP Cookie File\n").decode()
            with mock.patch.dict(os.environ, {"YT_COOKIES_B64": secret}):
                self.assertIsNone(app.cookie_file("x", d))
                path = app.cookie_file("youtube", d)
                assert path is not None
                with open(path, "rb") as fh:
                    self.assertTrue(fh.read().startswith(b"# Netscape"))


    def test_each_platform_reads_only_its_own_secret(self):
        secrets = {
            "YT_COOKIES_B64": base64.b64encode(b"# Netscape yt\n").decode(),
            "IG_COOKIES_B64": base64.b64encode(b"# Netscape ig\n").decode(),
            "FB_COOKIES_B64": base64.b64encode(b"# Netscape fb\n").decode(),
        }
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.dict(os.environ, secrets):
                for platform, marker in (("youtube", b"yt"), ("instagram", b"ig"), ("facebook", b"fb")):
                    path = app.cookie_file(platform, d)
                    assert path is not None
                    with open(path, "rb") as fh:
                        self.assertIn(marker, fh.read())
                self.assertIsNone(app.cookie_file("x", d))
            with mock.patch.dict(os.environ, {"YT_COOKIES_B64": secrets["YT_COOKIES_B64"]}, clear=True):
                self.assertIsNone(app.cookie_file("instagram", d))
                self.assertIsNone(app.cookie_file("facebook", d))


class FormatSelectorTest(unittest.TestCase):
    """Roda o seletor real do yt-dlp sobre formatos sinteticos."""

    def select(self, formats):
        ydl = yt_dlp.YoutubeDL({"quiet": True})
        selector = ydl.build_format_selector(app.FORMAT)
        ctx = {"formats": formats, "incomplete_formats": False, "has_merged_format": False}
        return [f["format_id"] for f in selector(ctx)]

    def fmt(self, fid, height, vcodec="avc1.640028", acodec="none", ext="mp4"):
        return {"format_id": fid, "height": height, "vcodec": vcodec, "acodec": acodec, "ext": ext,
                "url": f"https://example.invalid/{fid}", "protocol": "https"}

    def test_prefers_h264_aac_at_1080_over_vp9_and_4k(self):
        formats = [
            self.fmt("a", None, vcodec="none", acodec="mp4a.40.2", ext="m4a"),
            self.fmt("o", None, vcodec="none", acodec="opus", ext="webm"),
            self.fmt("h1080", 1080),
            self.fmt("v1080", 1080, vcodec="vp9", ext="webm"),
            self.fmt("h2160", 2160),
        ]
        self.assertEqual(self.select(formats), ["h1080+a"])

    def test_never_exceeds_1080_even_without_h264(self):
        formats = [
            self.fmt("o", None, vcodec="none", acodec="opus", ext="webm"),
            self.fmt("v720", 720, vcodec="vp9", ext="webm"),
            self.fmt("v2160", 2160, vcodec="vp9", ext="webm"),
        ]
        self.assertEqual(self.select(formats), ["v720+o"])

    def test_only_above_1080_selects_nothing(self):
        formats = [self.fmt("v2160", 2160, vcodec="vp9", acodec="opus", ext="webm")]
        self.assertEqual(self.select(formats), [])

    def test_progressive_h264_above_cap_selects_nothing(self):
        formats = [self.fmt("p2160", 2160, acodec="mp4a.40.2")]
        self.assertEqual(self.select(formats), [])

    def test_unknown_height_progressive_is_accepted(self):
        formats = [self.fmt("p", None, acodec="mp4a.40.2")]
        self.assertEqual(self.select(formats), ["p"])


class FormatOrientationTest(unittest.TestCase):
    """Teto de 1080p vale pelo lado menor (achado do consultor na issue #6): video vertical
    1080x1920 e 1080p. Usa o pipeline real do yt-dlp (process_ie_result sem download), que
    calcula aspect_ratio a partir de width/height como em producao."""

    def pick(self, formats):
        info = {"id": "v", "title": "v", "extractor": "test", "extractor_key": "Test",
                "webpage_url": "https://example.invalid/", "formats": formats}
        with yt_dlp.YoutubeDL({"quiet": True, "format": app.FORMAT, "simulate": True}) as ydl:
            result = ydl.process_ie_result(info, download=False)
        return result["format_id"]

    def fmt(self, fid, width, height, vcodec="avc1.640028", acodec="none", ext="mp4"):
        return {"format_id": fid, "width": width, "height": height, "vcodec": vcodec, "acodec": acodec,
                "ext": ext, "url": f"https://example.invalid/{fid}", "protocol": "https"}

    def audio(self):
        return {"format_id": "a", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a",
                "url": "https://example.invalid/a", "protocol": "https"}

    def test_vertical_h264_takes_1080_wide_not_540(self):
        formats = [self.audio(), self.fmt("h540", 540, 960), self.fmt("h1080", 1080, 1920), self.fmt("h2160", 2160, 3840)]
        self.assertEqual(self.pick(formats), "h1080+a")

    def test_vertical_reel_like_instagram_takes_720x1280(self):
        formats = [self.audio(), self.fmt("d480", 480, 854), self.fmt("d720", 720, 1280)]
        self.assertEqual(self.pick(formats), "d720+a")

    def test_vertical_without_h264_respects_width_cap(self):
        opus = {"format_id": "o", "vcodec": "none", "acodec": "opus", "ext": "webm",
                "url": "https://example.invalid/o", "protocol": "https"}
        formats = [opus, self.fmt("v1080", 1080, 1920, vcodec="vp9", ext="webm"),
                   self.fmt("v2160", 2160, 3840, vcodec="vp9", ext="webm")]
        self.assertEqual(self.pick(formats), "v1080+o")

    def test_landscape_unchanged(self):
        formats = [self.audio(), self.fmt("h1080", 1920, 1080), self.fmt("h2160", 3840, 2160)]
        self.assertEqual(self.pick(formats), "h1080+a")

    def test_square_capped_at_1080(self):
        formats = [self.audio(), self.fmt("s1080", 1080, 1080), self.fmt("s1440", 1440, 1440)]
        self.assertEqual(self.pick(formats), "s1080+a")

    def test_near_square_vertical_rounding_to_one_is_still_capped_by_width(self):
        """Achado P3 do Astra no PR #7: 1080x1084 arredonda aspect_ratio para 1.0."""
        formats = [self.audio(), self.fmt("q1080", 1080, 1084), self.fmt("q540", 540, 542)]
        self.assertEqual(self.pick(formats), "q1080+a")

    def test_near_square_landscape_rounding_to_one_is_capped_by_height(self):
        formats = [self.audio(), self.fmt("q1084", 1084, 1080), self.fmt("q1446", 1446, 1440)]
        self.assertEqual(self.pick(formats), "q1084+a")

    def test_vertical_above_cap_only_selects_nothing(self):
        formats = [self.fmt("p2160", 2160, 3840, acodec="mp4a.40.2")]
        with self.assertRaises(ExtractorError):
            self.pick(formats)


class TransientTest(unittest.TestCase):
    def dl_error(self, cause=None, msg="ERROR: falhou"):
        exc_info = (type(cause), cause, None) if cause is not None else None
        return DownloadError(msg, exc_info)

    def test_network_and_server_errors_are_transient(self):
        from yt_dlp.networking.exceptions import HTTPError, TransportError

        class Resp:
            def __init__(self, status):
                self.status = status
                self.reason = "x"
                self.headers = {}
                self.url = "https://x"

            def close(self):
                pass

        cases = [
            self.dl_error(TransportError("reset")),
            self.dl_error(TimeoutError("read timed out")),
            self.dl_error(ConnectionResetError("reset by peer")),
            self.dl_error(HTTPError(Resp(503))),
            self.dl_error(HTTPError(Resp(429))),
            self.dl_error(ExtractorError("Unable to download webpage", cause=TransportError("x"))),
            DownloadError("ERROR: [youtube] abc: The read operation timed out"),
        ]
        for exc in cases:
            with self.subTest(exc=str(exc.exc_info[1] if exc.exc_info else exc)):
                self.assertTrue(app.is_transient(exc))

    def test_content_errors_are_terminal(self):
        from yt_dlp.networking.exceptions import HTTPError

        class Resp:
            status = 404
            reason = "Not Found"
            headers: dict = {}
            url = "https://x"

            def close(self):
                pass

        cases = [
            self.dl_error(ExtractorError("Video unavailable", expected=True)),
            self.dl_error(ExtractorError("Sign in to confirm you're not a bot", expected=True)),
            self.dl_error(HTTPError(Resp())),
            DownloadError("ERROR: [twitter] 1: No video could be found in this tweet"),
            DownloadError("ERROR: No suitable extractor found for URL http://127.0.0.1"),
        ]
        for exc in cases:
            with self.subTest(exc=str(exc)):
                self.assertFalse(app.is_transient(exc))


class FragmentTest(unittest.TestCase):
    """I3: download HLS real (HlsFD do yt-dlp instalado) contra servidor local em que o segundo
    fragmento responde 503. Com as opcoes do app, o download falha; nunca gera arquivo parcial."""

    @classmethod
    def setUpClass(cls):
        from http.server import BaseHTTPRequestHandler

        class Hls(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/v.m3u8":
                    body = (
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n"
                        "#EXTINF:1.0,\n/f0.ts\n#EXTINF:1.0,\n/f1.ts\n#EXTINF:1.0,\n/f2.ts\n#EXT-X-ENDLIST\n"
                    ).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/vnd.apple.mpegurl")
                elif self.path == "/ok.m3u8":
                    body = (
                        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n"
                        "#EXTINF:1.0,\n/f0.ts\n#EXTINF:1.0,\n/f2.ts\n#EXTINF:1.0,\n/f0.ts\n#EXT-X-ENDLIST\n"
                    ).encode()
                    self.send_response(200)
                    self.send_header("content-type", "application/vnd.apple.mpegurl")
                elif self.path == "/f1.ts":
                    body = b"indisponivel"
                    self.send_response(503)
                elif self.path in ("/f0.ts", "/f2.ts"):
                    body = (b"A" if self.path == "/f0.ts" else b"C") * 188
                    self.send_response(200)
                else:
                    body = b""
                    self.send_response(404)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Hls)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def run_hls(self, overrides, playlist="/v.m3u8"):
        with tempfile.TemporaryDirectory() as d:
            opts = {**app.build_options("x", d), "retries": 0, "fragment_retries": 0, "socket_timeout": 5, **overrides}
            opts.pop("allowed_extractors")
            info = {
                "id": "hls",
                "title": "hls",
                "extractor": "test",
                "extractor_key": "Test",
                "webpage_url": self.base + "/",
                "formats": [{"format_id": "hls", "url": self.base + playlist, "protocol": "m3u8_native",
                             "ext": "mp4", "vcodec": "avc1.4d401f", "acodec": "mp4a.40.2", "height": 720}],
            }
            with RealYoutubeDL(opts) as ydl:
                try:
                    ydl.process_ie_result(info, download=True)
                except DownloadError as exc:
                    return "erro", str(exc)
            files = {f: os.path.getsize(os.path.join(d, f)) for f in os.listdir(d) if not f.endswith(".part")}
            return "arquivo", files

    def test_app_options_fail_instead_of_skipping_fragment(self):
        kind, detail = self.run_hls({})
        self.assertEqual(kind, "erro", detail)
        # o motivo e o 503 do fragmento, nao outra falha qualquer
        self.assertIn("503", detail)

    def test_control_skipping_fragments_would_produce_partial_file(self):
        kind, detail = self.run_hls({"skip_unavailable_fragments": True})
        self.assertEqual(kind, "arquivo", detail)
        # so os fragmentos 0 e 2: 2 x 188 bytes, o buraco que I3 proibe
        self.assertEqual(list(detail.values()), [376], detail)

    def test_healthy_hls_with_app_options_downloads_every_fragment(self):
        kind, detail = self.run_hls({}, playlist="/ok.m3u8")
        self.assertEqual(kind, "arquivo", detail)
        self.assertEqual(list(detail.values()), [564], detail)


class CarouselTest(unittest.TestCase):
    """Carrossel do Instagram: o yt-dlp real processa um playlist em que o primeiro item e foto
    (sem formatos). O app baixa o primeiro item com video, e so ele."""

    @classmethod
    def setUpClass(cls):
        from http.server import BaseHTTPRequestHandler

        class Media(BaseHTTPRequestHandler):
            hits: list = []

            def do_GET(self):
                Media.hits.append(self.path)
                body = (b"2" if self.path == "/v2.mp4" else b"3") * 4096
                self.send_response(200)
                self.send_header("content-type", "video/mp4")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        cls.media = Media
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Media)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def carousel(self):
        def video(n):
            return {
                "id": f"v{n}",
                "title": f"Video {n}",
                "formats": [{"format_id": "mp4", "url": f"{self.base}/v{n}.mp4", "ext": "mp4",
                             "vcodec": "avc1.4d401f", "acodec": "mp4a.40.2", "height": 720, "protocol": "http"}],
            }

        photo = {"id": "p1", "title": "Foto", "formats": [], "thumbnails": [{"url": f"{self.base}/p1.jpg"}]}
        return {
            "_type": "playlist",
            "id": "post",
            "title": "Post by someone",
            "extractor": "Instagram",
            "extractor_key": "Instagram",
            "webpage_url": "https://www.instagram.com/p/post/",
            "entries": [photo, video(2), video(3)],
        }

    def test_first_video_of_carousel_is_downloaded_even_after_photo(self):
        info = self.carousel()

        class CarouselYDL(RealYoutubeDL):
            def extract_info(inner, url, download=True):  # noqa: N805
                return inner.process_ie_result(info, download=download)

        self.media.hits.clear()
        with tempfile.TemporaryDirectory() as d, mock.patch.object(app.yt_dlp, "YoutubeDL", CarouselYDL):
            result = app.download("https://www.instagram.com/p/post/", "instagram", d)
            with open(result["path"], "rb") as fh:
                self.assertEqual(fh.read(1), b"2")
        self.assertEqual(result["title"], "Video 2")
        self.assertEqual(self.media.hits, ["/v2.mp4"])

    def test_carousel_without_video_is_a_terminal_failure(self):
        info = self.carousel()
        info["entries"] = [info["entries"][0]]

        class CarouselYDL(RealYoutubeDL):
            def extract_info(inner, url, download=True):  # noqa: N805
                return inner.process_ie_result(info, download=download)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(app.yt_dlp, "YoutubeDL", CarouselYDL):
            with self.assertRaises(app.DownloadFailed) as ctx:
                app.download("https://www.instagram.com/p/post/", "instagram", d)
        self.assertFalse(ctx.exception.transient)


def make_video(path, vcodec, seconds=2, size="320x240", acodec="libopus"):
    """Gera um video real com o ffmpeg do sistema (sem rede)."""
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size={size}:rate=25"]
    if acodec:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    cmd += ["-c:v", vcodec]
    if vcodec == "libvpx-vp9":
        cmd += ["-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k"]
    if acodec:
        cmd += ["-c:a", acodec]
    cmd += ["-shortest", path]
    subprocess.run(cmd, check=True)
    return path


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name",
                          "-of", "json", path], check=True, capture_output=True, text=True).stdout
    return {(s["codec_type"], s["codec_name"]) for s in json.loads(out)["streams"]}


class EnsureH264Test(unittest.TestCase):
    """Conversao para H.264 decidida pelo ffprobe do arquivo final (issue #6, decisao do consultor):
    o arquivo sai H.264+AAC, ou sai o original com aviso quando a conversao nao cabe no prazo."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))

    def test_h264_passes_untouched(self):
        src = make_video(os.path.join(self.dir, "a.mp4"), "libx264", acodec="aac")
        path, warning = app.ensure_h264(src, time.monotonic() + 60, self.dir)
        self.assertEqual(path, src)
        self.assertIsNone(warning)

    def test_vp9_opus_becomes_h264_aac_and_original_is_removed(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        path, warning = app.ensure_h264(src, time.monotonic() + 120, self.dir)
        self.assertIsNone(warning)
        self.assertNotEqual(path, src)
        self.assertEqual(probe(path), {("video", "h264"), ("audio", "aac")})
        self.assertFalse(os.path.exists(src))

    def test_vp9_without_audio_converts_video_only(self):
        src = make_video(os.path.join(self.dir, "s.mp4"), "libvpx-vp9", acodec=None)
        path, warning = app.ensure_h264(src, time.monotonic() + 120, self.dir)
        self.assertIsNone(warning)
        self.assertEqual(probe(path), {("video", "h264")})

    def test_no_time_left_returns_original_with_warning(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        path, warning = app.ensure_h264(src, time.monotonic() + 1, self.dir)
        self.assertEqual(path, src)
        self.assertIn("VP9", warning)
        self.assertIn("H.264", warning)
        self.assertEqual(probe(path), {("video", "vp9"), ("audio", "opus")})

    def test_projection_over_deadline_kills_ffmpeg_and_keeps_original(self):
        src = make_video(os.path.join(self.dir, "long.mp4"), "libvpx-vp9", seconds=40, size="1280x720")
        before = os.path.getsize(src)
        # ffmpeg preso a um nucleo: a conversao inteira leva bem mais que o prazo de 8 s, entao
        # so a projecao explica uma desistencia em menos de 5 s.
        slow = os.path.join(self.dir, "ffmpeg-slow")
        with open(slow, "w") as fh:
            fh.write('#!/bin/sh\nexec taskset -c 0 ffmpeg -threads 1 "$@"\n')
        os.chmod(slow, 0o755)
        started = time.monotonic()
        with mock.patch.object(app, "MIN_CONVERT_S", 0), mock.patch.object(app, "MIN_PROJECTION_S", 1), \
                mock.patch.object(app, "FFMPEG", slow):
            path, warning = app.ensure_h264(src, started + 8, self.dir)
        self.assertLess(time.monotonic() - started, 5, "deveria desistir pela projecao, sem esperar o prazo")
        self.assertEqual(path, src)
        self.assertEqual(os.path.getsize(src), before)
        self.assertIn("tempo", warning)
        leftovers = [f for f in os.listdir(self.dir) if f not in ("long.mp4", "ffmpeg-slow")]
        self.assertEqual(leftovers, [], "saida parcial da conversao deve ser apagada")

    def script(self, name, body):
        path = os.path.join(self.dir, name)
        with open(path, "w") as fh:
            fh.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        return path

    def test_silent_ffmpeg_is_killed_at_deadline(self):
        """Achado P1 do Astra (PR #8): ffmpeg vivo e sem progresso nao pode segurar o prazo."""
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        pidfile = os.path.join(self.dir, "pid")
        silent = self.script("ffmpeg-silent", f'echo $$ > {pidfile}; exec sleep 30')
        started = time.monotonic()
        with mock.patch.object(app, "MIN_CONVERT_S", 0), mock.patch.object(app, "FFMPEG", silent):
            path, warning = app.ensure_h264(src, started + 2, self.dir)
        self.assertLess(time.monotonic() - started, 3.5)
        self.assertEqual(path, src)
        self.assertIn("tempo", warning)
        with open(pidfile) as fh:
            pid = int(fh.read())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_slow_probe_is_bounded_by_deadline(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        slow = self.script("ffprobe-slow", "exec sleep 30")
        started = time.monotonic()
        with mock.patch.object(app, "FFPROBE", slow):
            path, warning = app.ensure_h264(src, started + 1.5, self.dir)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(path, src)
        self.assertIsNotNone(warning)

    def test_expired_deadline_returns_at_once_without_running_anything(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        started = time.monotonic()
        nothing = AssertionError("nada deveria rodar com o prazo vencido")
        with mock.patch.object(app, "_probe", side_effect=nothing), \
                mock.patch.object(app.subprocess, "Popen", side_effect=nothing):
            path, warning = app.ensure_h264(src, started - 1, self.dir)
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(path, src)
        self.assertIsNotNone(warning)

    def test_ffmpeg_failure_keeps_original_with_warning(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        with mock.patch.object(app, "FFMPEG", "false"):
            path, warning = app.ensure_h264(src, time.monotonic() + 60, self.dir)
        self.assertEqual(path, src)
        self.assertIn("falhou", warning)


class DeliveryMetaTest(unittest.TestCase):
    """Codec de origem e resolucao entregue (follow-up #5): o smoke prova a conversao e a UI mostra
    a resolucao real, que pode ser menor que 1080p quando so ha H.264 abaixo disso."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))

    def test_h264_reports_source_codec_and_size(self):
        src = make_video(os.path.join(self.dir, "a.mp4"), "libx264", size="640x360", acodec="aac")
        meta = {}
        path, warning = app.ensure_h264(src, time.monotonic() + 60, self.dir, meta)
        self.assertEqual((path, warning), (src, None))
        self.assertEqual(meta, {"source_codec": "h264", "width": 640, "height": 360})

    def test_converted_reports_vp9_source_and_output_size(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9", size="320x240")
        meta = {}
        path, warning = app.ensure_h264(src, time.monotonic() + 120, self.dir, meta)
        self.assertIsNone(warning)
        self.assertEqual(meta, {"source_codec": "vp9", "width": 320, "height": 240})

    def test_converted_reports_output_size_after_rotation(self):
        """Astra P3 e Kimi P2 (R1 do PR #14): a conversao aplica a rotacao; vale o tamanho da saida."""
        plain = make_video(os.path.join(self.dir, "p.mp4"), "libvpx-vp9", size="320x240")
        for degrees in ("90", "270"):
            with self.subTest(rotation=degrees):
                src = os.path.join(self.dir, f"r{degrees}.mp4")
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-display_rotation", degrees, "-i", plain, "-c", "copy",
                                src], check=True)
                meta = {}
                path, warning = app.ensure_h264(src, time.monotonic() + 120, self.dir, meta)
                self.assertIsNone(warning)
                self.assertEqual(meta, {"source_codec": "vp9", "width": 240, "height": 320})
                os.remove(path)

    def test_original_with_warning_still_reports_source(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9", size="320x240")
        meta = {}
        path, warning = app.ensure_h264(src, time.monotonic() + 1, self.dir, meta)
        self.assertEqual(path, src)
        self.assertIsNotNone(warning)
        self.assertEqual(meta, {"source_codec": "vp9", "width": 320, "height": 240})

    def test_file_without_video_stream_reports_nothing(self):
        src = os.path.join(self.dir, "a.m4a")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                        "-c:a", "aac", src], check=True)
        meta = {}
        path, warning = app.ensure_h264(src, time.monotonic() + 30, self.dir, meta)
        self.assertEqual((path, warning), (src, None))
        self.assertEqual(meta, {})

    def test_unverified_reports_nothing(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        meta = {}
        with mock.patch.object(app, "FFPROBE", "false"):
            path, warning = app.ensure_h264(src, time.monotonic() + 30, self.dir, meta)
        self.assertEqual(warning, app.UNVERIFIED)
        self.assertEqual(meta, {})


class ConversionRegressionTest(unittest.TestCase):
    """Regressoes permanentes dos casos verificados pelos revisores do PR #8 com harness temporario."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.dir, ignore_errors=True))

    def script(self, name, body):
        path = os.path.join(self.dir, name)
        with open(path, "w") as fh:
            fh.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        return path

    def test_hanging_output_probe_keeps_original_and_removes_output(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        before = os.path.getsize(src)
        count = os.path.join(self.dir, "probes")
        # primeiro probe (origem) responde; o da saida trava
        probe = self.script(
            "ffprobe-hang-2nd",
            f'n=$(cat {count} 2>/dev/null || echo 0); echo $((n+1)) > {count}; '
            f'[ "$n" -ge 1 ] && exec sleep 30; exec ffprobe "$@"',
        )
        started = time.monotonic()
        # MIN_CONVERT_S zerado: com o padrao de 10 s um prazo de 6 s nem comecaria a converter, e o
        # probe da saida nunca rodaria (P3 do Astra, R1 do PR #14).
        with mock.patch.object(app, "FFPROBE", probe), mock.patch.object(app, "MIN_CONVERT_S", 0):
            path, warning = app.ensure_h264(src, started + 6, self.dir)
        self.assertLess(time.monotonic() - started, 7.5)
        with open(count) as fh:
            self.assertEqual(int(fh.read()), 2, "o probe da saida precisa ter sido chamado")
        self.assertEqual(path, src)
        self.assertEqual(os.path.getsize(src), before)
        self.assertIn("tempo", warning)
        leftovers = [f for f in os.listdir(self.dir) if f.startswith("h264-")]
        self.assertEqual(leftovers, [], "saida da conversao deve ser apagada")

    def test_ffmpeg_flooding_stdout_does_not_deadlock(self):
        src = make_video(os.path.join(self.dir, "v.mp4"), "libvpx-vp9")
        # 8 MB no pipe de progresso antes de converter: sem leitor, o ffmpeg travaria no write
        flood = self.script("ffmpeg-flood", 'head -c 8000000 /dev/zero | tr "\\0" "x"; echo; exec ffmpeg "$@"')
        started = time.monotonic()
        with mock.patch.object(app, "FFMPEG", flood):
            path, warning = app.ensure_h264(src, started + 60, self.dir)
        self.assertLess(time.monotonic() - started, 30)
        self.assertIsNone(warning)
        self.assertEqual(probe(path), {("video", "h264"), ("audio", "aac")})


class LiveTest(unittest.TestCase):
    """Live em andamento ou agendada e recusada antes de baixar (follow-up #5): sem isso o yt-dlp
    baixa ate o prazo de 14 min e o job falha so no fim."""

    @classmethod
    def setUpClass(cls):
        from http.server import BaseHTTPRequestHandler

        class Media(BaseHTTPRequestHandler):
            hits: list = []

            def do_GET(self):
                Media.hits.append(self.path)
                body = b"v" * 4096
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        cls.media = Media
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Media)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def video(self, **extra):
        return {
            "id": "live1", "title": "Ao vivo", "extractor": "Youtube", "extractor_key": "Youtube",
            "webpage_url": "https://www.youtube.com/watch?v=live1",
            "formats": [{"format_id": "18", "url": f"{self.base}/v.mp4", "ext": "mp4", "protocol": "http",
                         "vcodec": "avc1.4d401f", "acodec": "mp4a.40.2", "height": 360}],
            **extra,
        }

    def run_download(self, info, platform="youtube"):
        class InfoYDL(RealYoutubeDL):
            def extract_info(inner, url, download=True):  # noqa: N805
                return inner.process_ie_result(info, download=download)

        url = {"youtube": "https://www.youtube.com/watch?v=live1", "instagram": "https://www.instagram.com/p/x/"}[platform]
        with tempfile.TemporaryDirectory() as d, mock.patch.object(app.yt_dlp, "YoutubeDL", InfoYDL):
            return app.download(url, platform, d)

    def test_live_in_progress_is_terminal_and_never_downloaded(self):
        for extra in ({"is_live": True, "live_status": "is_live"}, {"is_live": True}, {"live_status": "is_live"},
                      {"live_status": "is_upcoming"}):
            self.media.hits.clear()
            with self.subTest(extra=extra), self.assertRaises(app.DownloadFailed) as ctx:
                self.run_download(self.video(**extra))
            self.assertFalse(ctx.exception.transient)
            self.assertIn("live", str(ctx.exception).lower())
            self.assertEqual(self.media.hits, [])

    def test_finished_live_and_normal_video_download(self):
        for extra in ({}, {"is_live": False, "live_status": "was_live"}, {"live_status": "not_live"},
                      {"live_status": "post_live"}):
            self.media.hits.clear()
            with self.subTest(extra=extra):
                result = self.run_download(self.video(**extra))
                self.assertEqual(result["bytes"], 4096)
                self.assertEqual(self.media.hits, ["/v.mp4"])

    def carousel(self, *items):
        def video(n, **extra):
            return {
                "id": f"c{n}", "title": f"Item {n}",
                "formats": [{"format_id": "mp4", "url": f"{self.base}/c{n}.mp4", "ext": "mp4", "protocol": "http",
                             "vcodec": "avc1.4d401f", "acodec": "mp4a.40.2", "height": 360}],
                **extra,
            }

        entries = [video(n, **extra) for n, extra in items]
        return {"_type": "playlist", "id": "post", "title": "Post", "extractor": "Instagram",
                "extractor_key": "Instagram", "webpage_url": "https://www.instagram.com/p/x/", "entries": entries}

    def test_carousel_video_then_live_delivers_the_video(self):
        """R1 Kimi (PR #14): o item que o carrossel descarta nao pode virar recusa por live."""
        self.media.hits.clear()
        result = self.run_download(self.carousel((1, {}), (2, {"is_live": True, "live_status": "is_live"})), "instagram")
        self.assertEqual(result["title"], "Item 1")
        self.assertEqual(self.media.hits, ["/c1.mp4"])

    def test_carousel_live_first_stops_before_any_download(self):
        self.media.hits.clear()
        with self.assertRaises(app.DownloadFailed) as ctx:
            self.run_download(self.carousel((1, {"live_status": "is_live"}), (2, {})), "instagram")
        self.assertFalse(ctx.exception.transient)
        self.assertEqual(str(ctx.exception), app.LIVE_ERROR)
        self.assertEqual(self.media.hits, [])

    def test_instagram_keeps_carousel_filter_with_live_guard(self):
        opts = app.build_options("instagram", "/tmp")
        check = opts["match_filter"]
        self.assertIsNone(check({"id": "a", "live_status": "is_live"}, incomplete=True))
        with self.assertRaises(app.LiveRejected):
            check({"id": "a", "live_status": "is_live"})
        photo = {"id": "p", "formats": [{"vcodec": "none"}]}
        self.assertEqual(check(photo), "item sem video")


class SsrfTest(unittest.TestCase):
    def test_download_restricts_extractors_per_platform(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(app.yt_dlp, "YoutubeDL", FakeYDL):
            FakeYDL.behavior = "ok"
            app.download("https://x.com/a/status/1", "x", d)
            self.assertEqual(FakeYDL.last_opts["allowed_extractors"], ["twitter"])
            app.download("https://www.youtube.com/watch?v=jNQXAC9IVRw", "youtube", d)
            self.assertEqual(FakeYDL.last_opts["allowed_extractors"], ["youtube"])

    def test_instagram_loads_only_its_video_extractor(self):
        """allowed_extractors usa fullmatch: nada de instagram:story/user/tag."""
        expected = {"instagram": {"Instagram"}, "facebook": {"Facebook", "FacebookReel"}}
        for platform, names in expected.items():
            with self.subTest(platform=platform):
                with yt_dlp.YoutubeDL({"quiet": True, "allowed_extractors": app.ALLOWED_EXTRACTORS[platform]}) as ydl:
                    self.assertEqual(set(ydl._ies), names)

    def test_delegated_url_from_extractor_is_not_followed(self):
        """Reproduz o achado P1 do PR #3: o extrator do X devolve url_result para um link
        externo. Com a allowlist de extratores, o yt-dlp recusa sem fazer requisicao."""
        opts = {"quiet": True, "no_warnings": True, "allowed_extractors": app.ALLOWED_EXTRACTORS["x"]}
        with mock.patch("socket.create_connection", side_effect=AssertionError("nao deveria conectar")):
            with yt_dlp.YoutubeDL(opts) as ydl:
                with self.assertRaises(DownloadError) as ctx:
                    ydl.process_ie_result({"_type": "url", "url": "http://127.0.0.1:8080/health"}, download=False)
        self.assertIn("No suitable extractor", str(ctx.exception))


class NetworkGuardTest(unittest.TestCase):
    def fake_resolver(self, *ips):
        def resolver(host, *args, **kwargs):
            return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ips]
        return resolver

    def test_blocks_non_public_destinations(self):
        for ip in ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
                   "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]:
            with self.subTest(ip=ip), mock.patch.object(app, "_original_getaddrinfo", self.fake_resolver(ip)):
                with self.assertRaises(socket.gaierror):
                    app._public_getaddrinfo("alvo.example", 443)

    def test_keeps_only_public_addresses(self):
        with mock.patch.object(app, "_original_getaddrinfo", self.fake_resolver("10.0.0.1", "142.250.0.1", "2607:f8b0::1")):
            ips = [r[4][0] for r in app._public_getaddrinfo("www.youtube.com", 443)]
        self.assertEqual(ips, ["142.250.0.1", "2607:f8b0::1"])

    def test_install_replaces_socket_resolver(self):
        original = socket.getaddrinfo
        try:
            app.install_network_guard()
            self.assertIs(socket.getaddrinfo, app._public_getaddrinfo)
            with self.assertRaises(socket.gaierror):
                socket.getaddrinfo("127.0.0.1", 80)
        finally:
            socket.getaddrinfo = original


class DownloadTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        patcher = mock.patch.object(app.yt_dlp, "YoutubeDL", FakeYDL)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_success_returns_file_metadata_and_safe_options(self):
        FakeYDL.behavior = "ok"
        result = app.download("https://x.com/a/status/1", "x", self.dir)
        self.assertEqual(result["bytes"], 2048)
        self.assertEqual(result["ext"], "mp4")
        self.assertEqual(result["title"], "Título / com: chars?")
        self.assertTrue(FakeYDL.last_opts["noplaylist"])
        # I3: fragmento indisponivel nao pode virar arquivo parcial servido como sucesso
        self.assertIs(FakeYDL.last_opts.get("skip_unavailable_fragments"), False)
        self.assertEqual(FakeYDL.last_opts["merge_output_format"], "mp4")
        self.assertTrue(FakeYDL.last_opts["format"].startswith("bv*[vcodec^=avc1]"))

    def test_playlist_result_uses_first_real_entry(self):
        FakeYDL.behavior = "playlist"
        self.assertEqual(app.download("https://x.com/a/status/1", "x", self.dir)["bytes"], 2048)

    def test_ytdlp_error_becomes_readable_message(self):
        FakeYDL.behavior = "error"
        with self.assertRaises(app.DownloadFailed) as ctx:
            app.download("https://www.youtube.com/watch?v=jNQXAC9IVRw", "youtube", self.dir)
        self.assertEqual(str(ctx.exception), "[youtube] abc: Sign in to confirm you're not a bot")

    def test_no_file_is_a_failure(self):
        FakeYDL.behavior = "nofile"
        with self.assertRaises(app.DownloadFailed):
            app.download("https://x.com/a/status/1", "x", self.dir)


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        patcher = mock.patch.object(app.yt_dlp, "YoutubeDL", FakeYDL)
        patcher.start()
        self.addCleanup(patcher.stop)
        # O arquivo do FakeYDL nao e midia; a conversao tem testes proprios (EnsureH264Test).
        self.ensure_calls = []

        def fake_ensure(path, deadline, workdir, meta=None):
            self.ensure_calls.append((path, deadline, workdir))
            if meta is not None:
                meta.update(getattr(self, "meta", {}))
            if getattr(self, "convert", False):
                out = os.path.join(workdir, "h264-vid.mp4")
                with open(out, "wb") as fh:
                    fh.write(b"h" * 1000)
                os.remove(path)
                return out, None
            return path, getattr(self, "warning", None)

        ensure = mock.patch.object(app, "ensure_h264", side_effect=fake_ensure)
        ensure.start()
        self.addCleanup(ensure.stop)

    def post(self, body: bytes):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", "/download", body=body, headers={"content-type": "application/json"})
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp, data

    def test_health(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/health")
        self.assertEqual(conn.getresponse().status, 200)

    def test_success_streams_file_with_headers_and_cleans_workdir(self):
        FakeYDL.behavior = "ok"
        before = set(os.listdir(tempfile.gettempdir()))
        resp, data = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x"}).encode())
        self.assertEqual(resp.status, 200)
        self.assertEqual(len(data), 2048)
        self.assertEqual(resp.getheader("content-length"), "2048")
        self.assertEqual(urllib.parse.unquote(resp.getheader("x-title") or ""), "Título / com: chars?")
        self.assertEqual(resp.getheader("x-ext"), "mp4")
        # O handler apaga o workdir no finally, logo depois de enviar o corpo: aguarda ate 2 s.
        deadline = time.monotonic() + 2
        while True:
            leftovers = {p for p in set(os.listdir(tempfile.gettempdir())) - before if p.startswith("job-")}
            if not leftovers or time.monotonic() > deadline:
                break
            time.sleep(0.02)
        self.assertEqual(leftovers, set())

    def test_conversion_runs_with_deadline_from_budget_and_warning_goes_in_header(self):
        FakeYDL.behavior = "ok"
        self.warning = "Video em VP9: nao deu tempo de converter para H.264."
        started = time.monotonic()
        resp, data = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x", "budget_ms": 120000}).encode())
        self.assertEqual(resp.status, 200)
        self.assertEqual(len(data), 2048)
        self.assertEqual(urllib.parse.unquote(resp.getheader("x-warning") or ""), self.warning)
        [(path, deadline, workdir)] = self.ensure_calls
        self.assertTrue(path.startswith(workdir))
        self.assertAlmostEqual(deadline - started, 120, delta=2)

    def test_converted_file_is_the_one_streamed_with_its_own_length(self):
        FakeYDL.behavior = "ok"
        self.convert = True
        resp, data = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x"}).encode())
        self.assertEqual(resp.status, 200)
        self.assertEqual(data, b"h" * 1000)
        self.assertEqual(resp.getheader("content-length"), "1000")
        self.assertEqual(resp.getheader("x-ext"), "mp4")

    def test_source_codec_and_size_go_in_headers(self):
        FakeYDL.behavior = "ok"
        self.meta = {"source_codec": "vp9", "width": 1080, "height": 1920}
        resp, _ = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x"}).encode())
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.getheader("x-source-codec"), "vp9")
        self.assertEqual(resp.getheader("x-video-size"), "1080x1920")

    def test_no_meta_headers_when_probe_did_not_run(self):
        FakeYDL.behavior = "ok"
        resp, _ = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x"}).encode())
        self.assertIsNone(resp.getheader("x-source-codec"))
        self.assertIsNone(resp.getheader("x-video-size"))

    def test_no_warning_header_when_file_is_already_h264(self):
        FakeYDL.behavior = "ok"
        resp, _ = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x"}).encode())
        self.assertEqual(resp.status, 200)
        self.assertIsNone(resp.getheader("x-warning"))

    def test_ytdlp_failure_is_422_with_message(self):
        FakeYDL.behavior = "error"
        resp, data = self.post(
            json.dumps({"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "platform": "youtube"}).encode()
        )
        self.assertEqual(resp.status, 422)
        self.assertIn("Sign in to confirm", json.loads(data)["error"])

    def test_transient_ytdlp_failure_is_503(self):
        FakeYDL.behavior = "timeout"
        resp, data = self.post(
            json.dumps({"url": "https://www.youtube.com/watch?v=jNQXAC9IVRw", "platform": "youtube"}).encode()
        )
        self.assertEqual(resp.status, 503)
        self.assertEqual(json.loads(data), {"error": "[youtube] abc: The read operation timed out", "transient": True})

    def test_truncated_download_after_retries_is_503(self):
        FakeYDL.behavior = "truncated"
        resp, data = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x"}).encode())
        body = json.loads(data)
        self.assertEqual(resp.status, 503, body)
        self.assertTrue(body["transient"])
        self.assertIn("more expected", body["error"])

    def test_unexpected_exception_is_500_with_message_and_cleans_workdir(self):
        FakeYDL.behavior = "boom"
        before = set(os.listdir(tempfile.gettempdir()))
        resp, data = self.post(json.dumps({"url": "https://x.com/a/status/1", "platform": "x"}).encode())
        self.assertEqual(resp.status, 500)
        self.assertEqual(json.loads(data), {"error": "erro interno no container: RuntimeError: falha inesperada", "transient": True})
        deadline = time.monotonic() + 2
        while True:
            leftovers = {p for p in set(os.listdir(tempfile.gettempdir())) - before if p.startswith("job-")}
            if not leftovers or time.monotonic() > deadline:
                break
            time.sleep(0.02)
        self.assertEqual(leftovers, set())

    def test_main_installs_network_guard_before_serving(self):
        calls = []
        with mock.patch.object(app, "install_network_guard", side_effect=lambda: calls.append("guard")), \
                mock.patch.object(app, "ThreadingHTTPServer") as server:
            server.return_value.serve_forever.side_effect = lambda: calls.append("serve")
            app.main()
        self.assertEqual(calls, ["guard", "serve"])

    def test_invalid_json_and_disallowed_host_are_400(self):
        for body in (b"{nope", json.dumps({"url": "https://evil.com/", "platform": "x"}).encode()):
            with self.subTest(body=body):
                resp, _ = self.post(body)
                self.assertEqual(resp.status, 400)


if __name__ == "__main__":
    unittest.main()
