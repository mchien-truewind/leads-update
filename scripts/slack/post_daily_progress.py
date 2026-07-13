#!/usr/bin/env python3
"""Post daily lead progress counts to Slack.

Legacy local fallback behavior:
- Inbound count: messages in #leads containing "Booked Calendly Meeting"
- Outbound count: messages in #gtm-outbound containing "New Meeting"
- Target channel: #gtm-general
- Week resets on Monday in report timezone.

Production Railway reporting is implemented in slack_bot.js and counts HubSpot deals
by createdate + deal_source instead of Slack keywords.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, Tuple
from zoneinfo import ZoneInfo

DEFAULT_WEEKLY_GOAL = 30.0
LEGACY_WEEKLY_GOAL = 10.0


def parse_report_enabled(raw_value: object) -> bool:
    return str(raw_value or "").strip().lower() in {"true", "1"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-channel", default=None, help="Slack channel name override")
    parser.add_argument("--dry-run", action="store_true", help="Print message only; do not post")
    parser.add_argument("--force", action="store_true", help="Bypass the 6 PM local-time gate")
    return parser.parse_args()


def load_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        key, val = line.split("=", 1)
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def get_config(repo_root: Path, args: argparse.Namespace) -> Dict[str, str]:
    env_local = load_env_file(repo_root / ".env.local")
    env_file = load_env_file(repo_root / ".env")

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env_local.get(key) or env_file.get(key) or default

    token = pick("SLACK_BOT_TOKEN") or pick("SLACK_USER_TOKEN")
    if not token:
        raise RuntimeError("Missing SLACK_BOT_TOKEN (or SLACK_USER_TOKEN) in env/.env.local/.env")

    target_override = args.target_channel.strip() if args.target_channel else ""
    return {
        "token": token,
        "inbound_channel": pick("LEAD_REPORT_INBOUND_CHANNEL", "leads"),
        "outbound_channel": pick("LEAD_REPORT_OUTBOUND_CHANNEL", "gtm-outbound"),
        "target_channel": target_override or pick("LEAD_REPORT_TARGET_CHANNEL", "gtm-general"),
        "inbound_phrase": pick("LEAD_REPORT_INBOUND_PHRASE", "Booked Calendly Meeting"),
        "outbound_phrase": pick("LEAD_REPORT_OUTBOUND_PHRASE", "New Meeting"),
        "report_tz": pick("LEAD_REPORT_TIMEZONE", "America/Los_Angeles"),
        "weekly_goal": pick("LEAD_REPORT_WEEKLY_GOAL", str(int(DEFAULT_WEEKLY_GOAL))),
    }


def report_enabled(repo_root: Path) -> bool:
    env_local = load_env_file(repo_root / ".env.local")
    env_file = load_env_file(repo_root / ".env")
    for source in (os.environ, env_local, env_file):
        if "LEAD_REPORT_ENABLED" in source:
            return parse_report_enabled(source["LEAD_REPORT_ENABLED"])
    return False


def parse_weekly_goal(raw_value: str) -> float:
    try:
        weekly_goal = float(raw_value)
    except ValueError as exc:
        raise RuntimeError(f"Invalid LEAD_REPORT_WEEKLY_GOAL: {raw_value}") from exc

    if weekly_goal == LEGACY_WEEKLY_GOAL:
        print(
            "warning: ignoring legacy LEAD_REPORT_WEEKLY_GOAL=10 override; using 30",
            file=sys.stderr,
        )
        return DEFAULT_WEEKLY_GOAL
    return weekly_goal


def slack_api(method: str, token: str, params: Dict[str, str], use_get: bool = False) -> Dict:
    headers = {"Authorization": f"Bearer {token}"}
    if use_get:
        url = f"https://slack.com/api/{method}?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=headers)
    else:
        data = urllib.parse.urlencode(params).encode("utf-8")
        req = urllib.request.Request(f"https://slack.com/api/{method}", data=data, headers=headers)

    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        err = payload.get("error", "unknown_error")
        need = payload.get("needed", "")
        raise RuntimeError(f"Slack API {method} failed: {err} needed={need}")
    return payload


def resolve_public_channels(token: str, names: Iterable[str]) -> Dict[str, str]:
    needed = set(names)
    found: Dict[str, str] = {}
    cursor = ""
    while True:
        payload = slack_api(
            "conversations.list",
            token,
            {
                "exclude_archived": "true",
                "types": "public_channel",
                "limit": "1000",
                "cursor": cursor,
            },
            use_get=False,
        )
        for channel in payload.get("channels", []):
            name = channel.get("name", "")
            if name in needed:
                found[name] = channel.get("id", "")
        if needed.issubset(found.keys()):
            return found
        cursor = (payload.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            return found


def collect_matching_timestamps(
    token: str,
    channel_id: str,
    phrase: str,
    oldest: float,
    latest: float,
    exclude_patterns: Iterable[str] = (),
) -> list[float]:
    """Return timestamps of messages matching phrase (excluding filtered patterns)."""
    timestamps: list[float] = []
    skip_patterns = [p.lower() for p in exclude_patterns]
    cursor = ""
    while True:
        payload = slack_api(
            "conversations.history",
            token,
            {
                "channel": channel_id,
                "oldest": str(oldest),
                "latest": str(latest),
                "inclusive": "true",
                "limit": "200",
                "cursor": cursor,
            },
            use_get=True,
        )
        for msg in payload.get("messages", []):
            text = msg.get("text") or ""
            if phrase not in text:
                continue
            text_lower = text.lower()
            if any(p in text_lower for p in skip_patterns):
                continue
            timestamps.append(float(msg.get("ts", "0")))
        cursor = (payload.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            return timestamps


def defer_reason(now_local: datetime, force: bool) -> str:
    if force:
        return ""
    if now_local.hour < 18:
        return "daily post deferred until 6 PM local time"
    return ""


def date_label(now_local: datetime) -> str:
    return f"{now_local.month}/{now_local.day}/{now_local.strftime('%y')}"


def already_posted(token: str, target_channel_id: str, now_local: datetime) -> bool:
    start_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    oldest = start_local.astimezone(timezone.utc).timestamp()
    latest = now_local.astimezone(timezone.utc).timestamp()

    daily_prefix = f"Today {date_label(now_local)}"

    cursor = ""
    while True:
        payload = slack_api(
            "conversations.history",
            token,
            {
                "channel": target_channel_id,
                "oldest": str(oldest),
                "latest": str(latest),
                "inclusive": "true",
                "limit": "200",
                "cursor": cursor,
            },
            use_get=True,
        )
        for msg in payload.get("messages", []):
            text = msg.get("text") or ""
            if text.startswith(daily_prefix):
                return True
        cursor = (payload.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            return False


def build_message(
    now_local: datetime,
    today_inbound: int,
    today_outbound: int,
    week_inbound: int,
    week_outbound: int,
    weekly_goal: float,
    today_unknown: int = 0,
    week_unknown: int = 0,
) -> str:
    def fmt_num(value: float) -> str:
        text = f"{value:.2f}".rstrip("0").rstrip(".")
        return text if text else "0"

    week_total = week_inbound + week_outbound + week_unknown
    remaining = max(weekly_goal - week_total, 0.0)
    today_total = today_inbound + today_outbound + today_unknown
    return (
        f"Today {date_label(now_local)}\n"
        f"Inbound: {today_inbound}\n"
        f"Outbound: {today_outbound}\n"
        f"Unknown: {today_unknown}\n"
        f"Total: {today_total}\n"
        "\n\n"
        "This week so far\n"
        f"Inbound: {week_inbound}\n"
        f"Outbound: {week_outbound}\n"
        f"Unknown: {week_unknown}\n"
        f"Total: {week_total}\n"
        "\n"
        f"Weekly Goal: {fmt_num(weekly_goal)}\n"
        f":star2: How many more do we need? {fmt_num(remaining)}"
    )


def compute_counts(config: Dict[str, str]) -> Tuple[datetime, int, int, int, int, str]:
    token = config["token"]
    names = [config["inbound_channel"], config["outbound_channel"], config["target_channel"]]
    channels = resolve_public_channels(token, names)

    for name in names:
        if name not in channels:
            raise RuntimeError(f"Channel not found or not public: #{name}")

    report_tz = ZoneInfo(config["report_tz"])
    now_local = datetime.now(report_tz)
    start_today_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    days_since_monday = now_local.weekday()
    start_week_local = start_today_local - timedelta(days=days_since_monday)

    week_oldest = start_week_local.astimezone(timezone.utc).timestamp()
    today_oldest = start_today_local.astimezone(timezone.utc).timestamp()
    latest = now_local.astimezone(timezone.utc).timestamp()

    # Fetch the full week window once per channel, then split into today vs week.
    inbound_ts = collect_matching_timestamps(
        token, channels[config["inbound_channel"]],
        config["inbound_phrase"], week_oldest, latest,
        exclude_patterns=["truewind", "test"],
    )
    outbound_ts = collect_matching_timestamps(
        token, channels[config["outbound_channel"]],
        config["outbound_phrase"], week_oldest, latest,
    )

    week_inbound = len(inbound_ts)
    week_outbound = len(outbound_ts)
    today_inbound = sum(1 for ts in inbound_ts if ts >= today_oldest)
    today_outbound = sum(1 for ts in outbound_ts if ts >= today_oldest)

    target_channel_id = channels[config["target_channel"]]
    return now_local, today_inbound, today_outbound, week_inbound, week_outbound, target_channel_id


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[2]
    if not report_enabled(repo_root):
        print("skipped mode=daily reason=LEAD_REPORT_ENABLED is not true")
        return 0

    config = get_config(repo_root, args)
    weekly_goal = parse_weekly_goal(config["weekly_goal"])

    (
        now_local,
        today_inbound,
        today_outbound,
        week_inbound,
        week_outbound,
        target_channel_id,
    ) = compute_counts(config)

    reason = defer_reason(now_local, args.force)
    if reason:
        print(
            f"deferred mode=daily reason={reason} local_time={now_local.isoformat()}"
        )
        return 0

    text = build_message(
        now_local,
        today_inbound,
        today_outbound,
        week_inbound,
        week_outbound,
        weekly_goal,
    )

    if args.dry_run:
        print(text)
        return 0

    if already_posted(config["token"], target_channel_id, now_local):
        print(
            f"skipped duplicate mode=daily channel=#{config['target_channel']} "
            f"local_time={now_local.isoformat()}"
        )
        return 0

    payload = slack_api(
        "chat.postMessage",
        config["token"],
        {"channel": target_channel_id, "text": text},
        use_get=False,
    )
    print(
        f"posted channel=#{config['target_channel']} "
        f"channel_id={target_channel_id} ts={payload.get('ts')} "
        "mode=daily "
        f"today_inbound={today_inbound} today_outbound={today_outbound} "
        f"week_inbound={week_inbound} week_outbound={week_outbound} "
        f"local_time={now_local.isoformat()}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
