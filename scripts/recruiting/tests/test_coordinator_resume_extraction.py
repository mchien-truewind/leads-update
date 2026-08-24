#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import email
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
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
        "custom_gpt_no_response_template": "",
        "custom_gpt_no_response_wait_hours": 48,
        "reject_delay_hours": 24,
        "reject_draft_auto_send_age_hours": 24,
        "name_verifier_provider": "",
        "name_verifier_model": "",
        "resume_extractor_provider": "off",
        "resume_extractor_model": "",
        "resume_extractor_model_anthropic": "",
        "anthropic_api_key": "",
        "openai_api_key": "",
        "no_response_wait_business_days": 7,
        "assignment_keywords": set(),
        "sent_status_lookback_days": 7,
        "pipeline_label_name": "",
        "pdl_api_key": "",
        "unipile_dsn": "",
        "unipile_api_key": "",
        "unipile_account_id": "",
        "slack_token": "xoxb-test",
        "slack_post_token": "xoxb-post-test",
        "slack_review_channel": "C123",
        "slack_mention_user_id": "",
        "slack_history_lookback_days": 7,
        "slack_proceed_reactions": {"white_check_mark"},
        "slack_reject_reactions": {"x"},
        "slack_forward_reactions": {"arrow_right"},
        "slack_allow_decision_override": False,
        "ats_follow_up_enabled": False,
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


class RejectionDraftIssueNotificationTests(unittest.TestCase):
    def _notify(self, config: cli.Config, **overrides) -> bool:
        values = {
            "draft_id": "r-legacy-1",
            "issue_key": "name_verification_failed",
            "heading": "Rejection draft name verification failed. Auto-send skipped.",
            "candidate_name": "Abdul Shaik",
            "candidate_email": "candidate@example.com",
            "details": ["*Draft greeting:* `Shaik`"],
            "notion_url": "https://notion.example/row",
        }
        values.update(overrides)
        return cli.notify_rejection_draft_issue(config, **values)

    def test_slack_history_suppresses_legacy_issue_after_local_state_reset(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = build_config(slack_state_file=Path(tmpdir) / "state.json")
            client = mock.Mock()
            client.resolve_channel_id.return_value = "C123"
            client.list_channel_messages.return_value = [{
                "text": "Rejection draft issue for candidate@example.com",
                "blocks": [{
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": (
                            "Rejection draft name verification failed. Auto-send skipped.\n"
                            "*Draft ID:* `r-legacy-1`"
                        ),
                    },
                }],
            }]

            with (
                mock.patch.object(cli, "slack_history_client", return_value=client),
                mock.patch.object(cli, "slack_post_client", return_value=client),
            ):
                self.assertFalse(self._notify(config))

            client.post_message.assert_not_called()
            self.assertIn(
                "name_verification_failed:r-legacy-1",
                cli.load_rejection_name_failure_notified_drafts(config.slack_state_file),
            )
            with mock.patch.object(
                cli,
                "slack_post_client",
                side_effect=AssertionError("history should not be reread after local rehydration"),
            ):
                self.assertFalse(self._notify(config))

    def test_marker_suppresses_exact_issue_but_not_different_issue_type(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = build_config(slack_state_file=Path(tmpdir) / "state.json")
            client = mock.Mock()
            client.resolve_channel_id.return_value = "C123"
            marker = cli.rejection_draft_issue_marker(
                "name_verification_failed", "r-legacy-1", "candidate@example.com"
            )
            client.list_channel_messages.return_value = [{
                "text": "older alert",
                "blocks": [{"type": "section", "block_id": marker}],
            }]

            with (
                mock.patch.object(cli, "slack_history_client", return_value=client),
                mock.patch.object(cli, "slack_post_client", return_value=client),
            ):
                self.assertFalse(self._notify(config))
                self.assertTrue(self._notify(
                    config,
                    issue_key="draft_missing",
                    heading="Rejection draft is missing. Auto-send skipped.",
                ))

            client.post_message.assert_called_once()
            posted_blocks = client.post_message.call_args.args[2]
            self.assertNotEqual(posted_blocks[0]["block_id"], marker)

    def test_unrelated_history_does_not_suppress_new_issue(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = build_config(slack_state_file=Path(tmpdir) / "state.json")
            client = mock.Mock()
            client.resolve_channel_id.return_value = "C123"
            client.list_channel_messages.return_value = [{
                "text": "Rejection draft issue for someone else",
                "blocks": [{
                    "type": "section",
                    "text": {
                        "type": "mrkdwn",
                        "text": (
                            "Rejection draft name verification failed. Auto-send skipped.\n"
                            "*Draft ID:* `r-other`"
                        ),
                    },
                }],
            }]

            with (
                mock.patch.object(cli, "slack_history_client", return_value=client),
                mock.patch.object(cli, "slack_post_client", return_value=client),
            ):
                self.assertTrue(self._notify(config))

            client.post_message.assert_called_once()

    def test_history_uses_read_token_and_post_uses_post_token(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            config = build_config(
                slack_token="xoxp-read",
                slack_post_token="xoxb-post",
                slack_state_file=Path(tmpdir) / "state.json",
            )
            history_client = mock.Mock()
            history_client.resolve_channel_id.return_value = "C123"
            history_client.list_channel_messages.return_value = []
            post_client = mock.Mock()

            with (
                mock.patch.object(cli, "slack_history_client", return_value=history_client),
                mock.patch.object(cli, "slack_post_client", return_value=post_client),
            ):
                self.assertTrue(self._notify(config))

            history_client.resolve_channel_id.assert_called_once_with(config.slack_review_channel)
            history_client.list_channel_messages.assert_called_once()
            history_client.post_message.assert_not_called()
            post_client.resolve_channel_id.assert_not_called()
            post_client.list_channel_messages.assert_not_called()
            post_client.post_message.assert_called_once()


def slack_candidate(thread_id: str) -> dict[str, str]:
    return {
        "source": cli.SOURCE_INBOUND,
        "thread_id": thread_id,
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


class SlackMentionBehaviorTests(unittest.TestCase):
    def _config(self) -> cli.Config:
        return build_config()

    def test_load_config_mention_default_is_blank_and_can_be_configured(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "")
        with mock.patch.dict(os.environ, {"RECRUITING_SLACK_MENTION_USER_ID": "none"}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "")
        with mock.patch.dict(os.environ, {"RECRUITING_SLACK_MENTION_USER_ID": "off"}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "")
        with mock.patch.dict(os.environ, {"RECRUITING_SLACK_MENTION_USER_ID": "false"}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "")
        with mock.patch.dict(os.environ, {"RECRUITING_SLACK_MENTION_USER_ID": "0"}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "")
        with mock.patch.dict(os.environ, {"RECRUITING_SLACK_MENTION_USER_ID": "U123"}, clear=True):
            self.assertEqual(cli.resolve_recruiting_slack_mention_user_id(), "U123")

    def test_blank_slack_mention_user_id_does_not_fallback_to_auth_test(self):
        candidate = slack_candidate("thread-1")

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

    def test_post_candidate_reviews_skips_threads_known_in_local_state(self):
        candidate = slack_candidate("thread-1")

        with tempfile.TemporaryDirectory() as tmpdir:
            config = self._config()
            config.slack_state_file = Path(tmpdir) / "slack-posted.json"
            cli.save_slack_posted_threads(config.slack_state_file, {"thread-1"})

            with mock.patch.object(cli, "requests", mock.Mock()), mock.patch.object(
                cli, "load_recent_slack_posted_threads", return_value=(set(), {})
            ), mock.patch.object(
                cli.SlackClient, "resolve_channel_id", return_value="C123"
            ), mock.patch.object(
                cli.SlackClient, "post_message", side_effect=AssertionError("old candidate reposted")
            ) as post_message:
                posted, failed = cli.post_candidate_reviews_to_slack(config, [candidate])

        self.assertEqual((posted, failed), (0, 0))
        post_message.assert_not_called()

    def test_post_candidate_reviews_skips_threads_seen_in_recent_slack_history(self):
        candidate = slack_candidate("thread-1")

        with tempfile.TemporaryDirectory() as tmpdir:
            config = self._config()
            config.slack_state_file = Path(tmpdir) / "slack-posted.json"

            with mock.patch.object(cli, "requests", mock.Mock()), mock.patch.object(
                cli, "load_recent_slack_posted_threads", return_value=({"thread-1"}, {})
            ), mock.patch.object(
                cli.SlackClient, "resolve_channel_id", return_value="C123"
            ), mock.patch.object(
                cli.SlackClient, "post_message", side_effect=AssertionError("recent candidate reposted")
            ) as post_message:
                posted, failed = cli.post_candidate_reviews_to_slack(config, [candidate])

        self.assertEqual((posted, failed), (0, 0))
        post_message.assert_not_called()

    def test_post_candidate_reviews_skips_superposition_source(self):
        candidate = slack_candidate("thread-1")
        candidate["source"] = " superposition "

        with tempfile.TemporaryDirectory() as tmpdir:
            config = self._config()
            config.slack_state_file = Path(tmpdir) / "slack-posted.json"

            with mock.patch.object(cli, "requests", mock.Mock()), mock.patch.object(
                cli, "load_recent_slack_posted_threads", return_value=(set(), {})
            ), mock.patch.object(
                cli.SlackClient, "resolve_channel_id", return_value="C123"
            ), mock.patch.object(
                cli.SlackClient, "post_message", side_effect=AssertionError("superposition candidate posted")
            ) as post_message:
                posted, failed = cli.post_candidate_reviews_to_slack(config, [candidate])

        self.assertEqual((posted, failed), (0, 0))
        post_message.assert_not_called()

    def test_ingest_slack_candidates_are_only_newly_created_candidates(self):
        created_candidates = [slack_candidate("new-thread")]

        selected = cli.select_ingest_review_candidates(created_candidates)

        self.assertEqual(selected, created_candidates)
        self.assertIsNot(selected, created_candidates)

    def test_ingest_slack_candidates_exclude_superposition_source(self):
        inbound = slack_candidate("inbound-thread")
        superposition = slack_candidate("superposition-thread")
        superposition["source"] = cli.SOURCE_SUPERPOSITION

        selected = cli.select_ingest_review_candidates([inbound, superposition])

        self.assertEqual(selected, [inbound])


class DurableSlackReconciliationTests(unittest.TestCase):
    @staticmethod
    def _schema(slack_type="url"):
        prop = cli.NotionPropertyMap()
        return {
            "properties": {
                prop.candidate_name: {"type": "title"}, prop.source: {"type": "select"},
                prop.status: {"type": "status"}, prop.decision: {"type": "select"},
                prop.gmail_thread_id: {"type": "rich_text"}, prop.slack_review_url: {"type": slack_type},
            }
        }

    @staticmethod
    def _page(page_id, *, source="Inbound", status="Awaiting Decision", decision="", thread="t1", receipt=""):
        prop = cli.NotionPropertyMap()
        return {"id": page_id, "properties": {
            prop.candidate_name: {"type": "title", "title": [{"plain_text": page_id}]},
            prop.source: {"type": "select", "select": {"name": source}},
            prop.status: {"type": "status", "status": {"name": status}},
            prop.decision: {"type": "select", "select": ({"name": decision} if decision else None)},
            prop.gmail_thread_id: {"type": "rich_text", "rich_text": ([{"plain_text": thread}] if thread else [])},
            prop.slack_review_url: {"type": "url", "url": receipt or None},
        }}

    def test_eligibility_excludes_non_inbound_decided_non_awaiting_missing_thread_and_receipt(self):
        pages = [
            self._page("eligible"), self._page("super", source="Superposition"),
            self._page("decided", decision="Proceed"), self._page("other", status="Needs Attention"),
            self._page("no-thread", thread=""), self._page("delivered", receipt="https://slack.test/p1"),
        ]
        notion = mock.Mock()
        notion.query_pages.return_value = pages
        selected = cli.collect_review_candidates_for_slack(notion, self._schema(), cli.NotionPropertyMap())
        self.assertEqual([item["page_id"] for item in selected], ["eligible"])

    def test_wrong_receipt_schema_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "must be type URL"):
            cli.ensure_slack_review_url_schema(mock.Mock(), self._schema("rich_text"), cli.NotionPropertyMap())

    def test_dry_run_missing_schema_does_not_create_property(self):
        notion = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "run --apply"):
            cli.ensure_slack_review_url_schema(
                notion, {"properties": {}}, cli.NotionPropertyMap(), create=False
            )
        notion.update_database.assert_not_called()

    def test_apply_creates_missing_url_schema(self):
        notion = mock.Mock()
        notion.update_database.return_value = self._schema()
        result = cli.ensure_slack_review_url_schema(notion, {"properties": {}}, cli.NotionPropertyMap())
        self.assertIn(cli.NotionPropertyMap().slack_review_url, result["properties"])
        notion.update_database.assert_called_once()

    def test_marker_history_is_fully_paginated_by_client_and_requires_permalink(self):
        client = mock.Mock()
        client.list_channel_messages.return_value = [{"text": "ATS_THREAD_ID:t1", "ts": "1.2"}]
        client.get_message_permalink.return_value = "https://slack.test/p1"
        self.assertEqual(cli.full_slack_marker_history(client, "C1"), {"t1": "https://slack.test/p1"})
        client.get_message_permalink.return_value = ""
        with self.assertRaisesRegex(RuntimeError, "no permalink"):
            cli.full_slack_marker_history(client, "C1")

    def test_permalink_uses_documented_get_transport(self):
        response = mock.Mock(ok=True, status_code=200)
        response.json.return_value = {"ok": True, "permalink": "https://slack.test/p1"}
        requests_mock = mock.Mock()
        requests_mock.get.return_value = response
        with mock.patch.object(cli, "requests", requests_mock):
            client = cli.SlackClient("xoxb-test")
            self.assertEqual(client.get_message_permalink("C1", "123.456"), "https://slack.test/p1")
        requests_mock.get.assert_called_once_with(
            "https://slack.com/api/chat.getPermalink",
            headers={"Authorization": "Bearer xoxb-test"},
            params={"channel": "C1", "message_ts": "123.456"},
            timeout=30,
        )

    def test_superposition_rules_and_quoted_only_hold(self):
        self.assertEqual(cli.classify_superposition_evidence("I am withdrawing", "candidate")[0], "Passed")
        self.assertEqual(
            cli.classify_superposition_evidence(
                "The comp is significantly lower than where I need to be. Good luck.", "candidate"
            )[0],
            "Passed",
        )
        self.assertNotEqual(
            cli.classify_superposition_evidence(
                "The compensation is significantly lower than I need; can you increase it? "
                "I can book time on your calendar to discuss.",
                "candidate",
            )[0],
            "Passed",
        )
        self.assertEqual(cli.classify_superposition_evidence("We will not be moving forward", "company")[0], "Rejected")
        self.assertEqual(cli.classify_superposition_evidence("We will not be moving forward", "candidate")[0], "")
        self.assertEqual(cli.classify_superposition_evidence("Please book a time on my calendar", "company")[0], "Round 1 Scheduling")
        self.assertEqual(cli.classify_superposition_evidence("Just following up", "candidate")[0], "Needs Attention")
        self.assertEqual(cli.classify_superposition_evidence("Please book a time on my calendar", "unknown")[0], "")
        self.assertEqual(cli.classify_superposition_evidence("Thanks for the update")[0], "")

    def test_digest_rerun_is_noop_when_marker_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            artifact = Path(tmpdir) / "digest.json"
            artifact.write_text(json.dumps({"items": [{
                "candidate_name": "Jordan", "thread_id": "t1", "slack_review_url": "https://slack.test/p1"
            }]}))
            args = argparse.Namespace(artifact=str(artifact), run_id="repair-1")
            client = mock.Mock()
            client.resolve_channel_id.return_value = "C1"
            client.list_channel_messages.return_value = [{"text": "ATS_AWAITING_DIGEST_RUN_ID:repair-1"}]
            with mock.patch.object(cli, "load_config", return_value=build_config()), mock.patch.object(
                cli, "slack_post_client", return_value=client
            ), mock.patch("builtins.print"):
                cli.post_awaiting_digest_cmd(args)
            client.post_message.assert_not_called()

    def test_recovered_marker_persists_receipt_without_posting(self):
        notion = mock.Mock()
        notion.query_pages.return_value = [self._page("p1")]
        client = mock.Mock()
        client.resolve_channel_id.return_value = "C1"
        with mock.patch.object(cli, "slack_post_client", return_value=client), mock.patch.object(
            cli, "full_slack_marker_history", return_value={"t1": "https://slack.test/p1"}
        ), mock.patch.object(cli, "post_candidate_reviews_to_slack") as post:
            result = cli.reconcile_slack_reviews(
                build_config(), notion, self._schema(), cli.NotionPropertyMap(), apply=True
            )
        self.assertEqual(len(result["recovered"]), 1)
        notion.update_page.assert_called_once()
        post.assert_not_called()

    def test_missing_marker_posts_then_persists_and_retries_after_receipt_failure(self):
        notion = mock.Mock()
        notion.query_pages.return_value = [self._page("p1")]
        notion.update_page.side_effect = RuntimeError("Notion unavailable")
        client = mock.Mock()
        client.resolve_channel_id.return_value = "C1"
        histories = [{}, {}, {"t1": "https://slack.test/p1"}]
        with mock.patch.object(cli, "slack_post_client", return_value=client), mock.patch.object(
            cli, "full_slack_marker_history", side_effect=histories
        ), mock.patch.object(cli, "post_candidate_reviews_to_slack", return_value=(1, 0)) as post:
            with self.assertRaisesRegex(RuntimeError, "Notion unavailable"):
                cli.reconcile_slack_reviews(
                    build_config(), notion, self._schema(), cli.NotionPropertyMap(), apply=True
                )
        post.assert_called_once()

        notion.update_page.side_effect = None
        with mock.patch.object(cli, "slack_post_client", return_value=client), mock.patch.object(
            cli, "full_slack_marker_history", return_value={"t1": "https://slack.test/p1"}
        ), mock.patch.object(cli, "post_candidate_reviews_to_slack") as repost:
            cli.reconcile_slack_reviews(
                build_config(), notion, self._schema(), cli.NotionPropertyMap(), apply=True
            )
        repost.assert_not_called()

    def test_history_failure_and_mutex_contention_fail_closed(self):
        notion = mock.Mock()
        notion.query_pages.return_value = [self._page("p1")]
        client = mock.Mock()
        client.resolve_channel_id.return_value = "C1"
        with mock.patch.object(cli, "slack_post_client", return_value=client), mock.patch.object(
            cli, "full_slack_marker_history", side_effect=RuntimeError("Slack unavailable")
        ), mock.patch.object(cli, "post_candidate_reviews_to_slack") as post:
            with self.assertRaisesRegex(RuntimeError, "Slack unavailable"):
                cli.reconcile_slack_reviews(
                    build_config(), notion, self._schema(), cli.NotionPropertyMap(), apply=True
                )
            post.assert_not_called()
        cli.SLACK_RECONCILIATION_MUTEX.acquire()
        try:
            with self.assertRaisesRegex(RuntimeError, "already running"):
                cli.reconcile_slack_reviews(
                    build_config(), notion, self._schema(), cli.NotionPropertyMap(), apply=True
                )
        finally:
            cli.SLACK_RECONCILIATION_MUTEX.release()


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


class CustomGptNoResponseDueTests(unittest.TestCase):
    def test_custom_gpt_no_response_is_due_after_configured_hours(self):
        assignment_sent_at = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)

        self.assertFalse(
            cli.custom_gpt_no_response_due(
                assignment_sent_at,
                assignment_sent_at + timedelta(hours=47, minutes=59),
                48,
            )
        )
        self.assertTrue(
            cli.custom_gpt_no_response_due(
                assignment_sent_at,
                assignment_sent_at + timedelta(hours=48),
                48,
            )
        )


class NoResponseTemplateTests(unittest.TestCase):
    def test_normal_no_response_uses_custom_gpt_closeout_language(self):
        self.assertEqual(
            cli.DEFAULT_NO_RESPONSE_TEMPLATE,
            cli.DEFAULT_CUSTOM_GPT_NO_RESPONSE_REJECTION_TEMPLATE,
        )

        rendered = cli.render_no_response_template(cli.DEFAULT_NO_RESPONSE_TEMPLATE, "Sam")

        self.assertIn("Hi Sam,", rendered)
        self.assertIn("Haven't heard from you in a while", rendered)
        self.assertIn("close the application", rendered)

    def test_no_response_sent_detector_matches_custom_gpt_closeout_language(self):
        body = cli.render_no_response_template(cli.DEFAULT_NO_RESPONSE_TEMPLATE, "Sam")

        self.assertRegex(body, cli.NO_RESPONSE_SENT_RE)


class NoResponseBusinessDayTests(unittest.TestCase):
    def test_add_business_days_skips_weekends(self):
        friday = datetime(2026, 6, 26, 12, 0, tzinfo=timezone.utc)

        due_at = cli.add_business_days(friday, 7, "America/Los_Angeles")

        self.assertEqual(due_at.date().isoformat(), "2026-07-07")

    def test_business_day_no_response_due_requires_no_reply(self):
        sent_at = datetime(2026, 6, 12, 18, 0, tzinfo=timezone.utc)
        now = datetime(2026, 6, 24, 18, 0, tzinfo=timezone.utc)

        self.assertTrue(
            cli.business_day_no_response_due(sent_at, None, now, 7, "America/Los_Angeles")
        )
        self.assertFalse(
            cli.business_day_no_response_due(
                sent_at,
                datetime(2026, 6, 13, 18, 0, tzinfo=timezone.utc),
                now,
                7,
                "America/Los_Angeles",
            )
        )


class EmailBodyFirstNameEvidenceTests(unittest.TestCase):
    def test_extracts_first_name_from_candidate_signoff(self):
        body = """Hi Mercedes,

Thanks for taking a look. I attached my resume.

Best,
Chun-Chi
"""

        self.assertEqual(cli.first_names_from_email_body(body), ["Chun-Chi"])

    def test_extracts_first_name_from_last_signature_line(self):
        body = """Hello,

I am interested in the AE role.

Aishwarya Babuji
"""

        self.assertEqual(cli.first_names_from_email_body(body), ["Aishwarya"])

    def test_ignores_names_only_present_in_quoted_email(self):
        body = """Hello,

I attached my resume.

On Mon, Jun 15, 2026 at 4:23 PM Mercedes Chien <mercedes@trytruewind.com> wrote:
Mercedes
"""

        self.assertEqual(cli.first_names_from_email_body(body), [])


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

    def _notion_schema(self) -> dict[str, object]:
        return {
            "properties": {
                "Candidate Name": {"type": "title"},
                "Source": {"type": "select"},
                "Role": {"type": "multi_select"},
                "Status": {"type": "select"},
                "Decision": {"type": "select"},
                "Gmail thread id": {"type": "rich_text"},
                "Date first entered": {"type": "date"},
            }
        }

    def _notion_page(
        self,
        name: str,
        source: str,
        *,
        status: str = cli.STATUS_AWAITING_DECISION,
        decision: str = "",
    ) -> dict[str, object]:
        return {
            "id": name.lower().replace(" ", "-"),
            "properties": {
                "Candidate Name": {"type": "title", "title": [{"plain_text": name}]},
                "Source": {"type": "select", "select": {"name": source.strip()} if source.strip() else None},
                "Role": {"type": "multi_select", "multi_select": [{"name": "AE"}]},
                "Status": {"type": "select", "select": {"name": status}},
                "Decision": {"type": "select", "select": {"name": decision} if decision else None},
                "Gmail thread id": {
                    "type": "rich_text",
                    "rich_text": [{"plain_text": f"thread-{name.lower().replace(' ', '-')}"}],
                },
                "Date first entered": {"type": "date", "date": {"start": "2026-06-01"}},
            },
        }

    def test_active_digest_collector_only_includes_inbound_source(self):
        class FakeNotion:
            def __init__(self, pages):
                self.pages = pages

            def query_pages(self, payload=None):
                return self.pages

        pages = [
            self._notion_page("Inbound One", cli.SOURCE_INBOUND),
            self._notion_page("Inbound Two", " inbound "),
            self._notion_page("Superposition Candidate", cli.SOURCE_SUPERPOSITION),
            self._notion_page("Blank Source", ""),
            self._notion_page("Referral Candidate", "Referral"),
        ]

        candidates = cli.collect_active_candidates_for_weekly_slack(
            FakeNotion(pages),
            self._notion_schema(),
            cli.NotionPropertyMap(),
        )

        self.assertEqual([candidate["candidate_name"] for candidate in candidates], ["Inbound One", "Inbound Two"])
        self.assertTrue(all(candidate["source"].strip().lower() == "inbound" for candidate in candidates))

    def test_no_response_status_is_terminal_and_excluded_from_active_digest(self):
        class FakeNotion:
            def __init__(self, pages):
                self.pages = pages

            def query_pages(self, payload=None):
                return self.pages

        self.assertTrue(cli.status_is_terminal(cli.STATUS_NO_RESPONSE))
        pages = [
            self._notion_page("Still Active", cli.SOURCE_INBOUND),
            self._notion_page("No Response Candidate", cli.SOURCE_INBOUND, status=cli.STATUS_NO_RESPONSE),
        ]

        candidates = cli.collect_active_candidates_for_weekly_slack(
            FakeNotion(pages),
            self._notion_schema(),
            cli.NotionPropertyMap(),
        )

        self.assertEqual([candidate["candidate_name"] for candidate in candidates], ["Still Active"])

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

    def test_scheduled_ats_follow_up_is_disabled_by_default(self):
        config = build_config(ats_follow_up_enabled=False)

        with mock.patch.object(
            cli,
            "post_weekly_active_candidates_digest",
            side_effect=AssertionError("scheduled digest posted while disabled"),
        ) as post_digest:
            result = cli.post_scheduled_ats_follow_up_if_enabled(
                config,
                notion=mock.Mock(),
                database_schema={},
                prop_map=cli.NotionPropertyMap(),
            )

        self.assertEqual(result, (0, 0))
        post_digest.assert_not_called()

    def test_scheduled_ats_follow_up_posts_when_explicitly_enabled(self):
        config = build_config(ats_follow_up_enabled=True)

        with mock.patch.object(cli, "post_weekly_active_candidates_digest", return_value=(1, 3)) as post_digest:
            result = cli.post_scheduled_ats_follow_up_if_enabled(
                config,
                notion=mock.Mock(),
                database_schema={},
                prop_map=cli.NotionPropertyMap(),
            )

        self.assertEqual(result, (1, 3))
        post_digest.assert_called_once()


class NameAndExtractorWaterfallTests(unittest.TestCase):
    def test_trusted_candidate_first_name_rejects_unknown_or_non_name(self):
        self.assertEqual(cli.trusted_candidate_first_name("Abdul Shaik"), "Abdul")
        self.assertEqual(cli.trusted_candidate_first_name("Unknown"), "")
        self.assertEqual(cli.trusted_candidate_first_name("Senior Software Engineer"), "")

    def test_create_reply_draft_prefers_trusted_ats_first_name(self):
        gmail = mock.Mock()
        gmail.users.return_value.threads.return_value.get.return_value.execute.return_value = {
            "messages": [{
                "payload": {
                    "headers": [
                        {"name": "Subject", "value": "Application"},
                        {"name": "Message-ID", "value": "<message-1@example.com>"},
                        {"name": "References", "value": ""},
                    ]
                }
            }]
        }
        gmail.users.return_value.drafts.return_value.create.return_value.execute.return_value = {
            "id": "r-new"
        }

        with mock.patch.object(
            cli,
            "resolve_recipient_first_name",
            side_effect=AssertionError("Gmail display name should not be consulted"),
        ):
            draft_id = cli.create_reply_draft(
                gmail,
                sender_email="hiring@example.com",
                to_email="candidate@example.com",
                thread_id="thread-1",
                body_text="Thanks for your interest.",
                recipient_name="Abdul Shaik",
            )

        self.assertEqual(draft_id, "r-new")
        create_body = gmail.users.return_value.drafts.return_value.create.call_args.kwargs["body"]
        raw_message = base64.urlsafe_b64decode(create_body["message"]["raw"])
        parsed = email.message_from_bytes(raw_message)
        self.assertIn("Hi Abdul,", parsed.get_payload(decode=True).decode(parsed.get_content_charset()))

    def test_looks_like_person_name_accepts_real_names(self):
        self.assertTrue(cli.looks_like_person_name("Dikshith Reddy M"))
        self.assertTrue(cli.looks_like_person_name("Jordan Lee"))

    def test_looks_like_person_name_rejects_objectives_and_headlines(self):
        self.assertFalse(cli.looks_like_person_name("career AI data software"))
        self.assertFalse(cli.looks_like_person_name("Seeking AI Roles In Canada"))
        self.assertFalse(cli.looks_like_person_name("Senior Software Engineer"))
        self.assertFalse(cli.looks_like_person_name("Phone 415 555 1212"))

    def test_resume_name_lines_skip_objective_headline(self):
        resume = "career AI/data/software roles in Canada\nDikshith Reddy M\nExperience\n"
        names = cli.likely_resume_name_lines(resume)
        self.assertNotIn("career AI data software", names)
        self.assertIn("Dikshith Reddy", names)

    def test_consensus_first_name_requires_three_agreeing_sources(self):
        # 3 sources agree -> returns the name
        ev = {"email": ["Jane"], "resume": ["jane"], "linkedin": ["Jane"], "linkedin_slug": [], "ats": ["Wrongname"]}
        self.assertEqual(cli.derive_consensus_first_name(ev, min_sources=3), "Jane")
        # only 2 agree -> no consensus
        ev2 = {"email": ["Jane"], "resume": ["jane"], "linkedin": ["Bob"], "linkedin_slug": [], "ats": []}
        self.assertEqual(cli.derive_consensus_first_name(ev2, min_sources=3), "")
        # generic tokens never count
        ev3 = {"email": ["there"], "resume": ["there"], "linkedin": ["there"], "ats": [], "linkedin_slug": []}
        self.assertEqual(cli.derive_consensus_first_name(ev3, min_sources=3), "")
        self.assertEqual(cli.derive_consensus_first_name({}, min_sources=3), "")

    def test_name_verifier_consensus_requires_both_agents(self):
        cfg = build_config(anthropic_api_key="a", openai_api_key="o")
        kw = dict(candidate_name="Jane Doe", candidate_email="jane@x.co", greeting_first_name="Jane",
                  evidence={"email": ["Jane"]}, deterministic_allowed=True, deterministic_reason="ok")
        # both approve -> True
        with mock.patch.object(cli, "call_anthropic_name_verifier", return_value=(True, "ok")), \
             mock.patch.object(cli, "call_openai_name_verifier", return_value=(True, "ok")):
            ok, _ = cli.call_rejection_name_verifier_consensus(cfg, **kw)
        self.assertTrue(ok)
        # one rejects -> False (fail closed)
        with mock.patch.object(cli, "call_anthropic_name_verifier", return_value=(True, "ok")), \
             mock.patch.object(cli, "call_openai_name_verifier", return_value=(False, "mismatch")):
            ok, _ = cli.call_rejection_name_verifier_consensus(cfg, **kw)
        self.assertFalse(ok)

    def test_unipile_configured_requires_all_three_values(self):
        self.assertFalse(cli.unipile_configured(build_config()))
        self.assertTrue(cli.unipile_configured(build_config(
            unipile_dsn="https://api1.unipile.com:13111",
            unipile_api_key="k",
            unipile_account_id="acc_1",
        )))

    def test_parse_title_company_from_headline(self):
        self.assertEqual(cli.parse_title_company_from_headline("Account Executive at Stripe"), ("Account Executive", "Stripe"))
        self.assertEqual(cli.parse_title_company_from_headline("AE @ Stripe | helping teams scale"), ("AE", "Stripe"))
        self.assertEqual(cli.parse_title_company_from_headline("Senior PM at Acme, Remote"), ("Senior PM", "Acme"))
        self.assertEqual(cli.parse_title_company_from_headline("Aspiring data scientist"), ("", ""))
        self.assertEqual(cli.parse_title_company_from_headline(""), ("", ""))

    def test_linkedin_identifier_from_url(self):
        self.assertEqual(cli.linkedin_identifier_from_url("https://www.linkedin.com/in/dikshithreddym"), "dikshithreddym")
        self.assertEqual(cli.linkedin_identifier_from_url("https://linkedin.com/in/jane-doe/"), "jane-doe")
        self.assertEqual(cli.linkedin_identifier_from_url("not-a-url"), "")

    def test_unipile_search_parses_public_identifier(self):
        cfg = build_config(
            unipile_dsn="https://api1.unipile.com:13111",
            unipile_api_key="k",
            unipile_account_id="acc_1",
        )
        resp = mock.Mock(ok=True)
        resp.json.return_value = {"items": [{"name": "Dikshith Reddy", "headline": "Account Executive at Stripe", "public_identifier": "dikshithreddym"}]}
        with mock.patch.object(cli, "requests", mock.Mock(post=mock.Mock(return_value=resp))):
            url, _conf = cli.unipile_search_linkedin_url(cfg, "Dikshith Reddy", "Stripe", "Account Executive")
        self.assertEqual(url, "https://www.linkedin.com/in/dikshithreddym")

    def test_find_linkedin_falls_back_to_scrape_when_unipile_unconfigured(self):
        cfg = build_config()  # no unipile creds
        with mock.patch.object(cli, "unipile_search_linkedin_url") as unipile, \
             mock.patch.object(cli, "google_search_linkedin_url", return_value=("https://www.linkedin.com/in/scraped", "Low")) as scrape:
            url, _ = cli.find_linkedin_url_for_candidate(cfg, "Jane Doe", "Acme", "AE")
        unipile.assert_not_called()
        scrape.assert_called_once()
        self.assertEqual(url, "https://www.linkedin.com/in/scraped")

    def test_confidence_is_acceptable_handles_labels_and_numbers(self):
        self.assertTrue(cli.confidence_is_acceptable("high"))
        self.assertTrue(cli.confidence_is_acceptable("medium"))
        self.assertTrue(cli.confidence_is_acceptable(0.95))   # models often return a number
        self.assertTrue(cli.confidence_is_acceptable("0.8"))
        self.assertFalse(cli.confidence_is_acceptable("low"))
        self.assertFalse(cli.confidence_is_acceptable(0.3))
        self.assertFalse(cli.confidence_is_acceptable(""))

    def test_resume_extractor_providers_waterfall(self):
        self.assertEqual(cli.resume_extractor_providers(_config(provider="auto")), ["anthropic", "openai"])
        self.assertEqual(cli.resume_extractor_providers(_config(provider="both")), ["anthropic", "openai"])
        self.assertEqual(cli.resume_extractor_providers(_config(provider="claude")), ["anthropic"])
        self.assertEqual(cli.resume_extractor_providers(_config(provider="openai")), ["openai"])
        self.assertEqual(cli.resume_extractor_providers(_config(provider="off")), [])

    def test_extract_resume_fields_falls_back_claude_then_openai(self):
        config = _config(provider="auto")
        with mock.patch.object(cli, "call_anthropic_resume_extractor", return_value={"candidate_name": "Dikshith Reddy M"}) as anthropic, \
             mock.patch.object(cli, "call_openai_resume_extractor", return_value={
                 "latest_current_title": "Data Engineer",
                 "latest_current_company": "Acme",
             }) as openai:
            fields = cli.extract_resume_fields(config, "resume", "snippet")
        anthropic.assert_called_once()
        openai.assert_called_once()  # called because Claude left title/company empty
        self.assertEqual(fields.get("candidate_name"), "Dikshith Reddy M")
        self.assertEqual(fields.get("latest_current_title"), "Data Engineer")
        self.assertEqual(fields.get("latest_current_company"), "Acme")


def _config(provider: str):
    return build_config(resume_extractor_provider=provider)


if __name__ == "__main__":
    unittest.main()
