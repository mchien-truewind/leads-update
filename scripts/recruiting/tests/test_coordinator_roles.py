from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from scripts.recruiting import coordinator_cli as coordinator


def role_page_props(role_name):
    return {
        "Role at Truewind": {
            "type": "multi_select",
            "multi_select": [{"name": role_name}],
        }
    }


class RecruitingCoordinatorRoleTest(unittest.TestCase):
    def test_ae_subject_parses_to_ae_role(self):
        self.assertEqual(
            coordinator.parse_required_subject("[hiring@] AE - Michael Goldstein"),
            ("AE", "Michael Goldstein"),
        )

    def test_account_executive_subject_parses_to_ae_role(self):
        self.assertEqual(
            coordinator.parse_required_subject("[hiring@] Account Executive - Michael Goldstein"),
            ("AE", "Michael Goldstein"),
        )

    def test_attention_prefix_subject_parses_embedded_role_and_candidate_name(self):
        self.assertEqual(
            coordinator.parse_required_subject(
                "[hiring@] ATTN: Kyle - Account Executive - Michael Goldstein"
            ),
            ("AE", "Michael Goldstein"),
        )

    def test_subject_role_inference_handles_common_typos_and_variants(self):
        self.assertEqual(
            coordinator.infer_truewind_role_from_subject("[hiring@] ACOUNT EXECUTIVE - Nkechi Zita Ejikeme"),
            "AE",
        )
        self.assertEqual(
            coordinator.infer_truewind_role_from_subject("[hiring@] Growth Genaralist - Devika Sureshbabu"),
            "Growth Generalist",
        )
        self.assertEqual(
            coordinator.infer_truewind_role_from_subject("[hiring@] Growth Marketing Opening - Tanner Hoskin"),
            "Growth Generalist",
        )

    def test_spam_report_subject_is_not_role_evidence(self):
        self.assertEqual(
            coordinator.infer_truewind_role_from_subject(
                "[hiring@] Moderator's spam report for hiring@trytruewind.com"
            ),
            "Unknown",
        )

    def test_existing_other_role_backfills_from_stronger_parse(self):
        class FakeNotion:
            def __init__(self):
                self.updated = []

            def update_page(self, page_id, payload):
                self.updated.append((page_id, payload))

        prop_map = coordinator.NotionPropertyMap(role="Role at Truewind")
        database_schema = {
            "properties": {
                "Candidate Name": {"type": "title"},
                "Email": {"type": "email"},
                "Source": {"type": "select"},
                "Role at Truewind": {"type": "multi_select"},
                "Resume URL": {"type": "url"},
                "Career Stage": {"type": "select"},
                "LinkedIn URL": {"type": "url"},
                "Confidence Level - LI": {"type": "select"},
                "Current Company": {"type": "rich_text"},
                "Current Role": {"type": "rich_text"},
                "Location": {"type": "select"},
                "Date first entered": {"type": "date"},
                "Gmail thread id": {"type": "rich_text"},
                "Last sync at": {"type": "date"},
            }
        }
        existing_page = {
            "id": "page-1",
            "properties": {
                "Role at Truewind": {
                    "type": "multi_select",
                    "multi_select": [{"name": "Other"}],
                },
                "Source": {"type": "select", "select": {"name": "Inbound"}},
            },
        }
        notion = FakeNotion()

        page_id, was_created = coordinator.upsert_candidate_page(
            notion,
            database_schema,
            prop_map,
            candidate_name="Kris Thomas",
            candidate_email="1kristhomas@gmail.com",
            source="Inbound",
            role="AE",
            resume_url="",
            career_stage="Unknown",
            linkedin_url="",
            linkedin_confidence="",
            company="Unknown",
            current_title="Unknown",
            location="U.S.",
            date_first_entered="2026-05-20T20:35:44+00:00",
            gmail_thread_id="thread-1",
            synced_at_iso="2026-06-30T00:00:00+00:00",
            existing_page=existing_page,
        )

        self.assertEqual(page_id, "page-1")
        self.assertFalse(was_created)
        self.assertEqual(len(notion.updated), 1)
        self.assertEqual(
            notion.updated[0][1]["Role at Truewind"],
            {"multi_select": [{"name": "AE"}]},
        )

    def test_ae_uses_custom_gpt_proceed_template(self):
        prop_map = coordinator.NotionPropertyMap(role="Role at Truewind")
        self.assertTrue(
            coordinator.uses_custom_gpt_first_round(role_page_props("AE"), prop_map)
        )

    def test_growth_generalist_uses_default_proceed_template(self):
        prop_map = coordinator.NotionPropertyMap(role="Role at Truewind")
        self.assertFalse(
            coordinator.uses_custom_gpt_first_round(role_page_props("Growth Generalist"), prop_map)
        )

    def test_rejected_rows_with_reject_draft_are_not_skipped_before_send_gate(self):
        self.assertFalse(
            coordinator.should_skip_terminal_status_before_decision_processing(
                status="Rejected",
                decision="Reject",
                reject_draft_id="draft-123",
            )
        )

    def test_needs_attention_rows_with_reject_draft_can_retry_send_gate(self):
        self.assertTrue(
            coordinator.should_process_reject_draft(
                status="Needs Attention",
                decision="Reject",
                reject_draft_id="draft-123",
            )
        )
        self.assertFalse(
            coordinator.should_process_reject_draft(
                status="Round 1 Scheduling",
                decision="Reject",
                reject_draft_id="draft-123",
            )
        )

    def test_terminal_rows_without_pending_reject_draft_are_still_skipped(self):
        self.assertTrue(
            coordinator.should_skip_terminal_status_before_decision_processing(
                status="Rejected",
                decision="Reject",
                reject_draft_id="",
            )
        )
        self.assertTrue(
            coordinator.should_skip_terminal_status_before_decision_processing(
                status="Offered",
                decision="Proceed",
                reject_draft_id="draft-123",
            )
        )


if __name__ == "__main__":
    unittest.main()
