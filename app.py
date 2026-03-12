"""
Flask UI for Twitter DM Automation
Serves at :5000 — proxies campaign commands to the Node.js backend at :3000
Also handles Groq message testing directly.
"""

import os
import csv
import json
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify
from groq import Groq

load_dotenv()

app = Flask(__name__)
app.secret_key = os.urandom(24)

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"
SENT_LOG = LOGS_DIR / "sent_log.json"
METRICS_CSV = LOGS_DIR / "dm_metrics.csv"

NODE_BACKEND = os.getenv("NODE_BACKEND", "http://localhost:3000")

groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
DEFAULT_MODEL = "openai/gpt-oss-120b"
MAX_RETRIES = 3


# ── Helpers ─────────────────────────────────────────────

def read_sent_log():
    if not SENT_LOG.exists():
        return []
    try:
        return json.loads(SENT_LOG.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, FileNotFoundError):
        return []


def read_metrics_csv():
    if not METRICS_CSV.exists():
        return []
    rows = []
    with open(METRICS_CSV, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
    return rows


HEADER_ALIASES = {
    "username": "username", "usernames": "username", "handle": "username", "twitter": "username",
    "name": "name", "first_name": "first_name", "firstname": "first_name",
    "last_name": "last_name", "lastname": "last_name",
    "bio": "bio", "biography": "bio", "description": "bio",
    "location": "location", "website": "website",
}


def read_all_leads():
    """Read all CSVs in data/ with header normalization."""
    leads = []
    seen = set()
    if not DATA_DIR.exists():
        return leads
    for csv_file in sorted(DATA_DIR.glob("*.csv")):
        try:
            with open(csv_file, newline="", encoding="utf-8-sig") as f:
                reader = csv.DictReader(f)
                for raw_row in reader:
                    row = {}
                    for key, val in raw_row.items():
                        normalized = key.strip().lower().replace(" ", "_")
                        canon = HEADER_ALIASES.get(normalized)
                        if canon:
                            row[canon] = (val or "").strip()
                    if "username" in row:
                        row["username"] = row["username"].lstrip("@")
                    if not row.get("name") and (row.get("first_name") or row.get("last_name")):
                        row["name"] = f"{row.get('first_name', '')} {row.get('last_name', '')}".strip()
                    if row.get("username") and row["username"].lower() not in seen:
                        seen.add(row["username"].lower())
                        leads.append(row)
        except Exception:
            continue
    return leads


def list_csv_files():
    if not DATA_DIR.exists():
        return []
    return sorted(f.name for f in DATA_DIR.glob("*.csv"))


def generate_message_groq(name, bio, campaign_context, cta_link, model=None):
    """Call Groq with retry logic. Returns (message, error)."""
    use_model = model or DEFAULT_MODEL
    has_bio = bool(bio and bio.strip())

    bio_rule = (
        "- Reference something specific from the recipient's bio to show genuine interest."
        if has_bio
        else "- The recipient has no bio, so greet them warmly by name and jump straight into the pitch."
    )

    system_prompt = (
        "You are a friendly outreach copywriter. Write a casual, friendly 2-3 sentence Twitter DM.\n"
        "Rules:\n"
        f"{bio_rule}\n"
        f"- Subtly pitch the following service: {campaign_context}\n"
        f"- End the message by naturally sharing this link: {cta_link}\n"
        "- Do NOT be overly formal or salesy.\n"
        "- Do NOT use hashtags or emojis.\n"
        "- Keep it under 500 characters.\n"
        "- Return ONLY the DM text — no quotes, no preamble, no explanation."
    )

    user_prompt = (
        f"Recipient name: {name or 'there'}\nRecipient bio: {bio}"
        if has_bio
        else f"Recipient name: {name or 'there'}"
    )

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = groq_client.chat.completions.create(
                model=use_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.8,
                max_tokens=300,
            )
            text = (response.choices[0].message.content or "").strip()

            # Fallback: some reasoning models put output in a reasoning field
            if (not text or len(text) <= 5) and hasattr(response.choices[0].message, "reasoning"):
                import re
                reasoning = response.choices[0].message.reasoning or ""
                quoted = re.search(r'"([^"]{20,})"', reasoning) or re.search(r"'([^']{20,})'", reasoning)
                if quoted:
                    text = quoted.group(1).strip()

            if text and len(text) > 5:
                return text, None
            last_error = f"Empty/short response on attempt {attempt}/{MAX_RETRIES}"
        except Exception as e:
            last_error = str(e)

    return None, last_error


# ── Routes ──────────────────────────────────────────────

@app.route("/")
def dashboard():
    leads = read_all_leads()
    logs = read_sent_log()
    files = list_csv_files()

    sent_set = {e["username"] for e in logs if e.get("status") == "Sent"}
    failed_set = {e["username"] for e in logs if e.get("status") == "Failed" and e["username"] not in sent_set}
    pending = [l for l in leads if l["username"] not in sent_set]

    return render_template(
        "dashboard.html",
        files=files,
        total_leads=len(leads),
        sent_count=len(sent_set),
        failed_count=len(failed_set),
        pending_count=len(pending),
        logs=list(reversed(logs)),
        default_model=DEFAULT_MODEL,
    )


@app.route("/leads")
def leads_page():
    leads = read_all_leads()
    logs = read_sent_log()
    sent_set = {e["username"] for e in logs if e.get("status") == "Sent"}
    return render_template("leads.html", leads=leads, sent_set=sent_set)


@app.route("/logs")
def logs_page():
    logs = read_sent_log()
    metrics = read_metrics_csv()
    return render_template("logs.html", logs=list(reversed(logs)), metrics=list(reversed(metrics)))


@app.route("/test-message", methods=["GET", "POST"])
def test_message():
    result = None
    error = None
    form_data = {
        "name": request.form.get("name", ""),
        "bio": request.form.get("bio", ""),
        "campaign_context": request.form.get("campaign_context", ""),
        "cta_link": request.form.get("cta_link", ""),
        "model": request.form.get("model", DEFAULT_MODEL),
    }
    if request.method == "POST":
        if not form_data["campaign_context"] or not form_data["cta_link"]:
            flash("Service Pitch and CTA Link are required.", "error")
        else:
            msg, err = generate_message_groq(
                form_data["name"], form_data["bio"],
                form_data["campaign_context"], form_data["cta_link"],
                form_data["model"],
            )
            if msg:
                result = msg
                flash("Message generated successfully!", "success")
            else:
                error = err
                flash(f"Groq error: {err}", "error")

    return render_template("test_message.html", result=result, error=error, form=form_data, default_model=DEFAULT_MODEL)


@app.route("/api/test-message", methods=["POST"])
def api_test_message():
    """JSON endpoint for AJAX message testing."""
    data = request.get_json(force=True)
    msg, err = generate_message_groq(
        data.get("name", ""), data.get("bio", ""),
        data.get("campaignContext", ""), data.get("ctaLink", ""),
        data.get("model"),
    )
    if msg:
        return jsonify({"message": msg})
    return jsonify({"error": err}), 500


@app.route("/api/proxy/<path:endpoint>", methods=["GET", "POST"])
def proxy_to_node(endpoint):
    """Proxy requests to the Node.js backend."""
    import urllib.request
    import urllib.error

    url = f"{NODE_BACKEND}/api/{endpoint}"
    try:
        if request.method == "POST":
            body = request.get_data()
            req = urllib.request.Request(
                url, data=body, method="POST",
                headers={"Content-Type": request.content_type or "application/json"},
            )
        else:
            req = urllib.request.Request(url)

        with urllib.request.urlopen(req, timeout=10) as resp:
            return jsonify(json.loads(resp.read())), resp.status
    except urllib.error.HTTPError as e:
        return jsonify(json.loads(e.read())), e.code
    except Exception as e:
        return jsonify({"error": f"Node backend unreachable: {e}"}), 502


# ── Start ───────────────────────────────────────────────

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
