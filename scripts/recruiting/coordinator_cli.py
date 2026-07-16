#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import re
import socket
import tempfile
import threading
import time as time_module
import unicodedata
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from datetime import datetime, time, timedelta, timezone
from email.message import EmailMessage
from email.utils import parseaddr
from html import unescape
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from zoneinfo import ZoneInfo

try:
    import requests
except ModuleNotFoundError:  # pragma: no cover - dependency guard
    requests = None  # type: ignore[assignment]

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:  # pragma: no cover - fallback for partial envs
    def load_dotenv(*_args, **_kwargs):  # type: ignore[no-redef]
        return False


GOOGLE_TRANSIENT_ERRORS = (TimeoutError, BrokenPipeError, ConnectionError, socket.timeout)


def is_google_transient_error(exc: Exception) -> bool:
    if isinstance(exc, GOOGLE_TRANSIENT_ERRORS):
        return True
    # httplib2/google-auth can wrap network failures in OSError subclasses.
    if isinstance(exc, OSError) and exc.__class__.__name__ in {
        "TimeoutError",
        "BrokenPipeError",
        "ConnectionResetError",
        "SSLError",
    }:
        return True
    status = getattr(getattr(exc, "resp", None), "status", None)
    return isinstance(status, int) and status in {429, 500, 502, 503, 504}


def execute_google_request(request: Any, *, description: str, attempts: int = 3) -> dict[str, Any]:
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return request.execute(num_retries=2)
        except Exception as exc:
            last_exc = exc
            if attempt >= attempts or not is_google_transient_error(exc):
                raise
            sleep_seconds = min(8, 2 ** (attempt - 1))
            print(
                f"{description} transient failure; retrying attempt {attempt + 1}/{attempts}: "
                f"{exc.__class__.__name__}"
            )
            time_module.sleep(sleep_seconds)
    if last_exc:
        raise last_exc
    return {}


GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
]
CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"]
DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]

RESUME_EXTENSIONS = (".pdf", ".docx", ".doc", ".txt", ".rtf")
RESUME_LINK_HOST_HINTS = (
    "drive.google.com",
    "docs.google.com",
    "dropbox.com",
    "onedrive.live.com",
    "sharepoint.com",
)
RESUME_LINK_FILE_HINTS = (".pdf", ".doc", ".docx", ".rtf", ".txt")
RESUME_LINK_RE = re.compile(r"https?://[^\s<>\")']+", flags=re.IGNORECASE)

DEFAULT_PROCEED_TEMPLATE = "Thanks for your submission. When are you free for a 20-minute intro call?"
DEFAULT_CUSTOM_GPT_PROCEED_TEMPLATE = (
    "Thanks for the submission. We'd love to get to know you a little better.\n\n"
    "As part of the next step in the process, please complete the following within the next 48 hours:\n"
    "1. Go to this roleplay link: https://chatgpt.com/g/g-698d0a0186288191bc1b95c61e3e36ed-truewind-bdr-roleplay\n"
    "2. Engage in a full cold call conversation with the GPT as if it were a real prospect.\n"
    "3. Share the link of the full chat transcript and email it back to us.\n\n"
    "We're looking to evaluate tone, structure, objection handling, and overall conversational flow.\n\n"
    "Looking forward to reviewing it.\n\n"
    "Thanks,\n"
    "Mercedes"
)
DEFAULT_REJECT_TEMPLATE = (
    "Thank you for your submission. We had an incredibly strong pool of applicants, and after careful "
    "consideration, we won't be moving forward with your application at this time.\n\n"
    "We're growing quickly, though, and new roles open up often. Please keep checking our careers page "
    "for future opportunities. We'd be glad to see your application again in the future."
)
DEFAULT_SCHEDULING_TEMPLATE = (
    "Thanks for the quick reply. Are you available for a 20-minute intro call on {slot_label}?"
)
DEFAULT_SCHEDULING_CONFIRM_TEMPLATE = (
    "Thanks for confirming. You're booked for a 20-minute intro call on {slot_label}. "
    "Calendar invite with the Google Meet link is on the way."
)
DEFAULT_CUSTOM_GPT_NO_RESPONSE_REJECTION_TEMPLATE = (
    "Hi {{first name}},\n\n"
    "Haven't heard from you in a while, so I'm going to go ahead and close the application.\n\n"
    "We are growing quickly and have new positions opening up often. Please let us know if another role "
    "piques your interest and we'd be open to seeing your application again soon.\n\n"
    "Mercedes"
)
DEFAULT_NO_RESPONSE_TEMPLATE = (
    DEFAULT_CUSTOM_GPT_NO_RESPONSE_REJECTION_TEMPLATE
)
PROCEED_SENT_RE = re.compile(r"(?i)\bwhen are you free for a 20-minute intro call\b")
SCHEDULING_SENT_RE = re.compile(
    r"(?i)\bthanks for the quick reply\b.*\b20-minute intro call on\b|\b20-minute intro call on\b"
)
NO_RESPONSE_SENT_RE = re.compile(
    r"(?i)\bhaven't heard back from you\b.*\bclosing this process\b|"
    r"\bhaven't heard from you in a while\b.*\bclose the application\b|"
    r"\bclose the loop on this process\b"
)
REJECT_HARD_PATTERNS = [
    re.compile(r"(?i)\bwon[’']?t\s+be\s+moving\s+forward\b"),
    re.compile(r"(?i)\bwill\s+not\s+be\s+moving\s+forward\b"),
    re.compile(r"(?i)\bnot\s+be\s+moving\s+forward\s+with\s+your\s+application\b"),
    re.compile(r"(?i)\bwe\s+won[’']?t\s+be\s+proceeding\b"),
    re.compile(r"(?i)\bwe\s+will\s+not\s+be\s+proceeding\b"),
    re.compile(r"(?i)\bno\s+longer\s+moving\s+forward\b"),
    re.compile(r"(?i)\bmove(?:d)?\s+forward\s+with\s+other\s+(?:candidates|applicants)\b"),
    re.compile(r"(?i)\bmoving\s+ahead\s+with\s+other\s+(?:candidates|applicants)\b"),
    re.compile(r"(?i)\bclosing\s+out\s+this\s+process\b.*\bsubmission\b"),
    re.compile(r"(?i)\bhaven[’']?t\s+received\s+your\s+submission\b"),
    re.compile(r"(?i)\bwe\s+haven[’']?t\s+received\s+your\s+submission\b"),
    re.compile(r"(?i)\bhaven[’']?t\s+heard\s+back\s+from\s+you\b.*\bclosing\s+this\s+process\b"),
    re.compile(r"(?i)\bhaven[’']?t\s+heard\s+from\s+you\s+in\s+a\s+while\b.*\bclose\s+the\s+application\b"),
    re.compile(r"(?i)\bgoing\s+to\s+go\s+ahead\s+and\s+close\s+the\s+application\b"),
]
REJECT_SUPPORT_PATTERNS = [
    re.compile(r"(?i)\bstrong\s+pool\s+of\s+applicants\b"),
    re.compile(r"(?i)\bcareful\s+consideration\b"),
    re.compile(r"(?i)\bkeep\s+checking\s+our\s+careers?\s+page\b"),
    re.compile(r"(?i)\bglad\s+to\s+see\s+your\s+application\s+again\b"),
    re.compile(r"(?i)\bapplication\s+again\s+in\s+the\s+future\b"),
    re.compile(r"(?i)\bapplication\b.*\bat\s+this\s+time\b"),
    re.compile(r"(?i)\bnew\s+positions\s+opening\s+up\s+often\b"),
    re.compile(r"(?i)\banother\s+role\s+piques\s+your\s+interest\b"),
    re.compile(r"(?i)\bopen\s+to\s+seeing\s+your\s+application\s+again\s+soon\b"),
]
REJECT_EXCLUSION_PATTERNS = [
    re.compile(r"(?i)\bas\s+you\s+figure\s+out\s+your\s+next\s+steps\b"),
]
DEFAULT_DRAFT_BCC = "hiring@trytruewind.com"
SLACK_THREAD_MARKER_PREFIX = "ATS_THREAD_ID:"
FORWARD_THREAD_MARKER_PREFIX = "ATS_FORWARD_THREAD_ID:"
DEFAULT_RECRUITING_SLACK_MENTION_USER_ID = ""
DOCLING_PARSE_EXTENSIONS = {"pdf", "doc", "docx"}
DEFAULT_ASSIGNMENT_KEYWORDS = (
    "assignment,case study,take-home,take home,exercise,project,"
    "roleplay,role play,chat transcript,complete the following,next step in the process,within the next 48 hours"
)
AUTO_ARCHIVE_SENDER_EMAILS = {
    "drew.katnik@cybercoders.com",
    "noreply-spamdigest@google.com",
}

_DOCLING_CONVERTER: Any | None = None
_DOCLING_CHECKED = False


@dataclass
class NotionPropertyMap:
    candidate_name: str = "Candidate Name"
    email: str = "Email"
    source: str = "Source"
    role: str = "Role"
    resume_url: str = "Resume URL"
    career_stage: str = "Career Stage"
    linkedin_url: str = "LinkedIn URL"
    linkedin_confidence: str = "Confidence Level - LI"
    company: str = "Company"
    current_title: str = "Current Title"
    location: str = "Location"
    date_first_entered: str = "Date first entered"
    decision: str = "Decision"
    decision_time: str = "Decision time"
    reject_send_at: str = "Reject send at"
    proceed_draft_id: str = "Proceed draft id"
    reject_draft_id: str = "Reject draft id"
    gmail_thread_id: str = "Gmail thread id"
    status: str = "Status"
    scheduling_draft_id: str = "Scheduling draft id"
    proposed_slot: str = "Proposed Slot"
    last_sync_at: str = "Last sync at"
    slack_review_url: str = "Slack Review URL"


@dataclass
class Config:
    notion_token: str
    notion_database_id: str
    gmail_label_name: str
    gmail_query: str
    gmail_max_messages: int
    recruiter_sender_emails: set[str]
    recruiter_sender_names: set[str]
    hiring_alias: str
    from_email: str
    proceed_template: str
    reject_template: str
    scheduling_template: str
    no_response_template: str
    custom_gpt_no_response_template: str
    custom_gpt_no_response_wait_hours: int
    reject_delay_hours: int
    reject_draft_auto_send_age_hours: int
    name_verifier_provider: str
    name_verifier_model: str
    resume_extractor_provider: str
    resume_extractor_model: str
    resume_extractor_model_anthropic: str
    anthropic_api_key: str
    openai_api_key: str
    no_response_wait_business_days: int
    assignment_keywords: set[str]
    sent_status_lookback_days: int
    pipeline_label_name: str
    pdl_api_key: str
    unipile_dsn: str
    unipile_api_key: str
    unipile_account_id: str
    slack_token: str
    slack_post_token: str
    slack_review_channel: str
    slack_mention_user_id: str
    slack_history_lookback_days: int
    slack_proceed_reactions: set[str]
    slack_reject_reactions: set[str]
    slack_forward_reactions: set[str]
    slack_allow_decision_override: bool
    ats_follow_up_enabled: bool
    slack_state_file: Path
    forward_to_email: str
    property_map: NotionPropertyMap
    drive_folder_id: str
    timezone_name: str
    slot_minutes: int
    buffer_minutes: int
    min_notice_hours: int
    lookahead_days: int
    weekdays: set[int]
    daily_start: time
    daily_end: time
    calendar_id: str


def load_env_files() -> None:
    load_dotenv(".env.local")
    load_dotenv()


def resolve_path(env_var: str, default: str) -> Path:
    return Path(os.getenv(env_var, default)).expanduser().resolve()


def save_credentials(path: Path, creds: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(creds.to_json(), encoding="utf-8")


def require_google_dependencies():
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaIoBaseUpload
    except ModuleNotFoundError as exc:  # pragma: no cover - dependency guard
        raise RuntimeError(
            "Missing Google API dependencies. Install them with: pip install -r requirements.txt"
        ) from exc
    return Request, Credentials, InstalledAppFlow, build, MediaIoBaseUpload


def load_google_credentials(token_path: Path, scopes: list[str]):
    if not token_path.exists():
        return None

    Request, Credentials, _, _, _ = require_google_dependencies()
    creds = Credentials.from_authorized_user_file(str(token_path), scopes)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        save_credentials(token_path, creds)

    if not creds.valid:
        return None
    if hasattr(creds, "has_scopes") and not creds.has_scopes(scopes):
        return None
    return creds


def run_auth_flow(credentials_path: Path, token_path: Path, scopes: list[str], help_text: str):
    if not credentials_path.exists():
        raise FileNotFoundError(f"Credentials file not found at {credentials_path}. {help_text}")

    _, _, InstalledAppFlow, _, _ = require_google_dependencies()
    flow = InstalledAppFlow.from_client_secrets_file(str(credentials_path), scopes)
    creds = flow.run_local_server(port=0)
    save_credentials(token_path, creds)
    return creds


def ensure_google_service(
    *,
    api_name: str,
    api_version: str,
    scopes: list[str],
    credentials_env: str,
    credentials_default: str,
    token_env: str,
    token_default: str,
    help_text: str,
):
    credentials_path = resolve_path(credentials_env, credentials_default)
    token_path = resolve_path(token_env, token_default)
    creds = load_google_credentials(token_path, scopes)
    if not creds:
        creds = run_auth_flow(credentials_path, token_path, scopes, help_text)
    _, _, _, build, _ = require_google_dependencies()
    timeout_seconds = parse_env_int("RECRUITING_GOOGLE_API_TIMEOUT_SECONDS", 20)
    try:
        import httplib2
        from google_auth_httplib2 import AuthorizedHttp

        http = AuthorizedHttp(creds, http=httplib2.Http(timeout=timeout_seconds))
        return build(api_name, api_version, http=http, cache_discovery=False)
    except ModuleNotFoundError:
        return build(api_name, api_version, credentials=creds, cache_discovery=False)


def parse_weekdays(value: str) -> set[int]:
    mapping = {
        "MON": 0,
        "TUE": 1,
        "WED": 2,
        "THU": 3,
        "FRI": 4,
        "SAT": 5,
        "SUN": 6,
    }
    weekdays: set[int] = set()
    for token in value.split(","):
        cleaned = token.strip().upper()
        if not cleaned:
            continue
        if cleaned not in mapping:
            raise ValueError(f"Invalid weekday token: {cleaned}")
        weekdays.add(mapping[cleaned])
    if not weekdays:
        raise ValueError("RECRUITING_SCHEDULING_WEEKDAYS cannot be empty.")
    return weekdays


def parse_hhmm(value: str) -> time:
    match = re.fullmatch(r"([01]\d|2[0-3]):([0-5]\d)", value.strip())
    if not match:
        raise ValueError(f"Invalid HH:MM value: {value}")
    return time(hour=int(match.group(1)), minute=int(match.group(2)))


def parse_env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"Invalid integer for {name}: {raw!r}") from exc


def parse_env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    cleaned = raw.strip().lower()
    if cleaned in {"1", "true", "yes", "y", "on"}:
        return True
    if cleaned in {"0", "false", "no", "n", "off"}:
        return False
    raise ValueError(f"Invalid boolean for {name}: {raw!r}")


def parse_csv_set(value: str, default: str = "") -> set[str]:
    source = value if value.strip() else default
    tokens = {item.strip().lower() for item in source.split(",") if item.strip()}
    return tokens


def resolve_recruiting_slack_mention_user_id() -> str:
    configured = (
        os.getenv("RECRUITING_SLACK_MENTION_USER_ID", "").strip()
        or os.getenv("SLACK_USER_ID", "").strip()
    )
    if configured.lower() in {"none", "off", "false", "0"}:
        return ""
    return configured or DEFAULT_RECRUITING_SLACK_MENTION_USER_ID


def get_env_first(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def normalize_notion_database_id(value: str) -> str:
    raw = value.strip()
    if not raw:
        return ""

    if raw.startswith("https://") or raw.startswith("http://"):
        parsed = urlparse(raw)
        raw = parsed.path.rsplit("/", 1)[-1]

    raw = raw.split("?", 1)[0].split("#", 1)[0]
    compact = re.sub(r"[^0-9a-fA-F]", "", raw)
    if len(compact) == 32:
        return compact
    return value.strip()


def load_config() -> Config:
    load_env_files()

    notion_token = get_env_first("NOTION_INTERNAL_INTEGRATION_SECRET", "NOTION_INTERNAL_INTEGRATION")
    notion_db_raw = get_env_first("NOTION_DATABASE_ID", "NOTION_ATS_DB_ID")
    notion_db = normalize_notion_database_id(notion_db_raw)
    if not notion_token:
        raise ValueError(
            "Set NOTION_INTERNAL_INTEGRATION_SECRET or NOTION_INTERNAL_INTEGRATION in .env.local"
        )
    if not notion_db:
        raise ValueError("Set NOTION_DATABASE_ID or NOTION_ATS_DB_ID in .env.local")

    from_email = (
        os.getenv("RECRUITING_FROM_EMAIL", "").strip()
        or os.getenv("GOOGLE_GMAIL_DEFAULT_FROM", "").strip()
    )
    if not from_email:
        raise ValueError("Set RECRUITING_FROM_EMAIL or GOOGLE_GMAIL_DEFAULT_FROM in .env.local")

    property_map = NotionPropertyMap(
        candidate_name=os.getenv("RECRUITING_NOTION_PROP_CANDIDATE_NAME", "Candidate Name").strip(),
        email=os.getenv("RECRUITING_NOTION_PROP_EMAIL", "Email").strip(),
        source=os.getenv("RECRUITING_NOTION_PROP_SOURCE", "Source").strip(),
        role=(
            os.getenv("RECRUITING_NOTION_PROP_ROLE_AT_TRUEWIND", "").strip()
            or os.getenv("RECRUITING_NOTION_PROP_ROLE", "").strip()
            or "Role at Truewind"
        ),
        resume_url=os.getenv("RECRUITING_NOTION_PROP_RESUME_URL", "Resume URL").strip(),
        career_stage=os.getenv("RECRUITING_NOTION_PROP_CAREER_STAGE", "Career Stage").strip(),
        linkedin_url=os.getenv("RECRUITING_NOTION_PROP_LINKEDIN_URL", "LinkedIn URL").strip(),
        linkedin_confidence=os.getenv(
            "RECRUITING_NOTION_PROP_LINKEDIN_CONFIDENCE", "Confidence Level - LI"
        ).strip(),
        company=(
            os.getenv("RECRUITING_NOTION_PROP_CURRENT_COMPANY", "").strip()
            or os.getenv("RECRUITING_NOTION_PROP_COMPANY", "").strip()
            or "Current Company"
        ),
        current_title=(
            os.getenv("RECRUITING_NOTION_PROP_CURRENT_ROLE", "").strip()
            or os.getenv("RECRUITING_NOTION_PROP_CURRENT_TITLE", "").strip()
            or "Current Role"
        ),
        location=os.getenv("RECRUITING_NOTION_PROP_LOCATION", "Location").strip(),
        date_first_entered=os.getenv("RECRUITING_NOTION_PROP_DATE_FIRST_ENTERED", "Date first entered").strip(),
        decision=os.getenv("RECRUITING_NOTION_PROP_DECISION", "Decision").strip(),
        decision_time=os.getenv("RECRUITING_NOTION_PROP_DECISION_TIME", "Decision time").strip(),
        reject_send_at=os.getenv("RECRUITING_NOTION_PROP_REJECT_SEND_AT", "Reject send at").strip(),
        proceed_draft_id=os.getenv("RECRUITING_NOTION_PROP_PROCEED_DRAFT_ID", "Proceed draft id").strip(),
        reject_draft_id=os.getenv("RECRUITING_NOTION_PROP_REJECT_DRAFT_ID", "Reject draft id").strip(),
        gmail_thread_id=os.getenv("RECRUITING_NOTION_PROP_GMAIL_THREAD_ID", "Gmail thread id").strip(),
        status=os.getenv("RECRUITING_NOTION_PROP_STATUS", "Status").strip(),
        scheduling_draft_id=os.getenv("RECRUITING_NOTION_PROP_SCHEDULING_DRAFT_ID", "Scheduling draft id").strip(),
        proposed_slot=os.getenv("RECRUITING_NOTION_PROP_PROPOSED_SLOT", "Proposed Slot").strip(),
        last_sync_at=os.getenv("RECRUITING_NOTION_PROP_LAST_SYNC_AT", "Last sync at").strip(),
        slack_review_url=os.getenv("RECRUITING_NOTION_PROP_SLACK_REVIEW_URL", "Slack Review URL").strip(),
    )

    timezone_name = os.getenv("RECRUITING_SCHEDULING_TIMEZONE", "America/Los_Angeles").strip()
    require_attachment = parse_env_bool("RECRUITING_REQUIRE_ATTACHMENT", False)
    gmail_query_raw = os.getenv("RECRUITING_GMAIL_QUERY", 'subject:"[hiring@]"').strip()
    if not require_attachment:
        gmail_query_raw = re.sub(r"(?i)\bhas:attachment\b", "", gmail_query_raw)
    gmail_query = clean_text(gmail_query_raw) or 'subject:"[hiring@]"'

    return Config(
        notion_token=notion_token,
        notion_database_id=notion_db,
        gmail_label_name=os.getenv("RECRUITING_GMAIL_LABEL", "hiring@").strip(),
        gmail_query=gmail_query,
        gmail_max_messages=parse_env_int("RECRUITING_GMAIL_MAX_MESSAGES", 250),
        recruiter_sender_emails=parse_csv_set(
            os.getenv("RECRUITING_RECRUITER_SENDER_EMAILS", ""),
            default="sam.k@hitruewind.com",
        ),
        recruiter_sender_names=parse_csv_set(
            os.getenv("RECRUITING_RECRUITER_SENDER_NAMES", ""),
            default="sam k,sam klein",
        ),
        hiring_alias=os.getenv("RECRUITING_HIRING_ALIAS", "").strip().lower(),
        from_email=from_email,
        proceed_template=(os.getenv("RECRUITING_PROCEED_TEMPLATE", "").strip() or DEFAULT_PROCEED_TEMPLATE),
        reject_template=(os.getenv("RECRUITING_REJECTION_TEMPLATE", "").strip() or DEFAULT_REJECT_TEMPLATE),
        scheduling_template=(
            os.getenv("RECRUITING_SCHEDULING_TEMPLATE", "").strip() or DEFAULT_SCHEDULING_TEMPLATE
        ),
        no_response_template=(
            os.getenv("RECRUITING_NO_RESPONSE_TEMPLATE", "").strip() or DEFAULT_NO_RESPONSE_TEMPLATE
        ),
        custom_gpt_no_response_template=(
            os.getenv("RECRUITING_CUSTOM_GPT_NO_RESPONSE_TEMPLATE", "").strip()
            or DEFAULT_CUSTOM_GPT_NO_RESPONSE_REJECTION_TEMPLATE
        ),
        custom_gpt_no_response_wait_hours=parse_env_int("RECRUITING_CUSTOM_GPT_NO_RESPONSE_WAIT_HOURS", 48),
        reject_delay_hours=parse_env_int("RECRUITING_REJECT_DELAY_HOURS", 24),
        reject_draft_auto_send_age_hours=parse_env_int("RECRUITING_REJECT_DRAFT_AUTO_SEND_AGE_HOURS", 48),
        name_verifier_provider=os.getenv("RECRUITING_NAME_VERIFIER_PROVIDER", "anthropic").strip().lower(),
        name_verifier_model=os.getenv("RECRUITING_NAME_VERIFIER_MODEL", "claude-haiku-4-5").strip(),
        resume_extractor_provider=os.getenv("RECRUITING_RESUME_EXTRACTOR_PROVIDER", "off").strip().lower(),
        resume_extractor_model=os.getenv("RECRUITING_RESUME_EXTRACTOR_MODEL", "gpt-4.1-mini").strip(),
        resume_extractor_model_anthropic=os.getenv("RECRUITING_RESUME_EXTRACTOR_MODEL_ANTHROPIC", "claude-haiku-4-5").strip(),
        anthropic_api_key=get_env_first("RECRUITING_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
        openai_api_key=get_env_first("RECRUITING_OPENAI_API_KEY", "OPENAI_API_KEY"),
        no_response_wait_business_days=parse_env_int(
            "RECRUITING_NO_RESPONSE_WAIT_BUSINESS_DAYS",
            parse_env_int("RECRUITING_NO_RESPONSE_WAIT_DAYS", 7),
        ),
        assignment_keywords=parse_csv_set(
            os.getenv("RECRUITING_ASSIGNMENT_KEYWORDS", ""), default=DEFAULT_ASSIGNMENT_KEYWORDS
        ),
        sent_status_lookback_days=parse_env_int("RECRUITING_SENT_STATUS_LOOKBACK_DAYS", 5),
        pipeline_label_name=os.getenv("RECRUITING_GMAIL_PIPELINE_LABEL", "hiring-pipeline").strip(),
        pdl_api_key=get_env_first("PDL_API", "PDL_API_KEY"),
        unipile_dsn=get_env_first("RECRUITING_UNIPILE_DSN", "UNIPILE_DSN"),
        unipile_api_key=get_env_first("RECRUITING_UNIPILE_API_KEY", "UNIPILE_API_KEY"),
        unipile_account_id=get_env_first("RECRUITING_UNIPILE_ACCOUNT_ID", "UNIPILE_ACCOUNT_ID"),
        slack_token=get_env_first("RECRUITING_SLACK_TOKEN", "SLACK_USER_TOKEN", "SLACK_BOT_TOKEN"),
        slack_post_token=get_env_first(
            "RECRUITING_SLACK_POST_TOKEN",
            "SLACK_BOT_TOKEN",
            "RECRUITING_SLACK_TOKEN",
            "SLACK_USER_TOKEN",
        ),
        slack_review_channel=(
            os.getenv("RECRUITING_SLACK_REVIEW_CHANNEL_ID", "").strip()
            or os.getenv("RECRUITING_SLACK_REVIEW_CHANNEL", "hiring-review").strip().lstrip("#")
        ),
        slack_mention_user_id=resolve_recruiting_slack_mention_user_id(),
        slack_history_lookback_days=parse_env_int("RECRUITING_SLACK_HISTORY_LOOKBACK_DAYS", 14),
        slack_proceed_reactions=parse_csv_set(
            os.getenv("RECRUITING_SLACK_PROCEED_REACTIONS", ""), default="white_check_mark"
        ),
        slack_reject_reactions=parse_csv_set(
            os.getenv("RECRUITING_SLACK_REJECT_REACTIONS", ""), default="x"
        ),
        slack_forward_reactions=parse_csv_set(
            os.getenv("RECRUITING_SLACK_FORWARD_REACTIONS", ""), default="arrow_right"
        ),
        slack_allow_decision_override=parse_env_bool("RECRUITING_SLACK_ALLOW_DECISION_OVERRIDE", False),
        ats_follow_up_enabled=parse_env_bool("RECRUITING_ENABLE_ATS_FOLLOW_UP_DIGEST", False),
        slack_state_file=Path(
            os.getenv("RECRUITING_SLACK_STATE_FILE", "outputs/recruiting/slack_review_posts.json")
        ).expanduser(),
        forward_to_email=normalize_email(os.getenv("RECRUITING_FORWARD_TO_EMAIL", "tenn@trytruewind.com")),
        property_map=property_map,
        drive_folder_id=get_env_first("GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_DRIVE_FOLDER_ATS"),
        timezone_name=timezone_name,
        slot_minutes=parse_env_int("RECRUITING_SLOT_MINUTES", 20),
        buffer_minutes=parse_env_int("RECRUITING_SCHEDULING_BUFFER_MINUTES", 10),
        min_notice_hours=parse_env_int("RECRUITING_SCHEDULING_MIN_NOTICE_HOURS", 24),
        lookahead_days=parse_env_int("RECRUITING_SCHEDULING_LOOKAHEAD_DAYS", 14),
        weekdays=parse_weekdays(os.getenv("RECRUITING_SCHEDULING_WEEKDAYS", "MON,TUE,WED,THU,FRI")),
        daily_start=parse_hhmm(os.getenv("RECRUITING_SCHEDULING_START_LOCAL", "10:00")),
        daily_end=parse_hhmm(os.getenv("RECRUITING_SCHEDULING_END_LOCAL", "16:00")),
        calendar_id=os.getenv("GOOGLE_CALENDAR_DEFAULT_CALENDAR_ID", "primary").strip() or "primary",
    )


class NotionClient:
    def __init__(self, token: str, database_id: str):
        if requests is None:
            raise RuntimeError("Missing dependency 'requests'. Install with: pip install -r requirements.txt")
        self._token = token
        self._database_id = database_id
        self._base_url = "https://api.notion.com/v1"
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        response = requests.request(
            method,
            f"{self._base_url}{path}",
            headers=self._headers,
            json=payload,
            timeout=30,
        )
        if not response.ok:
            raise RuntimeError(f"Notion API error {response.status_code}: {response.text}")
        return response.json()

    def get_database(self) -> dict[str, Any]:
        return self._request("GET", f"/databases/{self._database_id}")

    def update_database(self, properties: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", f"/databases/{self._database_id}", {"properties": properties})

    def query_pages(self, payload: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        body = payload.copy() if payload else {}
        pages: list[dict[str, Any]] = []
        next_cursor: str | None = None
        while True:
            if next_cursor:
                body["start_cursor"] = next_cursor
            data = self._request("POST", f"/databases/{self._database_id}/query", body)
            pages.extend(data.get("results", []))
            if not data.get("has_more"):
                break
            next_cursor = data.get("next_cursor")
        return pages

    def create_page(self, properties: dict[str, Any]) -> dict[str, Any]:
        payload = {"parent": {"database_id": self._database_id}, "properties": properties}
        return self._request("POST", "/pages", payload)

    def update_page(self, page_id: str, properties: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", f"/pages/{page_id}", {"properties": properties})

    def get_page(self, page_id: str) -> dict[str, Any]:
        return self._request("GET", f"/pages/{page_id}")


class SlackClient:
    def __init__(self, token: str):
        if requests is None:
            raise RuntimeError("Missing dependency 'requests'. Install with: pip install -r requirements.txt")
        self._token = token.strip()
        if not self._token:
            raise ValueError("Missing Slack token. Set SLACK_BOT_TOKEN or SLACK_USER_TOKEN.")
        self._base_url = "https://slack.com/api"
        self._headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json; charset=utf-8",
        }

    def _request(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = requests.post(
            f"{self._base_url}/{method}",
            headers=self._headers,
            json=payload,
            timeout=30,
        )
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After", "unknown")
            raise RuntimeError(f"Slack API rate-limited for {method} (retry_after={retry_after}s)")
        if not response.ok:
            raise RuntimeError(f"Slack API HTTP error {response.status_code}: {response.text}")
        body = response.json()
        if not body.get("ok"):
            raise RuntimeError(f"Slack API error {method}: {body.get('error', 'unknown_error')}")
        return body

    def auth_test(self) -> dict[str, Any]:
        return self._request("auth.test", {})

    def resolve_channel_id(self, channel_name_or_id: str) -> str:
        cleaned = channel_name_or_id.strip().lstrip("#")
        if re.fullmatch(r"[CGD][A-Z0-9]+", cleaned):
            return cleaned

        cursor = ""
        while True:
            payload: dict[str, Any] = {
                "exclude_archived": True,
                "types": "public_channel,private_channel",
                "limit": 1000,
            }
            if cursor:
                payload["cursor"] = cursor
            response = self._request("conversations.list", payload)
            for channel in response.get("channels", []):
                if channel.get("name", "").strip().lower() == cleaned.lower():
                    return channel.get("id", "")
            cursor = (response.get("response_metadata") or {}).get("next_cursor", "")
            if not cursor:
                break
        raise ValueError(
            f"Slack channel not found or inaccessible: #{cleaned}. "
            "Invite the Slack app to the channel and verify conversations scopes."
        )

    def post_message(self, channel_id: str, text: str, blocks: list[dict[str, Any]]) -> dict[str, Any]:
        return self._request(
            "chat.postMessage",
            {
                "channel": channel_id,
                "text": text,
                "blocks": blocks,
                "unfurl_links": False,
                "unfurl_media": False,
            },
        )

    def get_message_permalink(self, channel_id: str, message_ts: str) -> str:
        response = requests.get(
            f"{self._base_url}/chat.getPermalink",
            headers={"Authorization": f"Bearer {self._token}"},
            params={"channel": channel_id, "message_ts": message_ts},
            timeout=30,
        )
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After", "unknown")
            raise RuntimeError(f"Slack API rate-limited for chat.getPermalink (retry_after={retry_after}s)")
        if not response.ok:
            raise RuntimeError(f"Slack API HTTP error {response.status_code}: {response.text}")
        body = response.json()
        if not body.get("ok"):
            raise RuntimeError(f"Slack API error chat.getPermalink: {body.get('error', 'unknown_error')}")
        return str(body.get("permalink", "") or "")

    def list_channel_messages(self, channel_id: str, oldest_ts: float = 1.0) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        cursor = ""
        while True:
            payload: dict[str, Any] = {
                "channel": channel_id,
                "oldest": f"{oldest_ts:.3f}",
                "inclusive": True,
                "limit": 200,
            }
            if cursor:
                payload["cursor"] = cursor
            response = self._request("conversations.history", payload)
            messages.extend(response.get("messages", []))
            cursor = (response.get("response_metadata") or {}).get("next_cursor", "")
            if not cursor:
                break
        return messages


SLACK_RECONCILIATION_MUTEX = threading.Lock()


def notion_prop_value(prop: dict[str, Any]) -> str:
    prop_type = prop.get("type")
    if prop_type == "title":
        return " ".join(item.get("plain_text", "") for item in prop.get("title", [])).strip()
    if prop_type == "rich_text":
        return " ".join(item.get("plain_text", "") for item in prop.get("rich_text", [])).strip()
    if prop_type == "email":
        return (prop.get("email") or "").strip()
    if prop_type == "url":
        return (prop.get("url") or "").strip()
    if prop_type == "select":
        selected = prop.get("select")
        return (selected or {}).get("name", "").strip() if selected else ""
    if prop_type == "multi_select":
        values = [
            (item.get("name") or "").strip()
            for item in prop.get("multi_select", []) or []
            if (item.get("name") or "").strip()
        ]
        return ", ".join(values)
    if prop_type == "status":
        selected = prop.get("status")
        return (selected or {}).get("name", "").strip() if selected else ""
    if prop_type == "date":
        date_obj = prop.get("date")
        return (date_obj or {}).get("start", "").strip() if date_obj else ""
    if prop_type == "number":
        number = prop.get("number")
        return "" if number is None else str(number)
    if prop_type == "checkbox":
        return "true" if prop.get("checkbox") else "false"
    if prop_type == "phone_number":
        return (prop.get("phone_number") or "").strip()
    return ""


def build_notion_value(prop_schema: dict[str, Any], value: Any) -> dict[str, Any] | None:
    if value is None:
        return None

    def notion_text(text_value: Any, max_len: int = 2000) -> str:
        text = str(text_value).strip()
        if len(text) <= max_len:
            return text
        return text[: max_len - 1].rstrip()

    prop_type = prop_schema.get("type")
    if prop_type == "title":
        text = notion_text(value)
        return {"title": [{"type": "text", "text": {"content": text}}]} if text else {"title": []}
    if prop_type == "rich_text":
        text = notion_text(value)
        return {"rich_text": [{"type": "text", "text": {"content": text}}]} if text else {"rich_text": []}
    if prop_type == "email":
        return {"email": str(value).strip() or None}
    if prop_type == "url":
        url = str(value).strip()
        return {"url": url or None}
    if prop_type == "select":
        text = str(value).strip()
        return {"select": {"name": text}} if text else {"select": None}
    if prop_type == "multi_select":
        if isinstance(value, str):
            values = [item.strip() for item in value.split(",") if item.strip()]
        elif isinstance(value, (list, tuple, set)):
            values = [str(item).strip() for item in value if str(item).strip()]
        else:
            values = [str(value).strip()] if str(value).strip() else []
        return {"multi_select": [{"name": item} for item in values]}
    if prop_type == "status":
        text = str(value).strip()
        return {"status": {"name": text}} if text else {"status": None}
    if prop_type == "date":
        text = str(value).strip()
        return {"date": {"start": text}} if text else {"date": None}
    if prop_type == "number":
        try:
            return {"number": float(value)}
        except ValueError:
            return None
    if prop_type == "checkbox":
        return {"checkbox": bool(value)}
    if prop_type == "phone_number":
        return {"phone_number": str(value).strip()}
    return None


def normalize_email(value: str) -> str:
    return value.strip().lower()


def should_auto_archive_sender(sender_email: str) -> bool:
    return normalize_email(sender_email) in AUTO_ARCHIVE_SENDER_EMAILS


def candidate_name_from_email(candidate_email: str) -> str:
    local = clean_text(candidate_email).split("@", 1)[0]
    local = re.split(r"[._+\-]", local)[0].strip(" ,.-")
    return local.capitalize() if local else "Unknown"


def header_map(message: dict[str, Any]) -> dict[str, str]:
    headers = {}
    for entry in message.get("payload", {}).get("headers", []):
        name = entry.get("name", "").lower()
        if name:
            headers[name] = entry.get("value", "")
    return headers


def parse_candidate_identity_from_headers(
    headers: dict[str, str],
    *,
    internal_domains: set[str] | None = None,
) -> tuple[str, str]:
    internal_domains = internal_domains or set()

    candidate_headers = ["from"]
    from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
    if email_domain(from_email) in internal_domains:
        # Google Groups rewrites From to hiring@trytruewind.com; the applicant
        # is preserved in these original-sender headers.
        candidate_headers = ["x-original-from", "reply-to", "x-original-sender", "from"]

    for header_name in candidate_headers:
        raw_value = headers.get(header_name, "")
        if not raw_value:
            continue
        name, email = parseaddr(raw_value)
        normalized_email = normalize_email(email or raw_value)
        if not normalized_email or "@" not in normalized_email:
            continue
        if email_domain(normalized_email) in internal_domains and header_name != "from":
            continue
        candidate_name = clean_candidate_name(name.strip()) or candidate_name_from_email(normalized_email)
        return candidate_name, normalized_email

    name, email = parseaddr(headers.get("from", ""))
    normalized_email = normalize_email(email)
    return name.strip() or candidate_name_from_email(normalized_email), normalized_email


def iter_parts(part: dict[str, Any]):
    yield part
    for child in part.get("parts", []) or []:
        yield from iter_parts(child)


def extract_primary_resume_part(message: dict[str, Any]) -> dict[str, Any] | None:
    payload = message.get("payload", {})
    for part in iter_parts(payload):
        filename = (part.get("filename") or "").strip()
        if not filename:
            continue
        if not filename.lower().endswith(RESUME_EXTENSIONS):
            continue
        body = part.get("body", {})
        if body.get("attachmentId") or body.get("data"):
            return part
    return None


def sorted_thread_messages(thread: dict[str, Any]) -> list[dict[str, Any]]:
    def sort_key(message: dict[str, Any]) -> int:
        raw = str(message.get("internalDate", "") or "").strip()
        try:
            return int(raw)
        except ValueError:
            return 0

    return sorted(thread.get("messages", []) or [], key=sort_key)


def extract_primary_resume_part_from_thread(thread: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    for message in sorted_thread_messages(thread):
        part = extract_primary_resume_part(message)
        if part:
            message_id = str(message.get("id", "") or "").strip()
            if message_id:
                return message_id, part
    return None


def extract_message_body_text(message: dict[str, Any]) -> str:
    payload = message.get("payload", {})
    chunks: list[str] = []
    for part in iter_parts(payload):
        mime_type = (part.get("mimeType") or "").lower()
        if mime_type not in {"text/plain", "text/html"}:
            continue
        data = (part.get("body", {}) or {}).get("data")
        if not data:
            continue
        try:
            decoded = base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")
        except Exception:
            continue
        chunks.append(decoded)
    return "\n".join(chunks)


def extract_resume_link_from_text(text: str) -> str:
    for match in RESUME_LINK_RE.finditer(text or ""):
        candidate = clean_text(match.group(0)).rstrip(".,;:)>\"'")
        lowered = candidate.lower()
        if any(host in lowered for host in RESUME_LINK_HOST_HINTS):
            return candidate
        if lowered.endswith(RESUME_LINK_FILE_HINTS):
            return candidate
    return ""


def extract_resume_link_from_thread(thread: dict[str, Any]) -> str:
    for message in sorted_thread_messages(thread):
        link = extract_resume_link_from_text(extract_message_body_text(message))
        if link:
            return link
    return ""


def gmail_message_attachment_bytes(gmail_service, message_id: str, part: dict[str, Any]) -> bytes:
    body = part.get("body", {})
    data = body.get("data")
    if data:
        return base64.urlsafe_b64decode(data.encode("utf-8"))

    attachment_id = body.get("attachmentId")
    if not attachment_id:
        raise ValueError("Attachment part missing data and attachmentId")

    response = (
        gmail_service.users()
        .messages()
        .attachments()
        .get(userId="me", messageId=message_id, id=attachment_id)
        .execute()
    )
    encoded = response.get("data", "")
    if not encoded:
        return b""
    return base64.urlsafe_b64decode(encoded.encode("utf-8"))


def extract_text_from_docx(raw: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(raw)) as archive:
            xml = archive.read("word/document.xml").decode("utf-8", errors="ignore")
    except Exception:
        return ""
    text = re.sub(r"<[^>]+>", " ", xml)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def get_docling_converter() -> Any | None:
    global _DOCLING_CONVERTER, _DOCLING_CHECKED
    if _DOCLING_CHECKED:
        return _DOCLING_CONVERTER

    _DOCLING_CHECKED = True
    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
    except Exception:
        _DOCLING_CONVERTER = None
        return None

    try:
        pdf_options = PdfPipelineOptions()
        pdf_options.ocr_options = TesseractCliOcrOptions(lang=["eng"], tesseract_cmd="tesseract")
        _DOCLING_CONVERTER = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options)}
        )
    except Exception:
        _DOCLING_CONVERTER = None
    return _DOCLING_CONVERTER


def extract_text_with_docling(filename: str, raw: bytes) -> str:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext not in DOCLING_PARSE_EXTENSIONS:
        return ""

    converter = get_docling_converter()
    if converter is None:
        return ""

    suffix = f".{ext}" if ext else ".pdf"
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="resume-", suffix=suffix, delete=False) as handle:
            handle.write(raw)
            temp_path = Path(handle.name)

        result = converter.convert(str(temp_path))
        document = getattr(result, "document", None)
        if document is None:
            return ""

        markdown_text = ""
        text_plain = ""
        export_markdown = getattr(document, "export_to_markdown", None)
        export_text = getattr(document, "export_to_text", None)
        if callable(export_markdown):
            try:
                markdown_text = str(export_markdown() or "").strip()
            except Exception:
                markdown_text = ""
        if callable(export_text):
            try:
                text_plain = str(export_text() or "").strip()
            except Exception:
                text_plain = ""

        if markdown_text:
            return markdown_text
        return text_plain
    except Exception:
        return ""
    finally:
        if temp_path and temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


def extract_resume_text(filename: str, raw: bytes) -> str:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    docling_text = extract_text_with_docling(filename, raw)
    if docling_text:
        return unescape(docling_text)
    if ext in {"txt", "rtf"}:
        return raw.decode("utf-8", errors="ignore").strip()
    if ext == "docx":
        return extract_text_from_docx(raw)
    if ext == "pdf":
        try:
            from pypdf import PdfReader
        except ModuleNotFoundError:
            return ""
        try:
            reader = PdfReader(BytesIO(raw))
            pages = [page.extract_text() or "" for page in reader.pages]
        except Exception:
            return ""
        return "\n".join(pages).strip()
    return ""


def clean_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text or "").strip()
    return cleaned


def classify_career_stage(text: str) -> str:
    lowered = text.lower()
    years = [int(match.group(0)) for match in re.finditer(r"\b(?:19|20)\d{2}\b", text)]
    if years:
        span = max(years) - min(years)
        if span <= 4:
            return "Early"
        if span <= 9:
            return "Mid"
        return "Late"

    if any(keyword in lowered for keyword in ["principal", "director", "head of", "vp", "staff", "lead"]):
        return "Late"
    if any(keyword in lowered for keyword in ["intern", "new grad", "entry", "associate"]):
        return "Early"
    return "Mid"


def split_resume_lines(text: str) -> list[str]:
    lines = []
    for chunk in re.split(r"[\n\r]+", text):
        chunk = chunk.strip(" -*\t")
        if not chunk:
            continue
        if len(chunk) < 3:
            continue
        lines.append(clean_text(chunk))
    return lines


TITLE_KEYWORDS = {
    "engineer",
    "developer",
    "manager",
    "director",
    "analyst",
    "designer",
    "consultant",
    "specialist",
    "lead",
    "principal",
    "architect",
    "scientist",
    "coordinator",
    "recruiter",
    "founder",
    "advisor",
    "president",
    "officer",
    "head",
    "executive",
}

MONTH_TO_INDEX = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}

LINKEDIN_CONFIDENCE_HIGH = "High"
LINKEDIN_CONFIDENCE_MEDIUM = "Medium"
LINKEDIN_CONFIDENCE_LOW = "Low"


def looks_like_title(text: str) -> bool:
    lowered = text.lower()
    pattern = r"\b(" + "|".join(sorted((re.escape(item) for item in TITLE_KEYWORDS), key=len, reverse=True)) + r")\b"
    return bool(re.search(pattern, lowered))


def extract_title_phrase(text: str) -> str:
    source = clean_text(text)
    if not source:
        return ""
    matches = list(
        re.finditer(
            r"(?i)\b(?:sr\.?|senior|lead|principal|staff|associate|assistant|vp|vice president|head|chief)?"
            r"(?:\s+[a-z][a-z/&-]*){0,5}\s+"
            r"(?:engineer|developer|manager|director|analyst|designer|consultant|specialist|lead|principal|"
            r"architect|scientist|coordinator|recruiter|founder|advisor|president|officer|executive)\b"
            r"(?:\s+[a-z0-9/&(),.-]+){0,4}",
            source,
        )
    )
    if not matches:
        return source
    phrase = source[matches[-1].start() : matches[-1].end()]
    return clean_text(phrase.strip(" -,:;"))


def clean_title_fragment(value: str) -> str:
    text = clean_text(value)
    if not text:
        return ""
    text = re.split(r"[•●|]", text, maxsplit=1)[0]
    text = re.sub(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b", " ", text)
    text = re.sub(r"\b(?:19|20)\d{2}\b", " ", text)
    if ". " in text and len(text) > 80:
        tail = text.rsplit(". ", 1)[-1]
        if looks_like_title(tail):
            text = tail
    vp_match = re.search(r"(?i)\b(vice president(?:,\s*[a-z0-9/&(). -]+)?)\b", text)
    if vp_match:
        return clean_text(vp_match.group(1).strip(" -,:;"))
    text = extract_title_phrase(text)
    text = clean_text(text.strip(" -,:;"))
    if len(text) > 120:
        text = text[:120].rstrip(" -,:;")
    return text


def clean_company_fragment(value: str) -> str:
    text = clean_text(value)
    if not text:
        return ""
    text = re.split(r"[•●|]", text, maxsplit=1)[0]
    text = re.sub(r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b", " ", text)
    text = re.sub(r"\b(?:19|20)\d{2}\b", " ", text)
    text = re.sub(r"\((?:remote|hybrid|onsite|on[-\s]?site)[^)]*\)", " ", text, flags=re.IGNORECASE)
    text = clean_text(text.split(",")[0].strip(" -,:;@"))
    if len(text) > 100:
        text = text[:100].rstrip(" -,:;")
    return text


def parse_role_company_line(line: str) -> tuple[str, str]:
    text = clean_text(line)
    if not text or len(text) > 900:
        return "", ""

    patterns = [
        r"(?i)^(?P<title>.+?)\s+at\s+(?P<company>.+)$",
        r"(?i)^(?P<title>.+?)\s*@\s*(?P<company>.+)$",
        r"(?i)^(?P<company>.+?)\s+[|–—-]\s*(?P<title>.+)$",
    ]
    for pattern in patterns:
        match = re.match(pattern, text)
        if not match:
            continue
        title = clean_title_fragment(match.group("title"))
        company = clean_company_fragment(match.group("company"))
        if not title or not company:
            continue
        if looks_like_title(title):
            return title, company
        reversed_title = clean_title_fragment(match.group("company"))
        reversed_company = clean_company_fragment(match.group("title"))
        if reversed_title and reversed_company and looks_like_title(reversed_title):
            return reversed_title, reversed_company
    return "", ""


def normalize_resume_line(line: str) -> str:
    return clean_text(line.replace("#", " ").strip())


def split_company_and_date(line: str) -> tuple[str, str]:
    text = normalize_resume_line(line)
    date_pattern = (
        r"(?i)\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}"
        r"(?:\s*[-–—]\s*(?:present|current|now|"
        r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}))?"
    )
    match = re.search(date_pattern, text)
    if not match:
        return "", ""
    company_part = clean_text(text[: match.start()].strip(" -|,:"))
    date_part = clean_text(text[match.start() :])
    return company_part, date_part


def infer_latest_from_docling_sections(source: str) -> tuple[str, str]:
    lines = [line for line in source.splitlines() if line.strip()]
    scored: list[tuple[int, str, str]] = []
    for idx, raw_line in enumerate(lines):
        company_part, date_part = split_company_and_date(raw_line)
        if not company_part or not date_part:
            continue

        company = clean_company_fragment(company_part)
        if not company or looks_like_title(company):
            continue

        best_title = ""
        for look_ahead in range(1, 7):
            if idx + look_ahead >= len(lines):
                break
            candidate_line = normalize_resume_line(lines[idx + look_ahead])
            if not candidate_line:
                continue
            if split_company_and_date(candidate_line)[0]:
                break
            if candidate_line.lower().startswith("professional experience"):
                continue
            candidate_title = clean_title_fragment(candidate_line)
            if looks_like_title(candidate_title):
                best_title = candidate_title
                break
        if not best_title:
            continue

        rank = timeline_rank(date_part)
        scored.append((rank, best_title, company))

    if not scored:
        return "", ""
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1], scored[0][2]


def timeline_rank(text: str) -> int:
    source = clean_text(text)
    if not source:
        return 0
    if re.search(r"\b(present|current|now)\b", source, flags=re.IGNORECASE):
        return 10_000_000

    ranks: list[int] = []
    for match in re.finditer(
        r"(?i)\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+((?:19|20)\d{2})\b",
        source,
    ):
        month = MONTH_TO_INDEX[match.group(1).lower()[:3]]
        year = int(match.group(2))
        ranks.append(year * 12 + month)
    for match in re.finditer(r"\b((?:19|20)\d{2})\b", source):
        ranks.append(int(match.group(1)) * 12)
    return max(ranks) if ranks else 0


def infer_current_title_and_company_from_resume(resume_text: str, snippet: str) -> tuple[str, str]:
    source = resume_text if resume_text.strip() else snippet
    latest_title, latest_company = infer_latest_from_docling_sections(source)
    if latest_title and latest_company:
        return latest_title, latest_company

    lines = split_resume_lines(source)

    scored_candidates: list[tuple[int, int, str, str]] = []
    for idx, line in enumerate(lines):
        title, company = parse_role_company_line(line)
        if not title or not company:
            continue
        context = " ".join(lines[max(0, idx - 1) : min(len(lines), idx + 2)])
        rank = max(timeline_rank(line), timeline_rank(context))
        quality = 2
        if any(token in line for token in {"•", "●"}) and len(line) > 150:
            quality = 1
        scored_candidates.append((rank, quality, title, company))

    if scored_candidates:
        scored_candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
        _rank, _quality, best_title, best_company = scored_candidates[0]
        return best_title or "Unknown", best_company or "Unknown"

    for line in lines:
        candidate = clean_title_fragment(line)
        if looks_like_title(candidate):
            return candidate, "Unknown"

    return "Unknown", "Unknown"


def normalize_extractor_evidence(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text or "")
    normalized = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    normalized = re.sub(r"[^\w\s]", " ", normalized.lower())
    return re.sub(r"\s+", " ", normalized).strip()


def extractor_evidence_items(evidence: Any) -> list[str]:
    if isinstance(evidence, str):
        return [evidence] if evidence.strip() else []
    if isinstance(evidence, list):
        return [str(item) for item in evidence if str(item).strip()]
    return []


def extractor_evidence_matches_source(evidence: Any, source: str) -> bool:
    evidence_items = extractor_evidence_items(evidence)
    if not evidence_items:
        return False

    normalized_source = normalize_extractor_evidence(source)
    if not normalized_source:
        return False
    for item in evidence_items:
        cleaned = clean_text(str(item))
        if not cleaned:
            continue
        if cleaned in source:
            continue
        normalized_item = normalize_extractor_evidence(cleaned)
        if normalized_item and normalized_item in normalized_source:
            continue
        return False
    return True


def extractor_evidence_supports_output(title: str, company: str, evidence: Any, source: str) -> bool:
    if not extractor_evidence_matches_source(evidence, source):
        return False
    normalized_title = normalize_extractor_evidence(title)
    normalized_company = normalize_extractor_evidence(company)
    normalized_source = normalize_extractor_evidence(source)
    normalized_evidence = normalize_extractor_evidence(" ".join(extractor_evidence_items(evidence)))
    if not normalized_title or not normalized_company:
        return False
    if normalized_title not in normalized_source or normalized_company not in normalized_source:
        return False
    return normalized_title in normalized_evidence and normalized_company in normalized_evidence


def capped_resume_extractor_source(resume_text: str, snippet: str, max_chars: int = 16_000) -> str:
    resume_part = (resume_text or "").strip()
    snippet_part = (snippet or "").strip()
    if not resume_part:
        return snippet_part[:max_chars]
    if not snippet_part:
        return resume_part[:max_chars]

    separator = "\n\nEmail snippet:\n"
    remaining = max_chars - len(separator)
    if remaining <= 0:
        return resume_part[:max_chars]
    resume_budget = min(len(resume_part), max(0, remaining - min(len(snippet_part), 2_000)))
    snippet_budget = max(0, remaining - resume_budget)
    return f"{resume_part[:resume_budget]}{separator}{snippet_part[:snippet_budget]}"


def build_resume_extractor_prompt(source: str) -> str:
    return (
        "Extract the candidate's full name and latest current role and company from the resume text. "
        "Use only the provided source. Prefer explicitly current or most recent experience. "
        "Return only strict JSON with keys candidate_name, latest_current_title, latest_current_company, "
        "confidence, and evidence. "
        "candidate_name must be the person's actual full name (e.g. 'Dikshith Reddy M'), NOT an objective, "
        "headline, summary, or job-search phrase such as 'seeking AI roles in Canada'. If the real name is "
        "not clearly present, return an empty candidate_name. "
        "confidence must be one of low, medium, high. "
        "evidence must be a short exact quote or list of exact quotes copied from the source "
        "that supports the extracted current role/company. If uncertain, use empty strings and low confidence.\n\n"
        f"Source:\n{source}"
    )


def call_openai_resume_extractor(config: Config, resume_text: str, snippet: str) -> dict[str, Any]:
    if requests is None or not config.openai_api_key:
        return {}

    source = capped_resume_extractor_source(resume_text, snippet)
    if not source.strip():
        return {}

    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {config.openai_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": config.resume_extractor_model or "gpt-4.1-mini",
                "temperature": 0,
                "response_format": {"type": "json_object"},
                "messages": [{"role": "user", "content": build_resume_extractor_prompt(source)}],
            },
            timeout=45,
        )
    except Exception:
        return {}
    if not response.ok:
        return {}
    try:
        body = response.json()
    except ValueError:
        return {}

    content = (
        ((body.get("choices") or [{}])[0].get("message") or {}).get("content", "")
        if isinstance(body.get("choices"), list)
        else ""
    )
    return _finalize_resume_extraction(content, source)


def confidence_is_acceptable(raw: Any) -> bool:
    # Models return confidence either as a label (low/medium/high) or a number
    # (e.g. 0.95). Accept medium/high labels or a numeric score >= 0.6.
    if isinstance(raw, bool):
        return False
    if isinstance(raw, (int, float)):
        return float(raw) >= 0.6
    text = clean_text(str(raw or "")).lower()
    if text in {"medium", "high"}:
        return True
    try:
        return float(text) >= 0.6
    except ValueError:
        return False


def _finalize_resume_extraction(content: str, source: str) -> dict[str, Any]:
    try:
        parsed = json.loads(str(content).strip())
    except ValueError:
        parsed = extract_json_object(str(content))
    if not isinstance(parsed, dict) or not parsed:
        return {}

    result: dict[str, Any] = {}
    name = clean_candidate_name(str(parsed.get("candidate_name", "") or ""))
    if name and looks_like_person_name(name):
        result["candidate_name"] = name

    title = clean_text(str(parsed.get("latest_current_title", "") or ""))
    company = clean_text(str(parsed.get("latest_current_company", "") or ""))
    confidence = clean_text(str(parsed.get("confidence", "") or "")).lower()
    evidence = parsed.get("evidence")
    if (
        title
        and company
        and confidence_is_acceptable(parsed.get("confidence"))
        and extractor_evidence_supports_output(title, company, evidence, source)
    ):
        result["latest_current_title"] = title
        result["latest_current_company"] = company
        result["confidence"] = confidence
        result["evidence"] = evidence
    return result


def call_anthropic_resume_extractor(config: Config, resume_text: str, snippet: str) -> dict[str, Any]:
    if requests is None or not config.anthropic_api_key:
        return {}
    source = capped_resume_extractor_source(resume_text, snippet)
    if not source.strip():
        return {}
    try:
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": config.anthropic_api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": config.resume_extractor_model_anthropic or "claude-haiku-4-5",
                "max_tokens": 600,
                "temperature": 0,
                "messages": [{"role": "user", "content": build_resume_extractor_prompt(source)}],
            },
            timeout=45,
        )
    except Exception:
        return {}
    if not response.ok:
        return {}
    try:
        body = response.json()
    except ValueError:
        return {}
    content = "\n".join(
        str(item.get("text", ""))
        for item in (body.get("content") or [])
        if isinstance(item, dict) and item.get("type") == "text"
    )
    return _finalize_resume_extraction(content, source)


def resume_extractor_providers(config: Config) -> list[str]:
    provider = (config.resume_extractor_provider or "off").strip().lower()
    if provider in {"", "off", "none", "false", "0"}:
        return []
    if provider in {"auto", "both", "claude_then_openai", "anthropic_then_openai"}:
        return ["anthropic", "openai"]
    if provider in {"anthropic", "claude"}:
        return ["anthropic"]
    if provider == "openai":
        return ["openai"]
    return []


def extract_resume_fields(config: Config, resume_text: str, snippet: str) -> dict[str, Any]:
    """Run the configured resume extractor(s) as a waterfall and merge results.

    With provider 'auto'/'both', Claude runs first and OpenAI fills any field Claude
    left empty. Returns a dict that may include candidate_name, latest_current_title,
    and latest_current_company.
    """
    merged: dict[str, Any] = {}
    for provider in resume_extractor_providers(config):
        parsed = (
            call_anthropic_resume_extractor(config, resume_text, snippet)
            if provider == "anthropic"
            else call_openai_resume_extractor(config, resume_text, snippet)
        )
        for key, value in (parsed or {}).items():
            if value and not merged.get(key):
                merged[key] = value
        if (
            merged.get("candidate_name")
            and merged.get("latest_current_title")
            and merged.get("latest_current_company")
        ):
            break
    return merged


def extract_latest_resume_role_company(config: Config, resume_text: str, snippet: str) -> tuple[str, str]:
    parsed = extract_resume_fields(config, resume_text, snippet)
    return (
        clean_text(str(parsed.get("latest_current_title", "") or "")),
        clean_text(str(parsed.get("latest_current_company", "") or "")),
    )


def extract_resume_candidate_name(config: Config, resume_text: str, snippet: str) -> str:
    parsed = extract_resume_fields(config, resume_text, snippet)
    return clean_text(str(parsed.get("candidate_name", "") or ""))


def normalize_linkedin_url(url: str) -> str:
    raw = clean_text(url).strip().rstrip(".,;:)")
    if not raw:
        return ""
    if not raw.startswith(("http://", "https://")):
        raw = f"https://{raw}"
    try:
        parsed = urlparse(raw)
    except Exception:
        return ""
    host = parsed.netloc.lower()
    if "linkedin.com" not in host:
        return ""
    path = (parsed.path or "").rstrip("/")
    query = parsed.query or ""
    lowered_path = path.lower()
    if "/in/" in lowered_path or "/pub/" in lowered_path:
        suffix = f"?{query}" if query else ""
        return f"https://{host}{path}{suffix}"

    # Some resumes use legacy profile links like linkedin.com/first-last (no /in/ segment).
    segments = [segment for segment in lowered_path.split("/") if segment]
    disallowed = {
        "company",
        "school",
        "jobs",
        "feed",
        "learning",
        "sales",
        "groups",
        "events",
        "posts",
        "news",
        "pulse",
        "showcase",
        "help",
        "signin",
        "signup",
        "in",
        "pub",
    }
    if len(segments) == 1 and segments[0] not in disallowed:
        if re.fullmatch(r"[a-z0-9][a-z0-9-]{1,120}", segments[0]):
            suffix = f"?{query}" if query else ""
            return f"https://{host}{path}{suffix}"
    return ""


def extract_linkedin_url_from_pdf(raw: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ModuleNotFoundError:
        return ""

    try:
        reader = PdfReader(BytesIO(raw))
    except Exception:
        return ""

    # Prefer hyperlink annotations because many resumes embed LinkedIn URLs that text extraction omits.
    for page in reader.pages:
        annots = page.get("/Annots", []) or []
        for annot_ref in annots:
            try:
                annot = annot_ref.get_object()
            except Exception:
                continue
            action = annot.get("/A")
            if not action:
                continue
            uri = action.get("/URI")
            if not uri:
                continue
            normalized = normalize_linkedin_url(str(uri))
            if normalized:
                return normalized
    return ""


def extract_linkedin_url_from_docx(raw: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(raw)) as archive:
            rel_files = [name for name in archive.namelist() if name.startswith("word/_rels/") and name.endswith(".rels")]
            for rel_file in rel_files:
                rel_xml = archive.read(rel_file).decode("utf-8", errors="ignore")
                for match in re.finditer(r'Target="([^"]+linkedin\.com[^"]+)"', rel_xml, flags=re.IGNORECASE):
                    normalized = normalize_linkedin_url(match.group(1))
                    if normalized:
                        return normalized
    except Exception:
        return ""
    return ""


def extract_linkedin_url(
    resume_text: str,
    snippet: str,
    filename: str,
    raw: bytes,
    message_body_text: str = "",
) -> str:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    if ext == "pdf":
        from_pdf = extract_linkedin_url_from_pdf(raw)
        if from_pdf:
            return from_pdf
    if ext == "docx":
        from_docx = extract_linkedin_url_from_docx(raw)
        if from_docx:
            return from_docx

    source = f"{resume_text}\n{snippet}\n{message_body_text}\n{raw.decode('utf-8', errors='ignore')}"
    patterns = [
        r"(https?://(?:[a-z]{2,3}\.)?linkedin\.com/[^\s)>\"]+)",
        r"((?:[a-z]{2,3}\.)?linkedin\.com/[^\s)>\"]+)",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, source, flags=re.IGNORECASE):
            normalized = normalize_linkedin_url(match.group(1))
            if normalized:
                return normalized
    return ""


def extract_linkedin_urls_from_search_html(html_text: str) -> list[str]:
    source = unescape(html_text or "")
    candidates: list[str] = []

    for match in re.finditer(r"/url\?q=([^&\"'>]+)", source, flags=re.IGNORECASE):
        candidate = normalize_linkedin_url(unquote(match.group(1)))
        if candidate:
            candidates.append(candidate)

    for match in re.finditer(
        r"https?://[^\s\"'<>]*linkedin\.com/(?:in|pub)/[^\s\"'<>]+",
        source,
        flags=re.IGNORECASE,
    ):
        candidate = normalize_linkedin_url(unquote(match.group(0)))
        if candidate:
            candidates.append(candidate)

    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        deduped.append(candidate)
    return deduped


def linkedin_confidence_for_result(
    linkedin_url: str,
    candidate_name: str,
    company: str,
    current_title: str,
    page_text: str,
) -> tuple[str, int]:
    score = 0
    parsed = urlparse(linkedin_url)
    slug = parsed.path.lower().replace("-", " ").replace("/", " ")
    haystack = clean_text(page_text).lower()

    name_tokens = [token for token in re.findall(r"[a-z]+", candidate_name.lower()) if len(token) >= 3]
    if name_tokens:
        matched_name_tokens = sum(1 for token in name_tokens if token in slug)
        if matched_name_tokens >= 2:
            score += 3
        elif matched_name_tokens == 1:
            score += 1

    company_tokens = [token for token in re.findall(r"[a-z]+", company.lower()) if len(token) >= 4]
    if company_tokens and any(token in haystack for token in company_tokens):
        score += 2

    title_tokens = [token for token in re.findall(r"[a-z]+", current_title.lower()) if len(token) >= 5]
    if title_tokens and any(token in haystack for token in title_tokens):
        score += 1

    if score >= 5:
        return LINKEDIN_CONFIDENCE_HIGH, score
    if score >= 3:
        return LINKEDIN_CONFIDENCE_MEDIUM, score
    return LINKEDIN_CONFIDENCE_LOW, score


def google_search_linkedin_url(candidate_name: str, company: str, current_title: str) -> tuple[str, str]:
    if requests is None or not candidate_name.strip():
        return "", ""

    query_parts = [candidate_name.strip(), "LinkedIn"]
    if company.strip():
        query_parts.append(company.strip())
    elif current_title.strip():
        query_parts.append(current_title.strip())
    query = " ".join(query_parts)

    headers = {"User-Agent": "Mozilla/5.0 (compatible; RecruiterBot/1.0)"}
    search_requests = [
        ("https://www.google.com/search", {"q": query, "num": "5", "hl": "en"}),
        ("https://duckduckgo.com/html/", {"q": query}),
    ]

    best_url = ""
    best_confidence = ""
    best_score = -1

    for endpoint, params in search_requests:
        try:
            response = requests.get(endpoint, params=params, headers=headers, timeout=15)
        except Exception:
            continue
        if not response.ok:
            continue

        html_text = response.text
        for candidate_url in extract_linkedin_urls_from_search_html(html_text):
            confidence, score = linkedin_confidence_for_result(
                candidate_url,
                candidate_name=candidate_name,
                company=company,
                current_title=current_title,
                page_text=html_text,
            )
            if score > best_score:
                best_score = score
                best_url = candidate_url
                best_confidence = confidence
                if best_confidence == LINKEDIN_CONFIDENCE_HIGH:
                    return best_url, best_confidence

    return best_url, best_confidence


def unipile_configured(config: Config) -> bool:
    return bool(config.unipile_dsn and config.unipile_api_key and config.unipile_account_id)


def linkedin_identifier_from_url(url: str) -> str:
    match = re.search(r"linkedin\.com/(?:in|pub)/([^/?#]+)", clean_text(url), re.IGNORECASE)
    return match.group(1).strip() if match else ""


def unipile_search_linkedin_url(
    config: Config, candidate_name: str, company: str, current_title: str
) -> tuple[str, str]:
    """Find a candidate's LinkedIn URL via the Unipile API (real LinkedIn search,
    not HTML scraping). Mirrors the revve/gtm-os unipile-linkedin skill:
    POST /api/v1/linkedin/search with {api: classic, category: people, keywords}."""
    if requests is None or not unipile_configured(config) or not candidate_name.strip():
        return "", ""
    keywords = " ".join(part for part in [candidate_name.strip(), company.strip()] if part) or candidate_name.strip()
    try:
        response = requests.post(
            f"{config.unipile_dsn.rstrip('/')}/api/v1/linkedin/search",
            params={"account_id": config.unipile_account_id},
            headers={"X-API-KEY": config.unipile_api_key, "Content-Type": "application/json", "accept": "application/json"},
            json={"api": "classic", "category": "people", "keywords": keywords},
            timeout=30,
        )
    except Exception:
        return "", ""
    if not response.ok:
        return "", ""
    try:
        data = response.json()
    except ValueError:
        return "", ""

    best_url, best_confidence, best_score = "", "", -1
    for item in (data.get("items") or []):
        if not isinstance(item, dict):
            continue
        public_identifier = clean_text(str(item.get("public_identifier", "") or ""))
        if not public_identifier:
            continue
        candidate_url = f"https://www.linkedin.com/in/{public_identifier}"
        page_text = " ".join(
            str(item.get(key, "") or "")
            for key in ("name", "first_name", "last_name", "headline", "location")
        )
        confidence, score = linkedin_confidence_for_result(
            candidate_url,
            candidate_name=candidate_name,
            company=company,
            current_title=current_title,
            page_text=page_text,
        )
        if score > best_score:
            best_score, best_url, best_confidence = score, candidate_url, confidence
            if confidence == LINKEDIN_CONFIDENCE_HIGH:
                return best_url, best_confidence
    return best_url, best_confidence


def find_linkedin_url_for_candidate(
    config: Config, candidate_name: str, company: str, current_title: str
) -> tuple[str, str]:
    """Unipile-first LinkedIn URL discovery, falling back to the legacy web-search
    scrape only when Unipile is not configured or returns nothing."""
    if unipile_configured(config):
        url, confidence = unipile_search_linkedin_url(config, candidate_name, company, current_title)
        if url:
            return url, confidence
    return google_search_linkedin_url(candidate_name, company, current_title)


def unipile_profile_title_company(config: Config, linkedin_url: str) -> tuple[str, str]:
    """Fetch current title/company straight from LinkedIn via Unipile
    (GET /api/v1/users/{identifier}). Conservative parse: only returns values from
    structured experience entries, otherwise empty so the caller can fall back."""
    if requests is None or not unipile_configured(config):
        return "", ""
    identifier = linkedin_identifier_from_url(linkedin_url)
    if not identifier:
        return "", ""
    try:
        response = requests.get(
            f"{config.unipile_dsn.rstrip('/')}/api/v1/users/{identifier}",
            params={"account_id": config.unipile_account_id},
            headers={"X-API-KEY": config.unipile_api_key, "accept": "application/json"},
            timeout=30,
        )
    except Exception:
        return "", ""
    if not response.ok:
        return "", ""
    try:
        data = response.json()
    except ValueError:
        return "", ""
    # Prefer structured experience when the response carries it (some account
    # tiers / endpoints do); otherwise parse the LinkedIn headline, which the basic
    # /users response does return (e.g. "Account Executive at Stripe").
    work = data.get("work_experience") or data.get("experience") or data.get("positions")
    if isinstance(work, list) and work and isinstance(work[0], dict):
        first = work[0]
        title = clean_text(str(first.get("position") or first.get("title") or ""))
        company = clean_text(str(first.get("company") or first.get("company_name") or ""))
        if title or company:
            return title, company
    return parse_title_company_from_headline(str(data.get("headline", "") or ""))


def parse_title_company_from_headline(headline: str) -> tuple[str, str]:
    """Best-effort split of a LinkedIn headline into (title, company).
    "Account Executive at Stripe" -> ("Account Executive", "Stripe").
    "AE @ Stripe | helping teams" -> ("AE", "Stripe"). Returns empty when there is
    no clear "<title> at/@ <company>" so the caller falls back to PDL."""
    text = clean_text(headline)
    if not text:
        return "", ""
    # Headlines often pack extra after a separator; keep the first segment.
    segment = re.split(r"\s*[|•·]\s*", text)[0].strip()
    parts = re.split(r"\s+(?:at|@)\s+", segment, maxsplit=1, flags=re.IGNORECASE)
    if len(parts) != 2:
        return "", ""
    title = clean_text(parts[0])
    company = clean_text(re.split(r"\s*[|•·,]\s*", parts[1])[0])
    return title, company


def enrich_linkedin_title_company(config: Config, linkedin_url: str) -> tuple[str, str]:
    """Prefer Unipile's real LinkedIn profile for title/company; fall back to PDL."""
    if unipile_configured(config):
        title, company = unipile_profile_title_company(config, linkedin_url)
        if title or company:
            return title, company
    return enrich_title_company_from_linkedin(linkedin_url, config.pdl_api_key)


def enrich_title_company_from_linkedin(linkedin_url: str, pdl_api_key: str) -> tuple[str, str]:
    if not linkedin_url or not pdl_api_key or requests is None:
        return "", ""

    endpoint = "https://api.peopledatalabs.com/v5/person/enrich"
    params = {
        "api_key": pdl_api_key,
        "profile": linkedin_url,
        "min_likelihood": 2,
    }

    try:
        response = requests.get(endpoint, params=params, timeout=30)
    except Exception:
        return "", ""
    if not response.ok:
        return "", ""
    try:
        payload = response.json()
    except ValueError:
        return "", ""

    title = clean_text(str(payload.get("job_title", "") or ""))
    company = clean_text(str(payload.get("job_company_name", "") or ""))

    # Fallback to latest experience entry when top-level fields are empty.
    if (not title or not company) and isinstance(payload.get("experience"), list):
        for item in payload.get("experience", []):
            if not isinstance(item, dict):
                continue
            cand_title = clean_text(str(item.get("title", "") or ""))
            cand_company = clean_text(str(item.get("company", {}).get("name", "") if isinstance(item.get("company"), dict) else item.get("company", "") or ""))
            if cand_title and not title:
                title = cand_title
            if cand_company and not company:
                company = cand_company
            if title and company:
                break

    return title, company


def enrich_name_from_linkedin(linkedin_url: str, pdl_api_key: str) -> str:
    if not linkedin_url or not pdl_api_key or requests is None:
        return ""

    endpoint = "https://api.peopledatalabs.com/v5/person/enrich"
    params = {
        "api_key": pdl_api_key,
        "profile": linkedin_url,
        "min_likelihood": 2,
    }

    try:
        response = requests.get(endpoint, params=params, timeout=30)
    except Exception:
        return ""
    if not response.ok:
        return ""
    try:
        payload = response.json()
    except ValueError:
        return ""

    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return clean_candidate_name(str(data.get("full_name", "") or data.get("name", "") or ""))


US_KEYWORDS = {
    "usa",
    "u.s.",
    "united states",
    "us citizen",
    "california",
    "new york",
    "texas",
    "florida",
    "washington",
    "massachusetts",
    "illinois",
    "virginia",
    "new jersey",
    "north carolina",
    "georgia",
    "colorado",
    "pennsylvania",
    "ohio",
}


NON_US_KEYWORDS = {
    "canada",
    "united kingdom",
    "uk",
    "india",
    "singapore",
    "australia",
    "germany",
    "france",
    "spain",
    "netherlands",
    "brazil",
    "mexico",
    "china",
    "japan",
    "pakistan",
    "bangladesh",
    "philippines",
    "nigeria",
}


ROLE_CANONICAL = {
    "ae": "AE",
    "account executive": "AE",
    "bdr": "BDR",
    "sdr": "BDR",
    "founding sdr": "BDR",
    "growth generalist": "Growth Generalist",
    "growth associate": "Growth Generalist",
    "gtm associate": "Growth Generalist",
}

ROLE_NOISE_TOKENS = re.compile(
    r"(?i)\b(application|applying|candidate|role|position|positions|job|submission)\b"
)
INVALID_ROLE_FRAGMENTS = (
    "fwd:",
    "former yc",
    "recruitment continues",
    "moderator's spam report",
    "spam report",
    "contract idea",
)
SUBJECT_ROLE_PREFIX_RE = re.compile(r"(?i)^(?:attn|attention)\s*:\s*.+$")


def classify_location(resume_text: str, snippet: str) -> str:
    source = resume_text if resume_text.strip() else snippet
    lowered = source.lower()
    if any(keyword in lowered for keyword in US_KEYWORDS):
        return "U.S."
    if any(keyword in lowered for keyword in NON_US_KEYWORDS):
        return "non-U.S."
    return "non-U.S."


def canonicalize_truewind_role(raw_value: str) -> str:
    cleaned = clean_text(raw_value)
    lowered = cleaned.lower()
    if not cleaned:
        return "Unknown"
    if any(fragment in lowered for fragment in INVALID_ROLE_FRAGMENTS):
        return "Unknown"

    if lowered in ROLE_CANONICAL:
        return ROLE_CANONICAL[lowered]
    if "generalist" in lowered or "genaralist" in lowered:
        return "Growth Generalist"
    if "growth marketing" in lowered:
        return "Growth Generalist"
    if "growth associate" in lowered or "gtm associate" in lowered:
        return "Growth Generalist"
    if "account executive" in lowered or "acount executive" in lowered or re.search(r"\bae\b", lowered):
        return "AE"
    if "bdr" in lowered or "business development representative" in lowered:
        return "BDR"
    if "sdr" in lowered:
        return "BDR"

    stripped = ROLE_NOISE_TOKENS.sub(" ", cleaned)
    stripped = clean_text(stripped).strip("-:|,;")
    if not stripped:
        return "Unknown"
    return "Other"


def infer_truewind_role_from_subject(subject: str, fallback_candidate_name: str = "") -> str:
    parsed_subject = parse_required_subject(subject, fallback_candidate_name)
    if parsed_subject and parsed_subject[0] not in {"Unknown", "Other"}:
        return parsed_subject[0]
    role = canonicalize_truewind_role(subject)
    return role if role not in {"Unknown", "Other"} else "Unknown"


def clean_candidate_name(value: str) -> str:
    name = clean_text(value).strip("\"' ")
    while len(name) >= 2 and name[0] in "[({<" and name[-1] in "])}>":
        name = clean_text(name[1:-1]).strip("\"' ")
    return name


def parse_required_subject(subject: str, fallback_candidate_name: str = "") -> tuple[str, str] | None:
    # Required prefix: [hiring@]. Candidate name may come from subject or sender fallback.
    normalized = clean_text(subject)
    normalized = re.sub(r"^(?:fwd?:|re:)\s*", "", normalized, flags=re.IGNORECASE)
    normalized = normalized.replace("–", "-").replace("—", "-")
    prefix_match = re.match(r"^\[(?P<prefix>[^\]]+)\]\s*(?P<body>.*)$", normalized)
    if not prefix_match:
        return None
    if prefix_match.group("prefix").strip().lower() != "hiring@":
        return None
    body = clean_text(prefix_match.group("body"))
    fallback_name = clean_candidate_name(fallback_candidate_name)
    if not body and fallback_name:
        return "Unknown", fallback_name

    subject_parts = [clean_text(part) for part in re.split(r"\s*-\s*", body) if clean_text(part)]
    for idx, part in enumerate(subject_parts):
        role = canonicalize_truewind_role(part)
        if role in ROLE_OPTIONS and role != "Other":
            candidate_tail = " - ".join(subject_parts[idx + 1 :])
            candidate_name = clean_candidate_name(candidate_tail)
            if not candidate_name or canonicalize_truewind_role(candidate_name) in {"AE", "BDR", "Growth Generalist"}:
                candidate_name = fallback_name
            if candidate_name:
                return role, candidate_name
        if idx == 0 and SUBJECT_ROLE_PREFIX_RE.match(part):
            continue

    match = re.match(r"^\s*(?P<left>.+?)\s*-\s*(?P<right>.+?)\s*$", body)
    if match:
        left = clean_text(match.group("left"))
        right = clean_text(match.group("right"))
        role = canonicalize_truewind_role(left)
        candidate_name = clean_candidate_name(right)

        # Subjects like "Application - BDR Growth" contain role on the right side.
        if role == "Unknown" and fallback_name:
            alt_role = canonicalize_truewind_role(right)
            if alt_role != "Unknown":
                role = alt_role
                candidate_name = fallback_name

        if not candidate_name:
            candidate_name = fallback_name
        if candidate_name:
            return role, candidate_name

    role = canonicalize_truewind_role(body)
    if not fallback_name:
        return None
    return role, fallback_name


def upload_resume_to_drive(drive_service, filename: str, raw: bytes, folder_id: str) -> str:
    _, _, _, _, MediaIoBaseUpload = require_google_dependencies()

    safe_name = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{filename}"
    metadata: dict[str, Any] = {"name": safe_name}
    if folder_id:
        metadata["parents"] = [folder_id]

    mime_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    media = MediaIoBaseUpload(BytesIO(raw), mimetype=mime_type, resumable=False)
    created = execute_google_request(
        drive_service.files().create(body=metadata, media_body=media, fields="id,webViewLink"),
        description=f"Google Drive resume upload {safe_name}",
    )
    file_id = created.get("id", "")
    return created.get("webViewLink") or (f"https://drive.google.com/file/d/{file_id}/view" if file_id else "")


def gmail_label_id(gmail_service, label_name: str) -> str:
    labels = gmail_service.users().labels().list(userId="me").execute().get("labels", [])
    for label in labels:
        if label.get("name", "").strip() == label_name:
            return label.get("id", "")
    raise ValueError(f"Gmail label not found: {label_name}")


def list_label_messages(gmail_service, label_id: str, query: str, max_messages: int) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    page_token: str | None = None
    while len(messages) < max_messages:
        response = execute_google_request(
            gmail_service.users()
            .messages()
            .list(
                userId="me",
                labelIds=[label_id],
                q=query,
                maxResults=min(100, max_messages - len(messages)),
                pageToken=page_token,
            ),
            description=f"Gmail label message search {query or label_id}",
        )
        batch = response.get("messages", [])
        if not batch:
            break
        messages.extend(batch)
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return messages


def list_messages_matching_query(gmail_service, query: str, max_messages: int) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    page_token: str | None = None
    while len(messages) < max_messages:
        response = execute_google_request(
            gmail_service.users()
            .messages()
            .list(
                userId="me",
                q=query,
                maxResults=min(100, max_messages - len(messages)),
                pageToken=page_token,
            ),
            description=f"Gmail message search {query}",
        )
        batch = response.get("messages", [])
        if not batch:
            break
        messages.extend(batch)
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return messages


def merge_gmail_message_refs(*batches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen_threads: set[str] = set()
    seen_messages: set[str] = set()
    for batch in batches:
        for item in batch:
            thread_id = str(item.get("threadId", "") or "").strip()
            message_id = str(item.get("id", "") or "").strip()
            dedupe_key = thread_id or message_id
            if not dedupe_key:
                continue
            if thread_id and thread_id in seen_threads:
                continue
            if not thread_id and message_id in seen_messages:
                continue
            merged.append(item)
            if thread_id:
                seen_threads.add(thread_id)
            if message_id:
                seen_messages.add(message_id)
    return merged


def list_threads_matching_query(gmail_service, query: str, max_threads: int = 50) -> list[dict[str, Any]]:
    threads: list[dict[str, Any]] = []
    page_token: str | None = None
    while len(threads) < max_threads:
        response = execute_google_request(
            gmail_service.users()
            .threads()
            .list(
                userId="me",
                q=query,
                maxResults=min(100, max_threads - len(threads)),
                pageToken=page_token,
            ),
            description=f"Gmail thread search {query}",
            attempts=2,
        )
        batch = response.get("threads", [])
        if not batch:
            break
        threads.extend(batch)
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return threads


def extract_last_thread_message_headers(gmail_service, thread_id: str) -> tuple[str, str, str]:
    thread = (
        gmail_service.users()
        .threads()
        .get(
            userId="me",
            id=thread_id,
            format="metadata",
            metadataHeaders=["Subject", "Message-ID", "References"],
        )
        .execute()
    )
    messages = thread.get("messages", [])
    if not messages:
        raise ValueError(f"Thread {thread_id} has no messages")
    latest = messages[-1]
    headers = {
        entry.get("name", "").lower(): entry.get("value", "")
        for entry in latest.get("payload", {}).get("headers", [])
    }
    subject = headers.get("subject", "").strip() or "Application update"
    message_id = headers.get("message-id", "").strip()
    references = headers.get("references", "").strip()
    if not message_id:
        raise ValueError(f"Missing Message-ID in thread {thread_id}")
    return subject, message_id, references


def resolve_recipient_first_name(gmail_service, thread_id: str, to_email: str) -> str:
    recipient_email = normalize_email(to_email)
    if not recipient_email:
        return "there"
    try:
        thread = (
            gmail_service.users()
            .threads()
            .get(userId="me", id=thread_id, format="metadata", metadataHeaders=["From"])
            .execute()
        )
    except Exception:
        return extract_first_name("", recipient_email)

    for message in reversed(thread.get("messages", [])):
        headers = {
            entry.get("name", "").lower(): entry.get("value", "")
            for entry in message.get("payload", {}).get("headers", [])
        }
        from_name, from_email = parseaddr(headers.get("from", ""))
        if normalize_email(from_email) == recipient_email:
            return extract_first_name(from_name, recipient_email)
    return extract_first_name("", recipient_email)


def apply_email_greeting(body_text: str, first_name: str) -> str:
    text = (body_text or "").strip()
    if not text:
        return f"Hi {first_name},"
    if re.match(r"(?is)^hi\s+[^\n,]+,\s*\n", text):
        return text
    return f"Hi {first_name},\n\n{text}"


def create_reply_draft(
    gmail_service,
    *,
    sender_email: str,
    to_email: str,
    thread_id: str,
    body_text: str,
    subject_override: str | None = None,
) -> str:
    subject, replied_message_id, references = extract_last_thread_message_headers(gmail_service, thread_id)
    reply_subject = subject_override or (subject if subject.lower().startswith("re:") else f"Re: {subject}")
    merged_references = references if replied_message_id in references else f"{references} {replied_message_id}".strip()
    first_name = resolve_recipient_first_name(gmail_service, thread_id, to_email)
    body_with_greeting = apply_email_greeting(body_text, first_name)

    message = EmailMessage()
    message["From"] = sender_email
    message["To"] = to_email
    message["Subject"] = reply_subject
    message["In-Reply-To"] = replied_message_id
    message["References"] = merged_references
    if normalize_email(to_email) != normalize_email(DEFAULT_DRAFT_BCC):
        message["Bcc"] = DEFAULT_DRAFT_BCC
    message.set_content(body_with_greeting)

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
    created = (
        gmail_service.users()
        .drafts()
        .create(userId="me", body={"message": {"raw": raw, "threadId": thread_id}})
        .execute()
    )
    return created.get("id", "")


def get_gmail_draft(gmail_service, draft_id: str) -> dict[str, Any] | None:
    if not draft_id:
        return None
    try:
        return gmail_service.users().drafts().get(userId="me", id=draft_id, format="full").execute()
    except Exception:
        return None


def gmail_draft_created_at(draft: dict[str, Any]) -> datetime | None:
    raw = str((draft.get("message") or {}).get("internalDate", "") or "").strip()
    if not raw:
        return None
    try:
        return datetime.fromtimestamp(int(raw) / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def gmail_draft_body_text(draft: dict[str, Any]) -> str:
    message = draft.get("message") or {}
    if not isinstance(message, dict):
        return ""
    return extract_message_body_text(message).strip()


def update_gmail_draft_body_text(
    gmail_service,
    *,
    draft: dict[str, Any],
    body_text: str,
) -> bool:
    draft_id = str(draft.get("id", "") or "").strip()
    message_payload = draft.get("message") or {}
    if not draft_id or not isinstance(message_payload, dict):
        return False
    thread_id = str(message_payload.get("threadId", "") or "").strip()
    headers = header_map(message_payload)
    message = EmailMessage()
    for header_name in ("from", "to", "cc", "bcc", "subject", "in-reply-to", "references"):
        value = headers.get(header_name, "").strip()
        if value:
            message[header_name.title()] = value
    message.set_content(body_text)
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
    try:
        gmail_service.users().drafts().update(
            userId="me",
            id=draft_id,
            body={"message": {"raw": raw, "threadId": thread_id}},
        ).execute()
    except Exception:
        return False
    return True


def repair_missing_greeting_draft(
    gmail_service,
    *,
    draft: dict[str, Any],
    body_text: str,
    candidate_name: str,
    candidate_email: str,
) -> tuple[str, bool]:
    if extract_greeting_first_name(body_text):
        return body_text, True
    first_name = extract_first_name(candidate_name, candidate_email)
    if not first_name or normalize_first_name_for_verification(first_name) in {"candidate", "there"}:
        return body_text, False
    repaired_body = apply_email_greeting(body_text, first_name)
    if repaired_body == body_text:
        return body_text, True
    if update_gmail_draft_body_text(gmail_service, draft=draft, body_text=repaired_body):
        return repaired_body, True
    return repaired_body, False


def send_gmail_draft(gmail_service, draft_id: str) -> str:
    if not draft_id:
        return ""
    try:
        sent = gmail_service.users().drafts().send(userId="me", body={"id": draft_id}).execute()
    except Exception:
        return ""
    return sent.get("id", "")


def extract_greeting_first_name(body_text: str) -> str:
    match = re.match(r"(?is)^\s*hi\s+([^,\n\r]+)\s*,", body_text or "")
    if not match:
        return ""
    return clean_text(match.group(1))


def normalize_first_name_for_verification(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", clean_text(value))
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z]", "", ascii_text.lower())


def first_name_from_display_name(value: str) -> str:
    cleaned = clean_candidate_name(value)
    if not cleaned:
        return ""
    return extract_first_name(cleaned, "")


def first_name_from_linkedin_url(value: str) -> str:
    normalized = normalize_linkedin_url(value)
    if not normalized:
        return ""
    parsed = urlparse(normalized)
    path_parts = [part for part in parsed.path.split("/") if part]
    if not path_parts:
        return ""
    slug = path_parts[-1]
    tokens = [token for token in re.split(r"[-_.%0-9]+", slug) if token and len(token) >= 2]
    if not tokens:
        return ""
    return tokens[0].capitalize()


# Tokens that mark a line as an objective/headline/summary or a role descriptor
# rather than a person's name. Guards against grabbing strings like
# "career AI/data/software roles in Canada" as the candidate name.
NON_NAME_TOKENS = frozenset({
    "seeking", "objective", "objectives", "summary", "profile", "career", "careers",
    "role", "roles", "position", "positions", "looking", "aspiring", "passionate",
    "experienced", "professional", "professionals", "engineer", "developer", "manager",
    "analyst", "intern", "student", "resume", "cv", "curriculum", "vitae", "data",
    "software", "ai", "ml", "remote", "canada", "usa", "available", "open",
})


def looks_like_person_name(value: str) -> bool:
    name = clean_text(value).strip("\"' ")
    if not name or len(name) > 40 or any(ch.isdigit() for ch in name):
        return False
    words = name.split()
    if not (1 <= len(words) <= 4):
        return False
    if any(word.lower().strip(".,") in NON_NAME_TOKENS for word in words):
        return False
    capitalized = sum(1 for word in words if word[:1].isupper())
    return capitalized >= max(1, len(words) - 1)


def likely_resume_name_lines(resume_text: str) -> list[str]:
    lines = [normalize_resume_line(line) for line in split_resume_lines(resume_text)]
    candidates: list[str] = []
    for line in lines[:12]:
        if not line:
            continue
        lowered = line.lower()
        if any(token in lowered for token in {
            "resume", "curriculum", "experience", "education", "linkedin", "email",
            "objective", "summary", "profile", "seeking", "looking for",
        }):
            continue
        if re.search(r"[@:/]|(?:\+?\d[\d\s().-]{6,})", line):
            continue
        words = re.findall(r"[A-Za-z][A-Za-z'’-]+", line)
        if not (1 <= len(words) <= 4):
            continue
        candidate = " ".join(words)
        if looks_like_person_name(candidate):
            candidates.append(candidate)
    return candidates[:3]


def first_names_from_resume_text(resume_text: str) -> list[str]:
    return [extract_first_name(line, "") for line in likely_resume_name_lines(resume_text)]


def candidate_email_display_first_names(
    gmail_service,
    *,
    thread_ids: list[str],
    candidate_email: str,
) -> list[str]:
    names: list[str] = []
    normalized_candidate_email = normalize_email(candidate_email)
    for thread_id in thread_ids:
        try:
            thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
        except Exception:
            continue
        for message in sorted_thread_messages(thread):
            headers = header_map(message)
            for header_name in ("from", "reply-to", "x-original-from", "x-original-sender"):
                display_name, address = parseaddr(headers.get(header_name, ""))
                if normalize_email(address) != normalized_candidate_email:
                    continue
                first_name = first_name_from_display_name(display_name)
                if first_name:
                    names.append(first_name)
    return list(dict.fromkeys(names))


def resume_first_names_from_threads(gmail_service, *, thread_ids: list[str]) -> list[str]:
    names: list[str] = []
    for thread_id in thread_ids:
        try:
            thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
        except Exception:
            continue
        resume_reference = extract_primary_resume_part_from_thread(thread)
        if not resume_reference:
            continue
        message_id, part = resume_reference
        filename = (part.get("filename") or "resume").strip() or "resume"
        raw = gmail_message_attachment_bytes(gmail_service, message_id, part)
        if not raw:
            continue
        names.extend(first_names_from_resume_text(extract_resume_text(filename, raw)))
    return list(dict.fromkeys(name for name in names if name))


SIGNOFF_PREFIX_RE = re.compile(
    r"(?i)^(?:best|thanks|thank you|thank you!|regards|sincerely|cheers|warmly|talk soon|appreciate it)[,!. ]*$"
)
EMAIL_QUOTE_START_RE = re.compile(
    r"(?is)(?:\n|^|\s)(?:On\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?.{0,180}?wrote:|From:\s|-----Original Message-----)"
)
EMAIL_BODY_NON_SIGNATURE_RE = re.compile(r"(?i)^(?:hi|hello|hey)(?:\s+.+)?[,!. ]*$")


def candidate_email_body_first_names(
    gmail_service,
    *,
    thread_ids: list[str],
    candidate_email: str,
) -> list[str]:
    names: list[str] = []
    normalized_candidate_email = normalize_email(candidate_email)
    if not normalized_candidate_email:
        return names
    for thread_id in thread_ids:
        try:
            thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
        except Exception:
            continue
        for message in sorted_thread_messages(thread):
            headers = header_map(message)
            from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
            if from_email != normalized_candidate_email:
                continue
            body = extract_message_body_text(message)
            names.extend(first_names_from_email_body(body))
    return list(dict.fromkeys(name for name in names if name))


def first_names_from_email_body(body_text: str) -> list[str]:
    quote_match = EMAIL_QUOTE_START_RE.search(body_text or "")
    if quote_match:
        body_text = (body_text or "")[: quote_match.start()]
    lines = [
        clean_text(re.sub(r"<[^>]+>", " ", line)).strip(" -\t")
        for line in (body_text or "").replace("\r", "\n").split("\n")
    ]
    lines = [line for line in lines if line]
    names: list[str] = []
    for idx, line in enumerate(lines):
        if idx > 0 and SIGNOFF_PREFIX_RE.match(lines[idx - 1]):
            first_name = first_name_from_display_name(line) if looks_like_person_name(line) else ""
            if first_name:
                names.append(first_name)
        if SIGNOFF_PREFIX_RE.match(line) and idx + 1 < len(lines):
            next_line = lines[idx + 1]
            first_name = first_name_from_display_name(next_line) if looks_like_person_name(next_line) else ""
            if first_name:
                names.append(first_name)
    for line in reversed(lines[-8:]):
        if EMAIL_BODY_NON_SIGNATURE_RE.match(line):
            continue
        first_name = first_name_from_display_name(line) if looks_like_person_name(line) else ""
        if first_name:
            names.append(first_name)
            break
    return list(dict.fromkeys(names))


def build_rejection_first_name_evidence(
    gmail_service,
    *,
    thread_ids: list[str],
    candidate_name: str,
    candidate_email: str,
    linkedin_url: str,
    pdl_api_key: str,
) -> dict[str, list[str]]:
    evidence: dict[str, list[str]] = {
        "email": candidate_email_display_first_names(
            gmail_service,
            thread_ids=thread_ids,
            candidate_email=candidate_email,
        ),
        "email_body": candidate_email_body_first_names(
            gmail_service,
            thread_ids=thread_ids,
            candidate_email=candidate_email,
        ),
        "resume": resume_first_names_from_threads(gmail_service, thread_ids=thread_ids),
        "linkedin": [],
        "linkedin_slug": [],
        "ats": [],
    }
    linkedin_profile_name = enrich_name_from_linkedin(linkedin_url, pdl_api_key)
    linkedin_first_name = extract_first_name(linkedin_profile_name, "") if linkedin_profile_name else ""
    if linkedin_first_name:
        evidence["linkedin"].append(linkedin_first_name)
    linkedin_slug_first_name = first_name_from_linkedin_url(linkedin_url)
    if linkedin_slug_first_name:
        evidence["linkedin_slug"].append(linkedin_slug_first_name)
    ats_first_name = extract_first_name(candidate_name, candidate_email)
    if ats_first_name:
        evidence["ats"].append(ats_first_name)
    return {source: list(dict.fromkeys(values)) for source, values in evidence.items()}


def run_rejection_name_verification_agent(
    *,
    draft_body: str,
    evidence: dict[str, list[str]],
) -> tuple[bool, str, str]:
    greeting_first_name = extract_greeting_first_name(draft_body)
    normalized_greeting = normalize_first_name_for_verification(greeting_first_name)
    if not normalized_greeting:
        return False, greeting_first_name, "missing greeting"
    if "@" in greeting_first_name or "." in greeting_first_name:
        return False, greeting_first_name, "greeting is not a first name"

    # This deterministic check is intentionally narrow: it verifies the salutation
    # name itself, not resume parsing quality. OCR often extracts section headers
    # as candidate names, so unrelated resume tokens should not block a correct
    # "Hi <first name>" greeting.
    expected: dict[str, str] = {}
    for source in ("ats", "email", "linkedin", "linkedin_slug", "resume"):
        for name in evidence.get(source, []):
            normalized = normalize_first_name_for_verification(name)
            if normalized:
                expected.setdefault(normalized, f"{name} ({source})")

    if normalized_greeting in expected:
        return True, greeting_first_name, expected[normalized_greeting]

    expected_summary = []
    for source in ("email", "resume", "linkedin", "linkedin_slug", "ats"):
        values = evidence.get(source, [])
        if values:
            expected_summary.append(f"{source}={','.join(values)}")
    return False, greeting_first_name, "; ".join(expected_summary) or "no candidate first-name evidence"


def summarize_name_evidence(evidence: dict[str, list[str]]) -> str:
    parts = []
    for source in ("email", "resume", "linkedin", "linkedin_slug", "ats"):
        values = evidence.get(source, [])
        if values:
            parts.append(f"{source}={','.join(values)}")
    return "; ".join(parts)


def extract_json_object(text: str) -> dict[str, Any]:
    source = (text or "").strip()
    try:
        parsed = json.loads(source)
        return parsed if isinstance(parsed, dict) else {}
    except ValueError:
        pass
    match = re.search(r"\{.*\}", source, flags=re.DOTALL)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def build_name_verifier_prompt(payload: dict[str, Any]) -> str:
    return (
        "You are a recruiting operations verification subagent. "
        "Decide whether it is safe to auto-send a rejection draft based only on the salutation first name. "
        "Your job is only to verify the greeting, for example whether 'Hi Abishek,' or 'Hi Lori,' is the correct "
        "first-name greeting for the candidate. Allow if the greeting first name plausibly matches the candidate "
        "name in the ATS, the candidate email/local part or display name, a clean resume name, or an enriched "
        "LinkedIn profile name. Do not require resume or LinkedIn evidence when ATS/email evidence is clear. "
        "Ignore obvious resume/OCR noise such as section headers, locations, companies, roles, dates, or words like "
        "Summary, Core, Contact, Professional, Skills, Revenue, University, Bachelor, Phone, Account, or Growth. "
        "Reject if the greeting is missing, is an email address, is clearly a last name when the candidate's first "
        "name is known, or is clearly a different person's name. "
        "Return only compact JSON with keys allow_auto_send (boolean), reason (string), "
        "matched_sources (array), conflicts (array).\n\n"
        f"Payload:\n{json.dumps(payload, ensure_ascii=True, sort_keys=True)}"
    )


def call_anthropic_name_verifier(config: Config, payload: dict[str, Any], *, model: str = "") -> tuple[bool, str]:
    if requests is None or not config.anthropic_api_key:
        return False, "Anthropic verifier unavailable"
    response = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": config.anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        json={
            "model": model or config.name_verifier_model or "claude-haiku-4-5",
            "max_tokens": 300,
            "temperature": 0,
            "messages": [{"role": "user", "content": build_name_verifier_prompt(payload)}],
        },
        timeout=45,
    )
    if not response.ok:
        return False, f"Anthropic verifier HTTP {response.status_code}"
    try:
        body = response.json()
    except ValueError:
        return False, "Anthropic verifier returned invalid JSON"
    text_chunks = [
        str(item.get("text", ""))
        for item in body.get("content", []) or []
        if isinstance(item, dict) and item.get("type") == "text"
    ]
    parsed = extract_json_object("\n".join(text_chunks))
    return bool(parsed.get("allow_auto_send")), clean_text(str(parsed.get("reason", "") or "no reason"))


def call_openai_name_verifier(config: Config, payload: dict[str, Any], *, model: str = "") -> tuple[bool, str]:
    if requests is None or not config.openai_api_key:
        return False, "OpenAI verifier unavailable"
    response = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {config.openai_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model or config.name_verifier_model or "gpt-4o-mini",
            "temperature": 0,
            "messages": [{"role": "user", "content": build_name_verifier_prompt(payload)}],
        },
        timeout=45,
    )
    if not response.ok:
        return False, f"OpenAI verifier HTTP {response.status_code}"
    try:
        body = response.json()
    except ValueError:
        return False, "OpenAI verifier returned invalid JSON"
    content = (
        ((body.get("choices") or [{}])[0].get("message") or {}).get("content", "")
        if isinstance(body.get("choices"), list)
        else ""
    )
    parsed = extract_json_object(str(content))
    return bool(parsed.get("allow_auto_send")), clean_text(str(parsed.get("reason", "") or "no reason"))


def call_rejection_name_verifier_subagent(
    config: Config,
    *,
    candidate_name: str,
    candidate_email: str,
    greeting_first_name: str,
    evidence: dict[str, list[str]],
    deterministic_allowed: bool,
    deterministic_reason: str,
) -> tuple[bool, str]:
    payload = {
        "candidate_email": candidate_email,
        "notion_candidate_name": candidate_name,
        "greeting_first_name": greeting_first_name,
        "evidence": evidence,
        "deterministic_allowed": deterministic_allowed,
        "deterministic_reason": deterministic_reason,
    }
    provider = config.name_verifier_provider or "anthropic"
    try:
        if provider == "openai":
            return call_openai_name_verifier(config, payload)
        return call_anthropic_name_verifier(config, payload)
    except Exception as exc:
        return False, f"{provider} verifier failed: {exc.__class__.__name__}"


# Generic salutation tokens that must never be treated as a real first name.
GENERIC_FIRST_NAME_TOKENS = frozenset({
    "there", "candidate", "team", "hi", "hello", "applicant", "all", "everyone",
})


def derive_consensus_first_name(
    evidence: dict[str, list[str]], *, min_sources: int = 3
) -> str:
    """Return a corrected first name only when at least `min_sources` independent
    evidence sources (email, resume, linkedin, linkedin_slug, ats) agree on the
    same normalized first name. Returns "" when there is no strong consensus, so the
    caller leaves the draft for human review. Generic salutation tokens are ignored."""
    by_norm: dict[str, dict[str, str]] = {}
    for source, names in (evidence or {}).items():
        for name in names or []:
            norm = normalize_first_name_for_verification(name)
            if not norm or norm in GENERIC_FIRST_NAME_TOKENS:
                continue
            by_norm.setdefault(norm, {})[source] = clean_text(name)
    best_norm, best_count = "", 0
    for norm, sources in by_norm.items():
        if len(sources) > best_count:
            best_norm, best_count = norm, len(sources)
    if not best_norm or best_count < min_sources:
        return ""
    # Prefer a nicely-cased representative from the most authoritative source.
    preferred = by_norm[best_norm]
    for source in ("email", "ats", "linkedin", "resume", "linkedin_slug"):
        if source in preferred and preferred[source]:
            return preferred[source]
    return next(iter(preferred.values()))


def call_rejection_name_verifier_consensus(
    config: Config,
    *,
    candidate_name: str,
    candidate_email: str,
    greeting_first_name: str,
    evidence: dict[str, list[str]],
    deterministic_allowed: bool,
    deterministic_reason: str,
) -> tuple[bool, str]:
    """Two independent agents (Claude + OpenAI) must BOTH approve the corrected
    draft. Fails closed if either provider is unavailable or errors."""
    payload = {
        "candidate_email": candidate_email,
        "notion_candidate_name": candidate_name,
        "greeting_first_name": greeting_first_name,
        "evidence": evidence,
        "deterministic_allowed": deterministic_allowed,
        "deterministic_reason": deterministic_reason,
    }
    try:
        claude_ok, claude_reason = call_anthropic_name_verifier(config, payload, model="claude-haiku-4-5")
    except Exception as exc:
        claude_ok, claude_reason = False, f"anthropic error: {exc.__class__.__name__}"
    try:
        openai_ok, openai_reason = call_openai_name_verifier(config, payload, model="gpt-4o-mini")
    except Exception as exc:
        openai_ok, openai_reason = False, f"openai error: {exc.__class__.__name__}"
    return (claude_ok and openai_ok), f"claude={claude_ok}({claude_reason}); openai={openai_ok}({openai_reason})"


def notify_rejection_name_verification_failure(
    config: Config,
    *,
    draft_id: str,
    candidate_name: str,
    candidate_email: str,
    greeting_first_name: str,
    evidence_summary: str,
    subagent_reason: str,
    notion_url: str,
) -> bool:
    return notify_rejection_draft_issue(
        config,
        draft_id=draft_id,
        issue_key="name_verification_failed",
        heading="Rejection draft name verification failed. Auto-send skipped.",
        candidate_name=candidate_name,
        candidate_email=candidate_email,
        details=[
            f"*Draft greeting:* `{greeting_first_name or '(missing)'}`",
            f"*Subagent reason:* {subagent_reason or 'No reason returned'}",
            f"*Evidence:* {evidence_summary or 'No strong email/resume/LinkedIn name evidence'}",
        ],
        notion_url=notion_url,
    )


def notify_rejection_draft_issue(
    config: Config,
    *,
    draft_id: str,
    issue_key: str,
    heading: str,
    candidate_name: str,
    candidate_email: str,
    details: list[str],
    notion_url: str,
) -> bool:
    if not slack_post_enabled(config):
        return False
    notification_key = f"{issue_key}:{draft_id or candidate_email}"
    already_notified = load_rejection_name_failure_notified_drafts(config.slack_state_file)
    if notification_key in already_notified or (issue_key == "name_verification_failed" and draft_id in already_notified):
        return False
    try:
        client = slack_post_client(config)
        channel_id = client.resolve_channel_id(config.slack_review_channel)
    except Exception:
        return False

    mention_prefix = f"<@{config.slack_mention_user_id}> " if config.slack_mention_user_id else ""
    lines = [
        f"{mention_prefix}{heading}",
        f"*Candidate:* {candidate_name}",
        f"*Email:* `{candidate_email}`",
        f"*Draft ID:* `{draft_id or '(missing)'}`",
        *details,
    ]
    if notion_url:
        lines.append(f"*ATS:* <{notion_url}|Open Notion row>")
    text = "\n".join(lines)
    try:
        client.post_message(
            channel_id,
            f"Rejection draft issue for {candidate_email}: {heading}",
            [{"type": "section", "text": {"type": "mrkdwn", "text": text}}],
        )
    except Exception:
        return False
    save_rejection_name_failure_notified_draft(config.slack_state_file, notification_key)
    return True


def thread_forward_already_sent(
    gmail_service,
    *,
    sender_email: str,
    recipient_email: str,
    thread_id: str,
) -> bool:
    marker = forward_thread_marker(thread_id)
    query = f'in:sent to:{recipient_email} "{marker}"'
    try:
        response = gmail_service.users().messages().list(userId="me", q=query, maxResults=10).execute()
    except Exception:
        return False

    for item in response.get("messages", []) or []:
        try:
            message = (
                gmail_service.users()
                .messages()
                .get(userId="me", id=item.get("id", ""), format="metadata", metadataHeaders=["From"])
                .execute()
            )
        except Exception:
            continue
        headers = header_map(message)
        from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
        if sender_matches_outbound_scope(from_email, sender_email):
            return True
    return False


def forward_candidate_thread_to_recipient(
    gmail_service,
    *,
    sender_email: str,
    recipient_email: str,
    thread_id: str,
    candidate_name: str,
    candidate_email: str,
    role: str,
    notion_url: str = "",
    resume_url: str = "",
    internal_domains: set[str],
) -> str:
    thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
    application_message = select_application_message_from_thread(thread, internal_domains=internal_domains)
    if application_message is None:
        raise ValueError(f"Could not find application message for thread {thread_id}")

    headers = header_map(application_message)
    original_subject = clean_text(headers.get("subject", "")) or "Application"
    original_from = headers.get("from", "").strip()
    original_body = extract_message_body_text(application_message).strip()
    snippet = clean_text(application_message.get("snippet", ""))
    marker = forward_thread_marker(thread_id)

    forward_subject = original_subject if original_subject.lower().startswith("fwd:") else f"Fwd: {original_subject}"
    body_lines = [
        marker,
        f"Candidate: {candidate_name}",
        f"Candidate Email: {candidate_email}",
        f"Role @ Truewind: {role}",
    ]
    if notion_url:
        body_lines.append(f"Notion ATS: {notion_url}")
    if resume_url:
        body_lines.append(f"Resume: {resume_url}")
    body_lines.extend(
        [
            "",
            f"Original message from {original_from}:",
            "",
            original_body or snippet or "(no message body captured)",
        ]
    )

    message = EmailMessage()
    message["From"] = sender_email
    message["To"] = recipient_email
    message["Subject"] = f"{forward_subject} [{marker}]"
    message.set_content("\n".join(body_lines))

    resume_reference = extract_primary_resume_part_from_thread(thread)
    if resume_reference:
        attachment_message_id, resume_part = resume_reference
        filename = (resume_part.get("filename") or "resume").strip() or "resume"
        raw = gmail_message_attachment_bytes(gmail_service, attachment_message_id, resume_part)
        mime_type = (resume_part.get("mimeType") or "").strip() or (
            mimetypes.guess_type(filename)[0] or "application/octet-stream"
        )
        maintype, subtype = mime_type.split("/", 1) if "/" in mime_type else ("application", "octet-stream")
        if raw:
            message.add_attachment(raw, maintype=maintype, subtype=subtype, filename=filename)

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
    sent = gmail_service.users().messages().send(userId="me", body={"raw": raw}).execute()
    return sent.get("id", "")


def parse_iso_datetime(value: str, timezone_name: str) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=ZoneInfo(timezone_name))
    return dt


def message_internal_datetime(message: dict[str, Any]) -> datetime | None:
    internal_raw = str(message.get("internalDate", "") or "").strip()
    if not internal_raw:
        return None
    try:
        internal_ms = int(internal_raw)
    except ValueError:
        return None
    if internal_ms <= 0:
        return None
    return datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc)


def thread_first_message_datetime(gmail_service, thread_id: str) -> datetime | None:
    try:
        thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="minimal").execute()
    except Exception:
        return None
    timestamps = [message_internal_datetime(msg) for msg in thread.get("messages", [])]
    valid = [dt for dt in timestamps if dt is not None]
    if not valid:
        return None
    return min(valid)


def now_local(timezone_name: str) -> datetime:
    return datetime.now(ZoneInfo(timezone_name))


def candidate_replied_since(
    gmail_service,
    *,
    thread_id: str,
    candidate_email: str,
    since: datetime,
) -> bool:
    thread = (
        gmail_service.users()
        .threads()
        .get(userId="me", id=thread_id, format="metadata", metadataHeaders=["From"])
        .execute()
    )
    candidate_email = normalize_email(candidate_email)
    for message in thread.get("messages", []):
        internal_ms = int(message.get("internalDate", "0") or "0")
        internal_dt = datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc)
        if internal_dt <= since.astimezone(timezone.utc):
            continue
        headers = {
            entry.get("name", "").lower(): entry.get("value", "")
            for entry in message.get("payload", {}).get("headers", [])
        }
        from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
        if from_email == candidate_email:
            return True
    return False


def candidate_replied_since_any_thread(
    gmail_service,
    *,
    thread_ids: list[str],
    candidate_email: str,
    since: datetime,
) -> bool:
    for thread_id in thread_ids:
        if candidate_replied_since(
            gmail_service,
            thread_id=thread_id,
            candidate_email=candidate_email,
            since=since,
        ):
            return True
    return False


def sender_sent_since(
    gmail_service,
    *,
    thread_id: str,
    sender_email: str,
    since: datetime,
    to_email: str = "",
) -> bool:
    thread = (
        gmail_service.users()
        .threads()
        .get(userId="me", id=thread_id, format="metadata", metadataHeaders=["From", "To"])
        .execute()
    )
    sender_email = normalize_email(sender_email)
    to_email = normalize_email(to_email)

    for message in thread.get("messages", []):
        internal_ms = int(message.get("internalDate", "0") or "0")
        internal_dt = datetime.fromtimestamp(internal_ms / 1000, tz=timezone.utc)
        if internal_dt <= since.astimezone(timezone.utc):
            continue

        label_ids = set(message.get("labelIds", []) or [])
        sent_labeled = "SENT" in label_ids
        headers = {
            entry.get("name", "").lower(): entry.get("value", "")
            for entry in message.get("payload", {}).get("headers", [])
        }
        from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
        # Prefer SENT-labeled thread messages, and fallback to explicit from-email match.
        if not sent_labeled and not sender_matches_outbound_scope(from_email, sender_email):
            continue

        if to_email:
            recipients: set[str] = set()
            for token in headers.get("to", "").split(","):
                parsed = normalize_email(parseaddr(token)[1])
                if parsed:
                    recipients.add(parsed)
            if recipients and to_email not in recipients:
                continue

        return True
    return False


def sender_sent_since_any_thread(
    gmail_service,
    *,
    thread_ids: list[str],
    sender_email: str,
    since: datetime,
    to_email: str = "",
) -> bool:
    for thread_id in thread_ids:
        if sender_sent_since(
            gmail_service,
            thread_id=thread_id,
            sender_email=sender_email,
            since=since,
            to_email=to_email,
        ):
            return True
    return False


def extract_first_name(candidate_name: str, candidate_email: str) -> str:
    name = clean_text(candidate_name)
    if name and name.lower() != "unknown":
        token = re.split(r"\s+", name)[0].strip(" ,.-")
        if token:
            return token
    local = clean_text(candidate_email).split("@", 1)[0]
    local = re.split(r"[._+\-]", local)[0].strip(" ,.-")
    return local.capitalize() if local else "there"


def render_no_response_template(template: str, first_name: str) -> str:
    body = template.replace("{{first name}}", first_name).replace("{{first_name}}", first_name)
    try:
        body = body.format(first_name=first_name)
    except Exception:
        pass
    return body


def send_reply_email(
    gmail_service,
    *,
    sender_email: str,
    to_email: str,
    thread_id: str,
    body_text: str,
    subject_override: str | None = None,
) -> str:
    subject, replied_message_id, references = extract_last_thread_message_headers(gmail_service, thread_id)
    reply_subject = subject_override or (subject if subject.lower().startswith("re:") else f"Re: {subject}")
    merged_references = references if replied_message_id in references else f"{references} {replied_message_id}".strip()
    first_name = resolve_recipient_first_name(gmail_service, thread_id, to_email)
    body_with_greeting = apply_email_greeting(body_text, first_name)

    message = EmailMessage()
    message["From"] = sender_email
    message["To"] = to_email
    message["Subject"] = reply_subject
    if replied_message_id:
        message["In-Reply-To"] = replied_message_id
    if merged_references:
        message["References"] = merged_references
    if normalize_email(to_email) != normalize_email(DEFAULT_DRAFT_BCC):
        message["Bcc"] = DEFAULT_DRAFT_BCC
    message.set_content(body_with_greeting)

    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("utf-8")
    sent = (
        gmail_service.users()
        .messages()
        .send(userId="me", body={"raw": raw, "threadId": thread_id})
        .execute()
    )
    return sent.get("id", "")


def message_implies_rejection(haystack: str) -> bool:
    text = clean_text(haystack)
    if not text:
        return False

    for pattern in REJECT_EXCLUSION_PATTERNS:
        if pattern.search(text):
            return False

    hard_hits = sum(1 for pattern in REJECT_HARD_PATTERNS if pattern.search(text))
    support_hits = sum(1 for pattern in REJECT_SUPPORT_PATTERNS if pattern.search(text))

    if hard_hits >= 1:
        return True
    if support_hits >= 2:
        return True
    return False


def thread_latest_assignment_sent_at(
    gmail_service,
    *,
    thread_id: str,
    sender_email: str,
    keywords: set[str],
) -> datetime | None:
    if not keywords:
        return None
    try:
        thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
    except Exception:
        return None

    sender_email = normalize_email(sender_email)
    lowered_keywords = {keyword.strip().lower() for keyword in keywords if keyword.strip()}
    latest: datetime | None = None

    for message in thread.get("messages", []):
        headers = header_map(message)
        from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
        if not sender_matches_outbound_scope(from_email, sender_email):
            continue

        subject = clean_text(headers.get("subject", "")).lower()
        snippet = clean_text(message.get("snippet", "")).lower()
        body = clean_text(extract_message_body_text(message)).lower()
        haystack = f"{subject}\n{snippet}\n{body}"
        if not any(keyword in haystack for keyword in lowered_keywords):
            continue

        sent_at = message_internal_datetime(message)
        if sent_at and (latest is None or sent_at > latest):
            latest = sent_at

    return latest


def thread_latest_assignment_sent_at_any_thread(
    gmail_service,
    *,
    thread_ids: list[str],
    sender_email: str,
    keywords: set[str],
) -> datetime | None:
    latest: datetime | None = None
    for thread_id in thread_ids:
        sent_at = thread_latest_assignment_sent_at(
            gmail_service,
            thread_id=thread_id,
            sender_email=sender_email,
            keywords=keywords,
        )
        if sent_at and (latest is None or sent_at > latest):
            latest = sent_at
    return latest


def thread_latest_manual_rejection_sent_at(
    gmail_service,
    *,
    thread_id: str,
    sender_email: str,
    candidate_email: str,
) -> datetime | None:
    try:
        thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
    except Exception:
        return None

    sender_email = normalize_email(sender_email)
    candidate_email = normalize_email(candidate_email)
    latest: datetime | None = None

    for message in thread.get("messages", []):
        headers = header_map(message)
        from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
        label_ids = set(message.get("labelIds", []) or [])
        sent_labeled = "SENT" in label_ids
        if not sender_matches_outbound_scope(from_email, sender_email) and not sent_labeled:
            continue

        recipients: set[str] = set()
        for header_name in ("to", "cc", "bcc"):
            for token in headers.get(header_name, "").split(","):
                parsed = normalize_email(parseaddr(token)[1])
                if parsed:
                    recipients.add(parsed)
        if recipients and candidate_email not in recipients:
            continue

        subject = clean_text(headers.get("subject", ""))
        snippet = clean_text(message.get("snippet", ""))
        body = clean_text(extract_message_body_text(message))
        haystack = f"{subject}\n{snippet}\n{body}"
        if not message_implies_rejection(haystack):
            continue

        sent_at = message_internal_datetime(message)
        if sent_at and (latest is None or sent_at > latest):
            latest = sent_at

    return latest


def thread_latest_manual_rejection_sent_at_any_thread(
    gmail_service,
    *,
    thread_ids: list[str],
    sender_email: str,
    candidate_email: str,
) -> datetime | None:
    latest: datetime | None = None
    for thread_id in thread_ids:
        sent_at = thread_latest_manual_rejection_sent_at(
            gmail_service,
            thread_id=thread_id,
            sender_email=sender_email,
            candidate_email=candidate_email,
        )
        if sent_at and (latest is None or sent_at > latest):
            latest = sent_at
    return latest


def thread_latest_sent_matching_patterns(
    gmail_service,
    *,
    thread_id: str,
    sender_email: str,
    candidate_email: str,
    patterns: list[re.Pattern[str]],
) -> datetime | None:
    if not patterns:
        return None
    try:
        thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
    except Exception:
        return None

    sender_email = normalize_email(sender_email)
    candidate_email = normalize_email(candidate_email)
    latest: datetime | None = None

    for message in thread.get("messages", []):
        headers = header_map(message)
        from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
        label_ids = set(message.get("labelIds", []) or [])
        sent_labeled = "SENT" in label_ids
        if not sender_matches_outbound_scope(from_email, sender_email) and not sent_labeled:
            continue

        recipients: set[str] = set()
        for header_name in ("to", "cc", "bcc"):
            for token in headers.get(header_name, "").split(","):
                parsed = normalize_email(parseaddr(token)[1])
                if parsed:
                    recipients.add(parsed)
        if recipients and candidate_email not in recipients:
            continue

        subject = clean_text(headers.get("subject", ""))
        snippet = clean_text(message.get("snippet", ""))
        body = clean_text(extract_message_body_text(message))
        haystack = f"{subject}\n{snippet}\n{body}"
        if not any(pattern.search(haystack) for pattern in patterns):
            continue

        sent_at = message_internal_datetime(message)
        if sent_at and (latest is None or sent_at > latest):
            latest = sent_at

    return latest


def thread_latest_sent_matching_patterns_any_thread(
    gmail_service,
    *,
    thread_ids: list[str],
    sender_email: str,
    candidate_email: str,
    patterns: list[re.Pattern[str]],
) -> datetime | None:
    latest: datetime | None = None
    for thread_id in thread_ids:
        sent_at = thread_latest_sent_matching_patterns(
            gmail_service,
            thread_id=thread_id,
            sender_email=sender_email,
            candidate_email=candidate_email,
            patterns=patterns,
        )
        if sent_at and (latest is None or sent_at > latest):
            latest = sent_at
    return latest


def latest_candidate_message_since_any_thread(
    gmail_service,
    *,
    thread_ids: list[str],
    candidate_email: str,
    since: datetime,
) -> tuple[datetime | None, str]:
    candidate_email = normalize_email(candidate_email)
    latest_dt: datetime | None = None
    latest_text = ""

    for thread_id in thread_ids:
        try:
            thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
        except Exception:
            continue
        for message in thread.get("messages", []):
            sent_at = message_internal_datetime(message)
            if not sent_at or sent_at <= since.astimezone(timezone.utc):
                continue
            headers = header_map(message)
            from_email = normalize_email(parseaddr(headers.get("from", ""))[1])
            if from_email != candidate_email:
                continue
            body = clean_text(extract_message_body_text(message))
            snippet = clean_text(message.get("snippet", ""))
            subject = clean_text(headers.get("subject", ""))
            text = "\n".join(part for part in [subject, snippet, body] if part).strip()
            if latest_dt is None or sent_at > latest_dt:
                latest_dt = sent_at
                latest_text = text

    return latest_dt, latest_text


SCHEDULING_DECLINE_RE = re.compile(
    r"(?i)\b(not interested|no longer interested|withdraw|withdrawing|decline|declining|pass|won't be able to)\b"
)
SCHEDULING_POSITIVE_RE = re.compile(
    r"(?i)\b(yes|yep|yeah|sounds good|works for me|that works|happy to chat|happy to talk|would love to chat|interested|available|free)\b"
)


def classify_scheduling_readiness_reply(reply_text: str) -> str:
    text = clean_text(reply_text)
    if not text:
        return "ambiguous"
    if SCHEDULING_DECLINE_RE.search(text):
        return "decline"
    if SCHEDULING_POSITIVE_RE.search(text):
        return "ready"
    return "ambiguous"


def classify_scheduling_confirmation_reply(reply_text: str) -> str:
    text = clean_text(reply_text)
    if not text:
        return "ambiguous"
    if SCHEDULING_DECLINE_RE.search(text):
        return "decline"
    if SCHEDULING_POSITIVE_RE.search(text):
        return "confirm"
    return "ambiguous"


def calendar_event_id_for_thread(thread_id: str) -> str:
    cleaned = re.sub(r"[^a-f0-9]", "", thread_id.lower())
    return f"r{cleaned}"[:128] if cleaned else f"r{int(datetime.now(timezone.utc).timestamp())}"


def create_calendar_invite_for_candidate(
    calendar_service,
    *,
    config: Config,
    candidate_name: str,
    candidate_email: str,
    start_at: datetime,
    thread_id: str,
) -> dict[str, Any]:
    end_at = start_at + timedelta(minutes=config.slot_minutes)
    event_id = calendar_event_id_for_thread(thread_id)
    body = {
        "id": event_id,
        "summary": f"Truewind Intro Call - {candidate_name or candidate_email}",
        "start": {"dateTime": start_at.astimezone(timezone.utc).isoformat()},
        "end": {"dateTime": end_at.astimezone(timezone.utc).isoformat()},
        "attendees": [{"email": candidate_email}],
        "conferenceData": {
            "createRequest": {
                "requestId": event_id,
                "conferenceSolutionKey": {"type": "hangoutsMeet"},
            }
        },
    }
    try:
        return (
            calendar_service.events()
            .insert(
                calendarId=config.calendar_id,
                body=body,
                conferenceDataVersion=1,
                sendUpdates="all",
            )
            .execute()
        )
    except Exception:
        return calendar_service.events().get(calendarId=config.calendar_id, eventId=event_id).execute()


def thread_has_label(gmail_service, *, thread_id: str, label_id: str) -> bool:
    if not label_id:
        return False
    try:
        thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="minimal").execute()
    except Exception:
        return False
    for message in thread.get("messages", []):
        labels = set(message.get("labelIds", []) or [])
        if label_id in labels:
            return True
    return False


def any_thread_has_label(gmail_service, *, thread_ids: list[str], label_id: str) -> bool:
    for thread_id in thread_ids:
        if thread_has_label(gmail_service, thread_id=thread_id, label_id=label_id):
            return True
    return False


def add_business_days(start: datetime, days: int, timezone_name: str) -> datetime:
    local_dt = start.astimezone(ZoneInfo(timezone_name))
    current = local_dt
    added = 0
    while added < days:
        current = current + timedelta(days=1)
        if current.weekday() < 5:
            added += 1
    return current.astimezone(timezone.utc)


def remove_labels_from_thread(gmail_service, *, thread_id: str, label_ids: list[str]) -> bool:
    remove_ids = sorted({label_id for label_id in label_ids if label_id})
    if not remove_ids:
        return False
    try:
        (
            gmail_service.users()
            .threads()
            .modify(
                userId="me",
                id=thread_id,
                body={"removeLabelIds": remove_ids},
            )
            .execute()
        )
    except Exception:
        return False
    return True


def remove_labels_from_threads(
    gmail_service,
    *,
    thread_ids: list[str],
    label_ids: list[str],
) -> tuple[int, int]:
    normalized_labels = [label_id for label_id in label_ids if label_id]
    if not normalized_labels:
        return 0, 0

    removed = 0
    failures = 0
    for thread_id in dict.fromkeys(thread_ids):
        if remove_labels_from_thread(gmail_service, thread_id=thread_id, label_ids=normalized_labels):
            removed += 1
        else:
            failures += 1
    return removed, failures


def thread_latest_message_datetime(thread: dict[str, Any]) -> datetime | None:
    messages = sorted_thread_messages(thread)
    if not messages:
        return None
    return message_internal_datetime(messages[-1])


def thread_involves_candidate_and_internal(
    thread: dict[str, Any],
    *,
    candidate_email: str,
    internal_domains: set[str],
) -> bool:
    candidate_email = normalize_email(candidate_email)
    saw_candidate = False
    saw_internal = False
    for message in thread.get("messages", []) or []:
        headers = header_map(message)
        if subject_has_hiring_prefix(headers.get("subject", "")):
            saw_internal = True

        for header_name in ("from", "to", "cc", "bcc"):
            raw_value = headers.get(header_name, "")
            if not raw_value:
                continue
            tokens = raw_value.split(",") if header_name != "from" else [raw_value]
            for token in tokens:
                address = normalize_email(parseaddr(token)[1])
                if not address:
                    continue
                if address == candidate_email:
                    saw_candidate = True
                if email_domain(address) in internal_domains:
                    saw_internal = True
        if saw_candidate and saw_internal:
            return True
    return False


def candidate_related_thread_ids(
    gmail_service,
    *,
    candidate_email: str,
    primary_thread_id: str,
    internal_domains: set[str],
    hiring_label_id: str,
    max_threads: int = 25,
) -> list[str]:
    related_ids: set[str] = set()
    if primary_thread_id:
        related_ids.add(primary_thread_id)

    candidate_email = normalize_email(candidate_email)
    if not candidate_email:
        return list(related_ids)

    query = f'"{candidate_email}"'
    try:
        matching_threads = list_threads_matching_query(gmail_service, query, max_threads=max_threads)
    except Exception as exc:
        if not is_google_transient_error(exc):
            raise
        print(
            "Gmail related-thread search failed; falling back to primary ATS thread: "
            f"{candidate_email} ({exc.__class__.__name__})"
        )
        return list(related_ids)

    for item in matching_threads:
        thread_id = str(item.get("id", "") or "").strip()
        if not thread_id or thread_id in related_ids:
            continue
        if hiring_label_id and not thread_has_label(gmail_service, thread_id=thread_id, label_id=hiring_label_id):
            continue
        try:
            thread = (
                gmail_service.users()
                .threads()
                .get(
                    userId="me",
                    id=thread_id,
                    format="metadata",
                    metadataHeaders=["From", "To", "Cc", "Bcc", "Subject"],
                )
                .execute()
            )
        except Exception:
            continue
        if thread_involves_candidate_and_internal(
            thread,
            candidate_email=candidate_email,
            internal_domains=internal_domains,
        ):
            related_ids.add(thread_id)

    return list(related_ids)


def preferred_reply_thread_id(
    gmail_service,
    *,
    thread_ids: list[str],
    fallback_thread_id: str,
) -> str:
    latest_thread_id = fallback_thread_id
    latest_dt: datetime | None = None

    for thread_id in dict.fromkeys(thread_ids):
        try:
            thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="minimal").execute()
        except Exception:
            continue
        thread_dt = thread_latest_message_datetime(thread)
        if thread_dt and (latest_dt is None or thread_dt > latest_dt):
            latest_dt = thread_dt
            latest_thread_id = thread_id

    return latest_thread_id or fallback_thread_id


def find_next_available_slot(config: Config, calendar_service, start_anchor: datetime) -> datetime | None:
    tz = ZoneInfo(config.timezone_name)
    search_start = max(start_anchor, now_local(config.timezone_name) + timedelta(hours=config.min_notice_hours))
    search_end = search_start + timedelta(days=config.lookahead_days)

    busy_response = (
        calendar_service.freebusy()
        .query(
            body={
                "timeMin": search_start.astimezone(timezone.utc).isoformat(),
                "timeMax": search_end.astimezone(timezone.utc).isoformat(),
                "items": [{"id": config.calendar_id}],
            }
        )
        .execute()
    )
    busy_items = busy_response.get("calendars", {}).get(config.calendar_id, {}).get("busy", [])
    busy_ranges: list[tuple[datetime, datetime]] = []
    for item in busy_items:
        start = parse_iso_datetime(item.get("start", ""), config.timezone_name)
        end = parse_iso_datetime(item.get("end", ""), config.timezone_name)
        if start and end:
            busy_ranges.append((start, end))

    slot_step = timedelta(minutes=config.slot_minutes)
    duration = timedelta(minutes=config.slot_minutes)
    buffer_delta = timedelta(minutes=config.buffer_minutes)

    day_cursor = search_start.astimezone(tz).date()
    end_day = search_end.astimezone(tz).date()

    while day_cursor <= end_day:
        day_start = datetime.combine(day_cursor, config.daily_start, tz)
        day_end = datetime.combine(day_cursor, config.daily_end, tz)
        if day_start.weekday() not in config.weekdays:
            day_cursor += timedelta(days=1)
            continue

        slot = max(day_start, search_start.astimezone(tz))
        while slot + duration <= day_end:
            slot_end = slot + duration
            buffered_start = slot - buffer_delta
            buffered_end = slot_end + buffer_delta
            overlaps = any(buffered_start < busy_end and buffered_end > busy_start for busy_start, busy_end in busy_ranges)
            if not overlaps:
                return slot
            slot += slot_step

        day_cursor += timedelta(days=1)

    return None


def iso(dt: datetime) -> str:
    return dt.isoformat()


def notion_page_url(page_id: str) -> str:
    if not page_id:
        return ""
    cleaned = page_id.replace("-", "")
    return f"https://www.notion.so/{cleaned}"


def slack_thread_marker(thread_id: str) -> str:
    return f"{SLACK_THREAD_MARKER_PREFIX}{thread_id}"


def forward_thread_marker(thread_id: str) -> str:
    return f"{FORWARD_THREAD_MARKER_PREFIX}{thread_id}"


def extract_thread_id_from_slack_message(message_text: str) -> str:
    match = re.search(rf"{SLACK_THREAD_MARKER_PREFIX}([A-Za-z0-9_-]+)", message_text or "")
    return match.group(1).strip() if match else ""


def slack_reaction_names(reactions: list[dict[str, Any]]) -> set[str]:
    return {
        (reaction.get("name", "") or "").strip().lower()
        for reaction in reactions
        if isinstance(reaction, dict) and int(reaction.get("count", 0) or 0) > 0
    }


def derive_decision_from_reactions(
    reactions: list[dict[str, Any]],
    proceed_reactions: set[str],
    reject_reactions: set[str],
) -> str:
    reaction_names = slack_reaction_names(reactions)
    has_proceed = bool(reaction_names.intersection(proceed_reactions))
    has_reject = bool(reaction_names.intersection(reject_reactions))
    if has_proceed and has_reject:
        return ""
    if has_proceed:
        return "proceed"
    if has_reject:
        return "reject"
    return ""


def slack_enabled(config: Config) -> bool:
    return bool(config.slack_token and config.slack_review_channel)


def slack_post_enabled(config: Config) -> bool:
    return bool((config.slack_post_token or config.slack_token) and config.slack_review_channel)


def slack_post_client(config: Config) -> SlackClient:
    return SlackClient(config.slack_post_token or config.slack_token)


def load_slack_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(payload, list):
        return {"posted_thread_ids": [str(item).strip() for item in payload if str(item).strip()]}
    if isinstance(payload, dict):
        return payload
    return {}


def save_slack_state(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def load_slack_posted_threads(path: Path) -> set[str]:
    payload = load_slack_state(path)
    raw_items = payload.get("posted_thread_ids", [])
    if isinstance(raw_items, list):
        return {str(item).strip() for item in raw_items if str(item).strip()}
    return set()


def load_slack_review_links(path: Path) -> dict[str, str]:
    payload = load_slack_state(path)
    raw_items = payload.get("posted_thread_links", {})
    if isinstance(raw_items, dict):
        return {
            str(thread_id).strip(): str(url).strip()
            for thread_id, url in raw_items.items()
            if str(thread_id).strip() and str(url).strip()
        }
    return {}


def save_slack_posted_threads(path: Path, thread_ids: set[str], thread_links: dict[str, str] | None = None) -> None:
    payload = load_slack_state(path)
    existing_links = load_slack_review_links(path)
    if thread_links:
        existing_links.update({key: value for key, value in thread_links.items() if key and value})
    payload["posted_thread_ids"] = sorted(thread_ids)
    if existing_links:
        payload["posted_thread_links"] = dict(sorted(existing_links.items()))
    save_slack_state(path, payload)


def load_weekly_active_review_slots(path: Path) -> set[str]:
    payload = load_slack_state(path)
    raw_items = payload.get("weekly_active_review_sent_slots", [])
    if isinstance(raw_items, list):
        return {str(item).strip() for item in raw_items if str(item).strip()}
    return set()


def save_weekly_active_review_slot(path: Path, slot_key: str) -> None:
    payload = load_slack_state(path)
    existing = load_weekly_active_review_slots(path)
    existing.add(slot_key)
    payload["weekly_active_review_sent_slots"] = sorted(existing)[-32:]
    save_slack_state(path, payload)


def load_rejection_name_failure_notified_drafts(path: Path) -> set[str]:
    payload = load_slack_state(path)
    raw_items = payload.get("rejection_name_failure_notified_draft_ids", [])
    if isinstance(raw_items, list):
        return {str(item).strip() for item in raw_items if str(item).strip()}
    return set()


def save_rejection_name_failure_notified_draft(path: Path, draft_id: str) -> None:
    payload = load_slack_state(path)
    existing = load_rejection_name_failure_notified_drafts(path)
    existing.add(draft_id)
    payload["rejection_name_failure_notified_draft_ids"] = sorted(existing)[-256:]
    save_slack_state(path, payload)


def load_recent_slack_posted_threads(
    config: Config,
    client: SlackClient,
    channel_id: str,
) -> tuple[set[str], dict[str, str]]:
    oldest_ts = (datetime.now(timezone.utc) - timedelta(days=config.slack_history_lookback_days)).timestamp()
    try:
        messages = client.list_channel_messages(channel_id, oldest_ts)
    except Exception:
        return set(), {}

    thread_ids: set[str] = set()
    thread_links: dict[str, str] = {}
    for message in messages:
        thread_id = extract_thread_id_from_slack_message(message.get("text", ""))
        if thread_id:
            thread_ids.add(thread_id)
            permalink = str(message.get("permalink", "") or "").strip()
            if not permalink:
                message_ts = str(message.get("ts", "") or "").strip()
                if message_ts:
                    try:
                        permalink = client.get_message_permalink(channel_id, message_ts)
                    except Exception:
                        permalink = ""
            if permalink:
                thread_links[thread_id] = permalink
    return thread_ids, thread_links


def post_candidate_reviews_to_slack(
    config: Config,
    candidates: list[dict[str, str]],
    *,
    ignore_local_state: bool = False,
) -> tuple[int, int]:
    if not candidates or not slack_post_enabled(config):
        return 0, 0

    client = slack_post_client(config)
    posted_threads = load_slack_posted_threads(config.slack_state_file)
    posted_thread_links = load_slack_review_links(config.slack_state_file)
    state_changed = False
    try:
        channel_id = client.resolve_channel_id(config.slack_review_channel)
    except Exception:
        return 0, len(candidates)
    history_posted_threads, history_thread_links = load_recent_slack_posted_threads(config, client, channel_id)
    if history_posted_threads.difference(posted_threads):
        posted_threads.update(history_posted_threads)
        state_changed = True
    if history_thread_links:
        new_links = {
            thread_id: url
            for thread_id, url in history_thread_links.items()
            if posted_thread_links.get(thread_id) != url
        }
        if new_links:
            posted_thread_links.update(new_links)
            state_changed = True
    posted = 0
    failed = 0
    mention_prefix = f"<@{config.slack_mention_user_id}> " if config.slack_mention_user_id else ""

    for candidate in candidates:
        if is_superposition_source(candidate.get("source", "")):
            continue

        thread_id = candidate.get("thread_id", "").strip()
        if not thread_id:
            failed += 1
            continue
        if (not ignore_local_state and thread_id in posted_threads) or thread_id in history_posted_threads:
            continue

        marker = slack_thread_marker(thread_id)
        fallback_text = (
            f"{mention_prefix}New candidate: {candidate['candidate_name']} ({candidate['role']}) "
            f"- react :white_check_mark: to proceed, :x: to reject, or :arrow_right: to forward to Tenn. {marker}"
        )
        resume_url = candidate.get("resume_url", "")
        notion_url = candidate.get("notion_url", "")
        linkedin_url = candidate.get("linkedin_url", "")
        linkedin_display = linkedin_url if linkedin_url else "Not found"
        blocks: list[dict[str, Any]] = [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        f"*New Applicant*  {marker}\n"
                        f"*Role at Truewind:* {candidate['role']}\n"
                        f"*Name:* {candidate['candidate_name']}\n"
                        f"*Current role:* {candidate['current_title']}\n"
                        f"*Current Company:* {candidate['company']}\n"
                        f"*Location:* {candidate['location']}\n"
                        f"*Career Stage:* {candidate['career_stage']}\n"
                        f"*LinkedIn:* {linkedin_display}\n"
                        "React with :white_check_mark: to `Proceed`, :x: to `Reject`, or :arrow_right: to forward to Tenn."
                    ),
                },
            },
        ]
        if mention_prefix:
            blocks.insert(
                0,
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": f"{mention_prefix}new applicant to review"},
                },
            )
        action_elements: list[dict[str, Any]] = []
        if resume_url:
            action_elements.append(
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Open Resume"},
                    "url": resume_url,
                }
            )
        if notion_url:
            action_elements.append(
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Open Notion"},
                    "url": notion_url,
                }
            )
        if action_elements:
            blocks.append({"type": "actions", "elements": action_elements})

        try:
            response = client.post_message(channel_id, fallback_text, blocks)
            posted += 1
            posted_threads.add(thread_id)
            message_ts = str(response.get("ts", "") or "").strip()
            if message_ts:
                try:
                    permalink = client.get_message_permalink(channel_id, message_ts)
                except Exception:
                    permalink = ""
                if permalink:
                    posted_thread_links[thread_id] = permalink
            state_changed = True
        except Exception as exc:
            print(f"Slack review post failed for thread {thread_id}: {exc}")
            failed += 1

    if state_changed:
        save_slack_posted_threads(config.slack_state_file, posted_threads, posted_thread_links)
    return posted, failed


def full_slack_marker_history(client: SlackClient, channel_id: str) -> dict[str, str]:
    """Return exact ATS marker permalinks; any Slack failure propagates to the caller."""
    marker_messages: list[tuple[str, str]] = []
    for message in client.list_channel_messages(channel_id, 1.0):
        thread_id = extract_thread_id_from_slack_message(str(message.get("text", "") or ""))
        if not thread_id:
            continue
        message_ts = str(message.get("ts", "") or "").strip()
        if not message_ts:
            raise RuntimeError(f"Slack marker {thread_id} has no message timestamp")
        marker_messages.append((thread_id, message_ts))

    def fetch_permalink(item: tuple[str, str]) -> tuple[str, str]:
        thread_id, message_ts = item
        try:
            permalink = client.get_message_permalink(channel_id, message_ts)
        except Exception as exc:
            raise RuntimeError(
                f"Slack permalink lookup failed for ATS thread {thread_id} at message {message_ts}: {exc}"
            ) from exc
        if not permalink:
            raise RuntimeError(f"Slack marker {thread_id} has no permalink")
        return thread_id, permalink

    with ThreadPoolExecutor(max_workers=min(8, max(1, len(marker_messages)))) as pool:
        return dict(pool.map(fetch_permalink, marker_messages))


def ensure_slack_review_url_schema(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
    *,
    create: bool = True,
) -> dict[str, Any]:
    properties = database_schema.get("properties", {})
    existing = properties.get(prop_map.slack_review_url)
    if existing is None:
        if not create:
            raise RuntimeError(
                f"Notion property '{prop_map.slack_review_url}' is missing; run --apply to create it"
            )
        return notion.update_database({prop_map.slack_review_url: {"url": {}}})
    if existing.get("type") != "url":
        raise RuntimeError(
            f"Notion property '{prop_map.slack_review_url}' must be type URL, got {existing.get('type', 'unknown')}"
        )
    return database_schema


def reconcile_slack_reviews(
    config: Config,
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
    *,
    apply: bool,
) -> dict[str, Any]:
    if not SLACK_RECONCILIATION_MUTEX.acquire(blocking=False):
        raise RuntimeError("Slack review reconciliation is already running in this process")
    try:
        if not slack_post_enabled(config):
            raise RuntimeError("Slack review reconciliation requires a configured Slack post token and channel")
        database_schema = ensure_slack_review_url_schema(notion, database_schema, prop_map, create=apply)
        prop_map = resolve_property_map(prop_map, database_schema)
        candidates = collect_review_candidates_for_slack(notion, database_schema, prop_map)
        client = slack_post_client(config)
        channel_id = client.resolve_channel_id(config.slack_review_channel)
        history = full_slack_marker_history(client, channel_id)
        result: dict[str, Any] = {"eligible": len(candidates), "recovered": [], "missing": [], "posted": []}
        url_schema = database_schema["properties"][prop_map.slack_review_url]
        for candidate in candidates:
            thread_id = candidate["thread_id"]
            permalink = history.get(thread_id, "")
            if permalink:
                result["recovered"].append({"page_id": candidate["page_id"], "thread_id": thread_id, "url": permalink})
            else:
                result["missing"].append({"page_id": candidate["page_id"], "thread_id": thread_id, "candidate_name": candidate["candidate_name"]})
                if apply:
                    # Recheck immediately before the only posting operation.
                    permalink = full_slack_marker_history(client, channel_id).get(thread_id, "")
                    if not permalink:
                        posted, failed = post_candidate_reviews_to_slack(
                            config, [candidate], ignore_local_state=True
                        )
                        if posted != 1 or failed:
                            raise RuntimeError(f"Failed to post Slack review for ATS thread {thread_id}")
                        permalink = full_slack_marker_history(client, channel_id).get(thread_id, "")
                    if not permalink:
                        raise RuntimeError(f"Posted Slack review for {thread_id} but could not recover its permalink")
                    result["posted"].append({"page_id": candidate["page_id"], "thread_id": thread_id, "url": permalink})
            if apply and permalink:
                built = build_notion_value(url_schema, permalink)
                if built is None:
                    raise RuntimeError("Could not build Slack Review URL Notion value")
                notion.update_page(candidate["page_id"], {prop_map.slack_review_url: built})
        return result
    finally:
        SLACK_RECONCILIATION_MUTEX.release()


def select_ingest_review_candidates(created_candidates: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        candidate
        for candidate in created_candidates
        if not is_superposition_source(candidate.get("source", ""))
    ]


def collect_review_candidates_for_slack(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
) -> list[dict[str, str]]:
    properties_schema = database_schema.get("properties", {})
    title_prop_name = resolve_title_property_name(properties_schema, prop_map.candidate_name)
    candidates: list[dict[str, str]] = []
    for page in notion.query_pages({"page_size": 100}):
        props = page.get("properties", {})
        status = status_key(notion_prop_value(props.get(prop_map.status, {})))
        if status != "awaiting decision":
            continue
        decision = notion_prop_value(props.get(prop_map.decision, {})).strip()
        if decision:
            continue
        source = notion_prop_value(props.get(prop_map.source, {})).strip()
        if clean_text(source).lower() != SOURCE_INBOUND.lower():
            continue

        slack_review_url = notion_prop_value(props.get(prop_map.slack_review_url, {})).strip()
        if slack_review_url:
            continue

        thread_id = notion_prop_value(props.get(prop_map.gmail_thread_id, {})).strip()
        if not thread_id:
            continue

        candidates.append(
            {
                "candidate_name": notion_prop_value(props.get(title_prop_name, {})).strip() or "Unknown",
                "source": source,
                "role": notion_prop_value(props.get(prop_map.role, {})).strip() or "Unknown",
                "current_title": notion_prop_value(props.get(prop_map.current_title, {})).strip() or "Unknown",
                "company": notion_prop_value(props.get(prop_map.company, {})).strip() or "Unknown",
                "career_stage": notion_prop_value(props.get(prop_map.career_stage, {})).strip() or "Mid",
                "location": notion_prop_value(props.get(prop_map.location, {})).strip() or "Unknown",
                "linkedin_url": notion_prop_value(props.get(prop_map.linkedin_url, {})).strip(),
                "resume_url": notion_prop_value(props.get(prop_map.resume_url, {})).strip(),
                "thread_id": thread_id,
                "notion_url": notion_page_url(page.get("id", "")),
                "date_first_entered": notion_prop_value(props.get(prop_map.date_first_entered, {})).strip(),
                "page_id": str(page.get("id", "") or "").strip(),
            }
        )

    candidates.sort(key=lambda item: item.get("date_first_entered", ""))
    return candidates


def collect_active_candidates_for_weekly_slack(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
) -> list[dict[str, str]]:
    properties_schema = database_schema.get("properties", {})
    title_prop_name = resolve_title_property_name(properties_schema, prop_map.candidate_name)
    candidates: list[dict[str, str]] = []
    for page in notion.query_pages({"page_size": 100}):
        props = page.get("properties", {})
        source = notion_prop_value(props.get(prop_map.source, {})).strip()
        if clean_text(source).lower() != SOURCE_INBOUND.lower():
            continue
        status = canonical_status(notion_prop_value(props.get(prop_map.status, {})))
        decision = notion_prop_value(props.get(prop_map.decision, {})).strip().lower()
        if decision == "reject":
            continue
        if status_is_terminal(status):
            continue
        if should_exclude_from_active_digest(status):
            continue
        candidates.append(
            {
                "candidate_name": notion_prop_value(props.get(title_prop_name, {})).strip() or "Unknown",
                "role": notion_prop_value(props.get(prop_map.role, {})).strip() or "Unknown",
                "source": source,
                "status": status,
                "notion_url": notion_page_url(page.get("id", "")),
                "thread_id": notion_prop_value(props.get(prop_map.gmail_thread_id, {})).strip(),
                "date_first_entered": notion_prop_value(props.get(prop_map.date_first_entered, {})).strip(),
            }
        )

    candidates.sort(
        key=lambda item: (
            active_digest_status_rank(item.get("status", "")),
            item.get("date_first_entered", ""),
            item.get("candidate_name", ""),
        )
    )
    return candidates


def active_digest_status_rank(status: str) -> tuple[int, str]:
    key = status_key(status)
    if key in ATS_DIGEST_STATUS_PRIORITY:
        return (ATS_DIGEST_STATUS_PRIORITY[key], key)
    return (len(ATS_DIGEST_STATUS_PRIORITY), key)


def active_digest_status_summary(counts: Counter[str]) -> str:
    ordered = sorted(counts.items(), key=lambda item: (*active_digest_status_rank(item[0]), item[0]))
    return ", ".join(f"{status}: {count}" for status, count in ordered)


def active_digest_candidate_line(candidate: dict[str, str]) -> str:
    candidate_name = candidate.get("candidate_name", "Unknown")
    role = candidate.get("role", "Unknown")
    status = candidate.get("status", STATUS_AWAITING_DECISION)
    notion_url = candidate.get("notion_url", "")
    slack_review_url = candidate.get("slack_review_url", "")
    if slack_review_url:
        candidate_display = f"<{slack_review_url}|{candidate_name}>"
    elif notion_url:
        candidate_display = f"<{notion_url}|{candidate_name}>"
    else:
        candidate_display = candidate_name

    parts = [f"* {candidate_display}", status, role]
    if slack_review_url and notion_url:
        parts.append(f"<{notion_url}|ATS>")
    elif status_key(status) == status_key(STATUS_AWAITING_DECISION):
        parts.append("review thread missing")
    return " | ".join(parts)


def build_active_candidates_digest_blocks(
    *,
    heading: str,
    mention_prefix: str,
    candidates: list[dict[str, str]],
    slot_key: str,
) -> tuple[list[dict[str, Any]], str]:
    counts = Counter(candidate.get("status", STATUS_AWAITING_DECISION) for candidate in candidates)
    summary = active_digest_status_summary(counts)
    actionable = [
        candidate
        for candidate in candidates
        if status_key(candidate.get("status", "")) in ATS_DIGEST_ACTION_STATUS_KEYS
    ]
    actionable.sort(
        key=lambda item: (
            active_digest_status_rank(item.get("status", "")),
            item.get("date_first_entered", ""),
            item.get("candidate_name", ""),
        )
    )
    displayed = actionable

    headline = f"{mention_prefix}{heading}: {len(actionable)} need action, {len(candidates)} active total."
    blocks: list[dict[str, Any]] = [
        {"type": "section", "text": {"type": "mrkdwn", "text": headline}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*Status summary:* {summary}"}},
    ]

    if displayed:
        lines = ["*Action queue:*", *(active_digest_candidate_line(candidate) for candidate in displayed)]
    else:
        lines = ["*Action queue:*", "_No Needs Attention or Awaiting Decision candidates right now._"]

    blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)}})
    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": f"{ATS_FOLLOW_UP_SLOT_MARKER_PREFIX}{slot_key}"}],
        }
    )

    fallback_text = f"{headline} {summary} {ATS_FOLLOW_UP_SLOT_MARKER_PREFIX}{slot_key}"
    return blocks, fallback_text


def attach_slack_review_links(
    candidates: list[dict[str, str]],
    thread_links: dict[str, str],
) -> list[dict[str, str]]:
    enriched: list[dict[str, str]] = []
    for candidate in candidates:
        item = candidate.copy()
        thread_id = item.get("thread_id", "").strip()
        if thread_id and thread_links.get(thread_id):
            item["slack_review_url"] = thread_links[thread_id]
        enriched.append(item)
    return enriched


def weekly_active_review_slot_key(dt: datetime) -> str:
    local_dt = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    weekday_name = ATS_FOLLOW_UP_WEEKDAYS.get(local_dt.weekday(), "unknown").lower()
    return f"{local_dt.date().isoformat()}-{weekday_name}-{ATS_FOLLOW_UP_HOUR:02d}00"


def should_post_scheduled_weekly_active_review(dt: datetime) -> bool:
    return dt.weekday() in ATS_FOLLOW_UP_WEEKDAYS and dt.hour == ATS_FOLLOW_UP_HOUR


def slack_history_has_weekly_active_review_slot(
    client: SlackClient,
    channel_id: str,
    slot_key: str,
    *,
    timezone_name: str,
) -> bool:
    oldest_ts = (now_local(timezone_name) - timedelta(days=8)).timestamp()
    marker = f"{ATS_FOLLOW_UP_SLOT_MARKER_PREFIX}{slot_key}"
    try:
        messages = client.list_channel_messages(channel_id, oldest_ts)
    except Exception:
        return False
    for message in messages:
        if marker in str(message.get("text", "") or ""):
            return True
        for block in message.get("blocks", []) or []:
            text = (block.get("text") or {}).get("text", "") if isinstance(block, dict) else ""
            if marker in text:
                return True
    return False


def post_weekly_active_candidates_digest(
    config: Config,
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
    *,
    force: bool = False,
    record_slot: bool = True,
    heading: str = "Daily ATS follow-up",
) -> tuple[int, int]:
    if not slack_post_enabled(config):
        return 0, 0

    candidates = collect_active_candidates_for_weekly_slack(notion, database_schema, prop_map)
    if not candidates:
        return 0, 0

    now_dt = now_local(config.timezone_name)
    slot_key = weekly_active_review_slot_key(now_dt)
    if not force and not should_post_scheduled_weekly_active_review(now_dt):
        return 0, len(candidates)
    if not force and slot_key in load_weekly_active_review_slots(config.slack_state_file):
        return 0, len(candidates)

    client = slack_post_client(config)
    try:
        channel_id = client.resolve_channel_id(config.slack_review_channel)
    except Exception as exc:
        print(f"Daily ATS follow-up Slack post failed: {exc}")
        return 0, len(candidates)
    if not force and slack_history_has_weekly_active_review_slot(
        client,
        channel_id,
        slot_key,
        timezone_name=config.timezone_name,
    ):
        save_weekly_active_review_slot(config.slack_state_file, slot_key)
        return 0, len(candidates)

    mention_prefix = f"<@{config.slack_mention_user_id}> " if config.slack_mention_user_id else ""

    review_links = load_slack_review_links(config.slack_state_file)
    _recent_threads, recent_review_links = load_recent_slack_posted_threads(config, client, channel_id)
    if recent_review_links:
        updated_review_links = {
            thread_id: url
            for thread_id, url in recent_review_links.items()
            if review_links.get(thread_id) != url
        }
        if updated_review_links:
            review_links.update(updated_review_links)
            posted_threads = load_slack_posted_threads(config.slack_state_file)
            posted_threads.update(recent_review_links.keys())
            save_slack_posted_threads(config.slack_state_file, posted_threads, review_links)

    candidates_with_links = attach_slack_review_links(candidates, review_links)
    blocks, fallback_text = build_active_candidates_digest_blocks(
        heading=heading,
        mention_prefix=mention_prefix,
        candidates=candidates_with_links,
        slot_key=slot_key,
    )
    try:
        client.post_message(channel_id, fallback_text, blocks)
    except Exception as exc:
        print(f"Daily ATS follow-up Slack post failed: {exc}")
        return 0, len(candidates)

    if record_slot:
        save_weekly_active_review_slot(config.slack_state_file, slot_key)
    return 1, len(candidates)


def post_scheduled_ats_follow_up_if_enabled(
    config: Config,
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
) -> tuple[int, int]:
    if not config.ats_follow_up_enabled:
        return 0, 0
    return post_weekly_active_candidates_digest(
        config,
        notion,
        database_schema,
        prop_map,
    )


def sync_slack_decisions(
    config: Config,
    notion: NotionClient,
    database_schema: dict[str, Any],
) -> tuple[int, int, int, int, int, int, int]:
    if not slack_enabled(config):
        return 0, 0, 0, 0, 0, 0, 0

    properties = database_schema.get("properties", {})
    prop = resolve_property_map(config.property_map, database_schema)
    title_prop_name = resolve_title_property_name(properties, prop.candidate_name)
    required_props = [prop.decision, prop.decision_time, prop.gmail_thread_id]
    for required in required_props:
        if required not in properties:
            raise KeyError(f"Notion database missing property '{required}' required for Slack decision sync.")

    client = SlackClient(config.slack_token)
    channel_id = client.resolve_channel_id(config.slack_review_channel)
    oldest_ts = (datetime.now(timezone.utc) - timedelta(days=config.slack_history_lookback_days)).timestamp()
    messages = client.list_channel_messages(channel_id, oldest_ts)

    decisions_by_thread: dict[str, tuple[str, float]] = {}
    forward_threads: set[str] = set()
    for message in messages:
        thread_id = extract_thread_id_from_slack_message(message.get("text", ""))
        if not thread_id:
            continue
        reaction_names = slack_reaction_names(message.get("reactions", []))
        if reaction_names.intersection(config.slack_forward_reactions):
            forward_threads.add(thread_id)
        decision = derive_decision_from_reactions(
            message.get("reactions", []),
            config.slack_proceed_reactions,
            config.slack_reject_reactions,
        )
        if not decision:
            continue
        try:
            ts = float(message.get("ts", "0") or "0")
        except ValueError:
            ts = 0.0
        current = decisions_by_thread.get(thread_id)
        if not current or ts > current[1]:
            decisions_by_thread[thread_id] = (decision, ts)

    pages = notion.query_pages({"page_size": 100})
    page_by_thread: dict[str, dict[str, Any]] = {}
    for page in pages:
        page_props = page.get("properties", {})
        thread_id = notion_prop_value(page_props.get(prop.gmail_thread_id, {})).strip()
        if thread_id:
            page_by_thread[thread_id] = page

    updated = 0
    skipped_missing = 0
    skipped_locked = 0
    skipped_unchanged = 0
    forwards_sent = 0
    forwards_skipped_missing = 0
    forwards_skipped_existing = 0
    gmail_service = None
    now_iso = iso(datetime.now(timezone.utc))

    for thread_id, (decision, _ts) in decisions_by_thread.items():
        page = page_by_thread.get(thread_id)
        if not page:
            skipped_missing += 1
            continue

        page_props = page.get("properties", {})
        existing_status_raw = notion_prop_value(page_props.get(prop.status, {})).strip()
        existing_status = status_key(existing_status_raw)
        if status_is_terminal(existing_status_raw):
            skipped_locked += 1
            continue
        existing_decision = notion_prop_value(page_props.get(prop.decision, {})).strip().lower()
        if existing_decision == decision:
            skipped_unchanged += 1
            continue
        if (
            existing_decision in {"proceed", "reject"}
            and not config.slack_allow_decision_override
        ):
            skipped_locked += 1
            continue

        update_payload: dict[str, Any] = {}
        update_payload[prop.decision] = build_notion_value(properties[prop.decision], decision.title())
        update_payload[prop.decision_time] = build_notion_value(properties[prop.decision_time], now_iso)

        # Reset stale workflow fields when decision changes.
        if decision == "proceed":
            if prop.reject_send_at in properties:
                update_payload[prop.reject_send_at] = build_notion_value(properties[prop.reject_send_at], "")
            if prop.reject_draft_id in properties:
                update_payload[prop.reject_draft_id] = build_notion_value(properties[prop.reject_draft_id], "")
        if decision == "reject":
            if prop.proceed_draft_id in properties:
                update_payload[prop.proceed_draft_id] = build_notion_value(properties[prop.proceed_draft_id], "")
            if prop.scheduling_draft_id in properties:
                update_payload[prop.scheduling_draft_id] = build_notion_value(
                    properties[prop.scheduling_draft_id], ""
                )
            if prop.proposed_slot in properties:
                update_payload[prop.proposed_slot] = build_notion_value(properties[prop.proposed_slot], "")

        notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
        updated += 1

    if forward_threads and config.forward_to_email:
        gmail_service = ensure_google_service(
            api_name="gmail",
            api_version="v1",
            scopes=GMAIL_SCOPES,
            credentials_env="GOOGLE_GMAIL_CREDENTIALS_FILE",
            credentials_default="secrets/google-gmail-credentials.json",
            token_env="GOOGLE_GMAIL_TOKEN_FILE",
            token_default="secrets/google-gmail-token.json",
            help_text="Set GOOGLE_GMAIL_CREDENTIALS_FILE or place Gmail OAuth credentials in secrets/.",
        )
        internal_domains = {email_domain(config.from_email)}
        if config.hiring_alias:
            internal_domains.add(email_domain(config.hiring_alias))
        internal_domains.discard("")

        for thread_id in sorted(forward_threads):
            page = page_by_thread.get(thread_id)
            if not page:
                forwards_skipped_missing += 1
                continue

            page_props = page.get("properties", {})
            existing_status = notion_prop_value(page_props.get(prop.status, {})).strip()
            if status_is_terminal(existing_status):
                continue

            forward_sent = thread_forward_already_sent(
                gmail_service,
                sender_email=config.from_email,
                recipient_email=config.forward_to_email,
                thread_id=thread_id,
            )
            if forward_sent:
                forwards_skipped_existing += 1
            else:
                candidate_name = notion_prop_value(page_props.get(title_prop_name, {})).strip() or "Candidate"
                candidate_email = notion_prop_value(page_props.get(prop.email, {})).strip()
                role_values = notion_prop_values(page_props.get(prop.role, {}))
                role = ", ".join(role_values) if role_values else notion_prop_value(page_props.get(prop.role, {})).strip()
                notion_url = notion_page_url(page.get("id", ""))
                resume_url = notion_prop_value(page_props.get(prop.resume_url, {})).strip()

                forward_candidate_thread_to_recipient(
                    gmail_service,
                    sender_email=config.from_email,
                    recipient_email=config.forward_to_email,
                    thread_id=thread_id,
                    candidate_name=candidate_name,
                    candidate_email=candidate_email,
                    role=role or "Unknown",
                    notion_url=notion_url,
                    resume_url=resume_url,
                    internal_domains=internal_domains,
                )
                forwards_sent += 1

            if prop.status in properties and status_key(existing_status) != "n/a":
                notion.update_page(
                    page["id"],
                    {prop.status: build_notion_value(properties[prop.status], STATUS_NA)},
                )

    return (
        updated,
        skipped_missing,
        skipped_locked,
        skipped_unchanged,
        forwards_sent,
        forwards_skipped_missing,
        forwards_skipped_existing,
    )


def require_notion_property(
    database_schema: dict[str, Any],
    prop_name: str,
) -> dict[str, Any]:
    properties = database_schema.get("properties", {})
    if prop_name not in properties:
        available = ", ".join(sorted(properties))
        raise KeyError(f"Notion database missing property '{prop_name}'. Available: {available}")
    return properties[prop_name]


ROLE_OPTIONS = ("BDR", "Growth Generalist", "AE", "Other")
SOURCE_OPTIONS = ("Inbound", "Superposition")
SOURCE_INBOUND = "Inbound"
SOURCE_SUPERPOSITION = "Superposition"


def is_superposition_source(source: str) -> bool:
    return clean_text(source).lower() == SOURCE_SUPERPOSITION.lower()


CUSTOM_GPT_FIRST_ROUND_ROLES = {"BDR", "AE"}
STATUS_AWAITING_DECISION = "Awaiting Decision"
STATUS_WAITING_ON_CUSTOM_GPT = "Waiting on CustomGPT"
STATUS_ROUND_1_SCHEDULING = "Round 1 Scheduling"
STATUS_SCHEDULING_SENT = "Scheduling Sent"
STATUS_INTERVIEW_IN_PROCESS = "Interview in Process"
STATUS_NEEDS_ATTENTION = "Needs Attention"
STATUS_NO_RESPONSE = "No response"
STATUS_REJECTED = "Rejected"
STATUS_PASSED = "Passed"
STATUS_ACCEPTED = "Accepted"
STATUS_OFFERED = "Offered"
STATUS_NA = "N/A"
STATUS_OPTIONS = (
    STATUS_AWAITING_DECISION,
    STATUS_WAITING_ON_CUSTOM_GPT,
    STATUS_ROUND_1_SCHEDULING,
    STATUS_SCHEDULING_SENT,
    STATUS_INTERVIEW_IN_PROCESS,
    STATUS_NEEDS_ATTENTION,
    STATUS_NO_RESPONSE,
    STATUS_REJECTED,
    STATUS_PASSED,
    STATUS_ACCEPTED,
    STATUS_OFFERED,
    STATUS_NA,
)
TERMINAL_STATUSES = {"rejected", "passed", "accepted", "n/a", "offered", "no response"}
ATS_DIGEST_EXCLUDED_STATUSES = set()
STATUS_ALIASES = {
    "awaiting decision": STATUS_AWAITING_DECISION,
    "proceed selected": STATUS_AWAITING_DECISION,
    "reject selected": STATUS_REJECTED,
    "proceed drafted": STATUS_ROUND_1_SCHEDULING,
    "reject drafted": STATUS_REJECTED,
    "reject pending": STATUS_REJECTED,
    "in customgpt process": STATUS_WAITING_ON_CUSTOM_GPT,
    "customgpt processing": STATUS_WAITING_ON_CUSTOM_GPT,
    "custom gpt processing": STATUS_WAITING_ON_CUSTOM_GPT,
    "scheduling": STATUS_ROUND_1_SCHEDULING,
    "round 1 scheduling": STATUS_ROUND_1_SCHEDULING,
    "scheduling sent": STATUS_SCHEDULING_SENT,
    "interview scheduled": STATUS_SCHEDULING_SENT,
    "in process": STATUS_INTERVIEW_IN_PROCESS,
    "interview in process": STATUS_INTERVIEW_IN_PROCESS,
    "needs attention": STATUS_NEEDS_ATTENTION,
    "no response": STATUS_NO_RESPONSE,
    "rejected": STATUS_REJECTED,
    "passed": STATUS_PASSED,
    "accepted": STATUS_ACCEPTED,
    "offered": STATUS_OFFERED,
    "n/a": STATUS_NA,
}
ATS_FOLLOW_UP_WEEKDAYS = {
    0: "Monday",
    1: "Tuesday",
    2: "Wednesday",
    3: "Thursday",
    4: "Friday",
    5: "Saturday",
    6: "Sunday",
}
ATS_FOLLOW_UP_HOUR = 17
ATS_FOLLOW_UP_SLOT_MARKER_PREFIX = "ATS_ACTIVE_REVIEW_SLOT:"
ATS_DIGEST_STATUS_PRIORITY = {
    "needs attention": 0,
    "awaiting decision": 1,
    "round 1 scheduling": 2,
    "scheduling sent": 3,
    "waiting on customgpt": 4,
    "interview in process": 5,
    "no response": 6,
}
ATS_DIGEST_ACTION_STATUS_KEYS = {
    "needs attention",
    "awaiting decision",
}


def notion_prop_values(prop: dict[str, Any]) -> list[str]:
    prop_type = prop.get("type")
    if prop_type == "multi_select":
        return [
            (item.get("name") or "").strip()
            for item in prop.get("multi_select", []) or []
            if (item.get("name") or "").strip()
        ]
    value = notion_prop_value(prop)
    return [value] if value else []


def status_is_terminal(status: str) -> bool:
    return status_key(status) in TERMINAL_STATUSES


def should_skip_terminal_status_before_decision_processing(
    *, status: str, decision: str, reject_draft_id: str
) -> bool:
    if not status_is_terminal(status):
        return False
    if should_process_reject_draft(status=status, decision=decision, reject_draft_id=reject_draft_id):
        return False
    return True


def should_process_reject_draft(*, status: str, decision: str, reject_draft_id: str) -> bool:
    if clean_text(decision).lower() != "reject" or not reject_draft_id.strip():
        return False
    return status_key(status) in {"rejected", "needs attention"}


def should_exclude_from_active_digest(status: str) -> bool:
    return status_key(status) in ATS_DIGEST_EXCLUDED_STATUSES


def canonical_status(status: str, default: str = STATUS_AWAITING_DECISION) -> str:
    cleaned = clean_text(status)
    if not cleaned:
        return default
    return STATUS_ALIASES.get(cleaned.lower(), cleaned)


def status_key(status: str) -> str:
    return canonical_status(status).lower()


def page_role_values(page_props: dict[str, Any], prop_map: NotionPropertyMap) -> set[str]:
    return set(notion_prop_values(page_props.get(prop_map.role, {})))


def uses_custom_gpt_first_round(page_props: dict[str, Any], prop_map: NotionPropertyMap) -> bool:
    return bool(CUSTOM_GPT_FIRST_ROUND_ROLES.intersection(page_role_values(page_props, prop_map)))


def custom_gpt_no_response_due(assignment_sent_at: datetime, now: datetime, wait_hours: int) -> bool:
    wait_delta = timedelta(hours=max(int(wait_hours), 0))
    return now.astimezone(timezone.utc) >= assignment_sent_at.astimezone(timezone.utc) + wait_delta


def business_day_no_response_due(
    sent_at: datetime | None,
    reply_at: datetime | None,
    now: datetime,
    wait_business_days: int,
    timezone_name: str,
) -> bool:
    if not sent_at or reply_at:
        return False
    due_at = add_business_days(sent_at, wait_business_days, timezone_name)
    return now.astimezone(timezone.utc) >= due_at.astimezone(timezone.utc)


def ensure_role_property_schema(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
) -> dict[str, Any]:
    properties_schema = database_schema.get("properties", {})
    role_name = prop_map.role
    role_schema = properties_schema.get(role_name)
    if not role_schema:
        return database_schema

    role_type = role_schema.get("type")
    option_payload = [{"name": name} for name in ROLE_OPTIONS]
    if role_type == "multi_select":
        existing = {
            (item.get("name") or "").strip()
            for item in (role_schema.get("multi_select", {}) or {}).get("options", []) or []
            if (item.get("name") or "").strip()
        }
        if set(ROLE_OPTIONS).issubset(existing):
            return database_schema
        return notion.update_database({role_name: {"multi_select": {"options": option_payload}}})

    if role_type in {"select", "rich_text"}:
        return notion.update_database({role_name: {"multi_select": {"options": option_payload}}})

    return database_schema


def ensure_status_property_schema(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
) -> dict[str, Any]:
    properties_schema = database_schema.get("properties", {})
    status_name = prop_map.status
    status_schema = properties_schema.get(status_name)
    if not status_schema or status_schema.get("type") != "select":
        return database_schema

    existing_by_name = {
        (item.get("name") or "").strip(): item.get("color", "default") or "default"
        for item in (status_schema.get("select", {}) or {}).get("options", []) or []
        if (item.get("name") or "").strip()
    }
    desired_options = [
        {
            "name": name,
            "color": existing_by_name.get(name, "default"),
        }
        for name in STATUS_OPTIONS
    ]
    existing_ordered = [
        {"name": name, "color": color}
        for name, color in existing_by_name.items()
    ]
    if existing_ordered == desired_options:
        return database_schema

    return notion.update_database({status_name: {"select": {"options": desired_options}}})


def ensure_source_property_schema(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
) -> dict[str, Any]:
    properties_schema = database_schema.get("properties", {})
    source_name = prop_map.source
    source_schema = properties_schema.get(source_name)
    option_payload = [{"name": name} for name in SOURCE_OPTIONS]
    if not source_schema:
        return notion.update_database({source_name: {"select": {"options": option_payload}}})

    source_type = source_schema.get("type")
    if source_type == "select":
        existing_options = [
            {
                "name": (item.get("name") or "").strip(),
                "color": item.get("color", "default") or "default",
            }
            for item in (source_schema.get("select", {}) or {}).get("options", []) or []
            if (item.get("name") or "").strip()
        ]
        existing_names = {item["name"] for item in existing_options}
        missing = [name for name in SOURCE_OPTIONS if name not in existing_names]
        if not missing:
            return database_schema
        updated_options = existing_options + [{"name": name, "color": "default"} for name in missing]
        return notion.update_database({source_name: {"select": {"options": updated_options}}})

    if source_type == "rich_text":
        return notion.update_database({source_name: {"select": {"options": option_payload}}})

    return database_schema


def resolve_title_property_name(properties_schema: dict[str, Any], preferred: str) -> str:
    if preferred in properties_schema and properties_schema[preferred].get("type") == "title":
        return preferred
    for name, schema in properties_schema.items():
        if schema.get("type") == "title":
            return name
    raise KeyError("Notion database must contain a title property.")


def resolve_property_name(
    properties_schema: dict[str, Any],
    preferred: str,
    aliases: list[str],
) -> str:
    if preferred in properties_schema:
        return preferred
    for alias in aliases:
        if alias in properties_schema:
            return alias
    return preferred


def resolve_property_map(prop_map: NotionPropertyMap, database_schema: dict[str, Any]) -> NotionPropertyMap:
    properties_schema = database_schema.get("properties", {})
    return replace(
        prop_map,
        candidate_name=resolve_property_name(
            properties_schema,
            prop_map.candidate_name,
            ["Candidate Name", "Name"],
        ),
        source=resolve_property_name(
            properties_schema,
            prop_map.source,
            ["Source"],
        ),
        role=resolve_property_name(
            properties_schema,
            prop_map.role,
            ["Role at Truewind", "Role @ Truewind", "Role"],
        ),
        current_title=resolve_property_name(
            properties_schema,
            prop_map.current_title,
            ["Current Role", "Current Title", "Title"],
        ),
        company=resolve_property_name(
            properties_schema,
            prop_map.company,
            ["Current Company", "Company"],
        ),
    )


def thread_filter(prop_name: str, prop_schema: dict[str, Any], thread_id: str) -> dict[str, Any] | None:
    prop_type = prop_schema.get("type")
    if prop_type == "rich_text":
        return {"property": prop_name, "rich_text": {"equals": thread_id}}
    if prop_type == "title":
        return {"property": prop_name, "title": {"equals": thread_id}}
    if prop_type == "url":
        return {"property": prop_name, "url": {"equals": thread_id}}
    return None


def email_filter(prop_name: str, prop_schema: dict[str, Any], candidate_email: str) -> dict[str, Any] | None:
    prop_type = prop_schema.get("type")
    if prop_type == "email":
        return {"property": prop_name, "email": {"equals": candidate_email}}
    if prop_type == "rich_text":
        return {"property": prop_name, "rich_text": {"equals": candidate_email}}
    if prop_type == "title":
        return {"property": prop_name, "title": {"equals": candidate_email}}
    return None


def find_existing_candidate_page(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
    gmail_thread_id: str,
    candidate_email: str = "",
) -> dict[str, Any] | None:
    thread_schema = require_notion_property(database_schema, prop_map.gmail_thread_id)
    filter_payload = thread_filter(prop_map.gmail_thread_id, thread_schema, gmail_thread_id)
    if filter_payload:
        matches = notion.query_pages({"filter": filter_payload, "page_size": 1})
        if matches:
            return matches[0]

    normalized_email = normalize_email(candidate_email)
    if normalized_email:
        email_schema = require_notion_property(database_schema, prop_map.email)
        email_payload = email_filter(prop_map.email, email_schema, normalized_email)
        if email_payload:
            matches = notion.query_pages({"filter": email_payload, "page_size": 1})
            if matches:
                return matches[0]

    for existing in notion.query_pages({"page_size": 100}):
        props = existing.get("properties", {})
        if notion_prop_value(props.get(prop_map.gmail_thread_id, {})) == gmail_thread_id:
            return existing
        if normalized_email and normalize_email(notion_prop_value(props.get(prop_map.email, {}))) == normalized_email:
            return existing
    return None


def upsert_candidate_page(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
    *,
    candidate_name: str,
    candidate_email: str,
    source: str,
    role: str,
    resume_url: str,
    career_stage: str,
    linkedin_url: str,
    linkedin_confidence: str,
    company: str,
    current_title: str,
    location: str,
    date_first_entered: str,
    gmail_thread_id: str,
    synced_at_iso: str,
    existing_page: dict[str, Any] | None = None,
) -> tuple[str, bool]:
    properties_schema = database_schema.get("properties", {})
    title_prop_name = resolve_title_property_name(properties_schema, prop_map.candidate_name)
    page: dict[str, Any] | None = existing_page or find_existing_candidate_page(
        notion, database_schema, prop_map, gmail_thread_id, candidate_email
    )

    if page:
        # Existing ATS rows are manually curated in Notion. Avoid overwriting
        # profile fields during subsequent sync cycles. The exception is a weak
        # blank/Unknown/Other role when the current thread parse finds a stronger
        # role signal from the subject/body.
        props = page.get("properties", {})
        existing_source = notion_prop_value(props.get(prop_map.source, {})).strip()
        existing_role_values = notion_prop_values(props.get(prop_map.role, {}))
        existing_role = (
            existing_role_values[0]
            if len(existing_role_values) == 1
            else notion_prop_value(props.get(prop_map.role, {})).strip()
        )
        update_payload: dict[str, Any] = {}
        if not existing_source and prop_map.source in properties_schema:
            built_source = build_notion_value(properties_schema[prop_map.source], source)
            if built_source is not None:
                update_payload[prop_map.source] = built_source
        if (
            role in ROLE_OPTIONS
            and role != "Other"
            and clean_text(existing_role).lower() in {"", "unknown", "other"}
            and prop_map.role in properties_schema
        ):
            update_payload[prop_map.role] = build_notion_value(properties_schema[prop_map.role], [role])
        if update_payload:
            notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
        return page["id"], False

    role_values: list[str] = [role] if role in ROLE_OPTIONS else []

    base_values: dict[str, Any] = {
        title_prop_name: candidate_name,
        prop_map.email: candidate_email,
        prop_map.source: source,
        prop_map.role: role_values or role,
        prop_map.resume_url: resume_url,
        prop_map.career_stage: career_stage,
        prop_map.linkedin_url: linkedin_url,
        prop_map.linkedin_confidence: linkedin_confidence,
        prop_map.company: company,
        prop_map.current_title: current_title,
        prop_map.location: location,
        prop_map.date_first_entered: date_first_entered,
        prop_map.gmail_thread_id: gmail_thread_id,
        prop_map.last_sync_at: synced_at_iso,
    }
    values_to_set = dict(base_values)
    if not page:
        values_to_set[prop_map.status] = "Awaiting Decision"

    properties_payload: dict[str, Any] = {}
    for prop_name, value in values_to_set.items():
        if prop_name not in properties_schema:
            continue
        built = build_notion_value(properties_schema[prop_name], value)
        if built is not None:
            properties_payload[prop_name] = built

    created = notion.create_page(properties_payload)
    return created["id"], True


def backfill_missing_source_values(
    notion: NotionClient,
    database_schema: dict[str, Any],
    prop_map: NotionPropertyMap,
    gmail_service: Any,
    *,
    recruiter_sender_emails: set[str],
    recruiter_sender_names: set[str],
) -> int:
    properties_schema = database_schema.get("properties", {})
    if prop_map.source not in properties_schema:
        return 0

    source_schema = properties_schema[prop_map.source]
    updates = 0
    for page in notion.query_pages({"page_size": 100}):
        props = page.get("properties", {})
        if notion_prop_value(props.get(prop_map.source, {})).strip():
            continue

        source = SOURCE_INBOUND
        thread_id = notion_prop_value(props.get(prop_map.gmail_thread_id, {})).strip()
        if thread_id:
            try:
                thread = gmail_service.users().threads().get(
                    userId="me",
                    id=thread_id,
                    format="metadata",
                    metadataHeaders=["From"],
                ).execute()
            except Exception:
                thread = {}
            for message in sorted_thread_messages(thread):
                sender_name, sender_email = parseaddr(header_map(message).get("from", ""))
                sender_email = normalize_email(sender_email)
                if sender_is_recruiter_submission(
                    sender_email,
                    recruiter_sender_emails,
                    sender_name=sender_name,
                    recruiter_sender_names=recruiter_sender_names,
                ):
                    source = SOURCE_SUPERPOSITION
                    break

        built_source = build_notion_value(source_schema, source)
        if built_source is None:
            continue
        notion.update_page(page["id"], {prop_map.source: built_source})
        updates += 1

    return updates


def parse_candidate_from_message(
    message: dict[str, Any],
    *,
    internal_domains: set[str] | None = None,
) -> tuple[str, str, str]:
    headers = header_map(message)
    candidate_name, candidate_email = parse_candidate_identity_from_headers(
        headers,
        internal_domains=internal_domains,
    )
    subject = headers.get("subject", "").strip()
    return candidate_name, candidate_email, subject


EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}\b")


def normalize_sender_name(value: str) -> str:
    cleaned = clean_text(value).lower()
    cleaned = re.sub(r"[^a-z0-9]+", " ", cleaned)
    return clean_text(cleaned)


def sender_is_recruiter_submission(
    sender_email: str,
    recruiter_sender_emails: set[str],
    *,
    sender_name: str = "",
    recruiter_sender_names: set[str] | None = None,
) -> bool:
    if normalize_email(sender_email) in {normalize_email(item) for item in recruiter_sender_emails}:
        return True
    normalized_name = normalize_sender_name(sender_name)
    if not normalized_name:
        return False
    normalized_recruiter_names = {normalize_sender_name(item) for item in (recruiter_sender_names or set())}
    return normalized_name in normalized_recruiter_names


def recruiter_sender_name_queries(recruiter_sender_names: set[str], max_messages: int) -> list[str]:
    queries: list[str] = []
    seen_tokens: set[str] = set()
    for name in sorted(recruiter_sender_names):
        normalized = normalize_sender_name(name)
        if not normalized:
            continue
        first_token = normalized.split()[0]
        if not first_token or first_token in seen_tokens:
            continue
        seen_tokens.add(first_token)
        queries.append(f"from:({first_token})")
    return queries[: max(1, max_messages)]


def candidate_name_near_email(text: str, candidate_email: str) -> str:
    if not text or not candidate_email:
        return ""
    idx = text.lower().find(candidate_email.lower())
    if idx < 0:
        return ""
    before = text[max(0, idx - 160) : idx]
    patterns = [
        r"(?i)(?:candidate|name|applicant|from|contact)\s*[:\-]\s*([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})\s*$",
        r"([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})\s*(?:<|\()?\s*$",
    ]
    for pattern in patterns:
        match = re.search(pattern, before)
        if match:
            return clean_candidate_name(match.group(1))
    return ""


def parse_recruiter_candidate_from_thread(
    thread: dict[str, Any],
    *,
    recruiter_sender_emails: set[str],
    recruiter_sender_names: set[str],
    internal_domains: set[str],
) -> tuple[str, str, str, str] | None:
    messages = sorted_thread_messages(thread)
    if not messages:
        return None

    recruiter_messages: list[dict[str, Any]] = []
    recruiter_message_sender_emails: set[str] = set()
    for message in messages:
        headers = header_map(message)
        sender_name, sender_email = parseaddr(headers.get("from", ""))
        sender_email = normalize_email(sender_email)
        if sender_is_recruiter_submission(
            sender_email,
            recruiter_sender_emails,
            sender_name=sender_name,
            recruiter_sender_names=recruiter_sender_names,
        ):
            recruiter_messages.append(message)
            if sender_email:
                recruiter_message_sender_emails.add(sender_email)
    if not recruiter_messages:
        return None

    message = recruiter_messages[0]
    headers = header_map(message)
    subject = headers.get("subject", "").strip()
    body = "\n".join(extract_message_body_text(item) for item in recruiter_messages)
    candidate_email = ""
    excluded_emails = {normalize_email(item) for item in recruiter_sender_emails} | recruiter_message_sender_emails
    for email in EMAIL_RE.findall(body):
        normalized = normalize_email(email)
        if normalized in excluded_emails:
            continue
        if email_domain(normalized) in internal_domains:
            continue
        candidate_email = normalized
        break

    candidate_name = candidate_name_near_email(body, candidate_email)
    if not candidate_name:
        parsed_subject = clean_text(subject)
        parsed_subject = re.sub(r"(?i)\b(?:fwd|fw|re)\s*:\s*", "", parsed_subject)
        parsed_subject = re.sub(r"(?i)\b(?:candidate|applicant|application|resume|intro|introduction)\b", "", parsed_subject)
        parsed_subject = re.sub(r"(?i)\b(?:bdr|sdr|ae|account executive|growth generalist|gtm associate|growth associate)\b", "", parsed_subject)
        candidate_name = clean_candidate_name(parsed_subject.strip(" :-|"))
    if not candidate_name and candidate_email:
        candidate_name = candidate_name_from_email(candidate_email)

    role = canonicalize_truewind_role(f"{subject}\n{body}")
    return candidate_name, candidate_email, role, subject


def email_domain(value: str) -> str:
    email = normalize_email(value)
    if "@" not in email:
        return ""
    return email.rsplit("@", 1)[-1].strip()


def sender_matches_outbound_scope(from_email: str, sender_email: str) -> bool:
    normalized_from = normalize_email(from_email)
    normalized_sender = normalize_email(sender_email)
    if not normalized_from or not normalized_sender:
        return False
    if normalized_from == normalized_sender:
        return True
    sender_domain = email_domain(normalized_sender)
    return bool(sender_domain) and email_domain(normalized_from) == sender_domain


def subject_has_hiring_prefix(subject: str) -> bool:
    return "[hiring@]" in clean_text(subject).lower()


def select_application_message_from_thread(
    thread: dict[str, Any],
    *,
    internal_domains: set[str],
) -> dict[str, Any] | None:
    messages = sorted_thread_messages(thread)
    if not messages:
        return None

    fallback_external: dict[str, Any] | None = None
    for message in messages:
        headers = header_map(message)
        _candidate_name, candidate_email, _subject = parse_candidate_from_message(
            message,
            internal_domains=internal_domains,
        )
        if email_domain(candidate_email) in internal_domains:
            continue
        if fallback_external is None:
            fallback_external = message
        if subject_has_hiring_prefix(headers.get("subject", "")):
            return message

    return fallback_external or messages[0]


def ingest_cmd(_args: argparse.Namespace) -> None:
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    database_schema = notion.get_database()
    prop_map = resolve_property_map(config.property_map, database_schema)
    database_schema = ensure_role_property_schema(notion, database_schema, prop_map)
    database_schema = ensure_status_property_schema(notion, database_schema, prop_map)
    database_schema = ensure_source_property_schema(notion, database_schema, prop_map)
    prop_map = resolve_property_map(config.property_map, database_schema)

    gmail_service = ensure_google_service(
        api_name="gmail",
        api_version="v1",
        scopes=GMAIL_SCOPES,
        credentials_env="GOOGLE_GMAIL_CREDENTIALS_FILE",
        credentials_default="secrets/google-gmail-credentials.json",
        token_env="GOOGLE_GMAIL_TOKEN_FILE",
        token_default="secrets/google-gmail-token.json",
        help_text="Set GOOGLE_GMAIL_CREDENTIALS_FILE or place Gmail OAuth credentials in secrets/.",
    )

    drive_service = ensure_google_service(
        api_name="drive",
        api_version="v3",
        scopes=DRIVE_SCOPES,
        credentials_env="GOOGLE_DRIVE_CREDENTIALS_FILE",
        credentials_default="secrets/google-drive-credentials.json",
        token_env="GOOGLE_DRIVE_TOKEN_FILE",
        token_default="secrets/google-drive-token.json",
        help_text="Set GOOGLE_DRIVE_CREDENTIALS_FILE or place Drive OAuth credentials in secrets/.",
    )

    label_id = gmail_label_id(gmail_service, config.gmail_label_name)
    labeled_messages = list_label_messages(gmail_service, label_id, config.gmail_query, config.gmail_max_messages)
    subject_messages = list_messages_matching_query(gmail_service, config.gmail_query, config.gmail_max_messages)
    recruiter_messages: list[dict[str, Any]] = []
    for sender_email in sorted(config.recruiter_sender_emails):
        recruiter_messages.extend(
            list_messages_matching_query(
                gmail_service,
                f"from:{sender_email}",
                config.gmail_max_messages,
            )
        )
    for query in recruiter_sender_name_queries(config.recruiter_sender_names, config.gmail_max_messages):
        recruiter_messages.extend(
            list_messages_matching_query(
                gmail_service,
                query,
                config.gmail_max_messages,
            )
        )
    messages = merge_gmail_message_refs(labeled_messages, subject_messages, recruiter_messages)

    processed = 0
    created = 0
    updated = 0
    skipped = 0
    subject_format_skipped = 0
    slack_posts = 0
    slack_post_failures = 0
    thread_first_entered_cache: dict[str, str] = {}
    created_candidates: list[dict[str, str]] = []
    processed_threads: set[str] = set()
    internal_domains = {email_domain(config.from_email)}
    if config.hiring_alias:
        internal_domains.add(email_domain(config.hiring_alias))
    internal_domains.discard("")

    for item in messages:
        try:
            thread_id = item.get("threadId", "")
            if not thread_id or thread_id in processed_threads:
                continue
            processed_threads.add(thread_id)

            thread = gmail_service.users().threads().get(userId="me", id=thread_id, format="full").execute()
            thread_messages = sorted_thread_messages(thread)
            if not thread_messages:
                skipped += 1
                continue
            thread_recruiter_sender_emails: set[str] = set()
            for message in thread_messages:
                sender_name, sender_email = parseaddr(header_map(message).get("from", ""))
                sender_email = normalize_email(sender_email)
                if sender_is_recruiter_submission(
                    sender_email,
                    config.recruiter_sender_emails,
                    sender_name=sender_name,
                    recruiter_sender_names=config.recruiter_sender_names,
                ):
                    thread_recruiter_sender_emails.add(sender_email)

            recruiter_candidate = parse_recruiter_candidate_from_thread(
                thread,
                recruiter_sender_emails=config.recruiter_sender_emails,
                recruiter_sender_names=config.recruiter_sender_names,
                internal_domains=internal_domains,
            )
            ats_source = SOURCE_SUPERPOSITION if recruiter_candidate else SOURCE_INBOUND
            if recruiter_candidate:
                candidate_name, candidate_email, recruiter_role, subject = recruiter_candidate
                application_message = sorted_thread_messages(thread)[0]
            else:
                application_message = select_application_message_from_thread(
                    thread, internal_domains=internal_domains
                )
                if application_message is None:
                    skipped += 1
                    continue

                candidate_name, candidate_email, subject = parse_candidate_from_message(
                    application_message,
                    internal_domains=internal_domains,
                )
                candidate_domain = email_domain(candidate_email)
                if candidate_domain in internal_domains:
                    skipped += 1
                    continue
            if should_auto_archive_sender(candidate_email):
                remove_labels_from_thread(gmail_service, thread_id=thread_id, label_ids=[label_id])
                skipped += 1
                continue

            thread_body_text = "\n".join(extract_message_body_text(msg) for msg in thread_messages)

            if recruiter_candidate:
                role = recruiter_role
            else:
                parsed_subject = parse_required_subject(subject, candidate_name)
                if not parsed_subject:
                    skipped += 1
                    subject_format_skipped += 1
                    continue
                role, subject_candidate_name = parsed_subject
                candidate_name = subject_candidate_name
            if role in {"Unknown", "Other"}:
                # A stated position (e.g. "Account Executive") may appear anywhere in the
                # subject or body even when the primary subject parse missed it.
                rescanned = infer_truewind_role_from_subject(subject, candidate_name)
                if rescanned in {"Unknown", "Other"}:
                    rescanned = canonicalize_truewind_role(f"{subject}\n{thread_body_text}")
                if rescanned not in {"Unknown", "Other"}:
                    role = rescanned

            resume_reference = extract_primary_resume_part_from_thread(thread)
            resume_part: dict[str, Any] | None = None
            attachment_message_id = ""
            if resume_reference:
                attachment_message_id, resume_part = resume_reference

            resume_link = extract_resume_link_from_thread(thread)

            filename = (resume_part.get("filename") or "resume").strip() if resume_part else "resume"
            raw = b""
            resume_text = ""
            if resume_part and attachment_message_id:
                raw = gmail_message_attachment_bytes(gmail_service, attachment_message_id, resume_part)
                resume_text = extract_resume_text(filename, raw)
            elif not resume_link and role == "Unknown":
                # If there is no resume content and no role signal, this is likely a non-applicant thread.
                skipped += 1
                continue

            if not candidate_email and resume_text:
                excluded_emails = {normalize_email(item) for item in config.recruiter_sender_emails}
                excluded_emails |= thread_recruiter_sender_emails
                for email in EMAIL_RE.findall(resume_text):
                    normalized = normalize_email(email)
                    if normalized in excluded_emails:
                        continue
                    if email_domain(normalized) in internal_domains:
                        continue
                    candidate_email = normalized
                    break
            if (not candidate_name or candidate_name == "Unknown") and resume_text:
                resume_names = likely_resume_name_lines(resume_text)
                if resume_names:
                    candidate_name = clean_candidate_name(resume_names[0])
            if not candidate_email:
                skipped += 1
                continue
            if recruiter_candidate and not candidate_name:
                skipped += 1
                continue
            if config.hiring_alias and candidate_email == config.hiring_alias:
                skipped += 1
                continue

            snippet = application_message.get("snippet", "")
            message_body_text = thread_body_text

            stage = classify_career_stage(resume_text or snippet)
            resume_title, resume_company = infer_current_title_and_company_from_resume(resume_text, snippet)
            extracted_fields = extract_resume_fields(config, resume_text, snippet)
            extractor_title = clean_text(str(extracted_fields.get("latest_current_title", "") or ""))
            extractor_company = clean_text(str(extracted_fields.get("latest_current_company", "") or ""))
            # Prefer the LLM-extracted real name when the header/subject/heuristic name is
            # missing, "Unknown", or doesn't look like a person (e.g. a resume objective line).
            extractor_name = clean_candidate_name(str(extracted_fields.get("candidate_name", "") or ""))
            if extractor_name and looks_like_person_name(extractor_name) and (
                not candidate_name or candidate_name == "Unknown" or not looks_like_person_name(candidate_name)
            ):
                candidate_name = extractor_name
            location = classify_location(resume_text, snippet)

            existing_page = find_existing_candidate_page(
                notion, database_schema, prop_map, thread_id, candidate_email
            )
            existing_resume_url = ""
            existing_linkedin_url = ""
            existing_linkedin_confidence = ""
            existing_current_title = ""
            existing_company = ""
            existing_date_first_entered = ""
            if existing_page:
                props = existing_page.get("properties", {})
                existing_resume_url = notion_prop_value(
                    props.get(prop_map.resume_url, {})
                ).strip()
                existing_linkedin_url = notion_prop_value(
                    props.get(prop_map.linkedin_url, {})
                ).strip()
                existing_linkedin_confidence = notion_prop_value(
                    props.get(prop_map.linkedin_confidence, {})
                ).strip()
                existing_current_title = notion_prop_value(
                    props.get(prop_map.current_title, {})
                ).strip()
                existing_company = notion_prop_value(
                    props.get(prop_map.company, {})
                ).strip()
                existing_date_first_entered = notion_prop_value(
                    props.get(prop_map.date_first_entered, {})
                ).strip()

            resume_linkedin_url = extract_linkedin_url(
                resume_text, snippet, filename, raw, message_body_text
            )
            linkedin_url = resume_linkedin_url or existing_linkedin_url
            linkedin_confidence = (
                LINKEDIN_CONFIDENCE_HIGH if resume_linkedin_url else existing_linkedin_confidence
            )
            # Only attempt a LinkedIn lookup when we have a real candidate name. Searching
            # with "Unknown" or a non-name (e.g. a resume objective line) wastes the call
            # and tends to return the wrong profile.
            if not linkedin_url and candidate_name and candidate_name != "Unknown" and looks_like_person_name(candidate_name):
                fallback_url, fallback_confidence = find_linkedin_url_for_candidate(
                    config,
                    candidate_name,
                    extractor_company or resume_company or existing_company,
                    extractor_title or resume_title or existing_current_title,
                )
                if fallback_url:
                    linkedin_url = fallback_url
                    linkedin_confidence = fallback_confidence or LINKEDIN_CONFIDENCE_LOW
            elif not linkedin_confidence:
                linkedin_confidence = LINKEDIN_CONFIDENCE_MEDIUM

            linkedin_title = ""
            linkedin_company = ""
            can_skip_enrichment = (
                existing_linkedin_url
                and existing_linkedin_url == linkedin_url
                and existing_current_title
                and existing_company
                and existing_current_title.lower() != "unknown"
                and existing_company.lower() != "unknown"
            )
            if not can_skip_enrichment:
                linkedin_title, linkedin_company = enrich_linkedin_title_company(config, linkedin_url)

            resume_title_value = resume_title if resume_title and resume_title.lower() != "unknown" else ""
            resume_company_value = resume_company if resume_company and resume_company.lower() != "unknown" else ""
            extractor_title_value = (
                extractor_title if extractor_title and extractor_title.lower() != "unknown" else ""
            )
            extractor_company_value = (
                extractor_company if extractor_company and extractor_company.lower() != "unknown" else ""
            )
            current_title = (
                extractor_title_value or resume_title_value or linkedin_title or existing_current_title or "Unknown"
            )
            company = (
                extractor_company_value or resume_company_value or linkedin_company or existing_company or "Unknown"
            )
            resume_url = existing_resume_url
            if not resume_url:
                if raw:
                    resume_url = upload_resume_to_drive(drive_service, filename, raw, config.drive_folder_id)
                elif resume_link:
                    resume_url = resume_link
            computed_first_entered = thread_first_entered_cache.get(thread_id, "")
            if not computed_first_entered:
                first_dt = thread_first_message_datetime(gmail_service, thread_id) or message_internal_datetime(
                    application_message
                )
                computed_first_entered = iso(first_dt) if first_dt else ""
                thread_first_entered_cache[thread_id] = computed_first_entered
            date_first_entered = existing_date_first_entered or computed_first_entered
            existing_first_dt = parse_iso_datetime(existing_date_first_entered, config.timezone_name)
            computed_first_dt = parse_iso_datetime(computed_first_entered, config.timezone_name)
            if existing_first_dt and computed_first_dt and computed_first_dt < existing_first_dt:
                date_first_entered = computed_first_entered

            page_id, was_created = upsert_candidate_page(
                notion,
                database_schema,
                prop_map,
                candidate_name=candidate_name,
                candidate_email=candidate_email,
                source=ats_source,
                role=role,
                resume_url=resume_url,
                career_stage=stage,
                linkedin_url=linkedin_url,
                linkedin_confidence=linkedin_confidence,
                company=company,
                current_title=current_title,
                location=location,
                date_first_entered=date_first_entered,
                gmail_thread_id=thread_id,
                synced_at_iso=iso(now_local(config.timezone_name)),
                existing_page=existing_page,
            )

            processed += 1
            if was_created:
                created += 1
                created_candidates.append(
                    {
                        "candidate_name": candidate_name,
                        "source": ats_source,
                        "role": role,
                        "current_title": current_title,
                        "company": company,
                        "career_stage": stage,
                        "location": location,
                        "linkedin_url": linkedin_url,
                        "resume_url": resume_url,
                        "thread_id": thread_id,
                        "notion_url": notion_page_url(page_id),
                    }
                )
            else:
                updated += 1

        except Exception as exc:
            # One malformed applicant must not abort the whole ingest cycle.
            skipped += 1
            print(f"[ingest] skipped thread {item.get('threadId', '?')} after unhandled error: {exc}")
            continue
    source_backfilled = backfill_missing_source_values(
        notion,
        database_schema,
        prop_map,
        gmail_service,
        recruiter_sender_emails=config.recruiter_sender_emails,
        recruiter_sender_names=config.recruiter_sender_names,
    )

    if slack_post_enabled(config):
        reconciliation = reconcile_slack_reviews(
            config, notion, database_schema, prop_map, apply=True
        )
        slack_posts = len(reconciliation["posted"])
        slack_post_failures = 0

    print(f"Processed messages: {processed}")
    print(f"Created Notion records: {created}")
    print(f"Updated Notion records: {updated}")
    print(f"Backfilled Source values: {source_backfilled}")
    print(f"Skipped messages: {skipped}")
    print(f"Skipped (subject format mismatch): {subject_format_skipped}")
    if slack_post_enabled(config):
        print(f"Slack review posts created: {slack_posts}")
        print(f"Slack review post failures: {slack_post_failures}")


def process_decisions_cmd(_args: argparse.Namespace) -> None:
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    database_schema = notion.get_database()
    properties_schema = database_schema.get("properties", {})
    prop = resolve_property_map(config.property_map, database_schema)
    database_schema = ensure_role_property_schema(notion, database_schema, prop)
    database_schema = ensure_status_property_schema(notion, database_schema, prop)
    properties_schema = database_schema.get("properties", {})
    prop = resolve_property_map(config.property_map, database_schema)

    gmail_service = ensure_google_service(
        api_name="gmail",
        api_version="v1",
        scopes=GMAIL_SCOPES,
        credentials_env="GOOGLE_GMAIL_CREDENTIALS_FILE",
        credentials_default="secrets/google-gmail-credentials.json",
        token_env="GOOGLE_GMAIL_TOKEN_FILE",
        token_default="secrets/google-gmail-token.json",
        help_text="Set GOOGLE_GMAIL_CREDENTIALS_FILE or place Gmail OAuth credentials in secrets/.",
    )
    calendar_service = ensure_google_service(
        api_name="calendar",
        api_version="v3",
        scopes=CALENDAR_SCOPES,
        credentials_env="GOOGLE_CALENDAR_CREDENTIALS_FILE",
        credentials_default="secrets/google-calendar-credentials.json",
        token_env="GOOGLE_CALENDAR_TOKEN_FILE",
        token_default="secrets/google-calendar-token.json",
        help_text="Set GOOGLE_CALENDAR_CREDENTIALS_FILE or place Calendar OAuth credentials in secrets/.",
    )

    pages = notion.query_pages({"page_size": 100})

    proceed_drafts = 0
    proceed_drafts_auto_sent = 0
    proceed_drafts_auto_send_skipped_missing = 0
    reject_scheduled = 0
    reject_drafts = 0
    reject_drafts_auto_sent = 0
    reject_drafts_auto_send_skipped_young = 0
    reject_drafts_auto_send_skipped_name = 0
    reject_drafts_auto_send_skipped_missing = 0
    reject_marked_sent = 0
    manual_reject_marked = 0
    reject_threads_archived = 0
    reject_archive_failures = 0
    sent_draft_threads_archived = 0
    sent_draft_archive_failures = 0
    non_scheduling_threads_archived = 0
    non_scheduling_archive_failures = 0
    in_process_marked = 0
    no_response_drafts = 0
    no_response_closeouts_sent = 0
    custom_gpt_no_response_sent = 0
    custom_gpt_no_response_send_failures = 0
    custom_gpt_no_response_skipped_young = 0
    scheduling_drafts = 0
    status_lookback_anchor = now_local(config.timezone_name) - timedelta(days=config.sent_status_lookback_days)
    hiring_label_id = ""
    if config.gmail_label_name:
        try:
            hiring_label_id = gmail_label_id(gmail_service, config.gmail_label_name)
        except Exception:
            hiring_label_id = ""
    pipeline_label_id = ""
    if config.pipeline_label_name:
        try:
            pipeline_label_id = gmail_label_id(gmail_service, config.pipeline_label_name)
        except Exception:
            pipeline_label_id = ""
    internal_domains = {email_domain(config.from_email)}
    if config.hiring_alias:
        internal_domains.add(email_domain(config.hiring_alias))
    internal_domains.discard("")

    for page in pages:
        page_props = page.get("properties", {})
        decision = notion_prop_value(page_props.get(prop.decision, {})).strip().lower()
        current_status_raw = notion_prop_value(page_props.get(prop.status, {})).strip()
        current_status = status_key(current_status_raw)
        reject_draft_id_raw = notion_prop_value(page_props.get(prop.reject_draft_id, {})).strip()
        reject_send_at_raw = notion_prop_value(page_props.get(prop.reject_send_at, {})).strip()
        uses_custom_gpt_assignment = uses_custom_gpt_first_round(page_props, prop)
        candidate_name = notion_prop_value(page_props.get(prop.candidate_name, {})).strip() or "Candidate"
        linkedin_url = notion_prop_value(page_props.get(prop.linkedin_url, {})).strip()

        candidate_email = notion_prop_value(page_props.get(prop.email, {})).strip()
        thread_id = notion_prop_value(page_props.get(prop.gmail_thread_id, {})).strip()
        if not candidate_email or not thread_id:
            continue
        related_thread_ids = candidate_related_thread_ids(
            gmail_service,
            candidate_email=candidate_email,
            primary_thread_id=thread_id,
            internal_domains=internal_domains,
            hiring_label_id=hiring_label_id,
        )
        reply_thread_id = preferred_reply_thread_id(
            gmail_service,
            thread_ids=related_thread_ids,
            fallback_thread_id=thread_id,
        )

        if should_skip_terminal_status_before_decision_processing(
            status=current_status_raw,
            decision=decision,
            reject_draft_id=reject_draft_id_raw,
        ):
            archive_labels = [label_id for label_id in (hiring_label_id, pipeline_label_id) if label_id]
            if archive_labels:
                archived_count, archive_failures = remove_labels_from_threads(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    label_ids=archive_labels,
                )
                non_scheduling_threads_archived += archived_count
                non_scheduling_archive_failures += archive_failures
            continue

        update_payload: dict[str, Any] = {}
        in_pipeline = False
        if pipeline_label_id and any_thread_has_label(
            gmail_service,
            thread_ids=related_thread_ids,
            label_id=pipeline_label_id,
        ):
            in_pipeline = True
            if current_status != "interview in process" and prop.status in properties_schema:
                in_process_marked += 1
                update_payload[prop.status] = build_notion_value(
                    properties_schema[prop.status], STATUS_INTERVIEW_IN_PROCESS
                )
                current_status = "interview in process"

        manual_reject_sent_at: datetime | None = None
        if current_status != "rejected" and not in_pipeline:
            manual_reject_sent_at = thread_latest_manual_rejection_sent_at_any_thread(
                gmail_service,
                thread_ids=related_thread_ids,
                sender_email=config.from_email,
                candidate_email=candidate_email,
            )
            if manual_reject_sent_at:
                manual_reject_marked += 1
                if prop.status in properties_schema:
                    update_payload[prop.status] = build_notion_value(properties_schema[prop.status], STATUS_REJECTED)
                    current_status = "rejected"
                if prop.decision in properties_schema and decision != "reject":
                    update_payload[prop.decision] = build_notion_value(properties_schema[prop.decision], "Reject")
                    decision = "reject"
                if prop.decision_time in properties_schema:
                    existing_decision_time = notion_prop_value(page_props.get(prop.decision_time, {})).strip()
                    if not existing_decision_time:
                        update_payload[prop.decision_time] = build_notion_value(
                            properties_schema[prop.decision_time],
                            iso(manual_reject_sent_at.astimezone(timezone.utc)),
                        )

                archive_labels = [hiring_label_id]
                if pipeline_label_id:
                    archive_labels.append(pipeline_label_id)
                archived_count, archive_failures = remove_labels_from_threads(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    label_ids=archive_labels,
                )
                reject_threads_archived += archived_count
                reject_archive_failures += archive_failures

        if manual_reject_sent_at:
            if update_payload:
                notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
            continue

        sent_archive_labels = [hiring_label_id] if hiring_label_id else []
        if clean_text(current_status_raw).lower() == "proceed drafted":
            if uses_custom_gpt_assignment:
                proceed_sent_at = thread_latest_assignment_sent_at_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    sender_email=config.from_email,
                    keywords=config.assignment_keywords,
                )
            else:
                proceed_sent_at = thread_latest_sent_matching_patterns_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    sender_email=config.from_email,
                    candidate_email=candidate_email,
                    patterns=[PROCEED_SENT_RE],
                )
            if proceed_sent_at:
                if prop.status in properties_schema:
                    next_status = (
                        STATUS_WAITING_ON_CUSTOM_GPT
                        if uses_custom_gpt_assignment
                        else STATUS_ROUND_1_SCHEDULING
                    )
                    update_payload[prop.status] = build_notion_value(properties_schema[prop.status], next_status)
                archived_count, archive_failures = remove_labels_from_threads(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    label_ids=sent_archive_labels,
                )
                sent_draft_threads_archived += archived_count
                sent_draft_archive_failures += archive_failures
                if update_payload:
                    notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
                continue

        if current_status == "round 1 scheduling":
            proceed_sent_at = thread_latest_sent_matching_patterns_any_thread(
                gmail_service,
                thread_ids=related_thread_ids,
                sender_email=config.from_email,
                candidate_email=candidate_email,
                patterns=[PROCEED_SENT_RE],
            )
            if proceed_sent_at:
                reply_dt, reply_text = latest_candidate_message_since_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    candidate_email=candidate_email,
                    since=proceed_sent_at,
                )
                if reply_dt:
                    reply_state = classify_scheduling_readiness_reply(reply_text)
                    if reply_state == "ready":
                        scheduling_draft_id = notion_prop_value(page_props.get(prop.scheduling_draft_id, {})).strip()
                        proposed_slot_raw = notion_prop_value(page_props.get(prop.proposed_slot, {})).strip()
                        if not scheduling_draft_id and not proposed_slot_raw:
                            slot = find_next_available_slot(
                                config, calendar_service, start_anchor=now_local(config.timezone_name)
                            )
                            if slot:
                                slot_label = slot.strftime("%A, %b %d at %-I:%M %p %Z")
                                schedule_body = config.scheduling_template.format(slot_label=slot_label)
                                draft_id = create_reply_draft(
                                    gmail_service,
                                    sender_email=config.from_email,
                                    to_email=candidate_email,
                                    thread_id=reply_thread_id,
                                    body_text=schedule_body,
                                )
                                scheduling_drafts += 1
                                if prop.scheduling_draft_id in properties_schema:
                                    update_payload[prop.scheduling_draft_id] = build_notion_value(
                                        properties_schema[prop.scheduling_draft_id], draft_id
                                    )
                                if prop.proposed_slot in properties_schema:
                                    update_payload[prop.proposed_slot] = build_notion_value(
                                        properties_schema[prop.proposed_slot], iso(slot)
                                    )
                                if prop.status in properties_schema:
                                    update_payload[prop.status] = build_notion_value(
                                        properties_schema[prop.status], STATUS_SCHEDULING_SENT
                                    )
                    elif reply_state in {"decline", "ambiguous"} and prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], STATUS_NEEDS_ATTENTION
                        )

            assignment_sent_at = thread_latest_assignment_sent_at_any_thread(
                gmail_service,
                thread_ids=related_thread_ids,
                sender_email=config.from_email,
                keywords=config.assignment_keywords,
            )
            if assignment_sent_at and not update_payload:
                reply_dt, _reply_text = latest_candidate_message_since_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    candidate_email=candidate_email,
                    since=assignment_sent_at,
                )
                if business_day_no_response_due(
                    assignment_sent_at,
                    reply_dt,
                    now_local(config.timezone_name),
                    config.no_response_wait_business_days,
                    config.timezone_name,
                ):
                    no_response_sent_at = thread_latest_sent_matching_patterns_any_thread(
                        gmail_service,
                        thread_ids=related_thread_ids,
                        sender_email=config.from_email,
                        candidate_email=candidate_email,
                        patterns=[NO_RESPONSE_SENT_RE],
                    )
                    sent_message_id = ""
                    if not no_response_sent_at:
                        first_name = extract_first_name(candidate_name, candidate_email)
                        body = render_no_response_template(config.no_response_template, first_name)
                        sent_message_id = send_reply_email(
                            gmail_service,
                            sender_email=config.from_email,
                            to_email=candidate_email,
                            thread_id=reply_thread_id,
                            body_text=body,
                        )
                    if sent_message_id or no_response_sent_at:
                        if sent_message_id:
                            no_response_closeouts_sent += 1
                        if prop.status in properties_schema:
                            update_payload[prop.status] = build_notion_value(
                                properties_schema[prop.status], STATUS_NO_RESPONSE
                            )
                        if prop.decision in properties_schema:
                            update_payload[prop.decision] = build_notion_value(
                                properties_schema[prop.decision], "Reject"
                            )
                        if prop.decision_time in properties_schema:
                            update_payload[prop.decision_time] = build_notion_value(
                                properties_schema[prop.decision_time], iso(now_local(config.timezone_name))
                            )
                        if prop.reject_draft_id in properties_schema:
                            update_payload[prop.reject_draft_id] = build_notion_value(
                                properties_schema[prop.reject_draft_id], ""
                            )
                        if prop.reject_send_at in properties_schema:
                            update_payload[prop.reject_send_at] = build_notion_value(
                                properties_schema[prop.reject_send_at], ""
                            )
                        closeout_labels = [label_id for label_id in (hiring_label_id, pipeline_label_id) if label_id]
                        if closeout_labels:
                            archived_count, archive_failures = remove_labels_from_threads(
                                gmail_service,
                                thread_ids=related_thread_ids,
                                label_ids=closeout_labels,
                            )
                            reject_threads_archived += archived_count
                            reject_archive_failures += archive_failures

            if update_payload:
                notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
            continue

        if current_status == "scheduling sent":
            scheduling_sent_at = thread_latest_sent_matching_patterns_any_thread(
                gmail_service,
                thread_ids=related_thread_ids,
                sender_email=config.from_email,
                candidate_email=candidate_email,
                patterns=[SCHEDULING_SENT_RE],
            )
            if scheduling_sent_at:
                reply_dt, reply_text = latest_candidate_message_since_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    candidate_email=candidate_email,
                    since=scheduling_sent_at,
                )
                if reply_dt:
                    reply_state = classify_scheduling_confirmation_reply(reply_text)
                    if reply_state == "confirm":
                        proposed_slot_raw = notion_prop_value(page_props.get(prop.proposed_slot, {})).strip()
                        proposed_slot = parse_iso_datetime(proposed_slot_raw, config.timezone_name)
                        if proposed_slot:
                            event = create_calendar_invite_for_candidate(
                                calendar_service,
                                config=config,
                                candidate_name=candidate_name,
                                candidate_email=candidate_email,
                                start_at=proposed_slot,
                                thread_id=thread_id,
                            )
                            slot_label = proposed_slot.astimezone(ZoneInfo(config.timezone_name)).strftime(
                                "%A, %b %d at %-I:%M %p %Z"
                            )
                            confirm_body = DEFAULT_SCHEDULING_CONFIRM_TEMPLATE.format(slot_label=slot_label)
                            draft_id = create_reply_draft(
                                gmail_service,
                                sender_email=config.from_email,
                                to_email=candidate_email,
                                thread_id=reply_thread_id,
                                body_text=confirm_body,
                            )
                            if prop.scheduling_draft_id in properties_schema:
                                update_payload[prop.scheduling_draft_id] = build_notion_value(
                                    properties_schema[prop.scheduling_draft_id], draft_id
                                )
                            if prop.status in properties_schema:
                                update_payload[prop.status] = build_notion_value(
                                    properties_schema[prop.status], STATUS_SCHEDULING_SENT
                                )
                            if prop.proposed_slot in properties_schema:
                                update_payload[prop.proposed_slot] = build_notion_value(
                                    properties_schema[prop.proposed_slot], iso(proposed_slot)
                                )
                    elif reply_state in {"decline", "ambiguous"} and prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], STATUS_NEEDS_ATTENTION
                        )

            proposed_slot_raw = notion_prop_value(page_props.get(prop.proposed_slot, {})).strip()
            proposed_slot = parse_iso_datetime(proposed_slot_raw, config.timezone_name)
            if proposed_slot and now_local(config.timezone_name).astimezone(timezone.utc) >= proposed_slot.astimezone(timezone.utc):
                post_meeting_sent = thread_latest_sent_matching_patterns_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    sender_email=config.from_email,
                    candidate_email=candidate_email,
                    patterns=[re.compile(r".", re.DOTALL)],
                )
                if post_meeting_sent and post_meeting_sent >= proposed_slot.astimezone(timezone.utc):
                    if prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], STATUS_INTERVIEW_IN_PROCESS
                        )

            if update_payload:
                notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
            continue

        if current_status == "waiting on customgpt":
            if not uses_custom_gpt_assignment:
                if prop.status in properties_schema:
                    update_payload[prop.status] = build_notion_value(
                        properties_schema[prop.status], STATUS_ROUND_1_SCHEDULING
                    )
                if update_payload:
                    notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
                continue

            assignment_sent_at = thread_latest_assignment_sent_at_any_thread(
                gmail_service,
                thread_ids=related_thread_ids,
                sender_email=config.from_email,
                keywords=config.assignment_keywords,
            )
            if assignment_sent_at:
                reply_dt, _reply_text = latest_candidate_message_since_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    candidate_email=candidate_email,
                    since=assignment_sent_at,
                )
                if reply_dt and prop.status in properties_schema:
                    update_payload[prop.status] = build_notion_value(
                        properties_schema[prop.status], STATUS_ROUND_1_SCHEDULING
                    )
                elif custom_gpt_no_response_due(
                    assignment_sent_at,
                    now_local(config.timezone_name),
                    config.custom_gpt_no_response_wait_hours,
                ):
                    first_name = extract_first_name(candidate_name, candidate_email)
                    body = render_no_response_template(config.custom_gpt_no_response_template, first_name)
                    sent_message_id = send_reply_email(
                        gmail_service,
                        sender_email=config.from_email,
                        to_email=candidate_email,
                        thread_id=reply_thread_id,
                        body_text=body,
                    )
                    if sent_message_id:
                        custom_gpt_no_response_sent += 1
                        if prop.status in properties_schema:
                            update_payload[prop.status] = build_notion_value(
                                properties_schema[prop.status], STATUS_NO_RESPONSE
                            )
                        if prop.decision in properties_schema:
                            update_payload[prop.decision] = build_notion_value(
                                properties_schema[prop.decision], "Reject"
                            )
                        if prop.decision_time in properties_schema:
                            update_payload[prop.decision_time] = build_notion_value(
                                properties_schema[prop.decision_time], iso(now_local(config.timezone_name))
                            )
                        if prop.reject_draft_id in properties_schema:
                            update_payload[prop.reject_draft_id] = build_notion_value(
                                properties_schema[prop.reject_draft_id], ""
                            )
                        if prop.reject_send_at in properties_schema:
                            update_payload[prop.reject_send_at] = build_notion_value(
                                properties_schema[prop.reject_send_at], ""
                            )
                        closeout_labels = [label_id for label_id in (hiring_label_id, pipeline_label_id) if label_id]
                        if closeout_labels:
                            archived_count, archive_failures = remove_labels_from_threads(
                                gmail_service,
                                thread_ids=related_thread_ids,
                                label_ids=closeout_labels,
                            )
                            reject_threads_archived += archived_count
                            reject_archive_failures += archive_failures
                    else:
                        custom_gpt_no_response_send_failures += 1
                else:
                    custom_gpt_no_response_skipped_young += 1
            else:
                if prop.status in properties_schema:
                    update_payload[prop.status] = build_notion_value(
                        properties_schema[prop.status], STATUS_NEEDS_ATTENTION
                    )
            if update_payload:
                notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
            continue

        if current_status == "no response":
            no_response_sent_at = thread_latest_sent_matching_patterns_any_thread(
                gmail_service,
                thread_ids=related_thread_ids,
                sender_email=config.from_email,
                candidate_email=candidate_email,
                patterns=[NO_RESPONSE_SENT_RE],
            )
            closeout_labels = list(sent_archive_labels)
            if pipeline_label_id:
                closeout_labels.append(pipeline_label_id)
            if no_response_sent_at:
                if prop.status in properties_schema:
                    update_payload[prop.status] = build_notion_value(properties_schema[prop.status], STATUS_NO_RESPONSE)
                if prop.decision in properties_schema:
                    update_payload[prop.decision] = build_notion_value(properties_schema[prop.decision], "Reject")
                archived_count, archive_failures = remove_labels_from_threads(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    label_ids=closeout_labels,
                )
                sent_draft_threads_archived += archived_count
                sent_draft_archive_failures += archive_failures
                if update_payload:
                    notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
                continue

        if decision not in {"proceed", "reject"}:
            if current_status == "awaiting decision":
                assignment_sent_at = thread_latest_assignment_sent_at_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    sender_email=config.from_email,
                    keywords=config.assignment_keywords,
                )
                if assignment_sent_at:
                    due_at = add_business_days(
                        assignment_sent_at,
                        config.no_response_wait_business_days,
                        config.timezone_name,
                    )
                    if now_local(config.timezone_name).astimezone(timezone.utc) >= due_at:
                        if not candidate_replied_since_any_thread(
                            gmail_service,
                            thread_ids=related_thread_ids,
                            candidate_email=candidate_email,
                            since=assignment_sent_at,
                        ):
                            first_name = extract_first_name(
                                notion_prop_value(page_props.get(prop.candidate_name, {})).strip() or "there",
                                candidate_email,
                            )
                            body = render_no_response_template(config.no_response_template, first_name)
                            draft_id = create_reply_draft(
                                gmail_service,
                                sender_email=config.from_email,
                                to_email=candidate_email,
                                thread_id=reply_thread_id,
                                body_text=body,
                            )
                            no_response_drafts += 1
                            if prop.reject_draft_id in properties_schema:
                                update_payload[prop.reject_draft_id] = build_notion_value(
                                    properties_schema[prop.reject_draft_id], draft_id
                                )
                            if prop.decision in properties_schema:
                                update_payload[prop.decision] = build_notion_value(
                                    properties_schema[prop.decision], "Reject"
                                )
                            if prop.decision_time in properties_schema:
                                update_payload[prop.decision_time] = build_notion_value(
                                    properties_schema[prop.decision_time], iso(now_local(config.timezone_name))
                                )
                            if prop.status in properties_schema:
                                update_payload[prop.status] = build_notion_value(
                                    properties_schema[prop.status], STATUS_NO_RESPONSE
                                )
            if update_payload:
                notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
            continue

        decision_time_raw = notion_prop_value(page_props.get(prop.decision_time, {})).strip()
        decision_time = parse_iso_datetime(decision_time_raw, config.timezone_name)
        now = now_local(config.timezone_name)

        if decision == "proceed":
            proceed_draft_id = notion_prop_value(page_props.get(prop.proceed_draft_id, {})).strip()
            if proceed_draft_id and current_status == "round 1 scheduling":
                sent_message_id = send_gmail_draft(gmail_service, proceed_draft_id)
                if sent_message_id:
                    proceed_drafts_auto_sent += 1
                    next_status = (
                        STATUS_WAITING_ON_CUSTOM_GPT
                        if uses_custom_gpt_assignment
                        else STATUS_ROUND_1_SCHEDULING
                    )
                    current_status = next_status.lower()
                    if prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], next_status
                        )
                    if prop.proceed_draft_id in properties_schema:
                        update_payload[prop.proceed_draft_id] = build_notion_value(
                            properties_schema[prop.proceed_draft_id], ""
                        )
                    if not decision_time and prop.decision_time in properties_schema:
                        update_payload[prop.decision_time] = build_notion_value(
                            properties_schema[prop.decision_time], iso(now)
                        )
                else:
                    proceed_drafts_auto_send_skipped_missing += 1
            elif not proceed_draft_id:
                proceed_body = DEFAULT_CUSTOM_GPT_PROCEED_TEMPLATE if uses_custom_gpt_assignment else config.proceed_template
                draft_id = create_reply_draft(
                    gmail_service,
                    sender_email=config.from_email,
                    to_email=candidate_email,
                    thread_id=reply_thread_id,
                    body_text=proceed_body,
                )
                proceed_drafts += 1
                if prop.proceed_draft_id in properties_schema:
                    update_payload[prop.proceed_draft_id] = build_notion_value(
                        properties_schema[prop.proceed_draft_id], draft_id
                    )
                if not decision_time and prop.decision_time in properties_schema:
                    update_payload[prop.decision_time] = build_notion_value(
                        properties_schema[prop.decision_time], iso(now)
                    )
                if prop.status in properties_schema:
                    update_payload[prop.status] = build_notion_value(
                        properties_schema[prop.status],
                        STATUS_WAITING_ON_CUSTOM_GPT
                        if uses_custom_gpt_assignment
                        else STATUS_ROUND_1_SCHEDULING,
                    )
                sent_message_id = send_gmail_draft(gmail_service, draft_id)
                if sent_message_id:
                    proceed_drafts_auto_sent += 1
                    next_status = (
                        STATUS_WAITING_ON_CUSTOM_GPT
                        if uses_custom_gpt_assignment
                        else STATUS_ROUND_1_SCHEDULING
                    )
                    current_status = next_status.lower()
                    if prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], next_status
                        )
                    if prop.proceed_draft_id in properties_schema:
                        update_payload[prop.proceed_draft_id] = build_notion_value(
                            properties_schema[prop.proceed_draft_id], ""
                        )

            # Scheduling proposal after candidate reply.
            scheduling_draft_id = notion_prop_value(page_props.get(prop.scheduling_draft_id, {})).strip()
            proposed_slot_raw = notion_prop_value(page_props.get(prop.proposed_slot, {})).strip()
            anchor = decision_time or now
            if not uses_custom_gpt_assignment:
                reply_dt, reply_text = latest_candidate_message_since_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    candidate_email=candidate_email,
                    since=anchor,
                )
                if reply_dt:
                    reply_state = classify_scheduling_readiness_reply(reply_text)
                    if reply_state == "ready" and prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], STATUS_ROUND_1_SCHEDULING
                        )
                    elif reply_state in {"decline", "ambiguous"} and prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], STATUS_NEEDS_ATTENTION
                        )

        if decision == "reject":
            reject_draft_id = reject_draft_id_raw
            reject_send_at = parse_iso_datetime(reject_send_at_raw, config.timezone_name)

            if not decision_time:
                decision_time = now
                if prop.decision_time in properties_schema:
                    update_payload[prop.decision_time] = build_notion_value(
                        properties_schema[prop.decision_time], iso(decision_time)
                    )

            if should_process_reject_draft(
                status=current_status_raw,
                decision=decision,
                reject_draft_id=reject_draft_id,
            ):
                candidate_notion_url = notion_page_url(page.get("id", ""))
                draft = get_gmail_draft(gmail_service, reject_draft_id)
                draft_created_at = gmail_draft_created_at(draft or {})
                now_utc = now.astimezone(timezone.utc)
                if not draft:
                    verified_sent_at = thread_latest_manual_rejection_sent_at_any_thread(
                        gmail_service,
                        thread_ids=related_thread_ids,
                        sender_email=config.from_email,
                        candidate_email=candidate_email,
                    )
                    if verified_sent_at:
                        reject_drafts_auto_sent += 1
                        current_status = "rejected"
                        if prop.status in properties_schema:
                            update_payload[prop.status] = build_notion_value(
                                properties_schema[prop.status], STATUS_REJECTED
                            )
                        if prop.reject_draft_id in properties_schema:
                            update_payload[prop.reject_draft_id] = build_notion_value(
                                properties_schema[prop.reject_draft_id], ""
                            )
                        if prop.reject_send_at in properties_schema:
                            update_payload[prop.reject_send_at] = build_notion_value(
                                properties_schema[prop.reject_send_at], ""
                            )
                        archive_labels = [hiring_label_id]
                        if pipeline_label_id:
                            archive_labels.append(pipeline_label_id)
                        archived_count, archive_failures = remove_labels_from_threads(
                            gmail_service,
                            thread_ids=related_thread_ids,
                            label_ids=archive_labels,
                        )
                        reject_threads_archived += archived_count
                        reject_archive_failures += archive_failures
                    else:
                        reject_drafts_auto_send_skipped_missing += 1
                        notify_rejection_draft_issue(
                            config,
                            draft_id=reject_draft_id,
                            issue_key="draft_missing",
                            heading="Rejection draft is missing. Auto-send skipped.",
                            candidate_name=candidate_name,
                            candidate_email=candidate_email,
                            details=[
                                "*Reason:* Gmail could not find the draft stored on the ATS row, and no matching sent rejection email was found.",
                            ],
                            notion_url=candidate_notion_url,
                        )
                elif not draft_created_at:
                    reject_drafts_auto_send_skipped_missing += 1
                    notify_rejection_draft_issue(
                        config,
                        draft_id=reject_draft_id,
                        issue_key="draft_timestamp_missing",
                        heading="Rejection draft timestamp is missing. Auto-send skipped.",
                        candidate_name=candidate_name,
                        candidate_email=candidate_email,
                        details=[
                            "*Reason:* Gmail returned the draft, but it did not include a usable creation timestamp.",
                        ],
                        notion_url=candidate_notion_url,
                    )
                elif now_utc - draft_created_at < timedelta(hours=config.reject_draft_auto_send_age_hours):
                    reject_drafts_auto_send_skipped_young += 1
                else:
                    draft_body = gmail_draft_body_text(draft)
                    draft_body, can_send_existing_draft = repair_missing_greeting_draft(
                        gmail_service,
                        draft=draft,
                        body_text=draft_body,
                        candidate_name=candidate_name,
                        candidate_email=candidate_email,
                    )
                    name_evidence = build_rejection_first_name_evidence(
                        gmail_service,
                        thread_ids=related_thread_ids,
                        candidate_name=candidate_name,
                        candidate_email=candidate_email,
                        linkedin_url=linkedin_url,
                        pdl_api_key=config.pdl_api_key,
                    )
                    deterministic_ok, greeting_first_name, deterministic_reason = run_rejection_name_verification_agent(
                        draft_body=draft_body,
                        evidence=name_evidence,
                    )
                    # Wrong/missing greeting: attempt a consensus auto-repair (>=3 evidence
                    # sources must agree on the real first name), then require BOTH agents to
                    # confirm. If consensus is weak, fall through to the normal single-agent
                    # gate, which leaves it for human review.
                    repaired_name = False
                    if not deterministic_ok:
                        corrected_first_name = derive_consensus_first_name(name_evidence, min_sources=3)
                        if corrected_first_name and (
                            normalize_first_name_for_verification(corrected_first_name)
                            != normalize_first_name_for_verification(greeting_first_name)
                        ):
                            repaired_body = apply_email_greeting(draft_body, corrected_first_name)
                            if repaired_body != draft_body and update_gmail_draft_body_text(
                                gmail_service, draft=draft, body_text=repaired_body
                            ):
                                draft_body = repaired_body
                                can_send_existing_draft = True
                                repaired_name = True
                                print(
                                    "Reject draft greeting auto-repaired by consensus: "
                                    f"{candidate_name} <{candidate_email}> -> 'Hi {corrected_first_name}'"
                                )
                                deterministic_ok, greeting_first_name, deterministic_reason = run_rejection_name_verification_agent(
                                    draft_body=draft_body,
                                    evidence=name_evidence,
                                )
                    if repaired_name:
                        consensus_ok, subagent_reason = call_rejection_name_verifier_consensus(
                            config,
                            candidate_name=candidate_name,
                            candidate_email=candidate_email,
                            greeting_first_name=greeting_first_name,
                            evidence=name_evidence,
                            deterministic_allowed=deterministic_ok,
                            deterministic_reason=deterministic_reason,
                        )
                        name_ok = deterministic_ok and consensus_ok
                        subagent_reason = f"auto-repaired greeting; {subagent_reason}"
                    else:
                        subagent_ok, subagent_reason = call_rejection_name_verifier_subagent(
                            config,
                            candidate_name=candidate_name,
                            candidate_email=candidate_email,
                            greeting_first_name=greeting_first_name,
                            evidence=name_evidence,
                            deterministic_allowed=deterministic_ok,
                            deterministic_reason=deterministic_reason,
                        )
                        name_ok = subagent_ok
                    if not name_ok:
                        reject_drafts_auto_send_skipped_name += 1
                        failure_reason = (
                            f"deterministic={deterministic_reason}; subagent={subagent_reason}"
                        )
                        notify_rejection_name_verification_failure(
                            config,
                            draft_id=reject_draft_id,
                            candidate_name=candidate_name,
                            candidate_email=candidate_email,
                            greeting_first_name=greeting_first_name,
                            evidence_summary=summarize_name_evidence(name_evidence),
                            subagent_reason=failure_reason,
                            notion_url=candidate_notion_url,
                        )
                        print(
                            "Reject draft auto-send skipped (first-name mismatch): "
                            f"{candidate_name} <{candidate_email}> draft='{greeting_first_name}' "
                            f"reason='{failure_reason}'"
                        )
                        if prop.status in properties_schema:
                            update_payload[prop.status] = build_notion_value(
                                properties_schema[prop.status], STATUS_NEEDS_ATTENTION
                            )
                    else:
                        if can_send_existing_draft:
                            sent_message_id = send_gmail_draft(gmail_service, reject_draft_id)
                        else:
                            sent_message_id = send_reply_email(
                                gmail_service,
                                sender_email=config.from_email,
                                to_email=candidate_email,
                                thread_id=reply_thread_id,
                                body_text=draft_body,
                            )
                        if sent_message_id:
                            reject_drafts_auto_sent += 1
                            current_status = "rejected"
                            if prop.status in properties_schema:
                                update_payload[prop.status] = build_notion_value(
                                    properties_schema[prop.status], STATUS_REJECTED
                                )
                            if prop.reject_draft_id in properties_schema:
                                update_payload[prop.reject_draft_id] = build_notion_value(
                                    properties_schema[prop.reject_draft_id], ""
                                )
                            if prop.reject_send_at in properties_schema:
                                update_payload[prop.reject_send_at] = build_notion_value(
                                    properties_schema[prop.reject_send_at], ""
                                )
                            archive_labels = [hiring_label_id]
                            if pipeline_label_id:
                                archive_labels.append(pipeline_label_id)
                            archived_count, archive_failures = remove_labels_from_threads(
                                gmail_service,
                                thread_ids=related_thread_ids,
                                label_ids=archive_labels,
                            )
                            reject_threads_archived += archived_count
                            reject_archive_failures += archive_failures
                        else:
                            verified_sent_at = thread_latest_manual_rejection_sent_at_any_thread(
                                gmail_service,
                                thread_ids=related_thread_ids,
                                sender_email=config.from_email,
                                candidate_email=candidate_email,
                            )
                            sent_after_draft = bool(
                                verified_sent_at
                                and draft_created_at
                                and verified_sent_at >= draft_created_at - timedelta(minutes=5)
                            )
                            if sent_after_draft:
                                reject_drafts_auto_sent += 1
                                current_status = "rejected"
                                if prop.status in properties_schema:
                                    update_payload[prop.status] = build_notion_value(
                                        properties_schema[prop.status], STATUS_REJECTED
                                    )
                                if prop.reject_draft_id in properties_schema:
                                    update_payload[prop.reject_draft_id] = build_notion_value(
                                        properties_schema[prop.reject_draft_id], ""
                                    )
                                if prop.reject_send_at in properties_schema:
                                    update_payload[prop.reject_send_at] = build_notion_value(
                                        properties_schema[prop.reject_send_at], ""
                                    )
                                archive_labels = [hiring_label_id]
                                if pipeline_label_id:
                                    archive_labels.append(pipeline_label_id)
                                archived_count, archive_failures = remove_labels_from_threads(
                                    gmail_service,
                                    thread_ids=related_thread_ids,
                                    label_ids=archive_labels,
                                )
                                reject_threads_archived += archived_count
                                reject_archive_failures += archive_failures
                            else:
                                reject_drafts_auto_send_skipped_missing += 1
                                notify_rejection_draft_issue(
                                    config,
                                    draft_id=reject_draft_id,
                                    issue_key="draft_send_failed",
                                    heading="Rejection draft send failed. Auto-send skipped.",
                                    candidate_name=candidate_name,
                                    candidate_email=candidate_email,
                                    details=[
                                        "*Reason:* Gmail did not return a sent message ID, and no matching sent rejection email was found after the draft timestamp.",
                                    ],
                                    notion_url=candidate_notion_url,
                                )
            elif not reject_send_at:
                reject_send_at = decision_time + timedelta(hours=config.reject_delay_hours)
                reject_scheduled += 1
                if prop.reject_send_at in properties_schema:
                    update_payload[prop.reject_send_at] = build_notion_value(
                        properties_schema[prop.reject_send_at], iso(reject_send_at)
                    )
                if prop.status in properties_schema:
                    update_payload.pop(prop.status, None)
            elif now >= reject_send_at and not reject_draft_id:
                draft_id = create_reply_draft(
                    gmail_service,
                    sender_email=config.from_email,
                    to_email=candidate_email,
                    thread_id=reply_thread_id,
                    body_text=config.reject_template,
                )
                reject_drafts += 1
                if prop.reject_draft_id in properties_schema:
                    update_payload[prop.reject_draft_id] = build_notion_value(
                        properties_schema[prop.reject_draft_id], draft_id
                    )
                if prop.status in properties_schema:
                    update_payload.pop(prop.status, None)
            if current_status != "rejected" and not in_pipeline:
                # Mark as rejected once an outbound email is actually sent after the reject decision.
                # This works for both generated drafts and manual sends.
                sent_anchor = status_lookback_anchor
                if decision_time and decision_time > sent_anchor:
                    sent_anchor = decision_time
                if sent_anchor and sender_sent_since_any_thread(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    sender_email=config.from_email,
                    since=sent_anchor,
                    to_email=candidate_email,
                ):
                    reject_marked_sent += 1
                    if prop.status in properties_schema:
                        update_payload[prop.status] = build_notion_value(
                            properties_schema[prop.status], STATUS_REJECTED
                        )
                    archive_labels = [hiring_label_id]
                    if pipeline_label_id:
                        archive_labels.append(pipeline_label_id)
                    archived_count, archive_failures = remove_labels_from_threads(
                        gmail_service,
                        thread_ids=related_thread_ids,
                        label_ids=archive_labels,
                    )
                    reject_threads_archived += archived_count
                    reject_archive_failures += archive_failures

        if update_payload:
            notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})

        effective_status = current_status
        status_update = update_payload.get(prop.status)
        if isinstance(status_update, dict):
            status_payload = status_update.get("status") or status_update.get("select")
            if isinstance(status_payload, dict):
                status_name = clean_text(status_payload.get("name", ""))
                if status_name:
                    effective_status = status_key(status_name)

        if (
            hiring_label_id
            and status_key(effective_status) not in {"round 1 scheduling", "scheduling sent"}
            and any_thread_has_label(
                gmail_service,
                thread_ids=related_thread_ids,
                label_id=hiring_label_id,
            )
        ):
            archived_count, archive_failures = remove_labels_from_threads(
                gmail_service,
                thread_ids=related_thread_ids,
                label_ids=[hiring_label_id],
            )
            non_scheduling_threads_archived += archived_count
            non_scheduling_archive_failures += archive_failures

    print(f"Proceed drafts created: {proceed_drafts}")
    print(f"Proceed drafts auto-sent: {proceed_drafts_auto_sent}")
    print(f"Proceed drafts auto-send skipped (missing draft): {proceed_drafts_auto_send_skipped_missing}")
    print(f"Reject schedules initialized: {reject_scheduled}")
    print(f"Reject drafts created: {reject_drafts}")
    print(f"Reject drafts auto-sent: {reject_drafts_auto_sent}")
    print(f"Reject drafts auto-send skipped (younger than threshold): {reject_drafts_auto_send_skipped_young}")
    print(f"Reject drafts auto-send skipped (first-name mismatch): {reject_drafts_auto_send_skipped_name}")
    print(f"Reject drafts auto-send skipped (missing draft): {reject_drafts_auto_send_skipped_missing}")
    print(f"Reject records marked sent: {reject_marked_sent}")
    print(f"Manual rejection sends auto-marked: {manual_reject_marked}")
    print(f"Rejected threads archived from ATS labels: {reject_threads_archived}")
    print(f"Rejected thread archive failures: {reject_archive_failures}")
    print(f"Sent draft threads auto-archived: {sent_draft_threads_archived}")
    print(f"Sent draft thread archive failures: {sent_draft_archive_failures}")
    print(f"Non-scheduling ATS threads archived from hiring label: {non_scheduling_threads_archived}")
    print(f"Non-scheduling ATS thread archive failures: {non_scheduling_archive_failures}")
    print(f"In Process records marked from pipeline label: {in_process_marked}")
    daily_review_posts, daily_review_candidate_count = post_scheduled_ats_follow_up_if_enabled(
        config,
        notion,
        database_schema,
        prop,
    )
    print(f"No response drafts created: {no_response_drafts}")
    print(f"No response closeouts sent: {no_response_closeouts_sent}")
    print(f"CustomGPT no-response closeouts sent: {custom_gpt_no_response_sent}")
    print(f"CustomGPT no-response closeouts skipped (younger than threshold): {custom_gpt_no_response_skipped_young}")
    print(f"CustomGPT no-response closeout send failures: {custom_gpt_no_response_send_failures}")
    print(f"Daily ATS follow-up posts created: {daily_review_posts}")
    print(f"Daily ATS follow-up candidates included: {daily_review_candidate_count}")
    print(f"Scheduling drafts created: {scheduling_drafts}")


def close_stale_custom_gpt_cmd(args: argparse.Namespace) -> None:
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    database_schema = notion.get_database()
    properties_schema = database_schema.get("properties", {})
    prop = resolve_property_map(config.property_map, database_schema)

    gmail_service = ensure_google_service(
        api_name="gmail",
        api_version="v1",
        scopes=GMAIL_SCOPES,
        credentials_env="GOOGLE_GMAIL_CREDENTIALS_FILE",
        credentials_default="secrets/google-gmail-credentials.json",
        token_env="GOOGLE_GMAIL_TOKEN_FILE",
        token_default="secrets/google-gmail-token.json",
        help_text="Set GOOGLE_GMAIL_CREDENTIALS_FILE or place Gmail OAuth credentials in secrets/.",
    )
    pages = notion.query_pages({"page_size": 100})
    dry_run = not args.send
    business_days = max(int(args.business_days), 0)
    now = now_local(config.timezone_name)
    now_utc = now.astimezone(timezone.utc)
    message_template = args.message or DEFAULT_CUSTOM_GPT_NO_RESPONSE_REJECTION_TEMPLATE

    title_prop_name = resolve_title_property_name(properties_schema, prop.candidate_name)
    hiring_label_id = ""
    if config.gmail_label_name:
        try:
            hiring_label_id = gmail_label_id(gmail_service, config.gmail_label_name)
        except Exception:
            hiring_label_id = ""
    pipeline_label_id = ""
    if config.pipeline_label_name:
        try:
            pipeline_label_id = gmail_label_id(gmail_service, config.pipeline_label_name)
        except Exception:
            pipeline_label_id = ""

    internal_domains = {email_domain(config.from_email)}
    if config.hiring_alias:
        internal_domains.add(email_domain(config.hiring_alias))
    internal_domains.discard("")

    scanned = 0
    eligible: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    sent = 0
    updated = 0
    failures: list[str] = []

    for page in pages:
        page_props = page.get("properties", {})
        current_status = notion_prop_value(page_props.get(prop.status, {})).strip()
        if status_key(current_status) != "waiting on customgpt":
            continue
        scanned += 1

        candidate_name = notion_prop_value(page_props.get(title_prop_name, {})).strip() or "Candidate"
        candidate_email = notion_prop_value(page_props.get(prop.email, {})).strip()
        thread_id = notion_prop_value(page_props.get(prop.gmail_thread_id, {})).strip()
        if not candidate_email or not thread_id:
            skipped["missing_email_or_thread"] += 1
            continue

        related_thread_ids = candidate_related_thread_ids(
            gmail_service,
            candidate_email=candidate_email,
            primary_thread_id=thread_id,
            internal_domains=internal_domains,
            hiring_label_id=hiring_label_id,
        )
        reply_thread_id = preferred_reply_thread_id(
            gmail_service,
            thread_ids=related_thread_ids,
            fallback_thread_id=thread_id,
        )
        assignment_sent_at = thread_latest_assignment_sent_at_any_thread(
            gmail_service,
            thread_ids=related_thread_ids,
            sender_email=config.from_email,
            keywords=config.assignment_keywords,
        )
        if not assignment_sent_at:
            skipped["no_assignment_sent_match"] += 1
            continue

        due_at = add_business_days(assignment_sent_at, business_days, config.timezone_name)
        if now_utc <= due_at:
            skipped["not_past_business_day_threshold"] += 1
            continue

        reply_dt, _reply_text = latest_candidate_message_since_any_thread(
            gmail_service,
            thread_ids=related_thread_ids,
            candidate_email=candidate_email,
            since=assignment_sent_at,
        )
        if reply_dt:
            skipped["candidate_replied_after_assignment"] += 1
            continue

        first_name = extract_first_name(candidate_name, candidate_email)
        body = render_no_response_template(message_template, first_name)
        item = {
            "page_id": page.get("id", ""),
            "candidate_name": candidate_name,
            "candidate_email": candidate_email,
            "thread_id": thread_id,
            "reply_thread_id": reply_thread_id,
            "assignment_sent_at": assignment_sent_at.isoformat(),
            "due_at": due_at.isoformat(),
            "notion_url": notion_page_url(page.get("id", "")),
        }
        eligible.append(item)

        if dry_run:
            continue

        try:
            message_id = send_reply_email(
                gmail_service,
                sender_email=config.from_email,
                to_email=candidate_email,
                thread_id=reply_thread_id,
                body_text=body,
            )
            if not message_id:
                raise RuntimeError("Gmail send returned no message id")
            sent += 1
            update_payload: dict[str, Any] = {}
            if prop.status in properties_schema:
                update_payload[prop.status] = build_notion_value(properties_schema[prop.status], STATUS_NO_RESPONSE)
            if prop.decision in properties_schema:
                update_payload[prop.decision] = build_notion_value(properties_schema[prop.decision], "Reject")
            if prop.decision_time in properties_schema:
                update_payload[prop.decision_time] = build_notion_value(properties_schema[prop.decision_time], iso(now))
            if prop.reject_draft_id in properties_schema:
                update_payload[prop.reject_draft_id] = build_notion_value(properties_schema[prop.reject_draft_id], "")
            if prop.reject_send_at in properties_schema:
                update_payload[prop.reject_send_at] = build_notion_value(properties_schema[prop.reject_send_at], "")
            if update_payload:
                notion.update_page(page["id"], {k: v for k, v in update_payload.items() if v is not None})
                updated += 1
            closeout_labels = [label_id for label_id in (hiring_label_id, pipeline_label_id) if label_id]
            if closeout_labels:
                remove_labels_from_threads(
                    gmail_service,
                    thread_ids=related_thread_ids,
                    label_ids=closeout_labels,
                )
        except Exception as exc:
            failures.append(f"{candidate_name} <{candidate_email}>: {exc}")

    print(json.dumps({
        "dry_run": dry_run,
        "business_days": business_days,
        "scanned_in_custom_gpt_process": scanned,
        "eligible_count": len(eligible),
        "sent": sent,
        "notion_updated": updated,
        "skipped": dict(skipped),
        "failures": failures,
        "eligible": eligible,
    }, indent=2))
    if failures:
        raise SystemExit(1)


def sync_slack_decisions_cmd(_args: argparse.Namespace) -> None:
    config = load_config()
    if not slack_enabled(config):
        print("Slack decision sync skipped: missing Slack token or review channel config.")
        return

    notion = NotionClient(config.notion_token, config.notion_database_id)
    database_schema = notion.get_database()
    try:
        (
            updated,
            skipped_missing,
            skipped_locked,
            skipped_unchanged,
            forwards_sent,
            forwards_skipped_missing,
            forwards_skipped_existing,
        ) = sync_slack_decisions(
            config, notion, database_schema
        )
    except Exception as exc:
        print(f"Slack decision sync failed (continuing): {exc}")
        return

    print(f"Slack decisions applied: {updated}")
    print(f"Slack decisions skipped (no matching Notion thread): {skipped_missing}")
    print(f"Slack decisions skipped (Notion already decided): {skipped_locked}")
    print(f"Slack decisions skipped (unchanged): {skipped_unchanged}")
    print(f"Tenn forwards sent: {forwards_sent}")
    print(f"Tenn forwards skipped (no matching Notion thread): {forwards_skipped_missing}")
    print(f"Tenn forwards skipped (already sent): {forwards_skipped_existing}")


def post_ats_follow_up_test_cmd(_args: argparse.Namespace) -> None:
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    database_schema = notion.get_database()
    prop = resolve_property_map(config.property_map, database_schema)
    posts, candidates = post_weekly_active_candidates_digest(
        config,
        notion,
        database_schema,
        prop,
        force=True,
        record_slot=False,
        heading="Test ATS follow-up",
    )
    print(f"Test ATS follow-up posts created: {posts}")
    print(f"Test ATS follow-up candidates included: {candidates}")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reconcile_slack_reviews_cmd(args: argparse.Namespace) -> None:
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    schema = notion.get_database()
    prop = resolve_property_map(config.property_map, schema)
    result = reconcile_slack_reviews(config, notion, schema, prop, apply=bool(args.apply))
    print(json.dumps(result, indent=2, sort_keys=True))


def classify_superposition_evidence(text: str, actor: str = "unknown") -> tuple[str, str, str]:
    cleaned = clean_text(text)
    lower = cleaned.lower()
    rules = (
        ("candidate", r"\b(withdraw|withdrawing|no longer interested|decline the opportunity|must pass)\b", "Passed", "candidate_withdrawal"),
        ("company", r"\b(will not be moving forward|won't be moving forward|not moving forward|decided not to proceed)\b", "Rejected", "company_rejection"),
        ("any", r"\b(schedule|scheduling|calendar|calendly|book(?:ed|ing)?|availability|times? work)\b", "Round 1 Scheduling", "active_scheduling"),
        ("any", r"\b(follow up|following up|checking in|next step|still interested|haven't heard)\b", "Needs Attention", "stalled_or_ambiguous"),
    )
    for required_actor, pattern, status, rule in rules:
        if required_actor not in {"any", actor}:
            continue
        if re.search(pattern, lower, re.IGNORECASE):
            return status, rule, f"Matched {rule.replace('_', ' ')} evidence"
    return "", "manual_review", "No unambiguous status rule matched"


def audit_superposition_statuses_cmd(args: argparse.Namespace) -> None:
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    schema = notion.get_database()
    prop = resolve_property_map(config.property_map, schema)
    gmail = ensure_google_service(
        api_name="gmail", api_version="v1", scopes=GMAIL_SCOPES,
        credentials_env="GOOGLE_GMAIL_CREDENTIALS_FILE",
        credentials_default="secrets/google-gmail-credentials.json",
        token_env="GOOGLE_GMAIL_TOKEN_FILE", token_default="secrets/google-gmail-token.json",
        help_text="Set project-scoped Gmail OAuth credentials.",
    )
    rows: list[dict[str, Any]] = []
    verified_company_senders = {normalize_email(config.from_email), normalize_email(config.hiring_alias)}
    verified_company_senders.update(normalize_email(item) for item in config.recruiter_sender_emails)
    verified_company_senders.discard("")
    for page in notion.query_pages({"page_size": 100}):
        props = page.get("properties", {})
        if not is_superposition_source(notion_prop_value(props.get(prop.source, {}))):
            continue
        thread_id = notion_prop_value(props.get(prop.gmail_thread_id, {})).strip()
        current = notion_prop_value(props.get(prop.status, {})).strip()
        if status_key(current) != "awaiting decision":
            continue
        candidate_email = normalize_email(notion_prop_value(props.get(prop.email, {})))
        evidence_at = ""
        evidence_ref = ""
        proposed = rule = reason = ""
        evidence: list[tuple[str, str, str, str, str]] = []
        if thread_id:
            thread = gmail.users().threads().get(userId="me", id=thread_id, format="full").execute()
            for message in sorted_thread_messages(thread):
                body = extract_message_body_text(message)
                quote = EMAIL_QUOTE_START_RE.search(body)
                unquoted = body[: quote.start()] if quote else body
                sender = normalize_email(parseaddr(header_map(message).get("from", ""))[1])
                actor = (
                    "candidate" if sender and candidate_email and sender == candidate_email
                    else "company" if sender in verified_company_senders
                    else "unknown"
                )
                status, matched, why = classify_superposition_evidence(unquoted, actor)
                if status:
                    dt = message_internal_datetime(message)
                    evidence.append((status, matched, why, iso(dt) if dt else "", str(message.get("id", "") or "")))
        statuses = {item[0] for item in evidence}
        if len(statuses) == 1:
            proposed, rule, reason, evidence_at, evidence_ref = evidence[-1]
        elif len(statuses) > 1:
            proposed, rule, reason = "", "manual_review_conflict", "Conflicting unquoted evidence matched multiple status rules"
        rows.append({
            "row_id": str(page.get("id", "") or ""), "gmail_thread_id": thread_id,
            "current_status": current, "proposed_status": proposed,
            "evidence_timestamp": evidence_at, "evidence_reference": evidence_ref,
            "matched_rule": rule or "manual_review", "reason": reason or "Missing Gmail evidence",
        })
    artifact = {"version": 1, "generated_at": iso(datetime.now(timezone.utc)), "rows": rows}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "sha256": sha256_file(output), "rows": len(rows)}, indent=2))


def apply_superposition_statuses_cmd(args: argparse.Namespace) -> None:
    path = Path(args.artifact)
    actual = sha256_file(path)
    if actual.lower() != args.sha256.lower():
        raise RuntimeError(f"Artifact SHA-256 mismatch: expected {args.sha256}, got {actual}")
    artifact = json.loads(path.read_text(encoding="utf-8"))
    if artifact.get("version") != 1 or not isinstance(artifact.get("rows"), list):
        raise RuntimeError("Unsupported Superposition audit artifact")
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    schema = notion.get_database()
    prop = resolve_property_map(config.property_map, schema)
    status_schema = schema.get("properties", {}).get(prop.status, {})
    allowed_statuses = {"Passed", "Rejected", "Round 1 Scheduling", "Needs Attention"}
    row_ids = [str(row.get("row_id", "") or "").strip() for row in artifact["rows"]]
    if any(not row_id for row_id in row_ids) or len(set(row_ids)) != len(row_ids):
        raise RuntimeError("Artifact row IDs must be non-empty and unique")
    planned: list[tuple[str, str, dict[str, Any]]] = []
    for row in artifact["rows"]:
        proposed = str(row.get("proposed_status", "") or "").strip()
        if proposed and proposed not in allowed_statuses:
            raise RuntimeError(f"Disallowed proposed status for row {row.get('row_id')}: {proposed}")
        if not proposed or proposed == str(row.get("current_status", "") or "").strip():
            continue
        live_page = notion.get_page(str(row["row_id"]))
        live_props = live_page.get("properties", {})
        live_source = notion_prop_value(live_props.get(prop.source, {})).strip()
        live_status = notion_prop_value(live_props.get(prop.status, {})).strip()
        if not is_superposition_source(live_source):
            raise RuntimeError(f"Row {row['row_id']} is no longer Superposition")
        if live_status != str(row.get("current_status", "") or "").strip():
            raise RuntimeError(
                f"Row {row['row_id']} status changed since preview: expected {row.get('current_status')}, got {live_status}"
            )
        built = build_notion_value(status_schema, proposed)
        if built is None:
            raise RuntimeError(f"Cannot build status value for row {row.get('row_id')}")
        planned.append((str(row["row_id"]), proposed, built))

    changed: list[str] = []
    for row_id, proposed, built in planned:
        notion.update_page(row_id, {prop.status: built})
        readback = notion.get_page(row_id)
        readback_status = notion_prop_value(readback.get("properties", {}).get(prop.status, {})).strip()
        if readback_status != proposed:
            raise RuntimeError(f"Status readback failed for row {row_id}: got {readback_status}")
        changed.append(row_id)
    print(json.dumps({"artifact_sha256": actual, "changed_row_ids": changed}, indent=2))


def post_awaiting_digest_cmd(args: argparse.Namespace) -> None:
    path = Path(args.artifact)
    artifact = json.loads(path.read_text(encoding="utf-8"))
    items = artifact.get("items", [])
    if not isinstance(items, list) or not items:
        raise RuntimeError("Digest artifact must contain a non-empty items list")
    config = load_config()
    client = slack_post_client(config)
    channel_id = client.resolve_channel_id(config.slack_review_channel)
    marker = f"ATS_AWAITING_DIGEST_RUN_ID:{args.run_id}"
    if any(marker in str(message.get("text", "") or "") for message in client.list_channel_messages(channel_id, 1.0)):
        print(json.dumps({"posted": False, "reason": "already_posted", "run_id": args.run_id}))
        return
    lines = [f"*Awaiting candidate reviews*  {marker}"]
    for item in items:
        name = clean_text(str(item.get("candidate_name", "") or ""))
        url = str(item.get("slack_review_url", "") or "").strip()
        thread_id = str(item.get("thread_id", "") or "").strip()
        if not name or not url or not thread_id:
            raise RuntimeError("Every digest item requires candidate_name, thread_id, and slack_review_url")
        lines.append(f"• <{url}|{name}> — `{slack_thread_marker(thread_id)}`")
    text = "\n".join(lines)
    response = client.post_message(channel_id, text, [{"type": "section", "text": {"type": "mrkdwn", "text": text}}])
    permalink = client.get_message_permalink(channel_id, str(response.get("ts", "") or ""))
    print(json.dumps({"posted": True, "run_id": args.run_id, "count": len(items), "permalink": permalink}, indent=2))


def run_cmd(_args: argparse.Namespace) -> None:
    failures: list[str] = []
    for step_name, step_func in (
        ("ingest", ingest_cmd),
        ("sync-slack-decisions", sync_slack_decisions_cmd),
        ("process-decisions", process_decisions_cmd),
    ):
        try:
            step_func(_args)
        except Exception as exc:
            failures.append(f"{step_name}: {exc.__class__.__name__}")
            print(f"{step_name} failed (continuing): {exc}")
    if failures:
        raise RuntimeError("Recruiting run completed with step failures: " + "; ".join(failures))


def auth_cmd(_args: argparse.Namespace) -> None:
    load_config()
    ensure_google_service(
        api_name="gmail",
        api_version="v1",
        scopes=GMAIL_SCOPES,
        credentials_env="GOOGLE_GMAIL_CREDENTIALS_FILE",
        credentials_default="secrets/google-gmail-credentials.json",
        token_env="GOOGLE_GMAIL_TOKEN_FILE",
        token_default="secrets/google-gmail-token.json",
        help_text="Set GOOGLE_GMAIL_CREDENTIALS_FILE or place Gmail OAuth credentials in secrets/.",
    )
    ensure_google_service(
        api_name="drive",
        api_version="v3",
        scopes=DRIVE_SCOPES,
        credentials_env="GOOGLE_DRIVE_CREDENTIALS_FILE",
        credentials_default="secrets/google-drive-credentials.json",
        token_env="GOOGLE_DRIVE_TOKEN_FILE",
        token_default="secrets/google-drive-token.json",
        help_text="Set GOOGLE_DRIVE_CREDENTIALS_FILE or place Drive OAuth credentials in secrets/.",
    )
    ensure_google_service(
        api_name="calendar",
        api_version="v3",
        scopes=CALENDAR_SCOPES,
        credentials_env="GOOGLE_CALENDAR_CREDENTIALS_FILE",
        credentials_default="secrets/google-calendar-credentials.json",
        token_env="GOOGLE_CALENDAR_TOKEN_FILE",
        token_default="secrets/google-calendar-token.json",
        help_text="Set GOOGLE_CALENDAR_CREDENTIALS_FILE or place Calendar OAuth credentials in secrets/.",
    )
    print("Google auth verified for Gmail, Drive, and Calendar.")
    print("Notion credentials detected.")


def schema_check_cmd(_args: argparse.Namespace) -> None:
    config = load_config()
    notion = NotionClient(config.notion_token, config.notion_database_id)
    db = notion.get_database()
    properties = db.get("properties", {})
    prop_map = resolve_property_map(config.property_map, db)
    title_prop_name = resolve_title_property_name(properties, prop_map.candidate_name)
    required = [
        title_prop_name,
        prop_map.email,
        prop_map.source,
        prop_map.role,
        prop_map.resume_url,
        prop_map.career_stage,
        prop_map.linkedin_url,
        prop_map.linkedin_confidence,
        prop_map.company,
        prop_map.current_title,
        prop_map.location,
        prop_map.date_first_entered,
        prop_map.decision,
        prop_map.decision_time,
        prop_map.reject_send_at,
        prop_map.proceed_draft_id,
        prop_map.reject_draft_id,
        prop_map.gmail_thread_id,
        prop_map.status,
        prop_map.scheduling_draft_id,
        prop_map.proposed_slot,
        prop_map.last_sync_at,
        prop_map.slack_review_url,
    ]

    missing = [name for name in required if name not in properties]
    if missing:
        print("Missing Notion properties:")
        for item in missing:
            print(f"- {item}")
        raise SystemExit(1)

    print("Notion schema check passed.")


def dump_config_cmd(_args: argparse.Namespace) -> None:
    config = load_config()
    payload = {
        "gmail_label": config.gmail_label_name,
        "gmail_query": config.gmail_query,
        "gmail_max_messages": config.gmail_max_messages,
        "recruiter_sender_emails": sorted(config.recruiter_sender_emails),
        "recruiter_sender_names": sorted(config.recruiter_sender_names),
        "from_email": config.from_email,
        "drive_folder_id_configured": bool(config.drive_folder_id),
        "slack_enabled": slack_enabled(config),
        "slack_post_enabled": slack_post_enabled(config),
        "slack_review_channel": config.slack_review_channel,
        "slack_mention_user_configured": bool(config.slack_mention_user_id),
        "slack_history_lookback_days": config.slack_history_lookback_days,
        "slack_allow_decision_override": config.slack_allow_decision_override,
        "ats_follow_up_enabled": config.ats_follow_up_enabled,
        "slack_proceed_reactions": sorted(config.slack_proceed_reactions),
        "slack_reject_reactions": sorted(config.slack_reject_reactions),
        "slack_forward_reactions": sorted(config.slack_forward_reactions),
        "ats_follow_up_weekdays": sorted(ATS_FOLLOW_UP_WEEKDAYS.values()),
        "ats_follow_up_hour": ATS_FOLLOW_UP_HOUR,
        "ats_follow_up_excluded_statuses": sorted(ATS_DIGEST_EXCLUDED_STATUSES),
        "forward_to_email": config.forward_to_email,
        "reject_delay_hours": config.reject_delay_hours,
        "reject_draft_auto_send_age_hours": config.reject_draft_auto_send_age_hours,
        "name_verifier_provider": config.name_verifier_provider,
        "name_verifier_model": config.name_verifier_model,
        "name_verifier_configured": bool(
            config.anthropic_api_key if config.name_verifier_provider != "openai" else config.openai_api_key
        ),
        "resume_extractor_provider": config.resume_extractor_provider,
        "resume_extractor_model": config.resume_extractor_model,
        "resume_extractor_configured": bool(
            config.openai_api_key if config.resume_extractor_provider == "openai" else False
        ),
        "no_response_wait_business_days": config.no_response_wait_business_days,
        "custom_gpt_no_response_wait_hours": config.custom_gpt_no_response_wait_hours,
        "assignment_keywords": sorted(config.assignment_keywords),
        "sent_status_lookback_days": config.sent_status_lookback_days,
        "pipeline_label_name": config.pipeline_label_name,
        "timezone": config.timezone_name,
        "slot_minutes": config.slot_minutes,
        "buffer_minutes": config.buffer_minutes,
        "min_notice_hours": config.min_notice_hours,
        "lookahead_days": config.lookahead_days,
        "weekdays": sorted(config.weekdays),
        "daily_start": config.daily_start.strftime("%H:%M"),
        "daily_end": config.daily_end.strftime("%H:%M"),
        "calendar_id": config.calendar_id,
    }
    print(json.dumps(payload, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Notion ATS recruiting coordinator")
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth_parser = subparsers.add_parser("auth", help="Verify OAuth and Notion credentials")
    auth_parser.set_defaults(func=auth_cmd)

    schema_parser = subparsers.add_parser("schema-check", help="Validate Notion ATS schema")
    schema_parser.set_defaults(func=schema_check_cmd)

    config_parser = subparsers.add_parser("dump-config", help="Print resolved runtime config")
    config_parser.set_defaults(func=dump_config_cmd)

    ingest_parser = subparsers.add_parser(
        "ingest",
        help="Ingest hiring@ Gmail threads using subject format 'ROLE - CANDIDATE NAME'",
    )
    ingest_parser.set_defaults(func=ingest_cmd)

    decisions_parser = subparsers.add_parser(
        "process-decisions",
        help="Create draft-only proceed/reject/scheduling actions from Notion decisions",
    )
    decisions_parser.set_defaults(func=process_decisions_cmd)

    slack_sync_parser = subparsers.add_parser(
        "sync-slack-decisions",
        help="Sync Proceed/Reject decisions from Slack reactions into Notion",
    )
    slack_sync_parser.set_defaults(func=sync_slack_decisions_cmd)

    follow_up_test_parser = subparsers.add_parser(
        "post-ats-follow-up-test",
        help="Post the non-terminal ATS Slack digest immediately without consuming a scheduled slot",
    )
    follow_up_test_parser.set_defaults(func=post_ats_follow_up_test_cmd)

    reconcile_parser = subparsers.add_parser(
        "reconcile-slack-reviews", help="Preview or apply durable ATS-to-Slack review reconciliation"
    )
    reconcile_mode = reconcile_parser.add_mutually_exclusive_group(required=True)
    reconcile_mode.add_argument("--dry-run", action="store_true")
    reconcile_mode.add_argument("--apply", action="store_true")
    reconcile_parser.set_defaults(func=reconcile_slack_reviews_cmd)

    audit_superposition_parser = subparsers.add_parser(
        "audit-superposition-statuses", help="Write a Gmail-evidence status preview artifact"
    )
    audit_superposition_parser.add_argument("--output", required=True)
    audit_superposition_parser.set_defaults(func=audit_superposition_statuses_cmd)

    apply_superposition_parser = subparsers.add_parser(
        "apply-superposition-statuses", help="Apply a hash-approved Superposition status artifact"
    )
    apply_superposition_parser.add_argument("--artifact", required=True)
    apply_superposition_parser.add_argument("--sha256", required=True)
    apply_superposition_parser.set_defaults(func=apply_superposition_statuses_cmd)

    digest_parser = subparsers.add_parser(
        "post-awaiting-digest", help="Post an idempotent digest from an approved candidate/post artifact"
    )
    digest_parser.add_argument("--artifact", required=True)
    digest_parser.add_argument("--run-id", required=True)
    digest_parser.set_defaults(func=post_awaiting_digest_cmd)

    close_custom_gpt_parser = subparsers.add_parser(
        "close-stale-custom-gpt",
        help="Close CustomGPT candidates with no reply after a business-day threshold. Defaults to dry run.",
    )
    close_custom_gpt_parser.add_argument(
        "--business-days",
        type=int,
        default=7,
        help="Business days to wait after the CustomGPT assignment was sent. Default: 7.",
    )
    close_custom_gpt_parser.add_argument(
        "--send",
        action="store_true",
        help="Actually send the closeout email and mark eligible candidates No response. Omit for dry run.",
    )
    close_custom_gpt_parser.add_argument(
        "--message",
        default="",
        help="Optional closeout message template. Supports {{first name}} or {first_name}.",
    )
    close_custom_gpt_parser.set_defaults(func=close_stale_custom_gpt_cmd)

    run_parser = subparsers.add_parser(
        "run",
        help="Run ingest, sync Slack decisions, then process-decisions",
    )
    run_parser.set_defaults(func=run_cmd)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except (RuntimeError, ValueError, FileNotFoundError, KeyError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
