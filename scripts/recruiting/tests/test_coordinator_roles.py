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


if __name__ == "__main__":
    unittest.main()
