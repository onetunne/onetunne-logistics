import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from assistant_tools import llm_local as L  # noqa: E402
from assistant_tools import mtk  # noqa: E402
from assistant_tools.statusline import render  # noqa: E402
from assistant_tools.subs import Segment, Word, build_ass, compact_lines, group_words, read_srt, write_srt  # noqa: E402

HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


class Subs(unittest.TestCase):
    def test_srt_roundtrip_and_compact(self):
        segs = [Segment(0.5, 2.0, "Привіт"), Segment(2.5, 30.0, "довгий текст"), Segment(31.0, 33.0, "кінець")]
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "a.srt"
            write_srt(segs, p)
            back = read_srt(p)
        self.assertEqual([(round(s.start, 2), s.text) for s in back], [(0.5, "Привіт"), (2.5, "довгий текст"), (31.0, "кінець")])
        self.assertEqual(compact_lines(segs, 20)[0], "[0:00:00] Привіт")

    def test_tiktok_ass(self):
        words = [Word(0.0, 0.4, "Знижка"), Word(0.5, 0.9, "тридцять"), Word(1.0, 1.5, "відсотків!"), Word(2.0, 2.5, "Тільки")]
        groups = group_words(words)
        self.assertTrue(all(1 <= len(g) <= 3 for g in groups))
        self.assertEqual(groups[-1][0].word, "Тільки")  # "!" closes the previous group
        self.assertEqual(sum(len(g) for g in groups), 4)
        ass = build_ass(1080, 1920, [Segment(0, 2.5, "x", words)], "tiktok", offset=0.5, clip_duration=10, title="SALE")
        self.assertIn("PlayResY: 1920", ass)
        self.assertIn(r"{\c&H00FFFF&}ТРИДЦЯТЬ{\r}", ass)
        self.assertIn("Dialogue: 1,0:00:00.00,0:00:03.00,Title", ass)  # title starts at clip start, 3 s
        self.assertNotIn("0:00:-", ass)


class Status(unittest.TestCase):
    def test_render(self):
        line = render({"model": {"display_name": "Opus"}, "context_window": {"used_percentage": 42.4},
                       "rate_limits": {"five_hour": {"used_percentage": 81}, "seven_day": {"used_percentage": 10}}})
        self.assertIn("Opus", line)
        self.assertIn("42%", line)
        self.assertIn("81%", line)
        self.assertEqual(render({}), "")


class FakeOllama(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/tags":
            self._send({"models": [{"name": "qwen3.5:9b", "size": 6.6e9}, {"name": "gpt-oss:120b-cloud", "size": 0}]})
        elif self.path == "/api/version":
            self._send({"version": "0.20.0"})

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/api/show":
            self._send({"capabilities": ["completion", "vision"]})
        elif self.path == "/api/chat":
            FakeOllama.last = payload
            self._send({"message": {"content": "<think>hmm</think>товар"}})


class LocalLLM(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), FakeOllama)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.env = mock.patch.dict("os.environ", {"OLLAMA_HOST": f"127.0.0.1:{cls.srv.server_port}",
                                                 "ASSISTANT_HOME": tempfile.mkdtemp()})
        cls.env.start()

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.srv.shutdown()

    def test_pick_and_chat(self):
        self.assertEqual(L.pick_model("text"), "qwen3.5:9b")  # cloud model ignored
        self.assertEqual(L.pick_model("vision"), "qwen3.5:9b")
        self.assertEqual(L.chat("qwen3.5:9b", "?"), "товар")  # <think> stripped
        self.assertFalse(FakeOllama.last["think"])
        with self.assertRaises(L.Unavailable):
            L.pick_model("text", "gpt-oss:120b-cloud")

    def test_remote_host_refused_and_unavailable_exit(self):
        with mock.patch.dict("os.environ", {"OLLAMA_HOST": "http://192.168.1.50:11434"}):
            with self.assertRaises(L.Unavailable):
                L.installed()
        with mock.patch.dict("os.environ", {"OLLAMA_HOST": "127.0.0.1:9"}):
            self.assertEqual(L.main(["status"]), L.EXIT_UNAVAILABLE)


@unittest.skipUnless(HAS_FFMPEG, "ffmpeg не встановлено")
class MediaIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = Path(tempfile.mkdtemp())
        cls.video = cls.td / "src.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-f", "lavfi", "-i", "color=c=red:s=640x360:d=3:r=25",
                        "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=3:r=25",
                        "-f", "lavfi", "-i", "aevalsrc='if(lt(t,2),0.4,if(lt(t,3.5),0,0.6))*sin(2*PI*440*t)':s=48000:d=6",
                        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a",
                        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(cls.video)], check=True)
        cls.env = mock.patch.dict("os.environ", {"ASSISTANT_HOME": str(cls.td / "home")})
        cls.env.start()

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        shutil.rmtree(cls.td, ignore_errors=True)

    def test_pipeline(self):
        from assistant_tools import media as M
        info = M.probe(self.video)
        self.assertEqual((info.width, info.height, info.has_audio), (640, 360, True))
        self.assertAlmostEqual(info.duration, 6.0, delta=0.2)
        self.assertTrue(any(abs(t - 3.0) < 0.2 for t, _ in M.detect_scenes(self.video)))
        sil = M.detect_silence(self.video, duration=info.duration)
        self.assertTrue(any(abs(s - 2.0) < 0.2 for s, _ in sil))
        self.assertEqual(mtk.main(["cut", str(self.video), "--segments", "0:00.5-0:02,0:03.6-0:05.5", "--transition",
                                   "fade", "--tdur", "0.3", "--hw", "cpu", "-o", str(self.td / "cut.mp4")]), 0)
        self.assertAlmostEqual(M.probe(self.td / "cut.mp4").duration, 3.1, delta=0.25)
        self.assertEqual(mtk.main(["render", str(self.video), "--preset", "tiktok", "--title", "Тест", "--hw", "cpu",
                                   "-o", str(self.td / "v.mp4")]), 0)
        v = M.probe(self.td / "v.mp4")
        self.assertEqual((v.width, v.height), (1080, 1920))
        self.assertEqual(mtk.main(["render", str(self.video), "--preset", "tiktok", "-o", str(self.td / "v.mp4")]), 0)  # skip
        self.assertEqual(mtk.main(["timeline", str(self.video), "--segments", "0:01-0:02,0:04-0:05", "--dissolve", "0.4",
                                   "-o", str(self.td / "e.otio")]), 0)
        otio = json.loads((self.td / "e.otio").read_text(encoding="utf-8"))
        kinds = [c["OTIO_SCHEMA"] for c in otio["tracks"]["children"][0]["children"]]
        self.assertEqual(kinds, ["Clip.2", "Transition.1", "Clip.2"])


if __name__ == "__main__":
    unittest.main()
