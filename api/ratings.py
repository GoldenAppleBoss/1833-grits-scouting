"""Authenticated NumPy ratings, served by Vercel's Python runtime.

The --stdio entrypoint runs the same math for Node local development and tests.
Only this read-only function uses Python; credentials and sessions stay private.
"""
import os
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit
import numpy as np


def valid_record(r):
    return (r.get("completed") is True and r.get("kind", "quantitative") == "quantitative"
            and all(isinstance(r.get(k), int) and not isinstance(r.get(k), bool) and r[k] >= 0
                    for k in ("autoFuel", "teleopFuel")))


def latest_records(records):
    selected = {}
    for r in sorted(filter(valid_record, records), key=lambda r: (
            r.get("serverReceivedAt") or r.get("submittedAt") or r.get("updatedAt") or "", r["recordId"])):
        selected[(r["matchKey"], r["teamNumber"])] = r
    return selected


def least_squares(matrix, targets, columns):
    if not len(matrix) or not columns:
        return np.zeros(columns), 0, np.zeros(columns, dtype=bool)
    a = np.asarray(matrix, dtype=float).reshape(-1, columns)
    x, _, rank, _ = np.linalg.lstsq(a, np.asarray(targets, dtype=float), rcond=None)
    # A column is independently estimable only if no null-space vector changes it.
    _, _, vh = np.linalg.svd(a, full_matrices=a.shape[0] < columns)
    independent = np.linalg.norm(vh[rank:, :], axis=0) < 1e-7
    return x, int(rank), independent


def official_fit(matches, teams):
    positions = {t: i for i, t in enumerate(teams)}
    a, b = [], []
    appearances = Counter()
    for m in matches:
        if m["level"] != "qm":
            continue
        for side in m["alliances"].values():
            if side.get("scores") is None:
                continue
            row = np.zeros(len(teams))
            for t in side["teams"]:
                row[positions[t]] = 1
                appearances[t] += 1
            a.append(row)
            b.append(side["scores"]["total"])
    x, rank, independent = least_squares(a, b, len(teams))
    return {t: float(x[i]) for i, t in enumerate(teams) if appearances[t]}, rank, independent, appearances


def scouting_fit(records, teams, fields=("autoFuel", "teleopFuel")):
    # Each observation measures one robot. Its one-hot least-squares design
    # gives its mean measured contribution, without inventing missing allies.
    positions = {t: i for i, t in enumerate(teams)}
    a, b, counts = [], [], Counter()
    for r in latest_records(records).values():
        if not r["matchKey"].startswith("qm") or r["teamNumber"] not in positions:
            continue
        if any(not isinstance(r.get(k), int) or isinstance(r.get(k), bool) or r[k] < 0 for k in fields):
            continue
        row = np.zeros(len(teams))
        row[positions[r["teamNumber"]]] = 1
        a.append(row)
        b.append(sum(r[k] for k in fields))
        counts[r["teamNumber"]] += 1
    x, _, _ = least_squares(a, b, len(teams))
    return {t: float(x[i]) for i, t in enumerate(teams) if counts[t]}, counts


def holdout_report(matches, records, teams):
    played = [m for m in matches if m["level"] == "qm" and all(s.get("scores") is not None for s in m["alliances"].values())]
    played.sort(key=lambda m: (m.get("time", 0), m["number"], m["key"]))
    if len(played) < 5:
        return {"alliances": 0, "reason": "At least five scored qualification matches are needed for a chronological holdout."}
    cut = max(1, int(len(played) * .7))
    training, testing = played[:cut], played[cut:]
    train_keys = {m["key"] for m in training}
    official, _, _, _ = official_fit(training, teams)
    scout, _ = scouting_fit([r for r in records if r["matchKey"] in train_keys], teams)
    comparisons = []
    for m in testing:
        for side in m["alliances"].values():
            if all(t in official and t in scout for t in side["teams"]):
                comparisons.append((sum(official[t] for t in side["teams"]),
                                    sum(scout[t] for t in side["teams"]), side["scores"]["total"]))
    if not comparisons:
        return {"alliances": 0, "reason": "The held-out alliances need scouting coverage for all three robots in the training matches."}
    a = np.asarray(comparisons)
    errors = [float(np.mean(np.abs((1-w/100)*a[:, 0] + (w/100)*a[:, 1] - a[:, 2]))) for w in range(101)]
    return {"alliances": len(comparisons), "trainingMatches": cut, "testMatches": len(testing),
            "tbaMAE": errors[0], "scoutMAE": errors[100], "blendMAE": errors}


def opr_report(data):
    matches = data.get("matches", [])
    schedule = data.get("schedule", matches)
    scheduled = {(m["key"], t) for m in schedule if m["level"] == "qm" for s in m["alliances"].values() for t in s["teams"]}
    records = [r for r in data.get("records", []) if (r["matchKey"], r["teamNumber"]) in scheduled]
    teams = sorted({int(t["team_number"]) for t in data.get("teams", [])}
                   | {t for m in schedule for s in m["alliances"].values() for t in s["teams"]})
    official, rank, independent, appearances = official_fit(matches, teams)
    scout, counts = scouting_fit(records, teams)
    passing, _ = scouting_fit(records, teams, ("autoPassed", "teleopPassed"))
    names = {int(t["team_number"]): t["name"] for t in data.get("teams", [])}
    rows = [{"teamNumber": t, "name": names.get(t, f"Team {t}"), "scoutingOPR": scout.get(t),
             "tbaFuelOPR": official.get(t), "scoutingPassingOPR": passing.get(t), "tbaOverallOPR": data.get("oprs", {}).get(f"frc{t}"),
             "matches": counts[t], "officialMatches": appearances[t], "independent": bool(independent[i])}
            for i, t in enumerate(teams)]
    return {"teams": rows, "rank": rank, "teamCount": len(official), "updatedAt": data.get("updatedAt"),
            "holdout": holdout_report(matches, records, teams), "basis": "scoring-fuel", "defaultWeight": .5}


def roster_report(data):
    selected = latest_records(data.get("records", []))
    users = {str(u["id"]): u for u in data.get("users", [])}
    ids = sorted(users)
    index = {uid: i for i, uid in enumerate(ids)}
    a, b, agreements, flagged, counts = [], [], defaultdict(list), Counter(), Counter()
    for m in data.get("matches", []):
        for side in m["alliances"].values():
            rs = [selected.get((m["key"], t)) for t in side["teams"]]
            if side.get("scores") is None or any(r is None or str(r["ownerUserId"]) not in index for r in rs):
                continue
            actual = {"auto": sum(r["autoFuel"] for r in rs), "teleop": sum(r["teleopFuel"] for r in rs)}
            actual["total"] = actual["auto"] + actual["teleop"]
            errors = [abs(actual[k]-side["scores"][k])/max(side["scores"][k], 1) for k in actual]
            # Worst phase catches offsetting autonomous / teleop mistakes.
            error = max(errors)
            row = np.zeros(len(ids))
            for r in rs:
                uid = str(r["ownerUserId"])
                row[index[uid]] += 1/3
            for uid in {str(r["ownerUserId"]) for r in rs}:
                agreements[uid].append(100*max(0, 1-error))
                counts[uid] += 1
                flagged[uid] += int(error > .15 + 1e-10)
            a.append(row)
            b.append(error)
    x, rank, independent = least_squares(a, b, len(ids))
    # Nonnegative least squares using projected gradient descent in NumPy.
    # Negative error contributions would produce misleading >100% accuracy.
    if a:
        matrix = np.asarray(a)
        target = np.asarray(b)
        lipschitz = float(np.linalg.norm(matrix, 2)**2) or 1
        x = np.maximum(x, 0)
        for _ in range(1500):
            step = np.maximum(0, x - matrix.T @ (matrix @ x - target) / lipschitz)
            if np.linalg.norm(step-x) < 1e-9:
                break
            x = step
    rows = []
    for uid in ids:
        i = index[uid]
        known = bool(independent[i]) and counts[uid] >= 3
        rows.append({"id": uid, "name": users[uid].get("name") or users[uid]["email"], "email": users[uid]["email"],
                     "estimatedAccuracy": float(100*max(0, 1-x[i])) if known else None,
                     "allianceAgreement": float(np.mean(agreements[uid])) if agreements[uid] else None,
                     "comparisons": counts[uid], "flagged": flagged[uid],
                     "status": "estimated" if known else "crew-only" if counts[uid] >= 3 else "provisional" if counts[uid] else "no-data"})
    return {"scouters": rows, "rank": rank, "columns": len(ids), "alliances": len(a), "updatedAt": data.get("updatedAt")}


def compute(data, mode):
    return roster_report(data) if mode == "roster" else opr_report(data)


class AccessError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def load_authenticated_data(cookie_header, event, mode):
    import psycopg
    from psycopg.rows import dict_row
    cookies = SimpleCookie()
    try:
        cookies.load(cookie_header)
        token = cookies["team1833_session"].value
    except (KeyError, ValueError, CookieError):
        raise AccessError(401, "Authentication required")
    if not token or len(token) > 200:
        raise AccessError(401, "Authentication required")
    # No global connection: Supabase transaction pooling and concurrent requests
    # require independent, short-lived sessions without prepared statements.
    url = os.environ.get("DATABASE_URL", "").strip()
    with psycopg.connect(url, connect_timeout=10, prepare_threshold=None, row_factory=dict_row) as conn:
        identity = conn.execute("""SELECT u.id, ARRAY(SELECT permission FROM shared_login.portal_permissions WHERE user_id=u.id) AS permissions
            FROM shared_login.portal_sessions s JOIN shared_login.portal_users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND s.expires_at>now() AND u.is_active""", (hashlib.sha256(token.encode()).digest(),)).fetchone()
        if not identity:
            raise AccessError(401, "Authentication required")
        permissions = set(identity["permissions"])
        admin = bool(permissions & {"portal:admin", "scouting:manage"})
        if "scouting:read" not in permissions or (mode == "roster" and not admin) or (mode == "opr" and not admin and not permissions & {"scouting:analytics", "scouting:alliances"}):
            raise AccessError(403, "Scouting administrator access required" if mode == "roster" else "Analytics access required")
        saved = conn.execute("SELECT payload,updated_at FROM scouting.event_scores WHERE event_key=%s", (event,)).fetchone()
        data = dict(saved["payload"]) if saved else {"matches": []}
        data["updatedAt"] = saved["updated_at"].isoformat() if saved else None
        data["records"] = []
        for r in conn.execute("SELECT payload,event_key,match_key,kind,owner_user_id::text,server_received_at FROM scouting.records WHERE event_key=%s AND completed AND kind='quantitative'", (event,)):
            data["records"].append({**r["payload"], "eventKey": r["event_key"], "matchKey": r["match_key"], "kind": r["kind"],
                                    "ownerUserId": r["owner_user_id"], "serverReceivedAt": r["server_received_at"].isoformat()})
        data["teams"] = conn.execute("SELECT team_number,name FROM scouting.teams WHERE event_key=%s ORDER BY team_number", (event,)).fetchall()
        data["schedule"] = [{"key": m["match_key"], "level": m["comp_level"], "alliances": {"red": {"teams": m["red"]}, "blue": {"teams": m["blue"]}}}
                            for m in conn.execute("SELECT match_key,comp_level,red,blue FROM scouting.matches WHERE event_key=%s", (event,))]
        data["users"] = conn.execute("""SELECT u.id::text,u.email,COALESCE(NULLIF(trim(u.first_name||' '||u.last_name),''),u.email) AS name
            FROM shared_login.portal_users u WHERE EXISTS(SELECT 1 FROM scouting.rotations r WHERE r.event_key=%s AND r.user_id=u.id)
            OR EXISTS(SELECT 1 FROM scouting.records r WHERE r.event_key=%s AND r.owner_user_id=u.id) ORDER BY name""", (event,event)).fetchall() if mode == "roster" else []
        return data


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            query = parse_qs(urlsplit(self.path).query)
            event = query.get("eventKey", [""])[0]
            mode = query.get("mode", ["opr"])[0]
            if not re.fullmatch(r"2026[a-z0-9]+", event) or mode not in ("opr", "roster"):
                raise AccessError(400, "Choose a 2026 event and a valid rating view")
            data = load_authenticated_data(self.headers.get("Cookie", ""), event, mode)
            self.respond(200, compute(data, mode))
        except AccessError as error:
            self.respond(error.status, {"error": error.message})
        except Exception as error:
            # Log a type/code only, never a connection string or user data.
            print("Ratings unavailable:", type(error).__name__, getattr(error, "sqlstate", ""), file=sys.stderr)
            self.respond(503, {"error": "Ratings unavailable. Check the Python function dependencies and run database migrations."})

    def do_POST(self):
        self.respond(405, {"error": "Use GET"})

    def respond(self, status, value):
        body = json.dumps(value, allow_nan=False).encode()
        self.send_response(status)
        for key, value in {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
                           "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY"}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__" and "--stdio" in sys.argv:
    request = json.load(sys.stdin)
    print(json.dumps(compute(request["data"], request["mode"]), allow_nan=False))
