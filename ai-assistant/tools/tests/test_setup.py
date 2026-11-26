import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from assistant_tools import setup_cli as S  # noqa: E402
from assistant_tools.hardware import make_plan  # noqa: E402
from assistant_tools.redact import find_secrets, redact_json, redact_text  # noqa: E402

SRC = Path(__file__).resolve().parents[2]
CATALOG = json.loads((SRC / "config" / "models.json").read_text(encoding="utf-8"))


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.home = self.tmp / "home"
        (self.home / ".claude").mkdir(parents=True)
        self.patch = mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.home / ".claude"),
                                                  "ASSISTANT_HOME": str(self.home / ".claude-assistant"),
                                                  "HOME": str(self.home), "USERPROFILE": str(self.home)})
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def args(self, **kw):
        return mock.Mock(source=str(SRC), dry_run=False, **kw)


class Deploy(Env):
    def test_deploy_merge_idempotent_and_undeploy(self):
        ch = self.home / ".claude"
        user_settings = {"model": "sonnet", "permissions": {"allow": ["Bash(make *)"]},
                         "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "my-hook"}]}]},
                         "env": {"BASH_MAX_OUTPUT_LENGTH": "50000"}}
        (ch / "settings.json").write_text(json.dumps(user_settings), encoding="utf-8")
        (ch / "agents").mkdir()
        (ch / "agents" / "researcher.md").write_text("my own agent", encoding="utf-8")
        self.assertEqual(S.cmd_deploy(self.args()), 0)
        st = json.loads((ch / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(st["model"], "sonnet")
        self.assertIn("Bash(make *)", st["permissions"]["allow"])
        self.assertIn("Read(~/.claude/.credentials.json)", st["permissions"]["deny"])
        self.assertEqual(st["env"]["BASH_MAX_OUTPUT_LENGTH"], "50000")  # user value kept
        cmds = json.dumps(st["hooks"])
        self.assertIn("my-hook", cmds)
        self.assertIn("guard", cmds)
        self.assertIn("statusline", json.dumps(st["statusLine"]))
        self.assertTrue((ch / "rules" / "universal-assistant.md").exists())
        self.assertTrue((ch / "skills" / "video-production" / "reference" / "resolve.md").exists())
        self.assertIn(S.MARK, (ch / "agents" / "researcher.md").read_text(encoding="utf-8"))
        backups = list((self.home / ".claude-assistant" / "backups").rglob("researcher.md"))
        self.assertTrue(backups and backups[0].read_text(encoding="utf-8") == "my own agent")
        # idempotent: second deploy changes nothing, no duplicate hooks
        before = (ch / "settings.json").read_text(encoding="utf-8")
        S.cmd_deploy(self.args())
        self.assertEqual(before, (ch / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(json.dumps(st["hooks"]).count("guard"), 1)
        # undeploy removes ours, keeps the user's
        S.cmd_undeploy(self.args())
        st2 = json.loads((ch / "settings.json").read_text(encoding="utf-8"))
        self.assertIn("my-hook", json.dumps(st2))
        self.assertNotIn("guard", json.dumps(st2.get("hooks", {})))
        self.assertNotIn("statusLine", st2)
        self.assertIn("Bash(make *)", st2["permissions"]["allow"])
        self.assertFalse((ch / "rules" / "universal-assistant.md").exists())

    def test_dry_run_writes_nothing(self):
        S.cmd_deploy(mock.Mock(source=str(SRC), dry_run=True))
        self.assertFalse((self.home / ".claude" / "settings.json").exists())
        self.assertFalse((self.home / ".claude" / "rules").exists())


class BackupRestore(Env):
    def test_backup_has_no_secrets_and_restores(self):
        ch = self.home / ".claude"
        S.cmd_deploy(self.args())
        st = json.loads((ch / "settings.json").read_text(encoding="utf-8"))
        st["env"]["ANTHROPIC_API_KEY"] = "sk-ant-api03-" + "x" * 40
        (ch / "settings.json").write_text(json.dumps(st), encoding="utf-8")
        (ch / ".credentials.json").write_text('{"token":"secret-oauth"}', encoding="utf-8")
        (ch / "CLAUDE.md").write_text("Мої правила. github token ghp_" + "A" * 36, encoding="utf-8")
        (self.home / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "x@y.z"}, "mcpServers": {
            "gh": {"command": "npx", "args": ["-y", "srv", "--token", "abc123secret"], "env": {"GITHUB_TOKEN": "ghp_" + "B" * 36}},
            "remote": {"type": "http", "url": "https://x", "headers": {"Authorization": "Bearer abcdefghijklmnop1234"}}}}),
            encoding="utf-8")
        out = self.tmp / "out"
        self.assertEqual(S.cmd_backup(mock.Mock(out=str(out))), 0)
        z = next(out.glob("*.zip"))
        with zipfile.ZipFile(z) as zf:
            names = zf.namelist()
            blob = "\n".join(zf.read(n).decode("utf-8", "replace") for n in names)
        self.assertNotIn(".credentials.json", " ".join(names))
        for secret in ("sk-ant-api03", "ghp_", "abc123secret", "abcdefghijklmnop1234", "secret-oauth", "x@y.z"):
            self.assertNotIn(secret, blob, secret)
        self.assertIn("Мої правила", blob)
        self.assertEqual(find_secrets(blob), [])
        # restore onto a "new PC"
        shutil.rmtree(ch)
        ch.mkdir()
        self.assertEqual(S.cmd_restore(mock.Mock(backup=str(z), dry_run=False, source=None)), 0)
        self.assertTrue((ch / "CLAUDE.md").read_text(encoding="utf-8").startswith("Мої правила"))
        self.assertTrue((ch / "agents" / "video-editor.md").exists())
        restored = json.loads((ch / "settings.json").read_text(encoding="utf-8"))
        self.assertNotIn("guard", json.dumps(restored.get("hooks", {})))  # machine paths dropped; redeploy adds them
        S.cmd_deploy(self.args())
        self.assertIn("guard", (ch / "settings.json").read_text(encoding="utf-8"))

    def test_restore_rejects_zip_slip(self):
        bad = self.tmp / "bad.zip"
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("manifest.json", "{}")
            zf.writestr("../evil.txt", "x")
        with self.assertRaises(SystemExit):
            S.cmd_restore(mock.Mock(backup=str(bad), dry_run=False, source=None))


class Redact(unittest.TestCase):
    def test_patterns(self):
        txt, c = redact_text("key sk-ant-abc" + "1" * 30 + " shpat_" + "a" * 32 + " 123456789:" + "A" * 35)
        self.assertNotIn("sk-ant", txt)
        self.assertGreaterEqual(sum(c.values()), 3)
        obj, c = redact_json({"env": {"MY_SECRET": "v", "PATH": "/bin"}, "args": ["--api-key=zzz", "--x"], "authMethod": "oauth"})
        self.assertEqual(obj["env"]["PATH"], "/bin")
        self.assertTrue(obj["env"]["MY_SECRET"].startswith("<REDACTED"))
        self.assertEqual(obj["args"][0], "--api-key=<REDACTED:arg>")
        self.assertEqual(obj["authMethod"], "oauth")


class Plan(unittest.TestCase):
    def hw(self, ram, gpus, threads=8, disk=200):
        return {"ram_gb": ram, "gpus": gpus, "cpu_threads": threads, "disk_free_gb": disk, "os": "Windows",
                "os_release": "11", "cpu": "x"}

    def test_tiers(self):
        nv = lambda v: [{"name": "NVIDIA GeForce RTX", "vendor": "nvidia", "vram_gb": v, "integrated": False}]  # noqa: E731
        self.assertEqual(make_plan(self.hw(8, []), CATALOG)["llm"]["tier"], "none")
        self.assertEqual(make_plan(self.hw(16, []), CATALOG)["llm"]["tier"], "small")
        self.assertEqual(make_plan(self.hw(64, []), CATALOG)["llm"]["tier"], "small")  # CPU-only stays small
        self.assertEqual(make_plan(self.hw(16, nv(8)), CATALOG)["llm"]["tier"], "medium")
        p = make_plan(self.hw(32, nv(12)), CATALOG)
        self.assertEqual(p["llm"]["tier"], "medium")
        self.assertEqual(p["whisper"]["device"], "cuda")
        self.assertEqual(p["video_encoder_hint"], "nvenc")
        p = make_plan(self.hw(64, nv(24)), CATALOG)
        self.assertEqual(p["llm"]["tier"], "xlarge")
        self.assertEqual(p["llm"]["vision"], "gemma4:26b")
        self.assertEqual(make_plan(self.hw(64, nv(24), disk=25), CATALOG)["llm"]["tier"], "none")  # low disk
        igpu = [{"name": "Intel(R) UHD Graphics 770", "vendor": "intel", "vram_gb": 0.1, "integrated": True}]
        p = make_plan(self.hw(16, igpu, threads=4), CATALOG)
        self.assertEqual((p["llm"]["tier"], p["whisper"]["device"], p["video_encoder_hint"]), ("small", "cpu", "qsv"))


class StaticConfig(unittest.TestCase):
    def test_frontmatter_and_json(self):
        import re
        for f in list((SRC / "claude" / "agents").glob("*.md")) + list((SRC / "claude" / "skills").glob("*/SKILL.md")):
            text = f.read_text(encoding="utf-8")
            m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
            self.assertTrue(m, f)
            fm = m.group(1)
            self.assertIn(S.MARK, fm, f)
            self.assertRegex(fm, r"(?m)^name: [a-z-]+$")
            desc = re.search(r"(?m)^description: (.+)$", fm).group(1)
            self.assertNotIn(": ", desc, f"YAML-unsafe ': ' in description of {f}")
            self.assertLess(len(desc), 1000)
            self.assertNotRegex(fm, r"claude-(opus|sonnet|haiku|fable)-\d", "no model ids in files")
        for f in (SRC / "config").glob("*.json"):
            json.loads(f.read_text(encoding="utf-8"))
        json.loads((SRC / "claude" / "settings.template.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
