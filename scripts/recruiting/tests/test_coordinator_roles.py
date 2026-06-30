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
