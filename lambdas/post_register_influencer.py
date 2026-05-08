"""
/**
 * @summary Creates a new influencer user in Cognito with a temporary password and sends
 *          the access credentials via a WhatsApp template message ("uppy_welcome_influencer").
 *
 * @receives {object} event - API Gateway POST request with a JSON body containing the
 *           influencer registration data.
 *
 * @example Request (body):
 * {
 *   "phone": "573144043845",
 *   "email": "influencer@example.com",
 *   "name": "María García",
 *   "id_influencer_main": "f712ce49-2534-4e0a-8a86-b4bfd14f182a"
 * }
 *
 * @returns {object} HTTP-style response with statusCode and JSON body.
 *
 * @example Response:
 * {
 *   "statusCode": 200,
 *   "body": {
 *     "message": "Influencer registered successfully",
 *     "username": "influencer@example.com",
 *     "whatsapp_sent": true
 *   }
 * }
 */
"""

import json
import os
import logging
import urllib.request
import urllib.error
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_REGION = os.environ.get("AWS_REGION", "us-east-1")

cognito_idp = boto3.client("cognito-idp", region_name=_REGION)

USER_POOL_ID = os.environ.get("USER_POOL_ID", "us-east-1_NE3oqagA9")
COGNITO_GROUP_NAME = os.environ.get("COGNITO_GROUP_NAME", "influencer")

WHATSAPP_TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
WHATSAPP_PHONE_NUMBER_ID = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "")
WHATSAPP_API_VERSION = os.environ.get("WHATSAPP_API_VERSION", "v22.0")

# Name of the approved WhatsApp template that contains:
#   {{1}} -> influencer name
#   {{2}} -> username (email used to sign in)
#   {{3}} -> temporary password
WHATSAPP_TEMPLATE_NAME = os.environ.get(
    "WHATSAPP_WELCOME_TEMPLATE_NAME", "uppy_ingreso_utility"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _response(status_code: int, body: dict) -> dict:
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=str),
    }


def _parse_body(event: dict) -> dict:
    """Return parsed body regardless of whether the event wraps it as a string."""
    raw = event.get("body") or event
    if isinstance(raw, str):
        return json.loads(raw)
    if isinstance(raw, dict):
        # Direct invocation or body already parsed by API Gateway v2
        return raw
    return {}


# ---------------------------------------------------------------------------
# Cognito
# ---------------------------------------------------------------------------

def _generate_username(name: str) -> str:
    """
    Builds a username like "juandavid.gomez" from a full name.
    Removes accents, keeps only alphanumeric chars and dots.
    """
    import unicodedata
    normalized = unicodedata.normalize("NFD", name.lower())
    ascii_name = "".join(
        c for c in normalized if unicodedata.category(c) != "Mn"
    )
    parts = ascii_name.split()
    if len(parts) < 2:
        return parts[0] if parts else "user"
    first_names = "".join(parts[:-1])
    last_name = parts[-1]
    return f"{first_names}.{last_name}"


def _find_available_username(base_username: str) -> str:
    """
    Checks Cognito for an existing user with base_username.
    If taken, appends an incrementing number (1, 2, 3…) until one is free.
    """
    candidate = base_username
    suffix = 0
    while True:
        try:
            cognito_idp.admin_get_user(
                UserPoolId=USER_POOL_ID,
                Username=candidate,
            )
            suffix += 1
            candidate = f"{base_username}{suffix}"
        except cognito_idp.exceptions.UserNotFoundException:
            return candidate


def _generate_temp_password() -> str:
    """Generates a 12-char password that satisfies typical Cognito policies."""
    import secrets
    import string
    lower = string.ascii_lowercase
    upper = string.ascii_uppercase
    digits = string.digits
    symbols = "!@#$%"
    # Guarantee at least one of each required character type
    mandatory = [
        secrets.choice(lower),
        secrets.choice(upper),
        secrets.choice(digits),
        secrets.choice(symbols),
    ]
    pool = lower + upper + digits + symbols
    rest = [secrets.choice(pool) for _ in range(8)]
    chars = mandatory + rest
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def _create_cognito_user(email: str, phone: str, name: str, id_influencer_main: str) -> tuple:
    """
    Creates the user in Cognito with AdminCreateUser (MessageAction=SUPPRESS to avoid
    the default email because we deliver credentials via WhatsApp instead).

    Username format: "firstname.lastname" (e.g. "juandavid.gomez").
    If already taken, appends an incrementing number (e.g. "juandavid.gomez1").

    Returns a tuple (username, temporary_password).
    """
    base_username = _generate_username(name)
    username = _find_available_username(base_username)
    temporary_password = _generate_temp_password()

    cognito_idp.admin_create_user(
        UserPoolId=USER_POOL_ID,
        Username=username,
        TemporaryPassword=temporary_password,
        DesiredDeliveryMediums=["EMAIL"],
        UserAttributes=[
            {"Name": "email", "Value": email},
            {"Name": "email_verified", "Value": "true"},
            {"Name": "phone_number", "Value": f"+{phone.lstrip('+')}"},
            {"Name": "phone_number_verified", "Value": "true"},
            {"Name": "name", "Value": name},
            {"Name": "custom:id_influencer_main", "Value": id_influencer_main},
        ],
    )

    cognito_idp.admin_add_user_to_group(
        UserPoolId=USER_POOL_ID,
        Username=username,
        GroupName=COGNITO_GROUP_NAME,
    )

    return username, temporary_password


# ---------------------------------------------------------------------------
# WhatsApp
# ---------------------------------------------------------------------------

def _send_whatsapp_welcome(phone: str, name: str, username: str, temporary_password: str) -> bool:
    """
    Sends the WhatsApp template "uppy_welcome_influencer" to the influencer.

    Expected template body variables:
        {{1}} -> influencer name
        {{2}} -> username (email / login)
        {{3}} -> temporary password

    Returns True if the message was accepted by the API, False otherwise.
    """
    if not WHATSAPP_TOKEN or not WHATSAPP_PHONE_NUMBER_ID:
        logger.warning("WhatsApp credentials not configured — skipping send")
        return False

    url = (
        f"https://graph.facebook.com/{WHATSAPP_API_VERSION}"
        f"/{WHATSAPP_PHONE_NUMBER_ID}/messages"
    )

    payload = {
        "messaging_product": "whatsapp",
        "to": phone.lstrip("+"),
        "type": "template",
        "template": {
            "name": WHATSAPP_TEMPLATE_NAME,
            "language": {"code": "es"},
            "components": [
                {
                    "type": "body",
                    "parameters": [
                        {"type": "text", "text": name},
                        {"type": "text", "text": f"Email: {username}"},
                        {"type": "text", "text": f"Contraseña: {temporary_password}"},
                    ],
                }
            ],
        },
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {WHATSAPP_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            response_body = json.loads(resp.read().decode("utf-8"))
            message_id = (response_body.get("messages") or [{}])[0].get("id")
            logger.info("WhatsApp welcome sent to %s — message_id: %s", phone, message_id)
            return True
    except urllib.error.HTTPError as e:
        error_detail = e.read().decode("utf-8") if e.fp else str(e)
        logger.error("WhatsApp API HTTP error %s: %s", e.code, error_detail)
        return False
    except Exception as e:
        logger.error("WhatsApp send failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

def lambda_handler(event, context):
    logger.info("register_influencer invoked")

    try:
        body = _parse_body(event)
    except (json.JSONDecodeError, TypeError) as e:
        return _response(400, {"error": "Invalid JSON body", "message": str(e)})

    # --- Validate required fields ---
    phone = (body.get("phone") or "").strip()
    email = (body.get("email") or "").strip()
    name = (body.get("name") or "").strip()
    id_influencer_main = (body.get("id_influencer_main") or "").strip()

    missing = [f for f, v in {
        "phone": phone,
        "email": email,
        "name": name,
        "id_influencer_main": id_influencer_main,
    }.items() if not v]

    if missing:
        return _response(
            400,
            {
                "error": "Missing required fields",
                "fields": missing,
            },
        )

    # --- Create Cognito user ---
    try:
        username, temporary_password = _create_cognito_user(email, phone, name, id_influencer_main)
        logger.info("Cognito user created: %s (%s)", username, email)
    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        error_message = e.response.get("Error", {}).get("Message", str(e))

        if error_code == "UsernameExistsException":
            return _response(
                409,
                {
                    "error": "User already exists",
                    "message": "A Cognito user with the same email or phone already exists.",
                },
            )

        logger.error("Cognito error [%s]: %s", error_code, error_message)
        return _response(
            500,
            {
                "error": "Could not create Cognito user",
                "code": error_code,
                "message": error_message,
            },
        )

    # --- Send WhatsApp welcome message ---
    whatsapp_sent = _send_whatsapp_welcome(phone, name, username, temporary_password)

    if not whatsapp_sent:
        logger.warning(
            "WhatsApp message could not be delivered to %s — user was still created in Cognito",
            phone,
        )

    return _response(
        200,
        {
            "message": "Influencer registered successfully",
            "username": username,
            "whatsapp_sent": whatsapp_sent,
        },
    )