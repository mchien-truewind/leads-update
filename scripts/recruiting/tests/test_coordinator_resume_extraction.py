#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


RECRUITING_DIR = Path(__file__).resolve().parents[1]
if str(RECRUITING_DIR) not in sys.path:
    sys.path.insert(0, str(RECRUITING_DIR))

import coordinator_cli as cli  # noqa: E402


MULTI_ROLE_RESUME = """
Jordan Lee
jordan@example.com

Experience
Beta Analytics
Senior Product Manager
Jan 2021 - Present
- Owns revenue reporting workflows.

Acme Corp - Account Executive
2018 - 2020
- Closed mid-market deals.
"""


def _result_value(result, key: str):
    if isinstance(result, dict):
        if key == "title":
            return result.get("title") or result.get("latest_current_title")
        if key == "company":
            return result.get("company") or result.get("latest_current_company")
        return result.get(key)
    return getattr(result, key)


def _normalized_result(result) -> dict[str, object]:
    return {
        "title": _result_value(result, "title"),
        "company": _result_value(result, "company"),
        "confidence": _result_value(result, "confidence"),
        "evidence": _result_value(result, "evidence"),
    }


class MockResponse:
    def __init__(self, content: str, *, ok: bool = True, status_code: int = 200):
        self.ok = ok
        self.status_code = status_code
        self._content = content

    def json(self):
        return {"choices": [{"message": {"content": self._content}}]}


class ResumeExtractionHelperTests(unittest.TestCase):
    def _config(self) -> cli.Config:
        return build_config(
            openai_api_key="sk-test",
            resume_extractor_provider="openai",
            resume_extractor_model="gpt-test",
        )

    def _extract(self, extraction_json: str, source_text: str = MULTI_ROLE_RESUME) -> dict[str, object]:
        with mock.patch.object(cli, "requests", mock.Mock(post=mock.Mock(return_value=MockResponse(extraction_json)))):
            return cli.call_openai_resume_extractor(self._config(), source_text, "")

    def test_openai_response_parser_extracts_strict_json_fields(self):
        parsed = self._extract(
            '{"latest_current_title":"Senior Product Manager",'
            '"latest_current_company":"Beta Analytics",'
            '"confidence":"high",'
            '"evidence":"Beta Analytics\\nSenior Product Manager\\nJan 2021 - Present"}'
        )

        self.assertEqual(
            _normalized_result(parsed),
            {
                "title": "Senior Product Manager",
                "company": "Beta Analytics",
                "confidence": "high",
                "evidence": "Beta Analytics\nSenior Product Manager\nJan 2021 - Present",
            },
        )

    def test_acceptance_rejects_low_confidence_missing_fields_and_ungrounded_evidence(self):
        cases = {
            "low confidence": (
                '{"latest_current_title":"Senior Product Manager",'
                '"latest_current_company":"Beta Analytics",'
                '"confidence":"low",'
                '"evidence":"Senior Product Manager Jan 2021 - Present"}'
            ),
            "missing title": (
                '{"latest_current_title":"",'
                '"latest_current_company":"Beta Analytics",'
                '"confidence":"high",'
                '"evidence":"Senior Product Manager Jan 2021 - Present"}'
            ),
            "missing company": (
                '{"latest_current_title":"Senior Product Manager",'
                '"latest_current_company":"",'
                '"confidence":"high",'
                '"evidence":"Senior Product Manager Jan 2021 - Present"}'
            ),
            "ungrounded evidence": (
                '{"latest_current_title":"Senior Product Manager",'
                '"latest_current_company":"Beta Analytics",'
                '"confidence":"high",'
                '"evidence":"Chief Revenue Officer at Fabricated Co"}'
            ),
            "evidence missing company": (
                '{"latest_current_title":"Senior Product Manager",'
                '"latest_current_company":"Beta Analytics",'
                '"confidence":"high",'
                '"evidence":"Senior Product Manager Jan 2021 - Present"}'
            ),
        }

        for label, extraction_json in cases.items():
            with self.subTest(label=label):
                self.assertEqual(self._extract(extraction_json), {})

    def test_multi_role_resume_accepts_mocked_llm_result_only_when_evidence_is_grounded(self):
        heuristic_title, heuristic_company = cli.infer_current_title_and_company_from_resume(
            MULTI_ROLE_RESUME,
            "",
        )
        self.assertNotEqual((heuristic_title, heuristic_company), ("Senior Product Manager", "Beta Analytics"))

        with mock.patch.object(
            cli,
            "requests",
            mock.Mock(
                post=mock.Mock(
                    return_value=MockResponse(
                        '{"latest_current_title":"Senior Product Manager",'
                        '"latest_current_company":"Beta Analytics",'
                        '"confidence":"high",'
                        '"evidence":["Beta Analytics","Senior Product Manager","Jan 2021 - Present"]}'
                    )
                )
            ),
        ):
            self.assertEqual(
                cli.extract_latest_resume_role_company(self._config(), MULTI_ROLE_RESUME, ""),
                ("Senior Product Manager", "Beta Analytics"),
            )

        with mock.patch.object(
            cli,
            "requests",
            mock.Mock(
                post=mock.Mock(
                    return_value=MockResponse(
                        '{"latest_current_title":"Senior Product Manager",'
                        '"latest_current_company":"Made Up Labs",'
                        '"confidence":"high",'
                        '"evidence":"Made Up Labs Senior Product Manager Present"}'
                    )
                )
            ),
        ):
            self.assertEqual(cli.extract_latest_resume_role_company(self._config(), MULTI_ROLE_RESUME, ""), ("", ""))


def build_config(**overrides) -> cli.Config:
    values = {
        "notion_token": "notion",
        "notion_database_id": "db",
        "gmail_label_name": "ATS",
        "gmail_query": "",
        "gmail_max_messages": 1,
        "recruiter_sender_emails": set(),
        "recruiter_sender_names": set(),
        "hiring_alias": "hiring@example.com",
        "from_email": "hiring@example.com",
        "proceed_template": "",
        "reject_template": "",
        "scheduling_template": "",
        "no_response_template": "",
        "reject_delay_hours": 24,
        "reject_draft_auto_send_age_hours": 24,
        "name_verifier_provider": "",
        "name_verifier_model": "",
        "resume_extractor_provider": "off",
        "resume_extractor_model": "",
        "anthropic_api_key": "",
        "openai_api_key": "",
        "no_response_wait_days": 7,
        "assignment_keywords": set(),
        "sent_status_lookback_days": 7,
        "pipeline_label_name": "",
        "pdl_api_key": "",
        "slack_token": "xoxb-test",
        "slack_post_token": "xoxb-post-test",
        "slack_review_channel": "C123",
        "slack_mention_user_id": "",
        "slack_history_lookback_days": 7,
        "slack_proceed_reactions": {"white_check_mark"},
        "slack_reject_reactions": {"x"},
        "slack_forward_reactions": {"arrow_right"},
        "slack_allow_decision_override": False,
        "slack_state_file": Path(tempfile.gettempdir()) / "coordinator-test-slack-state.json",
        "forward_to_email": "",
        "property_map": cli.NotionPropertyMap(),
        "drive_folder_id": "",
        "timezone_name": "America/Los_Angeles",
        "slot_minutes": 20,
        "buffer_minutes": 10,
        "min_notice_hours": 24,
        "lookahead_days": 7,
        "weekdays": {0, 1, 2, 3, 4},
        "daily_start": cli.time(9, 0),
        "daily_end": cli.time(17, 0),
        "calendar_id": "primary",
    }
    values.update(overrides)
    return cli.Config(**values)


class SlackMentionBehaviorTests(unittest.TestCase):
    def _config(self) -> cli.Config:
        return build_config()

    def test_load_config_mention_default_targets_mercedes_and_can_be_disabled(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "U0ABULY5TEK")
        with mock.patch.dict(os.environ, {"RECRUITING_SLACK_MENTION_USER_ID": "none"}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "")
        with mock.patch.dict(os.environ, {"RECRUITING_SLACK_MENTION_USER_ID": "U123"}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "U123")

    def test_blank_slack_mention_user_id_does_not_fallback_to_auth_test(self):
        candidate = {
            "source": cli.SOURCE_INBOUND,
            "thread_id": "thread-1",
            "candidate_name": "Jordan Lee",
            "role": "Account Executive",
            "current_title": "Senior Product Manager",
            "company": "Beta Analytics",
            "location": "United States",
            "career_stage": "Experienced",
            "linkedin_url": "",
            "resume_url": "",
            "notion_url": "",
        }

        with tempfile.TemporaryDirectory() as tmpdir:
            config = self._config()
            config.slack_state_file = Path(tmpdir) / "slack-posted.json"

            with mock.patch.object(cli, "requests", mock.Mock()), mock.patch.object(
                cli, "load_recent_slack_posted_threads", return_value=(set(), {})
            ), mock.patch.object(
                cli.SlackClient, "resolve_channel_id", return_value="C123"
            ), mock.patch.object(cli.SlackClient, "auth_test", side_effect=AssertionError("auth_test fallback called")), mock.patch.object(
                cli.SlackClient, "get_message_permalink", return_value="https://truewind.slack.com/review"
            ), mock.patch.object(
                cli.SlackClient, "post_message", return_value={"ok": True, "ts": "123.456"}
            ) as post_message:
                posted, failed = cli.post_candidate_reviews_to_slack(config, [candidate])

        self.assertEqual((posted, failed), (1, 0))
        post_message.assert_called_once()
        _channel_id, fallback_text, blocks = post_message.call_args.args
        self.assertNotIn("<@", fallback_text)
        self.assertFalse(
            any("<@" in block.get("text", {}).get("text", "") for block in blocks),
            "blank slack_mention_user_id should not mention or auth-test the bot user",
        )


class ProceedRoleRoutingTests(unittest.TestCase):
    def test_growth_generalist_skips_custom_gpt_first_round(self):
        prop_map = cli.NotionPropertyMap()
        page_props = {
            prop_map.role: {
                "type": "multi_select",
                "multi_select": [{"name": "Growth Generalist"}],
            }
        }

        self.assertFalse(cli.uses_custom_gpt_first_round(page_props, prop_map))

    def test_bdr_and_ae_use_custom_gpt_first_round(self):
        prop_map = cli.NotionPropertyMap()
        for role in ("BDR", "AE"):
            with self.subTest(role=role):
                page_props = {
                    prop_map.role: {
                        "type": "multi_select",
                        "multi_select": [{"name": role}],
                    }
                }

                self.assertTrue(cli.uses_custom_gpt_first_round(page_props, prop_map))


class ActiveAtsDigestTests(unittest.TestCase):
    def _candidate(
        self,
        name: str,
        status: str,
        date_first_entered: str = "2026-06-01",
        thread_id: str = "",
        slack_review_url: str = "",
    ) -> dict[str, str]:
        return {
            "candidate_name": name,
            "role": "AE",
            "status": status,
            "notion_url": f"https://notion.so/{name.replace(' ', '-')}",
            "date_first_entered": date_first_entered,
            "thread_id": thread_id,
            "slack_review_url": slack_review_url,
        }

    def _digest_text(self, candidates: list[dict[str, str]]) -> str:
        blocks, fallback_text = cli.build_active_candidates_digest_blocks(
            heading="Daily ATS follow-up",
            mention_prefix="<@U123> ",
            candidates=candidates,
            slot_key="2026-06-08-monday-1700",
        )
        block_text = "\n".join(
            block.get("text", {}).get("text", "")
            for block in blocks
            if block.get("type") == "section"
        )
        return f"{fallback_text}\n{block_text}"

    def test_active_digest_shows_all_awaiting_decision_candidates_with_slack_links(self):
        candidates = [
            self._candidate(f"Needs Attention {idx:02d}", cli.STATUS_NEEDS_ATTENTION, f"2026-06-{idx + 1:02d}")
            for idx in range(2)
        ] + [
            self._candidate(
                f"Awaiting Decision {idx:02d}",
                cli.STATUS_AWAITING_DECISION,
                f"2026-06-{idx + 1:02d}",
                thread_id=f"gmail-{idx}",
                slack_review_url=f"https://truewind.slack.com/archives/C123/p{idx:016d}",
            )
            for idx in range(20)
        ] + [
            self._candidate(f"Waiting {idx:02d}", cli.STATUS_WAITING_ON_CUSTOM_GPT)
            for idx in range(2)
        ]

        text = self._digest_text(candidates)

        self.assertIn("Daily ATS follow-up: 22 need action, 24 active total.", text)
        self.assertIn("*Status summary:* Needs Attention: 2, Awaiting Decision: 20, Waiting on CustomGPT: 2", text)
        self.assertIn("<https://truewind.slack.com/archives/C123/p0000000000000000|Awaiting Decision 00>", text)
        self.assertIn("<https://truewind.slack.com/archives/C123/p0000000000000019|Awaiting Decision 19>", text)
        self.assertIn("<https://notion.so/Awaiting-Decision-19|ATS>", text)
        self.assertNotIn("more hidden", text)
        self.assertNotIn("Waiting 00", text)

    def test_active_digest_summarizes_non_action_statuses_without_candidate_dump(self):
        candidates = [
            self._candidate("Round One", cli.STATUS_ROUND_1_SCHEDULING),
            self._candidate("Scheduling Sent", cli.STATUS_SCHEDULING_SENT),
            self._candidate("Interviewing", cli.STATUS_INTERVIEW_IN_PROCESS),
            self._candidate("CustomGPT", cli.STATUS_WAITING_ON_CUSTOM_GPT),
        ]

        text = self._digest_text(candidates)

        self.assertIn("Daily ATS follow-up: 0 need action, 4 active total.", text)
        self.assertIn("No Needs Attention or Awaiting Decision candidates right now.", text)
        self.assertIn("Round 1 Scheduling: 1", text)
        self.assertIn("Scheduling Sent: 1", text)
        self.assertIn("Waiting on CustomGPT: 1", text)
        self.assertIn("Interview in Process: 1", text)
        self.assertNotIn("<https://notion.so/Round-One|Round One>", text)
        self.assertNotIn("<https://notion.so/CustomGPT|CustomGPT>", text)

    def test_slack_review_links_are_attached_by_gmail_thread_id(self):
        candidates = [
            self._candidate("Linked Candidate", cli.STATUS_AWAITING_DECISION, thread_id="thread-1"),
            self._candidate("Missing Link", cli.STATUS_AWAITING_DECISION, thread_id="thread-2"),
        ]

        enriched = cli.attach_slack_review_links(candidates, {"thread-1": "https://truewind.slack.com/review"})
        text = self._digest_text(enriched)

        self.assertIn("<https://truewind.slack.com/review|Linked Candidate>", text)
        self.assertIn("* <https://notion.so/Missing-Link|Missing Link> | Awaiting Decision | AE | review thread missing", text)


if __name__ == "__main__":
    unittest.main()
