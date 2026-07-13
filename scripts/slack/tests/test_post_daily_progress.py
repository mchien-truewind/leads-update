import contextlib
import importlib.util
import io
import os
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "post_daily_progress.py"
SPEC = importlib.util.spec_from_file_location("post_daily_progress", MODULE_PATH)
post_daily_progress = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(post_daily_progress)


class DailyProgressKillSwitchTests(unittest.TestCase):
    def test_parse_report_enabled_fails_closed(self):
        self.assertFalse(post_daily_progress.parse_report_enabled(None))
        self.assertFalse(post_daily_progress.parse_report_enabled(""))
        self.assertFalse(post_daily_progress.parse_report_enabled("false"))
        self.assertFalse(post_daily_progress.parse_report_enabled("yes"))
        self.assertTrue(post_daily_progress.parse_report_enabled(" true "))
        self.assertTrue(post_daily_progress.parse_report_enabled("1"))

    def test_main_skips_before_loading_credentials_when_disabled(self):
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, {"LEAD_REPORT_ENABLED": "false"}, clear=True):
            with mock.patch.object(post_daily_progress, "parse_args"):
                with contextlib.redirect_stdout(stdout):
                    self.assertEqual(post_daily_progress.main(), 0)
        self.assertIn("LEAD_REPORT_ENABLED is not true", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
