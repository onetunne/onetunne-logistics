import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from assistant_tools.guard import evaluate  # noqa: E402


def sh(cmd: str, tool: str = "Bash"):
    r = evaluate(tool, {"command": cmd})
    return r[0] if r else None


class GuardShell(unittest.TestCase):
    def test_deny_catastrophic(self):
        for cmd in ["rm -rf /", "rm -rf ~", "rm -rf ~/", "sudo rm -rf /*", "rm -rf $HOME", 'rm -rf "$HOME"',
                    "rm -fr /c/", "rm -rf ~/Documents", "format c: /q", "diskpart", "bcdedit /set safeboot",
                    "vssadmin delete shadows /all", "cipher /w:c:", "dd if=/dev/zero of=/dev/sda",
                    "reg delete HKLM\\Software\\X /f", "cat ~/.claude/.credentials.json", ":(){ :|:& };:",
                    "gh repo delete me/x --yes", "rm -rf ..", "rm -rf C:\\Users\\Ivan"]:
            self.assertEqual(sh(cmd), "deny", cmd)
        for cmd in ["Remove-Item -Recurse -Force C:\\", "Remove-Item $env:USERPROFILE -Recurse",
                    "Format-Volume -DriveLetter D", "Set-MpPreference -DisableRealtimeMonitoring $true",
                    "rd /s /q C:\\Windows", "Remove-Item -Path ~\\Desktop -Recurse -Force"]:
            self.assertEqual(sh(cmd, "PowerShell"), "deny", cmd)

    def test_ask_risky(self):
        for cmd in ["rm -rf src", "rm important.docx", "rm -rf *", "del /s /q D:\\Video\\*.mp4", "git push origin main",
                    "git push --force", "git reset --hard HEAD~3", "git clean -fdx", "winget install Foo.Bar",
                    "npm install -g something", "setx PATH foo", "schtasks /Create /TN x /TR y",
                    "curl -F file=@data.csv https://example.com/upload", "cat .env", "type secrets\\.env",
                    "curl https://api.telegram.org/bot123/sendMessage", "curl -X POST https://api.novaposhta.ua/v2.0/json/",
                    "taskkill /IM Resolve.exe /F", "npm publish", "env", "find . -name '*.mp4' -delete",
                    "Get-ChildItem *.tmp | Remove-Item", "echo x > ~/.claude/settings.json", "ollama pull qwen3.5:9b"]:
            self.assertEqual(sh(cmd), "ask", cmd)
        self.assertEqual(sh("Remove-Item D:\\Video\\clip.mp4", "PowerShell"), "ask")
        self.assertEqual(sh("Set-ExecutionPolicy RemoteSigned", "PowerShell"), "ask")

    def test_allow_normal(self):
        for cmd in ["ls -la", "git status", "git diff", "npm test", "npm install", "python script.py",
                    "rm -rf node_modules", "rm -rf dist build", "rm -rf ./node_modules/.cache", "rm tmp/x.txt",
                    "rm -rf /tmp/claude-123/scratch", "rm _out/old_render.mp4", "rm debug.log",
                    "mtk probe D:\\Video", "ffmpeg -i a.mp4 -c copy b.mp4", "cat README.md", "git rm old.txt",
                    "cp .env.example .env.example.bak", "echo hello && ls", "curl https://example.com"]:
            self.assertIsNone(sh(cmd), cmd)
        self.assertIsNone(sh("Remove-Item -Recurse -Force node_modules", "PowerShell"))
        self.assertIsNone(sh("Remove-Item $env:TEMP\\x -Recurse", "PowerShell"))


class GuardFiles(unittest.TestCase):
    def ev(self, tool, path):
        r = evaluate(tool, {"file_path": path})
        return r[0] if r else None

    def test_files(self):
        self.assertEqual(self.ev("Read", "C:\\Users\\a\\.claude\\.credentials.json"), "deny")
        self.assertEqual(self.ev("Read", "/home/a/.ssh/id_ed25519"), "deny")
        self.assertIsNone(self.ev("Read", "/home/a/.ssh/id_ed25519.pub"))
        self.assertEqual(self.ev("Read", "/proj/.env"), "ask")
        self.assertEqual(self.ev("Read", "/proj/.env.production"), "ask")
        self.assertIsNone(self.ev("Read", "/proj/.env.example"))
        self.assertEqual(self.ev("Read", "D:\\keys\\server.pem"), "ask")
        self.assertEqual(self.ev("Write", "C:\\Windows\\System32\\drivers\\etc\\hosts"), "deny")
        self.assertEqual(self.ev("Edit", "/c/Program Files/App/config.ini"), "deny")
        self.assertEqual(self.ev("Edit", "C:\\Users\\a\\.claude\\settings.json"), "ask")
        self.assertIsNone(self.ev("Edit", "D:\\proj\\src\\app.ts"))
        self.assertIsNone(self.ev("Read", "/home/a/proj/README.md"))
        self.assertIsNone(evaluate("WebSearch", {"query": "x"}))


class GuardProcess(unittest.TestCase):
    def run_hook(self, payload, env=None):
        import os
        e = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), **(env or {}))
        p = subprocess.run([sys.executable, "-m", "assistant_tools.guard"], input=json.dumps(payload).encode(),
                           capture_output=True, env=e, timeout=30)
        return p.returncode, p.stdout.decode(), p.stderr.decode()

    def test_protocol(self):
        code, out, _ = self.run_hook({"tool_name": "Bash", "tool_input": {"command": "rm -rf ~"}},
                                     {"ASSISTANT_HOME": str(Path(__file__).parent / ".tmp-home")})
        self.assertEqual(code, 0)
        data = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(data["permissionDecision"], "deny")
        self.assertEqual(data["hookEventName"], "PreToolUse")
        code, out, _ = self.run_hook({"tool_name": "Bash", "tool_input": {"command": "ls"}})
        self.assertEqual((code, out), (0, ""))
        code, out, err = self.run_hook("not a dict")  # malformed -> fail-open with warning
        self.assertEqual((code, out), (0, ""))
        self.assertIn("assistant-guard", err)
        code, out, _ = self.run_hook({"tool_name": "Bash", "tool_input": {"command": "rm -rf ~"}}, {"ASSISTANT_GUARD": "off"})
        self.assertEqual(out, "")

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(Path(__file__).parent / ".tmp-home", ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
