"""스킬 · Agent 등록: natural-language agents on a schedule, an inbox, and GPU trials of open-weight models.

The API is /api/agents (app.py routes, Cognito user). The other modes are actions of the same Lambda: ``agents_run``
(EventBridge Scheduler per agent, or "run now" as a self-invoke), ``agents_launch`` (테스트 starts the trial box in a
self-invoke: a capacity miss in every AZ outlasts CloudFront's 60 s) and ``agents_sweep`` (every 5 minutes: trial
progress from the box's S3 status files, timeouts, the benchmark baselines, the demo user's built-in scout).

The built-in 오픈웨이트 모델 스카우트 reads the Hugging Face Hub API, keeps open-licensed, recent, runnable models
that are not a baseline and were never proposed, and lets one Bedrock call rank them against the baselines. A
proposal's lifecycle: proposed -> 테스트 (a self-terminating g6e box runs trial_agent.py and renders the benchmark)
-> testing -> passed | failed -> 승인 (passed only: the parked box joins the fleet and is tagged
mediagen-promoted=true, LAST) -> promoted. 거절 = dismissed. The videogen MCP finds promoted boxes by those tags, so
a promoted model is usable from the next request on; it never becomes a default.

Items (main table):
  AGENT#<sub>      / <agentId>   agent
  AGENTNOTE#<sub>  / <noteId>    inbox note (ids sort by time)
  AGENTPROP#<sub>  / <propId>    proposal
  AGENTTRIAL       / <trialId>   GPU trial (global: the sweep reads one partition; one trial runs at a time)
  AGENTLOCK        / trial       {trialId} while a trial box is starting or running
  AGENTBASE        / <mode#hash> one baseline output for one benchmark prompt
  AGENTPROMOTED    / <slug>      what a promoted model is good at (for the chat agent's prompt)
"""
from __future__ import annotations
import hashlib
import html
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from botocore.exceptions import ClientError

from server import store
from server.providers import mcp_client
from server import i18n
from server.i18n import said, tr

KST = timezone(timedelta(hours=9), "KST")
SCOUT_ID = "open-model-scout"
SCOUT_NAME = "오픈웨이트 모델 스카우트"
SCOUT_CRON = "cron(0 8 * * ? *)"
SCHEDULE_TZ = "Asia/Seoul"
MAX_PROPOSALS_PER_RUN = 3
CANDIDATES_FOR_RANKING = 14
RECENT_CREATED_DAYS = 180  # "released recently" ...
RECENT_UPDATED_DAYS = 45  # ... or "updated recently"
MIN_LIKES = 10
AGENT_MAX_TURNS = 15
RUN_BUDGET_SEC = 600  # inside the 900 s Lambda timeout
FETCH_MAX_CHARS = 12_000
PARK_DAYS = 7  # a passed trial box waits this long (stopped) for 승인, then it is terminated
LAUNCH_STALE_MIN = 20

PIPELINES = {"text-to-image": "image", "image-to-image": "image", "text-to-video": "video", "image-to-video": "video"}
SORTS = ("trendingScore", "likes")
HF_EXPAND = ("lastModified", "createdAt", "likes", "tags", "library_name", "pipeline_tag", "safetensors", "cardData",
             "trendingScore", "downloads", "gated")

# What IPverse runs today (connections.DEFAULT_IMAGE_MODELS, mediagen_video.DEFAULT_CATALOG): the scout must beat these.
BASELINES = {
    "image": [("krea", "Krea 2 Turbo", "text -> image, fast, photoreal, no reference images"),
              ("klein9", "FLUX.2 klein 9B", "text -> image and image editing with reference images (i2i)")],
    "video": [("ltx", "LTX-2.5 (LTX 22B)", "text/image -> video with synchronized audio, 2-20 s, plus IC-LoRA v2v"),
              ("wan-animate", "Wan2.2-Animate-14B + Wan2.1-VACE-14B", "character animation and restyle"),
              ("minimax-h3", "MiniMax H3", "text/image -> 5 s video with native audio, first+last frame"),
              ("kandinsky-6-0-video-pro", "Kandinsky 6.0 Video Pro", "text/image -> 5 s 16:9 video")],
}
# repo ids (lower case) of those baselines: never proposed
BASELINE_REPOS = re.compile(r"flux\.2-klein|krea-2|krea2|ltx-2|ltx-video-2|wan2\.2|kandinsky-6|minimax-h3$")
DERIVED_NAME = re.compile(r"(-|_)(gguf|comfy|comfyui|fp8|fp4|int4|int8|nf4|bnb|awq|gptq|mlx|onnx|quant\w*|lora)$", re.I)

COMMERCIAL_LICENSES = {"apache-2.0", "mit", "openrail", "openrail++", "creativeml-openrail-m", "bigscience-openrail-m",
                       "bsd", "bsd-2-clause", "bsd-3-clause", "cc-by-4.0", "cc-by-sa-4.0", "cc0-1.0", "unlicense",
                       "artistic-2.0", "afl-3.0", "ecl-2.0", "isc", "zlib", "mpl-2.0", "bsl-1.0", "postgresql"}
NON_COMMERCIAL = re.compile(r"non-?commercial|-nc(-|$)|research|cc-by-nc", re.I)

# Hourly on-demand us-east-1 prices (the 테스트 note quotes them) and the fallback sizes on a capacity miss.
INSTANCE_COST = {"g6e.xlarge": 1.861, "g6e.2xlarge": 2.242, "g6e.4xlarge": 3.004, "g6e.8xlarge": 4.529, "g6e.16xlarge": 7.577,
                 "g6e.12xlarge": 10.493}
# g6e.xlarge (the same L40S, 4 vCPU / 32 GB RAM) often has capacity when every larger size is out
INSTANCE_FALLBACKS = {"g6e.2xlarge": ["g6e.xlarge", "g6e.4xlarge", "g6e.8xlarge", "g6e.16xlarge"], "g6e.4xlarge": ["g6e.8xlarge", "g6e.16xlarge"],
                      "g6e.16xlarge": ["g6e.8xlarge"], "g6e.8xlarge": ["g6e.16xlarge"]}
CAPACITY_ERRORS = ("InsufficientInstanceCapacity", "Unsupported", "InstanceLimitExceeded")
TRIAL_HOURS = {"image": 2, "video": 3}
ROOT_GB = 300
STOPPED_DISK_MONTHLY = ROOT_GB * 0.08  # gp3 at its baseline IOPS/throughput, while parked or promoted and stopped
# Fleet tags a promoted model must not take over (videogen finds boxes by the mediagen tag).
RESERVED_SLUGS = {"ltx", "wan", "h3", "trial", "self-stop", "minimax-h3", "wan-animate", "magi-2", "storyboard",
                  "promoted", "krea", "klein9", "stability-ultra"}

# The fixed benchmark: the same prompts on every candidate and on the baseline (generated once, AGENTBASE).
IMAGE_PROMPTS = [
    "Full-body character concept art of a young female space ranger in a teal and white armored suit, standing in an "
    "A-pose, centered, plain light grey studio background, soft even lighting, highly detailed, no text.",
    "A single ornate fantasy sword with a glowing blue crystal in the hilt, lying horizontally across the frame, "
    "centered, plain white background, product shot, sharp details, no text.",
]
EDIT_PROMPT = ("Change the suit to crimson red with gold trim and add a short flowing cape. Keep the same character, "
               "pose, framing, background and art style.")
VIDEO_PROMPTS = [
    "A young female space ranger in a teal armored suit walks toward the camera across a neon-lit hangar, then stops "
    "and raises her visor, smiling. Medium shot, smooth dolly back, cinematic lighting.",
    "Low drone shot gliding over a rainy neon-lit Seoul street at night: reflections on wet asphalt, people with "
    "umbrellas, taxis passing. Cinematic, smooth motion.",
]
I2V_PROMPT = "The character turns her head toward the camera and waves slowly; the camera pushes in gently."
BENCH = (  # (mode, prompt, baseline model id, baseline label, reference: the t2i baseline of IMAGE_PROMPTS[0])
    *(("t2i", p, "krea", "Krea 2 Turbo", False) for p in IMAGE_PROMPTS),
    ("i2i", EDIT_PROMPT, "klein9", "FLUX.2 klein 9B", True),
    *(("t2v", p, "ltx", "LTX-2.5", False) for p in VIDEO_PROMPTS),
    ("i2v", I2V_PROMPT, "ltx", "LTX-2.5", True),
)
MODES = {"image": ("t2i", "i2i"), "video": ("t2v", "i2v")}
BENCH_SEED = 20261109
BASELINE_ATTEMPTS = 3


class AgentError(Exception):
    def __init__(self, status: int, code: str, message: str):
        message = said(message)  # in the request's language: the sentence is written where it is raised
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _time_id(prefix: str) -> str:
    """Ids that sort by creation time (the inbox is newest first by sk)."""
    return f"{prefix}{_now_dt().strftime('%Y%m%d%H%M%S%f')[:17]}{secrets.token_hex(2)}"


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


# ── HTTP (one place, so tests replace it: no network) ───────────────────────────

def http_get(url: str, timeout: int = 20, accept: str = "application/json") -> bytes:
    req = urllib.request.Request(url, headers={"user-agent": "ipverse-studio-agents/1", "accept": accept})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(3_000_000)


def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            return False
    return True


# ── schedules ──────────────────────────────────────────────────────────────────

_CRON = re.compile(r"^cron\((\S+) (\S+) (\S+) (\S+) (\S+) (\S+)\)$")
_RATE = re.compile(r"^rate\((\d+) (minute|minutes|hour|hours|day|days)\)$")
DAYS = {"MON-FRI": "평일", "SAT,SUN": "주말", "MON": "매주 월요일", "TUE": "매주 화요일", "WED": "매주 수요일",
        "THU": "매주 목요일", "FRI": "매주 금요일", "SAT": "매주 토요일", "SUN": "매주 일요일"}
MANUAL = "수동 실행"  # the label of an agent with no schedule, and what the 일정 field takes for one
# What the 일정 field takes, as the dialog itself shows a schedule:
#  - the label's own forms (schedule_label): 매일 08:00 KST, 평일 …, 주말 …, 매주 월요일 …, 매월 1일 …, 3시간마다,
#    수동 실행, with the time as HH:MM or in words (오전 9시, 오후 3시 30분, 저녁 7시)
#  - a five-field cron in Korean time (분 시 일 월 요일), as cron writes it: 0 9 * * *
#  - EventBridge Scheduler's own cron(...) and rate(...), which is how it is stored
# A refusal names them by example.
FORMS = ("‘매일 09:00’, ‘평일 오전 9시’, ‘매주 월요일 09:00’, ‘3시간마다’처럼 적거나 cron 식 ‘0 9 * * *’(분 시 일 월 요일, "
         f"한국 시간)로 적어 주세요. 직접 실행할 때만 돌리려면 ‘{MANUAL}’이라고 적어 주세요.")
_DOW = ("SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT")
_KO_DOW = dict(zip("일월화수목금토", _DOW))
_DOW_KO = {name: ko for ko, name in _KO_DOW.items()}
FORMS_EN = ("Write it like ‘every day 09:00’, ‘weekdays 9am’, ‘every Monday 09:00’ or ‘every 3 hours’, or as a "
            "cron expression ‘0 9 * * *’ (minute hour day month weekday). Times are Korean time, at most once an hour. "
            "Write ‘manual’ to run it only when you press ‘Run now’.")
DAYS_EN = {"MON-FRI": "Weekdays", "SAT,SUN": "Weekends", "MON": "Every Monday", "TUE": "Every Tuesday",
           "WED": "Every Wednesday", "THU": "Every Thursday", "FRI": "Every Friday", "SAT": "Every Saturday",
           "SUN": "Every Sunday"}
MANUAL_EN = "Manual"
_AM, _PM = ("오전", "아침", "새벽"), ("오후", "낮", "저녁", "밤")
_CLOCK = re.compile(r"(?:(" + "|".join(_AM + _PM) + r")\s*)?(\d{1,2})\s*(?::\s*(\d{2})|시\s*(?:(\d{1,2})\s*분|(반))?)")
_EVERY = re.compile(r"(?:매\s*)?(\d{1,3})\s*(분|시간|일)\s*마다")


def _forms() -> str:
    return FORMS_EN if i18n.lang() == "en" else FORMS


def _unreadable(expr) -> AgentError:
    return AgentError(400, "bad_schedule", tr("일정 ‘{expr}’은(는) 읽지 못했어요. {forms}", expr=str(expr)[:60],
                                              forms=_forms()))


def _too_often() -> AgentError:
    return AgentError(400, "bad_schedule", tr("한 시간에 한 번보다 자주 돌릴 수는 없어요. 분은 0이나 30처럼 숫자로 정해 주세요. "
                                              "{forms}", forms=_forms()))


def _numbers(field: str, lo: int, hi: int) -> bool:
    """A cron field of plain numbers (lists and ranges), every one within lo–hi."""
    return bool(re.fullmatch(r"\d{1,2}(?:[-,]\d{1,2})*", field)) and all(lo <= int(n) <= hi for n in re.findall(r"\d+", field))


def _weekdays(field: str):
    """A cron day-of-week field (0–7 with 0 and 7 Sunday, or names; lists and ranges) in EventBridge's names, or None.
    EventBridge counts its numbers from 1 = Sunday, so a number is never passed through."""
    def name(token):
        token = token.upper()
        return token if token in _DOW else _DOW[int(token) % 7] if re.fullmatch(r"[0-7]", token) else None

    parts = []
    for part in field.split(","):
        ends = [name(t) for t in part.split("-")]
        if not 1 <= len(ends) <= 2 or None in ends:
            return None
        parts.append("-".join(ends))
    return ",".join(parts)


def _five_fields(expr: str):
    """"분 시 일 월 요일" as cron writes it (Korean time) → EventBridge's six fields, or None when it is not that."""
    fields = expr.split()
    if len(fields) != 5 or not all(re.fullmatch(r"[0-9A-Za-z*,/-]+", f) for f in fields):
        return None
    minute, hour, day, month, weekday = fields
    if "*" in minute or "/" in minute:
        raise _too_often()
    if not _numbers(minute, 0, 59) or not (hour == "*" or _numbers(hour, 0, 23)) \
            or not (day == "*" or _numbers(day, 1, 31)) or not (month == "*" or _numbers(month, 1, 12)):
        return None
    if weekday == "*":
        return f"cron({minute} {hour} {day} {month} ? *)"
    names = _weekdays(weekday)
    # cron runs "on that day of the month or on that weekday" when both are given: EventBridge has no such schedule
    return f"cron({minute} {hour} ? {month} {names} *)" if names and day == "*" else None


def _clock(text: str):
    """The one time of day a phrase names → (hour, minute), or None: 09:00, 9시, 9시 30분, 9시 반, 오전 9시, 오후 3시,
    저녁 7시, 밤 12시 (midnight), 정오, 자정."""
    if re.fullmatch(r"\s*(정오|자정)\s*", text):
        return (12, 0) if "정오" in text else (0, 0)
    m = _CLOCK.fullmatch(text.strip())
    if not m:
        return None
    hour, minute = int(m[2]), int(m[3] or m[4] or (30 if m[5] else 0))
    if m[1] in _PM:
        hour = hour + 12 if hour < 12 else 12 if m[1] in ("오후", "낮") else 0  # 오후 12시 is noon, 밤 12시 midnight
    elif m[1] in _AM and hour == 12:
        hour = 0
    return (hour, minute) if hour <= 23 and minute <= 59 else None


def _worded(expr: str):
    """A schedule in the words the label prints (schedule_label) → the EventBridge expression, or None."""
    text = re.sub(r"\s*KST\s*$", "", expr.strip(), flags=re.I).rstrip("에 ")
    every = _EVERY.fullmatch(text)
    if every:
        n, unit = int(every[1]), {"분": "minute", "시간": "hour", "일": "day"}[every[2]]
        if unit == "minute" and n < 60:
            raise _too_often()
        return f"rate({n} {unit}{'' if n == 1 else 's'})" if n else None
    m = re.fullmatch(r"(매일|평일|주말|매주\s*([일월화수목금토](?:\s*[·,/]\s*[일월화수목금토])*)\s*요일|매월\s*(\d{1,2})\s*일)\s*(?:마다\s*)?(.+)", text)
    when = _clock(m[4]) if m else None
    if not when:
        return None
    hour, minute = when
    if m[3]:
        return f"cron({minute} {hour} {int(m[3])} * ? *)" if 1 <= int(m[3]) <= 31 else None
    days = "MON-FRI" if m[1] == "평일" else "SAT,SUN" if m[1] == "주말" else \
        ",".join(_KO_DOW[d] for d in re.findall("[일월화수목금토]", m[2])) if m[2] else None
    return f"cron({minute} {hour} ? * {days} *)" if days else f"cron({minute} {hour} * * ? *)"


# The same schedules in English, as schedule_label prints them there: "every day 09:00", "weekdays 9am", "every
# Monday 09:00", "monthly on day 1 09:00", "every 3 hours", "hourly", "noon". A bare hour is a time only after "at"
# ("every day at 9"), the time may come first ("9am daily"), and "every morning / evening / night at 9" is every
# day, with the half of the day it names.
_EN_DAY = {"sun": "SUN", "mon": "MON", "tue": "TUE", "wed": "WED", "thu": "THU", "fri": "FRI", "sat": "SAT"}
_EN_DAY_WORD = r"\b(?:sun|mon|tue(?:s)?|wed(?:nes)?|thu(?:r|rs)?|fri|sat(?:ur)?)(?:day)?s?\b"
_EN_CLOCK = re.compile(r"(\d{1,2})(?:\s*:\s*(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?", re.I)
_EN_EVERY = re.compile(r"(?:every\s+(?:(\d{1,3})\s+)?(minute|hour|day)s?|(hourly))", re.I)
_EN_DAYS = (r"(every\s*day|daily|every\s+(?:morning|afternoon|evening|night)|every\s+weekday|weekdays?|every\s+weekend"
            r"|weekends?|(?:every\s+|on\s+)?(" + _EN_DAY_WORD + r"(?:\s*(?:[·,/&]|and)\s*" + _EN_DAY_WORD + r")*)"
            r"|(?:monthly|every\s+month)\s+on\s+(?:the\s+|day\s+)?(\d{1,2})(?:st|nd|rd|th)?)")
_EN_WHEN = re.compile(_EN_DAYS + r"\s*,?\s*(at\s+)?(.+)", re.I)
# The time first: "9am daily", "at 9:30 every day", "noon on weekdays" (a bare hour only after "at")
_EN_TIME_FIRST = re.compile(r"(?:(at)\s+)?(\d{1,2}(?:\s*:\s*\d{2})?(?:\s*(?:a\.?m\.?|p\.?m\.?))?|noon|midnight)\s*,?\s+(?:on\s+)?("
                            + _EN_DAYS + r")", re.I)
_EN_PART = re.compile(r"every\s+(morning|afternoon|evening|night)", re.I)


def _clock_en(text: str, bare: bool = False, part: str = ""):
    """The one time of day an English phrase names → (hour, minute), or None: 09:00, 9am, 9:30 pm, noon, midnight.
    A bare number names no time ("every Monday 9") unless it follows "at" (bare: "every day at 9" is 09:00). part: the
    half of the day the phrase names ("every evening at 7" is 19:00), for a time that does not say am or pm."""
    text = text.strip().lower()
    if text in ("noon", "midnight"):
        return (12, 0) if text == "noon" else (0, 0)
    m = _EN_CLOCK.fullmatch(text)
    if not m or (m[2] is None and m[3] is None and not bare):
        return None
    hour, minute, half = int(m[1]), int(m[2] or 0), (m[3] or "").replace(".", "")
    if half:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if half == "pm" else 0)
    elif part == "morning" and hour >= 12:
        return None
    elif part in ("afternoon", "evening") and hour < 12:  # (19:00 is itself)
        if not hour:
            return None
        hour += 12
    elif part == "night" and 6 <= hour <= 12:  # 7 at night is 19:00, 12 at night midnight; 23:00 and 2:00 are themselves
        if hour == 6:
            return None
        hour = (hour + 12) % 24
    return (hour, minute) if hour <= 23 and minute <= 59 else None


def _worded_en(expr: str):
    """A schedule in English words → the EventBridge expression, or None."""
    text = re.sub(r"\s*KST\s*$", "", expr.strip(), flags=re.I).strip()
    every = _EN_EVERY.fullmatch(text)
    if every:
        n, unit = (1, "hour") if every[3] else (int(every[1] or 1), every[2].lower())
        if unit == "minute" and n < 60:
            raise _too_often()
        return f"rate({n} {unit}{'' if n == 1 else 's'})" if n else None
    first = _EN_TIME_FIRST.fullmatch(text)
    if first and (first[1] or not first[2].strip().isdigit()):
        text = f"{first[3]} at {first[2]}" if first[1] else f"{first[3]} {first[2]}"
    m = _EN_WHEN.fullmatch(text)
    part = _EN_PART.fullmatch(m[1]) if m else None
    when = _clock_en(m[5], bare=bool(m[4]), part=part[1].lower() if part else "") if m else None
    if not when:
        return None
    hour, minute = when
    if m[3]:
        return f"cron({minute} {hour} {int(m[3])} * ? *)" if 1 <= int(m[3]) <= 31 else None
    head = m[1].lower()
    if m[2]:
        days = ",".join(dict.fromkeys(_EN_DAY[d[:3]] for d in re.findall(_EN_DAY_WORD, m[2].lower())))
    else:
        days = "MON-FRI" if "weekday" in head else "SAT,SUN" if "weekend" in head else None
    return f"cron({minute} {hour} ? * {days} *)" if days else f"cron({minute} {hour} * * ? *)"


def validate_cron(expr) -> str | None:
    """What the 일정 field holds → an EventBridge Scheduler expression, at most hourly (caps Bedrock spend), or None
    (manual runs only). Takes the forms the dialog shows (see FORMS above); refuses anything else with those forms."""
    if expr is None:
        return None
    if not isinstance(expr, str):
        raise _unreadable(expr)
    expr = " ".join(expr.split())
    if expr in ("", MANUAL, "수동", "없음") or expr.lower() in ("manual", "manual run", "manually", "none", "off"):
        return None
    expr = _five_fields(expr) or _worded(expr) or _worded_en(expr) or expr
    m = _CRON.match(expr)
    if m:
        if not re.fullmatch(r"\d{1,2}(,\d{1,2})*", m.group(1)):
            raise _too_often()
        if "?" not in (m.group(3), m.group(5)):
            raise _unreadable(expr)
        return expr
    r = _RATE.match(expr)
    if r and r.group(2).startswith("minute") and int(r.group(1)) < 60:
        raise _too_often()
    if not r:
        raise _unreadable(expr)
    return expr


def schedule_label(expr: str | None) -> str:
    """A schedule in words, for the list and the dialog's hint. Every form it prints, validate_cron takes back."""
    en = i18n.lang() == "en"
    if not expr:
        return MANUAL_EN if en else MANUAL
    m = _CRON.match(expr)
    if m and re.fullmatch(r"\d{1,2}", m.group(1)) and re.fullmatch(r"\d{1,2}", m.group(2)) and m.group(4) == "*":
        when = f"{int(m.group(2)):02d}:{int(m.group(1)):02d} KST"
        if en:  # the same forms in English: validate_cron takes each back (_worded_en)
            if m.group(3) == "*" and m.group(5) == "?":
                return f"Every day {when}"
            if m.group(3) == "?" and m.group(5) in DAYS_EN:
                return f"{DAYS_EN[m.group(5)]} {when}"
            if m.group(3) == "?" and all(d in _DOW_KO for d in m.group(5).split(",")):
                return f"Every {'·'.join(d.capitalize() for d in m.group(5).split(','))} {when}"
            if m.group(5) == "?" and re.fullmatch(r"\d{1,2}", m.group(3)):
                return f"Monthly on day {int(m.group(3))} {when}"
            return expr
        if m.group(3) == "*" and m.group(5) == "?":
            return f"매일 {when}"
        if m.group(3) == "?" and m.group(5) in DAYS:
            return f"{DAYS[m.group(5)]} {when}"
        if m.group(3) == "?" and all(d in _DOW_KO for d in m.group(5).split(",")):
            return f"매주 {'·'.join(_DOW_KO[d] for d in m.group(5).split(','))}요일 {when}"
        if m.group(5) == "?" and re.fullmatch(r"\d{1,2}", m.group(3)):
            return f"매월 {int(m.group(3))}일 {when}"
    r = _RATE.match(expr)
    if r and en:
        unit = r.group(2).rstrip("s")
        return f"Every {unit}" if r.group(1) == "1" else f"Every {r.group(1)} {unit}s"
    if r:
        unit = {"minute": "분", "hour": "시간", "day": "일"}[r.group(2).rstrip("s")]
        return f"{r.group(1)}{unit}마다"
    return expr


def schedule_name(sub: str, agent_id: str) -> str:
    return "ipv-agent-" + hashlib.sha256(f"{sub}|{agent_id}".encode()).hexdigest()[:40]


def _scheduler(ctx):
    if getattr(ctx, "scheduler", None) is None:
        import boto3
        ctx.scheduler = boto3.client("scheduler", region_name="us-east-1")
    return ctx.scheduler


def self_arn() -> str:
    return _env("AGENTS_SELF_ARN") or \
        f"arn:aws:lambda:us-east-1:{_env('ACCOUNT_ID', '087967639890')}:function:{_env('SELF_FUNCTION_NAME', 'ipverse-api')}"


def sync_schedule(ctx, sub: str, agent: dict) -> None:
    sched, name, group = _scheduler(ctx), schedule_name(sub, agent["agentId"]), _env("AGENTS_SCHEDULE_GROUP", "ipverse-agents")
    if agent.get("enabled") and agent.get("cron"):
        args = dict(Name=name, GroupName=group, ScheduleExpression=agent["cron"],
                    ScheduleExpressionTimezone=agent.get("timezone") or SCHEDULE_TZ,
                    FlexibleTimeWindow={"Mode": "OFF"}, State="ENABLED",
                    Description=f"{agent['name']} ({sub})"[:512],
                    Target={"Arn": self_arn(), "RoleArn": _env("AGENTS_SCHEDULER_ROLE_ARN"),
                            "Input": json.dumps({"action": "agents_run", "sub": sub, "agentId": agent["agentId"]}),
                            "RetryPolicy": {"MaximumRetryAttempts": 0}})
        try:
            try:
                sched.update_schedule(**args)
            except ClientError as e:
                if e.response["Error"]["Code"] != "ResourceNotFoundException":
                    raise
                sched.create_schedule(**args)
        except ClientError as e:
            if e.response["Error"]["Code"] == "ValidationException":  # e.g. the 31st of February: its English stays in the log
                print(f"[agents] schedule {agent.get('cron')} refused: {e.response['Error'].get('Message', '')[:300]}")
                raise _unreadable(agent.get("cron")) from None
            raise
    else:
        try:
            sched.delete_schedule(Name=name, GroupName=group)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                raise


# ── agents ─────────────────────────────────────────────────────────────────────

SCOUT_INSTRUCTIONS = (
    "매일 아침 Hugging Face Hub에서 새로 나왔거나 갱신된 오픈웨이트 이미지(텍스트→이미지, 레퍼런스 이미지 편집)·영상"
    "(텍스트·이미지→영상) 생성 모델을 조사한다. 오픈 라이선스(비상업 라이선스는 표시), L40S 48 GB GPU 한 장에 들어가는지"
    "(아니면 필요한 인스턴스), diffusers나 공식 추론 코드가 있는지 확인하고, 지금 쓰는 Krea 2 Turbo·FLUX.2 klein 9B·"
    "LTX-2.5·Wan2.2·MiniMax H3·Kandinsky 6.0 Pro보다 나은 모델만 제안한다. 이미 제안·테스트·승인한 모델은 다시 제안하지 "
    "않는다. 테스트를 누르면 GPU에 실제로 설치해 같은 프롬프트로 비교하고, 승인하면 다음 요청부터 그 모델을 고를 수 있다.")


def _scout(enabled: bool) -> dict:
    return {"agentId": SCOUT_ID, "name": SCOUT_NAME, "instructions": SCOUT_INSTRUCTIONS, "cron": SCOUT_CRON,
            "timezone": SCHEDULE_TZ, "enabled": enabled, "builtin": True, "createdAt": store.now(), "lastRun": None}


def _agent_pk(sub: str) -> str:
    return f"AGENT#{sub}"


def public_agent(a: dict) -> dict:
    out = {k: a.get(k) for k in ("agentId", "name", "instructions", "cron", "enabled", "builtin")}
    out["scheduleLabel"] = schedule_label(a.get("cron"))
    last = a.get("lastRun")
    out["lastRun"] = {k: last.get(k) for k in ("at", "status", "summary")} if isinstance(last, dict) else None
    if a.get("builtin"):  # today's copy, in the page's language: the built-in's text is not the user's
        out["name"], out["instructions"] = tr(SCOUT_NAME), tr(SCOUT_INSTRUCTIONS)
    return out


def ensure_scout(ctx, user: dict) -> dict:
    """The built-in scout exists for every user; enabled (and scheduled) by default for SCOUT_DEFAULT_USERS (demo)."""
    found = store._get(ctx, _agent_pk(user["sub"]), SCOUT_ID)
    if found:
        return found
    default_users = {u.strip() for u in _env("SCOUT_DEFAULT_USERS", "demo").split(",") if u.strip()}
    scout = _scout(user.get("username") in default_users)
    if scout["enabled"]:
        sync_schedule(ctx, user["sub"], scout)
    store._put(ctx, _agent_pk(user["sub"]), SCOUT_ID, scout)
    return scout


def remember_lang(ctx, user, scout: dict = None) -> None:
    """Keep the language of the account's latest request to the agents' pages on its scout (one write, when it
    changed): proposals, trial notes and runs are written outside a request (account_lang)."""
    scout = scout or ensure_scout(ctx, user)
    if i18n.norm(scout.get("lang")) != i18n.lang():
        store._update(ctx, _agent_pk(user["sub"]), SCOUT_ID, {"lang": i18n.lang()})


def account_lang(ctx, sub: str) -> str:
    """The language of the account's latest request to the agents' pages (remember_lang), Korean when none is kept."""
    try:
        return i18n.norm((store._get(ctx, _agent_pk(sub), SCOUT_ID) or {}).get("lang"))
    except Exception:  # noqa: BLE001 — falls back to Korean
        return "ko"


def list_agents(ctx, user) -> dict:
    remember_lang(ctx, user, ensure_scout(ctx, user))
    items = [store._strip(i) for i in store._query(ctx, _agent_pk(user["sub"]))]
    items.sort(key=lambda a: (not a.get("builtin"), a.get("createdAt", "")))
    return {"agents": [public_agent(a) for a in items]}


def get_agent(ctx, sub: str, agent_id: str) -> dict:
    a = store._get(ctx, _agent_pk(sub), agent_id)
    if not a:
        raise AgentError(404, "not_found", "에이전트를 찾지 못했어요. 목록을 새로 고친 뒤 다시 해 주세요.")
    return a


DRAFT_TOOL = {"toolSpec": {"name": "agent_spec", "description": "The agent definition.", "inputSchema": {"json": {
    "type": "object", "properties": {
        "name": {"type": "string", "description": "short name in the user's language (Korean)"},
        "instructions": {"type": "string", "description": "complete standing instructions the agent follows on every "
                         "run, in Korean: what to research, which sources, what counts as news, when to notify, format"},
        "cron": {"type": ["string", "null"], "description": "EventBridge Scheduler expression in Asia/Seoul time: "
                 "cron(minutes hours day-of-month month day-of-week year) with ? in one day field, e.g. "
                 "cron(0 9 * * ? *) daily 09:00 or cron(30 8 ? * MON-FRI *) weekdays. At most hourly. null when the "
                 "request gives no time or recurrence."},
        "cannot": {"type": ["string", "null"], "description": "null when the agent can do what was asked with the "
                   "abilities listed above alone. Otherwise one short Korean sentence in 해요체 that says what it cannot "
                   "do, e.g. \"스튜디오의 세션 목록은 볼 수 없어요.\""}},
    "required": ["name", "instructions", "cron", "cannot"]}}}}
# What an agent can do, as the user is told it when a request needs more (create_agent)
CAN_DO = "에이전트는 Hugging Face 모델 찾기, 공개 웹 페이지 읽기와 웹 검색, 받은 편지함으로 알리기만 할 수 있어요."


def _in_english() -> str:
    """An addition to the agents' own model calls (a draft, the scout's ranking, a custom agent's run), whose
    instructions ask for Korean: on an English account the text a person reads is English."""
    return (" The user reads English: write every text a person reads (names, instructions, notes, summaries, why and "
            "risks, the cannot sentence) in English, wherever these instructions or a tool description say Korean."
            ) if i18n.lang() == "en" else ""


def create_agent(ctx, user, body) -> dict:
    text = body.get("description")
    if not isinstance(text, str) or not text.strip():
        raise AgentError(400, "bad_request", "맡길 일을 한 문장으로 적어 주세요.")
    if len(text) > 4000:
        raise AgentError(400, "bad_request", "맡길 일이 너무 길어요. 4,000자 안으로 줄여 주세요.")
    resp = ctx.bedrock_rt_east.converse(
        modelId=ctx.agent_model_id,
        system=[{"text": "Turn the user's natural-language request into an agent for IPverse Studio, a game/media IP "
                         "studio. An agent runs unattended on a schedule and can only search Hugging Face models, read "
                         "public web pages, search the web when available, and post notes to the user's inbox (no "
                         "email, no chat, no file access, and nothing of the user's own studio: not their sessions, IPs, "
                         "games, jobs or files). When the request needs anything else, say so in cannot instead of "
                         "writing instructions that pretend or that admit they cannot be followed. Write name and "
                         "instructions in Korean. Answer only by calling the agent_spec tool." + _in_english()}],
        messages=[{"role": "user", "content": [{"text": text.strip()}]}],
        # forced toolChoice is refused by the agent model ("type tool and any are not supported"): auto + told to call it
        toolConfig={"tools": [DRAFT_TOOL], "toolChoice": {"auto": {}}},
        inferenceConfig={"maxTokens": 2048})
    spec = next((c["toolUse"]["input"] for c in resp["output"]["message"]["content"] if "toolUse" in c), None)
    if not isinstance(spec, dict):
        raise AgentError(502, "draft_failed", "에이전트를 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.")
    # An agent whose own plan says it cannot do the task is not registered: nothing is stored or scheduled, and the
    # dialog shows why, with the sentence still in its box
    cannot = spec.get("cannot")
    if isinstance(cannot, str) and cannot.strip():
        raise AgentError(422, "cannot_do", tr("이 일은 지금 에이전트에게 맡길 수 없어요: {cannot} {can_do} "
                                              "할 일을 바꿔 다시 적어 주세요.", cannot=cannot.strip()[:300],
                                              can_do=tr(CAN_DO)))
    name = str(spec.get("name") or "").strip()[:80]
    instructions = str(spec.get("instructions") or "").strip()[:8000]
    if not name or not instructions:
        raise AgentError(502, "draft_failed", "에이전트의 이름이나 할 일이 비어서 만들지 못했어요. 다시 눌러 주세요.")
    try:
        cron = validate_cron(spec.get("cron"))
    except AgentError:
        cron = None  # a schedule the model got wrong: the user sets it in the edit form
    agent = {"agentId": store.new_id("agt"), "name": name, "instructions": instructions, "cron": cron,
             "timezone": SCHEDULE_TZ, "enabled": True, "builtin": False, "createdAt": store.now(), "lastRun": None,
             "description": text.strip()[:1000]}
    sync_schedule(ctx, user["sub"], agent)
    store._put(ctx, _agent_pk(user["sub"]), agent["agentId"], agent)
    return public_agent(agent)


def patch_agent(ctx, user, agent_id, body) -> dict:
    agent = get_agent(ctx, user["sub"], agent_id)
    if agent.get("builtin") and any(k in body for k in ("name", "instructions")):
        raise AgentError(409, "builtin", "기본 에이전트의 이름과 할 일은 바꿀 수 없어요. 일정과 켜기·끄기만 바꿀 수 있어요.")
    for k, limit in (("name", 80), ("instructions", 8000)):
        if k in body:
            v = body[k].strip() if isinstance(body[k], str) else ""
            if not v or len(v) > limit:
                raise AgentError(400, "bad_request", (tr("이름을 1–{limit}자로 적어 주세요.", limit=f"{limit:,}") if k == "name"
                                                      else tr("할 일을 1–{limit}자로 적어 주세요.", limit=f"{limit:,}")))
            agent[k] = v
    if "cron" in body:
        agent["cron"] = validate_cron(body["cron"])
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise AgentError(400, "bad_request", "켜기·끄기 값을 읽지 못했어요. 화면을 새로 고친 뒤 다시 눌러 주세요.")
        agent["enabled"] = body["enabled"]
    sync_schedule(ctx, user["sub"], agent)
    agent["updatedAt"] = store.now()
    store._put(ctx, _agent_pk(user["sub"]), agent_id, agent)
    return public_agent(agent)


def delete_agent(ctx, user, agent_id) -> None:
    agent = get_agent(ctx, user["sub"], agent_id)
    if agent.get("builtin"):
        raise AgentError(409, "builtin", "기본 에이전트는 지울 수 없어요. 끄기로 멈출 수 있어요.")
    sync_schedule(ctx, user["sub"], {**agent, "enabled": False})
    ctx.table.delete_item(Key={"pk": _agent_pk(user["sub"]), "sk": agent_id})


def run_now(ctx, user, agent_id) -> dict:
    get_agent(ctx, user["sub"], agent_id)
    run_id = store.new_id("run")
    ctx.lambda_.invoke(FunctionName=_env("SELF_FUNCTION_NAME", "ipverse-api"), InvocationType="Event",
                       Payload=json.dumps({"action": "agents_run", "sub": user["sub"], "agentId": agent_id,
                                           "runId": run_id}))
    store._update(ctx, _agent_pk(user["sub"]), agent_id,
                  {"lastRun": {"at": store.now(), "status": "running", "summary": tr("실행 중…"), "runId": run_id}})
    return {"runId": run_id}


def _set_last_run(ctx, sub, agent_id, status, summary, run_id=None):
    store._update(ctx, _agent_pk(sub), agent_id, {"lastRun": {"at": store.now(), "status": status,
                                                              "summary": summary[:1500], "runId": run_id}})


def run_agent(ctx, sub: str, agent_id: str, run_id: str = None) -> dict:
    """The agents_run action: the scout's pipeline, or a custom agent's Converse tool loop."""
    agent = store._get(ctx, _agent_pk(sub), agent_id)
    if not agent:
        return {"skipped": "no such agent"}
    run_id = run_id or store.new_id("run")
    i18n.use(account_lang(ctx, sub))  # what this run writes is in the account's language (remember_lang)
    _set_last_run(ctx, sub, agent_id, "running", tr("실행 중…"), run_id)
    try:
        summary = run_scout(ctx, sub, agent) if agent.get("builtin") else run_custom(ctx, sub, agent)
        status = "succeeded"
    except Exception:  # noqa: BLE001 — shown as the agent's last run: what to do, the exception stays in the log
        traceback.print_exc()
        summary, status = tr("이번 실행은 끝내지 못했어요. 잠시 뒤 ‘지금 실행’으로 다시 해 주세요."), "failed"
    _set_last_run(ctx, sub, agent_id, status, summary, run_id)
    return {"status": status, "summary": summary}


# ── inbox ──────────────────────────────────────────────────────────────────────

def _note_pk(sub):
    return f"AGENTNOTE#{sub}"


def _prop_pk(sub):
    return f"AGENTPROP#{sub}"


def put_note(ctx, sub, agent, title, body, proposal_id=None) -> dict:
    note = {"noteId": _time_id("nt_"), "agentId": agent["agentId"], "agentName": agent["name"],
            "createdAt": store.now(), "title": title[:200], "body": body[:20_000],
            **({"proposalId": proposal_id} if proposal_id else {})}
    store._put(ctx, _note_pk(sub), note["noteId"], note)
    return note


def get_proposal(ctx, sub, pid) -> dict:
    p = store._get(ctx, _prop_pk(sub), pid)
    if not p:
        raise AgentError(404, "not_found", "제안을 찾지 못했어요. 받은 편지함을 새로 고친 뒤 다시 해 주세요.")
    return p


def get_trial(ctx, tid) -> dict | None:
    return store._get(ctx, "AGENTTRIAL", tid) if tid else None


def public_trial(ctx, t: dict | None, baselines: dict | None = None) -> dict | None:
    if not t:
        return None
    base = baselines if baselines is not None else baseline_map(ctx)
    results = []
    for o in t.get("outputs") or []:
        b = base.get((o.get("mode"), o.get("prompt"))) or {}
        model = next((label for mode, prompt, _, label, _ in BENCH if mode == o.get("mode")), "")
        results.append({"prompt": o.get("prompt"), "mode": o.get("mode"),
                        **({"referenceUrl": o["referenceUrl"]} if o.get("referenceUrl") else {}),
                        "baseline": {"model": model, "url": b.get("url") if b.get("status") == "SUCCEEDED" else None},
                        "candidate": {"url": o.get("url"), **({"seconds": o["seconds"]} if o.get("seconds") else {})}})
    return {"trialId": t["trialId"], "phase": t.get("phase", ""), "startedAt": t.get("startedAt"),
            "finishedAt": t.get("finishedAt"), "error": t.get("error"), "results": results,
            "instanceType": t.get("instanceType"), "kinds": t.get("kinds") or []}


PROPOSAL_FIELDS = ("proposalId", "kind", "hfRepo", "label", "license", "commercialOk", "vramGb", "instance", "why",
                   "risks", "status")


def public_proposal(ctx, p: dict, baselines: dict | None = None) -> dict:
    out = {k: p.get(k) for k in PROPOSAL_FIELDS}
    out["trial"] = public_trial(ctx, get_trial(ctx, p.get("trialId")), baselines)
    return out


def inbox(ctx, user) -> dict:
    sub = user["sub"]
    remember_lang(ctx, user)
    notes = [store._strip(i) for i in store._query(ctx, _note_pk(sub), forward=False)][:100]
    props = {p["proposalId"]: p for p in (store._strip(i) for i in store._query(ctx, _prop_pk(sub)))}
    base = baseline_map(ctx)
    out = []
    for n in notes:
        p = props.get(n.get("proposalId") or "")
        out.append({**{k: n.get(k) for k in ("noteId", "agentId", "agentName", "createdAt", "title", "body")},
                    "proposal": public_proposal(ctx, p, base) if p else None})
    return {"notes": out}


# ── the scout: Hugging Face Hub → filters → one Bedrock ranking ─────────────────

def hf_models(pipeline: str, sort: str, limit: int = 50) -> list:
    q = urllib.parse.urlencode([("pipeline_tag", pipeline), ("sort", sort), ("direction", "-1"), ("limit", limit)]
                               + [("expand[]", e) for e in HF_EXPAND])
    data = json.loads(http_get(f"https://huggingface.co/api/models?{q}"))
    return data if isinstance(data, list) else []


def hf_card(repo: str) -> str:
    try:
        return http_get(f"https://huggingface.co/{repo}/raw/main/README.md", accept="text/plain").decode(
            "utf-8", "replace")[:30_000]
    except Exception:  # noqa: BLE001 — a gated or missing card: the candidate is judged on its metadata
        return ""


def license_of(m: dict) -> str:
    card = m.get("cardData") or {}
    lic = card.get("license")
    if isinstance(lic, list):
        lic = lic[0] if lic else None
    if not lic:
        lic = next((t.split(":", 1)[1] for t in m.get("tags") or [] if t.startswith("license:")), "")
    lic = str(lic or "").strip().lower()
    if lic == "other":
        name = card.get("license_name") or os.path.basename(str(card.get("license_link") or "")).split(".")[0]
        lic = f"other:{str(name).strip().lower()}" if name else "other"
    return lic


def classify_license(lic: str) -> tuple:
    """(open, commercialOk). Unknown or unnamed licenses are not open; non-commercial ones are open with a flag;
    a named custom license (e.g. a community license) is allowed but never marked commercially safe."""
    if not lic or lic in ("other", "unknown"):
        return False, False
    if NON_COMMERCIAL.search(lic):
        return True, False
    if lic in COMMERCIAL_LICENSES:
        return True, True
    return lic.startswith(("other:", "openrail", "cc-by", "flux", "llama", "gemma")), False


def _params(m: dict) -> float | None:
    st = m.get("safetensors") or {}
    total = st.get("total") or sum((st.get("parameters") or {}).values()) if isinstance(st, dict) else None
    try:
        return float(total) if total else None
    except (TypeError, ValueError):
        return None


def vram_and_instance(kind: str, params: float | None) -> tuple:
    """(vramGb estimate for bf16 weights + 15 % activations, instance type, fits one L40S)."""
    if not params:
        return None, ("g6e.2xlarge" if kind == "image" else "g6e.4xlarge"), True
    vram = math.ceil(params * 2 / 1e9 * 1.15)
    if vram <= 44:
        return vram, ("g6e.2xlarge" if kind == "image" else "g6e.4xlarge"), True
    if vram <= 80:
        return vram, "g6e.16xlarge", False  # one L40S with CPU offload (512 GB RAM), the MiniMax H3 box size
    return vram, "g6e.12xlarge", False  # 4x L40S


def _derived(m: dict) -> bool:
    tags = [t.lower() for t in m.get("tags") or []]
    return (any(t.startswith(("base_model:quantized:", "base_model:adapter:", "base_model:merge:")) for t in tags)
            or (m.get("library_name") or "").lower() in ("gguf", "peft", "mlx")
            or "gguf" in tags or "lora" in tags or bool(DERIVED_NAME.search(m.get("id", ""))))


def _recent(m: dict, now: datetime) -> bool:
    created, updated = _parse(m.get("createdAt")), _parse(m.get("lastModified"))
    return bool((created and created >= now - timedelta(days=RECENT_CREATED_DAYS))
                or (updated and updated >= now - timedelta(days=RECENT_UPDATED_DAYS)))


def inference_path(m: dict, card: str) -> str:
    if (m.get("library_name") or "").lower() == "diffusers" or "diffusers" in [t.lower() for t in m.get("tags") or []]:
        return "diffusers"
    if re.search(r"github\.com/[\w.-]+/[\w.-]+", card) and re.search(r"inference|generate|sample|demo|python ", card, re.I):
        return "reference code"
    return ""


def seen_repos(ctx, sub: str) -> set:
    """Repos never to propose again: this user's proposals in any state, every promoted model."""
    seen = {p.get("hfRepo", "").lower() for p in (store._strip(i) for i in store._query(ctx, _prop_pk(sub)))}
    seen |= {p.get("hfRepo", "").lower() for p in (store._strip(i) for i in store._query(ctx, "AGENTPROMOTED"))}
    try:
        seen |= {m["hfRepo"].lower() for m in promoted_boxes(ctx)}
    except Exception:  # noqa: BLE001 — the registry above still covers what IPverse promoted
        traceback.print_exc()
    return {s for s in seen if s}


def scout_candidates(ctx, sub: str, stats: dict | None = None) -> list:
    """Hard-filtered candidates, most trending first: [{hfRepo, kind, pipeline, license, commercialOk, vramGb,
    instance, fits, inference, likes, createdAt, lastModified, card}]."""
    stats = stats if stats is not None else {}
    now, seen, found = _now_dt(), seen_repos(ctx, sub), {}
    for pipeline, kind in PIPELINES.items():
        for sort in SORTS:
            try:
                rows = hf_models(pipeline, sort)
            except Exception as e:  # noqa: BLE001 — one failed listing must not end the run
                stats.setdefault("errors", []).append(f"{pipeline}/{sort}: {e}"[:200])
                continue
            for m in rows:
                repo = str(m.get("id") or "")
                if repo and repo not in found:
                    found[repo] = (m, kind, pipeline)
    stats["listed"] = len(found)
    out = []
    for repo, (m, kind, pipeline) in found.items():
        low = repo.lower()
        if low in seen:
            stats["seen"] = stats.get("seen", 0) + 1
            continue
        if BASELINE_REPOS.search(low) or _derived(m) or int(m.get("likes") or 0) < MIN_LIKES:
            stats["derived_or_baseline"] = stats.get("derived_or_baseline", 0) + 1
            continue
        if not _recent(m, now):
            stats["old"] = stats.get("old", 0) + 1
            continue
        lic = license_of(m)
        ok, commercial = classify_license(lic)
        if not ok:
            stats["license"] = stats.get("license", 0) + 1
            continue
        vram, instance, fits = vram_and_instance(kind, _params(m))
        out.append({"hfRepo": repo, "kind": kind, "pipeline": pipeline, "license": lic, "commercialOk": commercial,
                    "vramGb": vram, "instance": instance, "fits": fits, "likes": int(m.get("likes") or 0),
                    "trending": float(m.get("trendingScore") or 0), "createdAt": m.get("createdAt"),
                    "lastModified": m.get("lastModified"), "gated": bool(m.get("gated")),
                    "_m": m})
    out.sort(key=lambda c: (-c["trending"], -c["likes"]))
    kept = []
    for c in out:
        if len(kept) >= CANDIDATES_FOR_RANKING:
            break
        m = c.pop("_m")
        card = hf_card(c["hfRepo"])
        c["inference"] = inference_path(m, card)
        if not c["inference"]:
            stats["no_inference"] = stats.get("no_inference", 0) + 1
            continue
        c["card"] = card[:2500]
        kept.append(c)
    for c in out:
        c.pop("_m", None)
    stats["candidates"] = len(kept)
    return kept


def web_search(ctx, query: str, max_results: int = 6) -> list:
    """The harness's AgentCore Gateway web-search connector (SigV4 MCP), when WEBSEARCH_GATEWAY_URL is set."""
    url = _env("WEBSEARCH_GATEWAY_URL")
    if not url:
        return []
    import boto3
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": _env("WEBSEARCH_TOOL_NAME", "WebSearch___WebSearch"),
        "arguments": {"query": query, "maxResults": max(1, min(int(max_results), 10))}}})
    req = AWSRequest(method="POST", url=url, data=body,
                     headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    SigV4Auth(boto3.Session().get_credentials().get_frozen_credentials(), "bedrock-agentcore", "us-east-1").add_auth(req)
    r = urllib.request.Request(url, data=body.encode(), headers=dict(req.headers.items()), method="POST")
    with urllib.request.urlopen(r, timeout=40) as resp:
        raw = resp.read().decode("utf-8", "replace").strip()
    if not raw.startswith("{"):
        frames = [ln[5:].strip() for ln in raw.splitlines() if ln.startswith("data:")]
        raw = frames[-1] if frames else "{}"
    result = json.loads(raw).get("result") or {}
    data = result.get("structuredContent")
    if data is None:
        text = "".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        try:
            data = json.loads(text)
        except ValueError:
            data = {}
    rows = data.get("results", []) if isinstance(data, dict) else []
    return [{"title": x.get("title"), "url": x.get("url"), "publishedDate": x.get("publishedDate"),
             "text": (x.get("text") or "")[:500]} for x in rows]


RANK_TOOL = {"toolSpec": {"name": "propose", "description": "The models worth a GPU trial, best first.",
                          "inputSchema": {"json": {"type": "object", "properties": {
                              "proposals": {"type": "array", "maxItems": MAX_PROPOSALS_PER_RUN, "items": {
                                  "type": "object", "properties": {
                                      "hfRepo": {"type": "string", "description": "exactly one of the candidates' hfRepo"},
                                      "label": {"type": "string", "description": "short model name, e.g. 'Qwen-Image 2.1'"},
                                      "why": {"type": "string", "description": "Korean: why it is better than the "
                                              "baseline it would replace or complement, with the evidence (card "
                                              "benchmark, leaderboard, feature such as reference editing)"},
                                      "risks": {"type": "string", "description": "Korean: license limits, VRAM/offload, "
                                                "speed, gated weights, missing features, unverified claims"},
                                      "editCapable": {"type": "boolean", "description": "image models: edits with "
                                                      "reference images (i2i)"}},
                                  "required": ["hfRepo", "label", "why", "risks"]}},
                              "summary": {"type": "string", "description": "Korean, 2-4 sentences: what was checked "
                                          "and why the others were not proposed"}},
                              "required": ["proposals", "summary"]}}}}


def rank(ctx, candidates: list, news: list) -> dict:
    if not candidates:
        return {"proposals": [], "summary": ""}
    base = "\n".join(f"- {kind}: {label} ({note})" for kind, rows in BASELINES.items() for _, label, note in rows)
    cands = [{k: c[k] for k in ("hfRepo", "kind", "pipeline", "license", "commercialOk", "vramGb", "instance", "fits",
                                "inference", "likes", "createdAt", "lastModified", "gated")} | {"card": c.get("card", "")}
             for c in candidates]
    prompt = (f"Today: {datetime.now(KST).strftime('%Y-%m-%d')} KST.\nModels IPverse Studio runs today (the baselines "
              f"to beat):\n{base}\n\nCandidates (already filtered: open license, recent, inference path exists; "
              f"model cards truncated):\n{json.dumps(cands, ensure_ascii=False)}\n\n"
              + (f"Recent web news:\n{json.dumps(news, ensure_ascii=False)}\n\n" if news else "")
              + f"Pick at most {MAX_PROPOSALS_PER_RUN} candidates that are clearly better than the baseline of their "
                "kind (quality, prompt following, editing with references, speed at equal quality, longer or better "
                "video) and are original models, not re-uploads or fine-tunes of one style. Prefer models that fit one "
                "L40S. Propose nothing when none is clearly better. Write why/risks in Korean, keep names and numbers."
              + _in_english())
    resp = ctx.bedrock_rt_east.converse(
        modelId=ctx.agent_model_id,
        system=[{"text": "You are the open-weight model scout of IPverse Studio, a game and media IP studio that "
                         "generates characters, props, backgrounds and trailers on its own GPUs. Be strict and "
                         "evidence-based: a model is better only if its card or a credible benchmark says so. Answer only by calling the "
                         "propose tool (an empty proposals list when none is clearly better)."}],
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        toolConfig={"tools": [RANK_TOOL], "toolChoice": {"auto": {}}},
        inferenceConfig={"maxTokens": 4096})
    out = next((c["toolUse"]["input"] for c in resp["output"]["message"]["content"] if "toolUse" in c), None) or {}
    by_repo = {c["hfRepo"]: c for c in candidates}
    picked = []
    for p in out.get("proposals") or []:
        c = by_repo.get(str(p.get("hfRepo") or ""))
        if c and c["hfRepo"] not in {x["hfRepo"] for x in picked}:  # never a repo the filters did not pass
            picked.append({**c, "label": str(p.get("label") or c["hfRepo"].split("/")[-1])[:120],
                           "why": str(p.get("why") or "")[:2000], "risks": str(p.get("risks") or "")[:2000],
                           "editCapable": bool(p.get("editCapable")) and c["kind"] == "image"})
    return {"proposals": picked[:MAX_PROPOSALS_PER_RUN], "summary": str(out.get("summary") or "")[:2000]}


def proposal_body(p: dict) -> str:
    kind = (tr("이미지 (레퍼런스 편집 가능)") if p.get("editCapable") else tr("이미지")) if p["kind"] == "image" else tr("영상")
    vram = tr("약 {gb} GB(bf16 추정)", gb=p["vramGb"]) if p.get("vramGb") else tr("모델 카드에 크기 정보 없음")
    fits = tr("L40S 48 GB 한 장에 들어감") if p.get("fits", True) else tr("L40S 한 장을 넘음(오프로드/멀티 GPU 필요)")
    lic = f"{p['license']} — " + (tr("상업 이용 가능") if p.get("commercialOk") else tr("상업 이용 불가 또는 조건부(확인 필요)"))
    hours = TRIAL_HOURS[p["kind"]]
    cost = INSTANCE_COST.get(p["instance"], 0)
    return (f"**{p['label']}** (`{p['hfRepo']}`) · {kind}\n\n"
            + tr("- 왜 더 나은가: {why}\n- 위험: {risks}\n", why=p.get("why") or "-", risks=p.get("risks") or "-")
            + tr("- VRAM: {vram} · {fits} · 인스턴스 {instance}\n- 라이선스: {lic}\n", vram=vram, fits=fits,
                 instance=p["instance"], lic=lic)
            + tr("- 추론 경로: {inference}\n", inference=p.get("inference") or "-")
            + f"- Hugging Face: https://huggingface.co/{p['hfRepo']}\n\n"
            + tr("**테스트**를 누르면 {instance}(시간당 약 ${cost}, 최대 {hours}시간)에 모델을 설치해 지금 모델과 같은 "
                 "프롬프트로 결과를 만들어 비교합니다. 통과하면 **승인**으로 다음 요청부터 이 모델을 고를 수 있습니다.",
                 instance=p["instance"], cost=f"{cost:.2f}", hours=hours))


def run_scout(ctx, sub: str, agent: dict) -> str:
    stats: dict = {}
    candidates = scout_candidates(ctx, sub, stats)
    news = []
    try:
        month = datetime.now(KST).strftime("%B %Y")
        news = web_search(ctx, f"new open-weight image generation model release {month}") + \
            web_search(ctx, f"new open-source text-to-video model release {month}")
    except Exception:  # noqa: BLE001 — the Hub data alone is enough
        traceback.print_exc()
    ranked = rank(ctx, candidates, news)
    # written when the scout runs, in the language of the account's latest request (run_agent, account_lang)
    checked = tr("Hugging Face에서 {listed}개 모델을 확인했고, 필터를 통과한 후보 {candidates}개를 기준 모델과 비교했습니다 "
                 "(이미 제안·승인됨 {seen}, 파생·기준 모델 {derived}, 오래됨 {old}, 라이선스 {license}, 추론 코드 없음 "
                 "{no_inference}).", listed=stats.get("listed", 0), candidates=stats.get("candidates", 0),
                 seen=stats.get("seen", 0), derived=stats.get("derived_or_baseline", 0), old=stats.get("old", 0),
                 license=stats.get("license", 0), no_inference=stats.get("no_inference", 0))
    agent = {**agent, "name": tr(SCOUT_NAME)}  # the note's sender, as the list names the built-in
    for p in ranked["proposals"]:
        pid = store.new_id("prop")
        note = put_note(ctx, sub, agent, tr("모델 제안: {label} ({kind})", label=p["label"],
                                            kind=tr("이미지") if p["kind"] == "image" else tr("영상")),
                        proposal_body(p), pid)
        store._put(ctx, _prop_pk(sub), pid, {
            "proposalId": pid, "noteId": note["noteId"], "createdAt": store.now(), "status": "proposed",
            **{k: p.get(k) for k in ("kind", "hfRepo", "label", "license", "commercialOk", "vramGb", "instance", "why",
                                     "risks", "editCapable", "inference", "fits")},
            "slug": promoted_slug(p["label"])})
    if not ranked["proposals"]:
        put_note(ctx, sub, agent, tr("조사 완료 — 지금 모델보다 나은 새 후보 없음"),
                 f"{checked}\n\n{ranked['summary'] or tr('오늘은 제안할 모델이 없습니다.')}")
    return tr("제안 {n}건. {checked}", n=len(ranked["proposals"]), checked=checked)


# ── custom agents: a Converse tool loop ─────────────────────────────────────────

def tool_fetch_url(ctx, url: str) -> dict:
    u = urllib.parse.urlparse(str(url))
    if u.scheme not in ("http", "https") or not u.hostname or not _public_host(u.hostname):
        return {"error": "only public http(s) URLs can be fetched"}
    try:
        raw = http_get(url, accept="text/html,application/json,*/*").decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}
    if raw.lstrip().startswith("<"):
        raw = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", raw)
        raw = html.unescape(re.sub(r"(?s)<[^>]+>", " ", raw))
    text = re.sub(r"\s+", " ", raw).strip()
    return {"url": url, "text": text[:FETCH_MAX_CHARS], "truncated": len(text) > FETCH_MAX_CHARS}


def tool_hf_models(ctx, pipeline_tag: str, sort: str = "trendingScore", limit: int = 20) -> dict:
    if pipeline_tag not in PIPELINES and not re.fullmatch(r"[a-z0-9-]{2,40}", str(pipeline_tag)):
        return {"error": "bad pipeline_tag"}
    rows = hf_models(pipeline_tag, sort if sort in ("trendingScore", "likes", "downloads", "lastModified") else
                     "trendingScore", max(1, min(int(limit), 40)))
    return {"models": [{"id": m.get("id"), "likes": m.get("likes"), "createdAt": m.get("createdAt"),
                        "lastModified": m.get("lastModified"), "license": license_of(m),
                        "library": m.get("library_name")} for m in rows]}


def tool_web_search(ctx, query: str, max_results: int = 6) -> dict:
    return {"results": web_search(ctx, query, max_results)}


AGENT_TOOLS = {
    "fetch_url": ({"name": "fetch_url", "description": "Fetch a public web page and return its text (first ~12k chars).",
                   "inputSchema": {"json": {"type": "object", "properties": {"url": {"type": "string"}},
                                            "required": ["url"]}}}, tool_fetch_url),
    "hf_models": ({"name": "hf_models", "description": "List Hugging Face Hub models for a pipeline tag "
                   "(text-to-image, image-to-image, text-to-video, image-to-video, ...).",
                   "inputSchema": {"json": {"type": "object", "properties": {
                       "pipeline_tag": {"type": "string"}, "sort": {"type": "string",
                                                                    "enum": ["trendingScore", "likes", "lastModified"]},
                       "limit": {"type": "integer"}}, "required": ["pipeline_tag"]}}}, tool_hf_models),
    "web_search": ({"name": "web_search", "description": "Search the web: titles, URLs, dates and snippets.",
                    "inputSchema": {"json": {"type": "object", "properties": {
                        "query": {"type": "string"}, "max_results": {"type": "integer"}}, "required": ["query"]}}},
                   tool_web_search),
}
NOTIFY_SPEC = {"name": "notify", "description": "Post a note to the user's inbox (the only way to tell the user "
               "anything). Korean, markdown body, cite source URLs.",
               "inputSchema": {"json": {"type": "object", "properties": {
                   "title": {"type": "string"}, "body": {"type": "string"}}, "required": ["title", "body"]}}}


def run_custom(ctx, sub: str, agent: dict) -> str:
    deadline = time.monotonic() + RUN_BUDGET_SEC
    names = [n for n in AGENT_TOOLS if n != "web_search" or _env("WEBSEARCH_GATEWAY_URL")]
    tool_config = {"tools": [{"toolSpec": AGENT_TOOLS[n][0]} for n in names] + [{"toolSpec": NOTIFY_SPEC}]}
    system = [{"text": f"You are '{agent['name']}', an autonomous agent of IPverse Studio. Now: "
                       f"{datetime.now(KST).strftime('%Y-%m-%d %H:%M')} KST. You run unattended: nobody answers "
                       "questions. Use your tools, tell the user with notify, then end with a one-paragraph Korean "
                       f"summary.{_in_english()}\n\nYour instructions:\n{agent['instructions']}"}]
    messages = [{"role": "user", "content": [{"text": "지금 실행하세요."}]}]
    notes = 0
    for _ in range(AGENT_MAX_TURNS):
        if time.monotonic() > deadline:
            return tr("시간 제한으로 멈췄습니다 (알림 {n}건).", n=notes)
        resp = ctx.bedrock_rt_east.converse(modelId=ctx.agent_model_id, system=system, messages=messages,
                                            toolConfig=tool_config, inferenceConfig={"maxTokens": 4096})
        msg = resp["output"]["message"]
        messages.append(msg)
        uses = [c["toolUse"] for c in msg["content"] if "toolUse" in c]
        if not uses:
            text = " ".join(c.get("text", "") for c in msg["content"]).strip()
            return tr("{text} (알림 {n}건)", text=text or tr("완료했습니다."), n=notes)
        results = []
        for u in uses:
            try:
                if u["name"] == "notify":
                    put_note(ctx, sub, agent, str(u["input"].get("title") or agent["name"]),
                             str(u["input"].get("body") or ""))
                    notes += 1
                    out = {"ok": True}
                elif u["name"] in names:
                    out = AGENT_TOOLS[u["name"]][1](ctx, **u["input"])
                else:
                    out = {"error": f"unknown tool {u['name']}"}
            except Exception as e:  # noqa: BLE001 — the model sees the error and adapts
                out = {"error": str(e)[:500]}
            results.append({"toolResult": {"toolUseId": u["toolUseId"], "content": [{"json": out}],
                                           **({"status": "error"} if "error" in out else {})}})
        messages.append({"role": "user", "content": results})
    return tr("최대 단계 수에서 멈췄습니다 (알림 {n}건).", n=notes)


# ── promoted models (the registry is the boxes' EC2 tags) ───────────────────────

def promoted_slug(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(label or "").lower()).strip("-")[:40]
    return f"m-{slug}" if not slug or slug in RESERVED_SLUGS else slug


def promoted_boxes(ctx) -> list:
    resp = ctx.ec2.describe_instances(Filters=[
        {"Name": "tag:mediagen-promoted", "Values": ["true"]},
        {"Name": "instance-state-name", "Values": ["pending", "running", "stopping", "stopped"]}])
    out = []
    for r in resp.get("Reservations", []):
        for i in r.get("Instances", []):
            tags = {t["Key"]: t["Value"] for t in i.get("Tags", [])}
            out.append({"slug": tags.get("mediagen", ""), "label": tags.get("mediagen-label", ""),
                        "hfRepo": tags.get("mediagen-hf", ""), "instanceId": i["InstanceId"],
                        # running | stopped | …: an edit's wait has the boot in it only when the box is not up (waits.py)
                        "state": (i.get("State") or {}).get("Name", ""),
                        "kinds": [k for k in tags.get("mediagen-kinds", "").split(",") if k]})
    return out


def promoted_registry(ctx) -> list:
    """What IPverse promoted, with what each model is good at (the chat agent's prompt, the catalogs' fallback)."""
    return [store._strip(i) for i in store._query(ctx, "AGENTPROMOTED")]


def promoted_image_models(ctx) -> list:
    """Catalog rows for promoted image models from the registry (used while the MCP cannot be read)."""
    return [{"id": p["slug"], "label": p.get("label") or p["slug"], "kinds": p.get("kinds") or ["t2i"],
             "promoted": True, "hfRepo": p.get("hfRepo", "")}
            for p in promoted_registry(ctx) if p.get("kind") == "image"]


# ── GPU trials ─────────────────────────────────────────────────────────────────

def _lock(ctx, tid: str) -> bool:
    """One trial box at a time (account-wide): AGENTLOCK/trial holds the running trial's id."""
    if store._update(ctx, "AGENTLOCK", "trial", {"trialId": tid, "at": store.now()}, expect={"trialId": None}):
        return True
    held = store._get(ctx, "AGENTLOCK", "trial") or {}
    t = get_trial(ctx, held.get("trialId"))
    if t and t.get("status") in ("launching", "running"):
        return False
    _unlock(ctx)  # a stale lock (its trial ended without releasing it)
    return store._update(ctx, "AGENTLOCK", "trial", {"trialId": tid, "at": store.now()}, expect={"trialId": None})


def _unlock(ctx, tid: str = None) -> None:
    held = store._get(ctx, "AGENTLOCK", "trial") or {}
    if tid is None or held.get("trialId") == tid:
        store._put(ctx, "AGENTLOCK", "trial", {"free": True, "at": store.now()})


def baseline_key(mode: str, prompt: str) -> str:
    return f"{mode}#" + hashlib.sha256(prompt.encode()).hexdigest()[:16]


def baseline_map(ctx) -> dict:
    out = {}
    for b in (store._strip(i) for i in store._query(ctx, "AGENTBASE")):
        out[(b.get("mode"), b.get("prompt"))] = b
    return out


def reference_url(ctx) -> str | None:
    """The i2i / i2v test input: the Krea baseline of IMAGE_PROMPTS[0] (None until it exists)."""
    b = baseline_map(ctx).get(("t2i", IMAGE_PROMPTS[0])) or {}
    return b.get("url") if b.get("status") == "SUCCEEDED" else None


def bench_for(kind: str, ref: str | None) -> list:
    return [{"mode": mode, "prompt": prompt, **({"referenceUrl": ref} if needs_ref and ref else {})}
            for mode, prompt, _, _, needs_ref in BENCH if mode in MODES[kind]]


def user_data(ctx, trial: dict) -> str:
    """The box's whole setup. No secrets: the box reads the HF token from SSM itself (HF_TOKEN_PARAM). The trial
    agent is too big for user-data's 16 KB limit, so launch puts it in S3 next to the status files."""
    out_bucket = _env("TRIAL_OUTPUT_BUCKET", "mediagen-out-087967639890-us-east-1")
    prefix = f"agents/trials/{trial['trialId']}/"
    cfg = {"trialId": trial["trialId"], "region": "us-east-1", "bucket": ctx.assets_bucket, "prefix": prefix,
           "outBucket": out_bucket, "cdn": _env("TRIAL_OUTPUT_CDN", "d511j70n4osuv.cloudfront.net"),
           "kind": trial["kind"], "label": trial["label"], "hfRepo": trial["hfRepo"], "slug": trial["slug"],
           "editCapable": bool(trial.get("editCapable")), "instanceType": trial["instanceType"],
           "modelId": ctx.agent_model_id, "maxHours": trial["maxHours"], "bench": trial["bench"]}
    minutes = int(trial["maxHours"] * 60)
    param = _env("HF_TOKEN_PARAM", "/mediagen/hf-token")
    return f"""#!/bin/bash
# Hard stop first: shutdown terminates this instance (InstanceInitiatedShutdownBehavior=terminate).
shutdown -h +{minutes}
mkdir -p /opt/trial /opt/models
cat > /opt/trial/env.json <<'CFG'
{json.dumps(cfg, ensure_ascii=False)}
CFG
aws s3 cp s3://{ctx.assets_bucket}/{prefix}trial_agent.py /opt/trial/trial_agent.py --region us-east-1
mkdir -p /opt/mg && aws s3 cp s3://{out_bucket}/code/common/jobserver.py /opt/mg/jobserver.py --region us-east-1
mkdir -p /root/.cache/huggingface
aws ssm get-parameter --region us-east-1 --name {param} --with-decryption \\
  --query Parameter.Value --output text > /root/.cache/huggingface/token
chmod 600 /root/.cache/huggingface/token
PY=/opt/pytorch/bin/python; [ -x "$PY" ] || PY=python3
$PY -m pip install -q -U boto3 >/dev/null 2>&1 || true
cd /opt/trial && HOME=/root HF_HOME=/root/.cache/huggingface $PY trial_agent.py >> /var/log/trial.log 2>&1
aws s3 cp /var/log/trial.log s3://{ctx.assets_bucket}/{prefix}trial.log --region us-east-1 || true
# A passing box waits for the sweeper to park it (stopped) until 승인; +60 is the safety net if it never comes.
if [ -f /opt/mg/promote ]; then shutdown -c; shutdown -h +60; else shutdown -h now; fi
"""


def _subnets(ctx) -> list:
    resp = ctx.ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [_env("TRIAL_VPC", "vpc-0048f3a571ac6b876")]},
                                             {"Name": "default-for-az", "Values": ["true"]}])
    return [s["SubnetId"] for s in resp.get("Subnets", [])]


def _launch_in_any_az(ctx, trial: dict) -> tuple:
    ud = user_data(ctx, trial)
    tags = [{"Key": "Name", "Value": f"ipverse-trial-{trial['hfRepo'].split('/')[-1]}"[:250]},
            {"Key": "mediagen", "Value": "trial"}, {"Key": "ipverse-trial", "Value": trial["trialId"]}]
    ec2 = getattr(ctx, "ec2_launch", None) or ctx.ec2
    last = ""
    for subnet in _subnets(ctx):
        try:
            resp = ec2.run_instances(
                ImageId=_env("TRIAL_AMI", "ami-012ba162b9cd2729c"), InstanceType=trial["instanceType"],
                MinCount=1, MaxCount=1, SubnetId=subnet, SecurityGroupIds=[_env("TRIAL_SECURITY_GROUP")],
                IamInstanceProfile={"Arn": _env("TRIAL_INSTANCE_PROFILE_ARN")},
                InstanceInitiatedShutdownBehavior="terminate", UserData=ud,
                BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {
                    "VolumeSize": ROOT_GB, "VolumeType": "gp3", "DeleteOnTermination": True}}],
                MetadataOptions={"HttpTokens": "required", "HttpPutResponseHopLimit": 2},
                TagSpecifications=[{"ResourceType": "instance", "Tags": tags}, {"ResourceType": "volume", "Tags": tags}])
            return resp["Instances"][0]["InstanceId"], ""
        except ClientError as e:
            code = e.response["Error"]["Code"]
            last = f"{code}: {e.response['Error'].get('Message', '')}"
            print(f"[agents] run_instances {trial['instanceType']} in {subnet}: {last[:200]}")
            if code not in CAPACITY_ERRORS:
                break
    return "", last


def launch_trial(ctx, trial: dict) -> str:
    """Start the box: the next AZ on a capacity miss, then a fallback size. Sets trial instanceType/tried."""
    tried, last = trial.setdefault("tried", []), ""
    ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=f"agents/trials/{trial['trialId']}/trial_agent.py",
                      Body=(Path(__file__).parent / "trial_agent.py").read_bytes(), ContentType="text/x-python")
    for it in [trial["instanceType"], *INSTANCE_FALLBACKS.get(trial["instanceType"], [])]:
        trial["instanceType"] = it
        tried.append(it)
        iid, last = _launch_in_any_az(ctx, trial)
        if iid:
            return iid
        if not last.startswith(CAPACITY_ERRORS):
            # the refusal itself is in the log (_launch_in_any_az prints it)
            raise AgentError(409, "launch_failed", "GPU 서버를 시작하지 못했어요. 잠시 뒤 ‘테스트’를 다시 눌러 주세요.")
    raise AgentError(409, "no_capacity", f"지금은 AWS에 남는 GPU 서버({', '.join(tried)})가 없어 테스트를 시작하지 못했어요. "
                                         "잠시 뒤 ‘테스트’를 다시 눌러 주세요.")


def _save_trial(ctx, t: dict) -> None:
    store._put(ctx, "AGENTTRIAL", t["trialId"], {k: v for k, v in t.items() if v is not None})


def _set_prop(ctx, sub, pid, **fields) -> None:
    store._update(ctx, _prop_pk(sub), pid, fields)


def test_proposal(ctx, user, pid) -> dict:
    sub = user["sub"]
    p = get_proposal(ctx, sub, pid)
    if p["status"] not in ("proposed", "failed"):
        raise AgentError(409, "not_testable", "이 제안은 지금 테스트할 수 없어요. 이미 테스트 중이거나 끝난 제안이에요.")
    taken = [m for m in promoted_boxes(ctx) if m["hfRepo"].lower() == p["hfRepo"].lower()]
    if taken:
        raise AgentError(409, "already_promoted", f"{p.get('label') or p['hfRepo']}은(는) 이미 승인해서 쓰고 있는 모델이에요.")
    tid = _time_id("tr_")
    if not _lock(ctx, tid):
        raise AgentError(409, "trial_running", "다른 모델을 테스트하는 중이에요. 끝난 뒤 다시 눌러 주세요.")
    kind = p["kind"]
    trial = {"trialId": tid, "sub": sub, "proposalId": pid, "kind": kind, "hfRepo": p["hfRepo"], "label": p["label"],
             "slug": p.get("slug") or promoted_slug(p["label"]), "editCapable": bool(p.get("editCapable")),
             "instanceType": p.get("instance") if p.get("instance") in INSTANCE_COST else
             ("g6e.2xlarge" if kind == "image" else "g6e.4xlarge"),
             "maxHours": TRIAL_HOURS[kind], "status": "launching", "phase": "GPU 재고 찾는 중", "startedAt": store.now(),
             "bench": bench_for(kind, reference_url(ctx))}
    _save_trial(ctx, trial)
    _set_prop(ctx, sub, pid, status="testing", trialId=tid)
    try:
        ctx.lambda_.invoke(FunctionName=_env("SELF_FUNCTION_NAME", "ipverse-api"), InvocationType="Event",
                           Payload=json.dumps({"action": "agents_launch", "trialId": tid}))
    except Exception as e:  # no launch will run: undo now
        traceback.print_exc()
        _finish(ctx, trial, "failed", tr("테스트를 시작하지 못했습니다: {why}", why=e)[:500])
    return public_proposal(ctx, get_proposal(ctx, sub, pid))


def run_launch(ctx, tid: str) -> dict:
    t = get_trial(ctx, tid)
    if not t or t.get("status") != "launching" or t.get("instanceId"):
        return {"skipped": (t or {}).get("status")}
    i18n.use(account_lang(ctx, t["sub"]))  # a refusal is kept as the trial's error, for the account that pressed 테스트
    try:
        t["instanceId"] = launch_trial(ctx, t)
        t["phase"] = "GPU 서버 켜는 중"
        _save_trial(ctx, t)
    except AgentError as e:
        _finish(ctx, t, "failed", e.message[:1000])
    return {"status": t["status"], "instanceType": t["instanceType"]}


def _finish(ctx, t: dict, status: str, error: str = None, **fields) -> None:
    """A trial ends: passed (box parked) or failed. The proposal follows; the lock is released."""
    t.update(status=status, phase="done" if status == "failed" else "승인 대기", finishedAt=store.now(),
             error=error, **fields)
    _save_trial(ctx, t)
    _set_prop(ctx, t["sub"], t["proposalId"], status="passed" if status == "passed" else "failed")
    _unlock(ctx, t["trialId"])


def _s3_json(ctx, key: str):
    try:
        raw = ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=key)["Body"].read()
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404", "AccessDenied"):
            return None
        raise
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _s3_tail(ctx, key: str, n: int = 1500) -> str:
    try:
        return ctx.s3.get_object(Bucket=ctx.assets_bucket, Key=key)["Body"].read().decode("utf-8", "replace")[-n:]
    except Exception:  # noqa: BLE001
        return ""


def _state(ctx, iid: str) -> str:
    try:
        r = ctx.ec2.describe_instances(InstanceIds=[iid]).get("Reservations") or []
        return r[0]["Instances"][0]["State"]["Name"] if r else "terminated"
    except ClientError:
        return "terminated"


def _terminate(ctx, iid: str) -> None:
    try:
        ctx.ec2.terminate_instances(InstanceIds=[iid])
    except ClientError as e:
        print(f"[agents] terminate {iid}: {e}")


def _verified_kinds(kind: str, result: dict) -> list:
    """A kind is offered only if the benchmark rendered it: the box's per-kind check outranks its kinds list."""
    checks = result.get("metrics") if isinstance(result.get("metrics"), dict) else {}
    first = MODES[kind][0]
    kinds = [k for k in result.get("kinds") or [] if k in MODES[kind] and checks.get(k, "verified") == "verified"]
    return kinds if first in kinds else [first, *kinds]


def advance_trial(ctx, t: dict) -> None:
    tid = t["trialId"]
    started = _parse(t.get("startedAt")) or _now_dt()
    if t["status"] == "passed":  # parked: waiting for 승인
        if _now_dt() > (_parse(t.get("finishedAt")) or started) + timedelta(days=PARK_DAYS) and t.get("instanceId"):
            _terminate(ctx, t["instanceId"])
            t.update(status="failed", error=tr("{days}일 안에 승인하지 않아 GPU 서버를 정리했어요. 쓰려면 다시 테스트해 주세요.",
                                               days=PARK_DAYS))
            _save_trial(ctx, t)
            _set_prop(ctx, t["sub"], t["proposalId"], status="failed")
        return
    if not t.get("instanceId"):
        if _now_dt() > started + timedelta(minutes=LAUNCH_STALE_MIN):
            _finish(ctx, t, "failed", tr("GPU 서버가 켜지지 않았어요. 다시 테스트해 주세요."))
        return
    prefix = f"agents/trials/{tid}/"
    status = _s3_json(ctx, prefix + "status.json")
    if status:
        t.update(status="running", phase=str(status.get("phase", ""))[:200], message=str(status.get("message", ""))[:1000])
    result = _s3_json(ctx, prefix + "result.json")
    state = _state(ctx, t["instanceId"])
    overdue = _now_dt() > started + timedelta(hours=float(t.get("maxHours", 3)), minutes=20)
    if result:
        ok = result.get("status") == "succeeded" and bool(result.get("outputs"))
        fields = {"outputs": result.get("outputs") or [], "metrics": result.get("metrics") or {},
                  "notes": str(result.get("notes") or "")[:4000]}
        if ok and result.get("promotable") and state in ("pending", "running", "stopping", "stopped"):
            try:  # park it: a stop (not the user-data's terminate) keeps the disk with the installed model
                ctx.ec2.modify_instance_attribute(InstanceId=t["instanceId"],
                                                  InstanceInitiatedShutdownBehavior={"Value": "stop"})
                ctx.ec2.stop_instances(InstanceIds=[t["instanceId"]])
                _finish(ctx, t, "passed", None, kinds=_verified_kinds(t["kind"], result), **fields)
                _trial_note(ctx, t)
                return
            except ClientError:
                traceback.print_exc()
                error = tr("결과는 나왔지만 GPU 서버를 보관하지 못했어요. 다시 테스트해 주세요.")
        elif ok:
            error = tr("결과는 나왔지만 GPU 서버를 승인용으로 보관하지 못했어요: {why}",
                       why=str(result.get("promoteError") or state))
        else:
            error = str(result.get("error") or tr("테스트 실패"))[:2000]
        if state not in ("terminated", "shutting-down"):
            _terminate(ctx, t["instanceId"])
        _finish(ctx, t, "failed", error[:2000], **fields)
        _trial_note(ctx, t)
        return
    if state in ("shutting-down", "terminated", "stopped") or overdue:
        if state not in ("terminated", "shutting-down"):
            _terminate(ctx, t["instanceId"])
        _finish(ctx, t, "failed", (tr("시간 초과") if overdue else tr("결과 없이 인스턴스가 {state}됨", state=state))
                + ("\n" + _s3_tail(ctx, prefix + "trial.log") if not overdue else ""))
        _trial_note(ctx, t)
        return
    if status:
        _save_trial(ctx, t)


def _trial_note(ctx, t: dict) -> None:
    hours = max(0.0, ((_parse(t.get("finishedAt")) or _now_dt()) - (_parse(t.get("startedAt")) or _now_dt()))
                .total_seconds() / 3600)
    cost = hours * INSTANCE_COST.get(t.get("instanceType"), 0)
    scout = {"agentId": SCOUT_ID, "name": tr(SCOUT_NAME)}
    if t["status"] == "passed":
        title = tr("GPU 테스트 통과: {label}", label=t["label"])
        body = tr("**{label}** (`{repo}`)를 {instance}에서 설치하고 지금 모델과 같은 프롬프트로 결과를 만들었습니다 ({kinds}). "
                  "비교해 보고 **승인**하면 다음 요청부터 이 모델을 고를 수 있습니다. GPU 서버는 정지 상태로 {days}일 동안 "
                  "승인을 기다립니다 (디스크 월 약 ${disk}).", label=t["label"], repo=t["hfRepo"],
                  instance=t["instanceType"], kinds=", ".join(t.get("kinds") or []), days=PARK_DAYS,
                  disk=f"{STOPPED_DISK_MONTHLY:.0f}") + f"\n\n{t.get('notes') or ''}"
    else:
        title = tr("GPU 테스트 실패: {label}", label=t["label"])
        body = (tr("`{repo}` 테스트가 실패했습니다.", repo=t["hfRepo"])
                + f"\n\n```\n{(t.get('error') or '')[-1500:]}\n```\n\n{t.get('notes') or ''}")
    body += "\n\n" + tr("인스턴스 사용 약 {hours}시간 (약 ${cost}).", hours=f"{hours:.1f}", cost=f"{cost:.2f}")
    put_note(ctx, t["sub"], scout, title, body, t["proposalId"])


def approve(ctx, user, pid) -> dict:
    """승인: the parked box joins the fleet. Every EC2 call is made while it still carries mediagen=trial (the IAM
    condition); the registry tags go LAST."""
    sub = user["sub"]
    p = get_proposal(ctx, sub, pid)
    if p["status"] != "passed":
        raise AgentError(409, "not_passed", "테스트를 통과한 제안만 승인할 수 있어요. 먼저 ‘테스트’를 눌러 주세요.")
    t = get_trial(ctx, p.get("trialId"))
    if not t or not t.get("instanceId") or _state(ctx, t["instanceId"]) in ("terminated", "shutting-down"):
        raise AgentError(409, "box_gone", "테스트한 GPU 서버가 정리되고 없어요. ‘테스트’를 다시 눌러 주세요.")
    slug, iid = t["slug"], t["instanceId"]
    taken = [m for m in promoted_boxes(ctx) if (m["slug"] == slug or m["hfRepo"].lower() == t["hfRepo"].lower())
             and m["instanceId"] != iid]
    if taken:
        raise AgentError(409, "already_promoted", f"{taken[0]['label'] or taken[0]['slug']}은(는) 이미 승인해서 쓰고 있어요.")
    kinds = t.get("kinds") or [MODES[t["kind"]][0]]
    try:
        _promote_box(ctx, t, iid, slug, kinds)
    except ClientError as e:  # e.g. the box is still stopping from its parking: every step is safe to repeat
        traceback.print_exc()
        raise AgentError(409, "promote_failed", "GPU 서버를 연결하지 못했어요. 잠시 뒤 ‘승인’을 다시 눌러 주세요.") from None
    store._put(ctx, "AGENTPROMOTED", slug, {
        "slug": slug, "kind": t["kind"], "label": t["label"], "hfRepo": t["hfRepo"], "kinds": kinds,
        "why": p.get("why", ""), "risks": p.get("risks", ""), "license": p.get("license"),
        "commercialOk": p.get("commercialOk"), "promotedAt": store.now(), "instanceId": iid, "sub": sub})
    t.update(phase="승인됨", promoted=slug)
    _save_trial(ctx, t)
    _set_prop(ctx, sub, pid, status="promoted")
    _forget_catalogs()
    put_note(ctx, sub, {"agentId": SCOUT_ID, "name": tr(SCOUT_NAME)}, tr("승인 완료: {label}", label=t["label"]),
             tr("**{label}**을(를) `{slug}`로 연결했습니다 ({kinds}). 다음 요청부터 {kind} 모델 목록에서 고를 수 있고, "
                "채팅에서 이름으로 말해도 됩니다. 기본 모델은 그대로입니다. GPU 서버는 정지해 두었다가 첫 요청에 "
                "켜지고(~10분), 20분 쉬면 스스로 정지합니다.", label=t["label"], slug=slug, kinds=", ".join(kinds),
                kind=tr("이미지") if t["kind"] == "image" else tr("영상")),
             pid)
    return public_proposal(ctx, get_proposal(ctx, sub, pid))


def _promote_box(ctx, t: dict, iid: str, slug: str, kinds: list) -> None:
    ec2 = ctx.ec2
    ec2.modify_instance_attribute(InstanceId=iid, InstanceInitiatedShutdownBehavior={"Value": "stop"})
    ec2.modify_instance_attribute(InstanceId=iid, Groups=[_env("FLEET_SECURITY_GROUP", "sg-07314d21c31296a92")])
    assoc = ec2.describe_iam_instance_profile_associations(Filters=[
        {"Name": "instance-id", "Values": [iid]},
        # a stopped box's new association stays "associating" until it starts
        {"Name": "state", "Values": ["associated", "associating"]}]).get(
        "IamInstanceProfileAssociations") or []
    fleet = _env("FLEET_INSTANCE_PROFILE_ARN", "arn:aws:iam::087967639890:instance-profile/mediagen-promoted-instance")
    if not assoc:  # a retry after the disassociate below: attach the fleet profile
        ec2.associate_iam_instance_profile(InstanceId=iid, IamInstanceProfile={"Arn": fleet})
    elif assoc[0]["IamInstanceProfile"]["Arn"] != fleet:
        try:
            ec2.replace_iam_instance_profile_association(IamInstanceProfile={"Arn": fleet},
                                                         AssociationId=assoc[0]["AssociationId"])
        except ClientError as e:
            # a just-parked box can answer IncorrectState ("... is not the active association") although describe
            # says associated; a disassociate then associate works
            if e.response["Error"]["Code"] != "IncorrectState":
                raise
            ec2.disassociate_iam_instance_profile(AssociationId=assoc[0]["AssociationId"])
            ec2.associate_iam_instance_profile(InstanceId=iid, IamInstanceProfile={"Arn": fleet})
    ec2.stop_instances(InstanceIds=[iid])
    ec2.create_tags(Resources=[iid], Tags=[{"Key": k, "Value": v[:256]} for k, v in {
        "mediagen": slug, "mediagen-promoted": "true", "mediagen-label": t["label"], "mediagen-hf": t["hfRepo"],
        "mediagen-kinds": ",".join(kinds), "mediagen-trial": t["trialId"], "Name": f"mediagen-{slug}"}.items()])


def dismiss(ctx, user, pid) -> dict:
    sub = user["sub"]
    p = get_proposal(ctx, sub, pid)
    if p["status"] == "promoted":
        raise AgentError(409, "promoted", "이미 승인한 모델은 거절할 수 없어요.")
    t = get_trial(ctx, p.get("trialId"))
    if t and t.get("status") in ("launching", "running", "passed"):
        if t.get("instanceId"):
            _terminate(ctx, t["instanceId"])
        t.update(status="failed", phase="done", finishedAt=store.now(), error=tr("사용자가 거절했습니다"))
        _save_trial(ctx, t)
        _unlock(ctx, t["trialId"])
    _set_prop(ctx, sub, pid, status="dismissed")
    return public_proposal(ctx, get_proposal(ctx, sub, pid))


def _forget_catalogs() -> None:
    from server import connections
    from server.providers import mediagen_video
    connections._image_catalog.clear()
    mediagen_video._catalog.clear()


# ── baselines (once, reused by every trial) ─────────────────────────────────────

def ensure_baselines(ctx) -> None:
    """One step per sweep for each benchmark prompt's baseline: start it, or poll it and keep the result. Images are
    copied to the assets bucket (served under /sessions/*), clips keep their mediagen CDN URL."""
    base = baseline_map(ctx)
    ref = reference_url(ctx)
    for mode, prompt, model, label, needs_ref in BENCH:
        item = base.get((mode, prompt)) or {"mode": mode, "prompt": prompt, "model": model, "attempts": 0}
        sk = baseline_key(mode, prompt)
        if item.get("status") == "SUCCEEDED" or (item.get("status") == "FAILED"
                                                 and int(item.get("attempts") or 0) >= BASELINE_ATTEMPTS):
            continue
        if needs_ref and not ref:
            continue  # the Krea picture comes first
        image = mode in ("t2i", "i2i")
        endpoint = mcp_client.IMAGE if image else mcp_client.VIDEO
        try:
            if item.get("status") == "RUNNING":
                st = mcp_client.call_tool(ctx, endpoint, "get_image_status" if image else "ltx_get_status",
                                          {"job_id": item["jobId"]})
                if st.get("status") == "SUCCEEDED" and st.get("url"):
                    url = st["url"]
                    if image:
                        key = f"sessions/agents-bench/{sk.replace('#', '-')}.png"
                        ctx.s3.put_object(Bucket=ctx.assets_bucket, Key=key, Body=mcp_client.download(url),
                                          ContentType="image/png")
                        url = mcp_client.public_input_url(ctx, key)
                    item.update(status="SUCCEEDED", url=url)
                elif st.get("status") == "FAILED":
                    item.update(status="FAILED", error=str(st.get("error") or "")[:300])
                else:
                    continue
            else:
                if image:
                    args = {"prompt": prompt, "model": model, "style": "real", "seed": BENCH_SEED,
                            **({"reference_image_urls": [ref]} if needs_ref else {})}
                    job = mcp_client.call_tool(ctx, endpoint, "start_image", args)
                else:
                    job = mcp_client.call_tool(ctx, endpoint, "ltx_start_video", {
                        "prompt": prompt, "seconds": 5, "seed": BENCH_SEED, **({"image_url": ref} if needs_ref else {})})
                if not job.get("job_id"):
                    raise RuntimeError(str(job)[:200])
                item.update(status="RUNNING", jobId=job["job_id"], attempts=int(item.get("attempts") or 0) + 1,
                            startedAt=store.now())
            store._put(ctx, "AGENTBASE", sk, item)
        except Exception as e:  # noqa: BLE001 — retried on the next sweep
            print(f"[agents] baseline {sk}: {e}")


# ── sweep ──────────────────────────────────────────────────────────────────────

_demo_seeded: set = set()


def ensure_default_scouts(ctx) -> None:
    """The demo user's scout exists (and is scheduled) before anyone opens the page: looked up once per container."""
    pool = _env("USER_POOL_ID")
    if not pool or getattr(ctx, "cognito", None) is None:
        return
    for username in [u.strip() for u in _env("SCOUT_DEFAULT_USERS", "demo").split(",") if u.strip()]:
        if username in _demo_seeded:
            continue
        try:
            resp = ctx.cognito.admin_get_user(UserPoolId=pool, Username=username)
            sub = next((a["Value"] for a in resp.get("UserAttributes", []) if a["Name"] == "sub"), None)
            if sub:
                ensure_scout(ctx, {"sub": sub, "username": username})
            _demo_seeded.add(username)
        except Exception:  # noqa: BLE001 — no such user yet: tried again next container
            traceback.print_exc()


def sweep(ctx) -> dict:
    trials = [store._strip(i) for i in store._query(ctx, "AGENTTRIAL")]
    # ponytail: one partition read every 5 minutes; fine for hundreds of trials, archive old ones beyond that.
    active = [t for t in trials if t.get("status") in ("launching", "running", "passed")]
    for t in active:
        try:
            # its notes and errors are the account's to read; what the sweep does after it is not in its language
            with i18n.speaking(account_lang(ctx, t.get("sub", ""))):
                advance_trial(ctx, t)
        except Exception:  # noqa: BLE001 — one broken trial must not stop the others
            traceback.print_exc()
    if trials:  # the baselines are only worth generating once the feature is used
        ensure_baselines(ctx)
    ensure_default_scouts(ctx)
    return {"trials": len(active)}


# ── chat agent prompt ──────────────────────────────────────────────────────────

def prompt_block(ctx) -> str:
    """The promoted models the chat agent may use when the user picks them ("" when there are none)."""
    rows = promoted_registry(ctx)
    if not rows:
        return ""
    lines = []
    for p in sorted(rows, key=lambda r: r.get("promotedAt", "")):
        what = ("이미지 image_model" if p.get("kind") == "image" else "영상 model")
        caps = ", ".join(p.get("kinds") or [])
        edit = " reference_ip_id와 make_ip_variant(image_model)에도 쓸 수 있다(i2i)." if "i2i" in (p.get("kinds") or []) else ""
        lic = "" if p.get("commercialOk") else " 비상업 또는 조건부 라이선스라 상업용 결과물에는 쓰지 말라고 알린다."
        why = re.sub(r"\s+", " ", str(p.get("why") or ""))[:400]
        lines.append(f"- {p['slug']} = {p.get('label')} ({p.get('hfRepo')}, {what}, {caps}): {why}{edit}{lic}")
    return ("## 스카우트로 추가된 모델\n사용자가 승인한 오픈웨이트 모델이다. 사용자가 이름이나 id로 고를 때만 그 id를 "
            "쓰고, 기본 모델(이미지 krea·klein9, 영상 ltx)은 바뀌지 않는다. 정지된 GPU 서버는 첫 호출에 켜져 ~10분 더 "
            "걸린다: 이미지는 도구 결과 message의 시간을 그대로 말하고(서버가 이미 켜져 있으면 켜는 시간이 없다), 영상은 "
            "정지돼 있으면 ~10분 더 걸린다고 알린다.\n" + "\n".join(lines))
