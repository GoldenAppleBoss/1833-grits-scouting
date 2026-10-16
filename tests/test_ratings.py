import importlib.util
import itertools
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

spec = importlib.util.spec_from_file_location("ratings", Path(__file__).parents[1] / "api" / "ratings.py")
ratings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ratings)


def robot(match, team, owner, auto, teleop):
    return {"recordId": f"{match}-{team}", "matchKey": match, "teamNumber": team, "ownerUserId": str(owner),
            "completed": True, "kind": "quantitative", "autoFuel": auto, "teleopFuel": teleop,
            "submittedAt": "2026-10-16T10:00:00Z"}


def fixture():
    teams = list(range(1, 7))
    data = {"teams": [{"team_number": t, "name": f"Team {t}"} for t in teams], "records": [], "matches": [], "users": []}
    for number, red in enumerate(itertools.combinations(teams, 3), 1):
        blue = tuple(t for t in teams if t not in red)
        match = {"key": f"qm{number}", "number": number, "time": number, "level": "qm", "alliances": {}}
        for color, members in (("red", red), ("blue", blue)):
            total = sum(t * 10 for t in members)
            match["alliances"][color] = {"teams": list(members), "scores": {"auto": total//2, "teleop": total//2, "total": total}}
            for team in members:
                data["records"].append(robot(match["key"], team, team, team*10, team*10))
        data["matches"].append(match)
    return data


class RatingsTests(unittest.TestCase):
    def test_known_fuel_contributions_are_recovered_and_individual_scouting_is_mean(self):
        data = fixture()
        result = ratings.opr_report(data)
        self.assertEqual(result["rank"], 6)
        for row in result["teams"]:
            self.assertAlmostEqual(row["tbaFuelOPR"], row["teamNumber"]*10)
            self.assertAlmostEqual(row["scoutingOPR"], row["teamNumber"]*20)
            self.assertTrue(row["independent"])
        self.assertEqual(result["defaultWeight"], .5)
        self.assertEqual(result["basis"], "scoring-fuel")

    def test_holdout_is_chronological_and_has_no_scouting_leakage(self):
        data = fixture()
        report = ratings.opr_report(data)["holdout"]
        self.assertEqual(report["trainingMatches"], 14)
        self.assertEqual(report["testMatches"], 6)
        self.assertEqual(report["alliances"], 12)
        self.assertAlmostEqual(report["tbaMAE"], 0)
        self.assertGreater(report["scoutMAE"], report["blendMAE"][50])
        self.assertGreater(report["blendMAE"][50], report["tbaMAE"])
        for r in data["records"]:
            if int(r["matchKey"][2:]) > 14:
                r["autoFuel"] = 9999
        self.assertEqual(report, ratings.opr_report(data)["holdout"])

    def test_missing_and_unplayed_results_are_not_zero_observations(self):
        data = fixture()
        data["records"] = [r for r in data["records"] if r["teamNumber"] != 6]
        for side in data["matches"][0]["alliances"].values():
            side["scores"] = None
        rows = ratings.opr_report(data)["teams"]
        six = next(t for t in rows if t["teamNumber"] == 6)
        self.assertIsNone(six["scoutingOPR"])
        self.assertEqual(six["matches"], 0)
        self.assertEqual(six["officialMatches"], 19)

    def test_duplicates_use_latest_complete_observation(self):
        records = [robot("qm1", 1, 1, 10, 20)]
        duplicate = {**records[0], "recordId": "new", "autoFuel": 30, "submittedAt": "2026-10-16T12:00:00Z"}
        records += [duplicate, {**duplicate, "recordId": "draft", "completed": False, "autoFuel": 9999}]
        values, counts = ratings.scouting_fit(records, [1])
        self.assertEqual(values[1], 50)
        self.assertEqual(counts[1], 1)

    def test_fixed_crews_cannot_be_assigned_separate_individual_accuracy(self):
        data = fixture()
        data["users"] = [{"id": str(t), "name": f"Scout {t}", "email": f"{t}@example.org"} for t in range(1, 4)]
        # The same three people scout every red alliance, even as robots change.
        selected = []
        for m in data["matches"]:
            for i, team in enumerate(m["alliances"]["red"]["teams"], 1):
                selected.append(robot(m["key"], team, i, team*5, team*5))
        data["records"] = selected
        report = ratings.roster_report(data)
        self.assertEqual(report["rank"], 1)
        for row in report["scouters"]:
            self.assertIsNone(row["estimatedAccuracy"])
            self.assertEqual(row["status"], "crew-only")
            self.assertEqual(row["allianceAgreement"], 100)

    def test_mixed_crews_recover_known_nonnegative_error_contributions(self):
        users = [{"id": str(t), "name": f"Scout {t}", "email": f"{t}@example.org"} for t in range(1, 5)]
        data = {"users": users, "matches": [], "records": []}
        errors = {1: 0, 2: .03, 3: .06, 4: .09}
        for number, crew in enumerate(list(itertools.combinations(range(1, 5), 3))*3, 1):
            expected_error = sum(errors[u] for u in crew)/3
            match = {"key": f"qm{number}", "number": number, "level": "qm", "alliances": {"red": {
                "teams": [1, 2, 3], "scores": {"auto": 100, "teleop": 100, "total": 200}}}}
            data["matches"].append(match)
            extra = round(100*expected_error)
            for i, uid in enumerate(crew, 1):
                value = (40 + extra) if i == 1 else 30
                data["records"].append(robot(match["key"], i, uid, value, value))
        report = ratings.roster_report(data)
        self.assertEqual(report["rank"], 4)
        for row in report["scouters"]:
            self.assertEqual(row["status"], "estimated")
            self.assertAlmostEqual(row["estimatedAccuracy"], 100*(1-errors[int(row["id"])]), places=5)
            self.assertTrue(0 <= row["estimatedAccuracy"] <= 100)

    def test_small_or_empty_samples_are_explicitly_unknown(self):
        data = {"matches": [], "records": [], "teams": [], "users": [{"id": "1", "name": "One", "email": "1@example.org"}]}
        result = ratings.roster_report(data)
        self.assertEqual(result["scouters"][0]["status"], "no-data")
        self.assertIsNone(result["scouters"][0]["estimatedAccuracy"])
        self.assertEqual(ratings.opr_report(data)["teams"], [])

    def test_one_scouter_covering_three_robots_is_one_alliance_comparison(self):
        data = {"users": [{"id": "1", "name": "One", "email": "1@example.org"}],
                "matches": [{"key": "qm1", "alliances": {"red": {"teams": [1, 2, 3],
                    "scores": {"auto": 30, "teleop": 30, "total": 60}}}}],
                "records": [robot("qm1", t, 1, 10, 10) for t in (1, 2, 3)]}
        row = ratings.roster_report(data)["scouters"][0]
        self.assertEqual(row["comparisons"], 1)
        self.assertEqual(row["status"], "provisional")
        self.assertIsNone(row["estimatedAccuracy"])

    def test_null_space_marks_only_confounded_columns(self):
        x, rank, independent = ratings.least_squares([[1, 0, 0], [0, 1, 1]], [5, 8], 3)
        self.assertEqual(rank, 2)
        np.testing.assert_array_equal(independent, [True, False, False])
        self.assertAlmostEqual(x[0], 5)


class AuthenticationTests(unittest.TestCase):
    def fake_database(self, permissions=None, active=True):
        class Cursor:
            def __init__(self, value): self.value = value
            def fetchone(self): return self.value
            def fetchall(self): return []
            def __iter__(self): return iter([])
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, sql, args):
                if "portal_sessions" in sql:
                    self.assert_digest = args[0]
                    return Cursor({"id": 1, "permissions": permissions or []} if active else None)
                return Cursor(None)
        connection = Connection()
        module = types.ModuleType("psycopg")
        module.connect = lambda *args, **kwargs: connection
        rows = types.ModuleType("psycopg.rows")
        rows.dict_row = object()
        return patch.dict(sys.modules, {"psycopg": module, "psycopg.rows": rows})

    def test_anonymous_expired_and_inactive_sessions_are_rejected(self):
        with self.fake_database(active=False):
            for cookie in ("", "team1833_session=expired"):
                with self.assertRaises(ratings.AccessError) as error:
                    ratings.load_authenticated_data(cookie, "2026test", "opr")
                self.assertEqual(error.exception.status, 401)

    def test_quantitative_only_cannot_read_ratings_or_roster(self):
        with self.fake_database(["scouting:read"]):
            for mode in ("opr", "roster"):
                with self.assertRaises(ratings.AccessError) as error:
                    ratings.load_authenticated_data("team1833_session=token", "2026test", mode)
                self.assertEqual(error.exception.status, 403)

    def test_analytics_can_read_opr_but_not_private_roster(self):
        with self.fake_database(["scouting:read", "scouting:analytics"]):
            result = ratings.load_authenticated_data("team1833_session=token", "2026test", "opr")
            self.assertEqual(result["users"], [])
            with self.assertRaises(ratings.AccessError) as error:
                ratings.load_authenticated_data("team1833_session=token", "2026test", "roster")
            self.assertEqual(error.exception.status, 403)

    def test_scouting_manager_and_portal_admin_can_read_roster(self):
        for role in ("scouting:manage", "portal:admin"):
            with self.fake_database(["scouting:read", role]):
                result = ratings.load_authenticated_data("team1833_session=token", "2026test", "roster")
                self.assertEqual(result["records"], [])


if __name__ == "__main__":
    unittest.main()
